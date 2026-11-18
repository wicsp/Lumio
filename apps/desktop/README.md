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

1. In Lumio, open Settings → Capture → Lumio Capture for Mac and create a pairing code, or use
   `lumio login-code --name desktop`.
2. Open the Lumio menu-bar item and choose **配对…** (shown as **重新配对…** once paired). Enter the Hub origin and
   pairing code. Loopback HTTP is supported for the local instance. Remote origins
   use HTTPS. The token is stored in Keychain and **断开** removes it.
3. Open **权限检查…** and grant Screen Recording, Accessibility and Input Monitoring.
   Allow browser Automation when macOS prompts to read the active tab URL in
   Safari, Chrome, Edge, Arc or ego lite. Restart the
   helper if System Settings requests it.
4. Point to a paragraph and tap **F18**. **触发键：F18…** can learn another ordinary key
   or mouse button 3, 4 or 5. Uncheck **提示音** to mute feedback.

The top of the menu shows the connection state and Hub address, the current
trigger, and any missing permission (click it to fix). The menu-bar icon dims
while the Hub is unpaired or unreachable. **打开 Lumio** (⌘O) opens the paired Hub.

For a loaded webpage, pair the current [Save to Lumio extension](../chrome-ext/README.md#f18-桌面捕获012-起)
under **配对浏览器扩展…** and allow the site in the extension settings. Capture starts reading the page as it takes the window
screenshot. The pop sound indicates the page text is ready to leave the tab. The usual save sound confirms Inbox processing.

The built-in excluded bundle IDs are `com.1password.1password`,
`com.agilebits.onepassword7`, `com.apple.keychainaccess`, `com.apple.Passwords`,
`com.apple.systempreferences`, `com.bitwarden.desktop`,
`com.dashlane.dashlanephonefinal`, `com.lastpass.LastPass` and
`org.keepassxc.keepassxc`. Add bundle IDs in **排除的 App…**. Browser private windows
are excluded when their browser reports private mode. An unreachable Hub
produces a failure in the overlay. Pending captures are held in memory.

## Hold to speak

Hold the trigger for at least 250 ms and speak when the listening indicator
appears. Allow microphone access on first use. The helper streams 16 kHz mono
PCM to your Hub and shows the current transcription. The Hub needs a
`speech.asr` binding for this account. Release to send the final transcript and
glance to your main conversation. **展开** shows the full answer and
**在 Lumio 中打开** opens the conversation, where any required approval can be
handled. Press Esc while holding the trigger to cancel. An empty utterance or
unavailable speech service leaves the gesture as a save.
## Sign and install

Build and test with Xcode available. If the standalone Command Line Tools are
selected, set `DEVELOPER_DIR` to your installed Xcode's `Contents/Developer`
directory for the build. Run `bun run desktop:check` to compile and test without
signing or installing.

For a persistent local signing identity, run
`bun run scripts/desktop.ts create-identity` and approve the code-signing trust
dialog. This creates one development certificate in your login Keychain. On
later builds the script reuses it. To use an existing valid certificate, set
`LUMIO_DESKTOP_SIGN_IDENTITY` to its exact name or SHA-1 fingerprint from
`security find-identity -v -p codesigning`. Reuse the same identity so macOS
can recognize the app's privacy grants across updates.

Run `bun run desktop:build` to assemble the app under `apps/desktop/.build/`.
On the machine running Hub port 7420, run
`bun run scripts/deploy-local.ts --desktop` to deploy committed main and install
the signed helper in `~/Applications`. The helper registers as a login item
on its first launch. Its menu can toggle startup or open System Settings if
macOS requests authorization.
