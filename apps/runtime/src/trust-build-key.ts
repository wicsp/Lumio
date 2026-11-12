import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { keyFingerprint, publicKeyPEM } from "@lumio/platform";
import { privateFile } from "./service.ts";
import { text as msg } from "./messages.ts";

export async function trustBuildKey(key: string, options: { home?: string; log?: (value: string) => void; confirm?: (fingerprint: string) => Promise<boolean> } = {}): Promise<void> {
  const pem = publicKeyPEM(key), fingerprint = keyFingerprint(pem), log = options.log ?? console.log;
  log(msg("update.build_key_fingerprint", fingerprint));
  const confirm = options.confirm ?? (async () => {
    if (!process.stdin.isTTY) return false;
    const reader = createInterface({ input: process.stdin, output: process.stdout });
    try { return (await reader.question(msg("update.confirm_fingerprint"))).trim() === fingerprint; } finally { reader.close(); }
  });
  if (!await confirm(fingerprint)) throw new Error(msg("update.key_not_confirmed"));
  const path = join(options.home ?? homedir(), ".config/lumio-runtime/trusted-build-keys.json");
  let keys: string[] = [];
  try { keys = JSON.parse(await readFile(path, "utf8")) as string[]; }
  catch (cause) { if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause; }
  if (!Array.isArray(keys) || keys.some(key => typeof key !== "string")) throw new Error(msg("update.key_not_confirmed"));
  if (!keys.some(key => keyFingerprint(key) === fingerprint)) keys.push(pem);
  await privateFile(path, JSON.stringify(keys) + "\n");
  log(msg("update.build_key_trusted"));
}
