export interface SudoPaths { binary: string; config: string; state: string; sudoers: string }

export function sudoPaths(platform: string): SudoPaths {
  // Use canonical paths on macOS: /etc and /var are symlinks there.
  if (platform === "darwin") return {
    binary: "/Library/Lumio/lumio-sudo-helper",
    config: "/Library/Lumio/sudo.json",
    state: "/Library/Lumio/sudo-state",
    sudoers: "/private/etc/sudoers.d/lumio",
  };
  return {
    binary: "/usr/local/libexec/lumio-sudo-helper", config: "/etc/lumio/sudo.json",
    state: "/var/lib/lumio-sudo", sudoers: "/etc/sudoers.d/lumio",
  };
}
