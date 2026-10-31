import { Id, ID_PREFIXES } from "@lumio/schema";
import { CoreError } from "./errors.ts";

export type IdPrefix = (typeof ID_PREFIXES)[keyof typeof ID_PREFIXES];
const BASE32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function newId(prefix: IdPrefix, now: Date, random: (n: number) => Uint8Array): string {
  const time = now.getTime();
  if (!Number.isSafeInteger(time) || time < 0 || time > 0xffffffffffff) {
    throw new CoreError("INVALID_ID_TIME", "ULID 时间必须在 48 位毫秒范围内");
  }
  try {
    const bytes = random(10);
    if (bytes.length !== 10) throw new Error("随机源必须返回 10 字节");
    let value = BigInt(time);
    for (const byte of bytes) value = (value << 8n) | BigInt(byte);
    let ulid = "";
    for (let i = 0; i < 26; i++) {
      ulid = BASE32[Number(value & 31n)] + ulid;
      value >>= 5n;
    }
    const id = `${prefix}_${ulid}`;
    if (!Id.safeParse(id).success) throw new Error("ID 前缀不合法");
    return id;
  } catch (cause) {
    throw new CoreError("INVALID_ID_SOURCE", "无法生成 ID", { cause });
  }
}

/** 从 ULID 形式的 ID 里取出时间部分（毫秒）。 */
export function idTime(id: string): number {
  const ulid = id.slice(id.indexOf("_") + 1);
  if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(ulid)) throw new CoreError("INVALID_ID_TIME", "不是 ULID 形式的 ID");
  let time = 0;
  for (const char of ulid.slice(0, 10)) time = time * 32 + BASE32.indexOf(char);
  return time;
}

