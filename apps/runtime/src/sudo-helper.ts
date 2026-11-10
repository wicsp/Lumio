import { errorMessage, text as msg } from "./messages.ts";
import { createPublicKey, verify } from "node:crypto";
import { constants } from "node:fs";
import { open, lstat, mkdir, rmdir } from "node:fs/promises";
import { dirname, isAbsolute, join, parse, resolve } from "node:path";
import { spawn } from "node:child_process";
import { PrivilegedApproval, privilegedSigningPayload } from "@lumio/schema";
import { RuntimeError } from "./config.ts";
import { sudoPaths } from "./sudo-paths.ts";

const ENV = { PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C.UTF-8" };
/** 测试可注入路径、时钟与 uid；生产入口只使用写死的路径及真实 uid。 */
export async function executeApproval(raw: unknown, options: {
  config: string; used: string; now?: () => number; uid?: number; owner?: number;
  timeoutMs?: number; stdout?: (chunk: Buffer) => void; stderr?: (chunk: Buffer) => void;
}): Promise<number> {
  if ((options.uid ?? process.getuid?.()) !== 0) throw new RuntimeError(msg("sudo-helper.helper_must_run_as_root"));
  const owner = options.owner ?? 0;
  const safe = async (path: string, directory = false) => {
    const st = await lstat(path);
    if (st.uid !== owner || (st.mode & 0o022) || st.isSymbolicLink() || (directory ? !st.isDirectory() : !st.isFile())) throw new RuntimeError(msg("sudo-helper.unsafe_helper_configuration_or_used_credential_list_permissions"));
  };
  // 校验到安装目录为止的父目录，避免攻击者替换 root 所有的叶文件。
  const parents = async (path: string) => {
    for (let dir = dirname(resolve(path)); dir !== parse(dir).root; dir = dirname(dir)) {
      // 测试把根放在系统临时目录下，测试注入 owner 时只检查直接父目录。
      await safe(dir, true); if (options.owner !== undefined) break;
    }
  };
  await parents(options.config); await safe(options.config);
  const file = await open(options.config, constants.O_RDONLY | constants.O_NOFOLLOW);
  let config: { public_key: string; runtime: string };
  try {
    const st = await file.stat();
    if (st.uid !== owner || (st.mode & 0o022) || !st.isFile()) throw new RuntimeError(msg("sudo-helper.unsafe_configuration_permissions"));
    config = JSON.parse(await file.readFile("utf8"));
  } finally { await file.close(); }
  if (!config || typeof config.public_key !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(config.public_key) || typeof config.runtime !== "string") throw new RuntimeError(msg("sudo-helper.invalid_helper_configuration"));
  const parsed = PrivilegedApproval.safeParse(raw);
  if (!parsed.success) throw new RuntimeError(msg("sudo-helper.invalid_approval_credential"));
  const approval = parsed.data;
  const key = createPublicKey({ format: "jwk", key: { kty: "OKP", crv: "Ed25519", x: config.public_key } });
  if (!verify(null, Buffer.from(privilegedSigningPayload(approval)), key, Buffer.from(approval.signature, "base64url"))) throw new RuntimeError(msg("sudo-helper.invalid_approval_signature"));
  if (approval.runtime !== config.runtime) throw new RuntimeError(msg("sudo-helper.runtime_does_not_match"));
  const now = (options.now ?? Date.now)();
  if (Date.parse(approval.expires) <= now || Date.parse(approval.approved_at) > now || Date.parse(approval.expires) > Date.parse(approval.approved_at) + 600_000) throw new RuntimeError(msg("sudo-helper.approval_expired_or_timestamp_is_invalid"));
  if (!isAbsolute(approval.argv[0]!) || approval.argv.some((a) => a.includes("\0"))) throw new RuntimeError(msg("privileged.program_must_be_an_absolute_path_and_arguments_must_not_contain_nul"));
  await parents(options.used);
  // mkdir 是跨进程的排他锁；锁残留时拒绝执行，由管理员检查后移除。
  const lock = `${options.used}.lock`;
  try { await mkdir(lock, { mode: 0o700 }); } catch { throw new RuntimeError(msg("sudo-helper.used_credential_list_is_locked")); }
  try {
    const used = await open(options.used, constants.O_RDWR | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
    try {
      const st = await used.stat();
      if (st.uid !== owner || (st.mode & 0o022) || !st.isFile() || st.nlink !== 1) throw new RuntimeError(msg("sudo-helper.unsafe_used_credential_list_permissions"));
      if ((await used.readFile("utf8")).split("\n").includes(approval.proposal)) throw new RuntimeError(msg("sudo-helper.approval_already_used"));
      await used.write(`${approval.proposal}\n`); await used.sync();
      const directory = await open(dirname(options.used), constants.O_RDONLY); try { await directory.sync(); } finally { await directory.close(); }
    } finally { await used.close(); }
  } finally { await rmdir(lock); }
  // 已用记录落盘以后才启动程序；即使启动失败也不能重试这张凭据。
  return new Promise<number>((resolve) => {
    const child = spawn(approval.argv[0]!, approval.argv.slice(1), { shell: false, detached: true, cwd: "/", env: ENV, stdio: ["ignore", "pipe", "pipe"] });
    const kill = () => { if (child.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch {} } };
    const timer = setTimeout(kill, options.timeoutMs ?? 1_800_000);
    process.once("SIGTERM", kill); process.once("SIGINT", kill);
    const finish = (code: number) => { clearTimeout(timer); process.removeListener("SIGTERM", kill); process.removeListener("SIGINT", kill); resolve(code); };
    child.stdout.on("data", options.stdout ?? ((chunk) => process.stdout.write(chunk)));
    child.stderr.on("data", options.stderr ?? ((chunk) => process.stderr.write(chunk)));
    child.once("error", () => finish(127)); child.once("close", (code) => { kill(); finish(code ?? 137); });
  });
}

export async function runSudoHelper() {
  try {
    const input = await new Response(Bun.stdin.stream()).text();
    const paths = sudoPaths(process.platform);
    return await executeApproval(JSON.parse(input), { config: paths.config, used: join(paths.state, "used") });
  } catch (cause) {
    console.error(cause instanceof RuntimeError ? errorMessage(cause) : msg("sudo-helper.helper_refused_execution"));
    return 126;
  }
}
