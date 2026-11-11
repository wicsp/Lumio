import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileIdentity, replaceBinary, snapshotDatabase } from "./deploy-local.ts";

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "lumio-deploy-test."));
  const installed = join(directory, "lumio"), candidate = join(directory, "candidate"), previous = join(directory, "backup");
  writeFileSync(installed, "previous program");
  writeFileSync(previous, "previous program");
  writeFileSync(candidate, "new program");
  return { directory, installed, candidate, previous, originalIdentity: fileIdentity(installed) };
}

test("checks a staged file before replacing the existing inode", async () => {
  const files = fixture();
  try {
    await replaceBinary({ ...files, verify: stage => {
      expect(readFileSync(stage, "utf8")).toBe("new program");
      expect(fileIdentity(files.installed)).toBe(files.originalIdentity);
    }, activate: async () => {
      expect(readFileSync(files.installed, "utf8")).toBe("new program");
      expect(fileIdentity(files.installed)).not.toBe(files.originalIdentity);
    }, rollback: async () => { throw new Error("unexpected rollback"); } });
  } finally { rmSync(files.directory, { recursive: true, force: true }); }
});

test("failed verification and a concurrent write both leave the installed file alone", async () => {
  const files = fixture();
  const unexpected = async () => { throw new Error("unexpected service restart"); };
  try {
    await expect(replaceBinary({ ...files, verify: () => { throw new Error("bad signature"); },
      activate: unexpected, rollback: unexpected })).rejects.toThrow("bad signature");
    expect(fileIdentity(files.installed)).toBe(files.originalIdentity);
    await expect(replaceBinary({ ...files, verify: () => writeFileSync(files.installed, "another deployment"),
      activate: unexpected, rollback: unexpected })).rejects.toThrow("changed during preparation");
    expect(readFileSync(files.installed, "utf8")).toBe("another deployment");
  } finally { rmSync(files.directory, { recursive: true, force: true }); }
});

test("failed activation restores the backup before restarting the old program", async () => {
  const files = fixture();
  try {
    await expect(replaceBinary({ ...files, verify: () => {}, activate: async () => {
      expect(readFileSync(files.installed, "utf8")).toBe("new program");
      throw new Error("unhealthy Hub");
    }, rollback: async () => {
      expect(readFileSync(files.installed, "utf8")).toBe("previous program");
      expect(fileIdentity(files.installed)).not.toBe(files.originalIdentity);
    } })).rejects.toThrow("unhealthy Hub");
    expect(readFileSync(files.previous, "utf8")).toBe("previous program");
  } finally { rmSync(files.directory, { recursive: true, force: true }); }
});

test("Runtime backup includes committed WAL data while the source database remains open", () => {
  const files = fixture();
  const source = new Database(join(files.directory, "runtime.sqlite"));
  const snapshot = join(files.directory, "snapshot.sqlite");
  try {
    source.exec("PRAGMA journal_mode=WAL; CREATE TABLE queue (state TEXT); INSERT INTO queue VALUES ('running')");
    snapshotDatabase(source.filename, snapshot);
    source.exec("UPDATE queue SET state='done'");
    const copy = new Database(snapshot, { readonly: true });
    try { expect(copy.query("SELECT state FROM queue").get()).toEqual({ state: "running" }); }
    finally { copy.close(); }
  } finally {
    source.close();
    rmSync(files.directory, { recursive: true, force: true });
  }
});
