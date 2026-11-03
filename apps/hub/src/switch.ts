import { errorMessage, text as msg } from "./messages.ts";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { CliConfig, RuntimeInfo } from "@lumio/schema";
import { HubError } from "./errors.ts";
import { runMigration } from "./migrate.ts";
import { optional, parseEnvironment, runCommand } from "./setup.ts";

export interface SwitchOptions {
  home?: string; platform?: string; uid?: number; binary?: string; env?: NodeJS.ProcessEnv;
  run?: typeof runCommand; log?: (line: string) => void;
  stdout?: (chunk: string) => void; stderr?: (chunk: string) => void;
  ready?: (service: "hub" | "runtime") => Promise<void>;
  retire?: (vault: string, state: string) => Promise<void>;
}
/** Explicitly requested offline transition; never infer service paths from running processes. */
export async function switchLegacy(args: string[], options: SwitchOptions = {}): Promise<number> {
  if (args.length !== 1 || args[0] !== "--retire-legacy") throw new HubError("INVALID", { key: "switch.usage_lumio_hub_switch_retire_legacy", args: [] });
  if (!options.binary && !Bun.main.startsWith("/$bunfs/")) throw new HubError("INVALID", { key: "switch.run_switch_using_the_installed_program_running_from_source_does_not", args: [] });
  const home = options.home ?? process.env.HOME ?? homedir(), platform = options.platform ?? process.platform;
  const log = options.log ?? console.log, run = options.run ?? runCommand, env = options.env ?? process.env;
  const binary = options.binary ?? process.execPath, bin = dirname(binary);
  const servicePath = (service: string) => join(home, platform === "darwin" ? `Library/LaunchAgents/io.lumio.${service}.plist` : `.config/systemd/user/lumio-${service}.service`);
  if (!["darwin", "linux"].includes(platform) || !await optional(servicePath("hub")) || !await optional(servicePath("runtime"))) {
    throw new HubError("INVALID", { key: "switch.unmanaged_environment_stop_hub_and_the_local_runtime_manually_run_pr", args: [] });
  }
  const hubEnv = parseEnvironment(await optional(join(home, ".config/lumio/hub.env")) ?? "");
  const runtimeEnv = parseEnvironment(await optional(join(home, ".config/lumio-runtime/runtime.env")) ?? "");
  const cli = CliConfig.parse(JSON.parse(await optional(join(home, ".config/lumio/config.json")) ?? "{}"));
  const vault = env.LUMIO_VAULT ?? hubEnv.LUMIO_VAULT ?? cli.vault;
  const state = resolve(env.LUMIO_STATE_DIR ?? hubEnv.LUMIO_STATE_DIR ?? join(home, ".local/share/lumio"));
  const runtimeState = runtimeEnv.LUMIO_RUNTIME_STATE_DIR;
  if (!vault || !runtimeState) throw new HubError("INVALID", { key: "switch.setup_is_missing_the_knowledge_or_local_runtime_state_directory_serv", args: [] });
  const completed: string[] = [], domain = `gui/${options.uid ?? process.getuid?.() ?? -1}`;
  const service = (name: "hub" | "runtime", start: boolean) => platform === "darwin"
    ? ["launchctl", start ? "bootstrap" : "bootout", domain, servicePath(name)]
    : ["systemctl", "--user", start ? "start" : "stop", `lumio-${name}.service`];
  const ready = options.ready ?? (async (name: "hub" | "runtime") => {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      try {
        const response = await fetch(`${cli.hub_url.replace(/\/+$/, "")}${name === "hub" ? "/health" : "/v1/runtimes"}`, {
          redirect: "error", signal: AbortSignal.timeout(1000), headers: { Authorization: `Bearer ${cli.token}` },
        });
        if (response.ok) {
          const body = await response.json() as { ok?: boolean };
          if (name === "hub" ? body?.ok === true : RuntimeInfo.array().parse(body).some(runtime => runtime.online && runtime.registration.name === runtimeEnv.LUMIO_RUNTIME_NAME)) return;
        }
      } catch { /* a newly started service may not be listening yet */ }
      await Bun.sleep(200);
    }
    throw new HubError("INVALID", name === "hub" ? { key: "switch.hub_startup_timed_out", args: [] } : { key: "switch.local_runtime_registration_timed_out", args: [] });
  });
  const command = async (argv: string[]) => { if ((await run(argv)).code) throw new HubError("INVALID", { key: "switch.command_failed_check_service_status_and_logs", args: [] }); };
  const stop = async (name: "hub" | "runtime") => {
    const result = await run(service(name, false));
    if (!result.code) return;
    if (platform === "darwin") {
      const status = await run(["launchctl", "print", `${domain}/io.lumio.${name}`]);
      // bootout also fails for permission and I/O errors. Only a confirmed missing service is harmless.
      if (status.code && /could not find (?:service|domain)|no such process/i.test(status.stderr)) return;
    }
    throw new HubError("INVALID", { key: "switch.could_not_stop_service_check_service_status_and_logs", args: [] });
  };
  async function step(label: string, action: () => Promise<void>) {
    log(msg("switch.switch", label)); await action(); completed.push(label);
  }
  try {
    await step(msg("switch.stop_hub"), () => stop("hub"));
    await step(msg("switch.stop_local_runtime"), () => stop("runtime"));
    await step(msg("switch.prepare_local_runtime"), () => command([join(bin, "lumio-runtime"), "prepare-migration", "--state-dir", runtimeState]));
    await step(msg("switch.create_and_verify_a_full_backup_then_retire_legacy_notes"), () => options.retire ? options.retire(vault, state) : runMigration(["retire", "--vault", vault], log, { stateDir: state }));
    await step(msg("switch.start_hub"), async () => { await command(service("hub", true)); await ready("hub"); });
    await step(msg("switch.start_local_runtime"), async () => { await command(service("runtime", true)); await ready("runtime"); });
  } catch (cause) {
    const detail = cause instanceof HubError ? errorMessage(cause) : msg("switch.step_failed");
    throw new HubError("INVALID", { key: "switch.switch_stopped_completed_no_further_steps_were_run_recovery_fix_the", args: [detail, completed.join(" → ") || msg("tasks.none"), service("hub", true).join(" "), service("runtime", true).join(" ")] });
  }
  // Retirement and service startup succeeded. A diagnostic failure cannot undo the switch.
  log(msg("switch.switch_run_doctor"));
  const result = await run([join(bin, "lumio"), "doctor"]);
  const stdout = options.stdout ?? (chunk => { process.stdout.write(chunk); });
  const stderr = options.stderr ?? (chunk => { process.stderr.write(chunk); });
  if (result.stdout) stdout(result.stdout);
  if (result.stderr) stderr(result.stderr);
  if (result.code) {
    const failed = result.stdout.split(/\r?\n/).filter(line => line.replace(/\x1b\[[0-9;]*m/g, "").startsWith("✗"));
    log(msg("switch.switch_completed_these_checks_failed", failed.length ? failed.join("；") : msg("switch.see_doctor_output_above")));
    return 1;
  }
  log(msg("switch.switch_completed_legacy_notes_are_knowledge_files_manage_tasks_and_r"));
  return 0;
}
