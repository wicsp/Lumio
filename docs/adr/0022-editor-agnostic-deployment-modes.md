# 0022 编辑器无关；两种部署模式；网络由部署者负责

- 状态：Accepted（人类 2026-10-28 确认）
- 日期：2026-10-28
- 领域：数据、Hub 与运行、安全
- 影响：取代 ADR 0017 第 1 节中"不存在两边各有一份"、第 4 节（Tailscale 作为远程访问方式）、第 5 节；
  修订 ADR 0021 第 2、3 节（Tailscale 降为补充）；ADR 0018（链接写法）；`packages/schema` 的 `LinkSource`

## 背景
Lumio 要开源给别人用。讨论 ADR 0021 的安装设计时发现几处只适合作者自己环境的假设：
- vault 默认在 iCloud 的 Obsidian 目录、设计里多处写死 Obsidian；
- 远程执行器连 Hub 依赖 Tailscale——原因是 Hub 放在 Mac 上，Mac 在 NAT 后面；
- 链接只认 Obsidian 风格的 `[[ ]]`。
人类的判断：Obsidian 只是一个文本编辑器，VS Code 或任何编辑器都可以；正式的编辑方式以后由 Lumio 官方 GUI 提供；
网络与证书按主流自托管软件的做法交给部署者，不替用户包办。

## 决定

### 1. 编辑器无关
- vault 就是一个装 Markdown + YAML frontmatter 的普通文件夹。Lumio 不读写、不同步、不依赖任何编辑器的配置
  （如 `.obsidian/`）；编辑器配置由用户自己管理（作者用 iCloud 同步 Obsidian 的配置）。
- 用外部编辑器直接改文件是**最不正式**但一直支持的用法；**正式的编辑方式是 Lumio 官方 GUI**（以后的切片，P4 的 Web 计划扩展为编辑界面）。
- 链接：**同时识别** `[[文件名]]`（按文件名解析）与标准 Markdown 链接 `[文字](相对路径.md)`（按路径解析）；用哪种由人决定。
  Lumio 自己仍不写链接（ADR 0018）。
- 改名：任何编辑器都可以改名，造成的断链由 `lumio check` 列出（ADR 0018 不变）；官方 GUI 以后经 Hub 的改名操作同时更新引用。

### 2. 两种部署模式
- **单机模式（默认）**：Hub、vault、执行器在同一台机器（macOS 或 Linux）。Hub 只听 `127.0.0.1`，不需要任何网络配置。
  `install.sh` 装完就是这个状态。
- **服务器模式（标准）**：Hub 与 vault 在一台服务器上，像普通自托管软件一样部署；其他机器（包括 Mac）作为 CLI 客户端和执行器，
  **主动连接** Hub（与 GitHub Actions runner 等相同的结构）。
- 两种模式都**只有一个 Hub**。vault 文件夹可以被任何外部工具（git、Syncthing、Nextcloud、iCloud……）同步到别的设备上编辑，
  同步进来的修改对 Hub 来说就是人改了文件（与现在 iPad 经 iCloud 修改相同）。同步工具自己的冲突由同步工具或人处理；
  Hub 只保证自己不在中途覆盖文件（已有的 expectedContent 安全写入）。Lumio 不做自己的双向同步。

### 3. 网络由部署者负责
- Hub 只讲 HTTP。默认只听 `127.0.0.1`；部署服务器时由部署者设置监听地址（`LUMIO_HUB_LISTEN`）与对外地址（`LUMIO_PUBLIC_URL`）。
- 是否加 HTTPS、怎么开端口由部署者决定。文档给出 Caddy 自动证书的示例。Hub **不拒绝**非本机的 HTTP 监听：
  对外地址是 `http://` 且不是本机地址时，启动日志与 `lumio doctor` 给出警告，照常运行。
- 配对命令里的 Hub 地址统一取 `LUMIO_PUBLIC_URL`，不关心它是公网域名、内网 IP 还是 VPN 地址。
- **私有网络是补充**：Tailscale、ZeroTier、WireGuard 等都可以提供这个地址。`lumio-hub setup` 检测到 Tailscale 时可以帮忙填写
  （`tailscale serve` 或 Tailscale 地址），但核心代码不依赖它。不做 SSH 隧道。

### 4. 默认路径
- vault 默认放在 `~/.config/lumio/vault`（与 CLI 配置同一个目录）；第一次运行 `lumio-hub setup` 时询问，可以改成任意路径
  （作者自己的 vault 在 iCloud 里，指定那个路径即可）。路径记在 CLI 配置文件里。
- 作者自己的用法（iCloud、Obsidian 设置、Tailscale）写在 `docs/personal-setup.md`，不属于软件设计。

## 后果
- 好处：别人照着主流方式就能部署；不绑定任何编辑器或网络工具；作者现在的用法仍然完全支持（单机模式 + 指定 iCloud 里的 vault + Tailscale 补充）。
- 代价：服务器模式下，不同设备之间怎么同步 vault 交给用户自己选，Lumio 只给建议；默认 vault 在隐藏目录 `~/.config` 下，
  Finder 默认看不到，`setup` 结束时要把完整路径打印出来。
