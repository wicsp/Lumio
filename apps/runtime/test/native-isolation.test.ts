import {tmpdir} from "node:os";
import { test, expect } from "bun:test";
import { mkdtemp, mkdir, writeFile, symlink, rm,realpath } from "node:fs/promises";
import { join } from "node:path";
import { seatbelt, isolatedEnvironment } from "../src/native/isolation.ts";
import { NativeProcessScope } from "../src/native/process-scope.ts";
import { spawn } from "node:child_process";
test.skipIf(process.platform !== "darwin")("native outer boundary denies synthetic vault, credentials, sibling sessions and symlink reads", async () => {
    const root = await mkdtemp(join(await realpath(tmpdir()),"native-boundary-")), outside = await mkdtemp(join(await realpath(tmpdir()),"native-vault-")), exe = "/bin/cat";
    try {
        await mkdir(join(root, "tmp"));
        await writeFile(join(root, "allowed"), "SYNTHETIC_ALLOWED");
        await writeFile(join(outside, "private"), "SYNTHETIC_PRIVATE");
        await symlink(join(outside, "private"), join(root, "link"));
        const run = async (path: string) => { const p = Bun.spawn(["/usr/bin/sandbox-exec", "-p", seatbelt(root, exe), exe, path], { cwd: root, env: isolatedEnvironment(root, root, exe), stdout: "pipe", stderr: "ignore" }); return { code: await p.exited, text: await new Response(p.stdout).text() }; };
        expect(await run(join(root, "allowed"))).toEqual({ code: 0, text: "SYNTHETIC_ALLOWED" });
        for (const path of [join(outside, "private"), join(root, "link")]) {
            const result = await run(path);
            expect(result.code).not.toBe(0);
            expect(result.text).not.toContain("SYNTHETIC_PRIVATE");
        }
    }
    finally {
        await rm(root, { recursive: true, force: true });
        await rm(outside, { recursive: true, force: true });
    }
});
test("native supervision stops a started command after killing the parent", async () => {
    const root = await mkdtemp(join(await realpath(tmpdir()),"native-descendants-"));
    const marker = join(root, "finished");
    const child = spawn("/bin/sh", ["-c", `sleep 3; /bin/echo SYNTHETIC > '${marker}'`], { detached: true, stdio: "ignore" });
    const scope = new NativeProcessScope(child.pid!);
    await scope.collect();
    await Bun.sleep(100);
    child.kill("SIGKILL");
    await scope.stop();
    await Bun.sleep(3200);
    expect(await Bun.file(marker).exists()).toBe(false);
    await rm(root, { recursive: true, force: true });
}, 10000);
