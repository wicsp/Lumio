# P1-5 按引用导出 BibTeX、断链检查、Hub 备份

- 负责：后端（Codex）　Review：Claude
- 相关 ADR：0018（链接写在正文、导出时从正文找引用、只发现断链）、0014（第 3 节备份、第 4 节链接解析）、0012（私密实体、AI 区块）
- 涉及：`packages/core`、`apps/cli`、`apps/hub`、`packages/api-client`
- 契约：`packages/schema/src/query.ts` 的 `CheckResult`（已批准，**本任务不得修改**）
- 依赖：P1-4

## 目标
三个小功能，把 P1 的数据侧收尾：
1. 写报告时，只为**这篇报告里引用到的论文**生成 BibTeX，而不是整个论文库。
2. 在 Obsidian 之外改名造成的断链，能一条命令全部列出来（ADR 0018：只发现，不修复）。
3. `hub.sqlite`（身份、令牌、提议、审计）无法从 vault 重建，需要能备份。

## 用法
```
lumio export bib --from <引用> [--out <路径>]     # 只导出该笔记引用到的论文；不给 --out 时输出到 stdout
lumio check [--include-private] [--json]           # 列出所有悬空链接
lumio-hub backup <目标文件>                          # 备份 hub.sqlite；目标已存在时拒绝
```

## 范围

### packages/core
1. **从一篇笔记里收集引用**：`collectCitations(root, reference, options)`。
   - 引用可以是 ID、citekey、文件名（与 `show` 相同的解析，重名时报错并列出候选）。
   - 来源两种：正文中的 `[[名称]]`（复用 P1-1 的链接解析：去掉 `|别名`、`#标题`，忽略代码块），
     以及正文中的 `\cite{a,b}`、`\citep{…}`、`\citet{…}`、`\parencite{…}`、`\textcite{…}`（可带 `[…]` 可选参数；
     逗号分隔多个 key，去掉空白）。代码块里的 `\cite` 也忽略。
   - 只保留解析到 **paper** 的引用，按 citekey 去重。指向其他类型的 `[[ ]]` 忽略，不报警告。
   - `\cite{key}` 找不到对应论文 → 警告"找不到 citekey：key"；`[[ ]]` 悬空不在这里报（由 `check` 负责）。
   - **AI 区块内的引用不计入**（ADR 0012、0018），但给出警告"AI 区块中有 N 处引用未计入"，提醒人确认。
   - **私密笔记**：被导出的笔记本身是私密的，或者引用解析到私密实体，都不导出（与 `export bib` 现有规则一致）。
2. **`exportBib` 支持只导出一组论文**：复用现有的 BibTeX 区块提取、key 纠正、排序与"内容未变就不写"的逻辑，
   输入从"所有论文"换成 `collectCitations` 的结果。缺少 BibTeX 区块的论文照常警告。
3. **列出悬空链接**：`checkLinks(root, options) → CheckResult`。
   - 来源：索引中所有 `resolved_path` 为空的链接（`wikilink` 与旧的 `related` 都算）。
   - 可见性与 `links` 相同：默认不列私密笔记里的链接；指向私密笔记的链接对非私密查询表现为悬空——
     **这种情况不要列入**，否则会泄露私密笔记的存在。即：只列"在可见范围内确实找不到目标"的链接。
   - 按 `from.path`、再按 `target` 排序。

### apps/cli
4. `lumio export bib --from <引用>`：没有 `--out` 时把 BibTeX 打印到 stdout，警告打到 stderr；有 `--out` 时与现有 `export bib` 相同（原子写入，未变化不重写）。
   不带 `--from` 时行为不变。`--from` 只支持本地模式（与现有 `export bib` 一致）。
5. `lumio check`：本地模式与 Hub 模式都支持，两种模式的 `--json` 输出逐字节相同（`CheckResult`）。
   人类可读输出：每行 `<来源笔记路径>  →  [[目标]]`；最后一行"共 N 条悬空链接"；没有时输出"没有悬空链接"。
   有悬空链接时退出码仍为 0（这是报告，不是错误）。

### apps/hub、packages/api-client
6. `GET /v1/check?include_private=…` → `CheckResult`。经 `authorize`，规则与 `links` 相同（agent 带 `include_private=true` 为 403）。
   api-client 增加 `check()`。
7. `lumio-hub backup <目标文件>`：用 SQLite 的 `VACUUM INTO` 生成一致的快照（Hub 运行中也可执行）。
   - 目标已存在 → 报错，不覆盖；目标所在目录不存在 → 报错。
   - 生成的文件权限 0600。只备份 `hub.sqlite`，不备份可重建的 `index.sqlite`。
   - 输出只打印目标路径，不打印任何令牌或哈希。

## 不做
- 不自动修复断链，不提供改名命令（以后由自己的客户端经 Hub 实现，ADR 0018）。
- 不改 `related` 的解析（仍计入链接图），不删除 `link.add`（P2 再删，ADR 0018）。
- 不做定时备份、不做备份恢复命令（恢复就是停 Hub 后把文件拷回去，写进 `infra/launchd/README.md` 一段说明即可）。

## 验收标准
1. `bun run check` 通过。
2. `export bib --from`（合成 vault，新增一篇报告式 fixture）：
   - `[[citekey]]`、`[[citekey|别名]]`、`\cite{a,b}`、`\citep[第3页]{c}` 都能收进来；重复引用只出现一次；按 citekey 排序。
   - 代码块和 AI 区块里的引用不计入，AI 区块给出数量警告；找不到的 `\cite` key 给出警告；指向想法等非论文的链接被忽略。
   - 私密笔记作为 `--from` 时不导出；引用到私密实体时不导出该条。
   - 输出到 stdout 时 stdout 只有 BibTeX；`--out` 连续运行两次文件不被重写。
3. `check`：
   - 改名一篇论文（不更新链接）后，所有指向旧名的 `[[ ]]` 都被列出；改回后列表为空。
   - 指向私密笔记的链接在不带 `--include-private` 时**不出现**；带上后若目标存在也不出现（它不是悬空）。
   - 本地与 Hub 模式 `--json` 逐字节相同，并通过 `CheckResult` 校验；agent 带 `include_private=true` 为 403。
4. `backup`：Hub 运行中执行备份，备份文件能被打开，身份、令牌（哈希）、提议、审计行数与原库相同；目标已存在时报错且原文件不变；
   输出与日志中不含令牌明文或哈希。
