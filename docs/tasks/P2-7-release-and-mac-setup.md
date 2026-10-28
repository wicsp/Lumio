# P2-7 发布编译好的程序；Mac 上一条命令装好

- 负责：后端（Codex）　Review：Claude
- 相关 ADR：**0021**（第 1、2 节，先读）、0017（部署）
- 涉及：`.github/workflows/`、`install.sh`（仓库根目录）、`apps/hub`、`apps/cli`、`infra/`、`README.md`
- 契约：`packages/schema/src/setup.ts` 的 `CliConfig`（已由 Claude 起草并合并，**不得修改**）
- 依赖：P2-6

## 目标
人在 Mac 上只运行：
```sh
curl -fsSL https://raw.githubusercontent.com/wicsp/Lumio/main/install.sh | sh
```
之后 Hub 已作为 launchd 服务运行（开机自启），任何终端里的 `lumio` 不设环境变量就能用。

## 范围

### 发布
1. `.github/workflows/release.yml`：推送 `v*` 标签时触发。
   - 在 macOS runner 上用 Bun **1.3.13**（`oven-sh/setup-bun`，写死版本）`bun install --frozen-lockfile`、`bun run check`，
     然后用 `bun build --compile --target=…` 编译 `apps/cli`、`apps/hub`、`apps/runtime` 的入口，平台 `darwin-arm64`、`linux-x64`、`linux-arm64`。
   - darwin 的三个程序 `codesign --force --sign -`。
   - 每个平台打一个 `lumio-<平台>.tar.gz`（内含 `lumio`、`lumio-hub`、`lumio-runtime`），生成 `SHA256SUMS`，上传到 Release。
   - 版本号：标签去掉 `v`，编译时用 `--define` 注入，替换现在从 `package.json` 读的 `0.0.0`。源码运行时仍显示 `0.0.0-dev`。
2. `.github/workflows/check.yml`：PR 与 main 上跑 `bun run check`（Linux 即可）。
3. 在 PR 描述里写明引入 `oven-sh/setup-bun` 这个 Action 的理由（AGENTS.md 第 5 条）。

### install.sh
4. POSIX sh，不依赖 bash。参数：无参数 = Mac 安装；`runtime --hub <地址> --code <配对码>` = 服务器安装（配对部分在 P2-8 实现，
   本切片只需把参数原样交给 `lumio-runtime join`，命令不存在时报错）。可选 `--version vX.Y.Z`（默认最新 Release）。
   - 识别平台（`uname -s`/`uname -m`），不支持的平台报错退出。
   - 下载压缩包与 `SHA256SUMS`，用 `shasum -a 256`（macOS）或 `sha256sum`（Linux）校验，不通过就退出、不安装。
   - 解压到临时目录，装到 `~/.local/bin`（不存在就建）；**不需要 sudo**。`~/.local/bin` 不在 PATH 时提示怎么加（不自动改 shell 配置）。
   - Mac：接着运行 `~/.local/bin/lumio-hub setup`。
   - 失败时说清楚哪一步失败；不打印下载到的内容。

### `lumio-hub setup`（apps/hub）
5. 可重复运行，第二次运行就是修复或升级，不会产生重复的身份或服务。步骤：
   - **vault**：`--vault <路径>` 或默认 `~/Library/Mobile Documents/iCloud~md~obsidian/Documents/Lumio`；不存在就报错并说明用 `--vault`。
   - **状态目录**：`~/.local/share/lumio`（0700）。已有 `hub.sqlite` 就沿用其中的身份与令牌。
   - **身份与 CLI 令牌**：没有 human 身份就建 `owner`；吊销名为 `cli@<主机名>` 的旧令牌并新建一个；写入 `~/.config/lumio/config.json`
     （`CliConfig`，权限 0600，目录 0700），`hub_url` 为 `http://127.0.0.1:7420`，`vault` 为上面的路径。令牌不打印到终端。
   - **launchd**：按本机实际路径生成 `~/Library/LaunchAgents/io.lumio.hub.plist`（程序路径用 `lumio-hub` 自身的绝对路径；
     环境变量 `LUMIO_VAULT`、`LUMIO_STATE_DIR`、`LUMIO_HUB_LISTEN`，`PATH` 包含 `git` 所在目录；日志写到状态目录）。
     已加载就先 `bootout`（忽略"未加载"的错误），再 `bootstrap`。用 `plutil -lint` 校验。
   - **等待** `/health` 最多 20 秒。失败时读 `hub-error.log` 的最后几行判断原因：读 vault 被拒（`EPERM`/`Operation not permitted`）→
     打印"系统设置 → 隐私与安全性 → 完全磁盘访问权限，加入 `<lumio-hub 的路径>`，然后重新运行 `lumio-hub setup`"；其他 → 打印日志位置。
   - **Tailscale**：找得到 `tailscale` 命令时，用 `tailscale serve status --json` 判断是否已有转发到 `127.0.0.1:7420` 的 HTTPS 服务；
     没有就询问（`[Y/n]`，非交互终端默认不开）是否运行 `tailscale serve --bg 7420`。用 `tailscale status --json` 得到本机的
     `https://<DNSName>`，写进 plist 的 `LUMIO_PUBLIC_URL`（P2-8 生成配对命令时用）。找不到 tailscale 就跳过并提示。
   - 最后打印一段总结：Hub 地址、远程地址、vault、日志位置，以及下一步"加服务器：`lumio runtime add <名称>`"（P2-8）。
6. `readConfig` 增加可选的 `LUMIO_PUBLIC_URL`（必须是 https 地址；不设置时为空）。
7. `infra/launchd/README.md` 改为：正常情况运行 `install.sh`；模板与手动步骤保留在"手动安装"一节。

### apps/cli
8. 读取配置：环境变量 `LUMIO_HUB_URL`、`LUMIO_TOKEN`、`LUMIO_VAULT` 优先，其次 `~/.config/lumio/config.json`（`CliConfig` 严格解析；
   文件权限不是 0600 时警告但照用）。把现在散在 `jobs.ts`、`tasks.ts`、`routines.ts`、`operations.ts`、`query.ts`、`cli.ts` 里的
   读环境变量逻辑收成一个函数。缺配置时的错误改为"还没有配置，请先运行 install.sh 或 `lumio-hub setup`"。
9. `lumio --version` 显示注入的版本号。

### README
10. 仓库 `README.md` 的"安装"一节只写那一行命令和"加服务器见 P2-8 之后的 `lumio runtime add`"。

## 不做
- 服务器配对与 systemd 安装（P2-8）；doctor、selftest、upgrade（P2-9）；Nix。

## 验收标准
1. `bun run check` 通过。
2. 测试：
   - CLI 配置的优先级（环境变量 > 文件）、严格解析、权限警告；缺配置时的提示。
   - `lumio-hub setup` 的各步骤拆成可注入的函数（运行命令、读写文件、时钟），测试覆盖：首次安装、重复运行不产生重复身份且吊销旧 CLI 令牌、
     plist 内容（路径、环境变量、无 `~`）、`/health` 超时时识别 EPERM 并给出提示、Tailscale 已开启 / 未开启 / 没装三种情况。
     测试一律用临时目录，不碰真实的 `~/Library`、`~/.config`、vault。
   - `install.sh`：用 shellcheck（若 CI 上可用）检查；用本地起的 HTTP 服务模拟 Release，覆盖校验通过、校验失败不安装、不支持的平台。
3. 人类验收：在 Mac 上运行那一行命令，之后 `lumio search <词>` 不设环境变量能用；重启 Mac 后 Hub 自动启动。
