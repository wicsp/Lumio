import { Citekey } from "@lumio/schema";
import { CoreError } from "@lumio/foundation";
import type { PaperMetadata } from "./paper-metadata.ts";

const STOP_WORDS = new Set(["a", "an", "the", "of", "for", "with", "and", "on", "in", "to", "at", "by", "from", "as", "is", "are"]);

const asciiAbbreviation = (value: string): string => value.replace(/[^A-Za-z0-9]/g, "");

/** Mechanical ASCII rules from ADR 0004; no confirmation or transliteration table. */
export function generateCitekey(metadata: PaperMetadata, abbreviation?: string): string {
  if (!Number.isInteger(metadata.year) || metadata.year < 1000 || metadata.year > 9999) {
    throw new CoreError("INVALID_PAPER_YEAR", { key: "citekey.paper_year_must_have_four_digits", args: [] });
  }
  const surname = metadata.firstAuthorFamily ?? metadata.authors[0]?.trim().split(/\s+/u).at(-1) ?? "";
  const ascii = surname.normalize("NFD").replace(/\p{M}/gu, "").replace(/[^A-Za-z]/g, "");
  const family = ascii ? ascii.charAt(0).toUpperCase() + ascii.slice(1) : "Anon";
  let short: string;
  if (abbreviation !== undefined) {
    short = asciiAbbreviation(abbreviation);
    if (!short) throw new CoreError("INVALID_ABBREVIATION", { key: "citekey.abbr_is_empty_after_removing_invalid_characters_provide_ascii_letter", args: [] });
  } else {
    const colon = metadata.title.indexOf(":");
    const prefix = colon < 0 ? "" : metadata.title.slice(0, colon).trim();
    short = prefix && !/\s/u.test(prefix) ? asciiAbbreviation(prefix) : "";
    if (!short) {
      short = metadata.title.split(/\s+/u).map(asciiAbbreviation)
        .filter((word) => word && !STOP_WORDS.has(word.toLowerCase())).slice(0, 4)
        .map((word) => word.charAt(0).toUpperCase()).join("") || "Paper";
    }
  }
  const citekey = `${family}_${metadata.year}_${short}`;
  if (!Citekey.safeParse(citekey).success) {
    throw new CoreError("INVALID_CITEKEY", { key: "citekey.generated_citekey_does_not_match_contract", args: [] });
  }
  return citekey;
}
