import { writeFileSync } from "node:fs";

const args = process.argv.slice(2);
if (args[0] === "--version") {
  console.log("codex-cli 0.166.0");
  process.exit(0);
}

const result = args[args.indexOf("--output-last-message") + 1]!;
const session = "synthetic-permission-session";
let report = "Need to fetch the synthetic upstream.\n<lumio-permission>git, secret:fixture</lumio-permission>";
if (args[1] === "resume") {
  if (!args.includes(session) || !args.includes('default_permissions="lumio-stage"')
    || process.env.LUMIO_SECRET_fixture !== "synthetic-permission-secret" || process.env.LUMIO_SECRET_other !== undefined) process.exit(3);
  report = "Resumed with the approved Git access and credential: " + process.env.LUMIO_SECRET_fixture;
} else if (process.env.LUMIO_SECRET_fixture !== undefined) process.exit(3);
console.log(JSON.stringify({ type: "thread.started", thread_id: session }));
writeFileSync(result, report);
