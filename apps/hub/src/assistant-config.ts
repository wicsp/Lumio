import { join } from "node:path";
import { homedir } from "node:os";
import { AssistantConfigUpdate, AssistantConfigView, assistantConfigReason, type AssistantConfigProblem } from "@lumio/schema";
import { modelConfiguration, type ModelConfiguration } from "./assistant-model.ts";
import { atomicFile, environmentText, optional, parseEnvironment } from "./setup.ts";
import { WriteCoordinator } from "./coordinator.ts";
import { HubError } from "./errors.ts";

const KEYS = ["LUMIO_ASSISTANT_BASE_URL", "LUMIO_ASSISTANT_MODEL", "LUMIO_ASSISTANT_API_KEY"] as const;
const failure = (problem: AssistantConfigProblem) => new HubError("INVALID", { key: `assistant.config.${problem}`, args: [] }, { reason: assistantConfigReason(problem) });

/** One serialized implementation for HTTP and the local setup command. Credentials never leave this adapter. */
export class AssistantConfiguration {
  private readonly writes = new WriteCoordinator();
  private current?: ModelConfiguration;
  readonly path: string;
  constructor(private readonly options: { home?: string; external?: ModelConfiguration; fetch?: typeof fetch; timeoutMs?: number;
    reload?: (model: ModelConfiguration | undefined) => void } = {}) {
    this.path = join(options.home ?? process.env.HOME ?? homedir(), ".config/lumio/hub.env");
    this.current = options.external;
  }
  async load(): Promise<ModelConfiguration | undefined> {
    if (!this.options.external) this.current = modelConfiguration(parseEnvironment(await optional(this.path) ?? ""));
    return this.current;
  }
  /** Also observes local setup writes made before the CLI has Hub credentials. */
  refresh(): Promise<void> {
    return this.writes.exclusive(async () => {
      if (this.options.external) return;
      const previous = this.current;
      await this.load();
      if (previous?.baseUrl !== this.current?.baseUrl || previous?.model !== this.current?.model || previous?.credential() !== this.current?.credential()) {
        this.options.reload?.(this.current);
      }
    });
  }
  view(): AssistantConfigView {
    const key = this.current?.credential();
    const safe = (value: string | undefined) => key && value?.includes(key) ? undefined : value;
    return AssistantConfigView.parse({ base_url: safe(this.current?.baseUrl), model: safe(this.current?.model), api_key_set: !!key, managed: !this.options.external });
  }
  update(raw: unknown): Promise<AssistantConfigView> {
    return this.writes.exclusive(async () => {
      this.writable();
      const parsed = AssistantConfigUpdate.safeParse(raw);
      if (!parsed.success) throw failure("address");
      const input = parsed.data;
      if (!input.model.trim()) throw failure("model");
      const env = parseEnvironment(await optional(this.path) ?? "");
      const key = input.clear_api_key ? undefined : input.api_key ?? env.LUMIO_ASSISTANT_API_KEY;
      // Refuse values that environment files cannot represent, and credentials hidden in public fields.
      if ([input.base_url, input.model, key ?? ""].some(value => /[\r\n\0]/.test(value)) || (key && (input.base_url.includes(key) || input.model.includes(key)))) throw failure("address");
      const candidate = modelConfiguration({ LUMIO_ASSISTANT_BASE_URL: input.base_url, LUMIO_ASSISTANT_MODEL: input.model, LUMIO_ASSISTANT_API_KEY: key });
      if (!candidate) throw failure("model");
      if (input.check !== false) await this.check(candidate);
      env.LUMIO_ASSISTANT_BASE_URL = candidate.baseUrl;
      env.LUMIO_ASSISTANT_MODEL = candidate.model;
      if (key) env.LUMIO_ASSISTANT_API_KEY = key; else delete env.LUMIO_ASSISTANT_API_KEY;
      await atomicFile(this.path, environmentText(env), 0o600, true);
      this.current = candidate; this.options.reload?.(candidate);
      return this.view();
    });
  }
  clear(): Promise<AssistantConfigView> {
    return this.writes.exclusive(async () => {
      this.writable();
      const env = parseEnvironment(await optional(this.path) ?? "");
      for (const key of KEYS) delete env[key];
      await atomicFile(this.path, environmentText(env), 0o600, true);
      this.current = undefined; this.options.reload?.(undefined); return this.view();
    });
  }
  private writable(): void {
    if (this.options.external) throw new HubError("FORBIDDEN", { key: "assistant.config.external", args: [] }, { reason: "assistant-config-managed-externally" });
  }
  private async check(config: ModelConfiguration): Promise<void> {
    const signal = AbortSignal.timeout(this.options.timeoutMs ?? 30_000);
    let response: Response | undefined;
    try {
      response = await (this.options.fetch ?? fetch)(`${config.baseUrl}/chat/completions`, { method: "POST", redirect: "error", signal,
        headers: { "Content-Type": "application/json", ...(config.credential() ? { Authorization: `Bearer ${config.credential()}` } : {}) },
        body: JSON.stringify({ model: config.model, stream: false, messages: [{ role: "user", content: "ping" }] }),
      });
      if (!response.ok) throw failure(response.status === 401 || response.status === 403 ? "auth" : response.status === 400 || response.status === 404 || response.status === 422 ? "model" : "address");
      const reader = response.body?.getReader(); if (!reader) throw failure("response");
      let text = "";
      try { for (;;) { const part = await reader.read(); if (part.done) break; text += new TextDecoder().decode(part.value); if (text.length > 65536) throw failure("response"); } }
      finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      let body;
      try { body = JSON.parse(text); } catch { throw failure("response"); }
      if (!Array.isArray(body?.choices) || body.choices[0]?.message?.role !== "assistant" || typeof body.choices[0]?.message?.content !== "string") throw failure("response");
    } catch (cause) {
      if (cause instanceof HubError) throw cause;
      throw failure(signal.aborted ? "timeout" : response ? "response" : "address");
    } finally { if (response?.body && !response.body.locked) await response.body.cancel().catch(() => {}); }
  }
}
