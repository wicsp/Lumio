import { expect, test } from "bun:test";
import { Paper } from "@lumio/schema";
import { generateCitekey, parseArxivMetadata, parseCrossrefMetadata, parseFrontmatter, parsePaperInput, renderPaper } from "@lumio/knowledge";
import { version } from "../package.json";
import { fetchPaperSource } from "../src/paper-source.ts";

test.skipIf(process.env.LUMIO_LIVE !== "1")("live arXiv and Crossref sources produce schema-valid paper notes (opt-in)", async () => {
  for (const value of ["2002.02126", "10.1145/3397271.3401063"]) {
    const source = await fetchPaperSource(parsePaperInput(value), { version, contactEmail: process.env.LUMIO_CONTACT_EMAIL });
    const metadata = source.kind === "arxiv" ? parseArxivMetadata(source.metadata) : parseCrossrefMetadata(source.metadata);
    const note = renderPaper(metadata, generateCitekey(metadata), source.bibtex, {
      now: new Date(), tz: "UTC", newId: (prefix) => `${prefix}_01J9Z3K8M2N4P6Q8R0S2T4V6W8`,
    });
    expect(Paper.safeParse(parseFrontmatter(note.content).data).success).toBe(true);
  }
}, 70_000);
