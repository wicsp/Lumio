/**
 * @lumio/core —— 旧包的兼容转发入口（ADR 0025）。
 * 实现已归 Knowledge / Storage / Execution / Foundation / Platform；应用不得再依赖此汇总入口。
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
export * from "./task-note.ts";
export * from "./cron.ts";
export * from "./terminal.ts";
