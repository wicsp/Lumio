/** 依赖边界规则，见 docs/DESIGN.md 第 2 节。由 `bun run lint:deps` 在 CI 中强制执行。 */
module.exports = {
  forbidden: [
    {
      name: "domains-are-independent",
      severity: "error",
      from: { path: "^packages/(knowledge|work|execution|assistant)/src/" },
      to: { path: "^packages/(knowledge|work|execution|assistant|storage|api-client|platform|core)/", pathNot: "^packages/$1/" },
    },
    {
      name: "domains-no-io",
      severity: "error",
      from: { path: "^packages/(knowledge|work|execution|assistant)/src/" },
      to: { path: "^(node:)?(fs|fs/promises|http|https|http2|net|tls|dgram|child_process)$|^bun:sqlite$|node_modules/(undici|axios|node-fetch|ky|got)/" },
    },
    {
      name: "apps-use-explicit-modules",
      severity: "error",
      from: { path: "^apps/" },
      to: { path: "^packages/core/" },
    },
    {
      name: "packages-not-depend-on-apps",
      severity: "error",
      from: { path: "^packages/" },
      to: { path: "^apps/" },
    },
    {
      name: "apps-not-depend-on-each-other",
      severity: "error",
      from: { path: "^apps/([^/]+)/" },
      to: { path: "^apps/", pathNot: "^apps/$1/" },
    },
    {
      name: "schema-is-leaf",
      comment: "packages/schema 只能依赖 zod，不依赖任何其他包",
      severity: "error",
      from: { path: "^packages/schema/src/" },
      to: { path: "^packages/(?!schema/)|node_modules/(?!zod/)" },
    },
    {
      name: "core-no-network",
      comment: "packages/core 是纯本地逻辑；网络请求放在 apps/* 或 api-client。全局 fetch 无法静态检测，靠 review 把关",
      severity: "error",
      from: { path: "^packages/core/" },
      to: { path: "^(node:)?(http|https|http2|net|tls|dgram)$|node_modules/(undici|axios|node-fetch|ky|got)/" },
    },
    { name: "no-circular", severity: "error", from: {}, to: { circular: true } },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    exclude: { path: "(^|/)node_modules/" },
    tsConfig: { fileName: "tsconfig.json" },
    tsPreCompilationDeps: true,
    enhancedResolveOptions: { exportsFields: ["exports"], conditionNames: ["import", "bun", "default"] },
  },
};
