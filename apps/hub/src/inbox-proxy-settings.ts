import { join } from "node:path";
import { CaptureProxyRecord, type CaptureProxySettings, type CaptureProxyUpdate } from "@lumio/schema";
import { WriteCoordinator } from "./coordinator.ts";
import { HubError } from "./errors.ts";
import { captureNetwork } from "./inbox-fetch.ts";
import { atomicFile, optional } from "./setup.ts";

export class InboxProxySettings {
  private readonly writes = new WriteCoordinator();

  private constructor(private readonly path: string, private record: CaptureProxyRecord) {}

  static async open(stateDir: string): Promise<InboxProxySettings> {
    const path = join(stateDir, "capture-proxy.json");
    try {
      const data = await optional(path);
      const record = data === undefined ? { revision: 1, mode: "environment" } as const
        : CaptureProxyRecord.parse(JSON.parse(data));
      return new InboxProxySettings(path, record);
    } catch {
      throw new HubError("INVALID", { key: "inbox.proxy.read_failed", args: [] });
    }
  }

  view(): CaptureProxySettings {
    const { revision, mode } = this.record;
    return this.record.mode === "custom"
      ? { revision, mode: "custom", proxy_origin: new URL(this.record.proxy_url).origin, no_proxy: this.record.no_proxy }
      : { revision, mode: "environment" };
  }

  network() {
    const { HTTPS_PROXY, HTTP_PROXY, NO_PROXY } = process.env;
    return captureNetwork(this.record.mode === "custom"
      ? { HTTPS_PROXY: this.record.proxy_url, HTTP_PROXY: this.record.proxy_url, NO_PROXY: this.record.no_proxy }
      : { HTTPS_PROXY, HTTP_PROXY, NO_PROXY });
  }

  update(input: CaptureProxyUpdate): Promise<CaptureProxySettings> {
    return this.writes.exclusive(async () => {
      if (input.expected_revision !== this.record.revision) {
        throw new HubError("CONFLICT", { key: "inbox.proxy.conflict", args: [] });
      }
      const revision = this.record.revision + 1;
      const next = CaptureProxyRecord.safeParse(input.mode === "custom"
        ? { revision, mode: input.mode, proxy_url: input.proxy_url ?? (this.record.mode === "custom" ? this.record.proxy_url : undefined), no_proxy: input.no_proxy }
        : { revision, mode: input.mode });
      if (!next.success) throw new HubError("INVALID", { key: "inbox.proxy.invalid", args: [] });
      try {
        await atomicFile(this.path, JSON.stringify(next.data) + "\n", 0o600);
      } catch {
        throw new HubError("INTERNAL", { key: "inbox.proxy.write_failed", args: [] });
      }
      this.record = next.data;
      return this.view();
    });
  }

  drain(): Promise<void> { return this.writes.drain(); }
}
