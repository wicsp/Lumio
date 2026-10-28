# 0021 安装、配对与自检：用户不需要手抄命令

- 状态：Accepted（人类 2026-10-28 确认方向：仓库公开，用 GitHub Releases 发布；Mac 上继续用 launchd；Nix 以后再做）；第 2、3 节按 ADR 0022 修订
- 日期：2026-10-28
- 领域：Hub 与运行、安全、流程
- 影响：ADR 0017（部署）、ADR 0019（执行器登记）、ADR 0020（root 助手的安装）；`packages/schema` 新增 setup.ts

## 背景
P2 的功能都已实现，但第一次手动验收就卡在安装上：
- Hub、执行器、CLI 都要人手动编译、复制、签名，再手写 launchd/systemd 配置（`infra/` 里只有模板）；
- CLI 只认环境变量 `LUMIO_HUB_URL`、`LUMIO_TOKEN`，每个终端都要 export；
- 接入一台服务器要在 Mac 上建身份、生成令牌，再把令牌和 Tailscale 地址抄进服务器的配置文件；
- 服务器要装 Bun、从源码编译；
- 出了问题只能翻日志；验收是一份长清单。
人类的要求：作为用户使用时，不应该贴这么多命令。这是自用工具，装不起来，功能写得再对也没用。

## 决定

### 1. 发布编译好的程序
- 打 `v*` 标签时由 GitHub Actions 编译 `lumio`、`lumio-hub`、`lumio-runtime`，平台 `darwin-arm64`、`linux-x64`、`linux-arm64`，
  每个平台一个压缩包，附 `SHA256SUMS`。macOS 的程序在 macOS runner 上编译并做 ad-hoc 签名（编译出来的程序在 macOS 上被系统杀过）。
- 版本号来自标签，编译时注入；`/health`、`--version`、`lumio doctor` 都显示它。
- 仓库根目录的 `install.sh`：识别平台 → 下载 → 校验 SHA256 → 装到 `~/.local/bin` → 接着执行对应的设置命令。
  不需要 Bun、不需要源码。从源码开发的人照旧用 `bun run …`。

### 2. 一条命令装好 Hub、CLI 和本机执行器（单机模式，ADR 0022）
- `curl -fsSL https://raw.githubusercontent.com/wicsp/Lumio/main/install.sh | sh` 在 macOS 或 Linux 上装好三个程序后运行 `lumio-hub setup`。
- `lumio-hub setup` 可重复运行（第二次就是修复或升级）：
  - 询问 vault 放在哪（默认 `~/.config/lumio/vault`，不存在就建；可用 `--vault` 指定，如作者在 iCloud 里的 vault）；
  - 建状态目录；没有 human 身份就建一个；为 CLI 生成令牌并写进 **CLI 配置文件**；
  - 把 Hub 装成后台服务：macOS 用 launchd，Linux 用 systemd 用户服务；按本机实际路径生成配置并启动，等待 `/health`；
  - **同时在本机装一个执行器**（名称为主机名，直接建 runtime 身份与令牌，不需要配对码），这样单机模式下派活、例行任务开箱即用；
  - macOS 上读 iCloud 等受保护目录被系统拦住时，明确告诉人去"完全磁盘访问权限"里加哪个程序。
- `--server`：服务器模式，额外询问监听地址（`LUMIO_HUB_LISTEN`）与对外地址（`LUMIO_PUBLIC_URL`），打印 Caddy 反向代理的示例配置；
  对外地址是 `http://` 时提示风险，但照常继续（网络由部署者负责）。检测到 Tailscale 时可以帮忙把对外地址填成 Tailscale 的地址（补充功能）。
- **CLI 配置文件** `~/.config/lumio/config.json`（权限 0600）：Hub 地址、令牌、vault 路径。优先级：环境变量 > 配置文件。
  有了它，任何终端里的 `lumio` 都能直接用。另一台机器上的 CLI 用 `lumio login <Hub 地址>` 配置（同样走一次性配对码，见下）。

### 3. 加一台执行器：一次性配对码
- 在任意已配置好的 CLI 上运行 `lumio runtime add <名称>` → Hub 建 runtime 身份（已有则沿用），生成一个**一次性配对码**
  （随机 128 位，10 分钟有效，只能用一次，Hub 只存哈希），CLI 打印**一行**命令：
  `curl -fsSL …/install.sh | sh -s -- runtime --hub <LUMIO_PUBLIC_URL> --code <配对码>`。没有设置 `LUMIO_PUBLIC_URL` 时说明要先配置对外地址。
- 在那台机器上运行这行命令：下载程序 → `lumio-runtime join` 用配对码向 Hub 换取令牌（`POST /v1/runtime/join`，不需要令牌，
  只认配对码）→ 写 `runtime.env`（0600，包含**当时 shell 的 PATH**，这样后台服务里也找得到 codex、claude、pi）→
  装成后台服务（Linux：systemd 用户服务；macOS：launchd）并启动 → 等到登记成功，打印检测到的 agent。
- 同一个名称重新配对 = 吊销这个身份原来的令牌，换新的（服务器重装、令牌泄露时用）。
- 配对码出现在服务器的 shell 历史里：10 分钟过期、只能用一次，可以接受。join 失败次数有上限，日志里不记配对码。
- 有 root 的服务器再运行一次 `sudo lumio-runtime install-sudo-helper`：从 Hub 取签名公钥，**打印公钥指纹让人和 Hub 所在机器上
  `lumio-hub signing-key` 的输出对一眼**（`~/.local/bin` 里的程序与 agent 同一账号，理论上可被替换，所以安装要在派活之前、由人确认），
  再装助手程序、`/etc/lumio/sudo.json`、sudoers（先 `visudo -c` 校验），并把 `LUMIO_RUNTIME_SUDO_COMMAND` 写进 `runtime.env`。

### 4. 自检代替手动清单
- `lumio doctor`：配置、Hub、令牌、对外地址（是否可达、是否为 HTTP）、vault 权限、各执行器在线情况与 agent、Hub 状态里的问题、例行任务的问题，
  逐项列出"正常 / 不正常 + 怎么修"。`lumio-runtime doctor`（执行器所在机器）：配置、连 Hub、服务状态、agent 与 PATH、提权助手。
- `lumio selftest [--runtime <名称>]`：经 Hub 用**真实 agent** 跑一遍关键路径，每项给出通过或失败：
  能执行并取到汇报、接着同一会话继续、`<lumio-question>` 被识别、取消能停下；可选 `--notes` 在 vault 里建一篇临时任务笔记，
  验证"改 turn → 派出 → 结果写回"。不改动工作目录以外的东西，自检的笔记标明来源，做完把状态改为 `done`（不删除）。
- 升级：`lumio upgrade`（替换本机程序并重启 Hub 与本机执行器）、`lumio-runtime upgrade`（执行器所在机器：替换程序并重启服务）。

## 不做
- Nix flake / home-manager 模块（两台服务器以后都会装 Nix，到时作为另一种安装方式，不替代 install.sh）。
- 自动更新、Hub 远程让执行器升级、Windows。

## 后果
- 好处：装 Hub 一行、每台执行器一行，之后一条 `lumio doctor` / `lumio selftest` 就知道是否正常；令牌不经过人手。
- 代价：多了发布流程（CI、标签、install.sh）；Hub 多一个不需要令牌的接口（配对），需要限制尝试次数；
  `install.sh` 以 `curl | sh` 的方式运行，信任 GitHub 上的这个仓库（与直接 clone 源码编译相同）。

## 修订记录
- 2026-10-28：按 ADR 0022 修订第 2、3 节（人类批准）：不再假设 Mac 与 iCloud/Obsidian；setup 同时支持 macOS 与 Linux，并在本机装执行器；`--server` 服务器模式；Tailscale 降为补充；配对地址统一取 `LUMIO_PUBLIC_URL`；执行器在 macOS 上用 launchd；新增 `lumio login`。
