# 0021 安装、配对与自检：用户不需要手抄命令

- 状态：Accepted（人类 2026-10-28 确认方向：仓库公开，用 GitHub Releases 发布；Mac 上继续用 launchd；Nix 以后再做）
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

### 2. Mac：一条命令装好 Hub 和 CLI
- `curl -fsSL https://raw.githubusercontent.com/wicsp/Lumio/main/install.sh | sh` 在 Mac 上装好三个程序后运行 `lumio-hub setup`。
- `lumio-hub setup` 可重复运行（第二次就是修复或升级）：找到 vault（默认 iCloud 里的 Obsidian `Lumio`）、建状态目录、
  没有 human 身份就建一个、为 CLI 生成令牌并写进 **CLI 配置文件**、按本机实际路径写 launchd plist 并启动、等待 `/health`。
  读 iCloud 目录被系统拦住时，明确告诉人去"完全磁盘访问权限"里加哪个程序。
- Tailscale：检测 `tailscale serve` 是否已把 Hub 转发出去；没有时询问后开启，并记下 Hub 的远程地址（配对时要用）。
- **CLI 配置文件** `~/.config/lumio/config.json`（权限 0600）：Hub 地址、令牌、vault 路径。优先级：环境变量 > 配置文件。
  有了它，任何终端里的 `lumio` 都能直接用。

### 3. 加一台服务器：一次性配对码
- Mac 上 `lumio runtime add <名称>` → Hub 建 runtime 身份（已有则沿用），生成一个**一次性配对码**（随机 128 位，10 分钟有效，
  只能用一次，Hub 只存哈希），CLI 打印**一行**命令：
  `curl -fsSL …/install.sh | sh -s -- runtime --hub <Hub 远程地址> --code <配对码>`。
- 服务器上这行命令：下载 Linux 程序 → `lumio-runtime join` 用配对码向 Hub 换取令牌（`POST /v1/runtime/join`，不需要令牌，
  只认配对码）→ 写 `runtime.env`（0600，包含**当时 shell 的 PATH**，这样 systemd 里也找得到 codex、claude、pi）→
  写 systemd 用户服务并启动 → 等到登记成功，打印检测到的 agent。
- 同一个名称重新配对 = 吊销这个身份原来的令牌，换新的（服务器重装、令牌泄露时用）。
- 配对码出现在服务器的 shell 历史里：10 分钟过期、只能用一次，可以接受。join 失败次数有上限，日志里不记配对码。
- 有 root 的服务器再运行一次 `sudo lumio-runtime install-sudo-helper`：从 Hub 取签名公钥，**打印公钥指纹让人和 Mac 上
  `lumio-hub signing-key` 的输出对一眼**（`~/.local/bin` 里的程序与 agent 同一账号，理论上可被替换，所以安装要在派活之前、由人确认），
  再装助手程序、`/etc/lumio/sudo.json`、sudoers（先 `visudo -c` 校验），并把 `LUMIO_RUNTIME_SUDO_COMMAND` 写进 `runtime.env`。

### 4. 自检代替手动清单
- `lumio doctor`（Mac）：配置、Hub、令牌、Tailscale、vault 权限、各执行器在线情况与 agent、Hub 状态里的问题、例行任务的问题，
  逐项列出"正常 / 不正常 + 怎么修"。`lumio-runtime doctor`（服务器）：配置、连 Hub、服务状态、agent 与 PATH、提权助手。
- `lumio selftest [--runtime <名称>]`：经 Hub 用**真实 agent** 跑一遍关键路径，每项给出通过或失败：
  能执行并取到汇报、接着同一会话继续、`<lumio-question>` 被识别、取消能停下；可选 `--notes` 在 vault 里建一篇临时任务笔记，
  验证"改 turn → 派出 → 结果写回"。不改动工作目录以外的东西，自检的笔记标明来源，做完把状态改为 `done`（不删除）。
- 升级：`lumio upgrade`（Mac：替换程序并重启 Hub）、`lumio-runtime upgrade`（服务器：替换程序并重启服务）。

## 不做
- Nix flake / home-manager 模块（两台服务器以后都会装 Nix，到时作为另一种安装方式，不替代 install.sh）。
- 自动更新、Hub 远程让执行器升级、Windows。

## 后果
- 好处：Mac 一行、每台服务器一行，之后一条 `lumio doctor` / `lumio selftest` 就知道是否正常；令牌不经过人手。
- 代价：多了发布流程（CI、标签、install.sh）；Hub 多一个不需要令牌的接口（配对），需要限制尝试次数；
  `install.sh` 以 `curl | sh` 的方式运行，信任 GitHub 上的这个仓库（与直接 clone 源码编译相同）。
