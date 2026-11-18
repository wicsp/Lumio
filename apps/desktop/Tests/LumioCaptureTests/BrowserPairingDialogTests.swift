import AppKit
@testable import LumioCapture
import XCTest

final class BrowserPairingDialogTests: XCTestCase {
    func testInputFitsBelowInstructionsAndReceivesInitialFocus() async throws {
        try await MainActor.run {
            _ = NSApplication.shared
            let dialog = BrowserPairingDialog(savedID: nil, browsers: ["ego lite", "Arc"], selectedBrowser: 1)
            let window = dialog.alert.window
            let content = try XCTUnwrap(window.contentView)
            content.layoutSubtreeIfNeeded()
            let form = try XCTUnwrap(dialog.alert.accessoryView)
            let instructions = try XCTUnwrap(content.subviews.compactMap { $0 as? NSTextField }
                .first { $0.stringValue == dialog.alert.informativeText })
            let instructionBounds = instructions.convert(instructions.bounds, to: content)
            XCTAssertLessThanOrEqual(form.convert(form.bounds, to: content).maxY, instructionBounds.minY)
            XCTAssertTrue(form.bounds.contains(dialog.extensionID.frame))
            XCTAssertTrue(form.bounds.contains(dialog.browser.frame))
            XCTAssertFalse(dialog.extensionID.frame.intersects(dialog.browser.frame))
            XCTAssertTrue(window.initialFirstResponder === dialog.extensionID)
            XCTAssertTrue(dialog.extensionID.isEditable)
            XCTAssertEqual(dialog.browser.titleOfSelectedItem, "Arc")
            XCTAssertFalse(dialog.submit.isEnabled)
        }
    }

    func testEditingAndPastingValidateTheExtensionIDWithoutClosingTheDialog() async throws {
        try await MainActor.run {
            _ = NSApplication.shared
            let board = NSPasteboard.withUniqueName()
            defer { board.releaseGlobally() }
            let dialog = BrowserPairingDialog(savedID: nil, browsers: ["ego lite"], selectedBrowser: 0, pasteboard: board)
            let window = dialog.alert.window
            XCTAssertTrue(window.makeFirstResponder(dialog.extensionID))
            let editor = try XCTUnwrap(dialog.extensionID.currentEditor() as? NSTextView)
            let valid = String(repeating: "a", count: 32)
            editor.insertText(valid, replacementRange: editor.selectedRange())
            XCTAssertTrue(dialog.submit.isEnabled)
            editor.insertText("z", replacementRange: editor.selectedRange())
            XCTAssertFalse(dialog.submit.isEnabled)

            board.clearContents()
            board.setString("  \(valid)\n", forType: .string)
            let shortcut = try XCTUnwrap(NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: .command,
                timestamp: 0, windowNumber: window.windowNumber, context: nil, characters: "v",
                charactersIgnoringModifiers: "v", isARepeat: false, keyCode: 9))
            XCTAssertTrue(window.performKeyEquivalent(with: shortcut))
            XCTAssertEqual(dialog.extensionID.currentEditor()?.string, valid)
            XCTAssertTrue(dialog.submit.isEnabled)

            board.clearContents()
            board.setString("invalid", forType: .string)
            dialog.pasteButton.performClick(nil)
            XCTAssertEqual(dialog.extensionID.currentEditor()?.string, "invalid")
            XCTAssertFalse(dialog.submit.isEnabled)
        }
    }
}
