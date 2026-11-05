import { createECDH, createDecipheriv, createHmac, createPublicKey, verify } from "node:crypto";
import type { PushSubscriptionInput } from "@lumio/schema";

/** Synthetic browser: independent HMAC expansion and receiver-side decryption. No network. */
export function pushReceiver(endpoint = "https://push.example.test/synthetic-subscription") {
  const receiver = createECDH("prime256v1"); receiver.generateKeys();
  const auth = Buffer.alloc(16, 37);
  const subscription: PushSubscriptionInput = { endpoint, keys: { p256dh: receiver.getPublicKey().toString("base64url"), auth: auth.toString("base64url") } };
  return { subscription, decrypt(body: Buffer): unknown {
    const salt = body.subarray(0, 16), keyLength = body[20]!, pub = body.subarray(21, 21 + keyLength);
    if (body.readUInt32BE(16) !== 4096 || keyLength !== 65) throw new Error("Invalid record header");
    const mac = (key: Buffer, data: Buffer) => createHmac("sha256", key).update(data).digest();
    const secret = receiver.computeSecret(pub), prkKey = mac(auth, secret);
    const ikm = mac(prkKey, Buffer.concat([Buffer.from("WebPush: info\0"), receiver.getPublicKey(), pub, Buffer.from([1])]));
    const prk = mac(salt, ikm);
    const cek = mac(prk, Buffer.from("Content-Encoding: aes128gcm\0\x01")).subarray(0, 16);
    const nonce = mac(prk, Buffer.from("Content-Encoding: nonce\0\x01")).subarray(0, 12);
    const decipher = createDecipheriv("aes-128-gcm", cek, nonce);
    decipher.setAuthTag(body.subarray(-16));
    const clear = Buffer.concat([decipher.update(body.subarray(21 + keyLength, -16)), decipher.final()]);
    if (clear.at(-1) !== 2) throw new Error("Invalid final record delimiter");
    return JSON.parse(clear.subarray(0, -1).toString());
  } };
}
export function verifyVapid(authorization: string) {
  const match = /^vapid t=([^,]+), k=([A-Za-z0-9_-]+)$/.exec(authorization);
  if (!match) throw new Error("Invalid authorization");
  const [header, claims, signature] = match[1]!.split("."), pub = Buffer.from(match[2]!, "base64url");
  const key = createPublicKey({ format: "jwk", key: { kty: "EC", crv: "P-256", x: pub.subarray(1, 33).toString("base64url"), y: pub.subarray(33).toString("base64url") } });
  if (!verify("sha256", Buffer.from(`${header}.${claims}`), { key, dsaEncoding: "ieee-p1363" }, Buffer.from(signature!, "base64url"))) throw new Error("Invalid VAPID signature");
  return { header: JSON.parse(Buffer.from(header!, "base64url").toString()), claims: JSON.parse(Buffer.from(claims!, "base64url").toString()), publicKey: match[2]! };
}
