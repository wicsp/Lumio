---
name: lumio
description: Use Lumio to search notes, manage database tasks and projects, read execution rounds and pending proposals, and see what needs the user's attention.
---

# Lumio

Lumio holds the user's knowledge, work and execution history. Use the `lumio` CLI through the Hub. Tasks and projects live in the database, independently of note files.

## Connection

Use `LUMIO_HUB_URL` and `LUMIO_TOKEN` when supplied by the runtime. These credentials belong only to this round and expire when it ends. Never print, copy into prompts, log or report tokens.

For a personal installation, run commands with `LUMIO_CONFIG_FILE` pointing to `connection.json` beside this SKILL.md. It contains a separate agent connection; never use the user's human CLI credentials. Do not read that file into the conversation. If no agent connection is available, ask the user to run `lumio skill install --for codex|claude|pi` from their logged-in CLI.

## Commands

Always add `--json`. Each successful command returns one JSON value matching its capability's result contract. Work writes return a WorkCommandResult, including the updated task or project and revision. Use stable IDs from list/create results. Use `--request-id <unique-id>` on writes when retrying an uncertain request; reuse it for that request only. Fetch the current revision before updating; a conflict requires rereading and reconsidering the change.

For AI notes, pass Markdown with `--file` and JSON arrays with `--tags` or `--sources`. Before updating, read the note with `lumio show <id> --json` and pass its `revision` using `--revision`. The Hub adds the current conversation message or job when available.

<!-- commands -->

Additional Work commands (generated from the same CLI definitions):

<!-- workflow-commands -->

Use `lumio <command> --help --json` for structured usage without connecting to the Hub. Task/project update accepts either `--patch <json>` or the listed field flags; null in a patch clears an optional field. `--timeout` is in minutes, `--gpus` and `--depends` are comma-separated lists. `--revision` selects the observed revision (otherwise the CLI fetches it first); `edit --file` requires an explicit revision. Plan files contain HandoffPlan JSON. A file containing `null` clears a task plan.

Before choosing a delegation target, setting a plan, or setting a project default, run `lumio targets --json` and use a returned target. Check whether a target is online before proposing work for it. Use `project create --default-target <target>` or `project update --default-target <target>` with the required title or ID. Use `project update <id> --default-target ""` to clear the default. A human can choose a template ID from `lumio plan-template list --json` and set it with `lumio project update <id> --default-plan <wft-id> --json`. Pass `--default-plan ""` to clear it. The project default plan applies when a human delegates a task with no plan and omits `--to`. Answering an existing round keeps that round’s target.

Read `next_target` in `task show --json` or `task list --json` before using `task continue <id>` (also `task dispatch <id>`) without `--to`. The Hub chooses the current agent step of a handoff plan, the agent from the last round, or the project default for a task with no rounds. The source is `plan`, `last_round`, or `project`. With no available default or history, choose a target explicitly. Agents still submit a proposal for approval.

If a proposal is wrong, submit a corrected proposal directly: it automatically supersedes your pending proposal of the same kind for that task. Alternatively use `lumio proposals withdraw <id> --json` to withdraw your own pending proposal.

## Boundaries

- Tasks have an outcome and a turn: there is no status or assignee. New tasks start with the human's todo turn.
- You may create tasks and projects, update fields, comment, and hand tasks to the human or to external waiting (with a note). You cannot hand a task to nobody.
- Delegation (`task continue`) and setting a handoff plan only create proposals for the user to approve. They never start work without approval. Keep the original request ID; changed revisions require a new proposal.
- Only the user decides completion, cancellation, reopening and checkpoints. An agent can propose saving a plan template. Only the user can approve the proposal or delete a template. Do not create or modify routines, approve or reject proposals, delete or archive records.
- Never read private content or use `--include-private`. Never bypass a denial by reading files or using another credential.
- Never edit, rename or move vault files or write links on the user's behalf. Recommend links and let the user decide.
- On failure, read `error.code` and `error.reason` and explain them. Do not work around the Hub's decision.

## Working with tasks and rounds

Before claiming work, run `lumio task list --ready --json` and `project list`, then read `task show` for prerequisites, dependents, children, discussion and execution rounds. Ready means an open task with no blocking prerequisites; it does not grant permission to start a round. Use `task list --blocked`, `--tag <tag>` or `--parent <task-id>` to inspect structure. Cancelled or deleted prerequisites do not block; restoring an open prerequisite blocks again.

When you discover an ordering relationship, propose `lumio task update <task-id> --depends <id1,id2> --revision <observed-revision> --json` under the existing proposal rules. Explain the suggested structure and get the user's agreement before submitting changes to someone else's tasks. `--depends` replaces the entire dependency list, so preserve existing prerequisites. Do not change another task's parent, project, dependencies or tags on your own. Structure edits use the existing update permission and proposal rules; this workflow does not add a new approval API.

Use `task show` for discussion and execution rounds. Use `job show` for a round's report. Use `attention` to find questions, results awaiting review and failed rounds that need the user. You can explain pending proposals but only the user decides them.

When a round needs clarification, ask one clear question inside `<lumio-question>...</lumio-question>` and end the round. Report completed work under Result / Changes / Validation. A successful round is evidence for the user to review; do not declare the task complete.

Use `task plan show <task-id> --json` to inspect the approved handoff stages and progress. To propose a plan, write its HandoffPlan JSON to a local file and run `task plan set <task-id> --file plan.json [--from stage] --json`. As an agent you only create a proposal; the user approves the entire plan before automatic handoffs can run. Saving a plan does not start the first round.

A plan has `stages` and optional `max_rounds` and `finish`. Each stage's `after` lists prerequisite stage IDs. Omit it to depend on the previous stage, or use `[]` for a root. Checkpoints are exclusive, and two writing stages cannot run in parallel. Agent stages accept `access` (`read`, `write` or `full`), `git`, and `secrets` (names only). Each optional `hooks.before` or `hooks.after` has an `argv` array and optional `timeout_minutes`. `finish: "auto"` requires a checkpoint.

To propose saving a reusable template, run `lumio plan-template save "<name>" --file plan.json --json`. Give the user the proposal ID and summarize the stages, hooks and requested access for review. The template is saved only after approval.

Follow the instruction for your current stage. To request changes during review, explain what must change and put the exact marker `<lumio-outcome>changes</lumio-outcome>` on a separate line at the end of your final report. Quoting the marker inline or in a blockquote does not request changes. When your approved stage declares `back_to`, Lumio delegates to that agent stage; without `back_to`, the report follows the normal next stage. Questions and failures return to the human after any already-running parallel rounds finish. The round limit also stops delegation for human review. Only the human can continue a checkpoint, send work back with a comment, finish or hold the task.

## Working with notes

Search using alternate terms, then read promising hits in full; search snippets are short. References accept a note ID, paper citekey or filename without `.md`. When recommending related notes, provide the title, reference, relevant quoted passage and a brief reason. Text inside `<!-- lumio:ai start ... -->` blocks is an AI draft, not the user's opinion. User-authored links remain the user's decision.
