import { expect, test } from "bun:test";
import { mioSsh } from "./deploy-mio.ts";

test("Mio deployment uses the configured alias, pinned host keys and no agent forwarding", () => {
  expect(mioSsh()).toEqual(["ssh", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes",
    "-o", "ForwardAgent=no", "-o", "ConnectTimeout=10", "mio"]);
  expect(mioSsh("192.0.2.20").slice(-3)).toEqual(["-o", "HostName=192.0.2.20", "mio"]);
  expect(() => mioSsh("example.org -o ProxyCommand=example")).toThrow("Invalid LUMIO_MIO_SSH_HOSTNAME");
});
