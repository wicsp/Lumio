import AppKit
import ApplicationServices
import AVFoundation
import LumioCaptureCore
import ServiceManagement

/// 菜单栏显示的 Hub 连接状态。
enum Connection: Equatable {
    case unpaired, checking, connected, unreachable

    func title(host: String?) -> String {
        let place = host.map { " · \($0)" } ?? ""
        switch self {
        case .unpaired: return "未配对"
        case .checking: return "正在连接\(place)"
        case .connected: return "已连接\(place)"
        case .unreachable: return "Hub 不可达\(place)"
        }
    }

    var badge: NSImage? {
        let symbol: String, color: NSColor
        switch self {
        case .connected: symbol = "circle.fill"; color = .systemGreen
        case .checking: symbol = "circle.dotted"; color = .secondaryLabelColor
        case .unreachable: symbol = "circle.fill"; color = .systemRed
        case .unpaired: symbol = "circle"; color = .secondaryLabelColor
        }
        let config = NSImage.SymbolConfiguration(pointSize: 8, weight: .regular).applying(.init(paletteColors: [color]))
        return NSImage(systemSymbolName: symbol, accessibilityDescription: nil)?.withSymbolConfiguration(config)
    }
}

@MainActor final class CaptureApp: NSObject, NSApplicationDelegate, NSMenuDelegate {
    static let defaultExclusions: Set<String> = [
        "com.1password.1password", "com.agilebits.onepassword7", "com.apple.keychainaccess",
        "com.apple.Passwords", "com.apple.systempreferences", "com.bitwarden.desktop",
        "com.dashlane.dashlanephonefinal", "com.lastpass.LastPass", "org.keepassxc.keepassxc",
    ]

    private let status = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
    private let hotKey = HotKey()
    private let browserBridge = BrowserBridge()
    private let panel = FeedbackPanel()
    private let settings = UserDefaults.standard
    private var connection = Connection.unpaired
    private weak var statusLine: NSMenuItem?
    private var capture: Task<ScreenCapture, Error>?
    private var browserPage: Task<BrowserPage?, Never>?
    private var submission: Task<Void, Never>?
    private var press: Press?
    private var sampler: Timer?
    private var speech: SpeechCapture?
    private var holdTimer: Task<Void, Never>?
    private var speechProblem: String?
    private var activeHub: Hub?
    private var permissionObserver: NSObjectProtocol?
    private var sound: Bool { !settings.bool(forKey: "mute") }

    private var hub: Hub? {
        guard let raw = settings.string(forKey: "origin"), let origin = try? Hub.origin(from: raw), let token = CredentialStore.read() else { return nil }
        return Hub(origin: origin, token: token)
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        status.button?.image = NSImage(systemSymbolName: "viewfinder", accessibilityDescription: "Lumio")
        status.button?.image?.isTemplate = true
        let menu = NSMenu()
        menu.delegate = self
        status.menu = menu
        if let data = settings.data(forKey: "trigger"), let saved = try? JSONDecoder().decode(Trigger.self, from: data) { hotKey.trigger = saved }
        hotKey.onPress = { [weak self] in self?.begin(at: $0) }
        hotKey.onRelease = { [weak self] in self?.finish() }
        hotKey.onCancel = { [weak self] in self?.cancel() }
        startBrowserBridge()
        refresh()
        if Bundle.main.bundleIdentifier == "io.lumio.capture", !settings.bool(forKey: "loginConfigured") {
            changeLogin(start: true)
        }
        permissionObserver = NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in _ = self?.hotKey.start() }
        }
        if !settings.bool(forKey: "started") {
            settings.set(true, forKey: "started")
            permissions()
        }
    }

    /// 菜单按用途分段：状态（连接、触发方式、缺少的权限）→ 打开 Lumio → 连接 → 设置 → 退出。
    /// 开关类选项用勾选表示当前状态，不再用「打开…/关闭…」交替的文字。
    func menuWillOpen(_ menu: NSMenu) {
        menu.removeAllItems()
        menu.autoenablesItems = false
        @discardableResult
        func add(_ title: String, _ action: Selector?, key: String = "", on: Bool = false) -> NSMenuItem {
            let item = menu.addItem(withTitle: title, action: action, keyEquivalent: key)
            item.target = self
            item.isEnabled = action != nil
            item.state = on ? .on : .off
            return item
        }
        let paired = hub != nil
        let header = add(connection.title(host: hostLabel), nil)
        header.image = connection.badge
        statusLine = header
        add(paired ? "轻点 \(hotKey.trigger.display) 收藏 · 按住说话" : "配对后即可使用 \(hotKey.trigger.display) 收藏", nil)
        let missing = Self.missingPermissions()
        if !missing.isEmpty {
            let item = add("缺少权限：\(missing.joined(separator: "、"))…", #selector(permissions))
            item.image = NSImage(systemSymbolName: "exclamationmark.triangle", accessibilityDescription: nil)
        }
        if paired {
            menu.addItem(.separator())
            add("打开 Lumio", #selector(openLumio), key: "o")
        }
        menu.addItem(.separator())
        menu.addItem(.sectionHeader(title: "连接"))
        add(paired ? "重新配对…" : "配对…", #selector(pair))
        if paired { add("断开", #selector(disconnect)) }
        add(browserBridge.connected ? "浏览器扩展已连接…" : "配对浏览器扩展…", #selector(pairBrowser), on: browserBridge.connected)
        if settings.string(forKey: "browserExtensionID") != nil {
            add("断开浏览器扩展", #selector(disconnectBrowser))
        }
        menu.addItem(.separator())
        menu.addItem(.sectionHeader(title: "设置"))
        add("触发键：\(hotKey.trigger.display)…", #selector(changeTrigger))
        add("排除的 App…", #selector(editExclusions))
        add("提示音", #selector(toggleSound), on: sound)
        if Bundle.main.bundleIdentifier == "io.lumio.capture" {
            switch SMAppService.mainApp.status {
            case .enabled: add("登录时启动", #selector(toggleLogin), on: true)
            case .requiresApproval: add("登录时启动（需在系统设置允许）…", #selector(openLoginSettings))
            default: add("登录时启动", #selector(toggleLogin))
            }
        }
        add("权限检查…", #selector(permissions))
        menu.addItem(.separator())
        add("退出 Lumio Capture", #selector(quit), key: "q")
        refresh()
    }

    private var hostLabel: String? {
        guard let raw = settings.string(forKey: "origin"), let url = URL(string: raw), let host = url.host else { return nil }
        return url.port.map { "\(host):\($0)" } ?? host
    }

    /// 截图、读取选中文字、监听触发键必需；麦克风只在按住说话时需要，也一并提示。
    static func missingPermissions() -> [String] {
        [("屏幕录制", CGPreflightScreenCaptureAccess()), ("辅助功能", AXIsProcessTrusted()),
         ("输入监控", CGPreflightListenEventAccess()), ("麦克风", AVCaptureDevice.authorizationStatus(for: .audio) == .authorized)]
            .filter { !$0.1 }.map { $0.0 }
    }

    private func refresh() {
        _ = hotKey.start()
        guard let hub else { show(.unpaired); return }
        if connection == .unpaired { show(.checking) }
        Task {
            do { try await hub.ping(); show(.connected) }
            catch { show(.unreachable) }
        }
    }

    /// 更新菜单栏图标、提示和已打开菜单里的状态行。未连接时图标变灰。
    private func show(_ state: Connection) {
        connection = state
        status.button?.appearsDisabled = state != .connected
        status.button?.toolTip = "Lumio Capture · \(state.title(host: hostLabel))"
        statusLine?.title = state.title(host: hostLabel)
        statusLine?.image = state.badge
    }

    @objc private func openLumio() {
        guard let raw = settings.string(forKey: "origin"), let url = URL(string: raw) else { return }
        NSWorkspace.shared.open(url)
    }

    private func begin(at pointer: CGPoint) {
        guard capture == nil, submission == nil else { return }
        guard let hub else { panel.show("请先配对 Hub", sound: sound ? "Basso" : nil); return }
        guard let front = NSWorkspace.shared.frontmostApplication, front.processIdentifier != ProcessInfo.processInfo.processIdentifier else { return }
        let excluded = Self.defaultExclusions.union(settings.stringArray(forKey: "exclusions") ?? [])
        if let bundle = front.bundleIdentifier, excluded.contains(bundle) { panel.show("这个 App 不截取"); return }
        activeHub = hub
        let now = ProcessInfo.processInfo.systemUptime
        var timing = Press(started: now)
        timing.add(pointer, at: now)
        press = timing
        sampler = Timer.scheduledTimer(withTimeInterval: CaptureLimits.sampleSeconds, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated {
                if let location = CGEvent(source: nil)?.location {
                    self?.press?.add(location, at: ProcessInfo.processInfo.systemUptime)
                }
            }
        }
        capture = Task { try await ScreenCapture.collect(app: front, at: pointer, hub: hub) }
        browserPage = Task { [browserBridge] in await browserBridge.capture(bundle: front.bundleIdentifier) }
        if sound { NSSound(named: "Tink")?.play() }
        speechProblem = nil
        holdTimer = Task { [weak self] in
            try? await Task.sleep(for: .seconds(CaptureLimits.tapSeconds))
            guard let self, !Task.isCancelled, press != nil else { return }
            do {
                speech = try SpeechCapture(hub: hub) { [weak self] text in
                    self?.panel.show(text.isEmpty ? "正在听…" : text, seconds: nil)
                }
                panel.show("正在听…", seconds: nil)
            } catch { speechProblem = error.localizedDescription }
        }
    }

    private func finish() {
        sampler?.invalidate()
        sampler = nil
        guard let capture, let press, let hub = activeHub else { return }
        holdTimer?.cancel()
        holdTimer = nil
        let speech = self.speech
        let browserPage = self.browserPage
        self.browserPage = nil
        self.speech = nil
        speech?.release()
        self.capture = nil
        self.press = nil
        activeHub = nil
        let held = !press.isTap(at: ProcessInfo.processInfo.systemUptime)
        let problem = speechProblem
        submission = Task {
            defer { browserPage?.cancel(); submission = nil }
            var uploaded: Hub.Glance?
            var savedIdea: String?
            do {
                let screen = try await capture.value
                try Task.checkCancellation()
                let snapshot = await browserPage?.value
                let page = snapshot.flatMap { $0.url == screen.url && !hub.isLocal($0.url) ? $0 : nil }
                if page != nil, sound { NSSound(named: "Pop")?.play() }
                let (meta, image) = try await screen.request(press: press, includeTrail: held)
                var transcript = "", speechFailure = problem
                if let speech {
                    panel.show("正在识别…", seconds: nil)
                    do { transcript = try await speech.finalText().trimmingCharacters(in: .whitespacesAndNewlines) }
                    catch { speechFailure = error.localizedDescription }
                }
                try Task.checkCancellation()
                let glance = try await hub.upload(meta, image: image, page: page)
                uploaded = glance
                try Task.checkCancellation()
                if transcript.isEmpty {
                    let saved = try await hub.save(glance, waitForPage: page != nil)
                    let note = speechFailure.map { "\n语音不可用 · \($0)" } ?? ""
                    let status = saved.ready ? "已收藏" : "正在入库"
                    panel.show("\(status) · \(saved.title)\(note)", sound: sound && saved.ready ? "Glass" : nil)
                } else {
                    let conversation = try await hub.mainConversation()
                    let url = hub.conversationURL(conversation)
                    panel.show("正在保存想法…", seconds: nil, url: url)
                    try await hub.chat(ChatRequest(conversation: conversation, message: transcript, glance: glance.id, recordIdea: true)) { state in
                        savedIdea = state.idea ?? savedIdea
                        let status = savedIdea == nil ? "正在保存想法…" : "已记下想法"
                        let reply = state.reply.isEmpty ? status : "\(status)\n\n\(state.reply)"
                        let target = state.reply.isEmpty ? savedIdea.map(hub.noteURL) ?? url : url
                        panel.show(reply, seconds: state.finished ? 25 : nil, url: target, expandable: !state.reply.isEmpty)
                    }
                }
            } catch {
                if let uploaded { try? await hub.discard(uploaded) }
                if !Task.isCancelled {
                    if let savedIdea {
                        panel.show("已记下想法\n\n助手回复中断：\(error.localizedDescription)", seconds: 25, url: hub.noteURL(savedIdea))
                    } else {
                        panel.show(error.localizedDescription, sound: sound ? "Basso" : nil)
                    }
                }
            }
        }
    }

    private func cancel() {
        sampler?.invalidate()
        sampler = nil
        holdTimer?.cancel()
        holdTimer = nil
        speech?.cancel()
        speech = nil
        capture?.cancel()
        browserPage?.cancel()
        browserPage = nil
        capture = nil
        press = nil
        activeHub = nil
        submission?.cancel()
        panel.show("已取消")
    }

    private static let browsers = [
        ("ego lite", "com.citrolabs.ego.lite"),
        ("Google Chrome", "com.google.Chrome"),
        ("Microsoft Edge", "com.microsoft.edgemac"),
        ("Arc", "company.thebrowser.Browser"),
    ]

    private func startBrowserBridge() {
        guard let id = settings.string(forKey: "browserExtensionID"), BrowserBridge.extensionID(id),
              let browser = settings.string(forKey: "browserBundle"),
              Self.browsers.contains(where: { $0.1 == browser }),
              let key = CredentialStore.read(account: "browser-bridge") else { return }
        do { try browserBridge.start(extensionID: id, browser: browser, secret: key) }
        catch { panel.show("无法启动浏览器连接") }
    }

    @objc private func pairBrowser() {
        let selected = Self.browsers.firstIndex(where: { $0.1 == settings.string(forKey: "browserBundle") }) ?? 0
        let dialog = BrowserPairingDialog(savedID: settings.string(forKey: "browserExtensionID"),
                                          browsers: Self.browsers.map(\.0), selectedBrowser: selected)
        guard let pairing = dialog.run() else { return }
        do {
            let key = try BrowserBridge.key()
            try CredentialStore.write(key, account: "browser-bridge")
            settings.set(pairing.id, forKey: "browserExtensionID")
            settings.set(Self.browsers[pairing.browserIndex].1, forKey: "browserBundle")
            startBrowserBridge()
            let code = NSAlert()
            code.messageText = "本机浏览器配对码"
            code.informativeText = "把配对码粘贴到 Save to Lumio 的「配对桌面捕获」。"
            let text = NSTextField(labelWithString: key)
            text.font = .monospacedSystemFont(ofSize: 11, weight: .regular)
            text.isSelectable = true
            text.sizeToFit()
            code.accessoryView = text
            code.addButton(withTitle: "复制配对码")
            code.addButton(withTitle: "关闭")
            if code.runModal() == .alertFirstButtonReturn {
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(key, forType: .string)
            }
        } catch { panel.show(error.localizedDescription) }
    }

    @objc private func disconnectBrowser() {
        do {
            try CredentialStore.remove(account: "browser-bridge")
            settings.removeObject(forKey: "browserExtensionID")
            settings.removeObject(forKey: "browserBundle")
            browserBridge.stop()
        } catch { panel.show(error.localizedDescription) }
    }

    @objc private func pair() {
        let dialog = NSAlert()
        dialog.messageText = "配对 Lumio"
        dialog.informativeText = "在 Lumio 设置中生成客户端配对码。"
        dialog.addButton(withTitle: "配对")
        dialog.addButton(withTitle: "取消")
        let url = NSTextField(string: settings.string(forKey: "origin") ?? "http://127.0.0.1:7420")
        url.placeholderString = "Hub 地址"
        url.setAccessibilityLabel("Hub 地址")
        let code = NSSecureTextField()
        code.placeholderString = "配对码"
        code.setAccessibilityLabel("配对码")
        let width: CGFloat = 320
        let fieldHeight: CGFloat = 24
        let spacing: CGFloat = 8
        let form = NSView(frame: NSRect(x: 0, y: 0, width: width, height: fieldHeight * 2 + spacing))
        url.frame = NSRect(x: 0, y: fieldHeight + spacing, width: width, height: fieldHeight)
        code.frame = NSRect(x: 0, y: 0, width: width, height: fieldHeight)
        form.addSubview(url)
        form.addSubview(code)
        dialog.accessoryView = form
        dialog.layout()
        url.nextKeyView = code
        dialog.window.initialFirstResponder = url
        NSApp.activate(ignoringOtherApps: true)
        guard dialog.runModal() == .alertFirstButtonReturn else { return }
        Task {
            do {
                let origin = try Hub.origin(from: url.stringValue)
                let token = try await Hub(origin: origin, token: nil).pair(code: code.stringValue.trimmingCharacters(in: .whitespacesAndNewlines))
                try CredentialStore.write(token)
                settings.set(origin.absoluteString, forKey: "origin")
                connection = .unpaired
                panel.show("已配对 · 轻点 \(hotKey.trigger.display) 收藏", sound: sound ? "Glass" : nil)
                refresh()
            } catch { panel.show(error.localizedDescription, sound: sound ? "Basso" : nil) }
        }
    }

    @objc private func disconnect() {
        do {
            try CredentialStore.remove()
            settings.removeObject(forKey: "origin")
            refresh()
            panel.show("已断开")
        } catch { panel.show(error.localizedDescription) }
    }

    @objc private func changeTrigger() {
        guard hotKey.start() else { permissions(); return }
        panel.show("请按新的触发键，支持键盘或鼠标侧键。Esc 取消。", seconds: 10)
        hotKey.learning = { [weak self] value in
            guard let self else { return }
            hotKey.trigger = value
            if let data = try? JSONEncoder().encode(value) { settings.set(data, forKey: "trigger") }
            panel.show("触发键 · \(value.display)")
        }
        Task {
            try? await Task.sleep(for: .seconds(10))
            hotKey.learning = nil
        }
    }

    @objc private func editExclusions() {
        let dialog = NSAlert()
        dialog.messageText = "排除的 App"
        dialog.informativeText = "输入额外的 bundle ID，以逗号分隔。\n始终排除：\(Self.defaultExclusions.sorted().joined(separator: ", "))"
        let field = NSTextField(string: (settings.stringArray(forKey: "exclusions") ?? []).joined(separator: ", "))
        field.frame.size.width = 320
        dialog.accessoryView = field
        dialog.addButton(withTitle: "保存")
        dialog.addButton(withTitle: "取消")
        NSApp.activate(ignoringOtherApps: true)
        guard dialog.runModal() == .alertFirstButtonReturn else { return }
        settings.set(field.stringValue.split(separator: ",").map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }, forKey: "exclusions")
    }

    @objc private func permissions() {
        let items: [(String, Bool, String)] = [
            ("屏幕录制", CGPreflightScreenCaptureAccess(), "Privacy_ScreenCapture"),
            ("辅助功能", AXIsProcessTrusted(), "Privacy_Accessibility"),
            ("输入监控", CGPreflightListenEventAccess(), "Privacy_ListenEvent"),
            ("麦克风", AVCaptureDevice.authorizationStatus(for: .audio) == .authorized, "Privacy_Microphone"),
            ("自动化（各浏览器首次读取网址时申请）", true, "Privacy_Automation"),
        ]
        let dialog = NSAlert()
        dialog.messageText = "权限检查"
        dialog.informativeText = items.map { "\($0.1 ? "·" : "○") \($0.0)" }.joined(separator: "\n")
        let missing = items.filter { !$0.1 }
        for item in missing { dialog.addButton(withTitle: item.0) }
        dialog.addButton(withTitle: "完成")
        NSApp.activate(ignoringOtherApps: true)
        let index = dialog.runModal().rawValue - NSApplication.ModalResponse.alertFirstButtonReturn.rawValue
        if missing.indices.contains(index) {
            switch missing[index].2 {
            case "Privacy_ScreenCapture": _ = CGRequestScreenCaptureAccess()
            case "Privacy_Accessibility": _ = AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary)
            case "Privacy_ListenEvent": _ = CGRequestListenEventAccess()
            case "Privacy_Microphone":
                Task { _ = await AVCaptureDevice.requestAccess(for: .audio) }
            default: break
            }
            if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?\(missing[index].2)") {
                NSWorkspace.shared.open(url)
            }
        }
        refresh()
    }

    private func changeLogin(start: Bool) {
        do {
            if start {
                if SMAppService.mainApp.status == .notRegistered || SMAppService.mainApp.status == .notFound {
                    try SMAppService.mainApp.register()
                }
            } else {
                try SMAppService.mainApp.unregister()
            }
            settings.set(true, forKey: "loginConfigured")
            if SMAppService.mainApp.status == .requiresApproval { panel.show("请在系统设置允许 Lumio 登录时启动") }
        } catch { panel.show(error.localizedDescription) }
    }

    @objc private func toggleLogin() { changeLogin(start: SMAppService.mainApp.status != .enabled) }
    @objc private func openLoginSettings() { SMAppService.openSystemSettingsLoginItems() }
    @objc private func toggleSound() { settings.set(sound, forKey: "mute") }
    @objc private func quit() { NSApp.terminate(nil) }
}

MainActor.assumeIsolated {
    let app = NSApplication.shared
    let delegate = CaptureApp()
    app.delegate = delegate
    app.setActivationPolicy(.accessory)
    app.run()
}
