# Mac 登录后启动 Hub

这是模板，不会自动安装。Hub 只讲 HTTP，默认监听 `127.0.0.1:7420`。

1. 用 Bun 1.3.x 在 `apps/hub` 中运行 `bun run build`，将 `dist/lumio-hub` 放到固定的绝对路径。
2. 复制 `io.lumio.hub.plist` 到 `~/Library/LaunchAgents/`，替换所有 `/ABSOLUTE/PATH/TO/…`。
   launchd 不展开 `~` 或 shell 变量。状态目录必须在 vault/iCloud 外，先创建该目录以便 launchd 打开日志文件。
3. 使用同一个 `LUMIO_STATE_DIR` 初始化身份和令牌：
   ```sh
   lumio-hub actor create owner --role human
   lumio-hub token create mac-cli --actor owner
   lumio-hub actor list
   lumio-hub token list
   ```
   创建令牌只在本次命令输出明文，立即保存到密码管理器；不要写进 plist 或日志。
   吊销用 `lumio-hub token revoke mac-cli`。管理命令只需状态目录，不需要 vault。
4. 手动安装/卸载：
   ```sh
   launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/io.lumio.hub.plist
   launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/io.lumio.hub.plist
   ```
5. 检查 `curl http://127.0.0.1:7420/health`。远程访问由 `tailscale serve` 转发并提供 HTTPS，Hub 仍绑定 loopback。
   仅在明确配置可信代理时设置 `LUMIO_TRUSTED_PROXY` 为该代理的单个 IP；只有来自该 IP 的请求才能采用
   `X-Forwarded-For` 的第一个有效 IP，其他转发头不参与身份或授权。

源码启动方式为 `bun apps/hub/src/main.ts`。服务需要 `LUMIO_VAULT`；`LUMIO_STATE_DIR` 默认是
`~/.local/share/lumio/`。CLI 查询设置 `LUMIO_HUB_URL` 与 `LUMIO_TOKEN` 后走 Hub，不需要本地 vault；
两者必须同时设置。`export bib`、新建和补全仍使用本地 vault。

每个请求输出一行 JSON。路径使用路由模板（笔记引用不写入日志），不包含查询内容或认证头；
拒绝授权写入 `hub.sqlite` 的 audit 表。放行查询不写审计。请单独备份 `hub.sqlite`，索引可重建。
