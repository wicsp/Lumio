# P1-4 操作与提议：AI 请求加链接，人来接受或拒绝

- 负责：后端（Codex）　Review：Claude
- 相关 ADR：0007、0014（第 1、4、6、7 节）、0016（操作、授权、提议、审计）
- 涉及：`packages/core`、`apps/hub`、`packages/api-client`、`apps/cli`
- 契约：`packages/schema/src/operation.ts`、`proposal.ts`、`api.ts`（已批准，**本任务不得修改**）
- 依赖：P1-3

## 目标
程序对 vault 的修改第一次走统一的"操作"入口（ADR 0016）。AI 想给两篇笔记加链接时，请求一个 `link.add` 操作，
Hub 判定"需要批准"并生成提议；你看过理由后接受，Hub 才执行这个操作。你自己请求同样的操作时立即执行。
这是"AI 只能提议"（ADR 0014 第 1 节）第一次由程序强制执行。

## 用法
```
lumio link add <from 引用> <to 引用> [--reason "<理由>"]      # human：立即执行；agent：生成提议，--reason 必填
lumio propose link <from 引用> <to 引用> --reason "<理由>"     # 同上，给 AI 和 skill 用的别名
lumio proposals [--status pending|accepted|rejected] [--json]  # 默认只列 pending
lumio proposals accept <提议ID>                               # 只有 human 可用
lumio proposals reject <提议ID>                               # 只有 human 可用
```
这些命令**只能在 Hub 模式下使用**（ADR 0014 第 7 节），未设置 `LUMIO_HUB_URL` 时报错并说明原因。

## 范围

### packages/core
1. **在 `related` 中追加一个 ID 的 frontmatter 编辑**：
   - `related` 不存在或为 `null` → 写成只含该 ID 的列表；已经是列表 → 在末尾追加；已经包含该 ID → 不写文件。
   - 支持块式（`- id`）与行内（`[a, b]`）两种写法，保持原有写法与其他字段不变；**正文逐字节不变**。
   - 写回仍使用带 `expectedContent` 的安全写入。`related` 不是列表（写坏了）时拒绝并报错，不修改文件。
2. **git 提交带 trailer**：P1-3 的 `git.ts` 增加带 trailer 的 `commit`（`Lumio-Actor`、`Lumio-Proposal`、`Lumio-Approved-By`）。

### apps/hub
3. **操作入口** `POST /v1/operations`：请求体 `OperationRequest`。
   - 先校验操作本身：from、to 都能解析为**有 ID 的**笔记、from ≠ to、`to` 不在 from 的 `related` 中；否则 400 `INVALID`。
     agent 引用私密实体时按"不存在"返回 400（ADR 0012）。
   - 再调用 P1-2 的 `authorize`。P1 规则：`human` 对 `link.add` 为 `allow`；`agent` 为 `needs_approval`。
   - `allow` → 执行，返回 200 `OperationResult { status: "applied" }`。
   - `needs_approval` → 没有 `reason` 时 400；已有内容相同的 pending 提议时 409（`ApiError.proposal` 指向它）；
     否则生成提议（`author` 为当前身份 ID），返回 **202** `OperationResult { status: "pending_approval" }`。
   - `deny` → 403 `FORBIDDEN`，带 `operation` 与 `reason`。
4. **执行操作**（立即执行和接受提议共用一个函数）：
   - 目标文件有尚未提交的修改时，先把它作为一次普通的自动保存提交；git 不可用时跳过所有提交，只执行写入。
   - 执行第 1 条的写入，然后**立即提交这一个文件**，信息形如 `lumio: link.add <from 标题> → <to 标题>`，带 trailer
     `Lumio-Actor: <执行者身份 ID>`；经提议执行时再加 `Lumio-Proposal: <提议ID>`、`Lumio-Approved-By: <批准者身份 ID>`。
     经提议执行时，`Lumio-Actor` 是提议的作者。
   - 提交前同样做卡号检查（P1-3）。
5. **提议**存在 `hub.sqlite`：
   - `GET /v1/proposals?status=…` → `Proposal[]`，按创建时间倒序。agent 只能看到自己提交的提议。
   - `POST /v1/proposals/<id>/accept`、`/reject`：经 `authorize`，**agent 为 `deny`**（403，`reason: agent-cannot-decide-proposals`）。
     只有 pending 的提议可以决定，否则 409。接受时**原样执行提议里存的操作**，成功后才改为 accepted；
     写入失败（如 `FILE_CHANGED`）时提议保持 pending，返回 409。
6. **审计**：每次操作请求、每次决定提议，都按 ADR 0016 第 5 节写入审计表。
7. 执行后的写入同样会触发 P1-3 的文件监听，确认不会产生多余的处理或循环，也不会被自动保存再提交一次。

### packages/api-client、apps/cli
8. 实现上述命令；`--json` 输出 `OperationResult`、`Proposal` 或 `Proposal[]`，用 schema 校验。
   出错时 `--json` 输出 `ApiError`（退出码非 0），让 AI 能读到被拒绝的操作和原因。
9. 人类可读输出中，每条提议显示：ID、from 与 to 的标题、理由、提交者名称、时间。`pending_approval` 时提示
   "已提交提议 <ID>，等待批准"。

## 不做
- 不支持 `link.add` 以外的操作（以后加操作要改契约）。
- 不做权限规则配置、身份的停用与过期、批量接受、通知（飞书通知在 P3）。
- 不允许删除提议；决定之后不可更改。

## 验收标准
1. `bun run check` 通过。
2. **授权**：human 请求 `link.add` → 200 并已写入；agent 请求 → 202 并生成提议、文件不变；agent 接受或拒绝 → 403
   且错误带 `operation` 与 `reason`；human 可以接受、拒绝（测试逐一断言）。
3. 接受后 from 笔记的 `related` 增加该 ID，正文逐字节不变，其他 frontmatter 不变；块式与行内两种写法各一个用例。
4. 重复提议、自我链接、已存在的链接、引用到没有 ID 的笔记，都被拒绝且不写入。
5. 接受时文件被并发修改 → 提议仍为 pending、文件内容为人的版本。
6. 接受后 `lumio links` 能看到新链接（来源为 `related`）。
7. **git**（临时仓库）：经提议执行后的提交只含该文件，trailer 中的三个身份/提议 ID 正确；目标文件原有的未提交修改
   在前一个自动保存提交里，不在操作提交里。
8. 审计表中能查到 agent 的请求（needs_approval）、human 的接受（allow）以及执行结果，记录的都是身份 ID。
