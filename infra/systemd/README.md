# Linux 后台服务（systemd --user）

通常使用仓库根目录的 `install.sh`，在普通用户下运行，无需 sudo。
`lumio-hub setup` 配置单机模式，`lumio-hub setup --server` 配置服务器模式；两者都会安装本机执行器。
自动生成 `~/.config/systemd/user/lumio-hub.service` 与 `lumio-runtime.service`，
环境文件为 `~/.config/lumio/hub.env`、`~/.config/lumio-runtime/runtime.env`（0600）。
CLI 自动读取 `~/.config/lumio/config.json`；执行器 PATH 取安装时的 shell。

日志：`journalctl --user -u lumio-hub -u lumio-runtime -n 30`。
没有可用的 systemd 用户服务时，安装命令会打印手动运行的方法。
需要退出登录后继续运行时，请管理员运行 `loginctl enable-linger <用户名>`。
HTTPS 见 [Caddy 示例](../README.md#caddy-反向代理)。

## 加一台执行器或 CLI

在已配置好的 CLI 上运行 `lumio runtime add server`，把输出的一行命令粘到目标机器上运行。
配对码 10 分钟内有效且只能用一次；程序会下载、保存配置并启动执行器，成功后显示检测到的 agent。
Hub 必须先设置其他机器可访问的 `LUMIO_PUBLIC_URL`（可重新运行 `lumio-hub setup --server`）。
同名执行器重新配对会吊销全部旧令牌；移除设备用 `lumio runtime remove server`，历史 Job 保留。

已有程序时也可直接运行 `lumio-runtime join --hub <Hub 地址> --code <配对码>`。
`runtime.env` 保留标签、允许命令等其他设置，PATH 更新为当前 shell 的 PATH。
没有 systemd 用户服务时，join 输出 nohup / crontab 的手动启动方法；启动超时用上面的日志命令排查，
修好后运行 `lumio-runtime install-service`，无需重新配对。
macOS 同样支持配对，使用 `io.lumio.runtime` launchd 服务，日志在执行器状态目录。

另一台机器上的 CLI：在已登录的 CLI 上运行 `lumio login-code --name cli@macbook`，
将输出的 `lumio login <Hub 地址> --code <配对码>` 命令粘到新机器上运行。
需要在本机创建笔记时追加 `--vault <本机 vault 路径>`。已有配置必须在交互终端确认覆盖。
配置保存在 `~/.config/lumio/config.json`（0600），`lumio logout` 移除其中的令牌；环境变量仍优先于配置文件。

有 root 权限的 Linux 服务器还可运行 `sudo ~/.local/bin/lumio-runtime install-sudo-helper`，
按 [提权助手说明](../sudo-helper.md) 核对指纹后安装。

## 手动安装

以下保留执行器模板安装方法。Hub 与 vault 可以在另一台机器，执行器不需要 vault。

1. 在 Linux 服务器用 Bun 1.3.x 构建：`bun run --cwd apps/runtime build`。
   将 `apps/runtime/dist/lumio-runtime` 放到 `~/.local/bin/lumio-runtime`。
2. 在 Hub 所在机器创建独立身份和令牌（令牌只显示一次）：
   ```sh
   lumio-hub actor create server --role runtime
   lumio-hub token create server-runtime --actor server
   ```
3. 服务器创建 `~/.config/lumio-runtime/runtime.env`，权限设为 `600`。填入实际 Hub 地址与刚生成的令牌，勿提交此文件：
   ```ini
   LUMIO_HUB_URL=https://lumio.example.org
   LUMIO_TOKEN=<runtime 身份的令牌>
   LUMIO_RUNTIME_NAME=server
   LUMIO_RUNTIME_TAGS=gpu:4,lab
   LUMIO_RUNTIME_MAX_CONCURRENT=1
   LUMIO_RUNTIME_STATE_DIR=/home/<用户名>/.local/share/lumio-runtime
   LUMIO_RUNTIME_POLL_SECONDS=5
   PATH=/home/<用户名>/.local/bin:/usr/local/bin:/usr/bin:/bin
   ```
   `PATH` 必须包含实际安装 codex、claude、pi 的目录；systemd 不读取交互式 shell 配置。
   先确认执行器能访问该地址；HTTPS 通常由 Hub 前面的反向代理提供。
   默认状态目录为 `~/.local/share/lumio-runtime/`；标签默认空、并发默认 1、轮询默认 5 秒。
   环境文件中的路径请写绝对路径，不使用 `~`、`$HOME` 等 shell 展开。
4. 复制本目录的单元到 `~/.config/systemd/user/lumio-runtime.service`，然后运行：
   ```sh
   systemctl --user daemon-reload
   systemctl --user enable --now lumio-runtime.service
   journalctl --user -u lumio-runtime.service -f
   ```
   如需退出登录后仍运行，由管理员为该用户启用 linger（`loginctl enable-linger <用户名>`）。
5. 在 CLI 上使用 **human** 令牌设置 `LUMIO_HUB_URL`、`LUMIO_TOKEN`，执行：
   ```sh
   lumio runtime list
   lumio runtime list --json
   ```
   应显示 `server` 在线、服务器实际安装的 agent 版本及标签；未找到或版本无法解析的 agent 不出现。
   agent 检测仅运行 `--version`，不派活。可先在服务器手动执行三种 agent 的 `--version` 对照。
6. 停止并重启 Hub，执行器应持续运行，日志先显示失联，恢复后重新登记并显示恢复。
   停止执行器 `systemctl --user stop lumio-runtime.service`，等待超过 3 分钟后列表应显示失联及最近一次时间。
   验证后可用 `systemctl --user start lumio-runtime.service` 恢复。

请在 PR 记录手动验证的服务器、时间、实际版本及结果；自动化测试不能替代这一步。
