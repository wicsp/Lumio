# 0020 高权限命令：Hub 签名的一次性批准凭据

- 状态：Implemented（P2-6；真实服务器安装与软件包人工验收待办见 docs/tasks/README.md）
- 日期：2026-10-26
- 领域：安全、AI 协作与权限、Hub 与运行
- 影响：ADR 0019 第 7 节（细化 `lumio sudo`）、ADR 0016（runtime 可以发起一种需要批准的操作）；`packages/schema` 的 operation、privileged

## 背景
ADR 0019 第 7 节定了：agent 需要 root 时经 `lumio sudo` 发起需要批准的操作 `exec.privileged`，人批准后由执行器执行。
但还有两个问题没有定。

1. **agent 和执行器是同一个系统账号**（P2-2 review 已记录）。如果"执行器决定执行、通过 sudoers 免密调用 root 助手程序"，
   agent 也能直接调用这个助手程序，跳过批准。所以助手程序不能信任调用它的人，必须自己能验证"人确实批准了这条命令"。
2. **批准结果怎么回到执行器**：`RuntimeSync` 里加字段要改契约；执行器又不能读提议列表（ADR 0019：只能领活和回报）。

## 决定

### 1. 批准凭据由 Hub 签名，root 助手程序自己验证
- Hub 有一把 Ed25519 签名密钥，首次启动时生成，存在 `hub.sqlite` 里（随 `lumio-hub backup` 一起备份）。
  `lumio-hub signing-key` 打印公钥，人把它装到服务器上 root 所有的 `/etc/lumio/sudo.json`。
- 人接受 `exec.privileged` 提议 = Hub 签发一张**批准凭据**（`PrivilegedApproval`）：提议 ID、执行器、Job、argv、批准者、批准时间、
  过期时间（批准后 10 分钟）和签名。
- root 助手程序 `lumio-sudo-helper`（root 安装、root 所有，sudoers 只给它免密）执行前检查：
  签名有效（公钥来自 `/etc/lumio/sudo.json`，文件必须 root 所有且其他人不可写）、执行器与本机配置一致、未过期、
  **这个提议 ID 从没用过**（已用列表在 root 所有的 `/var/lib/lumio-sudo/`）。都通过才执行，执行一次后记为已用。
- 这样 agent 直接调用助手程序也没用：没有人批准就没有凭据，凭据只能用一次，过期作废。

### 2. 申请与取回都走执行器自己的身份
- 执行器（身份角色 `runtime`）可以经 `POST /v1/operations` 提交**唯一一种**操作 `exec.privileged`，授权结果一律为"需要批准"。
  Hub 另外检查：`args.runtime` 就是调用者；`args.job` 派给了它且还在执行。其他操作对 runtime 仍然拒绝。
- 执行器用 `GET /v1/runtime/privileged/<提议 ID>` 取回状态（`PrivilegedStatus`：待批准 / 已批准且附凭据 / 已拒绝 / 已失效）；
  只能取自己提交的提议。不改 `RuntimeSync`。
- 执行完后执行器用 `POST /v1/runtime/privileged` 回报（`PrivilegedReport`：退出码、时间；**不含输出**），记入审计。
- 接受提议时 Job 已经结束（或已取消）→ Hub 拒绝接受（409），提议标为失效。

### 3. 发起方式
- agent 在一轮之内运行 `lumio-runtime sudo -- <程序> [参数…]`。执行器为每一轮设置两个环境变量：
  本地 socket 路径与只对这一轮有效的随机凭据；不在一轮之内、凭据不对 → 直接拒绝。
  （不叫 `lumio sudo`：`lumio` 是查询笔记库的 CLI，与执行器是两个 app，不互相调用。）
- 调用者阻塞等待，最长 30 分钟（可配置）；超时、拒绝、失效都以非 0 退出并打印原因。批准后输出原样返回给调用者，退出码透传。
- 不经过 shell；助手程序用最小环境（固定的 `PATH`、工作目录 `/`）执行 argv，有超时。
- 没有 root 的执行器（如学校服务器）不配置助手程序：`lumio-runtime sudo` 立即返回"此执行器不支持提权"，不联系 Hub。

## 不做
- 审批模型、飞书批准（P3）；"同类命令自动批准"的规则；让 agent 直接用系统的 sudo。

## 后果
- 好处：即使 agent 与执行器同一账号，没有人的批准就拿不到 root；批准一次只能用一次；Hub 不必连接执行器，契约只增不改。
- 代价：服务器上要由人用 root 装一次助手程序、配置文件和 sudoers；Hub 多一把签名密钥，备份文件因此更敏感（本来就含令牌哈希，权限 0600）。
  密钥丢失只需重新生成并更新服务器上的公钥。

## 修订记录
- 2026-10-26：按 P2-6 任务实现签名凭据、runtime 本地通道、root 助手与审计；自动验收通过，人工服务器验收待办。
