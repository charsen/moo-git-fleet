import AppKit
import Darwin
import Foundation
import WebKit

final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
    /// 五套主题的导航 / 画布底色，与 `styles.css` 里 `--color-navigation`、`--color-canvas` 一致。
    ///
    /// 标题栏是透明的（`titlebarAppearsTransparent`），透出的就是 `NSWindow` 的底色；
    /// 首帧之前内容区还盖着一层画布色遮罩。这两处都要在网页画出第一帧之前上色，
    /// 所以外壳得先按配置里选的主题自己取一次值。页面加载完会通过 `appearance` 通道
    /// 把计算值发回来，之后以网页为准——这张表只管启动那一两秒。
    /// 用 sRGB 而不是 calibrated：网页里的色值都是 sRGB，走 generic RGB 会偏色。
    private static let themeColors: [String: (navigation: NSColor, canvas: NSColor)] = [
        "fleet-blue": (srgb(0x0a0d14), srgb(0x0b0f17)),
        "mooeen": (srgb(0x000000), srgb(0x000000)),
        "dark-modern": (srgb(0x181818), srgb(0x181818)),
        "monokai": (srgb(0x1e1f1c), srgb(0x1e1f1c)),
        "dark-high-contrast": (srgb(0x000000), srgb(0x000000)),
    ]
    private static let defaultThemeName = "fleet-blue"

    private static func srgb(_ rgb: UInt32) -> NSColor {
        NSColor(
            srgbRed: CGFloat((rgb >> 16) & 0xff) / 255,
            green: CGFloat((rgb >> 8) & 0xff) / 255,
            blue: CGFloat(rgb & 0xff) / 255,
            alpha: 1
        )
    }

    /// `#rgb` / `#rrggbb` → NSColor；网页发回来的就是这两种写法。
    private static func parseHexColor(_ value: String) -> NSColor? {
        var hex = value.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if hex.hasPrefix("#") { hex.removeFirst() }
        if hex.count == 3 { hex = hex.map { "\($0)\($0)" }.joined() }
        guard hex.count == 6, let rgb = UInt32(hex, radix: 16) else { return nil }
        return srgb(rgb)
    }

    private var window: NSWindow!
    private var webView: WKWebView!
    /// 标题栏透出的底色（`--color-navigation`）。
    private var navigationColor: NSColor = AppDelegate.themeColors[AppDelegate.defaultThemeName]!.navigation
    /// 内容区兜底色（`--color-canvas`）。
    private var canvasColor: NSColor = AppDelegate.themeColors[AppDelegate.defaultThemeName]!.canvas
    /// 首帧之前盖在网页上方的一层画布色遮罩。
    ///
    /// `underPageBackgroundColor` 管不到这一段：实测首帧前内容区画的是系统深色窗口的灰
    /// （#282828），不是我们设的颜色，于是在深蓝画布上闪一下更亮的灰。
    /// 自己盖一层同色视图最稳，页面画完再淡出。
    private var launchCover: NSView?
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
            // 先按配置里的主题上色，再建窗口：顺序反了会先闪一帧默认主题的深蓝。
            if let support = try? applicationSupportDirectory() {
                applyStoredTheme(from: support)
            }
            let port = try availablePort()
            backendPort = port
            try startBackend(port: port)
            createWindow()
            waitForBackend(port: port, attemptsRemaining: 80)
        } catch {
            presentFatalError(error.localizedDescription)
        }
    }

    /// 读取配置里保存的主题，取到启动用的两层底色。
    ///
    /// 读不到就用默认主题：网页加载完会立刻把真实值发回来，这里错了也只错一帧。
    private func applyStoredTheme(from support: URL) {
        let name = storedThemeName(from: support)
        guard let colors = Self.themeColors[name] else { return }
        navigationColor = colors.navigation
        canvasColor = colors.canvas
    }

    /// 从 `config/profile.yaml` 里取 `theme:` 那一行。
    ///
    /// 只为这一个字段引入 YAML 解析不划算，所以按行找：缩进无所谓，值不在主题表里就
    /// 视为没配置。
    private func storedThemeName(from support: URL) -> String {
        let profileURL = support.appendingPathComponent("config/profile.yaml")
        guard let text = try? String(contentsOf: profileURL, encoding: .utf8) else {
            return Self.defaultThemeName
        }
        for line in text.split(separator: "\n") where line.contains("theme:") {
            let value = line.split(separator: ":", maxSplits: 1).last!
                .trimmingCharacters(in: .whitespaces)
            if Self.themeColors[value] != nil { return value }
        }
        return Self.defaultThemeName
    }

    /// 网页侧 `applyTheme()` 把计算出来的两层底色发回来。
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == "appearance", let body = message.body as? [String: Any] else { return }
        if let value = body["navigation"] as? String, let color = Self.parseHexColor(value) {
            navigationColor = color
            window?.backgroundColor = color
        }
        if let value = body["canvas"] as? String, let color = Self.parseHexColor(value) {
            canvasColor = color
            webView?.underPageBackgroundColor = color
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

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    func applicationWillTerminate(_ notification: Notification) {
        stopBackend()
    }

    func windowWillClose(_ notification: Notification) {
        stopBackend()
    }

    /// 关闭按钮只收起窗口：本地服务和工作台继续保持运行，退出仍需显式使用 ⌘Q 或应用菜单。
    func windowShouldClose(_ sender: NSWindow) -> Bool {
        hideMainWindow()
        return false
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag {
            showMainWindow(nil)
        }
        return true
    }

    private func hideMainWindow() {
        window?.orderOut(nil)
    }

    @objc private func showMainWindow(_ sender: Any?) {
        guard let window else { return }
        if window.isMiniaturized {
            window.deminiaturize(nil)
        }
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    private func createWindow() {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        // 网页切主题后把两层底色发回来，标题栏跟着换色。要在建 webView 之前挂上。
        configuration.userContentController.add(self, name: "appearance")
        webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        // 透明页面的兜底色：仍设成画布色，避免页面自己声明透明时露出系统灰。
        webView.underPageBackgroundColor = canvasColor

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
        // 标题栏透明，这一条就是它透出来的颜色；用导航色而不是画布色，
        // 和网页顶栏接得上，不会出现「顶上一条比顶栏更深/更浅的带子」。
        window.backgroundColor = navigationColor
        window.titlebarAppearsTransparent = true
        window.titleVisibility = .hidden
        window.titlebarSeparatorStyle = .none
        installLaunchCover()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    /// 盖住网页的首帧。
    ///
    /// 遮罩直接挂在 webView 上，不改成「容器 + 两个子视图」：webView 本身就是 contentView，
    /// 换容器等于把窗口的几何重算一遍，而这里只需要一层跟着它缩放的覆盖层。
    private func installLaunchCover() {
        let cover = NSView(frame: webView.bounds)
        cover.wantsLayer = true
        cover.layer?.backgroundColor = canvasColor.cgColor
        cover.autoresizingMask = [.width, .height]
        webView.addSubview(cover)
        launchCover = cover
        // 兜底：万一导航回调一直不来（后端卡住、被系统拦下），8 秒后无条件撤掉，
        // 宁可露出页面原样，也不要留一块永远不动的纯色。
        DispatchQueue.main.asyncAfter(deadline: .now() + 8) { [weak self] in
            self?.revealPage()
        }
    }

    /// 页面已经画出内容，把遮罩淡出。
    ///
    /// 不用 `didCommit`：那只是开始收到数据，画布未必已经铺好，早撤一层等于没盖。
    /// 淡出 0.18 秒而不是直接移除，是为了避免「灰 → 亮」的硬切。
    private func revealPage() {
        guard let cover = launchCover else { return }
        launchCover = nil
        NSAnimationContext.runAnimationGroup { context in
            context.duration = 0.18
            cover.animator().alphaValue = 0
        } completionHandler: {
            cover.removeFromSuperview()
        }
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
        let showWindowItem = windowMenu.addItem(withTitle: "显示主窗口", action: #selector(showMainWindow(_:)), keyEquivalent: "0")
        showWindowItem.target = self
        windowMenu.addItem(NSMenuItem.separator())
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

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        revealPage()
    }

    /// 加载失败也要撤掉遮罩，否则窗口会停在纯色上，用户既看不到页面也看不到错误。
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        revealPage()
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        revealPage()
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
