# ADR 0054：Claude Code 订阅额度后台刷新

- 状态：Accepted
- 日期：2026-11-10
- 人类批准：2026-11-10

## 背景

[ADR 0052 与 PR #143](https://github.com/wicsp/Lumio/pull/143) 增加了 AI 连接用量。DeepSeek 和 Codex 在监控开启后每 15 分钟查询，Claude Code 只接收已启用状态栏的交互会话采样。用户希望 Claude Code 也能主动刷新，无需为采样保持终端打开或发送模型消息。

## 调研

- **CodexBar** 有独立的 CLI 采集路径。它在专用目录短时启动原版 Claude Code，通过伪终端调用内置 `/usage`，解析当前窗口与每周额度，结束后关闭进程。可以参考有界终端渲染、禁用会话附加能力和失败时保留最近读数。 [CodexBar Claude 实现说明](https://github.com/steipete/CodexBar/blob/main/docs/claude.md#cli-pty-fallback)
- **Claude Code Usage Monitor** 通过订阅 OAuth 凭据轮询私有接口，并对服务端限流退避。**Claude Usage Tracker** 结合状态栏样本与 OAuth 轮询。两者印证了后台查询与会话采样应有独立的状态和时间戳。Anthropic 的公开说明限制第三方代用订阅凭据、收集或转存会话令牌，Lumio 的采集路径由原版 Claude Code 持有和使用登录。 [Claude Code Usage Monitor](https://github.com/duanestorey/claude-monitor#how-it-works) · [Claude Usage Tracker](https://github.com/paris-paraskevas/claude-usage-tracker#how-it-works) · [Anthropic 凭据规则](https://code.claude.com/docs/en/legal-and-compliance#authentication-and-credential-use)
- **ccusage** 从本地活动数据计算 token 和估算成本，适合历史统计。个人订阅的额度分母、账户跨端用量及重置窗口由 Claude 给出。 [ccusage](https://github.com/ccusage/ccusage) · [Claude Code 内置命令](https://code.claude.com/docs/en/commands)

## 决定

### 1. 采集与账号绑定

- 在现有 Claude Code 订阅连接增加「后台查询」方式，由连接所有者在选定的 Runtime 上显式启用。Runtime 调用设备上已经安装且通过验证的原版 Claude Code。通过 CLI 自带的身份状态验证为 Claude 订阅，并绑定可验证的账户指纹和采集代次。缺少登录、身份无法核实或账号变更时暂停，保留或清除快照依 ADR 0052 的绑定失效规则。用户可在官方 Claude Code 完成登录或重新确认绑定。
- Runtime 从独立于项目和 vault 的专用工作目录启动有时限的本地伪终端，调用已确认存在的内置 `/usage`，读取返回的额度面板后退出。只在能禁用工具、用户自定义 hooks、MCP 和其他会话扩展的环境运行。出现工作区信任、登录、权限或其他交互提示时停止，交由用户处理。使用独立进程监督和有界终端缓冲，不发送聊天消息，不启动常驻 Claude 会话。原版 CLI 保管登录和续期，Lumio 不读取 Claude 令牌、浏览器 Cookie 或历史对话，不改写用户设置。
- 从已识别的面板提取额度窗口、已用百分比和可无歧义确定的重置时间。缺失的窗口或重置时间保持未知。采集失败、布局变化或超时保持最近读数的原时间。Hub 和 Web 只接收规范化字段、绑定信息与错误类别。原始终端输出不持久化，也不进日志或 HTTP 响应。

### 2. 刷新、显示与兼容

- Hub 对开启监控的连接每 15 分钟调度一次。所绑定的 Runtime 在线并协商支持后领取查询，同一账号的并发刷新合并。页面支持手动刷新，同一查询复用回执。连接停用或离线时不排积压任务，临时失败退避，登录失效或不支持的版本显示明确状态。
- 复用 ADR 0052 的快照、所有者授权和阈值提醒。契约显式区分后台查询与会话采样，并为后台请求及结果定义 Runtime 身份、采集代次和请求关联。一次成功的后台查询即使数值相同也更新查询时间。会话采样沿用原有去重规则，旧的采样及回执不能覆盖新代次的结果。
- 既有 Claude Code 连接、采样设置和快照继续可读。用户选择后台方式后才开始调度。旧 Runtime 继续提供它原来支持的采样方式。Hub 仅向宣告支持并绑定该连接的 Runtime 下发后台查询。

## 验收

- 在合成 CLI 和终端记录上验证冷启动、禁用扩展、窗口缺失、布局差异、超时、重复领取、速率限制、身份切换及进程退出。遇到未知提示或命令不可用时，禁止提交文本到模型。
- 验证关闭页面且没有用户打开 Claude 会话时仍可完成轮询。验证旧 Runtime 和旧采样、持久提醒去重及新旧采集代次之间的隔离。
- 先运行全量检查，再按本机部署流程备份、部署并在 `7420` 验收。真实订阅验收只检查用量窗口、更新时间和采集状态。

## 修订记录

- 2026-11-10（人类批准）：原版 CLI 在外层 Seatbelt 中无法完成启动，故额度采集改用 CodexBar 的短时 CLI 方式。macOS Runtime 管理者显式将 `LUMIO_CLAUDE_QUOTA_CONNECTION` 设为允许查询的连接 ID 后，该设备才为这条连接提供后台查询。只有固定、签名和版本通过验证的额度进程可以在外层沙箱之外启动，继续使用 Claude 的受限模式、专用登录环境、禁用扩展和命令菜单核验。普通任务和原生 Codex 会话沿用各自的隔离策略。
