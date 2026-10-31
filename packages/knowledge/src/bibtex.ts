import { Citekey } from "@lumio/schema";
import { CoreError } from "@lumio/foundation";

/** Change only the entry key; preserve all other characters from the source. */
export function rewriteBibtexKey(bibtex: string, citekey: string): string {
  if (!Citekey.safeParse(citekey).success) throw new CoreError("INVALID_CITEKEY", "BibTeX 的 citekey 不合法");
  const entry = /^(\s*@(?!(?:comment|string|preamble)\b)[a-z]+\s*[{(]\s*)([^,\s]+)(\s*,)/i.exec(bibtex);
  if (!entry || !/[})]\s*$/.test(bibtex)) throw new CoreError("INVALID_BIBTEX", "来源未返回合法的 BibTeX 条目");
  return bibtex.slice(0, entry[1]!.length) + citekey + bibtex.slice(entry[1]!.length + entry[2]!.length);
}
