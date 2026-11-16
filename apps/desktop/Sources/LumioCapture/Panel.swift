import AppKit

@MainActor final class FeedbackPanel: NSObject {
    private let panel = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 354, height: 132), styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
    private let label = NSTextField(wrappingLabelWithString: "")

    private let more = NSButton(title: "展开", target: nil, action: nil)
    private let open = NSButton(title: "在 Lumio 中打开", target: nil, action: nil)
    private var targetURL: URL?
    private var fullText = ""
    private var hide: Task<Void, Never>?

    override init() {
        super.init()
        panel.level = .floating
        panel.isOpaque = false
        panel.hasShadow = true
        panel.backgroundColor = .clear
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .ignoresCycle]
        let background = NSVisualEffectView(frame: panel.contentView!.bounds)
        background.material = .hudWindow
        background.state = .active
        background.wantsLayer = true
        background.layer?.cornerRadius = 14
        background.layer?.masksToBounds = true
        panel.contentView = background
        label.textColor = .labelColor
        label.font = .systemFont(ofSize: 15, weight: .medium)
        label.maximumNumberOfLines = 3
        label.translatesAutoresizingMaskIntoConstraints = false
        let actions = NSStackView(views: [more, open])
        actions.translatesAutoresizingMaskIntoConstraints = false
        for (button, action) in [(more, #selector(expand)), (open, #selector(openLumio))] {
            button.target = self
            button.action = action
            button.bezelStyle = .rounded
        }
        background.addSubview(label)
        background.addSubview(actions)
        NSLayoutConstraint.activate([
            label.leadingAnchor.constraint(equalTo: background.leadingAnchor, constant: 20),
            label.trailingAnchor.constraint(equalTo: background.trailingAnchor, constant: -20),
            label.topAnchor.constraint(equalTo: background.topAnchor, constant: 17),
            actions.leadingAnchor.constraint(equalTo: label.leadingAnchor),
            actions.bottomAnchor.constraint(equalTo: background.bottomAnchor, constant: -14),
        ])
    }

    func show(_ text: String, seconds: Int? = 4, sound: String? = nil, url: URL? = nil, expandable: Bool = false) {
        hide?.cancel()
        fullText = text
        targetURL = url
        more.isHidden = !expandable
        open.isHidden = url == nil
        label.stringValue = text
        let mouse = NSEvent.mouseLocation
        if let screen = NSScreen.screens.first(where: { $0.frame.contains(mouse) }) ?? NSScreen.main {
            let frame = screen.visibleFrame
            panel.setFrameOrigin(NSPoint(x: frame.maxX - panel.frame.width - 18, y: frame.maxY - panel.frame.height - 18))
        }
        panel.orderFrontRegardless()
        if let sound { NSSound(named: NSSound.Name(sound))?.play() }
        if let seconds {
            hide = Task { [weak self] in
                try? await Task.sleep(for: .seconds(seconds))
                if !Task.isCancelled { self?.panel.orderOut(nil) }
            }
        }
    }
    @objc private func openLumio() {
        if let targetURL { NSWorkspace.shared.open(targetURL) }
    }

    @objc private func expand() {
        let alert = NSAlert()
        alert.messageText = "Lumio 助手"
        let scroll = NSScrollView(frame: NSRect(x: 0, y: 0, width: 440, height: 270))
        scroll.hasVerticalScroller = true
        let text = NSTextView(frame: scroll.bounds)
        text.string = fullText
        text.isEditable = false
        text.isHorizontallyResizable = false
        text.isVerticallyResizable = true
        text.textContainer?.widthTracksTextView = true
        scroll.documentView = text
        alert.accessoryView = scroll
        alert.addButton(withTitle: "关闭")
        NSApp.activate(ignoringOtherApps: true)
        alert.runModal()
    }

}
