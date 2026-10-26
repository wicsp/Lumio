# P2-6 高权限命令的门：`lumio-runtime sudo`

- 负责：后端（Codex）　Review：Claude
- 相关 ADR：**0020**（本切片的设计，先读）、0019（第 7 节）、0016（需要批准的操作、提议、审计）
- 涉及：`apps/runtime`、`apps/hub`、`apps/cli`、`infra/`、`skills/lumio`
- 契约：`packages/schema` 的 `ExecPrivileged`、`PrivilegedApproval`、`PrivilegedStatus`、`PrivilegedReport`、
  `privilegedSigningPayload`（已由 Claude 起草并合并，**不得修改**；需要改时先说明理由）
- 依赖：P2-4

## 目标
在人类自己的服务器上，一轮之内的 agent 需要 root 时运行 `lumio-runtime sudo -- <程序> [参数…]`；
人在 Mac 上 `lumio proposals accept <ID>` 后，由 root 助手程序执行**一次**，输出返回给 agent。
agent 与执行器是同一个系统账号，所以助手程序自己验证 Hub 的签名，不信任调用者（ADR 0020 第 1 节）。

## 流程总览
```
agent ──(本地 socket + 这一轮的凭据)──▶ 执行器 ──POST /v1/operations exec.privileged──▶ Hub：生成提议（needs_approval）
                                          │                                        人：lumio proposals accept → Hub 签发凭据
                                          ├──GET /v1/runtime/privileged/<提议>（轮询）◀─┘
                                          ├──sudo -n lumio-sudo-helper --sudo-helper（stdin：凭据）→ 验证 → 执行 → 记为已用
                                          ├──输出、退出码 ──▶ agent
                                          └──POST /v1/runtime/privileged（回报，不含输出）──▶ Hub 审计
```

## 范围

### apps/hub
1. **签名密钥**：首次启动时生成 Ed25519 密钥对，存在 `hub.sqlite` 新表里（私钥只在 Hub 进程内使用，不出现在任何 API、日志、错误里）。
   管理命令 `lumio-hub signing-key` 打印公钥（base64url，32 字节原始公钥）。备份沿用现有 `backup`。
2. **授权**（`authorize.ts`，替换现在的占位拒绝规则）：
   - `exec.privileged`：`runtime` → `needs_approval`；`human`、`agent` → 拒绝（原因 `only-runtimes-request-privileged`）。
   - runtime 访问 `/v1/operations` 现在会在读请求体之前被拒绝（`server.ts`）。改为：runtime 可以提交请求体，
     但除 `exec.privileged` 外一律 403；`actors`、`proposals`、`proposal.accept|reject` 对 runtime 仍在读请求体前拒绝。
   - 提交时额外检查（不通过 → 400/409，不生成提议）：`args.runtime` 等于调用者身份；`args.job` 派给了它且还没有结果；
     `reason` 由执行器填写（如"第 2 轮的 agent 申请"）。同一 Job 同时待批准的申请最多 5 个（防止刷屏）。
3. **接受提议**（`operations.ts` 的 `execute`）：`exec.privileged` 的"执行"= 签发凭据：
   `{ proposal, runtime, job, argv, approved_by: 批准者, approved_at: 现在, expires: 现在 + 10 分钟 }`，
   签名 `sign(null, Buffer.from(privilegedSigningPayload(grant)), 私钥)`，存起来。
   - 接受时 Job 已有结果或已取消 → 409，提议状态改为 `rejected` 并在审计中记 `expired`（不新增提议状态）。
   - 注意：现有代码"以提议作者身份执行"，作者是 runtime；签发凭据时 `approved_by` 用**批准者**。
4. **新路由**（归入 `RUNTIME_OPERATIONS`，只有 runtime 允许）：
   - `GET /v1/runtime/privileged/<提议 ID>` → `PrivilegedStatus`。只能查自己提交的；别人的、不存在的 → 404。
     待批准 → `pending`；已拒绝 → `rejected`；已签发 → `accepted` + 凭据；凭据已过期或 Job 已结束 → `expired`。
   - `POST /v1/runtime/privileged`（`PrivilegedReport`）→ 记入审计（操作、argv 原文、退出码、状态；**不记输出**）。
     同一提议只接受一次回报，重复的相同回报返回 200，不同的返回 409。
5. **`lumio proposals` 的显示**（`apps/cli/src/operations.ts`）：`exec.privileged` 显示为
   `在 <执行器名> 上以 root 执行：<argv 用空格连接，含空格的参数加引号>`，下一行是来源（任务标题 + 第几轮，或例行任务标题），
   再下一行是理由。人要能一眼看清命令本身。
6. **固定说明**（`tasks.ts` 的 `INSTRUCTIONS`、`routines.ts` 的 `ROUTINE_INSTRUCTIONS`）：把"不要尝试提权（sudo）"改为
   "需要 root 时运行 `lumio-runtime sudo -- <命令>` 并等待用户批准（可能要等很久，也可能被拒绝）；不要直接使用 sudo"。

### apps/runtime
7. **配置**（`config.ts`）：
   - `LUMIO_RUNTIME_SUDO_COMMAND`：调用助手程序的完整前缀，空格分隔，例如
     `sudo -n /usr/local/libexec/lumio-sudo-helper --sudo-helper`；第一个元素必须是绝对路径。不设置 = 此执行器不支持提权。
   - `LUMIO_RUNTIME_SUDO_TIMEOUT`：等待批准的最长秒数，默认 1800。
8. **本地申请通道**：执行器启动时在状态目录下建 `sudo.sock`（目录 0700）。每一轮开始时生成一个随机凭据（32 字节），
   在这一轮的环境里**额外**设置 `LUMIO_SUDO_SOCKET`、`LUMIO_SUDO_TOKEN`（`jobEnv` 会去掉所有 `LUMIO_*`，这两个是之后显式加的；
   执行器自己的 `LUMIO_TOKEN` 仍然不能出现）。一轮结束（任何结果）时作废凭据，并结束这一轮所有等待中的申请。
   协议是执行器内部的事（JSON 行即可），不进 `packages/schema`。
9. **`lumio-runtime sudo -- <程序> [参数…]`**（`main.ts` 新增子命令）：
   - 没有 `LUMIO_SUDO_SOCKET`/`LUMIO_SUDO_TOKEN` → 打印"只能在执行器派出的一轮之内使用"，退出码 2。
   - 执行器没配置 `LUMIO_RUNTIME_SUDO_COMMAND` → "此执行器不支持提权"，退出码 2，不联系 Hub。
   - 否则发起申请并阻塞等待；打印一行"已提交申请 <提议 ID>，等待用户批准"到 stderr。
   - 批准并执行 → stdout/stderr 原样转发，退出码透传；拒绝 → "用户拒绝了这条命令"，退出码 1；超时、失效 → 相应说明，退出码 1。
   - `<程序>` 必须是绝对路径（不经过 PATH 查找，避免 agent 预先放一个同名程序）。
10. **执行器处理申请**：校验凭据属于正在执行的那一轮 → 提交 `exec.privileged`（`runtime` 用登记时 Hub 返回的身份）→
    每隔轮询间隔查 `GET /v1/runtime/privileged/<提议>`，直到不再是 `pending` 或超时 → `accepted` 时以凭据 JSON 为 stdin
    调用 `LUMIO_RUNTIME_SUDO_COMMAND` → 把输出转给调用者 → 回报 `PrivilegedReport`（Hub 不在线时进入现有的待交回机制或单独重试，不能丢）。
    Hub 失联期间申请照样等待（计入超时）。
11. **root 助手程序**（同一个可执行文件，入口 `--sudo-helper`；由 root 复制到 `/usr/local/libexec/lumio-sudo-helper`）：
    - 只在真实 uid 为 0 时运行，否则拒绝。
    - 配置路径**写死**为 `/etc/lumio/sudo.json`（`{ "public_key": "<base64url>", "runtime": "act_…" }`），已用列表写死为
      `/var/lib/lumio-sudo/used`。两者都必须 root 所有、组和其他人不可写，否则拒绝。不读任何环境变量来决定这些路径。
    - 从 stdin 读 `PrivilegedApproval`（严格解析）；依次检查：签名有效、`runtime` 与配置一致、未过期、提议 ID 不在已用列表里。
      检查通过后**先**把提议 ID 追加进已用列表（加锁、fsync），**再**执行——宁可执行失败也不能执行两次。
    - 执行：不经过 shell，argv[0] 必须是绝对路径；环境只有 `PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`、
      `LANG=C.UTF-8`；工作目录 `/`；超时 30 分钟后杀掉进程组。
    - 拒绝时打印原因、退出码 126（执行器据此回报 `refused`）。
    - 把检查逻辑写成可注入路径与时钟的函数（测试用），`--sudo-helper` 入口只传写死的路径。

### infra/
12. `infra/systemd/README.md`（或新文件 `infra/sudo-helper.md`）写明服务器上由人用 root 做的一次性安装：
    复制助手程序、`/etc/lumio/sudo.json`（公钥来自 Mac 上的 `lumio-hub signing-key`，runtime 来自 `lumio runtime list --json`）、
    `/var/lib/lumio-sudo/`、sudoers 一行（`<账号> ALL=(root) NOPASSWD: /usr/local/libexec/lumio-sudo-helper --sudo-helper`，
    用 `visudo -f /etc/sudoers.d/lumio` 编辑）；执行器的环境里设置 `LUMIO_RUNTIME_SUDO_COMMAND`。学校服务器不做这些。

### skills/lumio
13. 在 skill 中说明：`exec.privileged` 的提议来自服务器上的 agent，用户用 `lumio proposals` 查看；AI 可以帮用户解释命令的作用，
    但不能替用户接受（agent 令牌会被拒绝），也不要建议用户不看就接受。

## 不做
- 审批模型、飞书批准（P3）；同类命令自动批准；把输出存进 Hub；让 agent 交互式地输入密码。

## 验收标准
1. `bun run check` 通过。
2. Hub 测试：
   - runtime 提交 `exec.privileged` → 202 + 提议；`args.runtime` 不是自己、Job 不是自己的或已结束 → 拒绝且无提议；
     runtime 提交其他操作 → 403；human、agent 提交 `exec.privileged` → 403。
   - agent 不能接受；human 接受 → 凭据能用 Hub 公钥验证，`approved_by` 是批准者；Job 已结束时接受 → 409；
     查别人的提议 → 404；过期后状态为 `expired`；签名私钥不出现在任何响应、日志、审计里。
   - 回报只记一次；审计里有申请、批准或拒绝、执行结果，没有输出。
3. 助手程序测试（注入临时路径与时钟，非 root 时跳过 uid 检查的那一项）：签名错、执行器不一致、过期、已用过、配置文件权限不对 → 拒绝且不执行；
   通过 → 执行一次并记为已用；同一凭据第二次 → 拒绝；argv[0] 不是绝对路径 → 拒绝；环境变量不会传进被执行的程序。
4. 端到端（真实 Hub + 执行器 + 假 agent + 假的助手程序记录收到的凭据并执行一个无害命令）：
   批准 → 执行一次，agent 拿到输出与退出码；拒绝 → 不执行，agent 退出 1；等待超时 → 不执行；
   不在一轮之内调用 → 退出 2；未配置助手程序 → 退出 2 且 Hub 上没有提议；这一轮被取消 → 等待中的申请结束、之后接受也不会执行。
5. 人类在自己的服务器上手动验证一次（见 `docs/tasks/README.md` 的待办）。

## 完成时
按 AGENTS.md 列出改动、契约（应为"未改"）、依赖（应为"无"）、验证方式；更新 `docs/tasks/README.md`（P2-6 ✅、手动验收一项）、
ADR 0019 与 0020 的状态和修订记录、`docs/DESIGN.md` 第 4.6、5 节。
