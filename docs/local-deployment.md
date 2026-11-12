# 主线开发与本机部署

从最新的 `origin/main` 建立功能分支。每个 PR 在本地 `bun run check` 通过（以及安排了的 review 通过）后合入 `main`，CI 在合并后于 `main` 上运行，失败时修复或 revert 对应 PR（PR #188）；由谁 review、何时合并由 Lumio 交接计划或人类安排，没有安排时按 `AGENTS.md` 第 9 条的默认流程（ADR 0049）。本机只维护一个日常实例，监听 `127.0.0.1:7420`，始终从 `main` 的已提交版本构建：PR 合并后重新部署，人类在日常实例上验收；发现问题时继续修复或 revert 对应 PR。含数据迁移的 PR 合并和部署前先停下交回人确认。隔离测试使用临时目录、临时端口和合成数据。

在 macsp 上以 LaunchAgent 所有者身份，从仓库运行：

```sh
bun run scripts/deploy-local.ts
```

脚本串行部署 7420，从最新 `origin/main` 导出独立源码目录，用仓库固定的 Bun 构建带 Web 资源的统一程序。它验证业务快照，备份现有程序、服务定义、Hub 安装配置与 Runtime 状态，再把已验签的文件从同目录原子换入。随后只重启 Hub，核对 `/health` 版本、首页、JS、CSS 和本机 Runtime 的新心跳及期望版本确认。验收失败时脚本原子还原备份的旧程序并再次验收；业务数据保留在现有状态目录。备份位于 Hub 状态目录下的 `deploy-backups/`。

只要求 Hub 助手没有活跃轮次；Runtime Job 可以继续执行。脚本不重启 Runtime，支持 `self_update` 的本机 Runtime 发现磁盘程序变化后自行等空闲重启，远端受管 Runtime 下载、验签、预检后等空闲替换。脚本输出各台机器的版本、策略和当前状态，不等更新完成。`--allow-active` 保留为兼容参数，已不再需要。旧 Runtime 会提示需要一次手动升级以启用自更新。涉及数据迁移时先单独确认迁移和恢复方案。业务备份、vault 与安装配置的边界见 [Hub 部署与备份](design/hub.md#存放)。

开发构建按已登记的 `managed` Runtime 平台交叉编译，签出 `manifest.json` / `manifest.sig`，原子发布到 Hub 状态目录 `updates/<版本>/`；只保留当前与上一版本。构建密钥保存在 `~/.config/lumio/build-signing/private.pem`（0600），不存在时自动生成，公钥为同目录 `public.pem`，脚本只打印公钥路径和 SHA-256 指纹。远端第一次使用开发构建时，将公钥交给那台机器，运行 `lumio runtime trust-build-key --file <公钥文件>`，与 Hub 输出核对后输入完整指纹；私钥不复制给 Runtime。未信任时显示 `blocked / untrusted_build`，信任后下一轮自动重新检查。正式发布密钥与本机构建密钥分开（U1-2～U1-5）。

回退代码时，先将 revert 合入 `main`，再运行同一脚本。脚本遇到部署锁时，先确认持锁部署已经结束；异常退出留下的锁可在确认后删除。

对外发布时，人类在日常实例上验收后，从 `main` 上已验收的提交推送正式 `v*` 标签。Release workflow 校验提交属于主线，重跑全量检查并创建 GitHub Release。带预发布后缀的版本标为预发布，不成为 Latest。

## 在 Web 设置资料抓取代理（I1-3b）

打开「设置 → Hub 与执行器 → 资料抓取代理」，选择「使用自定义代理」，填入 Hub 所在机器可访问的地址，例如 macsp 本地代理的 `http://127.0.0.1:7890`。HTTP 和 HTTPS 网址都使用这个代理。`NO_PROXY` 可选，用逗号分隔直连目标。保存后可立即重试抓取。选择「跟随 Hub 服务环境」可恢复下文的部署配置。

Web 设置保存在 Hub 状态目录的私有 `capture-proxy.json` 中，随安装配置备份。代理凭据可能包含在该文件中，保持文件权限为 `0600`。

## macsp 上用服务环境设置抓取代理（I1-3a）

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
