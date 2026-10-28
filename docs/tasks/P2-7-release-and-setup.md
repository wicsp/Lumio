# P2-7 发布编译好的程序；一条命令装好 Hub、CLI 和本机执行器

- 负责：后端（Codex）　Review：Claude
- 相关 ADR：**0021**（第 1、2 节）、**0022**（编辑器无关、两种部署模式、网络由部署者负责），先读这两条
- 涉及：`.github/workflows/`、`install.sh`（仓库根目录）、`apps/hub`、`apps/runtime`、`apps/cli`、`infra/`、`README.md`、`docs/personal-setup.md`
- 契约：`packages/schema/src/setup.ts` 的 `CliConfig`（已由 Claude 起草并合并，**不得修改**）
- 依赖：P2-6

## 目标
在 macOS 或 Linux 上只运行：
```sh
curl -fsSL https://raw.githubusercontent.com/wicsp/Lumio/main/install.sh | sh
```
之后就是**单机模式**：Hub 与本机执行器都作为后台服务运行（开机 / 登录后自启），任何终端里的 `lumio` 不设环境变量就能用，
派活、例行任务开箱即用。加 `--server` 即为服务器模式的 Hub（ADR 0022 第 2 节）。

## 范围

### 发布
1. `.github/workflows/release.yml`：推送 `v*` 标签时触发。
   - 在 macOS runner 上用 Bun **1.3.13**（`oven-sh/setup-bun`，写死版本）`bun install --frozen-lockfile`、`bun run check`，
     然后用 `bun build --compile --target=…` 编译 `apps/cli`、`apps/hub`、`apps/runtime` 的入口，平台 `darwin-arm64`、`linux-x64`、`linux-arm64`。
   - darwin 的三个程序 `codesign --force --sign -`。
   - 每个平台打一个 `lumio-<平台>.tar.gz`（内含 `lumio`、`lumio-hub`、`lumio-runtime`），生成 `SHA256SUMS`，上传到 Release。
   - 版本号：标签去掉 `v`，编译时用 `--define` 注入，替换现在从 `package.json` 读的 `0.0.0`。源码运行时显示 `0.0.0-dev`。
2. `.github/workflows/check.yml`：PR 与 main 上跑 `bun run check`（Linux 即可）。
3. 在 PR 描述里写明引入 `oven-sh/setup-bun` 这个 Action 的理由（AGENTS.md 第 5 条）。

### install.sh
4. POSIX sh，不依赖 bash。参数：
   - 无参数：装好后运行 `lumio-hub setup`；`--server`：运行 `lumio-hub setup --server`；
   - `runtime --hub <地址> --code <配对码>`：装好后运行 `lumio-runtime join`（P2-8 实现，本切片原样转交参数，命令不存在时报错）；
   - `--version vX.Y.Z`：指定版本，默认最新 Release；`--no-setup`：只装程序。
   - 识别平台（`uname -s`/`uname -m`），不支持的平台报错退出。
   - 下载压缩包与 `SHA256SUMS`，用 `shasum -a 256`（macOS）或 `sha256sum`（Linux）校验，不通过就退出、不安装。
   - 解压到临时目录，装到 `~/.local/bin`（不存在就建）；**不需要 sudo**。`~/.local/bin` 不在 PATH 时提示怎么加（不自动改 shell 配置）。
   - 失败时说清楚哪一步失败；不打印下载到的内容。

### `lumio-hub setup [--vault <路径>] [--server] [--yes]`（apps/hub）
5. 可重复运行，第二次运行就是修复或升级，不会产生重复的身份或服务。所有询问都有默认值；`--yes` 或非交互终端时全部取默认值。步骤：
   - **vault**：已有 CLI 配置时沿用其中的路径；否则询问，默认 `~/.config/lumio/vault`（不存在就建，并写一个简短的 `README.md`
     说明这是 Lumio 的 vault、目录结构见文档）。`--vault` 直接指定。路径不存在且不是默认值 → 报错。
   - **状态目录**：`~/.local/share/lumio`（0700）。已有 `hub.sqlite` 就沿用其中的身份与令牌。
   - **身份与 CLI 令牌**：没有 human 身份就建 `owner`；吊销名为 `cli@<主机名>` 的旧令牌并新建一个；写入 `~/.config/lumio/config.json`
     （`CliConfig`，权限 0600，目录 0700），`hub_url` 为 `http://127.0.0.1:<端口>`，`vault` 为上面的路径。令牌不打印到终端。
   - **Hub 后台服务**：
     - macOS：生成 `~/Library/LaunchAgents/io.lumio.hub.plist`（程序路径用 `lumio-hub` 自身的绝对路径；环境变量 `LUMIO_VAULT`、
       `LUMIO_STATE_DIR`、`LUMIO_HUB_LISTEN`、`LUMIO_PUBLIC_URL`（服务器模式才有），`PATH` 包含 `git` 所在目录；日志写到状态目录）。
       已加载就先 `bootout`（忽略"未加载"），再 `bootstrap`；用 `plutil -lint` 校验。
     - Linux：生成 `~/.config/systemd/user/lumio-hub.service`（同样的环境变量写进 `~/.config/lumio/hub.env`，0600），
       `daemon-reload`、`enable --now`（已在运行则 `restart`）；检查 linger 并提示（同 P2-8 的执行器）。没有 systemd 用户服务时打印手动运行的方法。
   - **等待** `/health` 最多 20 秒。失败时读错误日志的最后几行判断原因：读 vault 被拒（`EPERM`/`Operation not permitted`，macOS 上读 iCloud
     等受保护目录）→ 打印"系统设置 → 隐私与安全性 → 完全磁盘访问权限，加入 `<lumio-hub 的路径>`，然后重新运行 `lumio-hub setup`"；
     端口被占用 → 说明；其他 → 打印日志位置。
   - **本机执行器**：直接在 Hub 里建名为主机名（规范成 `RuntimeName` 允许的形式）的 runtime 身份与令牌（已有则吊销旧令牌换新），
     写本机执行器的 `runtime.env`（0600，PATH 取当前 shell 的 PATH），装成后台服务（macOS：`io.lumio.runtime.plist`；
     Linux：`lumio-runtime.service`），启动后确认登记成功并打印检测到的 agent。执行器部分写成 apps/runtime 自己的函数
     （`lumio-runtime install-service`，P2-8 的 join 也调用它），setup 以子进程调用，**不跨 app import**。
   - **服务器模式 `--server`**：额外询问监听地址（默认 `0.0.0.0:7420`）与对外地址（如 `https://lumio.example.org`），写进服务配置；
     打印一段 Caddy 反向代理的示例（`lumio.example.org { reverse_proxy 127.0.0.1:7420 }`）。对外地址是 `http://` 且不是本机地址时，
     打印一条风险提示，然后照常继续（ADR 0022 第 3 节：网络由部署者负责）。
   - **Tailscale（补充）**：找得到 `tailscale` 命令且是服务器模式、或用户在单机模式下想让别的机器连进来时，询问是否用 Tailscale 提供对外地址：
     可以 `tailscale serve --bg <端口>` 得到 `https://<DNSName>`，或直接用 `http://<Tailscale IP>:<端口>`（此时监听地址设为该 IP）。
     找不到 tailscale 就不提。
   - 最后打印总结：vault 的完整路径（默认路径在隐藏目录里，Finder 看不到）、Hub 地址、对外地址（有的话）、日志位置、
     本机执行器与检测到的 agent，以及下一步（"加一台执行器：`lumio runtime add <名称>`"，P2-8）。
6. `readConfig` 增加可选的 `LUMIO_PUBLIC_URL`（http 或 https 地址；不设置时为空）。Hub 启动时，监听地址不是本机地址、
   且 `LUMIO_PUBLIC_URL` 是 `http://` 或未设置时，日志里打印一条警告；不拒绝启动。

### apps/cli
7. 读取配置：环境变量 `LUMIO_HUB_URL`、`LUMIO_TOKEN`、`LUMIO_VAULT` 优先，其次 `~/.config/lumio/config.json`（`CliConfig` 严格解析；
   文件权限不是 0600 时警告但照用）。把现在散在 `jobs.ts`、`tasks.ts`、`routines.ts`、`operations.ts`、`query.ts`、`cli.ts` 里的
   读环境变量逻辑收成一个函数。本地写 vault 的命令（`new`、`sync`、`export bib`）也用配置里的 `vault`。
   缺配置时的错误改为"还没有配置，请先运行 install.sh 或 `lumio-hub setup`"。
8. `lumio --version` 显示注入的版本号。

### 文档
9. `README.md` 的"安装"一节：单机一行命令；服务器模式加 `--server`，并链接 Caddy 示例；加执行器见 `lumio runtime add`（P2-8）。
   不提 Obsidian 与 Tailscale 以外的私人配置；Tailscale 只作为"没有公网地址时的一种办法"出现。
10. `infra/launchd/README.md`、`infra/systemd/README.md`：正常情况用 install.sh；模板与手动步骤保留在"手动安装"一节。
11. 新建 `docs/personal-setup.md`：作者自己的用法（vault 在 iCloud、用 Obsidian 编辑并经 iCloud 同步其配置、vault 的 `.gitignore`
    排除编辑器插件的设置文件、用 Tailscale 让实验室服务器连回 Mac）。软件文档里不再写这些。

## 不做
- 执行器配对、`lumio login`、提权助手安装（P2-8）；doctor、selftest、upgrade（P2-9）；Nix；Windows。

## 验收标准
1. `bun run check` 通过。
2. 测试：
   - CLI 配置的优先级（环境变量 > 文件）、严格解析、权限警告；缺配置时的提示；本地命令使用配置里的 vault。
   - `lumio-hub setup` 的各步骤拆成可注入的函数（运行命令、读写文件、平台、时钟），测试覆盖：首次安装（默认 vault 被创建）、
     重复运行不产生重复身份且吊销旧 CLI 令牌、`--vault` 指定已有目录、macOS plist 与 Linux systemd 单元的内容（绝对路径、无 `~`、环境变量）、
     `/health` 超时时识别 EPERM 并给出提示、本机执行器被装上、`--server` 写入监听与对外地址并在 `http://` 时提示、
     Tailscale 存在 / 不存在两种情况。测试一律用临时目录，不碰真实的 `~/Library`、`~/.config`、vault。
   - Hub 启动警告：非本机监听且对外地址为 `http://` 时有警告，本机监听时没有。
   - `install.sh`：用 shellcheck（若 CI 上可用）检查；用本地起的 HTTP 服务模拟 Release，覆盖校验通过、校验失败不安装、不支持的平台。
3. 人类验收：在 Mac 上运行那一行命令，vault 指定为 iCloud 里现有的目录；之后 `lumio search <词>` 不设环境变量能用；
   `lumio runtime list` 显示本机执行器在线；重启 Mac 后 Hub 与执行器自动启动。
