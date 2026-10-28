import { afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** CLI tests must never inherit an installed user's configuration or credentials. */
export function isolatedHome(): string {
  const home = mkdtempSync(join(tmpdir(), "lumio-cli-home-"));
  afterAll(() => rmSync(home, { recursive: true, force: true }));
  return home;
}
