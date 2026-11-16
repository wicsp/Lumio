# B0-0 开发期基线：补齐 C1 契约，删除旧笔记模式与兼容层

依据：[ADR 0068](../adr/0068-dev-baseline-remove-legacy-compat.md)、[ADR 0067](../adr/0067-glance-storage-contract-completion.md)（均 Accepted，2026-11-16 人类批准）。
必读：`docs/DESIGN.md`、`docs/design/work.md`、`execution.md`、`hub.md`、`knowledge.md`；B0-1 另读 `packages/schema/src/` 全部相关文件。

## 目标

每个概念只有一份契约。删掉旧笔记版 Task/Project/Routine、显式迁移与切换、`/v1` 的人与 agent 接口、"旧数据缺失"的可选字段与旧安装垫片；
同时按 ADR 0067 补齐所见入库所需的契约，让 C1-2 起可以继续。

**允许破坏性修改，不写旧格式读取或自动迁移。** 不新增依赖。

## 前提核实（B0-2 开始前）

日常实例 7420 必须已完成 v2 apply 或 retire。用 `lumio doctor` 或迁移回执核实（只读，不改业务数据）。
仍有旧笔记任务在用、或无法确认时：停下交回人，不继续 B0-2 之后的切片。

## 切片

| 编号 | 内容 | 范围 | 依赖 |
|---|---|---|---|
| B0-1 | 契约：ADR 0067 全部 + ADR 0068 第 2、4 节的 schema 删改；契约测试；`bun run schema:export` | `packages/schema` 及编译所需的连带修改 | — |
| B0-2 | 业务包与存储：删旧笔记工作路径、迁移、`packages/core`；Storage 支持 `ArtifactOwner` 与 hub→knowledge 归属转移；一次性数据脚本 | `packages/*`、`scripts/` | B0-1 |
| B0-3 | Hub / CLI / api-client：`/v1` 人与 agent 接口收敛到 `/v2`，配对移到 `/v2/setup/…`；删 migrate、switch、`--legacy`、task-v3 自动迁移 | `apps/hub`、`apps/cli`、`packages/api-client` | B0-2 |
| B0-4 | Runtime 改用新的高权限申请路径；Web、桌面小助手改新路径；安装与发布去掉垫片、兼容链接与 SHA256SUMS 例外 | `apps/runtime`、`apps/web`、`apps/desktop`、发布脚本 | B0-3 |
| B0-5 | 文档：DESIGN.md 与各分册删去旧模式说明，`migration-v2.md` 删除，DESIGN.md 顶部"开发期基线"提示改为已实施 | `docs/` | B0-4 |

每个切片一个 PR。B0-1 与 B0-2 若拆开会导致 `bun run check` 不过，可以合成一个 PR，但提交按切片分开。

## B0-1 契约细节

- `entities.ts`：`SOURCE_KINDS = ["web","video","podcast","course","book","text"]`，`Source.kind` 用它；删除 `Project`、`Task`、`Routine`、`RunConfig`；`TASK_STATUSES` 移到 `work.ts`；`Entity` 只剩知识实体。
- `inbox.ts`：`CaptureKind = z.enum(["paper", ...SOURCE_KINDS])`；`OriginalFrontmatter` 加可选严格对象 `glance: { id: gln_, app: GlanceApp, window?: ≤GLANCE_LIMITS.max_window_title_chars, screenshot?: art_, pointing: GlancePointing.method }`。
  注意 `glance.ts` 现在从 `work.ts` 引入 ResourceRef，`inbox.ts` 引入 glance 类型时避免循环引用（必要时把 `GlanceApp`、`GlancePointing` 放到无依赖的位置）。
- `storage.ts`：`HubRef = { module: "hub", id: cap_ | gln_ }`，`ArtifactOwner = ResourceRef | HubRef`，`StoredArtifact.owner` 用它；删除 `MigrationEntry`、`MigrationPlan`。
- `common.ts`：删除 `AgentAssignee` 对象写法、`Assignee`、`parseAssignee`、`AssigneeError`。
- `operation.ts`：`Operation` 只剩 `exec.privileged`；`ProposalOperation = exec.privileged | work.command`。
- `job.ts` 删除 NoteRef 版 `RoutineInfo`；`knowledge-graph.ts` 删除 `include_legacy`。
- 改必填：`WorkProject` / `WorkTask` 的 `created_by`、`updated_by`；`plan.ts` 的 `done`；`query.ts` 中"旧 Hub 不返回"的字段；Hub 返回给客户端的 Runtime 版本与更新字段。
  Runtime 发给 Hub 的新字段按 ADR 0068 第 1 节仍可选（Hub 接受上一个正式版本的 Runtime）。
- `schema_version` 号不回退，只删读取旧版本的代码。
- 契约测试：ADR 0067"验证"一节所列；删除的类型与操作被拒绝；改必填的字段缺失时被拒绝。

## B0-2 细节

- Storage：托管文件表已按 `owner_module/owner_id` 存，`hub` 归属不需要改表；新增归属转移（只允许 hub → knowledge，同事务校验目标存在且属于同一 human）。
  业务备份与恢复覆盖 knowledge 与 hub 归属的文件。
- 一次性脚本 `scripts/b0-baseline.ts`：先做业务备份并验证，再把缺失的 `created_by` / `updated_by` 填为该 Hub 唯一的 human 身份、补全旧计划的 `done`；可重复运行；用合成数据测试。
  **只由人在日常实例上执行，agent 不代为运行。**
- vault 中 `type: task|project|routine` 的文件：索引跳过，`lumio check` 列为"已不支持的旧工作笔记"，不改动文件。

## B0-3 细节

- 删除的 `/v1` 接口逐一列出 `/v2` 对应（缺的补上，例如 `/v2/knowledge/search`、`/v2/system/status`），写进 PR 描述。
- Runtime 协议路径 `/v1/runtime/register|sync|ack|results|privileged…` **不动**（ADR 0068 第 3 节）。`exec.privileged` 的提交从 `/v1/operations` 改到 `/v2/approval/…`，
  Hub 在一个正式版本内同时接受旧路径的 `exec.privileged`，以免未升级的 Runtime 失去高权限申请；这是 Hub↔Runtime 版本差兼容，不是旧数据兼容。

## 验收

- 每个切片 `bun run check` 通过；`grep` 不再出现被删除的类型、命令与 `/v1` 人/agent 路径（Runtime 协议路径除外）。
- 合成数据：所见截图上传 → 存成资料后归属为 knowledge → 随资料删除、恢复 → 业务备份含该文件；只用于对话的截图到期清理；agent / runtime 读取被拒。
- 含数据脚本与改必填字段的 PR（B0-1/B0-2）按 AGENTS.md 第 9 条属于数据迁移：推 PR 后**停下交回人，不合并、不部署**，在汇报里写明人要执行的命令。
  人运行 `scripts/b0-baseline.ts` 并确认后，再合并并用 `bun run scripts/deploy-local.ts` 部署；B0-3 起按第 9 条默认流程。
