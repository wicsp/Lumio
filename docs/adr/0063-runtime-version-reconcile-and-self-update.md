# 0063 Runtime 跟随 Hub 版本：期望版本对账与空闲自更新

- 状态：Accepted（2026-11-12 人类批准方向与本文全部决定）
- 实施状态：U1-1～U1-5 已实现后端与发布部署链路（第 1～4、6～7 节及第 5 节 CLI/通知）；第 5 节 Web 界面由 U1-6 接续。
- 日期：2026-11-12
- 领域：Hub 与运行、发布与升级兼容、安全、HTTP 契约
- 关联：[ADR 0019](0019-hub-runtimes-tasks-rounds.md)、[ADR 0020](0020-privileged-exec-signed-approvals.md)、[ADR 0021](0021-install-pairing-selftest.md)、[ADR 0027](0027-v0.2-rollout.md)、[ADR 0028](0028-language-terminal-theme.md)、[ADR 0042](0042-native-agent-sessions.md)、任务 [U1-0](../tasks/U1-0-runtime-auto-update.md)

## 背景

- 现在升级 Runtime 要人去每台机器上运行 `lumio-runtime upgrade`。Hub 已经升级而服务器上的 Runtime 还停在旧版本的情况经常出现，而且没有地方能看出来：`RuntimeRegistration` 只登记引擎和能力，不登记 Runtime 自己的版本。
- 在 Hub 所在的机器上，Hub 和本机 Runtime 共用同一个 `~/.local/bin/lumio`。`lumio upgrade` 换完程序后会立刻重启 Runtime 服务，不管它是否正在执行；`scripts/deploy-local.ts` 则要求 Runtime 空闲，否则就拒绝部署。前者会中断工作，后者会挡住 Hub 的部署。
- 日常实例从 `main` 构建，版本形如 `x.y.z-dev.local.<sha>`。这种构建只存在于 Hub 机器上，GitHub Releases 里没有，所以远端 Runtime 无法从 GitHub 得到同一个版本。
- 发布包只附 `SHA256SUMS`，它和压缩包来自同一个地方，只能防止传输损坏，不能证明是谁发布的。一旦 Runtime 会按 Hub 的指示自动换程序，更新通道就等于一条远程执行代码的通道，而 Runtime 手里有 agent 权限，还可能有高权限助手。
- 作者计划以后用 Nix 管理服务器；开源用户也可能通过 brew、docker 或从源码运行。这些安装方式由包管理器负责程序文件，Runtime 不能自己去改。

## 决定

### 1. 期望版本与对账，不推一次性的更新任务

- Hub 为每个 Runtime 声明一个**期望版本**，默认等于 Hub 自己的版本（策略 `follow`）。人可以把某个 Runtime 改成 `manual`，这时 Hub 只显示它落后了，不下发期望版本。策略属于 Hub 的执行配置，由 human 修改并记入审计。
- 期望版本放在同步回复里（只发给声明了 `self_update` 能力的 Runtime，旧 Runtime 不会收到不认识的字段，做法和 `job-access` 一样）。Runtime 每次同步时比较期望版本与自己的版本，不一致就自己去收敛。离线的机器重新上线后自然会对上。重复下发或中途失败都不需要特殊处理，同一个期望版本反复执行的结果是一样的。
- 更新**不是** Work 任务，也不是 Job：不占用任务、轮次、审批和 agent。Job 协议仍为 2。
- Runtime 在登记里报告自己的版本、平台、安装方式和 `self_update` 能力，在心跳里报告更新状态（第 5 节）。Hub 和 Web 据此显示每台 Runtime 的版本、是否落后、正卡在哪一步。

### 2. 安装方式决定 Runtime 能做什么

Runtime 启动时判断自己属于下面哪一种，登记给 Hub：

| 安装方式 | 判断 | 收敛时做什么 |
|---|---|---|
| `hub-shared` | 运行的程序是 `~/.local/bin/lumio`，且本机的 Hub 服务指向同一个程序 | **不下载、不替换程序**。程序由 Hub 一侧的 `lumio upgrade` 或 `deploy-local` 负责；Runtime 发现磁盘上的程序版本与正在运行的不同，就在空闲时重启自己 |
| `managed` | 运行的程序是 `install.sh` 或 `upgrade` 管理的 `~/.local/bin/lumio`，本机没有 Hub 服务 | 下载、验签、替换并重启（第 3、4 节） |
| `external` | 其他情况：Nix store、Homebrew、容器、`bun` 源码运行，或环境变量 `LUMIO_RUNTIME_AUTO_UPDATE=off` | 什么都不改，只报告落后；由部署者用自己的包管理方式升级 |

判断规则写在 Runtime 里，Hub 不替 Runtime 猜安装方式。

### 3. 程序从哪里来、怎么证明可信

- **正式版本签名**：发布时由 CI 生成发布清单 `manifest.json`，写明格式版本、版本号、来源提交、构建时间以及各平台压缩包的文件名、大小和 SHA-256，再用 Ed25519 私钥签出 `manifest.sig`，一起上传到 Release。私钥只存放在 GitHub Actions 的密钥里；公钥在编译时写进程序。验签使用 `node:crypto` 自带的 Ed25519，不引入新依赖。
- **本机开发构建签名**：`deploy-local` 用部署者的构建签名密钥签出同样格式的清单。这把密钥放在 `~/.config/lumio/build-signing/`（权限 `0600`），不在 Hub 状态目录和 vault 里，Hub 的任何接口都读不到它。远端 Runtime **默认不信任**开发构建；要信任，人在那台机器上运行一次 `lumio runtime trust-build-key`，并核对指纹（做法与高权限助手核对 Hub 签名公钥相同，ADR 0021）。没有信任时，期望的开发构建版本显示为"未信任的构建"，Runtime 继续运行当前版本。
- **Hub 只给版本号，不给信任**：同步里只下发版本号。Runtime 只接受由内置正式公钥或本机已信任的构建公钥签过的清单，并按清单核对压缩包的大小和 SHA-256。所以 Hub 被攻破也不能让 Runtime 装上任意程序。
- **Hub 中转下载**：Hub 维护一个更新产物库，Runtime 优先从 `/v2/execution/updates/…` 拉清单和压缩包（只有 runtime 身份能读），拉到后照样验签。正式版本由 Hub 从 GitHub Releases 取来缓存（走 Hub 服务环境的代理设置），只下载一次；Hub 取不到时，`managed` 的 Runtime 可以直接向 GitHub 取正式版本。开发构建只能经 Hub 取得：`deploy-local` 为已登记的 `managed` 远端 Runtime 所用的平台交叉编译，签名后放进产物库。
- **存储上限**：Hub 产物库只保留当前期望版本和上一个版本；Runtime 只保留已暂存的新版本和替换下来的上一个版本，不会随着构建越积越多。
- **首次安装**：`install.sh` 仍只校验 SHA-256（首次安装信任 TLS 和 GitHub）；之后的 `upgrade` 和自更新都要求清单签名。开始签名之后的第一个正式版本，其 `upgrade` 仍接受没有签名的旧版本发布，以便回退。

### 4. 切换：空闲、排空、原子替换、确认或回退

1. **下载与预检**（不影响正在跑的工作）：后台下载到 Runtime 状态目录的 `update/staged/<版本>/`，验签、核对哈希、解包后检查文件类型，然后执行新程序的 `--version`（必须等于期望版本）和只读自检 `runtime update-check`（读取现有配置、只读打开状态库、确认能理解本地队列格式）。任何一步失败都标为 `failed` 并报告原因，不替换。
2. **等空闲**：空闲指没有正在执行的 Job、没有进行中的原生会话轮次、没有正在运行的钩子或高权限请求。只有打开着但当前没有轮次的原生会话不算忙，因为它可以按 ADR 0042 恢复原线程。待交回的结果和文件会持久保存，也不算忙。
3. **排空**：准备好后等待自然空闲最多 30 分钟。到时还不空闲，就进入 `draining`：Hub 不再给它指派新的 Job 和原生轮次（委派仍然成立，这一轮在它重启上线后开始，与离线时的规则相同），Runtime 本地也暂缓启动已排队的 Job，到点的例行任务推迟到重启后（沿用"错过只补跑最近一次"）。**不杀正在执行的工作**。排空超过 2 小时，Hub 发通知给人，人可以选择"暂缓这次更新"或"立即重启（会中断进行中的工作）"；中断的轮次按现有规则标为 `unknown`。
4. **替换**（仅 `managed`）：把当前程序复制到 `update/previous/`，写下待确认标记（目标版本、上一个程序、尝试次数），然后用同目录 rename 原子替换 `~/.local/bin/lumio`（兼容链接不变），再以约定的退出码正常退出，由 launchd（`KeepAlive`）或 systemd（`Restart=always`）拉起新程序。`hub-shared` 跳过替换，直接正常退出重启。
5. **确认或回退**：新程序在 `runtime serve` 的最早阶段，在任何其他初始化之前，读取待确认标记并把尝试次数加一；成功向 Hub 登记并完成一次同步后，删除标记，报告成功。连续 3 次启动都没能确认，就把 `update/previous/` 的程序原子换回并退出，由服务管理器拉起旧版本；旧版本报告 `failed`（含失败的目标版本），之后不再自动重试这个版本，直到期望版本变化或人点"重试"。Hub 不可达不算失败：确认等到 Hub 可达，不计入尝试次数。

### 5. 状态与可见性

- 心跳中的更新状态：`current`、`downloading`、`staged`、`waiting_idle`、`draining`、`restarting`、`failed`、`blocked`（`external`，或开发构建没有被信任），附目标版本、开始时间和面向人的原因。
- `lumio runtime list`、`lumio doctor` 和 Web「设置 → Hub 与执行器」显示每台 Runtime 的版本、安装方式、策略和更新状态。`failed`、`blocked` 和排空超时会通过统一通知接口提醒人。

### 6. 版本兼容

- 升级顺序总是 Hub 先、Runtime 后，离线的机器会落后更久。新 Hub 必须继续接受上一个正式版本的 Runtime 登记、同步和交回；协议上的新增一律通过可选字段和能力声明协商。
- 不支持 `self_update` 的旧 Runtime 照常工作，Hub 只显示"需手动升级"。每台现有 Runtime 需要手动 `lumio-runtime upgrade` 一次，升到带自更新的版本，之后才由 Hub 带着走。
- Hub 回退版本时，期望版本随之变旧，Runtime 允许降级，但只接受签过名的清单。不做更严格的防回滚（比如拒绝签过名的旧版本），代价见下文。
- 高权限助手（ADR 0020）是 root 安装的独立程序，Runtime 自更新不会替换它。新版本的 Runtime 发现助手版本不兼容时，不再声明 `privileged_helper` 能力，并提示人运行 `sudo lumio-runtime install-sudo-helper`。

### 7. Hub 机器上的升级不再顺带重启忙碌的 Runtime

- `lumio upgrade` 在 Hub 机器上替换程序后，如果本机 Runtime 声明了 `self_update`，就只重启 Hub，由 Runtime 在空闲时自己重启；旧 Runtime 维持现在的立即重启。
- `deploy-local` 改为只要求 Hub 空闲，不再因 Runtime 忙碌而拒绝部署，也不再自行重启 Runtime。部署后的验收改为：Hub 健康，Runtime 已收到新的期望版本；Runtime 在空闲后切换。脚本报告每台 Runtime 当时的更新状态，不等待。

### 否决的做法

- **推送一次性更新任务**：机器离线时任务会丢，或者需要另做补发；任务失败的处理也得单独设计。期望版本对账天然解决这两点。
- **Hub 下发下载地址并以 Hub 为信任来源**：Hub 被攻破就等于所有 Runtime 被攻破。
- **改用版本目录加 `current` 软链的安装布局**：回退更自然，但要同时改 `install.sh`、`upgrade`、`deploy-local`、服务文件和所有已有安装，代价大于收益。保留 `~/.local/bin/lumio` 单文件布局，用 `previous` 副本加待确认标记实现回退。
- **对 Nix、brew 安装也自更新**：会破坏包管理器的不可变安装和回滚，只报告不修改。

## 后果

- 好处：Hub 升级后，各 Runtime 会在不打断工作的前提下自动跟上，不需要人登录每台机器；版本落后一眼可见；部署 Hub 不再被 Runtime 的长任务挡住；发布第一次有了来源签名。
- 代价：
  - 需要维护一把正式发布私钥（存放在 GitHub Actions 密钥中）和一把本机构建私钥；私钥丢失需要发新版本换公钥，泄露则需要发新版本并让用户手动升级。
  - `deploy-local` 要为远端 Runtime 交叉编译，增加部署时间和 Hub 产物库占用（只保留两个版本）。
  - 远端 Runtime 要信任开发构建，人必须在那台机器上做一次指纹确认。
  - Hub 机器的用户账户被攻破时，可以签出开发构建并推给已信任构建公钥的 Runtime。这与现状相同：同一账户已经能给这些 Runtime 委派有完整权限的 agent。
  - 只能保证签过名，不能防止回滚到签过名的旧版本。
  - 现有 Runtime 需要手动升级一次才能启用自更新。

## 修订记录
