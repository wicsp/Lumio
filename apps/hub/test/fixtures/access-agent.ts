// Synthetic protocol participant; never reads user configuration or calls a model.
import { readFile } from "node:fs/promises";
if (process.argv[2] === "--version") { console.log("1.4.0"); process.exit(0); }
const token = process.env.LUMIO_TOKEN!, url = process.env.LUMIO_HUB_URL!, task = process.env.SYNTHETIC_TASK!;
const index = process.argv.indexOf("--skill");
if (index < 0 || !(await readFile(process.argv[index + 1]!, "utf8")).includes("# Lumio")) process.exit(10);
const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
const tasks = await fetch(`${url}/v2/work/tasks`, { headers }); if (!tasks.ok) process.exit(11);
const commented = await fetch(`${url}/v2/work/commands`, { method: "POST", headers, body: JSON.stringify({ request_id: "synthetic-process-comment", operation: { op: "work.task.comment", args: { task, body: "Synthetic process comment" } } }) });
if (!commented.ok) process.exit(12);
// Deliberately split the credential across writes to exercise streaming redaction.
process.stdout.write("Synthetic access succeeded " + token.slice(0, 20));
await Bun.sleep(30); process.stdout.write(token.slice(20) + "\n");
