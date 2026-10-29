// Agent 信鸽 — the macOS shell.
//
// A menu bar app (LSUIElement): a status item with a short menu, one window that hosts the
// web UI (WKWebView on the engine's local server), the engine as a supervised child
// process, and the login item (SMAppService). Everything else lives in the engine.

import AppKit
import ServiceManagement
import WebKit

// MARK: - Engine supervisor

/// Runs `Contents/MacOS/agent-pigeon-engine serve`, restarts it when it dies, and stops it
/// when the app quits. Its stdin stays open: the engine treats EOF as "the app is gone".
final class Engine {
    enum State: Equatable { case starting, running(port: Int), stopped(String) }

    private(set) var state: State = .starting { didSet { onChange?(state) } }
    var onChange: ((State) -> Void)?

    private var process: Process?
    private var stdin: Pipe?
    private var quitting = false
    private var restarts: [Date] = []
    private let binary: URL
    let dataDir: URL

    init() {
        binary = Bundle.main.bundleURL.appendingPathComponent("Contents/MacOS/agent-pigeon-engine")
        dataDir = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/AgentPigeon")
    }

    var uiPortFile: URL { dataDir.appendingPathComponent("ui.port") }

    func start() {
        guard process == nil else { return }
        quitting = false
        state = .starting
        try? FileManager.default.createDirectory(at: dataDir, withIntermediateDirectories: true)
        try? FileManager.default.removeItem(at: uiPortFile)

        let p = Process()
        p.executableURL = binary
        p.arguments = ["serve"]
        var env = ProcessInfo.processInfo.environment
        env["AP_PARENT_WATCH"] = "1"
        // Start in the data directory, never in whatever folder launched the app (a Desktop
        // cwd makes macOS ask for Desktop access before the engine has done anything).
        env.removeValue(forKey: "PWD")
        env.removeValue(forKey: "OLDPWD")
        p.environment = env
        p.currentDirectoryURL = dataDir
        let input = Pipe()
        p.standardInput = input
        let log = dataDir.appendingPathComponent("engine.stdout.log")
        FileManager.default.createFile(atPath: log.path, contents: nil)
        if let h = try? FileHandle(forWritingTo: log) {
            h.truncateFile(atOffset: 0)
            p.standardOutput = h
            p.standardError = h
        }
        p.terminationHandler = { [weak self] proc in
            DispatchQueue.main.async { self?.exited(code: proc.terminationStatus) }
        }
        do {
            try p.run()
        } catch {
            state = .stopped("引擎无法启动：\(error.localizedDescription)")
            return
        }
        process = p
        stdin = input
        waitForPort(deadline: Date().addingTimeInterval(20))
    }

    private func waitForPort(deadline: Date) {
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { [weak self] in
            guard let self, self.process != nil else { return }
            if let s = try? String(contentsOf: self.uiPortFile, encoding: .utf8),
               let port = Int(s.trimmingCharacters(in: .whitespacesAndNewlines)) {
                self.state = .running(port: port)
            } else if Date() < deadline {
                self.waitForPort(deadline: deadline)
            } else {
                self.state = .stopped("引擎启动超时，查看日志：\(self.dataDir.path)/logs")
            }
        }
    }

    private func exited(code: Int32) {
        process = nil
        stdin = nil
        if quitting { return }
        // 75 = the engine asked for a restart (settings changed); anything else is a crash.
        // Crash loops back off: at most 5 restarts a minute.
        let now = Date()
        restarts = restarts.filter { now.timeIntervalSince($0) < 60 } + [now]
        if code != 75 && restarts.count > 5 {
            state = .stopped("引擎反复退出（代码 \(code)），已停止重试。查看日志：\(dataDir.path)/logs")
            return
        }
        state = .starting
        DispatchQueue.main.asyncAfter(deadline: .now() + (code == 75 ? 0.3 : 2)) { [weak self] in self?.start() }
    }

    func restart() {
        guard let p = process else { start(); return }
        p.terminate() // SIGTERM; exited() starts a new one
    }

    func stop() {
        quitting = true
        guard let p = process else { return }
        p.terminate()
        let deadline = Date().addingTimeInterval(5)
        while p.isRunning && Date() < deadline { RunLoop.current.run(until: Date().addingTimeInterval(0.05)) }
        if p.isRunning { kill(p.processIdentifier, SIGKILL) }
        process = nil
    }
}

// MARK: - Window

final class MainWindow: NSWindowController, WKScriptMessageHandler, WKNavigationDelegate, NSWindowDelegate {
    private let webView: WKWebView
    private let placeholder = NSTextField(labelWithString: "正在启动引擎…")
    var onMessage: (([String: Any]) -> Void)?
    private var loadedPort: Int?

    init() {
        let config = WKWebViewConfiguration()
        let controller = WKUserContentController()
        config.userContentController = controller
        webView = WKWebView(frame: .zero, configuration: config)
        webView.setValue(false, forKey: "drawsBackground")

        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 980, height: 660),
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered, defer: false)
        window.title = "Agent 信鸽"
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        window.isMovableByWindowBackground = true
        window.minSize = NSSize(width: 760, height: 480)
        window.setFrameAutosaveName("AgentPigeonMain")
        window.backgroundColor = NSColor(name: nil) { $0.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
            ? NSColor(red: 0.10, green: 0.10, blue: 0.12, alpha: 1) : NSColor(red: 0.957, green: 0.957, blue: 0.965, alpha: 1) }

        let container = NSView()
        webView.translatesAutoresizingMaskIntoConstraints = false
        placeholder.translatesAutoresizingMaskIntoConstraints = false
        placeholder.textColor = .secondaryLabelColor
        placeholder.alignment = .center
        container.addSubview(webView)
        container.addSubview(placeholder)
        NSLayoutConstraint.activate([
            webView.leadingAnchor.constraint(equalTo: container.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: container.trailingAnchor),
            webView.topAnchor.constraint(equalTo: container.topAnchor),
            webView.bottomAnchor.constraint(equalTo: container.bottomAnchor),
            placeholder.centerXAnchor.constraint(equalTo: container.centerXAnchor),
            placeholder.centerYAnchor.constraint(equalTo: container.centerYAnchor),
            placeholder.widthAnchor.constraint(lessThanOrEqualTo: container.widthAnchor, constant: -80),
        ])
        window.contentView = container
        super.init(window: window)
        window.delegate = self
        webView.navigationDelegate = self
        controller.add(self, name: "ap")
        window.center()
    }

    required init?(coder: NSCoder) { fatalError() }

    func show(engine: Engine.State, loginItem: Bool) {
        apply(engine: engine, loginItem: loginItem)
        NSApp.setActivationPolicy(.regular) // a Dock icon while the window is open
        showWindow(nil)
        window?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    func apply(engine: Engine.State, loginItem: Bool) {
        switch engine {
        case .running(let port):
            placeholder.isHidden = true
            webView.isHidden = false
            if loadedPort != port, let url = URL(string: "http://127.0.0.1:\(port)/") {
                loadedPort = port
                webView.load(URLRequest(url: url))
            }
            pushNative(loginItem: loginItem)
        case .starting:
            if loadedPort == nil { placeholder.stringValue = "正在启动引擎…"; placeholder.isHidden = false; webView.isHidden = true }
        case .stopped(let why):
            loadedPort = nil
            placeholder.stringValue = why
            placeholder.isHidden = false
            webView.isHidden = true
        }
    }

    func pushNative(loginItem: Bool) {
        webView.evaluateJavaScript("window.apNativeChanged && window.apNativeChanged({loginItem: \(loginItem)})")
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        pushNative(loginItem: SMAppService.mainApp.status == .enabled)
    }

    /// Only the engine's own pages load in the window; anything else opens in the browser.
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if let url = action.request.url, url.host != "127.0.0.1" {
            NSWorkspace.shared.open(url)
            decisionHandler(.cancel)
            return
        }
        decisionHandler(.allow)
    }

    func userContentController(_ c: WKUserContentController, didReceive message: WKScriptMessage) {
        if let body = message.body as? [String: Any] { onMessage?(body) }
    }

    func windowWillClose(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory) // back to menu bar only
    }
}

// MARK: - App

final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate {
    private let engine = Engine()
    private var statusItem: NSStatusItem!
    private var window: MainWindow!
    private let stateItem = NSMenuItem(title: "正在启动…", action: nil, keyEquivalent: "")

    func applicationDidFinishLaunching(_ notification: Notification) {
        window = MainWindow()
        window.onMessage = { [weak self] msg in self?.handle(msg) }

        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        if let button = statusItem.button {
            let image = NSImage(named: "StatusIcon") ?? NSImage(systemSymbolName: "point.3.connected.trianglepath.dotted", accessibilityDescription: "Agent 信鸽")
            image?.isTemplate = true
            button.image = image
        }
        let menu = NSMenu()
        menu.delegate = self
        stateItem.isEnabled = false
        menu.addItem(stateItem)
        menu.addItem(.separator())
        menu.addItem(withTitle: "打开 Agent 信鸽", action: #selector(openWindow), keyEquivalent: "o").target = self
        menu.addItem(withTitle: "重启引擎", action: #selector(restartEngine), keyEquivalent: "r").target = self
        menu.addItem(.separator())
        menu.addItem(withTitle: "退出 Agent 信鸽", action: #selector(quit), keyEquivalent: "q").target = self
        statusItem.menu = menu

        engine.onChange = { [weak self] state in self?.engineChanged(state) }
        engine.start()

        // First launch (or launched by hand rather than at login): show the window.
        // keyAELaunchedAsLogInOrResume ('lgit'): the open event says the login items started us.
        let atLogin = NSAppleEventManager.shared().currentAppleEvent?.paramDescriptor(forKeyword: AEKeyword(0x6C67_6974))?.booleanValue ?? false
        if !atLogin { window.show(engine: engine.state, loginItem: loginItemEnabled) }
        if !UserDefaults.standard.bool(forKey: "askedLoginItem") {
            UserDefaults.standard.set(true, forKey: "askedLoginItem")
            setLoginItem(true) // on by default; the user can turn it off in Settings
        }
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        openWindow()
        return true
    }

    func applicationWillTerminate(_ notification: Notification) { engine.stop() }

    private var loginItemEnabled: Bool { SMAppService.mainApp.status == .enabled }

    private func setLoginItem(_ on: Bool) {
        do {
            if on { try SMAppService.mainApp.register() } else { try SMAppService.mainApp.unregister() }
        } catch {
            NSLog("login item: \(error.localizedDescription)")
        }
        window.pushNative(loginItem: loginItemEnabled)
    }

    private func engineChanged(_ state: Engine.State) {
        switch state {
        case .starting: stateItem.title = "引擎启动中…"
        case .running: stateItem.title = "引擎运行中"
        case .stopped(let why): stateItem.title = why.count > 40 ? String(why.prefix(40)) + "…" : why
        }
        window.apply(engine: state, loginItem: loginItemEnabled)
    }

    private func handle(_ msg: [String: Any]) {
        switch msg["action"] as? String {
        case "loginItem": setLoginItem((msg["value"] as? Bool) ?? !loginItemEnabled)
        case "reveal": NSWorkspace.shared.activateFileViewerSelecting([engine.dataDir])
        default: break
        }
    }

    @objc private func openWindow() { window.show(engine: engine.state, loginItem: loginItemEnabled) }
    @objc private func restartEngine() { engine.restart() }
    @objc private func quit() { NSApp.terminate(nil) }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
