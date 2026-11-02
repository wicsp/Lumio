/**
 * apps/web 的入口模块（ADR 0027）：只供 apps/cli 引用，把网页交给 Hub 提供。
 * Hub 不 import apps/web；apps/cli 调用这里得到文件表，再经 startHub 的选项传入。
 *
 *   const files = webFiles(await buildWebAssets(), { apiBase: "" });
 *   // 发布构建：在构建时调用 buildWebAssets()，把 assets 以文本方式嵌入程序，运行时只调用 webFiles。
 */
export { buildAssets as buildWebAssets, type WebAssets } from "./build.ts";
export { WEB_CSP, webFiles, type WebFile, type PageOptions } from "./page.ts";
