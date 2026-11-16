# Lumio for macOS

Lumio Capture is a menu-bar helper for macOS 14 or later. It uses a dedicated
trigger and captures the frontmost window at the time you press it. The
screenshot and selected or locally recognized text go to your paired Hub.

## Build and test

From the repository root, run `swift build --package-path apps/desktop` and
`swift test --package-path apps/desktop`. SwiftPM has no third-party dependencies.
On a machine with the standalone Command Line Tools, pass
`--build-system native` if SwiftPM reports an error initializing Swift Build.
Tests use synthetic samples. To regenerate the checked-in JSON samples from Swift,
set `LUMIO_UPDATE_DESKTOP_FIXTURES=1` when running `swift test` and run
`bun run check` to validate them against the Hub contracts.

## Pair and capture

1. In Lumio, use the client pairing code flow in Settings, or use
   `lumio login-code --name desktop`.
2. Open the Lumio menu-bar item and choose **配对…**. Enter the Hub origin and
   pairing code. Loopback HTTP is supported for the local instance. Remote origins
   use HTTPS. The token is stored in Keychain and **断开** removes it.
3. Open **权限检查** and grant Screen Recording, Accessibility and Input Monitoring.
   Allow browser Automation when macOS prompts to read a tab URL. Restart the
   helper if System Settings requests it.
4. Point to a paragraph and tap **F18**. **触发键…** can learn another ordinary key
   or mouse button 3, 4 or 5. **关闭声音** mutes feedback.

The built-in excluded bundle IDs are `com.1password.1password`,
`com.agilebits.onepassword7`, `com.apple.keychainaccess`, `com.apple.Passwords`,
`com.apple.systempreferences`, `com.bitwarden.desktop`,
`com.dashlane.dashlanephonefinal`, `com.lastpass.LastPass` and
`org.keepassxc.keepassxc`. Add bundle IDs in **排除的 App…**. Browser private windows
are excluded when their browser reports private mode. An unreachable Hub
produces a failure in the overlay. Pending captures are held in memory.
