# 0064 统一敏感信息审查

- 状态：Accepted
- 日期：2026-11-12
- 领域：安全、知识、执行、契约
- 关联：[ADR 0012](0012-vault-layout-sources-posts-assets.md) 的卡号防护、[ADR 0019](0019-hub-runtimes-tasks-rounds.md) 的汇报写回、[ADR 0057](0057-inbox-and-captured-sources.md) 的资料抓取

## 背景

arXiv 2507.16731v1 的全文下载与提取成功。LaTeXML 生成的作者 ORCID 链接和提示文字带有四组数字，其中有编号恰好也通过 Luhn 校验。Inbox 把整份原文判为敏感内容，返回 `extract_failed`。相同的判断也能使正常文件搜不到，或让下一轮执行缺失上轮汇报。

代码中有多套凭据正则。Hub、Work、CLI、Execution 与离线迁移对同一文本可能给出不同结果。卡号检测虽然复用同一个函数，调用方仍独立决定失败、隐藏、跳过或替换。

## 决定

- 把基于文本形状推测卡号或密钥的检测集中到一个独立的敏感信息审查功能。第一版由已授权的人按需运行，对其可读的内容做本地只读扫描，复用同一套规则。报告展示资源、位置与原因，省略命中的原始值。审查不调用模型，不保存扫描到的内容，也不修改原文件。
- 从日常捕获、编辑、保存、索引、读取、导出、提交、迁移和执行交接移除各自的敏感文本正则以及由它们产生的静默截断和失败。移除 `Asset` 契约中的内容推断，保留其字段格式和私密访问规则。具体审查入口与契约在实现前确认。
- 继续在凭据注入和使用处按已知的实际值脱敏，包括 Runtime 注入的轮次令牌和阶段密钥。访问控制、私密可见性、抓取地址约束、文件完整性和协议校验继续由对应边界执行。
- 审查是显式操作。原先靠猜测触发的拦截取消后，普通内容中误放的真实秘密可能随原有流程进入 Git、模型输入或执行上下文。审查发现的问题由用户处理。

## 已核对的入口

| 入口 | 当前影响 |
| --- | --- |
| Hub Inbox（`inbox.ts`、`inbox-files.ts`） | 捕获请求被拒绝，下载成功后整篇提取被标失败，或原文已有但摘要失败。 |
| Hub 知识写入（`knowledge-authoring.ts`、`knowledge-editing.ts`、`ai-notes.ts`） | 论文元数据解析、手动编辑、AI 笔记保存可能失败。 |
| Storage（`knowledge/index/store.ts`、`knowledge/originals.ts`、`knowledge/export-bib.ts`） | 笔记和原文可能从索引消失，原文读取可能返回未找到，BibTeX 导出可能跳过整篇论文。 |
| Hub 和 Storage 的 Git 路径（`watch.ts`、`commit.ts`、`knowledge/trash.ts`） | 自动提交、编辑写回、回收站相关提交可能遗漏文件。 |
| Work、Hub、Execution、CLI（`work/src/index.ts`、`hub/src/tasks.ts`、`hub/src/routines.ts`、`execution/src/routines.ts`、`cli/src/execution-routines.ts`） | 任务或例行任务汇报被替换成占位说明，上一轮汇报或引用标签可能从下一轮输入里消失。 |
| Hub（`notices.ts`、`decision-gate.ts`） | 通知标题或摘要可能丢失，事件分级可能回退。 |
| Schema 和 Storage（`schema/src/entities.ts`、`storage/src/migration.ts`） | 资产 frontmatter 校验失败，旧任务的迁移计划产生阻塞项。 |

## 实施与验证

- 在同一次切换中移除各业务入口的猜测式拦截并启用独立审查。改动涉及多个 app 和 package，包含 `packages/schema` 的验证行为，按契约变更流程执行。
- 兼容既有数据。发布时从现有文件重建派生索引，使被旧规则排除的文件重新出现，即使文件的大小和修改时间未变。既有失败捕获可使用 Inbox 的重试。已经被占位符替换的历史汇报按原 Job 引用查看。
- 用合成资料验证带 ORCID 的 arXiv 全文、原文检索、编辑与导出、任务交接、通知和迁移计划。验证独立审查仍报告合成卡号和密钥，Runtime 日志仍隐藏注入的实际凭据，且越权访问继续被拒绝。

## 修订记录

- 2026-11-12：人类批准原提案 ADR 0063。因主线已将 0063 用于执行器更新，编号顺延为 0064。
