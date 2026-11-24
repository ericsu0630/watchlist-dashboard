// Menu bar app: runs the dashboard server (node server.js) and offers Open / Restart / Quit.
// Config comes from env vars set by install.sh in the LaunchAgent:
//   WD_NODE  absolute path to node
//   WD_DIR   project folder
//   WD_PORT  port (default 3000)

import AppKit

let env = ProcessInfo.processInfo.environment
let nodePath = env["WD_NODE"] ?? "/usr/local/bin/node"
let projectDir = env["WD_DIR"] ?? FileManager.default.currentDirectoryPath
let port = env["WD_PORT"] ?? "3000"
let logURL = FileManager.default.homeDirectoryForCurrentUser
    .appendingPathComponent("Library/Logs/watchlist-dashboard.log")

final class AppDelegate: NSObject, NSApplicationDelegate {
    private let statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    private let stateItem = NSMenuItem(title: "Starting…", action: nil, keyEquivalent: "")
    private var server: Process?
    private var restarting = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        if let button = statusItem.button {
            let image = NSImage(systemSymbolName: "chart.line.uptrend.xyaxis", accessibilityDescription: "Watchlist dashboard")
            image?.isTemplate = true
            image?.size = NSSize(width: 18, height: 18)
            button.image = image
            button.imagePosition = .imageOnly
            // Fixed width wider than the icon, so there is padding on both sides
            statusItem.length = 36
        }
        let menu = NSMenu()
        menu.addItem(stateItem)
        menu.addItem(.separator())
        menu.addItem(item("Open Dashboard", #selector(openDashboard), "o"))
        menu.addItem(item("Restart Server", #selector(restartServer), "r"))
        menu.addItem(.separator())
        menu.addItem(item("Quit", #selector(quit), "q"))
        statusItem.menu = menu
        startServer()
    }

    func applicationWillTerminate(_ notification: Notification) {
        stopServer()
    }

    private func item(_ title: String, _ action: Selector, _ key: String) -> NSMenuItem {
        let i = NSMenuItem(title: title, action: action, keyEquivalent: key)
        i.target = self
        return i
    }

    private func startServer() {
        let fm = FileManager.default
        try? fm.createDirectory(at: logURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        if !fm.fileExists(atPath: logURL.path) { fm.createFile(atPath: logURL.path, contents: nil) }

        let p = Process()
        p.executableURL = URL(fileURLWithPath: nodePath)
        p.arguments = ["server.js"]
        p.currentDirectoryURL = URL(fileURLWithPath: projectDir)
        var childEnv = env
        childEnv["PORT"] = port
        p.environment = childEnv
        if let log = try? FileHandle(forWritingTo: logURL) {
            log.seekToEndOfFile()
            p.standardOutput = log
            p.standardError = log
        }
        p.terminationHandler = { [weak self] proc in
            DispatchQueue.main.async {
                guard let self, self.server === proc else { return }
                self.server = nil
                if !self.restarting { self.setState("Server stopped (exit \(proc.terminationStatus))") }
            }
        }
        do {
            try p.run()
            server = p
            setState("Server running on :\(port)")
        } catch {
            setState("Failed to start: \(error.localizedDescription)")
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
        NSWorkspace.shared.open(URL(string: "http://localhost:\(port)")!)
    }

    @objc private func restartServer() {
        restarting = true
        setState("Restarting…")
        stopServer()
        startServer()
        restarting = false
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
