# AGENTS.md — 所有 AI 共用的规则

本文件对 Claude Code、Codex 等所有编码 agent 生效。`CLAUDE.md` 只是引用本文件。

## 必读
开始任何任务前先读 `docs/DESIGN.md`（现行设计总览）、你的任务说明，以及任务说明里列出的 `docs/design/` 分册。
**不需要读 `docs/adr/`**：ADR 只记录决定的原因，想知道某条规则为什么这样定时，再按设计文档中标注的编号去查。
修改设计时，ADR 与设计文档要在同一个 PR 里一起改（ADR 0015）。
**只为架构级决定写 ADR**（契约与协议、模块边界、权限与安全、存储格式与迁移、发布与升级兼容、否决过的重要方案）；
小功能、界面改动、修 bug 不写 ADR，没有争议的规则变化直接改设计文档并标任务或 PR 编号（ADR 0036，判断方法见 `docs/DESIGN.md` 第 5 节）。

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
8. **提交前必须通过 `bun run check`**。功能分支从最新的 `origin/main` 开，按功能提 PR。
   合入 `main` 的关卡：本地 `bun run check` 通过；Lumio 交接计划或人安排了 review 时，还要 review 通过（review 者不是作者）。
   CI 不挡合并：合并后在 `main` 上运行，失败时由合并者修复或撤回（revert）该 PR（PR #188）。
   人类验收在合并后的 `main` 上进行；正式发布从 `main` 上已验收的提交打 `v*` 标签。本机部署方法见 [主线开发与本机部署](docs/local-deployment.md)。
9. **按交代做；没交代后续时走默认流程。**（ADR 0049）由谁 review、何时合并与部署，以 Lumio 交接计划或人的安排为准。
   - 任务说明或 Lumio 阶段说明交代了什么就做什么。
   - 人直接交代改动、没有交代后续时，默认：推 PR → 立即合并 → 在运行日常实例的机器（macsp）上从 `main` 部署 7420 → 汇报 → 留意 `main` 上这次合并的 CI。
     不在这台机器上时只合并，并在汇报里说明需要部署。**不自行找其他 agent review。**
   - **Claude Code、Codex 和其他 agent 部署、重部署或回退日常实例 7420，一律使用仓库的 `bun run scripts/deploy-local.ts`。** 回退代码时先把修复或 revert 合入 `main`，再运行同一脚本。
     不得用单个 app 的构建产物替换安装，也不得把任何构建直接输出或复制到 `~/.local/bin/lumio`、`lumio-hub` 或 `lumio-runtime`。脚本负责完整构建、备份、原子替换、Hub 重启和验收；只要求 Hub 空闲，Runtime 通过 `self_update` 自行等空闲更新，脚本不重启 Runtime（U1-5）。
   - `main` 上的 CI 失败时：能很快修好就直接修；修不好就 revert 该 PR、重新部署，并在汇报里说明。会话结束前 CI 还没出结果时，在汇报里说明。
   - 以下情况停下交回人，不合并：改动含数据迁移（撤回代码救不回已迁移的数据）、需要改契约（第 1 条）、交代了先别合并。
   - 缺权限时按需申请，说明要什么、为什么，等人批准（申请方式见 Lumio skill 与每一轮的说明）；不绕过执行环境的限制。
10. **同一个工作树同一时间只允许一个会话写入；独立 worktree 和独立分支允许并行开发与测试。**（V0-0）
   - 开始前检查工作树、分支、`git status` 与已有 worktree；用 `git fetch` 更新远端引用，从明确的已提交版本开始。
     只检查并要求自己要使用的工作树干净，不要求其他 worktree 干净。主工作树有人工作时，使用独立 worktree。
   - 不覆盖、暂存、提交、清理或搬移其他会话的改动；不在其他会话的工作树中 pull、切分支或执行 reset/clean。
     不把其他会话未提交的改动带入新 worktree。确实依赖那些改动、或无法隔离共享资源时，停下来告诉人类。
   - 每个会话使用自己的分支，测试的临时目录、数据库、端口与客户端状态目录（如 `CODEX_HOME`）相互隔离；
     不因使用 worktree 就读写真实 vault、全局客户端配置或正在运行的 Lumio 业务数据。
   - 部署、服务重启、发布、共享 Git 配置修改等共享操作必须串行协调；不影响其他会话的普通开发和隔离测试可并行。
   - 结束时通过必要检查，提交并推送自己的改动，不留下未提交内容；worktree 不再需要时安全归档，不清理其他会话的工作树。

## 约定
- TypeScript strict，ESM；测试用 `bun test`。
- **Bun 版本固定为 1.4.4**（以 `package.json` 的 `packageManager` 为准），开发、测试、CI、发布与人类的 Nix 环境保持一致。
  `bun.lock` 必须用该版本生成，CI 和发布通过 `bun-version-file: package.json` 读取同一版本。
  升级 Bun 需要人类决定，并同时更新 Nix 环境；本次 1.4 升级已于 2026-11-08 获人类批准。
- 包内互相引用用 `.ts` 扩展名；跨包只通过包名（`@lumio/schema`）引用，不写相对路径。
- 库代码抛出带 `code` 的错误类；只有 `apps/*` 负责打印和设置退出码。
- ID 格式：`<前缀>_<ULID>`，例如 `pap_01J...`。不要用文件名或标题当 ID。
- 时间一律 ISO 8601 带时区。
- 提交信息：`<package 或 app>: <做了什么>`，例如 `core: parse paper frontmatter`。

## 分工
- 后端（默认 Codex/GPT）：`packages/core`、`apps/cli`、`apps/hub`、`apps/runtime`。
- 前端（默认 Claude）：`packages/api-client`、`apps/web`、`apps/chrome-ext`、`apps/mobile`、`apps/feishu-bot`。
- `packages/schema`：由 Claude 起草，人类批准。
- 以上是作者习惯的默认分工，**不是**委派规则：实际由谁实现、由谁 review 以 Lumio 交接计划或人类的安排为准（ADR 0049）。
- review 时：争议点标出来交给人类。

## 完成一项任务时
在回复里列出：改了哪些 package/app、是否动了契约、新增了哪些依赖、怎么验证的。
