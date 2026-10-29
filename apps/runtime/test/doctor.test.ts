import { expect, test } from "bun:test";
import { doctor } from "../src/doctor.ts";
import { printChecks } from "../src/diagnostics.ts";
import { createHash, generateKeyPairSync } from "node:crypto";
import { signingKeyFingerprint } from "@lumio/schema";
const publicKey = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "der" }).subarray(-32);
const signingKey = { public_key: publicKey.toString("base64url"), fingerprint: signingKeyFingerprint(createHash("sha256").update(publicKey).digest("hex")) };
function fixture() {
  const files: Record<string, string> = { "/synthetic/.config/lumio-runtime/runtime.env": 'LUMIO_HUB_URL="http://synthetic"\nLUMIO_TOKEN="synthetic-secret"\nLUMIO_RUNTIME_NAME="server"\nPATH="/saved/bin"\nLUMIO_RUNTIME_SUDO_COMMAND="/usr/bin/sudo -n /helper"' };
  const fail = new Set<string>(), versions: Record<string, string> = { codex: "codex-cli 0.163.0", claude: "2.0.0 (Claude Code)", pi: "1.4.0" };
  const commands: string[][] = [];
  const options = { home: "/synthetic", env: { USER: "synthetic", PATH: "/wrong/shell/path" }, uid: 501, platform: "linux",
    read: async (p: string) => { if (fail.has("read") || !files[p]) throw new Error("synthetic-secret"); return files[p]!; },
    stat: async (p: string) => {
      if (fail.has("stat")) throw new Error("synthetic-secret");
      const dir = p.endsWith("lumio-runtime"), helper = p === "/helper";
      return { mode: fail.has("permissions") ? 0o777 : dir ? 0o700 : 0o600, uid: helper ? (fail.has("root") ? 501 : 0) : 501, isFile: () => !dir, isDirectory: () => dir };
    },
    run: async (argv: string[]) => {
      commands.push(argv); const command = argv[0]!;
      return { code: fail.has(command) ? 1 : 0, stderr: "", stdout: command === "loginctl" ? "Linger=yes\n" : command === "sudo" ? "(root) NOPASSWD: /helper\n" : versions[command.replace("/saved/bin/", "")] ?? "" };
    },
    fetch: (async () => { if (fail.has("fetch")) throw new Error("synthetic-secret"); return Response.json(signingKey); }) as unknown as typeof fetch,
    which: (command: string, path: string) => { expect(path).toBe("/saved/bin"); return fail.has("which") ? null : `/saved/bin/${command}`; },
    outbox: async () => { if (fail.has("outbox")) throw new Error(); return 3; },
  };
  return { options, fail, files, versions, commands };
}
test("runtime doctor checks saved PATH, read-only queue, service, linger, authentication and helper", async () => {
  const f = fixture(); let checks = await doctor(f.options);
  expect(checks.every((c) => c.ok)).toBe(true); expect(checks.find((c) => c.name === "结果队列")!.problem).toContain("3");
  expect(f.commands).toContainEqual(["sudo", "-n", "-l"]);
  expect(JSON.stringify(checks)).not.toContain("synthetic-secret");
  f.options.platform = "darwin"; checks = await doctor(f.options);
  expect(checks.some((c) => c.name === "linger")).toBe(false); expect(f.commands).toContainEqual(["launchctl", "print", "gui/501/io.lumio.runtime"]);
  f.files["/synthetic/.config/lumio-runtime/runtime.env"] = f.files["/synthetic/.config/lumio-runtime/runtime.env"]!.replace(/\nLUMIO_RUNTIME_SUDO_COMMAND=.*/, "");
  checks = await doctor(f.options); expect(checks.some((c) => c.name.startsWith("提权"))).toBe(false);
});
test("runtime doctor reports each injected filesystem, HTTP, command, agent and helper failure independently", async () => {
  for (const problem of ["read", "stat", "permissions", "root", "fetch", "which", "outbox", "sudo", "systemctl", "loginctl", "/saved/bin/pi"]) {
    const f = fixture(); f.fail.add(problem); const checks = await doctor(f.options);
    expect(checks.some((c) => !c.ok)).toBe(true); expect(checks.filter((c) => !c.ok).every((c) => c.fix)).toBe(true);
    expect(JSON.stringify(checks)).not.toContain("synthetic-secret");
  }
  const f = fixture(); f.versions.pi = "9.0.0";
  let checks = await doctor(f.options); expect(checks.find((c) => c.name === "pi 9.0.0")!.ok).toBe(false);
  f.files["/synthetic/.config/lumio-runtime/runtime.env"] = "bad line";
  checks = await doctor(f.options); expect(checks.find((c) => c.name === "执行器配置")!.ok).toBe(false);
  const lines: string[] = []; expect(printChecks(checks, true, (l) => lines.push(l))).toBe(1); expect(JSON.parse(lines[0]!)).toEqual(checks);
});
