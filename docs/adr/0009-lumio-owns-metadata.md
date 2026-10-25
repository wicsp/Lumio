# 0009 元数据由 Lumio 负责；统一的创建命令

- 状态：Accepted（部分实现：第 1、3、4、6 条已实现；第 2、5 条中由 Hub 自动补全和"程序字段"的部分尚未实现）
- 日期：2026-10-22
- 领域：数据

## 背景
手写 frontmatter 不现实：标题、作者、citekey、ULID、时间戳都容易出错或无法手写。
若改用 Obsidian 模板或 Templater 生成，会把 Lumio 的规则绑在 Obsidian 的插件上，
而且调用外部命令的 Obsidian 插件只能在桌面端运行，手机和 iPad 上不可用。

## 决定
1. **Obsidian 只是编辑器和阅读器。** 所有元数据（`id`、`type`、`created`、`updated`、
   默认值，以及论文的 citekey 与书目信息）都由 Lumio 生成，不依赖 Obsidian 的模板或插件。
2. **两种创建方式，结果完全一致：**
   - **显式创建**：通过 Lumio 的命令；以后再为飞书、快捷指令、网页提供 Hub 上的创建接口。
   - **随手写，自动补全**：在对应目录下直接新建普通 Markdown（可以不写 frontmatter），
     由 Lumio 补全缺失的元数据。P0 用 `lumio sync` 手动触发；P1 起由 Hub 监听文件变化自动完成。
3. **命令统一为"动词在前"**：
   ```
   lumio new paper <arXiv号 | DOI | 链接>
   lumio new idea  <标题>
   lumio sync
   ```
   以后新增命令沿用此规律（如 `lumio list papers`、`lumio export bib`）。
4. **统一的内部流水线**：输入 → 解析器（按类型）→ 补全器（所有类型共用）→ 校验 → 写文件。
   `new` 与 `sync` 共用同一个补全器，保证两种创建方式产生的元数据规则相同。
5. **补全规则**：
   - 类型由路径中的类型目录决定（`library/papers/` → paper，`research/ideas/` → idea，依此类推；
     完整映射见 ADR 0012，类型目录下可以有子文件夹）。
   - 标题缺失时取文件名；`created` 取文件创建时间；`id` 新生成。
   - 只补缺失的字段，**不覆盖**已有的值，**不改动正文与链接**（与 ADR 0014 第 1 节一致）。
   - **唯一的例外是"程序字段"**：由各类型的 schema 明确声明、归程序所有的字段（例如 post 的 target 发布结果、
     asset 自动续费后顺延的 `renews_on`，见 ADR 0012），程序可以更新已有的值。没有声明的字段一律不覆盖。
     这类更新属于修改性写入，必须经过 Hub（ADR 0007、ADR 0014 第 7 节）。
   - 无法自动补全的必填项（如论文的 citekey 缩写）不猜测，报告给人处理。
6. **Lumio 不依赖 Obsidian 模板**；笔记结构和元数据由 Lumio 在创建或补全时生成。`files/templates/`（ADR 0012）
   可以放你个人使用的模板，但模板里不要写 `id`、`created` 等元数据，留给 Lumio 补全。

## 范围
- P0：`lumio new paper`、`lumio new idea`、`lumio sync`。
- task、experiment 的创建留到 P2，与 Runtime 派活一起设计。

## 后果
- 好处：数据规则只存在于 Lumio 一处；手机上随手写的笔记无需任何插件即可纳入体系。
- 代价：手写的笔记在被补全之前，暂时不符合 schema；Lumio 需要能容忍并报告这种中间状态。

## 修订记录
- 2026-10-23：目录写法改为 ADR 0012 的新结构（批准：人类）
- 2026-10-23：增加"程序字段"例外（批准：人类）
- 2026-10-23：第 6 条改为"Lumio 不依赖 Obsidian 模板"，与 ADR 0012 的 `files/templates/` 一致（批准：人类）
- 2026-10-25：引用改为合并后的 ADR 0014（原 0006、0010、0011），内容不变（批准：人类）
