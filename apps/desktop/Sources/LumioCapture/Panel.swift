import AppKit

@MainActor final class FeedbackPanel {
    private let panel = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 354, height: 96), styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
    private let label = NSTextField(wrappingLabelWithString: "")
    private var hide: Task<Void, Never>?

    init() {
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
        background.addSubview(label)
        NSLayoutConstraint.activate([
            label.leadingAnchor.constraint(equalTo: background.leadingAnchor, constant: 20),
            label.trailingAnchor.constraint(equalTo: background.trailingAnchor, constant: -20),
            label.centerYAnchor.constraint(equalTo: background.centerYAnchor),
        ])
    }

    func show(_ text: String, seconds: Int? = 4, sound: String? = nil) {
        hide?.cancel()
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
}
