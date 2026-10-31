import { parseArgs } from "node:util";
import { upgrade as sharedUpgrade, UpgradeError, type UpgradeOptions } from "@lumio/platform";
export { UpgradeError } from "@lumio/platform";
export type { UpgradeOptions } from "@lumio/platform";

export function upgrade(options: UpgradeOptions = {}): Promise<void> {
  return sharedUpgrade({ ...options, tty: options.tty ?? process.stderr.isTTY, progress: options.progress ?? ((line) => { process.stderr.write(line + "\n"); }), log: options.log ?? console.log });
}
export async function runUpgrade(args: string[], runtimeOnly: boolean, log = console.log): Promise<number> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { version: { type: "string" } } });
  if (positionals.length) throw new UpgradeError(`用法：${runtimeOnly ? "lumio-runtime" : "lumio"} upgrade [--version vX.Y.Z]`);
  await upgrade({ version: values.version, runtimeOnly, log }); return 0;
}
