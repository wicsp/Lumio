# M1-0 原生 Assistant 实现与本地验收

日期：2026-11-08。分支：`codex/v0-ai-session-spike`。从已提交的 main `4dba5ca` 合入 T1 后继续；没有改动另一会话的工作树。

## 交付

- 统一 Connection/Profile/用途绑定契约、持久配置与设置页；Assistant 可选 API 或原生 Profile。DeepSeek 推理/加密续接状态单独保存，不显示为正文。
- 原生 Codex app-server：一会话一进程/状态/工作区，官方设备码登录、动态模型/effort、流式正文/公开思考摘要、工具过程、审批、停止、压缩及同 thread 恢复。
- 两条认证 HTTP 通道、持久 outbox、序号去重、逐轮配置交付记录；受理未知不自动重发。原生审批在 Hub 一次消费，绑定原实例。
- 固定沙箱与 OS 读取外边界、最小环境、账户指纹、工具集合验证；会话范围 MCP 凭据、普通 agent 授权、写入回执去重。未知结果冻结并要求核查，关闭终态不被迟到旧事件重新打开。
- 对话彻底删除清理 Hub 原生负载，迟到事件经 ID tombstone 确认，不拖断其他 Session；未核查 unknown 不可彻底删除。
- ADR 0040/0041、设计分册、Bun 1.4.x 规则和 CI 1.4.4 同批修改。生成契约由 `schema:export` 导出，无手改生成物。

## 验证与证据

- `bun install --frozen-lockfile --ignore-scripts`：117 installs / 108 packages，无变更、无新增依赖。
- `bun run schema:export`：新 AI/原生契约与既有契约全部导出成功。
- 合成原生集成：连续两轮、模型切换、请求幂等、所有者边界、实例审批、NO_ACK 未知冻结且调用一次、MCP 范围与写回执、停止后核查、状态丢失拒绝恢复、连接 revision 改变拒绝裸续接、删除和迟到事件。
- OS 反向验证：拒读合成 vault、凭据、相邻 Session 与 symlink 指向的目录；父进程退出后监督范围仍能停止已观察到的命令，不以此宣称绝对消除所有外部副作用。
- `LUMIO_NATIVE_LIVE=1 bun test scripts/native-assistant.test.ts -t 'official Codex:'`：真实官方客户端 **1 pass / 0 fail**。同 thread 记住并回忆合成词、跨进程完整配置恢复、实际调用合成 Hub 的 `work.task.list` MCP。只在一次性 fixture 中临时使用现有认证，目录在 finally 清理；正式试用不复制认证。
- `bun run apps/cli/src/build-binary.ts --version 0.2.0-native-trial ...`：编译和 macOS 签名成功，实际程序版本核对通过。
- ego-browser：网页登录配对、统一配置与 DeepSeek 表单、选择原生 Profile、创建会话、草稿保留、重新打开对话、发起官方设备码登录均完成。实际官方链接已出现，登录前 Send 禁用；未替用户完成官方账号认证。深色桌面布局已截图检查。
- 全量 `bun run check`：最终结果见下方交付记录；历史发现的失败包括发送唤醒丢失、实际配置上报时机、完成/就绪竞态及核查后迟到 unknown，均已修复并回归，不以早期通过结果替代最终检查。

## 部署与限制

独立本地 <http://127.0.0.1:7421>，新数据库、两个专属 launchd 服务、两个合成任务；原有 7420 与真实 vault 不受影响。登录与启停见 [试用说明](../native-assistant-trial.md)。当前仅支持 macOS/Codex 0.166.0；API 服务显式思考参数只开放验证过的 DeepSeek 组合。Job/Profile 接线与 Job3、Claude 原生、其他 OS、通用托管不在本切片。

影响 package/app：`schema`、`storage`、`assistant`、`api-client`；`hub`、`runtime`、`web`；`cli` 仅新增领域诊断文案。契约有变更，授权记录见 ADR。新增依赖：无。

## 最终交付记录

- Bun 1.4.4 的完整 `bun run check`：**1252 pass、4 skip、0 fail**，158 个文件；TypeScript 与依赖边界通过。四个 skip 为显式 opt-in 的官方 Codex、联网来源及终端交互用例；官方 Codex 已另行实跑通过。
- macOS 签名验证通过；本地最后构建 SHA-256：`1007d4507d35e6798aab8e4bc8e0b7a811e7afad08c88f209b563fa6ddeb65e3`。
- 试用 Runtime 在线、隔离级别 macos-seatbelt；两个合成任务；官方账号由用户在页面完成登录。
- 推送分支 `codex/v0-ai-session-spike`；ADR 保持 Accepted，PR 保持 Draft，是否合并由用户试用后决定。
