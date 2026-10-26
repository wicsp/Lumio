# Linux 执行器（systemd --user）

这是模板，不自动安装。使用普通用户操作。Hub 与真实 vault 仍只在 Mac 上；服务器不需要 vault。

1. 在 Linux 服务器用 Bun 1.3.x 构建：`bun run --cwd apps/runtime build`。
   将 `apps/runtime/dist/lumio-runtime` 放到 `~/.local/bin/lumio-runtime`。
2. 在 Mac 上创建独立身份和令牌（令牌只显示一次）：
   ```sh
   lumio-hub actor create server --role runtime
   lumio-hub token create server-runtime --actor server
   ```
3. 服务器创建 `~/.config/lumio-runtime/runtime.env`，权限设为 `600`。填入实际 Hub 地址与刚生成的令牌，勿提交此文件：
   ```ini
   LUMIO_HUB_URL=https://<Mac 的 Tailscale 地址>
   LUMIO_TOKEN=<runtime 身份的令牌>
   LUMIO_RUNTIME_NAME=server
   LUMIO_RUNTIME_TAGS=gpu:4,lab
   LUMIO_RUNTIME_MAX_CONCURRENT=1
   LUMIO_RUNTIME_STATE_DIR=/home/<用户名>/.local/share/lumio-runtime
   LUMIO_RUNTIME_POLL_SECONDS=5
   PATH=/home/<用户名>/.local/bin:/usr/local/bin:/usr/bin:/bin
   ```
   `PATH` 必须包含实际安装 codex、claude、pi 的目录；systemd 不读取交互式 shell 配置。
   Hub 只监听 loopback，通过 `tailscale serve` 提供 HTTPS。先确认服务器能访问该地址。
   默认状态目录为 `~/.local/share/lumio-runtime/`；标签默认空、并发默认 1、轮询默认 5 秒。
   环境文件中的路径请写绝对路径，不使用 `~`、`$HOME` 等 shell 展开。
4. 复制本目录的单元到 `~/.config/systemd/user/lumio-runtime.service`，然后运行：
   ```sh
   systemctl --user daemon-reload
   systemctl --user enable --now lumio-runtime.service
   journalctl --user -u lumio-runtime.service -f
   ```
   如需退出登录后仍运行，由管理员为该用户启用 linger（`loginctl enable-linger <用户名>`）。
5. 在 Mac 上使用 **human** 令牌设置 `LUMIO_HUB_URL`、`LUMIO_TOKEN`，执行：
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
