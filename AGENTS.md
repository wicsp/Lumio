# AGENTS.md — 所有 AI 共用的规则

本文件对 Claude Code、Codex 等所有编码 agent 生效。`CLAUDE.md` 只是引用本文件。

## 必读
开始任何任务前先读 `docs/ARCHITECTURE.md` 和 `docs/adr/` 里相关的条目。

## 硬规则
1. **契约不可私改**：`packages/schema/` 是唯一事实来源。需要改它时，先在 `docs/adr/` 写一条
   状态为 `Proposed` 的 ADR，停下来等人类批准，批准后再改。
   **ADR 本身的修改规则见 ADR 0013**：`Implemented` 的内容定稿，不得修改原文，要变更就写新的 ADR；
   `Accepted` 的内容修改前要人类批准，并记入文末的"修订记录"。导出的 JSON Schema 和由它生成的
   其他语言类型都是生成物，不得手改。
2. **依赖方向**（由 `bun run lint:deps` 强制）
   - `apps/*` → `packages/*`。`packages/*` 不得依赖 `apps/*`；`apps/*` 之间不得互相 import。
   - `packages/schema` 只依赖 `zod`。
   - `packages/core` 不做网络请求（包括全局 `fetch`，这一点工具查不出来，靠 review）。
   - `apps/runtime` 与 `apps/hub` 只通过 HTTP + job 协议通信。
3. **一次只动一个 package 或 app**，除非任务明确是契约变更的连带修改。
4. **新功能必须带测试**；契约相关行为要有契约测试（用 `@lumio/schema` 校验输入输出）。
5. **不引入新依赖**，除非在 PR 描述里写明理由和替代方案。
6. **不碰 vault 数据**：测试一律用 `fixtures/` 里的合成数据，不读写真实 vault。
7. **不在代码/配置里写真实密钥**，只用占位符（如 `${secret:openai}`），由运行时注入。
8. **提交前必须通过 `bun run check`**。
9. **同一时间只有一个会话改这个仓库。** 开始工作前先 `git pull` 并确认 `git status` 干净；
   工作在分支上进行，结束时提交并推送，不要把未提交的改动留在工作区。发现工作区里有别人未提交的改动时，
   停下来告诉人类，不要覆盖或接着改。

## 约定
- TypeScript strict，ESM；测试用 `bun test`。
- **Bun 版本固定为 1.3.x**（见 `package.json` 的 `packageManager`），与人类的 Nix 环境一致。
  `bun.lock` 必须用 1.3.x 生成；用更新版本的 Bun 会把锁文件升级成旧版本读不了的格式。
  升级 Bun 需要人类决定，并同时更新 Nix 环境。
- 包内互相引用用 `.ts` 扩展名；跨包只通过包名（`@lumio/schema`）引用，不写相对路径。
- 库代码抛出带 `code` 的错误类；只有 `apps/*` 负责打印和设置退出码。
- ID 格式：`<前缀>_<ULID>`，例如 `pap_01J...`。不要用文件名或标题当 ID。
- 时间一律 ISO 8601 带时区。
- 提交信息：`<package 或 app>: <做了什么>`，例如 `core: parse paper frontmatter`。

## 分工
- 后端（默认 Codex/GPT）：`packages/core`、`apps/cli`、`apps/hub`、`apps/runtime`。
- 前端（默认 Claude）：`packages/api-client`、`apps/web`、`apps/chrome-ext`、`apps/mobile`、`apps/feishu-bot`。
- `packages/schema`：由 Claude 起草，人类批准。
- 交叉 review：一方写的 PR 由另一方 review，争议点标出来交给人类。

## 完成一项任务时
在回复里列出：改了哪些 package/app、是否动了契约、新增了哪些依赖、怎么验证的。
