# S1-0 内置语音输入（与后续语音合成）

依据：[ADR 0055](../adr/0055-speech-input-and-output.md)（Accepted，2026-11-11 人类批准）。
必读：`docs/DESIGN.md`、`docs/design/assistant.md`、`docs/design/web.md`、`docs/design/security.md`。

## 目标

在任何能打开 Lumio 的设备上，按住一个键（按钮、键盘快捷键或手柄键）说话，松手后文字出现在当前输入框里，人确认后再发送。
音频不落盘；语音服务和聊天模型一样在设置页配置。

## 现状（不要重做）

- 统一 AI 配置：Connection / Profile / 用途绑定（ADR 0041，`packages/schema/src/ai.ts`），API 密钥保存在 Hub。
- Web 的 Origin/Host 校验与 CSP 在 Hub（ADR 0027）；Hub 目前没有任何 WebSocket 接口。
- Web 已有命令面板、列表键盘导航（`apps/web/src/client/list-keys.ts`）和恢复副本（ADR 0037），未发送的输入不会因刷新丢失。

## 切片

| 编号 | 内容 | 负责 | 改动范围 |
|---|---|---|---|
| S1-1 ✅ | 预研（[报告](../reviews/S1-1-speech-spike.md)，PR #164；人类选定 Fun-ASR、北京区域）：① 实测 2–3 家流式 ASR（中英混说、技术词、热词效果、首字与定稿延迟、价格），用人录的 20 句测试集；② 验证 Bun 的 WebSocket 能否与 Hub 现有路由、Origin 校验、CSP（`connect-src`）配合；③ 确认 Safari / iOS PWA 上 AudioWorklet 采集 16 kHz 的可行做法（重采样位置）。结果写入 `docs/reviews/S1-1-speech-spike.md`，给出首个服务商的建议 | 后端（Codex） | 只写报告与一次性脚本，不进产品代码 |
| S1-2 ✅ | 契约：`speech.ts`（`start` / `end` / `cancel` / `ready` / `partial` / `final` / `error`，`SPEECH_LIMITS`）；`AIConnectionKind` 增加 `dashscope`（官方区域地址 `DASHSCOPE_BASE_URLS`）；Profile 引擎增加 `speech`；语音用途绑定 `SpeechBinding`（`speech.asr` / `speech.tts`）；热词表 `SpeechVocabulary` 与同步状态（单个热词按 Fun-ASR 规则：非 ASCII ≤ 15 字符、纯 ASCII ≤ 7 个单词，`SPEECH_TERM_LIMITS`）；Hub 连带：语音 Profile 只能配 `dashscope`、不能用于聊天 | Claude 起草，人类批准 | `packages/schema` |
| S1-3 | Hub：`/v2/speech/transcribe` WebSocket（按 S1-1 报告，在 `browserAllowed` 之后、HTTP 认证之前 `server.upgrade`）；首条消息认证、只允许 human；Fun-ASR 适配器（`finish-task` 后等 `task-finished` 定稿；流式转发，不落盘）；上限与空闲断开；热词表存储、读写接口与同步到 Fun-ASR 词表（权重 4；不从私密实体取词；删除连接时删除服务商词表）；语音用途绑定读写；只记元数据的日志；中英错误文案 | 后端（Codex） | `apps/hub`、`packages/storage` |
| S1-4 | Web：麦克风按钮（按住说话 / 点按开关两种）与键盘快捷键；AudioWorklet 采集与分帧；临时结果在输入框内以浅色显示，定稿后变为普通文本；非安全上下文时隐藏入口并说明原因；设置页语音 Profile（写明音频去向）与热词表编辑 | 前端（Claude） | `packages/api-client`、`apps/web` |
| S1-5 | 准确率：松手后整段再识别一次作为定稿（服务商支持时）；可选的 LLM 纠错与"提到的知识条目"建议，作为附加建议展示，人选择后才写入 | 待定 | 依 S1-4 试用结果再细化 |
| S1-6 | 语音合成：口语摘要、逐句流式合成与播放、按说话键打断；协议另行细化后再开工 | 待定 | 依 ADR 0055 第 7 节 |

S1-2 依赖 S1-1（已完成）；S1-3 依赖 S1-2；S1-4 依赖 S1-3。手柄的"按住说话"见 [G1-0](G1-0-gamepad.md) 的 G1-4。

## S1-3 验收要点

- 未在 5 秒内收到有效 `start`、令牌无效、身份不是 human：断开并返回对应 `code`；agent 令牌即使有效也拒绝。
- 一句超过 120 秒自动定稿；单帧超过 8 KB 拒绝；同一身份第 3 路被拒绝；10 秒无音频自动结束。
- 浏览器中途断线：Hub 立即关闭到服务商的连接，不保留任何音频或文本。
- 服务商断线或报错：浏览器收到 `error`，已收到的临时文本保留在输入框，不自动重试。
- 测试用合成音频或服务商的模拟服务器；测试中不调用真实服务、不需要真实密钥（AGENTS.md 第 7 条）。
- 日志、审计、备份中检查不到音频字节和识别文本（加一条测试：跑完一句后在日志目录里搜索测试文本）。

## S1-4 界面要点

- 入口在 Assistant 输入框、任务说明与评论、笔记编辑器；同一时间只有一个输入框在录音，录音时有明显状态与计时。
- 按住说话：按下开始，松手结束；点按模式：点一下开始，再点一下结束；`Esc` 取消（丢弃本句）。
- 识别文本插入到光标位置，不覆盖已有内容；定稿后不自动发送。
- 第一次使用时浏览器请求麦克风权限；拒绝后给出如何在浏览器设置中重新允许的说明。
- 没有配置语音 Profile 时不显示入口，设置页给出配置引导。

## 不做

- 固定写法替换表（例如把识别结果改成 `codex@macsp`）：人不会口述执行器全名，而是说"用笔记本上的 Codex"，由 AI 解析成执行目标（人类决定，2026-11-11）。
