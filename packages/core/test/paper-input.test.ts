import { expect, test } from "bun:test";
import { parsePaperInput } from "../src/index.ts";

test.each([
  ["2403.14720", "2403.14720"], ["2403.14720v2", "2403.14720"],
  ["arXiv:2403.14720", "2403.14720"], ["arXiv:2403.14720v2", "2403.14720"],
  ["hep-th/9901001", "hep-th/9901001"], ["hep-th/9901001v2", "hep-th/9901001"],
  ["https://arxiv.org/abs/2403.14720", "2403.14720"],
  ["https://arxiv.org/abs/2403.14720v2", "2403.14720"],
  ["https://arxiv.org/pdf/2403.14720", "2403.14720"],
  ["https://arxiv.org/pdf/2403.14720.pdf", "2403.14720"],
  ["https://arxiv.org/pdf/2403.14720v2.pdf", "2403.14720"],
  ["https://arxiv.org/pdf/hep-th/9901001v2.pdf", "hep-th/9901001"],
])("recognizes arXiv %s", (input, id) => { expect(parsePaperInput(input)).toEqual({ kind: "arxiv", id }); });

test.each(["10.1145/3397271.3401063", "https://doi.org/10.1145/3397271.3401063", "https://doi.org/10.1145%2F3397271.3401063"])("recognizes DOI %s", (input) => {
  expect(parsePaperInput(input)).toEqual({ kind: "doi", doi: "10.1145/3397271.3401063" });
});

test.each(["", "not a paper", "2403.14720v0", "https://example.com/abs/2403.14720", "https://arxiv.org.evil/abs/2403.14720", "https://user:pass@arxiv.org/abs/2403.14720", "https://doi.org/%zz", "10.123/no spaces"])("invalid paper input is actionable: %j", (input) => {
  try { parsePaperInput(input); }
  catch (cause) {
    expect(cause).toMatchObject({ code: "INVALID_PAPER_INPUT" });
    expect((cause as Error).message).toBe("INVALID_PAPER_INPUT");
    return;
  }
  throw new Error("expected invalid input");
});
