已在隔离 Hub 复现：旧扩展构建产物调用已退役的 v1 配对入口，被 Hub 返回的 401 误报为连接过期；线上是否加载此产物，仍需浏览器请求路径确认。

## 结果

任务：`task_01M7PGHFWKRFY9RVG7NM9HBCM5`。调查日期：2026-11-18。

### 结论及边界

本地证据指向**扩展构建产物与 Hub API 版本不一致，加上扩展错误分类不准确**，不是配对码刚生成就真的超过 TTL。

工作目录现存 `apps/chrome-ext/dist/options.js` 内的 `clientJoin` 仍调用 `/v1/client/join`。2026-11-16 的提交 `767dd94437fb176d1829d2940cec2a89fe3f5a44`（PR #225）已将服务端配对入口改为 `/v2/setup/client/join`，同时更新 API client 源码。扩展把 API client 打包进 JS，升级 Hub、拉取源码都不会自动重建或重载浏览器中已安装的扩展。

旧路径没有匹配路由；Hub 在返回未找到之前先检查 Bearer token，而匿名配对只对匹配到的 join 路由豁免认证。因此请求在 `Pairing.join` 之前就收到 `401 UNAUTHENTICATED / A valid Bearer token is required`。扩展将任何 401 显示为 `The connection expired. Connect again in the extension settings.`。

已执行真实本地 Hub HTTP 请求，并在最小 DOM/Chrome API 适配器中执行现存 options bundle，复现完全相同文案。重新从当前源码构建的 options bundle 使用**同一个未消费的码**立即成功。适配器不模拟 Chrome 的 TLS、CORS 和权限弹窗；未操作用户浏览器，也未请求生产 Hub。故本地根因已经证实，生产故障同因仍属高可信推断。验收时只需核对扩展 DevTools 的实际请求路径；若是 `/v1/client/join`，即可闭环。

### 配对链路与断点

```text
Web SettingsPane.extensionPairing → pairing("browser")
  → clientInvite("browser@YYYY-MM-DD")
  → POST /v2/setup/client-invites（带 human token）
  → startHubInstance.handle → handlePairing → Pairing.invite
  → 同一 stateDir/hub.sqlite.pairing_codes
       写 SHA-256(code)、kind=client、actor、name、expires、used=0
       expires = Hub now + 600000 ms；同标签旧码 used=1
  ← code、expires、hub_url

扩展 options.render / submit
  → normalizeHub → permissions.request(origin/*)
  → hubClient（无 token）→ clientJoin(trim(code))
     ├─ 当前源码：POST /v2/setup/client/join
     │    → 匹配 client.join → 豁免 Bearer 认证
     │    → handlePairing → 严格校验 {code} → Pairing.join
     │    → 查同一 pairing_codes，检查 kind/hash/used/expires/全局封禁
     │    → 事务内标记消费、replaceToken、返回 human token
     │    → saveConnection → chrome.storage.local["lumio.connection"]
     └─ 现存旧 bundle：POST /v1/client/join
          → route=undefined
          → 【断点 A】认证检查返回 401（未查码、未消费）
          → ApiClientError.status=401
          → 【断点 B】failureText 不分调用阶段，一律显示 expired
```

完整调用链定位（行号基于本地提交 `212e6b722e73788861fb49161692e842b491af2e`）：

| 环节 | 文件、函数与行号 |
|---|---|
| 生成入口与浏览器标签 | `apps/web/src/client/panes/settings-page.ts:191` `SettingsPane.extensionPairing`；`:252` `pairing`；`:258` 调 `clientInvite` |
| 邀请与加入 HTTP 客户端 | `packages/api-client/src/index.ts:301` `clientInvite`；`:302` `clientJoin`；`:48` `request`；`:54` fetch；`:59` 保存 status；`:62` 解析 ApiError |
| Hub 路由 | `apps/hub/src/server.ts:48` client.invite；`:50` client.join；`:155` handle 匹配路由；`:182` Bearer 豁免条件；`:184` 401；`:199` 未找到路由检查；`:209` 调 handlePairing |
| Hub 授权与解析 | `apps/hub/src/pairing.ts:103` `handlePairing`；`:105` authorize；`:117` JSON 解析；`:120` ClientJoinRequest；`:121` join；`:124` 邀请解析；`:126` invite |
| 码生成、写入与读取 | `apps/hub/src/pairing.ts:12` `pairingCode`；`:35` `Pairing.invite`；`:52` TTL；`:53` 撤销旧码；`:54` INSERT；`:62` `Pairing.join`；`:68` SELECT；`:70` 无效判断；`:75` 消费；`:84` replaceToken |
| 扩展提交与持久化 | `apps/chrome-ext/src/options.ts:7` `render`；`:27` submit；`:32` 权限；`:36` clientJoin；`:37` saveConnection；`:40` failureText |
| 扩展客户端与文案 | `apps/chrome-ext/src/shared.ts:17` `hubClient`；`:22` `hubPattern`；`:12` `saveConnection`；`:87` `failureText`；`:89` 无条件映射 401 |
| 库路径与组装 | `apps/hub/src/store.ts:31` `HubStore.open`，`:33` stateDir/hub.sqlite；`apps/hub/src/server.ts:104` open，`:112` 为同一 store 创建唯一 Pairing |

没有 `/pair` 路径、GET preview、客户端时间戳、nonce 或客户端签名参与当前流程。API client 一次 join 只发送一个 POST，不自动重试。权限请求完成后才发送 POST；若用户让权限弹窗停留超过十分钟，确实可能超过 TTL。

### 证据与 Git 历史

| 证据 | 发现 |
|---|---|
| `767dd94`，2026-11-16，PR #225 | `git show` 确认 Hub 和 API client 从 `/v1/client/join` 改成 `/v2/setup/client/join`；没有提供旧客户端 join 路由别名 |
| `d737856`，2026-11-11 | 扩展初始实现；`git blame` 确认所有 401 → expired 和 `optional_host_permissions` 从此未改 |
| `fc93d9a`，2026-10-28，PR #41 | base32 编码、600000 ms TTL、Date.parse、单次消费、共享失败预算均来自此提交；`git log -G` 未发现这些逻辑近期改变 |
| `58b4a40`，2026-10-28，PR #46 | 同一身份同名 client token 替换时撤销旧 token |
| `7c997d0`，2026-11-11 | 支持扩展 Origin 与无 publicUrl 的本地客户端邀请 |
| 本地 dist（被 Git 忽略） | `options.js:1`（压缩单行）含 `/v1/client/join`，不含 `/v2/setup/client/join`；manifest version 仍为 0.1.0 |
| 产物指纹 | options.js SHA-256：`df82cc27c0d52512dfdeb54c506c20b6f97951bf6ee045379b1bf07426f2034a`；文件 mtime 为 `2026-11-11T16:16:54.278173Z`，mtime 仅作旁证 |
| 打包方式 | `apps/chrome-ext/build.ts:8` Bun.build 将入口与依赖一起打包；`:15` 静态文件；`:16` 从 app package 读取版本。`README.md` 要求手动加载 dist |

复现日志摘要（完整脱敏输出见 `evidence.log`）：

```text
旧 bundle → POST /v1/client/join → 401
body.error = {code: "UNAUTHENTICATED", message: "A valid Bearer token is required"}
UI = The connection expired. Connect again in the extension settings.
pairing_codes.used = 0

新构建 bundle → POST /v2/setup/client/join → 200（同一个码）
保存 connection 成功；pairing_codes.used = 1
配对后 POST /v2/inbox/captures → 202

Hub 日志：POST <unmatched> 401
Hub 日志：POST /v2/setup/client/join 200
Hub 日志：POST /v2/inbox/captures 202
```

Hub 日志使用路由模板，旧地址会记为 `<unmatched>`，不能只在日志里搜索 `/v1/client/join`（`server.ts:158`、`:315`）。日志里的旧请求时间正常但不会进入配对失败预算。

### “expired” 的全部相关触发分支

这里区分“代码能触发”和“用户此次实际发生”；未接触生产库，不能用静态分析把线上可能性冒充已排除。

| 条件 | 是否排除及理由 |
|---|---|
| 旧扩展请求退役路径 | **本地已证实，首要解释**。401 在路由认证层产生；码仍 unused，同码改用新入口成功 |
| TTL 到期 | 本地复现已排除；TTL 固定十分钟，599999 ms 可用、600000 ms 拒绝。线上当时等待时长未知 |
| 同码重复 POST、响应丢失后重试 | 真实可能。事务保证一个成功、其后 401；响应成功但本机保存失败也会失去这次凭据。没有 preview 自动消费或客户端自动重试 |
| 重新生成同 actor/kind/name 的码 | **真实可能，另已复现**。invite 主动将旧码置 used=1，无须等过期；Web 当天浏览器默认同名 |
| 错码、错 Hub/数据库、runtime/client 类型混用 | 真实可能。hash+kind 查不到即 401；当前提供的码形态符合小写 base32，但未将其用于请求 |
| JSON 不合法、字段缺失、多余字段、格式不合法 | Hub 直接调用时均折叠为 401。当前扩展先经 API client 本地校验；常见格式错误会在发请求前变成 INVALID，因无 status 反而被显示成无法连接，亦属文案分类缺陷 |
| 全局限流/封禁 | **真实可能，另已复现**。runtime/client 共用 60 秒内十次失败预算；封禁期间合法码也 401，60 秒后同码可成功。计数在 Pairing 实例内存，不是配对码存内存 |
| 邀请之后标签被其他身份占用 | 真实可能，`pairing.ts:81`–`:82` 返回同一 401；事务回滚，不会永久消费该码 |
| 登录态无效/旧 token 被吊销 | 剪藏等已认证接口真实可能；匿名新 join 不依赖旧 token。human token 没有普通时间 TTL，`store.ts:193`–`:206` 检查其存在和吊销状态 |
| 反向代理返回 HTTP 401 | 尚未线上排除。即使代理返回 HTML 而非 ApiError，API client 仍保留 status=401，扩展照样显示 expired；不能凭文字确定来自 Hub |
| UTC/秒毫秒混用、客户端时钟偏差 | 已排除当前代码的单位/时区混用：Hub getTime()/Date.parse 均为毫秒，ISO UTC 序列化；客户端不提交时间。两台机器恒定时差不会缩短同一 Hub 生成/校验的 TTL；Hub 时钟向前跳或不同机器/实例时钟不一致仍可能，未实测生产时钟 |
| 重启丢内存中的配对码 | 已排除代码假设，重启后同码成功：码持久化在 hub.sqlite；内存只放失败预算。不同 stateDir/错误代理目标仍可能查错库 |
| Host/Origin 被 Hub 拒绝 | 此文案来源在本地复现中已排除。`web.ts:20`–`:31` 返回 403，不映射成 expired；允许插件来源仍须 Host 在 local/public/webOrigins 范围 |
| TLS、自签证书、DNS、端口不通、权限拒绝或 CORS 拦截 | 不能由“请求没到 Hub”直接解释这条 401 文案：fetch 无 Response 时 status 未定义，显示无法连接；permissions.request 返回 false 显示专门权限提示。线上网络状态未实测 |
| 客户端 nonce/签名校验失败 | 无此机制，可排除 |

SQLite 组装没有生成时内存、校验时数据库的分裂。Hub 还通过 `server.ts:335` 的 `startHub` / `acquireStateLease` 防止同一状态目录并行 Hub；不能据此证明生产代理没有指向另一个不同状态目录。

### 裸 IP、HTTPS、MV3 与权限

`apps/chrome-ext/static/manifest.json:13` 从初版起就是 `optional_host_permissions: ["http://*/*", "https://*/*"]`。连接时以 `hubPattern` 为该 origin 申请权限，标准 HTTPS IP 的模式为 `https://8.135.45.26/*`，没有仅允许域名的代码或近期收紧权限的提交。

fetch 在扩展设置页、popup 或后台 service worker 发起；注入页面的脚本只负责采集。未使用 `webRequest`。`normalizeHub` 保留 origin，非标准端口会保留在地址中；它会丢弃 path，因此挂在子路径下的 Hub 另有不支持风险，此处用户地址不含子路径。非标准端口对应权限模式的 Chrome 运行时行为未做浏览器实测，不据静态代码承诺其必然可用。

Hub 的 `browserAllowed` 接受 chrome-extension/moz-extension Origin；用配置为 publicUrl 的 `https://8.135.45.26` 和 `:8443` 的构造请求都通过了函数校验。**这不是实际 HTTPS、证书信任或 Chrome CORS 的实测。** Hub 没有一般 OPTIONS/CORS 放行实现；不能把普通网页跨域请求成功与否等同于已获 host 权限的扩展请求。证书不受信任时仍可导致独立连接失败，但无需扩张 manifest 权限来修本次已复现的版本问题。

### 剪藏是否独立故障

没有发现剪藏 API 被删除或改名：旧产物和当前 API client 都调用 `/v2/inbox/captures`。`packages/api-client/src/index.ts:83`–`:94` 对应 `apps/hub/src/inbox.ts:23`–`:27`。popup 的 `run` 在 `apps/chrome-ext/src/popup.ts:15` 读取连接，`:40` 发 capture；后台 `apps/chrome-ext/src/background.ts:17` 的右键处理在 `:22` 发同一接口。

所以**未配对状态下不能剪藏可由同一故障解释**。本地成功配对后提交合成网页，响应 202；未测试真实用户网页抽取、浏览器是否启用插件、Chrome 缓存/加载路径和生产模型处理。

另发现一个**独立且已复现的连接失效隐患**：设置页生成标签 `browser@YYYY-MM-DD`。同一人当天为浏览器 B 再次配对，`replaceToken` 会吊销浏览器 A 的同名 token，使 A 随后剪藏收到 401。即使修好旧包问题，这个标签碰撞仍会存在。重复“生成”会提前作废同名未消费的码；真正“join”成功才替换旧 token。此发现不能自动认定为用户此次已连接插件失效的原因。

## 改动

### 最小恢复与建议 diff（均未实施）

最小恢复不需要改产品代码：用与 Hub 匹配的源码重新构建扩展，在 `chrome://extensions` 重载该扩展，再连接。先用 DevTools 验证请求已改成 `/v2/setup/client/join`。当前同一份源码已修正 API client 路径；不要只重载旧 dist。无需改生产配置、延长 TTL 或加宽 manifest 权限。

建议将防误报修复独立限定在 `apps/chrome-ext`（以下只是建议，未改这些文件）：

```diff
--- a/apps/chrome-ext/src/shared.ts
+++ b/apps/chrome-ext/src/shared.ts
@@
-export function failureText(error: unknown): string {
+export function failureText(error: unknown, phase: "session" | "pairing" = "session"): string {
   const status = (error as { status?: number })?.status;
+  if (status === 401 && phase === "pairing") return t("Pairing failed. Check the extension version, Hub address and pairing code.");
   if (status === 401) return t("The connection expired. Connect again in the extension settings.");
--- a/apps/chrome-ext/src/options.ts
+++ b/apps/chrome-ext/src/options.ts
@@
-        message.replaceChildren(h("span", { class: "error" }, failureText(error)));
+        message.replaceChildren(h("span", { class: "error" }, failureText(error, "pairing")));
```

同一 app 中补齐新文案的中译、对本地 `INVALID` 与网络错误做区分，并增加配对阶段 401、会话阶段 401、网络失败与构建后路由测试。发布扩展时更新 `apps/chrome-ext/package.json` 版本，构建脚本会将该版本写入生成 manifest；静态默认版本可同步，不改权限。

**Hub 不必为这个故障新增契约错误码**。invalid/expired/used 统一 401 是既有设计和测试约束，不建议为了诊断公开区分码是否存在。若要改 `packages/schema` 错误码，必须先写 Proposed ADR 并等人类批准。本轮不建议扩大到这一步。可单独评估在不含 code/token 的诊断中记录“请求未匹配路由”，或让未知路由先返回 404（会改变统一认证行为，需要单独评审，不是最小恢复的前提）。

标签碰撞另开仅 `apps/web` 的修复：让每次“配对一个新浏览器”使用不同标签，例如：

```diff
--- a/apps/web/src/client/panes/settings-page.ts
+++ b/apps/web/src/client/panes/settings-page.ts
@@
-        const invite = await this.session.client.clientInvite(`${kind}@${new Date().toISOString().slice(0, 10)}`);
+        const invite = await this.session.client.clientInvite(`${kind}@${crypto.randomUUID()}`);
```

UUID 标签符合当前字符与长度契约，无新依赖；其行为会从“同日同名替换”改成“新增客户端”，需验证不会互相撤销，并在后续产品流程保留显式撤销旧连接的能力。按仓库一次只改一个 app 的规则，该修复与扩展文案修复分开处理。

本轮只新增本目录的调查报告、复现脚本和脱敏验证日志。**未修改任何 package/app、契约或生产配置，未新增项目依赖，未部署、重启、合并或写真实 vault。**

## 验证

### 环境与复现方法

运行于 Bun 1.4.4。主工作树已有其他会话的未跟踪文件，未触碰。为避免复用不完整依赖或改动现有 dist，使用 `git archive HEAD` 导出已提交版本到本目录下的隔离 snapshot，使用该提交的 lockfile 执行 `bun install --frozen-lockfile --ignore-scripts`；安装缓存、合成 fixture vault、DB 和测试临时目录均在工作目录内。复制现存 dist 只用于比对，未覆盖原产物。验证结束删除隔离 snapshot，仅留下可审阅文件。

重新执行时，在独立、依赖完整的同版本 checkout 中放入本目录，并保留待诊断的 `apps/chrome-ext/dist/options.js`，运行：

```sh
bun run investigations/browser-extension-pairing-2026-11-18/repro.ts
```

脚本启动本地随机端口 Hub；凭据仅在进程内生成使用，不输出；使用 fixtures/query-vault，finally 关闭临时 Hub 并删除其状态目录。冻结的业务时钟用于精确验证 TTL，日志中的 `elapsedMs: 0` 表示业务时钟未推进，不是声称网络耗时为零。

### 已通过的检查

- `repro.ts` 全部断言通过：旧 options 的真实 bundle 调旧路由失败、UI 文案一致、码 unused；新构建同码成功；GET 不消费；同名生成撤旧码；配对后剪藏 202；同名登录撤旧 token；Hub 重启保留码；TTL 边界；全局封禁后合法码失败/解封成功；IP publicUrl 的 Host/Origin 函数判定。
- `apps/hub/test/pairing.test.ts` 中 4 项相关测试：4 pass / 0 fail / 63 assertions（其余 5 项按名称过滤）。原始结果见 `pairing-tests.log`。
- `apps/hub/test/web.test.ts`、`apps/chrome-ext/test/page.test.ts`、`packages/api-client/test/client.test.ts`、`packages/schema/test/setup.test.ts`：22 pass / 0 fail / 276 assertions。原始结果见 `client-tests.log`。
- 上述为第一轮在 `212e6b7` 上的验证记录；第一轮因 Git 权限受限，没有提交，也未运行全仓 `bun run check`。第二轮验证见下文。

### 尚未验证与权限限制

未读取生产系统时间、生产 DB、代理配置或浏览器持久状态；不能确认线上证书、时钟跳变、代理路由与 Chrome 实际装载路径。未复用用户给的历史配对码。按 Lumio skill 只读查询了本任务记录，确认没有历史轮次/参考笔记；未读写知识库。

第一轮 `git fetch origin` 被沙箱拒绝：`cannot open '.git/FETCH_HEAD': Operation not permitted`。第一轮基线为 HEAD `212e6b7`，当时本地 origin/main 为 `47f87f3`。该限制在第二轮授予 Git 权限后解除。

### 第二轮：刷新远端与提交前复核

已成功执行 `git fetch origin`，远端 main 更新至 `0d98d3ac92c627432d7db4cd51f366fafce0fff6`，并以此提交建立独立 worktree 和分支 `codex/browser-extension-pairing-investigation`。未切换或更新原主工作树，未带入其他会话的未提交改动。

比对第一轮基线与该提交，扩展和 API client 源码完全相同；Hub server 的变化为所见/语音资料业务组装，pairing.ts 的变化只涉及 runtime 注册查询，store.ts 的变化是已移除 runtime 的展示过滤。浏览器配对仍采用旧的同日标签，Web 设置页现在位于 `SettingsPane.extensionPairing:195`、`pairing:256`、`clientInvite:262`。Hub 配对路由现在为 `server.ts:49`、`:51`，认证检查与配对分发相较第一轮行号后移 2 行。上述变化不改变调查结论。

第二轮在该基线上重跑 `repro.ts` 全部断言通过，原始日志见 `round2-evidence.log`，旧扩展 bundle 的 SHA-256 与第一轮一致。全仓 `bun run check` 的类型检查、依赖检查通过；测试结果为 **1713 pass / 4 skip / 6 fail**，共 1723 项、238 个文件。失败详情见 `round2-check-summary.md`，其中系统沙箱测试明确报出 `sandbox_apply: Operation not permitted`，另有 fixture 登录版本与文件监听失败，不能将全部失败都归为权限原因。

根据 AGENTS.md 第 8 条“提交前必须通过 `bun run check`”，第二轮暂未提交或推送调查材料。需要 full 权限在不受当前外层沙箱阻拦的环境中重跑涉及系统沙箱的检查，并核验其余基线失败；不需要 root 或生产数据访问。第二轮只复核并保存调查材料，没有实施报告中的产品代码 diff。

### 第三轮：全仓检查通过

在同一提交 `0d98d3a` 上，用 Bun 1.4.4 以普通账号运行 `bun run check`。本轮已解除执行器外层沙箱。测试进程使用独立的主目录、临时目录和最小环境，数据来自合成 fixture。

类型检查和依赖检查均通过。全仓测试 **1719 通过、4 跳过、0 失败**，共 1723 项、238 个文件。第二轮失败的六项测试全部通过，包括三项 Runtime 测试、两项 Hub 交互测试和递归文件监听测试。第二轮记录中的 `native.version_unsupported` 与文件监听问题本轮均未重现，无法仅凭两次运行断定两者的具体成因。完整输出保存在工作树的 `node_modules/.investigation-round3/check.zfVXMM/check.log`。

隔离配对复现再次通过。旧 bundle 请求 `/v1/client/join`，收到 HTTP 401 时数据库中的码仍未消费。当前源码构建的扩展用同一个码请求 `/v2/setup/client/join` 返回 200，后续剪藏返回 202。生产浏览器加载的 bundle 仍待通过实际请求路径确认。

第三轮更新了调查文本，当轮未获 Git 写权限。第四轮刷新远端引用后，`origin/main` 为 `e919275`，其新增提交涉及任务状态显示，扩展和配对调用链没有变化。调查分支保留已通过全仓检查的 `0d98d3a` 基线，提交范围仅包含本目录的调查记录。
