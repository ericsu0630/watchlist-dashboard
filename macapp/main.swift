// Watchlist.app: a menu bar app that runs the bundled dashboard server with the bundled Node,
// and shows the dashboard in its own window (dashboard.swift).
// Bundle layout (made by macapp/build.sh):
//   Contents/MacOS/Watchlist      this program
//   Contents/MacOS/node           Node.js runtime
//   Contents/Resources/app/       server.js, lib/, public/, node_modules/
// Writable files live outside the bundle:
//   ~/Library/Application Support/Watchlist   accounts, synced boards, optional .env
//   ~/Library/Logs/Watchlist.log              server output
// For testing, WD_PORT, WD_DATA_DIR and WD_LOG override the port, data folder and log file.

import AppKit
import ServiceManagement

let env = ProcessInfo.processInfo.environment
let fm = FileManager.default
let home = fm.homeDirectoryForCurrentUser
let dataDir = env["WD_DATA_DIR"].map { URL(fileURLWithPath: $0) }
    ?? home.appendingPathComponent("Library/Application Support/Watchlist")
let logURL = env["WD_LOG"].map { URL(fileURLWithPath: $0) }
    ?? home.appendingPathComponent("Library/Logs/Watchlist.log")
let nodeURL = Bundle.main.executableURL!.deletingLastPathComponent().appendingPathComponent("node")
let appDir = Bundle.main.resourceURL!.appendingPathComponent("app")

/// KEY=value pairs from the .env in the data folder (only PORT and HOST matter here; the server reads the rest).
func readDotEnv() -> [String: String] {
    guard let text = try? String(contentsOf: dataDir.appendingPathComponent(".env"), encoding: .utf8) else { return [:] }
    var out: [String: String] = [:]
    for line in text.split(whereSeparator: \.isNewline) {
        let t = line.trimmingCharacters(in: .whitespaces)
        guard !t.hasPrefix("#"), let eq = t.firstIndex(of: "=") else { continue }
        let key = t[..<eq].trimmingCharacters(in: .whitespaces)
        var value = t[t.index(after: eq)...].trimmingCharacters(in: .whitespaces)
        if value.count >= 2, let f = value.first, f == value.last, f == "\"" || f == "'" { value = String(value.dropFirst().dropLast()) }
        out[key] = value
    }
    return out
}

/// True when something already accepts connections on 127.0.0.1:port (another server, or another copy of this app).
func portInUse(_ port: Int) -> Bool {
    let fd = socket(AF_INET, SOCK_STREAM, 0)
    guard fd >= 0 else { return false }
    defer { close(fd) }
    var addr = sockaddr_in()
    addr.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
    addr.sin_family = sa_family_t(AF_INET)
    addr.sin_port = in_port_t(UInt16(port).bigEndian)
    addr.sin_addr.s_addr = inet_addr("127.0.0.1")
    return withUnsafePointer(to: &addr) {
        $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
            connect(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) == 0
        }
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate {
    private let statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    private let stateItem = NSMenuItem(title: "Starting…", action: nil, keyEquivalent: "")
    private var loginItem: NSMenuItem!
    private var server: Process?
    private var port = 3000
    private var restarting = false
    private let dashboard = DashboardWindow()

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.mainMenu = makeMainMenu(reloadTarget: dashboard) // shown only while the dashboard window is open
        if let button = statusItem.button {
            let image = NSImage(systemSymbolName: "chart.line.uptrend.xyaxis", accessibilityDescription: "Watchlist")
            image?.isTemplate = true
            image?.size = NSSize(width: 18, height: 18)
            button.image = image
            button.imagePosition = .imageOnly
            // Fixed width wider than the icon, so there is padding on both sides
            statusItem.length = 36
        }
        let menu = NSMenu()
        menu.delegate = self
        menu.addItem(stateItem)
        menu.addItem(.separator())
        menu.addItem(item("Open Dashboard", #selector(openDashboard), "o"))
        menu.addItem(item("Open in Browser", #selector(openInBrowser), ""))
        menu.addItem(item("Restart Server", #selector(restartServer), "r"))
        menu.addItem(.separator())
        loginItem = item("Start at Login", #selector(toggleLogin), "")
        menu.addItem(loginItem)
        menu.addItem(.separator())
        menu.addItem(item("Quit", #selector(quit), "q"))
        statusItem.menu = menu
        startServer()
    }

    func applicationWillTerminate(_ notification: Notification) {
        stopServer()
    }

    /// Opening the app again while it runs (from Finder, Launchpad or Spotlight) shows the dashboard.
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        openDashboard()
        return false
    }

    func menuWillOpen(_ menu: NSMenu) {
        loginItem.state = SMAppService.mainApp.status == .enabled ? .on : .off
    }

    private func item(_ title: String, _ action: Selector, _ key: String) -> NSMenuItem {
        let i = NSMenuItem(title: title, action: action, keyEquivalent: key)
        i.target = self
        return i
    }

    private func openLog() -> FileHandle? {
        try? fm.createDirectory(at: logURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        // Start over once the log passes 5 MB, so it can't grow forever.
        let size = (try? fm.attributesOfItem(atPath: logURL.path)[.size] as? Int) ?? 0
        if size > 5_000_000 || !fm.fileExists(atPath: logURL.path) { fm.createFile(atPath: logURL.path, contents: nil) }
        let log = try? FileHandle(forWritingTo: logURL)
        log?.seekToEndOfFile()
        return log
    }

    private func startServer() {
        try? fm.createDirectory(at: dataDir, withIntermediateDirectories: true)
        let dotEnv = readDotEnv()
        let preferred = Int(env["WD_PORT"] ?? dotEnv["PORT"] ?? "") ?? 3000
        // Use the next free port when the preferred one is taken, so a second server doesn't stop this one.
        guard let free = (preferred...(preferred + 10)).first(where: { !portInUse($0) }) else {
            setState("Ports \(preferred)–\(preferred + 10) are in use")
            return
        }
        port = free

        let p = Process()
        p.executableURL = nodeURL
        p.arguments = ["server.js"]
        p.currentDirectoryURL = appDir
        var childEnv = env
        for key in ["WD_PORT", "WD_DATA_DIR", "WD_LOG"] { childEnv[key] = nil }
        childEnv["PORT"] = String(port)
        // Only this Mac by default: the dashboard has no lock. HOST=0.0.0.0 in the .env opens it to the network.
        childEnv["HOST"] = dotEnv["HOST"] ?? "127.0.0.1"
        childEnv["PD_DATA_DIR"] = dataDir.path
        childEnv["NODE_ENV"] = "production"
        p.environment = childEnv
        if let log = openLog() {
            log.write("\n--- \(Date()) Watchlist starting on port \(port)\n".data(using: .utf8)!)
            p.standardOutput = log
            p.standardError = log
        }
        p.terminationHandler = { [weak self] proc in
            DispatchQueue.main.async {
                guard let self, self.server === proc else { return }
                self.server = nil
                if self.restarting { return }
                self.setState(proc.terminationStatus == 2
                    ? "Port \(self.port) is in use"
                    : "Server stopped (exit \(proc.terminationStatus))")
            }
        }
        do {
            try p.run()
            server = p
            setState("Starting on :\(port)…")
            waitUntilListening(p, note: port == preferred ? "" : " (\(preferred) was busy)")
        } catch {
            setState("Failed to start: \(error.localizedDescription)")
        }
    }

    /// Polls the port until the server answers, then updates the menu and an open dashboard window
    /// (and opens the window on first launch).
    private func waitUntilListening(_ p: Process, note: String, tries: Int = 60) {
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { [weak self] in
            guard let self, self.server === p, p.isRunning else { return }
            guard portInUse(self.port) else {
                if tries > 0 { self.waitUntilListening(p, note: note, tries: tries - 1) }
                return
            }
            self.setState("Running on :\(self.port)\(note)")
            self.dashboard.serverReady(port: self.port)
            let key = "openedOnce"
            if !UserDefaults.standard.bool(forKey: key) {
                UserDefaults.standard.set(true, forKey: key)
                self.openDashboard()
            }
        }
    }

    private func stopServer() {
        guard let p = server, p.isRunning else { server = nil; return }
        p.terminate()
        let deadline = Date().addingTimeInterval(3)
        while p.isRunning && Date() < deadline { Thread.sleep(forTimeInterval: 0.05) }
        if p.isRunning { kill(p.processIdentifier, SIGKILL) }
        server = nil
    }

    private func setState(_ text: String) {
        stateItem.title = text
    }

    @objc private func openDashboard() {
        dashboard.show(port: port)
    }

    @objc private func openInBrowser() {
        NSWorkspace.shared.open(URL(string: "http://localhost:\(port)")!)
    }

    @objc private func restartServer() {
        restarting = true
        setState("Restarting…")
        stopServer()
        restarting = false
        startServer()
    }

    @objc private func toggleLogin() {
        let service = SMAppService.mainApp
        do {
            if service.status == .enabled {
                try service.unregister()
            } else {
                try service.register()
                if service.status == .requiresApproval { SMAppService.openSystemSettingsLoginItems() }
            }
        } catch {
            let alert = NSAlert()
            alert.messageText = "Couldn't change Start at Login"
            alert.informativeText = "\(error.localizedDescription)\n\nMove Watchlist to the Applications folder and try again, or add it in System Settings → General → Login Items."
            NSApp.activate(ignoringOtherApps: true)
            alert.runModal()
        }
    }

    @objc private func quit() {
        NSApp.terminate(nil)
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let delegate = AppDelegate()
app.delegate = delegate
signal(SIGTERM) { _ in DispatchQueue.main.async { NSApp.terminate(nil) } }
app.run()
