# P1-3 文件监听、自动补全与自动提交

- 负责：后端（Codex）　Review：Claude
- 相关 ADR：0007、0009、0014（第 3、8 节）、0012（目录、卡号防护）
- 涉及：`packages/core`、`apps/hub`、`apps/cli`
- 依赖：P1-2

## 目标
Hub 运行时，你在 Obsidian（包括 iPad、手机经 iCloud 同步到 Mac）里新建或修改的笔记，几秒内被自动补全元数据并更新索引；
vault 安静一段时间后自动提交到 git。不再需要手动运行 `lumio sync`。

## 范围

### packages/core
1. **把 sync 的单文件逻辑移入 core**。目前 `apps/cli/src/sync.ts` 中的"读取 → 补全 → 安全写回"
   是 CLI 私有的，Hub 不能 import 另一个 app（依赖规则）。提取为 `syncFile(vault, path, ctx)` 与
   `syncVault(vault, ctx)`，CLI 与 Hub 共用。**行为不变**，现有 sync 测试应在移动后原样通过。
2. **vault 的 git 操作**（`git.ts`）：通过子进程调用 `git`（不引入 git 库），用 vault 根目录的 `.git`
   指针文件定位仓库（支持指向同步目录之外的 gitdir，ADR 0007）。
   提供：是否是仓库、列出有改动的文件、按路径 `add`、`commit`。vault 不是仓库或没有安装 git 时返回"不可用"，不抛错。

### apps/hub
3. **监听**：用 `fs.watch(vault, { recursive: true })`。
   - 只处理 `VAULT_LAYOUT` 中各类型目录下的 `.md` 文件（P0-6），跳过 Excalidraw 文件（复用 `scanVault` 的判定）；
     忽略隐藏文件和目录、iCloud 占位文件（`.icloud` 结尾）、我们自己的临时文件（`.<名称>.<uuid>.tmp`）。
   - 同一文件 2 秒内的多次事件合并为一次（防抖）。
   - 处理流程：`syncFile` → 更新索引。Hub 自己写回触发的事件，第二次处理时补全结果为空，不会循环（需测试证明）。
   - 遇到 `FILE_CHANGED`（文件在处理中被修改）时，等下一次事件再处理，不报错。
4. **启动时全量处理**：先 `syncVault` 一次并更新索引，再开始监听（ADR 0014 第 8 节）。
5. **自动提交**：最后一次文件变化后 `LUMIO_AUTOSAVE_IDLE`（默认 300 秒）无新变化时提交一次，
   信息为 `lumio: auto-save <N> files`。git 不可用时只在启动时记一条日志，之后静默跳过。
   提交失败（例如 git 锁文件存在）时记日志，下一个周期重试。
   **提交前检查疑似卡号**（ADR 0012）：对每个待提交的文件读取原始文本，用 `textContainsCardNumber` 检查，
   命中的文件**不加入本次提交**（逐个 `git add <路径>`，不用 `git add -A`），并记入状态中的问题列表（只给路径）。
   这条检查覆盖 vault 中所有待提交的文件，不限于 asset。
6. **状态端点**：`GET /v1/status`（需认证）返回：监听是否正常、上次全量处理时间、待提交的文件数、最近 20 条问题
   （与 `sync` 输出的"问题""跳过"相同的内容）。响应结构在本任务中先用 TS 类型定义在 `apps/hub` 内部，
   不进入 `packages/schema`（P1 之后再决定是否稳定下来）。

### apps/cli
7. `lumio sync` 改为调用 core 的 `syncVault`，输出不变。
8. 新增 `lumio hub status`：设置了 `LUMIO_HUB_URL` 时调用 `/v1/status` 并打印。

## 不做
- 不处理 vault 之外的目录；不监听 `files/`、`research/reports/`（不在 `VAULT_LAYOUT` 中）。
- 不做冲突合并：人与 Hub 同时改同一文件时，以人的修改为准（已有的 `FILE_CHANGED` 机制）。
- 不推送到远端仓库（`git push`）。

## 验收标准
1. `bun run check` 通过；移动后的 sync 测试全部原样通过。
2. 测试（临时 vault + 临时 git 仓库，gitdir 放在 vault 之外）：
   - 新建一个没有 frontmatter 的 `research/ideas/x.md` → 几秒内被补全，且只被写一次。
   - 快速连续写同一文件 5 次 → 只处理一次（可通过注入的计数器断言）。
   - 隐藏文件、`.icloud` 文件、Excalidraw 文件、`files/` 中的文件不触发处理。
   - 含疑似卡号的文件不进入提交，其余文件照常提交；日志和状态里不出现该数字。
   - Hub 自身的写回不导致无限循环。
   - 用注入的时钟验证：空闲时间到达后提交一次；期间有新变化则重新计时；没有 git 仓库时不报错。
3. 启动时的全量处理覆盖 Hub 未运行期间新增的文件。
4. 在 macOS 上用真实 iCloud vault 手动验证一次（人类执行）：iPad 上新建笔记 → Mac 上几秒内被补全 → iPad 上看到补全后的 frontmatter。
   在 PR 描述中写出验证步骤。
