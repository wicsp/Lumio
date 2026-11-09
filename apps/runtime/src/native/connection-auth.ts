import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, mkdir, open, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { NativeConnectionView, type NativeAccountBinding, type NativeRuntimeCommand } from "@lumio/schema";
import { codexExecutable, isolatedEnvironment, NativeError, sandboxCommand } from "./isolation.ts";
import { NativeRpc } from "./rpc.ts";

type Command = Extract<NativeRuntimeCommand, { type: "connection_auth" }>;
type Metadata = { owner: string; generation: number; account?: string };
type Material = { accessToken: string; chatgptAccountId: string; expires: number; account: string };
type Account = { rpc?: NativeRpc; pending?: { id: string; view: NativeConnectionView }; chain: Promise<unknown> };

/** This process owns the managed login. Conversation processes only receive the access token over stdio. */
export class ConnectionAuth {
  private accounts = new Map<string, Account>();
  constructor(private stateDir: string, private options: { codex?: string; unsafeTestCommand?: string[] }) {}

  private root(connection: string) { return join(this.stateDir, "native-accounts", connection); }
  private async serialize<T>(connection: string, work: (account: Account) => Promise<T>): Promise<T> {
    const account = this.accounts.get(connection) ?? { chain: Promise.resolve() };
    this.accounts.set(connection, account);
    const next = account.chain.then(() => work(account));
    account.chain = next.catch(() => {});
    return next;
  }
  private async metadata(connection: string, owner: string): Promise<Metadata> {
    const record = await readFile(join(this.root(connection), "binding.json"), "utf8").catch((e: NodeJS.ErrnoException) => {
      if (e.code === "ENOENT") return undefined;
      throw e;
    });
    if (!record) return { owner, generation: 1 };
    const metadata = JSON.parse(record) as Metadata;
    if (metadata.owner !== owner || !Number.isSafeInteger(metadata.generation) || metadata.generation < 1)
      throw new NativeError("native.wrong_owner");
    return metadata;
  }
  private async save(connection: string, metadata: Metadata) {
    const file = join(this.root(connection), "binding.json");
    await writeFile(`${file}.next`, JSON.stringify(metadata), { mode: 0o600 });
    await rename(`${file}.next`, file);
  }
  private async client(connection: string, account: Account) {
    if (account.rpc) return account.rpc;
    const root = this.root(connection), home = join(root, "codex");
    for (const path of [root, home, join(root, "tmp")]) {
      await mkdir(path, { recursive: true, mode: 0o700 });
      await chmod(path, 0o700);
    }
    const exe = await codexExecutable(this.options.codex);
    const env = isolatedEnvironment(root, home, exe);
    const command = this.options.unsafeTestCommand ?? sandboxCommand(root, exe);
    if (!this.options.unsafeTestCommand) {
      const probe = Bun.spawn([...command, "--version"], { cwd: root, env, stdout: "pipe", stderr: "ignore" });
      if ((await new Response(probe.stdout).text()).trim() !== "codex-cli 0.166.0" || (await probe.exited) !== 0)
        throw new NativeError("native.version_unsupported");
    }
    await writeFile(join(home, "config.toml"), 'cli_auth_credentials_store = "file"\n[features]\napps = false\nplugins = false\nhooks = false\n', { mode: 0o600 });
    const rpc = new NativeRpc([...command, "app-server", "--listen", "stdio://"], root, env);
    account.rpc = rpc;
    rpc.onExit = () => {
      if (account.rpc !== rpc) return;
      account.rpc = undefined;
      account.pending = undefined;
    };
    rpc.onEvent = (method, params) => {
      if (account.rpc !== rpc || method !== "account/login/completed" || account.pending?.id !== params.loginId) return;
      account.pending = undefined;
    };
    try { await rpc.initialize(); } catch (e) { await rpc.stop(); throw e; }
    return rpc;
  }
  private async cache(connection: string): Promise<Material | undefined> {
    const file = await open(join(this.root(connection), "codex", "auth.json"), constants.O_RDONLY | constants.O_NOFOLLOW).catch((e: NodeJS.ErrnoException) => {
      if (e.code === "ENOENT") return undefined;
      throw e;
    });
    if (!file) return undefined;
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > 65536 || stat.uid !== process.getuid?.()) throw new NativeError("native.account_unverified");
      if (stat.mode & 0o077) await file.chmod(0o600);
      const { tokens, auth_mode } = JSON.parse(await file.readFile("utf8"));
      if (auth_mode !== "chatgpt" || typeof tokens?.access_token !== "string" || typeof tokens.account_id !== "string")
        throw new NativeError("native.account_unverified");
      const claims = JSON.parse(Buffer.from(tokens.access_token.split(".")[1], "base64url").toString("utf8"));
      const auth = claims["https://api.openai.com/auth"];
      const user = auth?.chatgpt_user_id ?? auth?.user_id ?? claims.sub;
      if (typeof user !== "string" || !user || !tokens.account_id || !Number.isFinite(claims.exp) ||
          (auth?.chatgpt_account_id && auth.chatgpt_account_id !== tokens.account_id)) throw new NativeError("native.account_unverified");
      return { accessToken: tokens.access_token, chatgptAccountId: tokens.account_id, expires: claims.exp * 1000,
        account: createHash("sha256").update(JSON.stringify([tokens.account_id, user])).digest("hex") };
    } finally { await file.close(); }
  }
  private async verify(connection: string, owner: string, account: Account, rejected?: string) {
    const metadata = await this.metadata(connection, owner);
    let material = await this.cache(connection);
    if (!material) return undefined;
    const rpc = await this.client(connection, account);
    const refresh = material.expires <= Date.now() + 60000 || createHash("sha256").update(material.accessToken).digest("hex") === rejected;
    const info = await rpc.request("account/read", { refreshToken: refresh }, 15000);
    if (info.account?.type !== "chatgpt") throw new NativeError("native.login_required");
    material = await this.cache(connection);
    if (!material || material.expires <= Date.now() || createHash("sha256").update(material.accessToken).digest("hex") === rejected ||
        (info.account.accountId && info.account.accountId !== material.chatgptAccountId)) throw new NativeError("native.login_required");
    if (metadata.account !== material.account) {
      if (metadata.account) metadata.generation++;
      metadata.account = material.account;
      await this.save(connection, metadata);
    }
    return { material, rpc, binding: { account: material.account, generation: metadata.generation } };
  }
  async request(c: Command): Promise<NativeConnectionView> {
    return this.serialize(c.connection, async account => {
      try {
        const metadata = await this.metadata(c.connection, c.owner);
        if (c.action === "cancel" || c.action === "logout" || (account.pending && Date.parse(account.pending.view.expires!) <= Date.now())) {
          const pending = account.pending;
          account.pending = undefined;
          if (pending && account.rpc) await account.rpc.request("account/login/cancel", { loginId: pending.id });
        }
        if (c.action === "logout") {
          const rpc = await this.client(c.connection, account);
          await rpc.request("account/logout");
          await this.save(c.connection, { ...metadata, generation: metadata.generation + 1 });
          await rpc.stop();
          return { state: "signed_out", models: [] };
        }
        if (account.pending) return account.pending.view;
        if (c.action === "login") {
          const rpc = await this.client(c.connection, account);
          // Bind the directory before the official process can save a credential.
          await this.save(c.connection, metadata);
          const login = await rpc.request("account/login/start", { type: "chatgptDeviceCode" }, 15000);
          const view = NativeConnectionView.parse({ state: "authorizing", login_url: login.verificationUrl,
            login_code: login.userCode, expires: new Date(Date.now() + 10 * 60000).toISOString() });
          if (typeof login.loginId !== "string" || !view.login_url || !view.login_code) throw new NativeError("native.login_failed");
          account.pending = { id: login.loginId, view };
          return view;
        }
        const verified = await this.verify(c.connection, c.owner, account);
        if (!verified) return { state: "signed_out", models: [] };
        const catalog = await verified.rpc.request("model/list", { limit: 100 });
        const models = catalog.data.map((m: { model?: string; id: string; defaultReasoningEffort?: string; supportedReasoningEfforts?: { reasoningEffort: string }[] }) => ({
          id: m.model ?? m.id, default_effort: m.defaultReasoningEffort, efforts: (m.supportedReasoningEfforts ?? []).map(v => v.reasoningEffort),
        }));
        return NativeConnectionView.parse({ state: "ready", binding: verified.binding, models });
      } catch (error) {
        return { state: "error", models: [], error: error instanceof NativeError ? error.reason : "native.login_failed" };
      }
    });
  }
  async access(connection: string, owner: string, binding: NativeAccountBinding, rejected?: string) {
    return this.serialize(connection, async account => {
      if (account.pending) throw new NativeError("native.login_required");
      const verified = await this.verify(connection, owner, account, rejected);
      if (!verified) throw new NativeError("native.login_required");
      if (verified.binding.account !== binding.account || verified.binding.generation < binding.generation)
        throw new NativeError("native.account_changed");
      return { accessToken: verified.material.accessToken, chatgptAccountId: verified.material.chatgptAccountId, chatgptPlanType: null };
    });
  }
  async stop() {
    await Promise.allSettled([...this.accounts.values()].map(async account => {
      await account.chain;
      await account.rpc?.stop();
    }));
  }
}
