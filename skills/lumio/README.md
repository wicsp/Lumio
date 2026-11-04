# Installing the Lumio skill

Install the `lumio` release and log the CLI into your Hub, then run:

```sh
lumio skill install --for codex
lumio skill install --for claude
lumio skill install --for pi
```

Omit `--for` to install all three. Re-running the command updates SKILL.md and preserves the existing connection.

The destinations are `~/.agents/skills/lumio`, `~/.claude/skills/lumio` and `~/.pi/agent/skills/lumio`. Each directory has a separate, private `connection.json`. Installation from a human CLI issues an agent token for that agent and machine. Installation with an existing agent token uses that token. Tokens never appear in SKILL.md or installation output.

The skill tells the agent to use `LUMIO_CONFIG_FILE=<skill-directory>/connection.json`. Runtime-supplied `LUMIO_HUB_URL` and `LUMIO_TOKEN` take precedence. Do not give agents your human credentials.

Manage access from any logged-in human CLI:

```sh
lumio agent add codex@mac --label laptop
lumio agent list --json
lumio agent revoke codex@mac --label laptop
lumio agent revoke codex@mac
```

`add` shows the token once. Lists contain labels and activity, never token plaintext. Revoking without a label revokes all credentials for the agent, including active round credentials.

The runtime negotiates `job-access` and stores credentials separately from Jobs in its private queue. It passes only that round's agent credential to the agent process, installs a round-local skill, and removes the queue credential after completion. Locally triggered routines have no Hub credential. The Hub validates lifecycle, cancellation, lease and expiry on every use.

Edit `instructions.md` for prose and `commands.ts` for CLI spellings, then run `bun run gen:skill`. The command table's names and descriptions come from `CAPABILITIES`. Tests exercise every command's JSON result against the catalog and check that generated SKILL.md matches the committed version. Synthetic process tests do not call real models or touch a user vault.
