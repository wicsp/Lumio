# Execution：执行器、Job、日志与 Routine

> 现行设计分册，只写现在生效的规则；总览、跨模块规则与写法见 [`../DESIGN.md`](../DESIGN.md)。

## 日志与托管文件（ADR 0025）

- Runtime 保留原始输出，同时写分段 JSONL（RunLogEvent v1）；每次运行独占日志目录，事件顺序从 1 连续递增。
  原始 stdout/stderr 的 JSONL output 负载用 base64 表达，避免二进制和 UTF-8 分块造成内容损坏。
- 活跃日志末行不完整可报告；封存日志截断、行损坏、事件重复或缺失必须失败。恢复中断运行只封存完整前缀并记 recovery，Job 仍由数据库标为 unknown，不从日志重新执行。
- 自有日志归档 MIME 为 `application/vnd.lumio.runlog+jsonl`，按完整运行流再次校验；原始输出以 text/plain 独立归档。
- 按事件 ID 定位运行使用业务库中的派生索引：查询未命中时只补扫尚未建索引的已归档日志，每份归档扫描一次，可由归档重建（ADR 0053）。
- Runtime 为文件保留独立交付记录；Hub 校验大小与 SHA-256，先发布字节再登记 ready。登记冲突保留文件待核查，重复交付不重复登记。
  Job 结果确认与文件确认互不替代，上传失败不阻塞结果交回；确认后原始文件仍留在 Runtime。
- 文件接口在 `/v2/execution/` 下；runtime 只能上传自己已接手的 Job 的文件。读取只授予 human，私密产物需显式 include_private。
  `lumio job artifacts <Job ID>` 查看 staged/ready；`lumio job download <文件 ID> --output <新文件>` 流式校验后保存，不覆盖目标。
- **归属**（ADR 0067）：托管文件归一个业务对象（ResourceRef）或 Hub 协调对象（`{module: "hub", id: cap_/gln_}`）。所见截图上传时归所见；存成资料时在同一事务转给该 `src_`，
  此后随资料进回收站、恢复与备份；只用于对话的按保留期删除。execution 文件规则不变；knowledge 文件按所属实体的可见性与私密规则读取；
  hub 文件只由所见的 human 所有者经 `/v2/glances/<id>/image` 读取，agent 与 runtime 不能登记或读取。
- Job 协议仍为 2；旧 Runtime 不归档文件，新 Runtime 遇到旧 Hub 时保留待交付文件并重试，不影响旧结果协议。

## Job 协议与执行边界（ADR 0019、0020、0025、0068）

- Hub 通过协议 2 管理 Job。Runtime 向 `/v1/runtime/register` 登记能力与版本，经 `/v1/runtime/sync` 主动轮询，先持久化 Job 再向 `/v1/runtime/ack` 确认。
- 每个 Job 只执行一次。断线时保留已确认的队列与待交付结果，Hub 按被指派的 Runtime 和 lease 接受 `/v1/runtime/results` 并去重。执行进程中断时标为 `unknown`，重新执行由人发起新一轮。
- 已编译的 Runtime 把该实例的程序目录放在 agent 的 PATH 前面；agent 使用同版本 `lumio`，凭据限当前 Job。
- **高权限申请**（ADR 0020）：每轮单独的本地 socket 凭据经 `lumio runtime sudo -- <绝对路径程序>` 发起，Runtime 向 `/v2/approval/privileged` 提交并经 `/v1/runtime/privileged` 查询与回报；人用 `lumio proposals` 查看并批准或拒绝。批准后 Hub 签发 10 分钟有效的一次性凭据，root 助手独立验证并在执行前记为已用；输出只返回调用者，执行状态离线时保留交回。Linux 与 macOS 安装见 [高权限助手](../../infra/sudo-helper.md)。
  执行器登记 `privileged_helper` 能力表示已配置助手；没配置时拒绝请求，并在这一轮结果的 `privileged_unavailable` 里记下第一次请求的程序（不含参数），供 Web 提示人安装。
- **适配器**：`codex exec`、`claude -p`、`pi -p` 的非交互模式；锁定验证过的版本；如实声明隔离级别（`os`/`none`）。
  不经过 shell；command 类型只执行登记过的程序；密钥在执行节点上才解析。
- **阶段权限与钩子**（ADR 0049，H1-4）：Codex 默认使用工作区写入沙箱，可按阶段改为只读或显式全权限；Git 写入授权只覆盖已验证版本上当前 checkout 的元数据。无 OS 沙箱的引擎由执行器账号权限约束。
  在执行器环境中通过 `LUMIO_SECRET_<名称>` 配置阶段密钥（名称中的 `-` 写成大写 `H`，例如 `LUMIO_SECRET_githubHmerge`），同名变量只注入声明它的 agent 轮次，汇报和日志脱敏。前后钩子以执行器账号在工作目录按 argv 运行，输出进入轮次日志，失败或超时结束该轮。
- **普通权限申请**（ADR 0049，H1-9）：执行器从 agent 汇报末尾的独立 `<lumio-permission>` 行提取权限，按等待人决定交回并保留理由。
- **不做**：跨设备调用工具、上下文管理、模型路由；留给以后自研的 agent（作为执行器里的一种引擎接入）。

## Job 实时活动与同轮介入（ADR 0069、0070、0072）

- Job 2 通过登记头协商活动扩展。Runtime 用独立通道提交少量脱敏事件，以 Job、lease 和连续序号校验、补读和去重。活动与最终结果独立，活动流延迟不会重启任务或改变业务终态。
- 心跳说明执行器连通，活动只呈现实际观察到的阶段和工具。普通活动在 Job 完成后保留 30 天，查询标明过期前缀。
- Codex、Claude Code 与 Pi 1.5.0 的非交互 Job 可上报运行事件。显式互动仅在具备已验证引擎、凭据与 OS 隔离的 Runtime 提供。交互模式允许 Web 对一个正在等待的请求进行答复、批准或拒绝，Codex 支持同轮纠偏。调用与回执绑定原执行进程与轮次。
- 复用人类同机 Codex 登录的 Job 默认使用任务或项目指定的具体工作目录。Runtime 管理员可用 `LUMIO_INTERACTIVE_JOB_ROOTS` 进一步限制这些目录。仅用 API 密钥的 Codex Job、Claude Code 和 Pi 交互 Job 继续由该变量指定允许的项目根。已验证版本是 macOS 上的 Codex 0.166.0、Claude Code 2.1.322 和 Pi 1.5.0。交互轮使用受限沙箱及独立的会话目录，阶段为全权限时须使用原非交互模式。
- macOS Codex 交互轮由 Runtime 的 Seatbelt 执行隔离。目录内操作直接运行，Git 元数据默认只读。需要创建 worktree 的开发轮从仓库根目录派出并授予 Git 权限，worktree 建在授权的工作目录内。
- 显式派出 Codex 交互轮次的人可以复用自己在同一 Runtime 上已登录的 AI 连接。唯一可用的连接自动选用，多连接时由人选择。Hub 保存该轮的授权快照，Runtime 通过协商后的现有同步接口取到快照，沿用原生通道管理的登录和刷新。注销、重新登录、切换连接或认证代次后，旧轮不得交付新决定或恢复会话。无可用连接时仍支持管理员已明确配置的 `LUMIO_JOB_CODEX_API_KEY`。Claude Agent SDK 路径沿用 `LUMIO_JOB_CLAUDE_API_KEY`。
- Pi 普通轮次从 JSON 事件读取实时工具进度和最终回复。交互轮次使用独立会话与执行器配置的目录许可，通过 Pi RPC 同轮提问，并在 Shell 或文件修改前按次请人决定。执行器通过 `LUMIO_JOB_PI_MODEL` 选择 `提供商/模型`，初期支持 OpenAI、Anthropic、OpenRouter 和 Google。可沿用执行器上的提供商环境密钥，也可用 `LUMIO_JOB_PI_API_KEY` 指定。交互进程只加载 Lumio 自带的扩展，提供商密钥不传给 Shell 工具。
- `lumio job watch <id>` 使用同一状态与事件接口。CLI 派出时可用 `lumio task continue <id> --interactive` 或 `lumio job submit --interactive` 请求交互，不能由定时例行任务启用。

## Runtime 版本与自动更新（ADR 0063，U1-0）

- **期望版本对账**：Hub 为每台 Runtime 声明期望版本，默认等于 Hub 自己的版本（策略 `follow`；`manual` 时只显示落后）。期望版本只通过同步回复发给声明了 `self_update` 的 Runtime，由 Runtime 自己收敛；更新不是 Task 或 Job，Job 协议仍为 2。
- Runtime 登记版本、平台、安装方式与 `self_update`，在心跳中报告更新状态（`current / downloading / staged / waiting_idle / draining / restarting / failed / blocked`）。
- **安装方式**：`hub-shared`（与本机 Hub 共用 `~/.local/bin/lumio`）不替换程序，磁盘程序版本变化后空闲时重启；`managed`（`install.sh`/`upgrade` 管理且本机无 Hub）下载、验签、替换并重启；`external`（Nix、brew、容器、源码运行或 `LUMIO_RUNTIME_AUTO_UPDATE=off`）只报告落后。
- **来源与验签**：优先从 Hub 产物库 `/v2/execution/updates/` 取清单与压缩包（只授予 runtime），正式版本可退回 GitHub；Runtime 只接受内置正式公钥或本机人工信任的构建公钥签过的清单，并核对大小与 SHA-256。Hub 只下发版本号。
- **切换不打断工作**：后台下载、预检（新程序 `--version` 与只读 `runtime update-check`）后等空闲（无执行中 Job、原生轮次、钩子与高权限请求；只是开着的原生会话与待交回结果不算忙）。30 分钟内没等到空闲就排空：Hub 不再指派新 Job 与原生轮次，本地暂缓排队的 Job 与到点的例行任务，不杀进行中的工作；排空超过 2 小时通知人选择暂缓或立即重启（中断的轮次为 `unknown`）。
- **替换与回退**：保留 `previous` 副本并写待确认标记后原子替换，正常退出由服务管理器拉起；新进程向 Hub 登记并同步一次才算确认，连续 3 次启动未确认则换回旧程序并报告 `failed`，同一版本不再自动重试。Hub 不可达不计次数。
- Hub 接受当前与上一正式版本的 Runtime。未声明 `self_update` 的 Runtime 需要手动升级。Runtime 收到期望版本后才在心跳报告更新状态。签名清单允许指定版本。高权限助手不随自更新替换，不兼容时 Runtime 不再声明 `privileged_helper` 并提示重装。

## 数据库 Routine 与设备（ADR 0025）

- 数据库 Routine 使用 `/v2/execution/routines` 与 `/v2/execution/commands`；计划在 Execution，独立于 Task 与知识目录。
  Runtime 继续使用 Job 协议 2，本地触发与 outbox 不变。已交付计划保留历史快照，旧结果按原 lease 匹配输入；心跳无 lease 时不猜测多份历史计划。
- 设备登记规则和在线时限由 Execution 判断，Runtime 表与 Job 表由 Storage 适配；Hub 的身份和 HTTP 入口只组装并转发。
  审批通过 Execution 查询 Job 是否仍有效，取消请求已登记时即拒绝开启高权限工作，不直接读取执行表。
- `lumio routine` 管理数据库计划。从指定执行开启追问时创建人工 Work 任务并保留执行来源。

## 原生交互会话（ADR 0041、0042、0047）

- Runtime 的原生 Assistant 通道与 Job2 并列，显式启用；Runtime 主动发起认证 HTTP 命令流并 POST 持久事件，按 Session 序号确认去重。断线只补事件，不重发 turn 或工具。
- 每个 Session 独占进程和托管目录，按需恢复原线程；支持连接授权的 Runtime 复用连接登录。当前只允许已验证 macOS/Codex 0.166.0，隔离不满足拒绝运行。一次仅一轮，审批绑定进程实例，停止时监督整个已观察进程范围。
- Job/Routine 后续沿用 Connection/Profile/用途绑定；本次不升级 Job 协议或把旧摘要执行改成交互会话。
- **连接额度上报（ADR 0052、0054）**：Codex 复用连接级认证通道，在双方协商支持后按需查询账户额度。Claude Code 状态栏在本机仅保存规范化读数，Runtime 取得指定给自己的绑定后上报，不需要开启 Codex 原生会话。macOS Runtime 管理者将 `LUMIO_CLAUDE_QUOTA_CONNECTION` 设为允许查询的连接 ID 后，设备可为该连接在外层 Seatbelt 之外调用签名和版本已验证的原版 Claude Code。短时伪终端在专用登录环境用 Claude 的受限模式调用内置 `/usage`，禁用项目扩展，验证订阅身份并按连接和代次回传规范化读数。专用环境由用户用官方 CLI 登录。上报只包含规范化读数、绑定信息和失败类别。
