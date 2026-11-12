# U1-0 Runtime 跟随 Hub 自动更新

依据：[ADR 0063](../adr/0063-runtime-version-reconcile-and-self-update.md)（Accepted，2026-11-12 人类批准）。
必读：`docs/DESIGN.md`、`docs/design/execution.md`（「Runtime 版本与自动更新」）、`docs/design/hub.md`（「部署」）、`docs/design/security.md`（「发布与更新的信任」）；
U1-6 另读 `docs/design/web.md`；U1-5 另读 `docs/local-deployment.md`。

## 目标

Hub 升级后，各台 Runtime 自己跟上 Hub 的版本：后台下载并验签，等空闲时切换，切换失败自动回退，全程不打断正在执行的工作。
人只需要在 Web 里看各台机器的状态，必要时决定"暂缓"或"立即重启"。Nix、brew 等外部安装只报告落后，不改程序。

## 现状（不要重做）

- 单个程序 `lumio`，`~/.local/bin` 里 `lumio-hub`、`lumio-runtime` 是指向它的兼容链接；Hub 机器上 Hub 与本机 Runtime 共用这个程序（ADR 0027）。
- `packages/platform/src/upgrade.ts`：从 GitHub Release 下载、校验 `SHA256SUMS`、按事务替换程序与服务文件、失败还原；目前会立即重启 Runtime 服务。
- `scripts/deploy-local.ts`：从 `origin/main` 构建 `x.y.z-dev.local.<sha>`，备份、原子替换、重启 Hub，Runtime 代码有变化时要求 Runtime 空闲并重启它。
- 服务管理：launchd `KeepAlive`、systemd `Restart=always`，进程退出后都会被拉起。
- `RuntimeRegistration` 没有版本字段；可选能力通过 `features` 与 `X-Lumio-Features` 头协商（ADR 0029、0049）。
- 高权限助手按 Hub 签名公钥指纹由人确认安装（ADR 0020、0021），可以作为构建公钥信任流程的参照。
- `release.yml` 打 `v*` 标签时编译 `darwin-arm64`、`linux-x64`、`linux-arm64`，附 `SHA256SUMS`。

## 切片

| 编号 | 内容 | 负责 | 改动范围 |
|---|---|---|---|
| U1-1 ✅ | 契约（`packages/schema/src/runtime-update.ts`）：`RuntimeRegistration` 增加可选 `version`、`platform`（`darwin-arm64` / `linux-x64` / `linux-arm64`）、`install`（`hub-shared` / `managed` / `external`）；`RUNTIME_FEATURES` 增加 `self_update`；`RuntimeHeartbeat` 增加可选 `update`（状态 `current / downloading / staged / waiting_idle / draining / restarting / failed / blocked`、目标版本、开始时间、原因 code 与参数）；`RuntimeSync` 增加可选 `update`（期望版本、是否要求排空、人决定的动作 `defer` / `restart_now` / `retry`），只发给声明了 `self_update` 的 Runtime；发布清单 `ReleaseManifest`（格式 1：版本、来源提交、构建时间、渠道 `release` / `dev`、各平台文件名/大小/SHA-256）；每台 Runtime 的更新策略 `follow` / `manual` 与人操作的请求；`RuntimeInfo` 与执行器视图带上以上信息 | Claude 起草（ADR 已批准） | `packages/schema` |
| U1-2 | 发布签名：Ed25519 签名与验签工具（`node:crypto`，不加依赖）；`build-binary.ts` 用 `--define` 写入正式公钥列表；`release.yml` 生成 `manifest.json` 与 `manifest.sig`（私钥来自 Actions 密钥 `LUMIO_RELEASE_SIGNING_KEY`），没有密钥时发布失败；`upgrade` 改为先验清单签名、再按清单核对哈希；过渡规则：目标版本没有清单时，只在它低于第一个签名版本时接受旧的 `SHA256SUMS` | 后端（Codex）；生成密钥并写入 Actions 密钥由人做 | `packages/platform`、`apps/cli`、`.github/workflows/release.yml` |
| U1-3 | Hub：按策略计算每台 Runtime 的期望版本（默认 Hub 自己的版本）并放进同步回复；Runtime 处于 `draining` 时不再指派新 Job 和原生轮次；更新产物库（状态目录 `updates/`，只留当前与上一个期望版本）及 `GET /v2/execution/updates/<版本>/manifest.json`、`manifest.sig`、`<压缩包>`（只授予 runtime 身份）；正式版本从 GitHub Releases 取来缓存（走 Hub 服务环境代理），先验签再入库；开发构建由 `deploy-local` 直接原子写入产物库目录（同一账户、同一台机器，不开上传接口），Hub 只负责提供，不判断其可信度；策略修改与人对更新的操作（暂缓、立即重启、重试）记审计；`failed` / `blocked` / 排空超过 2 小时发通知；`lumio runtime list` 与 `lumio doctor` 显示版本与更新状态 | 后端（Codex） | `apps/hub`、`packages/execution`、`packages/storage` |
| U1-4 | Runtime：判断安装方式（ADR 0063 第 2 节）；对账循环；`managed` 的下载（优先 Hub，正式版本可退回 GitHub）、验签（内置正式公钥 + 本机已信任构建公钥）、暂存与预检（新程序 `--version` 与只读 `runtime update-check`）；空闲判断、30 分钟后排空、排空期间暂缓本地排队的 Job 与到点的例行任务；`previous` 副本、待确认标记、原子替换、约定退出码重启；启动最早阶段的确认/回退（3 次）；`hub-shared` 只在磁盘程序版本变化时空闲重启；`external` 只报告；`lumio runtime trust-build-key`（打印指纹并要求确认，存放在 Runtime 配置目录 `0600`）；高权限助手不兼容时不再声明 `privileged_helper` 并提示重装 | 后端（Codex） | `apps/runtime`、`packages/platform` |
| U1-5 | Hub 机器的升级配合：`lumio upgrade` 在本机 Runtime 声明 `self_update` 时只重启 Hub；`deploy-local` 只要求 Hub 空闲，不重启 Runtime；按已登记的 `managed` 远端 Runtime 的平台交叉编译，用 `~/.config/lumio/build-signing/` 的密钥签出清单（没有密钥时自动生成并打印公钥指纹），原子写入 Hub 产物库目录；报告各 Runtime 的更新状态，不等待；更新 `docs/local-deployment.md` 与 AGENTS.md 第 9 条中关于 Runtime 空闲的说法 | 后端（Codex） | `scripts/deploy-local.ts`、`packages/platform`、`apps/cli`、文档 |
| U1-6 | Web「设置 → Hub 与执行器」：每台 Runtime 的版本、安装方式、策略开关（跟随 Hub / 手动）、更新状态与原因；排空中显示正在等待的工作并提供"暂缓这次更新""立即重启（会中断进行中的工作）"；`failed` 时提供"重试"；`blocked`（未信任构建）时显示需要在那台机器上运行的命令与公钥指纹 | 前端（Claude） | `packages/api-client`、`apps/web` |

依赖：U1-2 至 U1-6 依赖 U1-1；U1-4 依赖 U1-2 的验签工具；U1-5 依赖 U1-3、U1-4。U1-2 可与 U1-3 并行。

## U1-2 密钥格式（人已于 2026-11-12 生成）

- 私钥：Ed25519，PKCS#8 PEM，整段在 GitHub Actions 仓库密钥 `LUMIO_RELEASE_SIGNING_KEY` 中，由人保管备份。
- 公钥：SPKI DER 的 base64（一行），已写入 `packages/platform/src/release-keys.ts` 的 `RELEASE_PUBLIC_KEYS`（列表形式，换钥时新旧并存）。U1-2 由 `build-binary.ts` 把它编入程序。
- 签名：对 `manifest.json` 原始字节做 `crypto.sign(null, bytes, privateKey)`，结果 base64 写入 `manifest.sig`；验签用 `crypto.verify(null, bytes, publicKey, signature)`。

## U1-1 契约交接（给 U1-2～U1-6）

- 新文件 `packages/schema/src/runtime-update.ts`：`LumioVersion`（不带 `v`）、`RuntimePlatform`、`RuntimeInstall`、`RuntimeUpdatePolicy`、`RuntimeUpdateReport`、`RuntimeUpdateDirective`、`ReleaseManifest`、`RuntimeUpdateView`、`ExecutionRuntimeUpdateCommandRequest`；已登记进 `CONTRACTS`（`runtime-update-report`、`runtime-update-directive`、`runtime-update-command-request`、`release-manifest`）。
- `job.ts`：`RUNTIME_FEATURES` 增加 `self_update`；`RuntimeRegistration` 增加可选 `version`、`platform`、`install`，声明 `self_update` 时三者必填；`RuntimeHeartbeat.update`、`RuntimeSync.update`、`RuntimeInfo.update` 均为可选。
- **与旧 Hub 的兼容（U1-4 要做）**：协议是严格对象，旧 Hub 会拒绝新字段。所以 Runtime 只在收到过带 `update` 的同步回复之后，才在心跳里带 `update`；登记被拒绝（400）时，去掉 `version`、`platform`、`install` 和 Hub 不认识的 features 再登记一次。
- `RuntimeUpdateDirective`：`version` 与 `hold` 必有；`restart_now`、`retry` 是人操作的请求 ID，Runtime 对同一个 ID 只执行一次。不含任何下载地址。
- `ReleaseManifest`：`format: 1`；`channel` 与版本后缀一致（`dev` ⇔ 版本含 `-dev.`）；每个平台一项，文件名固定为 `lumio-<platform>.tar.gz`，SHA-256 用小写十六进制。签名不在清单里：`manifest.sig` 是对清单原始字节的 Ed25519 签名（base64）。
- 人的操作：`execution.runtime.update.policy`（`follow` / `manual`）、`.hold`、`.restart_now`、`.retry`。后三个带人看到的版本，与 Hub 当前期望版本不一致时返回 `CONFLICT`；只授予 human，记审计。
- 失败原因代码见 `RUNTIME_UPDATE_REASONS`，文字由各 app 翻译；`detail` 只放排查用的技术细节，不翻译。

## 验收要点

- 合成测试（不碰真实安装）：
  - 对账：期望版本变化 → 下载 → 预检 → 等空闲 → 替换 → 新进程确认；重复下发同一版本不会重复下载。
  - 安全：签名错误、哈希不符、版本不符、未信任的开发构建一律不替换并报告原因；Hub 返回的清单被篡改时拒绝。
  - 不打断工作：有 Job 或原生轮次在跑时不切换；超过 30 分钟进入排空，Hub 不再指派；人选择"立即重启"后中断的轮次标为 `unknown`。
  - 回退：新程序启动后无法确认时，第 3 次启动换回旧程序，旧程序报告 `failed`，且不自动重试同一版本；Hub 不可达时不计尝试次数。
  - `hub-shared` 从不写程序文件；`external`（含 `LUMIO_RUNTIME_AUTO_UPDATE=off`）从不下载。
  - 兼容：旧 Runtime（没有 `self_update`）的登记与同步不变，同步回复中不出现 `update` 字段。
- 真实验收（人类，U1-5 合并后）：
  1. Mac 与实验室服务器各运行一次 `lumio-runtime upgrade`，升到带自更新的版本（只需这一次）。
  2. 服务器上运行 `lumio runtime trust-build-key`，与 Mac 上 `deploy-local` 打印的指纹核对。
  3. 给服务器派一个长任务的同时在 Mac 部署新版本：任务不被中断，结束后服务器自动切到新版本，Web 显示版本一致。

## 不做

- 不替换高权限助手；不做 Nix、brew 的自动升级；不做防回滚到签过名的旧版本；不做 delta 增量更新。
