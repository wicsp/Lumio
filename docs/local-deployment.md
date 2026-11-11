# 主线开发与本机部署

从最新的 `origin/main` 建立功能分支。每个 PR 在本地 `bun run check` 通过（以及安排了的 review 通过）后合入 `main`，CI 在合并后于 `main` 上运行，失败时修复或 revert 对应 PR（PR #188）；由谁 review、何时合并由 Lumio 交接计划或人类安排，没有安排时按 `AGENTS.md` 第 9 条的默认流程（ADR 0049）。本机只维护一个日常实例，监听 `127.0.0.1:7420`，始终从 `main` 的已提交版本构建：PR 合并后重新部署，人类在日常实例上验收；发现问题时继续修复或 revert 对应 PR。含数据迁移的 PR 合并和部署前先停下交回人确认。隔离测试使用临时目录、临时端口和合成数据。

更新日常实例前，确认 Hub 和 Runtime 的活跃工作已经结束。用 `lumio hub backup business <新目录>` 创建业务快照，并用 `lumio hub backup verify <目录>` 校验。备份当前程序、服务定义和 Runtime 状态供回退。涉及迁移时先用合成数据验证，并确认备份可恢复。业务备份、vault 与安装配置的边界见 [Hub 部署与备份](design/hub.md#存放)。

从指定提交的独立源码目录用仓库固定的 Bun 构建。安装新程序后重启 Hub。仅 Web 更新可保留 Runtime 进程；Runtime 有改动时，等在途工作结束后再重启。核对 `/health` 的版本、页面资源和 Runtime 在线状态。

对外发布时，人类在日常实例上验收后，从 `main` 上已验收的提交推送正式 `v*` 标签。Release workflow 校验提交属于主线，重跑全量检查并创建 GitHub Release。带预发布后缀的版本标为预发布，不成为 Latest。

## macsp 上给 Hub 抓取配置代理（I1-3a）

在运行 Hub 的 macsp 用户下，编辑 `~/Library/LaunchAgents/io.lumio.hub.plist`，把下面的键加入已有的 `EnvironmentVariables` 字典。将示例地址换成 macsp 上受信任的 HTTP 或 HTTPS 代理监听地址。`HTTPS_PROXY` 用于 HTTPS 网址，`HTTP_PROXY` 用于 HTTP 网址，两者可以指向同一个 `http://` 代理。`NO_PROXY` 可选，填逗号分隔的直连目标。

```xml
<key>HTTPS_PROXY</key><string>http://127.0.0.1:7890</string>
<key>HTTP_PROXY</key><string>http://127.0.0.1:7890</string>
<key>NO_PROXY</key><string>localhost,127.0.0.1</string>
```

在 `~/.config/lumio/hub.env` 同步写入同名的 `KEY="值"` 项，以便日后 `lumio hub setup` 重建 plist 时保留。两个文件都保持 `0600`。等待活跃工作结束后，校验并重新加载 LaunchAgent，使服务读到新环境。

```sh
hub_plist="$HOME/Library/LaunchAgents/io.lumio.hub.plist"
hub_domain="gui/$(id -u)"
plutil -lint "$hub_plist" &&
  launchctl bootout "$hub_domain" "$hub_plist" &&
  launchctl bootstrap "$hub_domain" "$hub_plist"
curl --noproxy '*' -fsS http://127.0.0.1:7420/health
```

通过代理抓取时，由代理解析域名，Hub 每跳检查网址，仍会拒绝写在网址里的内网 IP、`localhost` 和 `.local` 等。命中 `NO_PROXY` 或该协议未配置代理时，Hub 解析域名、检查所有返回地址并连接通过检查的地址。macOS 系统代理和终端里的临时 `export` 不会替 LaunchAgent 配置这些值。
