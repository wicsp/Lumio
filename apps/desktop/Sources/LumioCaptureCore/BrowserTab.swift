package func chromiumTabScript(_ bundleID: String?) -> String? {
    guard let bundleID else { return nil }
    switch bundleID {
    case "com.google.Chrome", "com.microsoft.edgemac", "company.thebrowser.Browser", "com.citrolabs.ego.lite":
        return """
            tell application id "\(bundleID)"
                try
                    if mode of front window is "incognito" then return "__private__"
                end try
                return URL of active tab of front window
            end tell
            """
    default: return nil
    }
}
