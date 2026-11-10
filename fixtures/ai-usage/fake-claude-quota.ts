const mode = process.argv[2];
const prompt = "❯ ";
const status = "/status  Show Claude Code status";
const usage = "/usage  Show plan usage limits";
const paint = (screen: string) => process.stdout.write("\x1b[2J\x1b[H" + screen.replaceAll("\n", "\r\n"));
let menu = "";
process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.on("data", (data: Buffer) => {
  const input = data.toString();
  if (input === "/status" || input === "/usage") {
    menu = input;
    paint(mode === "unknown" ? "/usage  Custom project command" : input === "/status" ? status : usage);
  } else if (input === "\r") {
    if (mode === "unknown") {
      paint("HTTP 429");
    } else if (menu === "/status") {
      paint("Login method: Claude account\nEmail: fixture@example.test\nOrganization: Fixture");
    } else if (menu === "/usage") {
      if (mode === "limit") {
        paint("HTTP 429");
      } else {
        paint("Current session\n\x1b[32");
        setTimeout(() => process.stdout.write("m32% used\x1b[0m\r\n\r\nCurrent week (all models)\r\n64% used"), 10);
      }
    }
  } else if (input === "\x1b") paint(prompt);
});
paint(mode === "trust" ? "Quick safety check\nDo you trust this workspace?" : prompt);
