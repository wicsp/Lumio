import { KnowledgeService, type PaperMetadata, type FillContext } from "@lumio/knowledge";
import { FileKnowledgeRepository } from "./adapter.ts";

export function createPaper(vault: string, metadata: PaperMetadata, citekey: string, bibtex: string, context: FillContext): Promise<string> {
  return new KnowledgeService(new FileKnowledgeRepository(vault)).createPaper(metadata, citekey, bibtex, context);
}
