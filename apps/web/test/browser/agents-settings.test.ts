import { expect, test } from "bun:test";
import { agentVersionNotice } from "../../src/client/agents-settings.ts";

test("the connected agents page reports differing versions and their interaction baselines", () => {
  const engines = [
    { name: "codex", version: "0.166.0", sandbox: "os", upgraded: "0.169.0" },
    { name: "claude-code", version: "2.1.322", sandbox: "none", upgraded: "2.1.326" },
    { name: "pi", version: "1.5.0", sandbox: "none", upgraded: "1.6.0" },
  ] as const;
  for (const engine of engines) {
    expect(agentVersionNotice(engine, "macsp")).toBeUndefined();
    const notice = agentVersionNotice({ ...engine, version: engine.upgraded }, "macsp");
    expect(notice).toContain(engine.name);
    expect(notice).toContain("macsp");
    expect(notice).toContain(engine.version);
    expect(notice).toContain(engine.upgraded);
  }
});
