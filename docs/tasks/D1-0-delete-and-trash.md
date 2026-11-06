# D1-0 删除与回收站

依据：[ADR 0038](../adr/0038-delete-and-trash.md)（**Proposed，人类批准后才能开始**）。
必读：`docs/DESIGN.md`、`docs/design/work.md`、`knowledge.md`、`assistant.md`、`security.md`、`web.md`。

## 目标

项目、任务、笔记、助手对话可以在 Web 上删除；删除即移入回收站，30 天内可恢复或彻底删除。

## 切片

| 编号 | 内容 | 负责 | 改动范围 |
|---|---|---|---|
| D1-1 | 契约：删除、回收站列表、恢复、彻底删除的请求与结果；`TRASHED` 错误码 | Claude 起草，人类批准 | `packages/schema` |
| D1-2 | 任务与项目的删除、恢复、彻底删除（含停止进行中的一轮、项目下任务置空与恢复挂回） | 后端（Codex） | `packages/work`、`apps/hub` |
| D1-3 | 笔记移入 `.trash/`、恢复、彻底删除，自动提交 | 后端（Codex） | `packages/knowledge`、`apps/hub` |
| D1-4 | 对话删除、恢复、彻底删除（先停止生成）；回收站汇总与 30 天到期清理 | 后端（Codex） | `packages/assistant`、`apps/hub` |
| D1-5 | Web：四处删除入口、确认框、撤销提示、「最近删除」页面 | 前端（Claude） | `packages/api-client`、`apps/web` |

D1-2 到 D1-4 依赖 D1-1；D1-5 依赖 D1-2 到 D1-4 的 Hub 接口。

## 后端验收要点（D1-2 到 D1-4）

- 每个写操作带 `request_id`，重复提交返回同一结果；任务、项目、笔记带 `expected_revision`，版本不符返回 `CONFLICT`。
- 删除正在执行的任务：同一事务里停掉这一轮（语义同 `work.task.finish outcome=cancelled`），再移入回收站；执行记录不删。
- 删除项目：其下任务 `project` 置空、revision 递增，回收站记录这些任务 ID；恢复时只挂回仍无项目的任务。
- 回收站中的对象不出现在任何列表、搜索、引用候选、相关推荐、概览、计数和助手工具结果中；按 ID 读取返回 `TRASHED`。
- 笔记移到 `.trash/<原相对路径>`，冲突加后缀；恢复到原路径，被占用时加后缀并在结果中返回实际路径。
- agent 身份调用一律 `FORBIDDEN`，不生成提议；这些操作不出现在 agent 能力目录与 `skills/lumio/SKILL.md`。
- 30 天到期清理在 Hub 内定期执行，可在测试中注入时间；彻底删除笔记时删除 `.trash/` 中的文件并提交。
- 测试只用 `fixtures/` 合成数据与临时目录，不读写真实 vault。

## Web 验收要点（D1-5）

- 任务、项目详情的「⋯」菜单里有「删除」；笔记详情有「删除」；对话列表每项悬停时有删除按钮。
- 确认框写清后果：进行中的一轮会被停止 / 项目下 N 个任务会变成无项目 / 30 天内可在「最近删除」恢复。
- 删除成功后显示带「撤销」的提示，撤销即恢复。
- 设置旁或侧栏底部提供「最近删除」：按时间倒序，可恢复、可彻底删除（二次确认）。
- 被删除的任务在依赖、父任务、执行记录中显示为「已删除」，点击不报错。

## 不做

- 批量删除、按项目整体删除（连同任务）、删除 Routine / 计划模板 / 记忆（记忆已有 `assistant.memory.forget`）。
- 删除 `life/` 私密内容或旧格式的 Task/Project/Routine 笔记。
- 让 agent 删除或提议删除任何东西。
