import { createCipheriv, createECDH, createPrivateKey, createPublicKey, hkdfSync, randomBytes, sign, generateKeyPairSync, type ECDH } from "node:crypto";
import { fchmodSync, closeSync, constants, fstatSync, openSync, readFileSync, writeFileSync, fsyncSync } from "node:fs";
import { join } from "node:path";
import type { PushSubscriptionInput } from "@lumio/schema";

const decode = (value: string) => Buffer.from(value, "base64url");

/** RFC 8291 §§3–5: one aes128gcm record, fresh ECDH key and salt per message. */
export function encryptPush(payload: Uint8Array, keys: PushSubscriptionInput["keys"],
  sender?: ECDH, salt = randomBytes(16)): Buffer {
  if (!sender) { sender = createECDH("prime256v1"); sender.generateKeys(); }
  const ua = decode(keys.p256dh), pub = sender.getPublicKey();
  const ikm = hkdfSync("sha256", sender.computeSecret(ua), decode(keys.auth), Buffer.concat([Buffer.from("WebPush: info\0"), ua, pub]), 32);
  const cek = hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16);
  const nonce = hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12);
  if (payload.length > 3993 || salt.length !== 16) throw new Error("Invalid push record size");
  const cipher = createCipheriv("aes-128-gcm", Buffer.from(cek), Buffer.from(nonce));
  const header = Buffer.alloc(21); salt.copy(header); header.writeUInt32BE(4096, 16); header[20] = pub.length;
  return Buffer.concat([header, pub, cipher.update(Buffer.concat([payload, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
}

export function validatePushKeys(keys: PushSubscriptionInput["keys"]): void {
  const pub = decode(keys.p256dh), auth = decode(keys.auth);
  if (pub.length !== 65 || pub[0] !== 4 || auth.length !== 16) throw new Error("Invalid subscription keys");
  const ephemeral = createECDH("prime256v1"); ephemeral.generateKeys(); ephemeral.computeSecret(pub);
}

/** Lazy, private, stable signing identity. Never silently replace a damaged existing key. */
export class VapidKeys {
  constructor(private readonly stateDir: string) {}
  private load() {
    const path = join(this.stateDir, "push-vapid.pem");
    let fd: number;
    try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
      const { privateKey: key } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
      const output = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { writeFileSync(output, key.export({ format: "pem", type: "pkcs8" })); fsyncSync(output); } finally { closeSync(output); }
      fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    }
    try {
      if (!fstatSync(fd).isFile()) throw new Error("Invalid VAPID file");
      fchmodSync(fd, 0o600);
      const key = createPrivateKey(readFileSync(fd));
      const jwk = createPublicKey(key).export({ format: "jwk" });
      if (jwk.crv !== "P-256" || !jwk.x || !jwk.y) throw new Error("Invalid VAPID key");
      return { key, publicKey: Buffer.concat([Buffer.from([4]), decode(jwk.x), decode(jwk.y)]).toString("base64url") };
    } finally { closeSync(fd); }
  }
  publicKey(): string { return this.load().publicKey; }
  /** RFC 8292: ES256 JWS uses raw r||s, with the push service origin as audience. */
  authorization(endpoint: string, now: Date, subject?: string): string {
    const { key, publicKey } = this.load();
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const input = `${encode({ typ: "JWT", alg: "ES256" })}.${encode({ aud: new URL(endpoint).origin,
      exp: Math.floor(now.getTime() / 1000) + 12 * 60 * 60, ...(subject?.startsWith("https:") ? { sub: subject } : {}) })}`;
    const signature = sign("sha256", Buffer.from(input), { key, dsaEncoding: "ieee-p1363" }).toString("base64url");
    return `vapid t=${input}.${signature}, k=${publicKey}`;
  }
}
