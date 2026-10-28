import { joinRuntime } from "../../src/pairing.ts";
import { readConfig } from "../../src/config.ts";
import { runtimeEnvironment } from "../../src/service.ts";
import { runRuntime } from "../../src/runtime.ts";
const controller = new AbortController();
process.once("SIGTERM", () => controller.abort());
let daemon: Promise<void> | undefined;
await joinRuntime(["--hub", process.argv[2]!, "--code", process.argv[3]!], { install: async () => {
  const env = await runtimeEnvironment();
  daemon = runRuntime(readConfig(env), { env, signal: controller.signal });
  const path = `${env.LUMIO_RUNTIME_STATE_DIR}/registered.json`, until = Date.now() + 5000;
  while (!await Bun.file(path).exists() && Date.now() < until) await Bun.sleep(25);
  if (!await Bun.file(path).exists()) throw new Error("registration timed out");
  console.log("已连上 Hub");
} });
await daemon;
