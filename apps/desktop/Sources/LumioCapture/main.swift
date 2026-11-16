import AppKit
import ApplicationServices
import AVFoundation
import LumioCaptureCore

@MainActor final class CaptureApp: NSObject, NSApplicationDelegate, NSMenuDelegate {
    static let defaultExclusions: Set<String> = [
        "com.1password.1password", "com.agilebits.onepassword7", "com.apple.keychainaccess",
        "com.apple.Passwords", "com.apple.systempreferences", "com.bitwarden.desktop",
        "com.dashlane.dashlanephonefinal", "com.lastpass.LastPass", "org.keepassxc.keepassxc",
    ]

    private let status = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
    private let hotKey = HotKey()
    private let panel = FeedbackPanel()
    private let settings = UserDefaults.standard
    private var connection = "未配对"
    private var capture: Task<ScreenCapture, Error>?
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
        refresh()
        permissionObserver = NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in _ = self?.hotKey.start() }
        }
        if !settings.bool(forKey: "started") {
            settings.set(true, forKey: "started")
            permissions()
        }
    }

    func menuWillOpen(_ menu: NSMenu) {
        menu.removeAllItems()
        menu.addItem(withTitle: connection, action: nil, keyEquivalent: "")
        menu.addItem(.separator())
        func add(_ title: String, _ action: Selector) {
            menu.addItem(withTitle: title, action: action, keyEquivalent: "").target = self
        }
        add("配对…", #selector(pair))
        if hub != nil { add("断开", #selector(disconnect)) }
        add("触发键…（\(hotKey.trigger.display)）", #selector(changeTrigger))
        add("排除的 App…", #selector(editExclusions))
        add("权限检查", #selector(permissions))
        add(sound ? "关闭声音" : "打开声音", #selector(toggleSound))
        menu.addItem(.separator())
        add("退出", #selector(quit))
        refresh()
    }

    private func refresh() {
        _ = hotKey.start()
        guard let hub else { connection = "未配对"; return }
        Task {
            do { try await hub.ping(); connection = "已连接" }
            catch { connection = "Hub 不可达" }
            status.button?.toolTip = "Lumio · \(connection)"
        }
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
        self.speech = nil
        speech?.release()
        self.capture = nil
        self.press = nil
        activeHub = nil
        let held = !press.isTap(at: ProcessInfo.processInfo.systemUptime)
        let problem = speechProblem
        submission = Task {
            defer { submission = nil }
            var uploaded: Hub.Glance?
            do {
                let screen = try await capture.value
                try Task.checkCancellation()
                let (meta, image) = try await screen.request(press: press, includeTrail: held)
                var transcript = "", speechFailure = problem
                if let speech {
                    panel.show("正在识别…", seconds: nil)
                    do { transcript = try await speech.finalText().trimmingCharacters(in: .whitespacesAndNewlines) }
                    catch { speechFailure = error.localizedDescription }
                }
                try Task.checkCancellation()
                let glance = try await hub.upload(meta, image: image)
                uploaded = glance
                try Task.checkCancellation()
                if transcript.isEmpty {
                    let title = try await hub.save(glance)
                    let note = speechFailure.map { "\n语音不可用 · \($0)" } ?? ""
                    panel.show("已收藏 · \(title)\(note)", sound: sound ? "Glass" : nil)
                } else {
                    let conversation = try await hub.mainConversation()
                    let url = hub.conversationURL(conversation)
                    panel.show("正在等助手回答…", seconds: nil, url: url)
                    try await hub.chat(ChatRequest(conversation: conversation, message: transcript, glance: glance.id)) { state in
                        let confirmation = state.needsApproval ? "\n需要你确认" : ""
                        let reply = state.reply.isEmpty && !state.finished ? "正在等助手回答…" : state.reply
                        panel.show(reply + confirmation, seconds: state.finished ? 25 : nil, url: url, expandable: !state.reply.isEmpty)
                    }
                }
            } catch {
                if let uploaded { try? await hub.discard(uploaded) }
                if !Task.isCancelled { panel.show(error.localizedDescription, sound: sound ? "Basso" : nil) }
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
        capture = nil
        press = nil
        activeHub = nil
        submission?.cancel()
        panel.show("已取消")
    }

    @objc private func pair() {
        let dialog = NSAlert()
        dialog.messageText = "配对 Lumio"
        dialog.informativeText = "在 Lumio 设置中生成客户端配对码。"
        dialog.addButton(withTitle: "配对")
        dialog.addButton(withTitle: "取消")
        let url = NSTextField(string: settings.string(forKey: "origin") ?? "http://127.0.0.1:7420")
        let code = NSSecureTextField()
        code.placeholderString = "配对码"
        let form = NSStackView(views: [url, code])
        form.orientation = .vertical
        form.alignment = .width
        form.frame.size = NSSize(width: 290, height: 57)
        dialog.accessoryView = form
        dialog.window.initialFirstResponder = url
        NSApp.activate(ignoringOtherApps: true)
        guard dialog.runModal() == .alertFirstButtonReturn else { return }
        Task {
            do {
                let origin = try Hub.origin(from: url.stringValue)
                let token = try await Hub(origin: origin, token: nil).pair(code: code.stringValue.trimmingCharacters(in: .whitespacesAndNewlines))
                try CredentialStore.write(token)
                settings.set(origin.absoluteString, forKey: "origin")
                panel.show("已配对")
                refresh()
            } catch { panel.show(error.localizedDescription, sound: sound ? "Basso" : nil) }
        }
    }

    @objc private func disconnect() {
        do {
            try CredentialStore.remove()
            settings.removeObject(forKey: "origin")
            refresh()
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
