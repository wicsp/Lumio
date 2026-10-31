# R0-6 JSONL、托管文件与业务备份

- 依据：ADR 0025 第 3、5、6、8 节；已批准的 RunLogEvent、StoredArtifact、BackupManifest。
- 范围：先在 Storage 完成日志/文件/备份，再接入 Hub、Runtime、客户端必要调用方；无新协议版本。
- 状态：实施中。不读取真实数据，不触碰已安装服务。

## 要求

JSONL 每个 run 单写入者、顺序连续、分段封存。活跃尾部未写完可以报告，归档截断或中间损坏必须失败。
原始 agent 输出另存，不作为业务状态。运行结果由数据库确认，日志归档单独确认。

文件先 staged，字节大小与 SHA-256 校验后发布，再提交 ready；重复上传不重复登记，中断可恢复。
只允许安全相对路径，拒绝符号链接。业务备份以一致性数据库快照确定引用文件，包含校验清单；
恢复验证全部内容，只写入新目录，不覆盖已有状态。知识目录单独备份。

## 验收

- 并发日志写入、单写入者、旋转、重复/缺失事件、Unicode 末行截断与归档损坏。
- 文件错误校验、截断、重复请求、发布后提交前崩溃、无文件的 staged 状态、路径逃逸。
- WAL 中的新业务数据与 ready 文件一起备份恢复；缺失/篡改/重复清单/符号链接拒绝；旧目标不覆盖。
- 接入后用合成 Hub/Runtime 验证离线归档重试，Job 结果与文件确认分开。
- 提交前 bun run check，Bun 1.3.x，无新增第三方依赖。

## Storage 基础验证

2026-11-01，Bun 1.3.13，完整 `LUMIO_LIVE=0 bun run check` 通过：763 pass、3 skip、0 fail
（766 tests / 85 files）。新增 5 项测试覆盖上述日志/文件/备份失败路径及业务写入租约。
Storage 基础已完成，Hub/Runtime 与客户端接入继续下一切片；没有改契约或引入依赖。

## 接入切片

必要调用方：Hub 组装与归档 API、授权、管理命令；Runtime 的 JSONL 输出与独立 archive_outbox；API Client 与 CLI 的产物查看和校验下载。
使用既有 StoredArtifact/RunLogEvent/BackupManifest，没有增加 schema 字段或改变 Job 协议。Runtime 新增对仓库内 Storage/Foundation 的显式依赖，无新第三方库。
新增执行器上传权限只允许已接手的本人 Job；不授予助手或 agent 文件读取/写入权限，私密读取沿用显式请求。
端到端已覆盖上传失败时 Job 先完成、执行器重启后独立归档一次、配套备份恢复，以及 CLI 下载不覆盖已有目标。

2026-11-01 接入验证：Bun 1.3.13，完整 `LUMIO_LIVE=0 bun run check` 通过，768 pass、3 skip、0 fail
（771 tests / 85 files）。本机 Claude 的只读交叉 review 已启动，最终结论另行记录；未将整个 R0 标为完成。
