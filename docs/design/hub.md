# Hub：职责、存放、部署与迁移

> 现行设计分册，只写现在生效的规则；总览、跨模块规则与写法见 [`../DESIGN.md`](../DESIGN.md)。

## Hub 的职责（ADR 0007、0014）
- **程序写入的唯一裁判**：修改已有内容的程序写入（接受提议、更新程序字段）必须经过 Hub，没有 Hub 时不能用。
- **人可以直接改文件**：Hub 监听 vault，自动补全并重建索引；frontmatter 不合法时提醒人，不拒绝、不覆盖人的改动。
- 新建笔记和补全元数据（`lumio new`、`lumio sync`）不需要 Hub，性质等同于人新建文件。
- 知识查询两种模式都支持：设置 `LUMIO_HUB_URL` 时走 Hub，否则直接读本地 vault；规则与用例在 Knowledge，文件和索引在 Storage，两边共用。
- 数据库 Work/Assistant 经 Hub 使用；未配置知识目录时 Hub 不启动文件监听，知识查询给出未配置说明（ADR 0025）。

## 存放
- Hub 的运行数据放在 `~/.local/share/lumio/`（可配置），**不在 vault、不在同步目录里**：
  `index.sqlite`（派生索引，可重建）、`hub.sqlite`（身份、令牌、提议、审计、Job、数据库 Work 和 Assistant，需要备份）。
  `lumio hub backup <目标文件>` 仍提供旧数据库单文件备份；完整业务备份用 `lumio hub backup business <新目录>`，
  以数据库一致性快照确定 ready 托管文件，复制文件并生成校验清单（ADR 0014、0016、0025）。
- `lumio hub backup verify <目录>` 校验清单、数据库和引用文件；`lumio hub restore business <备份目录> <新状态目录>` 只恢复到新目录。
  拒绝缺失或被篡改的文件、重复清单与符号链接，不覆盖已有状态。知识目录与安装配置单独备份，索引可重建（ADR 0025）。
- Hub 与离线迁移通过同一业务目录的 SQLite OS 租约互斥；进程崩溃自动释放锁，不删除锁文件或凭 PID 猜测锁失效。

## 部署（ADR 0007、0017、0021、0022）
- **两种模式，都只有一个 Hub**：
  - **单机模式（默认）**：Hub、vault、执行器在同一台机器（macOS 或 Linux），Hub 只听 `127.0.0.1`，不需要任何网络配置。
  - **服务器模式（标准）**：Hub 与 vault 在服务器上，像普通自托管软件一样部署；其他机器作为 CLI 客户端和执行器主动连接 Hub。
- **网络由部署者负责**：Hub 只讲 HTTP；监听地址（`LUMIO_HUB_LISTEN`）与对外地址（`LUMIO_PUBLIC_URL`）由部署者设置，
  HTTPS 推荐放 Caddy 等反向代理（文档有示例）。非本机监听且对外地址是 `http://` 时只警告、不拒绝。
  Tailscale 等私有网络是补充：`setup` 检测到时可以帮忙填对外地址，核心代码不依赖它。
- **安装**（ADR 0021、0027）：打 `v*` 标签时 CI 为每个平台编译一个 `lumio`（嵌入 Web 资源）发布到 GitHub Releases；`install.sh` 下载、校验、装到 `~/.local/bin` 并建立 `lumio-hub`、`lumio-runtime` 兼容链接，
  为兼容 v0.1.x 升级器，压缩包保留三个普通文件：主程序与两个固定 shell 转发垫片；新安装器/升级器逐字节核对垫片后建立符号链接。从 v0.1.x 升级须执行两次 upgrade：第一次安装主程序与垫片，第二次转换链接、改写服务文件并显示切换提示。
  再运行 `lumio hub setup`（可重复运行；`--server` 为服务器模式）：vault 路径、身份、CLI 配置文件 `~/.config/lumio/config.json`、
  Hub 与本机执行器的后台服务（macOS：launchd；Linux：systemd 用户服务；服务命令为 `lumio hub serve`、`lumio runtime serve`，进程仍分开）。Web 由 Hub 在自己的地址上提供，没有单独的 Web 服务（ADR 0027）。
  加执行器：`lumio runtime add <名称>` 生成一次性配对码（10 分钟、一次有效），那台机器上 `lumio runtime join` 换取令牌并装好后台服务；
  客户端配对码优先返回 Hub 对外地址，未配置时返回供本机客户端使用的地址（I1-7a）。另一台机器上的 CLI 用 `lumio login`。`lumio doctor`、`lumio runtime doctor` 检查安装（含 Web 服务与助手配置）；`lumio selftest` 用真实 agent 和数据库任务验证关键路径；`upgrade` 升级（从 v0.1.x 升级时替换为单个程序并改写本机服务文件）。
  `upgrade` 始终直接升到目标版本（默认最新），已是该版本时不下载；发布包格式或安装布局变化时，上一个已发布版本的升级程序必须能直接完成升级（ADR 0028）。
  Release 附 Ed25519 签名的发布清单，`upgrade` 与 Runtime 自更新先验签再核对哈希；`install.sh` 首次安装仍只校验 SHA-256（ADR 0063）。
  Hub 机器上，本机 Runtime 声明 `self_update` 时 `upgrade` 与 `deploy-local` 只重启 Hub，Runtime 空闲后自己重启；远端 Runtime 跟随 Hub 的期望版本自动更新，见 [execution.md](execution.md#runtime-版本与自动更新adr-0063u1-0)。
  Hub 在状态目录 `updates/` 保存供 Runtime 下载的更新产物，只保留当前与上一个期望版本；正式版本由 Hub 从 Releases 取来缓存，开发构建由 `deploy-local` 交叉编译、签名后写入（ADR 0063）。
  从旧笔记模式切到数据库任务：不需要保留旧任务时 `lumio hub switch --retire-legacy` 一条命令退役旧笔记（不导入、不改文件，ADR 0027）；需要导入时按 `docs/migration-v2.md`。
  Nix 以后作为另一种安装方式。作者自己的用法见 `docs/personal-setup.md`。
- 只信任配置过的反向代理传来的客户端信息。
- 飞书 Bot 用官方 SDK 的长连接，不需要公网回调地址。

## 旧数据迁移与切换（ADR 0025、0027）

- `lumio hub migrate plan/apply/retire/sources/source` 提供显式迁移，完整步骤见 [切换与回退](../migration-v2.md)。
  apply 要求匹配的完整备份、源摘要和设备准备确认，并与 Hub 独占同一状态目录；原始字节和未知字段进入来源档案。
  第一次成功 apply 或 retire 后关闭整个工作区的旧 Task/Routine 文件控制与旧委派/追问；知识文件继续可编辑，不再由旧字段覆盖数据库。
- Runtime 与离线准备也持有独占状态租约。`prepare-migration --state-dir <目录>` 只在执行器停止且无待执行/交付数据时清空派生计划缓存。
  retire 在独占状态目录下自动完整备份并验证，只写退役回执（kind/时间/备份/数量/路径摘要），不导入或改写旧笔记；仍有未结束的旧笔记 Job 时拒绝。已有任何回执时 apply/retire 都拒绝，并说明切换时间与方式（ADR 0027）。
  迁移仅导入已处理历史关联与已经暂停的 Routine，不生成 Job 或重放工具/审批；下一轮取历史最高轮次加一。

## AI 配置与原生会话状态（ADR 0041、0042、0047）

- Hub 的 AI 配置与原生组合适配器使用新增业务表保存 Profile、Connection 私有 API 密钥、冻结绑定、交付和事件回执；API 客户端只拿不含凭据的视图。Runtime 原生状态、官方认证与事件 outbox 单独保存在执行器私有目录，不由 Hub 重建。
- 原生通道使用 runtime 身份。协商支持后，连接授权状态通过关联的命令回执返回且不持久化设备码；变更仅限连接所有者。MCP 是独立范围凭据，不能复用普通 Hub 接口。业务备份仍需一致性快照，原生认证按设备私有数据另行保护。
- 本机只部署到日常实例 7420。更新前备份，原位更新时保留业务库、配置、凭据和已有功能。隔离测试使用合成数据与临时端口，见[本机部署流程](../local-deployment.md)。
