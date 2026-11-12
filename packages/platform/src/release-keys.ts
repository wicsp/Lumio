/**
 * 正式发布签名公钥（ADR 0063 第 3 节，U1-2）。
 *
 * - 格式：Ed25519 公钥的 SPKI DER，base64 一行。私钥（PKCS#8 PEM）只在 GitHub Actions 密钥 LUMIO_RELEASE_SIGNING_KEY 中。
 * - 列表形式：换钥时新旧公钥并存一段时间，旧版程序仍能验证新发布。
 * - 由 build-binary.ts 编入程序；Runtime 自更新与 `lumio upgrade` 只接受由列表中任一公钥签名的发布清单。
 */
export const RELEASE_PUBLIC_KEYS: readonly string[] = [
  // 2026-11-12 生成（SHA-256 指纹前缀 7fb801eb0939ac00）
  "MCowBQYDK2VwAyEAQOGVb/iSKsKst7CYrE9xxSvcYolj5PQnOxJMP5NyJ94=",
];
