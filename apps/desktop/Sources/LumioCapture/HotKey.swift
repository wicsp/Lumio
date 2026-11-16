import AppKit
import LumioCaptureCore

@MainActor final class HotKey {
    private var tap: CFMachPort?
    private var source: CFRunLoopSource?
    private var pressed = false
    var trigger = Trigger.defaultKey
    var onPress: ((CGPoint) -> Void)?
    var onRelease: (() -> Void)?
    var onCancel: (() -> Void)?
    var learning: ((Trigger) -> Void)?

    func start() -> Bool {
        if tap != nil { return true }
        let types: [CGEventType] = [.keyDown, .keyUp, .otherMouseDown, .otherMouseUp]
        let mask = types.reduce(CGEventMask(0)) { $0 | (1 << $1.rawValue) }
        let callback: CGEventTapCallBack = { _, type, event, data in
            guard let data else { return Unmanaged.passUnretained(event) }
            let selfObject = Unmanaged<HotKey>.fromOpaque(data).takeUnretainedValue()
            return MainActor.assumeIsolated {
                selfObject.handle(type, event) ? nil : Unmanaged.passUnretained(event)
            }
        }
        guard let tap = CGEvent.tapCreate(tap: .cgSessionEventTap, place: .headInsertEventTap, options: .defaultTap,
                                          eventsOfInterest: mask, callback: callback, userInfo: Unmanaged.passUnretained(self).toOpaque()) else { return false }
        let source = CFMachPortCreateRunLoopSource(nil, tap, 0)
        CFRunLoopAddSource(CFRunLoopGetMain(), source, .commonModes)
        CGEvent.tapEnable(tap: tap, enable: true)
        self.tap = tap
        self.source = source
        return true
    }

    private func handle(_ type: CGEventType, _ event: CGEvent) -> Bool {
        if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
            if pressed { pressed = false; onCancel?() }
            if let tap { CGEvent.tapEnable(tap: tap, enable: true) }
            return false
        }
        let key = type == .keyDown || type == .keyUp
        let down = type == .keyDown || type == .otherMouseDown
        let code = Int(event.getIntegerValueField(key ? .keyboardEventKeycode : .mouseEventButtonNumber))
        let input = key ? Trigger.key(code) : .mouse(code)
        if let learning, down {
            if key && code == 53 { self.learning = nil; return true }
            guard key || (2...4).contains(code) else { return false }
            self.learning = nil
            learning(input)
            return true
        }
        if key && code == 53 && pressed && down {
            pressed = false
            onCancel?()
            return true
        }
        guard input == trigger else { return false }
        if down {
            if !pressed && (!key || event.getIntegerValueField(.keyboardEventAutorepeat) == 0) {
                pressed = true
                onPress?(event.location)
            }
        } else if pressed {
            pressed = false
            onRelease?()
        }
        return true
    }
}
