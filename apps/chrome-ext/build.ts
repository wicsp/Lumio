/** 构建插件到 dist/：打包三个入口，复制 manifest、页面、样式、图标与文案。在 Chrome「加载已解压的扩展程序」里选 dist/。 */
import { cp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

const here = import.meta.dir, out = join(here, "dist");
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
const result = await Bun.build({
  entrypoints: ["popup", "options", "background"].map(name => join(here, "src", `${name}.ts`)),
  outdir: out, target: "browser", format: "esm", minify: true, sourcemap: "none",
});
if (!result.success) { for (const log of result.logs) console.error(log); process.exit(1); }
await cp(join(here, "static"), out, { recursive: true });
const { version } = await Bun.file(join(here, "package.json")).json() as { version: string };
const manifest = await Bun.file(join(out, "manifest.json")).json() as { version: string };
manifest.version = version;
await Bun.write(join(out, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Built Lumio extension ${version} → ${out}`);
