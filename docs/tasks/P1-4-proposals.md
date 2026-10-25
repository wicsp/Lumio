# P1-4 提议队列：AI 提议链接，人来接受或拒绝

- 负责：后端（Codex）　Review：Claude
- 相关 ADR：0007、0014（第 1、4、6、7 节）
- 涉及：`packages/core`、`apps/hub`、`packages/api-client`、`apps/cli`
- 契约：`packages/schema/src/proposal.ts`（已起草并经批准，**本任务不得修改**）
- 依赖：P1-3

## 目标
AI 发现两篇笔记应该关联时，只能提交一条提议；你看过理由后接受，Hub 才把链接写进笔记。
这是"AI 只能提议"（ADR 0014 第 1 节）第一次由程序强制执行。

## 用法
```
lumio propose link <from 引用> <to 引用> --reason "<理由>"     # agent 与 human 令牌都可用
lumio proposals [--status pending|accepted|rejected] [--json]  # 默认只列 pending
lumio proposals accept <提议ID>                               # 只有 human 令牌可用
lumio proposals reject <提议ID>                               # 只有 human 令牌可用
```
这些命令**只能在 Hub 模式下使用**（ADR 0014 第 7 节），未设置 `LUMIO_HUB_URL` 时报错并说明原因。

## 范围

### packages/core
1. **在 `related` 中追加一个 ID 的 frontmatter 编辑**：
   - `related` 不存在或为 `null` → 写成只含该 ID 的列表；已经是列表 → 在末尾追加；已经包含该 ID → 不写文件。
   - 支持块式（`- id`）与行内（`[a, b]`）两种写法，保持原有写法与其他字段不变；**正文逐字节不变**。
   - 写回仍使用带 `expectedContent` 的安全写入。`related` 不是列表（写坏了）时拒绝并报错，不修改文件。

### apps/hub
2. 提议存在 `hub.sqlite`。端点：
   - `POST /v1/proposals`：请求体 `NewProposal` → 返回 `Proposal`。校验 from、to 都能解析为**有 ID 的**笔记、
     from ≠ to、`to` 不在 from 的 `related` 中、不存在内容相同的 pending 提议；否则 400 或 409。
     `author` 取当前令牌的名称。
     **agent 令牌不能引用私密实体**（ADR 0012）：from 或 to 是私密笔记时，按"不存在"返回 400。
   - `GET /v1/proposals?status=…` → `Proposal[]`，按创建时间倒序。
   - `POST /v1/proposals/<id>/accept`、`/reject`：**agent 令牌返回 403**。只有 pending 的提议可以决定，否则 409。
     接受时执行第 1 条的写入，成功后才把状态改为 accepted；写入失败（如 `FILE_CHANGED`）时提议保持 pending，返回 409。
3. 接受后的写入同样会触发 P1-3 的文件监听，确认不会产生多余的处理或循环。

### packages/api-client、apps/cli
4. 实现上述命令；`--json` 输出 `Proposal` 或 `Proposal[]`，用 schema 校验。
5. 人类可读输出中，每条提议显示：ID、from 与 to 的标题、理由、提交者、时间。

## 不做
- 不支持链接以外的提议类型（标签、正文修改等以后再说）。
- 不做批量接受、通知（飞书通知在 P3）。
- 不允许删除提议；决定之后不可更改。

## 验收标准
1. `bun run check` 通过。
2. **权限**：agent 令牌可以提交和列出，接受、拒绝返回 403；human 令牌可以全部操作（测试逐一断言）。
3. 接受后 from 笔记的 `related` 增加该 ID，正文逐字节不变，其他 frontmatter 不变；块式与行内两种写法各一个用例。
4. 重复提议、自我链接、已存在的链接、引用到没有 ID 的笔记，都被拒绝且不写入。
5. 接受时文件被并发修改 → 提议仍为 pending、文件内容为人的版本。
6. 接受后 `lumio links` 能看到新链接（来源为 `related`）。
