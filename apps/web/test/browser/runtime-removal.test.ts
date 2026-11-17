import { expect, mock, spyOn, test } from "bun:test";
import { RuntimeInfo } from "@lumio/schema";
import * as dom from "../../src/client/dom.ts";
import { t } from "../../src/client/i18n.ts";
import { SettingsPane } from "../../src/client/panes/settings-page.ts";

class ElementStub extends EventTarget {
  private children: ElementStub[] = [];
  private attrs: Record<string, string> = {};
  disabled = false;
  isConnected = true;

  setAttribute(name: string, value: string): void { this.attrs[name] = value; }
  append(child: ElementStub | string): void {
    if (child instanceof ElementStub) this.children.push(child);
  }
  replaceChildren(): void {
    for (const child of this.children) child.disconnect();
    this.children = [];
  }
  private disconnect(): void {
    this.isConnected = false;
    for (const child of this.children) child.disconnect();
  }
  button(label: string): ElementStub | undefined {
    if (this.attrs["aria-label"] === label) return this;
    for (const child of this.children) {
      const match = child.button(label);
      if (match) return match;
    }
  }
  click(): void { if (!this.disabled) this.dispatchEvent(new Event("click")); }
}

test("runtime removal confirms the named device, allows retry on failure and refreshes after success", async () => {
  const document = { createElement: () => new ElementStub() };
  const globals = { document, Node: ElementStub };
  const previous = Object.keys(globals).map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  for (const [name, value] of Object.entries(globals)) Object.defineProperty(globalThis, name, { configurable: true, value });
  const confirm = spyOn(dom, "confirmDialog").mockResolvedValueOnce(false).mockResolvedValue(true);
  const toast = spyOn(dom, "toast").mockImplementation(() => {});
  try {
    let devices = ["server", "zzz"].map((name, index) => RuntimeInfo.parse({
      actor: `act_0000000000000000000000000${index}`, last_seen: "2026-11-17T00:00:00Z", online: name === "zzz", update: null,
      registration: { protocol_version: 2, name, engines: [], tags: [], max_concurrent: 1, version: null, platform: null, install: null },
    }));
    const removeRuntime = mock(async (name: string) => { devices = devices.filter(device => device.registration.name !== name); })
      .mockRejectedValueOnce(new Error("synthetic failure"));
    const rows = new ElementStub();
    const pane = Object.assign(Object.create(SettingsPane.prototype), {
      active: true, runtimeRows: rows, runtimeLoad: 0,
      session: { client: { runtimes: async () => devices, removeRuntime } },
    }) as { loadRuntimes(rows: ElementStub): Promise<void> };
    await pane.loadRuntimes(rows);
    const label = t("Remove runtime {0}", "server");
    const button = rows.button(label)!;

    button.click();
    await Bun.sleep(0);
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ title: t("Remove {0}?", "server"), danger: true }));
    expect(removeRuntime).not.toHaveBeenCalled();

    button.click();
    await Bun.sleep(0);
    expect(removeRuntime).toHaveBeenLastCalledWith("server");
    expect(toast).toHaveBeenLastCalledWith(expect.stringContaining("server"), "error");
    expect(rows.button(label)).toBe(button);
    expect(button.disabled).toBe(false);

    button.click();
    await Bun.sleep(0);
    expect(removeRuntime).toHaveBeenCalledTimes(2);
    expect(rows.button(label)).toBeUndefined();
    expect(rows.button(t("Remove runtime {0}", "zzz"))).toBeDefined();
    expect(toast).toHaveBeenLastCalledWith(t("Removed {0}.", "server"));
  } finally {
    toast.mockRestore();
    confirm.mockRestore();
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
});
