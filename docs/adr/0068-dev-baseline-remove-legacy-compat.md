# 0068 开发期基线：删除旧笔记工作模式与兼容层

- 状态：Proposed（等待人类批准）
- 日期：2026-11-16
- 领域：契约、存储格式与迁移、发布与升级兼容、模块边界
- 关联：ADR 0019、0024、0025、0027、0032、0049、0063、0067

## 背景

人确认：Lumio 仍在开发期，允许破坏性更新，设计面向长期；为兼容保留的旧路径可以全部重构。
现在契约里同一个概念常有两套：笔记版 Task/Project/Routine 与数据库版、`/v1` 与 `/v2` 接口、对象写法与字符串写法的负责人、
"某版本之前的数据缺失"的可选字段，以及一整套迁移、切换、退役命令。它们让每个新功能都要先判断"走哪条路"，C1 的契约缺口也部分源于此。

## 决定

### 1. 兼容策略（长期规则）

- **1.0 之前**：契约变更默认是破坏性的，代码里不保留旧格式的读取或升级分支。每次破坏性变更在 PR 里给出一次性处理办法
  （脚本，或"清空某个文件/目录重来"的说明），由人在本机执行；不写成 Hub 启动时自动运行的迁移。
- **只有两处长期保留兼容**，且写在契约里：
  1. Hub ↔ Runtime：Runtime 在远端机器上独立升级，Hub 接受当前与上一个正式版本的 Runtime，靠 Job 协议版本号判断；
  2. vault 手写宽容：frontmatter 的空值视为未填、宽松对象保留未知字段、`last4` 的数字补零。这是方便人手改文件，不是旧数据兼容。
- 新增"兼容旧……"的代码路径需要 ADR。

### 2. 删除旧笔记工作模式

- `entities.ts` 删除 `Project`、`Task`、`Routine`、`RunConfig`；`TASK_STATUSES` 移到 `work.ts`。`Entity` 只剩知识实体：
  `paper / idea / experiment / source / post / asset / ai-note`。`Idea.project`、`Experiment.project` 继续指向数据库项目 `prj_`。
- `common.ts` 删除 `AgentAssignee` 的 `{agent, device}` 对象写法、`Assignee`、`parseAssignee`、`AssigneeError`；负责人只有 `TaskAssignee` / `AgentTarget`。
- `operation.ts` 删除 `task.dispatch`、`routine.followup`。`Operation` 只剩 `exec.privileged`；`ProposalOperation` = `exec.privileged | work.command`。
- `storage.ts` 删除 `MigrationEntry`、`MigrationPlan`；`job.ts` 删除以 `NoteRef` 表示的 `RoutineInfo`；`knowledge-graph.ts` 删除 `include_legacy`。
- Hub / CLI 删除：`hub migrate plan|apply|retire|sources|source`、`hub migrate task-v3` 与启动时自动迁移、`hub switch --retire-legacy`、
  所有 `--legacy` 选项、`turn` 字段开关、笔记 AI 区块写回、旧格式笔记的删除例外。`docs/migration-v2.md` 与 `execution.md`"旧任务笔记兼容"一节删除。
- vault 中残留的 `type: task|project|routine` 文件不再是实体：索引跳过并在 `lumio check` 中列为"已不支持的旧工作笔记"，由人自行删除或移走，Lumio 不改动它们。

### 3. 接口只有一个命名空间

- 删除 `/v1` 的人与 agent 接口：`operations`、`proposals`、`notes`、`search`、`jobs`、`routines`、`runtimes`、`actors`、`check`、`status`，
  缺少 `/v2` 对应的补齐到模块路径下（如 `/v2/knowledge/search`、`/v2/system/status`）；`exec.privileged` 改走 `/v2/approval`。
- 配对接口（`client-invites`、`client/join`、`runtime-invites`、`runtime/join`、`runtime/signing-key`）移到 `/v2/setup/…`；桌面小助手仍在开发，同步改。
- Runtime 协议路径（`/v1/runtime/register|sync|ack|results|privileged`）本次不动，它们的版本由 Job 协议号表达；下次升级 Job 协议时一起改到 `/v2/runtime/…`。
  这样已部署的 Runtime 仍能自更新，不必到每台机器重装。

### 4. 去掉"旧数据缺失"的可选字段

- `WorkProject` / `WorkTask` 的 `created_by`、`updated_by` 改为必填；`plan.ts` 的 `done` 不再"缺省视为线性前缀"，改为必填。
- `query.ts` 中注明"旧 Hub 不返回"的字段改为必填；`RuntimeInfo.version`、`update` 等"旧执行器/旧 Hub 没有"的字段按第 1 节 Hub↔Runtime 规则处理：
  Runtime 发来的仍可选（上一版本没有），Hub 返回给客户端的一律必填；Runtime 登记"被旧 Hub 拒绝时去掉新字段重试"删除。
- `Base` 删除 `related` 相关说明；AI 笔记不再识别旧的纯 ID 文件名。
- `schema_version` 号不回退，只删除读取旧版本的代码：版本号单调递增，避免"同一个号两种格式"。

### 5. 发布与包结构

- 删除 `packages/core` 兼容转发包。
- 安装包删除 v0.1.x 的两个 shell 垫片与"两次 upgrade"流程；`lumio-hub`、`lumio-runtime` 兼容链接删除，服务文件直接调用 `lumio hub` / `lumio runtime`。
- 签名清单成为唯一升级来源，删除 0.2.3 之前接受 SHA256SUMS 的例外。

## 一次性处理

前提：人的日常实例（7420）已完成 v2 apply 或 retire，Task/Project/Routine 只在数据库里。批准前请人确认；若仍有旧笔记任务在用，先按现有 `migration-v2.md` 处理，再合入本 ADR。

- 数据库：提供一次性脚本，把缺失的 `created_by`/`updated_by` 填为该 Hub 唯一的 human 身份，把旧计划的 `done` 补全；运行前自动做业务备份。
- 服务文件：`lumio upgrade` 时改写为直接调用 `lumio`；远端 Runtime 照常自更新。
- vault：`lumio check` 列出旧工作笔记，人决定删除或移走。

## 实施切片

| 编号 | 内容 | 范围 |
|---|---|---|
| B0-1 | 契约：第 2、4 节的 schema 删改与契约测试；JSON Schema 重新导出 | `packages/schema` |
| B0-2 | 业务包与存储：删旧笔记路径、迁移、`packages/core`；一次性脚本 | `packages/*` |
| B0-3 | Hub、CLI、api-client：第 3 节接口收敛，删除 migrate/switch/legacy | `apps/hub`、`apps/cli`、`packages/api-client` |
| B0-4 | Web、桌面小助手改新路径；安装与发布（第 5 节） | `apps/web`、`apps/desktop`、发布脚本 |
| B0-5 | 文档：DESIGN.md 与各分册删去旧模式说明 | `docs/` |

B0-1 与 ADR 0067 的契约修改可以在同一个 PR 完成；C1-2 起依赖 B0-1。

## 后果

- 好处：每个概念只有一份契约；新功能不再判断走哪条路；测试与文档体积明显下降。
- 代价：失去从旧笔记模式导入的能力；旧版本程序不能读新数据，回退只能用升级前的业务备份；Runtime 协议路径的 `/v1` 暂时保留。

## 考虑过的替代方案

- 只为 C1 打补丁、兼容层以后再清：每个新切片都继续绕旧路径，越拖越难删。
- Runtime 协议也一起改到 `/v2`：要到每台执行器手动重装，收益只是路径好看。
- `schema_version` 全部重置为 1：会出现同一个号对应两种格式，排查旧备份时更容易误判。
