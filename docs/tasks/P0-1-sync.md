# P0-1 补全器与 `lumio sync`

- 负责：后端（Codex）　Review：Claude
- 相关 ADR：0004、0008、0009、0014
- 涉及：`packages/core`、`apps/cli`

## 目标
扫描 vault，为缺少元数据的笔记补全 `id`、`type`、`title`、`created`、`updated` 和默认值，
并报告无法自动补全的问题。这个切片同时建立 P0 后续切片共用的基础设施：
vault 定位、frontmatter 读写、ID 生成、补全器、安全写文件。

## 用法
```
lumio sync [--vault <路径>] [--dry-run]
```
- vault 路径的确定顺序：`--vault` 参数 > 环境变量 `LUMIO_VAULT`。两者都没有时报错退出，提示如何设置。
- `--dry-run`：只显示将要做的修改，不写任何文件。

## 范围

### packages/core
1. **`ids.ts`**：`newId(prefix, now: Date, random: (n: number) => Uint8Array): string`，生成
   `<前缀>_<ULID>`。ULID 自己实现（约 20 行，前 10 位毫秒时间戳 + 16 位随机数，Crockford Base32）；
   时间和随机源可注入，便于测试。生成结果必须通过 `@lumio/schema` 的 ID 校验。
2. **`vault.ts`**：
   - 目录到类型的映射：`papers/`→paper、`ideas/`→idea、`projects/`→project、`tasks/`→task、
     `experiments/`→experiment。只看 vault 根目录下这五个目录（含子目录）。
   - 遍历时跳过：隐藏文件和目录（以 `.` 开头，包括 `.obsidian`、`.trash`）、非 `.md` 文件。
   - 其他位置（vault 根目录、`templates/`、`reports/` 等）的文件一律不处理。
3. **`frontmatter.ts`**：把文件拆成 frontmatter 与正文，再写回。
   - 使用 `yaml` 包（eemeli/yaml）的 Document API。**本任务批准新增这一个依赖**，理由：需要在写回时
     保留原有的键顺序、注释和格式，`JSON.parse` 式的解析会丢失这些信息。
   - **正文必须逐字节保持不变。** 已有的 frontmatter 键保持原顺序和原值，新补的键追加在末尾。
   - 文件没有 frontmatter 时，新建一个。
   - frontmatter 不是合法 YAML 时：抛出带 `code` 的错误，调用方把它记为问题，**不修改该文件**。
4. **`fill.ts`**：补全器，纯函数，不碰文件系统：
   ```ts
   fillMetadata(input: {
     type: EntityType;           // 由目录决定
     frontmatter: Record<string, unknown>;
     fileName: string;           // 不含扩展名
     birthtime: Date; mtime: Date;
   }, ctx: { now: Date; newId: (prefix) => string; tz: string }): {
     patch: Record<string, unknown>;   // 需要新增的键，已有的键绝不出现在这里
     issues: Issue[];                  // 补全后仍不满足 schema 的问题
   }
   ```
   补全规则（ADR 0009 第 5 条）：
   - **"缺失"一律包括值为 `null` 的情况**（ADR 0008：空值视为未填写）。下面每条规则都适用，
     不只是 `id`。frontmatter 写回时，原本为 `null` 的键在原位置被替换，不追加重复的键。
     空字符串 `""` 不算缺失，按原值校验。
   - `type`：缺失时填目录对应的类型。**已有但与目录不一致时，不改，记为问题。**
   - `id`：缺失（或为 null，ADR 0008）时生成对应前缀的新 ID。
   - `title`：缺失时取文件名。
   - `created`：缺失时取文件创建时间（birthtime；无效或为 0 时退回 mtime）。
   - `updated`：缺失时取 mtime。
   - 时间格式：带时区偏移的 ISO 8601，使用本机时区，精确到秒，例如 `2026-10-22T21:20:00+08:00`。
   - 带默认值的字段（`status`、`tags`、`related` 等）**不写入文件**，由 schema 在读取时补默认值。
   - 补全后用 `@lumio/schema` 对应实体校验，把剩余错误转成 `issues`。论文缺少 `citekey`、
     `authors`、`year` 等无法推断的必填项属于这一类：**报告，不猜测**。
   - 论文特例：`citekey` 缺失、且文件名符合 citekey 格式时，用文件名作为 `citekey`。
5. **`write.ts`**：安全写文件：写入同目录下的临时文件，再 rename 覆盖。内容没有变化时不写。
   **写回前必须确认文件在处理期间没有被修改**：调用方传入最初读到的内容，rename 之前重新读取
   目标文件并比较，不同则放弃写入，报告"文件在处理中被修改，请重新运行"（计为"跳过"）。
   vault 在 iCloud 中、Obsidian 常开，人和同步进程随时可能修改文件。
6. 错误：库代码只抛出带 `code` 字段的错误类，不打印、不退出。

### apps/cli
7. 命令解析使用 Node 内置的 `util.parseArgs`，**不引入命令行框架**。
8. `lumio sync`：遍历 vault → 对每个文件调用补全器 → 写回（非 dry-run 时）→ 输出汇总。
9. 输出格式（每个有变化或有问题的文件一行，最后一行汇总）：
   ```
   补全  ideas/新的想法.md          +id +type +created +updated
   问题  papers/Foo.md              citekey: 缺失，且文件名不是合法 citekey
   跳过  ideas/坏文件.md            frontmatter 不是合法 YAML
   完成：扫描 12 个，补全 3 个，问题 1 个，跳过 1 个
   ```
10. 退出码：没有问题和跳过时为 0；否则为 1。

## 不做
- 不处理 `reports/`（schema 里还没有 report 实体）。
- 不修改任何已有字段的值；不改正文；不改链接。
- 不联网。不实现 Hub、文件监听、配置文件。
- 不生成 `refs.bib`。

## 验收标准
1. `bun run check` 通过。
2. `packages/core` 有单元测试覆盖：ULID 格式与时间顺序；补全器的每条规则，包括"已有值不覆盖"和
   "type 与目录不一致只报告"；frontmatter 读写时正文逐字节不变、已有键顺序与注释保留；
   非法 YAML 抛出带 code 的错误。
3. `apps/cli` 有集成测试：在临时目录里用 `fixtures/` 中的合成 vault 运行 `sync`，检查输出、
   退出码和写回结果。fixture 至少包含：无 frontmatter 的想法、缺 id 的想法、完整合法的论文、
   缺 citekey 的论文、非法 YAML 的文件、`.obsidian/` 下的 `.md` 文件（必须被忽略）。
4. **幂等**：对同一个 vault 连续运行两次，第二次输出"补全 0 个"，且没有任何文件被写入。
5. `--dry-run` 不修改任何文件（测试中比较运行前后的文件内容和修改时间）。
6. 测试不读写真实 vault（AGENTS 第 6 条）。
