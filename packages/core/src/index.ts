/**
 * @lumio/core —— vault 解析、链接图、索引、BibTeX。
 *
 * 纯本地逻辑，不做网络请求（由 lint:deps 部分强制，其余靠 review）。
 * P0：vault 扫描、frontmatter 读写与元数据补全。
 */
export * from "./errors.ts";
export * from "./ids.ts";
export * from "./fill.ts";
export * from "./frontmatter.ts";
export * from "./vault.ts";
export * from "./write.ts";
export * from "./create.ts";
export * from "./paper-input.ts";
export * from "./paper-metadata.ts";
export * from "./citekey.ts";
export * from "./bibtex.ts";
export * from "./paper.ts";
export * from "./arxiv.ts";
export * from "./index/query.ts";
export type { IndexOptions } from "./index/store.ts";
export * from "./export-bib.ts";
export * from "./sync.ts";
export * from "./git.ts";
export { updateIndex } from "./index/store.ts";
