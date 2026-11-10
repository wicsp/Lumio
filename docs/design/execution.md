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
- Job 协议仍为 2；旧 Runtime 不归档文件，新 Runtime 遇到旧 Hub 时保留待交付文件并重试，不影响旧结果协议。

## Runtime 与旧任务笔记兼容（P2，ADR 0005、0019）

本节的文件开关和写回语义仅适用于尚未执行 v2 apply/retire 的旧模式；Job 的可靠执行协议继续共用。
数据库 Work 的轮到谁、显式委派与结果规则见 [work.md](work.md)。

本节关于修改笔记负责人触发、元数据交接和 AI 区块写回的条款适用于旧笔记路径；新版数据库 Work 见 [work.md](work.md)。
Job 协议、执行器主动连接、lease 校验与可靠交回仍共同适用（ADR 0025）。
- 已编译的 Runtime 启动 agent 时，将本实例的程序目录置于 PATH 前面；agent 调用 `lumio` 使用本实例版本，并沿用当前任务的临时授权。
- **Hub 是中心，每台设备上一个执行器**（`lumio-runtime`）。执行器登记能力（agent 及版本、隔离级别、标签如 `gpu:4`），
  **主动轮询 Hub**；只有 Hub 能委派。执行器的身份角色是 `runtime`：只能领活、回报、登记，不能查询笔记库。
- **一个任务很多轮**：一轮（Job）= 让某个 agent 执行一次，**只执行一次，不自动重试**；重试由人派出新的一轮。
- **负责人就是开关**（ADR 0024，P2-13）：`assignee` 写成 `human`、`<agent>` 或 `<agent>@<执行器>`（旧的 `{agent, device}` 对象仍可读）。
  人把 `assignee` 从 `human` 改成某个 agent（笔记安静 30 秒后派），或 `lumio task continue <任务> [--to <负责人>]`；都走操作 `task.dispatch`。
  交接只改这一个字段：一轮结束回到 `human`，人再改成另一个 agent 就由它接手（换 agent 开新会话）。agent 不能把任务交给另一个 agent。
  任务已有一轮在执行时不再派。`status` 为 `done`、`cancelled` 或 `paused` 时不派出（包括 CLI）；重新开始须先改回 `active` / `todo`。
  **升级兼容**：笔记中仍有 `turn` 字段时沿用旧开关，只有 `turn: agent` 才按负责人派出，否则视为轮到人；结束或拒绝派出时只把 `turn` 写回 `human`，保留原负责人及其对象写法。
  没有 `turn` 时才用 `assignee` 作开关；升级启动扫描不把旧笔记固定的 agent 负责人当成新的委派请求。AI 有问题时这一轮以"等你回答"结束，人回答后接着同一个会话继续。
- **派给哪个执行器**：写了 `@<执行器>` 时用它；否则用 Hub 所在机器上的本机执行器，没有时拒绝（ADR 0024）。不在线时 Job 等它上线后领取。
  `workdir` 缺省为执行器上的 `~`，不能在笔记库里。执行中人改 `assignee` 不生效，只记入 `hub status` 的问题列表。第一次派出时 `status` 从 `todo` 改成 `active`；人在执行中改成 `paused`/`cancelled` 会取消这一轮。
- **写回**：每轮结果写进正文末尾的 `round-N` AI 区块，新格式的 `assignee`（旧格式的 `turn`）改回 `human`；汇报疑似含卡号或密钥时不写入笔记，只提示用 `lumio job show` 查看。
  Hub 的这两次写入（派出、写回）各自单独提交；目标笔记里人还没提交的修改先作为一次自动保存提交。
- **上下文**：能接上原会话时只发人新写的部分；接不上时发人写的部分加最近一轮的汇报。
- **记录分开**：笔记里是每一轮的汇报摘要（AI 区块）；Hub 数据库里是每一轮的完整记录（配置、状态、时间、退出码、
  会话编号、开始与结束时的 git 提交、完整汇报）；完整日志在执行器本地。
- **断开后能接上**：执行器先把 Job 写进本地队列再确认；确认后这一轮归它负责，失联时 Hub 不转给别人。
  结果先存"待交回"，Hub 确认后才删；重复交回只记一次。Hub 只接受被指派的执行器、带着当前 lease 的回报。
  执行器重启时，执行到一半的标为 `unknown`，新格式的 `assignee`（旧格式的 `turn`）改回 `human`。
- **例行任务**（`plan/routines/`）：`status: active` 的例行任务由 Hub 做成计划同步给执行器（选执行器的规则同上），
  到点由执行器自己触发（Hub 离线也照常），Job 编号由"例行任务 + 计划触发时间"确定，重复生成只有一个；每次是独立的新会话，
  `context: previous` 时带上上一次的摘要。执行器离线错过的只补跑最近一次，其余在结果里注明跳过了几次。
  结果按时间追加在这篇笔记的 `run-<日期时间>` AI 区块里。`lumio routine list` 列出计划；
  `lumio routine followup <例行任务> <日期>`（操作 `routine.followup`）从某一次开出普通任务：执行配置照抄，`assignee: human`。
- **高权限申请**（ADR 0020）：每轮单独的本地 socket 凭据经 `lumio runtime sudo -- <绝对路径程序>` 发起；人用 `lumio proposals` 查看并批准或拒绝。批准后 Hub 签发 10 分钟有效的一次性凭据，root 助手独立验证并在执行前记为已用；输出只返回调用者，执行状态离线时保留交回。Linux 与 macOS 安装见 `infra/sudo-helper.md`。
- **适配器**：`codex exec`、`claude -p`、`pi -p` 的非交互模式；锁定验证过的版本；如实声明隔离级别（`os`/`none`）。
  不经过 shell；command 类型只执行登记过的程序；密钥在执行节点上才解析。
- **阶段权限与钩子**（ADR 0049，H1-4）：Codex 默认使用工作区写入沙箱，可按阶段改为只读或显式全权限；Git 写入授权只覆盖已验证版本上当前 checkout 的元数据。无 OS 沙箱的引擎由执行器账号权限约束。
  在执行器环境中通过 `LUMIO_SECRET_<名称>` 配置阶段密钥（名称中的 `-` 写成大写 `H`，例如 `LUMIO_SECRET_githubHmerge`），同名变量只注入声明它的 agent 轮次，汇报和日志脱敏。前后钩子以执行器账号在工作目录按 argv 运行，输出进入轮次日志，失败或超时结束该轮。
- **普通权限申请**（ADR 0049，H1-9）：执行器从 agent 汇报末尾的独立 `<lumio-permission>` 行提取权限，按等待人决定交回并保留理由。
- **不做**：跨设备调用工具、上下文管理、模型路由；留给以后自研的 agent（作为执行器里的一种引擎接入）。

## 数据库 Routine 与设备（ADR 0025）

- 数据库 Routine 使用 `/v2/execution/routines` 与 `/v2/execution/commands`；计划在 Execution，独立于 Task 与知识目录。
  Runtime 继续使用 Job 协议 2，本地触发与 outbox 不变。已交付计划保留历史快照，旧结果按原 lease 匹配输入；心跳无 lease 时不猜测多份历史计划。
- 设备登记规则和在线时限由 Execution 判断，Runtime 表与 Job 表由 Storage 适配；Hub 的身份和 HTTP 入口只组装并转发。
  审批通过 Execution 查询 Job 是否仍有效，取消请求已登记时即拒绝开启高权限工作，不直接读取执行表。
- `lumio routine` 默认使用数据库路径（命令以 `--help` 为准）；`--legacy` 选择旧笔记。
  新版追问从指定执行创建人工 Work 任务并保留执行来源；旧 v1 followup 拒绝数据库 Routine。

## 原生交互会话（ADR 0041、0042、0047）

- Runtime 的原生 Assistant 通道与 Job2 并列，显式启用；Runtime 主动发起认证 HTTP 命令流并 POST 持久事件，按 Session 序号确认去重。断线只补事件，不重发 turn 或工具。
- 每个 Session 独占进程和托管目录，按需恢复原线程；支持连接授权的 Runtime 复用连接登录。当前只允许已验证 macOS/Codex 0.166.0，隔离不满足拒绝运行。一次仅一轮，审批绑定进程实例，停止时监督整个已观察进程范围。
- Job/Routine 后续沿用 Connection/Profile/用途绑定；本次不升级 Job 协议或把旧摘要执行改成交互会话。
- **连接额度上报（ADR 0052、0054）**：Codex 复用连接级认证通道，在双方协商支持后按需查询账户额度。Claude Code 状态栏在本机仅保存规范化读数，Runtime 取得指定给自己的绑定后上报，不需要开启 Codex 原生会话。macOS Runtime 管理者将 `LUMIO_CLAUDE_QUOTA_CONNECTION` 设为允许查询的连接 ID 后，设备可为该连接在外层 Seatbelt 之外调用签名和版本已验证的原版 Claude Code。短时伪终端在专用登录环境用 Claude 的受限模式调用内置 `/usage`，禁用项目扩展，验证订阅身份并按连接和代次回传规范化读数。专用环境由用户用官方 CLI 登录。上报只包含规范化读数、绑定信息和失败类别。
