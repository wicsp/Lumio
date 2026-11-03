export type Language = "en" | "zh";
export interface MessageParams { key: string; args: readonly unknown[] }
export type Text = (key: string, ...args: unknown[]) => string;
export type MessageTable = Record<string, string | ((...args: unknown[]) => string)>;
/** First non-empty locale wins. HTTP callers pass the header as LUMIO_LANG. */
export function language(env: Readonly<Record<string, string | undefined>> = process.env): Language {
  const value = [env.LUMIO_LANG, env.LC_ALL, env.LC_MESSAGES, env.LANG].find(value => value !== undefined && value !== "");
  return value?.startsWith("zh") ? "zh" : "en";
}
export const untranslated: Text = (key, ...args) => key.replace(/\$\{(\d+)\}/g, (_, index: string) => String(args[Number(index)]));
export function renderMessage(table: MessageTable, params: MessageParams): string {
  const value = table[params.key];
  const args = params.args.map(arg => arg && typeof arg === "object" && "key" in arg && "args" in arg
    ? renderMessage(table, arg as MessageParams) : arg);
  return typeof value === "function" ? value(...args) : value ?? untranslated(params.key, ...args);
}
