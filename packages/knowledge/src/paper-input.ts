import { CoreError } from "@lumio/foundation";

export type PaperInput = { kind: "arxiv"; id: string } | { kind: "doi"; doi: string };
const ARXIV_ID = /^(?:\d{4}\.\d{4,5}|[a-z][a-z.-]*\/\d{7})(?:v[1-9]\d*)?$/i;
const DOI = /^10\.\d{4,9}\/[^\s<>]+$/i;

export function parsePaperInput(value: string): PaperInput {
  let input = value.trim();
  try {
    if (/^https?:\/\//i.test(input)) {
      const url = new URL(input);
      if (url.username || url.password || url.port) throw new Error("无效来源链接");
      if (url.hostname === "arxiv.org" && /^\/(abs|pdf)\//.test(url.pathname)) {
        input = decodeURIComponent(url.pathname.replace(/^\/(abs|pdf)\//, "")).replace(/\.pdf$/i, "");
      } else if (url.hostname === "doi.org") {
        input = decodeURIComponent(url.pathname.slice(1));
      } else throw new Error("无效来源链接");
    } else input = input.replace(/^arxiv:/i, "");
    if (ARXIV_ID.test(input)) return { kind: "arxiv", id: input.replace(/v\d+$/i, "") };
    if (DOI.test(input)) return { kind: "doi", doi: input };
  } catch { /* Report all unsupported input in the same, actionable format. */ }
  throw new CoreError("INVALID_PAPER_INPUT", "无法识别论文输入；接受 arXiv 号（2403.14720、hep-th/9901001）、arXiv abs/pdf 链接、DOI（10.1145/3397271.3401063）或 https://doi.org/<DOI>");
}
