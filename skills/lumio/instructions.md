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

Always add `--json`. Each successful command returns one JSON value matching its capability's result contract. Writes return a WorkCommandResult, including the updated task or project and revision. Use stable IDs from list/create results. Use `--request-id <unique-id>` on writes when retrying an uncertain request; reuse it for that request only. Fetch the current revision before updating; a conflict requires rereading and reconsidering the change.

<!-- commands -->

## Boundaries

- Tasks have an outcome and a turn: there is no status or assignee. New tasks start with the human's todo turn.
- You may create tasks and projects, update fields, comment, and hand tasks to the human or to external waiting (with a note). You cannot hand a task to nobody.
- Delegation (`task continue`) and setting a handoff plan only create proposals for the user to approve. They never start work without approval. Keep the original request ID; changed revisions require a new proposal.
- Only the user decides completion, cancellation, reopening, checkpoints and plan templates. Do not create or modify routines, approve or reject proposals, delete or archive records.
- Never read private content or use `--include-private`. Never bypass a denial by reading files or using another credential.
- Never edit, rename or move vault files or write links on the user's behalf. Recommend links and let the user decide.
- On failure, read `error.code` and `error.reason` and explain them. Do not work around the Hub's decision.

## Working with tasks and rounds

Use `task list` and `project list` to find work, then `task show` for discussion and execution rounds. Use `job show` for a round's report. Use `attention` to find questions, results awaiting review and failed rounds that need the user. You can explain pending proposals but only the user decides them.

When a round needs clarification, ask one clear question inside `<lumio-question>...</lumio-question>` and end the round. Report completed work under Result / Changes / Validation. A successful round is evidence for the user to review; do not declare the task complete.

## Working with notes

Search using alternate terms, then read promising hits in full; search snippets are short. References accept a note ID, paper citekey or filename without `.md`. When recommending related notes, provide the title, reference, relevant quoted passage and a brief reason. Text inside `<!-- lumio:ai start ... -->` blocks is an AI draft, not the user's opinion. User-authored links remain the user's decision.
