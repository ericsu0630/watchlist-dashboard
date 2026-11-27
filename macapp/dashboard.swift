// The dashboard in its own window: a WKWebView on the local server, instead of a browser tab.
// The window is made when it opens and thrown away when it closes, so a closed window doesn't keep
// streaming data. While it's open the app shows in the Dock and has a menu bar; closing it leaves the
// server running behind the menu bar icon.

import AppKit
import UniformTypeIdentifiers
import WebKit

final class DashboardWindow: NSObject, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate {
    private var window: NSWindow?
    private var webView: WKWebView?
    private var status: NSTextField?
    private var titleWatch: NSKeyValueObservation?
    private var port = 0
    private var loaded = false
    private var retry: DispatchWorkItem?

    /// The page's background (--ground in styles.css), so nothing flashes white while it loads.
    private let ground = NSColor(srgbRed: 0x11 / 255, green: 0x11 / 255, blue: 0x11 / 255, alpha: 1)

    func show(port: Int) {
        if window == nil { make() }
        if port != self.port || !loaded { load(port) }
        NSApp.setActivationPolicy(.regular)
        NSApp.activate(ignoringOtherApps: true)
        window?.makeKeyAndOrderFront(nil)
    }

    /// The server is up (again), maybe on another port: point an open window at it.
    func serverReady(port: Int) {
        guard window != nil, port != self.port || !loaded else { return }
        load(port)
    }

    @objc func reload(_ sender: Any?) {
        if loaded { webView?.reload() } else { load(port) }
    }

    private func make() {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default() // keeps the board (localStorage) between launches
        let web = WKWebView(frame: .zero, configuration: config)
        web.navigationDelegate = self
        web.uiDelegate = self
        web.underPageBackgroundColor = ground
        web.isHidden = true // until the first page has loaded
        if #available(macOS 13.3, *) { web.isInspectable = true } // Safari → Develop menu, for debugging
        web.autoresizingMask = [.width, .height]

        let label = NSTextField(labelWithString: "Starting…")
        label.textColor = NSColor(srgbRed: 0x89 / 255, green: 0x89 / 255, blue: 0x89 / 255, alpha: 1)
        label.alignment = .center
        label.translatesAutoresizingMaskIntoConstraints = false

        let content = NSView()
        content.addSubview(label)
        content.addSubview(web)
        NSLayoutConstraint.activate([
            label.centerXAnchor.constraint(equalTo: content.centerXAnchor),
            label.centerYAnchor.constraint(equalTo: content.centerYAnchor),
            label.widthAnchor.constraint(lessThanOrEqualTo: content.widthAnchor, constant: -40),
        ])

        let w = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1280, height: 820),
                         styleMask: [.titled, .closable, .miniaturizable, .resizable],
                         backing: .buffered, defer: false)
        w.title = "Watchlist"
        w.appearance = NSAppearance(named: .darkAqua)
        w.backgroundColor = ground
        w.minSize = NSSize(width: 420, height: 360)
        w.isReleasedWhenClosed = false
        w.tabbingMode = .disallowed
        w.collectionBehavior.insert(.fullScreenPrimary)
        w.contentView = content
        web.frame = content.bounds
        w.delegate = self
        if !w.setFrameUsingName("Dashboard") { w.center() }
        w.setFrameAutosaveName("Dashboard")

        // The page puts the enlarged chart's symbol and price in its title; show that in the title bar.
        titleWatch = web.observe(\.title) { [weak w] web, _ in
            if let t = web.title, !t.isEmpty { w?.title = t }
        }
        window = w
        webView = web
        status = label
    }

    private func load(_ port: Int) {
        retry?.cancel()
        self.port = port
        loaded = false
        webView?.load(URLRequest(url: URL(string: "http://localhost:\(port)/")!))
    }

    private func isDashboard(_ url: URL) -> Bool {
        url.scheme == "http" && (url.host == "localhost" || url.host == "127.0.0.1") && url.port == port
    }

    // MARK: Window

    func windowWillClose(_ notification: Notification) {
        retry?.cancel()
        titleWatch = nil
        webView?.stopLoading()
        webView?.navigationDelegate = nil
        webView?.uiDelegate = nil
        window?.delegate = nil
        window = nil
        webView = nil
        status = nil
        loaded = false
        NSApp.setActivationPolicy(.accessory) // back to the menu bar only
    }

    // MARK: Navigation

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if action.shouldPerformDownload { return decisionHandler(.download) } // Export
        guard let url = action.request.url else { return decisionHandler(.cancel) }
        // Anything that would take the window away from the dashboard (a news story, another site)
        // opens in the default browser instead.
        if action.targetFrame?.isMainFrame != false, !isDashboard(url), ["http", "https", "mailto"].contains(url.scheme ?? "") {
            NSWorkspace.shared.open(url)
            return decisionHandler(.cancel)
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse,
                 decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        decisionHandler(response.canShowMIMEType ? .allow : .download)
    }

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
        download.delegate = self
    }

    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
        download.delegate = self
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard webView === self.webView, let url = webView.url, isDashboard(url) else { return }
        loaded = true
        webView.isHidden = false
        status?.isHidden = true
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        guard webView === self.webView, (error as NSError).code != NSURLErrorCancelled else { return }
        // The server is starting, restarting or stopped: show why and try again shortly.
        loaded = false
        webView.isHidden = true
        status?.stringValue = "Can't reach the dashboard server. Trying again…\n\nIf this doesn't go away, choose Restart Server from the menu bar icon."
        status?.isHidden = false
        let work = DispatchWorkItem { [weak self] in
            guard let self, self.window != nil else { return }
            self.load(self.port)
        }
        retry = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 2, execute: work)
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        webView.reload()
    }

    // MARK: Links that open a new window, and file pickers

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        // target="_blank" (news headlines): the default browser.
        if let url = action.request.url, ["http", "https", "mailto"].contains(url.scheme ?? "") {
            NSWorkspace.shared.open(url)
        }
        return nil
    }

    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        guard let window else { return completionHandler(nil) }
        // Import…
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.canChooseDirectories = parameters.allowsDirectories
        panel.canChooseFiles = true
        panel.beginSheetModal(for: window) { result in
            completionHandler(result == .OK ? panel.urls : nil)
        }
    }

    // MARK: Downloads (Export)

    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String,
                  completionHandler: @escaping (URL?) -> Void) {
        guard let window else { return completionHandler(nil) }
        let panel = NSSavePanel()
        panel.nameFieldStringValue = suggestedFilename
        panel.directoryURL = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask).first
        panel.canCreateDirectories = true
        if (suggestedFilename as NSString).pathExtension.lowercased() == "json" { panel.allowedContentTypes = [.json] }
        panel.beginSheetModal(for: window) { result in
            guard result == .OK, let url = panel.url else { return completionHandler(nil) }
            // The panel has already asked whether to replace an existing file; a download won't overwrite one itself.
            try? FileManager.default.removeItem(at: url)
            completionHandler(url)
        }
    }

    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        guard (error as NSError).code != NSURLErrorCancelled, let window else { return }
        NSAlert(error: error).beginSheetModal(for: window)
    }
}

/// The menu bar shown while the dashboard window is open. Edit makes Cmd+C/V/X/A work in the page.
func makeMainMenu(reloadTarget: AnyObject) -> NSMenu {
    func add(_ menu: NSMenu, _ title: String, _ action: Selector?, _ key: String = "",
             _ modifiers: NSEvent.ModifierFlags = .command, target: AnyObject? = nil) {
        let i = NSMenuItem(title: title, action: action, keyEquivalent: key)
        i.keyEquivalentModifierMask = modifiers
        i.target = target
        menu.addItem(i)
    }
    func submenu(_ bar: NSMenu, _ title: String) -> NSMenu {
        let m = NSMenu(title: title)
        let item = NSMenuItem(title: title, action: nil, keyEquivalent: "")
        item.submenu = m
        bar.addItem(item)
        return m
    }
    let bar = NSMenu()

    let app = submenu(bar, "Watchlist")
    add(app, "About Watchlist", #selector(NSApplication.orderFrontStandardAboutPanel(_:)))
    app.addItem(.separator())
    add(app, "Hide Watchlist", #selector(NSApplication.hide(_:)), "h")
    add(app, "Hide Others", #selector(NSApplication.hideOtherApplications(_:)), "h", [.command, .option])
    add(app, "Show All", #selector(NSApplication.unhideAllApplications(_:)))
    app.addItem(.separator())
    add(app, "Quit Watchlist", #selector(NSApplication.terminate(_:)), "q")

    let edit = submenu(bar, "Edit")
    add(edit, "Undo", Selector(("undo:")), "z")
    add(edit, "Redo", Selector(("redo:")), "z", [.command, .shift])
    edit.addItem(.separator())
    add(edit, "Cut", #selector(NSText.cut(_:)), "x")
    add(edit, "Copy", #selector(NSText.copy(_:)), "c")
    add(edit, "Paste", #selector(NSText.paste(_:)), "v")
    add(edit, "Select All", #selector(NSText.selectAll(_:)), "a")

    let view = submenu(bar, "View")
    add(view, "Reload", #selector(DashboardWindow.reload(_:)), "r", target: reloadTarget)
    view.addItem(.separator())
    add(view, "Enter Full Screen", #selector(NSWindow.toggleFullScreen(_:)), "f", [.command, .control])

    let window = submenu(bar, "Window")
    add(window, "Minimize", #selector(NSWindow.performMiniaturize(_:)), "m")
    add(window, "Zoom", #selector(NSWindow.performZoom(_:)))
    window.addItem(.separator())
    add(window, "Close", #selector(NSWindow.performClose(_:)), "w")
    NSApp.windowsMenu = window
    return bar
}
