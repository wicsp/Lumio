import AppKit

@MainActor final class BrowserPairingDialog: NSObject, NSTextFieldDelegate {
    let alert: NSAlert
    let extensionID: NSTextField
    let browser: NSPopUpButton
    let pasteButton: NSButton
    let submit: NSButton
    private let pasteboard: NSPasteboard

    init(savedID: String?, browsers: [String], selectedBrowser: Int, pasteboard: NSPasteboard = .general) {
        self.pasteboard = pasteboard
        extensionID = NSTextField(string: savedID ?? "")
        browser = NSPopUpButton(frame: NSRect(x: 62, y: 0, width: 298, height: 26))
        pasteButton = NSButton(title: "粘贴", target: nil, action: nil)
        let alert = NSAlert()
        self.alert = alert
        alert.messageText = "配对浏览器扩展"
        alert.informativeText = "从 Save to Lumio 的设置复制扩展 ID，然后选择安装了该扩展的浏览器。"
        submit = alert.addButton(withTitle: "生成配对码")
        let cancel = alert.addButton(withTitle: "取消")
        super.init()

        // NSAlert measures its accessory before laying out subviews. Supply a complete frame.
        let form = NSView(frame: NSRect(x: 0, y: 0, width: 360, height: 88))
        let idLabel = NSTextField(labelWithString: "扩展 ID")
        idLabel.frame = NSRect(x: 0, y: 70, width: 290, height: 18)
        extensionID.frame = NSRect(x: 0, y: 40, width: 286, height: 24)
        extensionID.isEditable = true
        extensionID.isSelectable = true
        extensionID.usesSingleLineMode = true
        extensionID.setAccessibilityLabel(idLabel.stringValue)
        extensionID.delegate = self

        pasteButton.frame = NSRect(x: 292, y: 39, width: 68, height: 26)
        pasteButton.target = self
        pasteButton.action = #selector(pasteExtensionID)
        pasteButton.keyEquivalent = "v"
        pasteButton.keyEquivalentModifierMask = .command
        let browserLabel = NSTextField(labelWithString: "浏览器")
        browserLabel.frame = NSRect(x: 0, y: 4, width: 58, height: 18)
        browser.setAccessibilityLabel(browserLabel.stringValue)
        browser.addItems(withTitles: browsers)
        browser.selectItem(at: selectedBrowser)

        for view in [idLabel, extensionID, pasteButton, browserLabel, browser] as [NSView] { form.addSubview(view) }
        alert.accessoryView = form
        alert.layout()
        alert.window.initialFirstResponder = extensionID
        extensionID.nextKeyView = pasteButton
        pasteButton.nextKeyView = browser
        browser.nextKeyView = submit
        submit.nextKeyView = cancel
        cancel.nextKeyView = extensionID
        updateSubmit()
    }

    private var enteredID: String {
        (extensionID.currentEditor()?.string ?? extensionID.stringValue).trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func updateSubmit() { submit.isEnabled = BrowserBridge.extensionID(enteredID) }

    func controlTextDidChange(_ notification: Notification) { updateSubmit() }

    @objc private func pasteExtensionID() {
        guard let text = pasteboard.string(forType: .string) else { return }
        extensionID.abortEditing()
        extensionID.stringValue = text.trimmingCharacters(in: .whitespacesAndNewlines)
        alert.window.makeFirstResponder(extensionID)
        updateSubmit()
    }

    func run() -> (id: String, browserIndex: Int)? {
        NSApp.activate(ignoringOtherApps: true)
        guard alert.runModal() == .alertFirstButtonReturn else { return nil }
        let id = enteredID
        guard BrowserBridge.extensionID(id) else { return nil }
        return (id, browser.indexOfSelectedItem)
    }
}
