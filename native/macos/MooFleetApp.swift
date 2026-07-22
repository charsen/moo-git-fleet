import AppKit
import Darwin
import Foundation
import WebKit

final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate {
    private var window: NSWindow!
    private var webView: WKWebView!
    private var backend: Process?
    private var backendOutputPipe: Pipe?
    private var backendLog: RotatingLogWriter?
    private var backendLogURL: URL?
    private var backendPort: Int?
    private var backendFailureMessage: String?
    private var installedActivatedMainMenu = false
    private var terminationSignalSources: [DispatchSourceSignal] = []

    func applicationWillFinishLaunching(_ notification: Notification) {
        installTerminationSignalHandlers()
        createMainMenu()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        do {
            let port = try availablePort()
            backendPort = port
            try startBackend(port: port)
            createWindow()
            waitForBackend(port: port, attemptsRemaining: 80)
        } catch {
            presentFatalError(error.localizedDescription)
        }
    }

    func applicationDidBecomeActive(_ notification: Notification) {
        // A bundle without a storyboard gets a minimal fallback app menu from
        // AppKit during launch. Install the complete menu once activation has
        // finished so that fallback cannot replace Edit and Window.
        guard !installedActivatedMainMenu else { return }
        installedActivatedMainMenu = true
        createMainMenu()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    func applicationWillTerminate(_ notification: Notification) {
        stopBackend()
    }

    func windowWillClose(_ notification: Notification) {
        stopBackend()
    }

    private func createWindow() {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = self
        webView.uiDelegate = self

        let visibleFrame = NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
        let defaultWidth = min(1440, visibleFrame.width * 0.94)
        let defaultHeight = min(980, visibleFrame.height * 0.94)
        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: defaultWidth, height: defaultHeight),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "Moo Fleet"
        window.minSize = NSSize(width: 1024, height: 680)
        if !window.setFrameUsingName("MooFleetMainWindow") {
            window.center()
        }
        window.setFrameAutosaveName("MooFleetMainWindow")
        window.contentView = webView
        window.delegate = self
        window.backgroundColor = NSColor(calibratedRed: 16 / 255, green: 18 / 255, blue: 22 / 255, alpha: 1)
        window.titlebarAppearsTransparent = true
        window.titleVisibility = .hidden
        window.titlebarSeparatorStyle = .none
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    private func createMainMenu() {
        let mainMenu = NSMenu()

        let appMenuItem = NSMenuItem(title: "Moo Fleet", action: nil, keyEquivalent: "")
        let appMenu = NSMenu(title: "Moo Fleet")
        let aboutItem = appMenu.addItem(withTitle: "关于 Moo Fleet", action: #selector(showAboutPanel(_:)), keyEquivalent: "")
        aboutItem.target = self
        appMenu.addItem(NSMenuItem.separator())
        appMenu.addItem(withTitle: "隐藏 Moo Fleet", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        let hideOthers = appMenu.addItem(withTitle: "隐藏其他", action: #selector(NSApplication.hideOtherApplications(_:)), keyEquivalent: "h")
        hideOthers.keyEquivalentModifierMask = [.command, .option]
        appMenu.addItem(withTitle: "全部显示", action: #selector(NSApplication.unhideAllApplications(_:)), keyEquivalent: "")
        appMenu.addItem(NSMenuItem.separator())
        appMenu.addItem(withTitle: "退出 Moo Fleet", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appMenuItem.submenu = appMenu
        mainMenu.addItem(appMenuItem)

        let editMenuItem = NSMenuItem(title: "编辑", action: nil, keyEquivalent: "")
        let editMenu = NSMenu(title: "编辑")
        editMenu.addItem(withTitle: "撤销", action: Selector(("undo:")), keyEquivalent: "z")
        editMenu.addItem(withTitle: "重做", action: Selector(("redo:")), keyEquivalent: "Z")
        editMenu.addItem(NSMenuItem.separator())
        editMenu.addItem(withTitle: "剪切", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        editMenu.addItem(withTitle: "复制", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(withTitle: "粘贴", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        editMenu.addItem(withTitle: "全选", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editMenuItem.submenu = editMenu
        mainMenu.addItem(editMenuItem)

        let windowMenuItem = NSMenuItem(title: "窗口", action: nil, keyEquivalent: "")
        let windowMenu = NSMenu(title: "窗口")
        windowMenu.addItem(withTitle: "最小化", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        windowMenu.addItem(withTitle: "缩放", action: #selector(NSWindow.performZoom(_:)), keyEquivalent: "")
        windowMenuItem.submenu = windowMenu
        mainMenu.addItem(windowMenuItem)
        NSApp.windowsMenu = windowMenu
        NSApp.mainMenu = mainMenu
    }

    @objc private func showAboutPanel(_ sender: Any?) {
        let projectURL = URL(string: "https://gitee.com/charsen/moo-git-fleet")!
        let projectLabel = NSMutableAttributedString(string: "Gitee 项目主页\n")
        let linkText = "https://gitee.com/charsen/moo-git-fleet"
        let linkStart = projectLabel.length
        projectLabel.append(NSAttributedString(string: linkText))
        projectLabel.addAttributes(
            [
                .link: projectURL,
                .foregroundColor: NSColor.linkColor,
                .underlineStyle: NSUnderlineStyle.single.rawValue,
            ],
            range: NSRange(location: linkStart, length: linkText.utf16.count)
        )
        NSApp.orderFrontStandardAboutPanel(options: [.credits: projectLabel])
    }

    private func installTerminationSignalHandlers() {
        for signalNumber in [SIGTERM, SIGINT] {
            Darwin.signal(signalNumber, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: signalNumber, queue: .main)
            source.setEventHandler {
                NSApp.terminate(nil)
            }
            source.resume()
            terminationSignalSources.append(source)
        }
    }

    private func isInternalURL(_ url: URL) -> Bool {
        guard
            url.scheme == "http",
            let host = url.host,
            let backendPort,
            url.port == backendPort
        else { return false }
        return host == "127.0.0.1" || host == "localhost"
    }

    private func openExternalHTTPURL(_ url: URL) {
        guard url.scheme == "http" || url.scheme == "https" else { return }
        NSWorkspace.shared.open(url)
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else {
            decisionHandler(.cancel)
            return
        }
        if isInternalURL(url) {
            decisionHandler(.allow)
            return
        }
        openExternalHTTPURL(url)
        decisionHandler(.cancel)
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = navigationAction.request.url, !isInternalURL(url) {
            openExternalHTTPURL(url)
        }
        return nil
    }

    private func startBackend(port: Int) throws {
        guard let resources = Bundle.main.resourceURL else {
            throw NSError(domain: "MooFleet", code: 1, userInfo: [NSLocalizedDescriptionKey: "无法读取应用资源目录"])
        }
        let appRoot = resources.appendingPathComponent("app", isDirectory: true)
        let node = resources.appendingPathComponent("runtime/node")
        let server = appRoot.appendingPathComponent("dist/server/index.cjs")
        let support = try applicationSupportDirectory()
        let logURL = support.appendingPathComponent("moo-fleet.log")
        let log = try RotatingLogWriter(fileURL: logURL)
        let outputPipe = Pipe()
        outputPipe.fileHandleForReading.readabilityHandler = { [weak log] handle in
            let data = handle.availableData
            if data.isEmpty {
                handle.readabilityHandler = nil
                return
            }
            log?.write(data)
        }

        let process = Process()
        process.executableURL = node
        process.arguments = [server.path]
        process.currentDirectoryURL = appRoot
        var environment = ProcessInfo.processInfo.environment
        environment["NODE_ENV"] = "production"
        environment["GIT_FLEET_HOST"] = "127.0.0.1"
        environment["GIT_FLEET_PORT"] = String(port)
        environment["GIT_FLEET_HOME"] = support.path
        environment["GIT_FLEET_ASSETS_HOME"] = appRoot.path
        environment["GIT_FLEET_LOG_LEVEL"] = "warn"
        environment["PATH"] = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
        process.environment = environment
        process.standardOutput = outputPipe
        process.standardError = outputPipe
        process.terminationHandler = { [weak self] process in
            guard process.terminationStatus != 0 else { return }
            let diagnostic = "本地服务异常退出：status=\(process.terminationStatus), reason=\(process.terminationReason.rawValue)"
            DispatchQueue.main.async {
                self?.backendFailureMessage = diagnostic
                self?.appendBackendLog(diagnostic)
                if self?.window?.isVisible == true {
                    self?.presentFatalError("\(diagnostic)，请查看 \(logURL.path)", title: "Moo Fleet 运行异常")
                }
            }
        }
        do {
            try process.run()
        } catch {
            outputPipe.fileHandleForReading.readabilityHandler = nil
            try? outputPipe.fileHandleForReading.close()
            try? outputPipe.fileHandleForWriting.close()
            log.close()
            throw error
        }
        backend = process
        backendOutputPipe = outputPipe
        backendLog = log
        backendLogURL = logURL
    }

    private func appendBackendLog(_ message: String) {
        let timestamp = ISO8601DateFormatter().string(from: Date())
        backendLog?.write("[\(timestamp)] \(message)\n")
    }

    private func stopBackend() {
        guard let process = backend else { return }
        process.terminationHandler = nil
        if process.isRunning {
            process.terminate()
            process.waitUntilExit()
        }
        if let outputPipe = backendOutputPipe {
            outputPipe.fileHandleForReading.readabilityHandler = nil
            try? outputPipe.fileHandleForWriting.close()
            let remainingOutput = outputPipe.fileHandleForReading.readDataToEndOfFile()
            backendLog?.write(remainingOutput)
            try? outputPipe.fileHandleForReading.close()
        }
        backendLog?.close()
        backendOutputPipe = nil
        backendLog = nil
        backend = nil
    }

    private func waitForBackend(port: Int, attemptsRemaining: Int) {
        guard attemptsRemaining > 0 else {
            let detail = backendFailureMessage ?? "本地服务启动超时"
            presentFatalError("\(detail)，请查看 \(backendLogURL?.path ?? "应用日志")")
            return
        }
        if let backend, !backend.isRunning {
            let detail = backendFailureMessage ?? "本地服务进程已退出"
            presentFatalError("\(detail)，请查看 \(backendLogURL?.path ?? "应用日志")")
            return
        }
        let url = URL(string: "http://127.0.0.1:\(port)/api/health")!
        URLSession.shared.dataTask(with: url) { [weak self] _, response, _ in
            if (response as? HTTPURLResponse)?.statusCode == 200 {
                DispatchQueue.main.async {
                    self?.webView.load(URLRequest(url: URL(string: "http://127.0.0.1:\(port)/")!))
                }
                return
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
                self?.waitForBackend(port: port, attemptsRemaining: attemptsRemaining - 1)
            }
        }.resume()
    }

    private func applicationSupportDirectory() throws -> URL {
        let base = try FileManager.default.url(
            for: .applicationSupportDirectory,
            in: .userDomainMask,
            appropriateFor: nil,
            create: true
        )
        let directory = base.appendingPathComponent("Moo Fleet", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: directory.path)
        return directory
    }

    private func availablePort() throws -> Int {
        for _ in 0..<100 {
            let candidate = Int.random(in: 18000...28000)
            let descriptor = socket(AF_INET, SOCK_STREAM, 0)
            guard descriptor >= 0 else { continue }
            defer { close(descriptor) }
            var address = sockaddr_in()
            address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
            address.sin_family = sa_family_t(AF_INET)
            address.sin_port = in_port_t(candidate).bigEndian
            address.sin_addr = in_addr(s_addr: inet_addr("127.0.0.1"))
            let result = withUnsafePointer(to: &address) {
                $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                    Darwin.bind(descriptor, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
                }
            }
            if result == 0 { return candidate }
        }
        throw NSError(domain: "MooFleet", code: 2, userInfo: [NSLocalizedDescriptionKey: "无法找到可用的本地端口"])
    }

    private func presentFatalError(_ message: String, title: String = "Moo Fleet 无法启动") {
        let alert = NSAlert()
        alert.alertStyle = .critical
        alert.messageText = title
        alert.informativeText = message
        alert.addButton(withTitle: "退出")
        alert.runModal()
        NSApp.terminate(nil)
    }
}

@main
struct MooFleetApplication {
    static func main() {
        let application = NSApplication.shared
        let delegate = AppDelegate()
        application.delegate = delegate
        application.setActivationPolicy(.regular)
        application.run()
    }
}
