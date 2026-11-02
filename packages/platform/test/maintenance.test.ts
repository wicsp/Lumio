import { expect, test } from "bun:test";
import { ClientJoin } from "@lumio/schema";
import { createPairer, PairingError } from "../src/pairing-feedback.ts";
import { environment, httpURL, serviceCommand } from "../src/diagnostics.ts";

test("pairing uses each caller's version and injected display without shared application state", async () => {
  const join = ClientJoin.parse({ actor: "act_00000000000000000000000001", token: "synthetic-token" }), warnings: string[][] = [[], []];
  const fetcher = Object.assign(async (input: Parameters<typeof fetch>[0]) => String(input).endsWith("/health")
    ? Response.json({ ok: true, version: "3.0.0" }) : Response.json(join), { preconnect: fetch.preconnect });
  for (const [index, version] of ["1.0.0", "2.0.0"].entries()) {
    expect(await createPairer(version)("http://synthetic", "synthetic-code", "client", ClientJoin, fetcher, (line) => warnings[index]!.push(line))).toEqual(join);
    expect(warnings[index]![0]).toContain(`本程序是 ${version}`);
  }
  const absent = Object.assign(async (input: Parameters<typeof fetch>[0]) => String(input).endsWith("/health")
    ? Response.json({ ok: true, version: "3.0.0" }) : new Response("not a token", { status: 404 }), { preconnect: fetch.preconnect });
  await expect(createPairer("2.0.0")("http://synthetic", "synthetic-code", "runtime", ClientJoin, absent)).rejects.toBeInstanceOf(PairingError);
});

test("platform diagnostics reject malformed inputs with coded errors and no user input in their message", () => {
  for (const action of [() => httpURL("synthetic-secret"), () => httpURL("https://name:synthetic-secret@host"), () => environment("invalid synthetic-secret"), () => serviceCommand("unsupported", 1, "hub", "restart")]) {
    try { action(); throw new Error("expected failure"); }
    catch (cause) { expect(cause).toHaveProperty("code", "INVALID"); expect(String(cause)).not.toContain("synthetic-secret"); }
  }
});
