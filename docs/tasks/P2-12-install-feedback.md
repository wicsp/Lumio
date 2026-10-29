# P2-12 安装与配对：看得见进度，说得出原因

- 负责：后端（Codex）　Review：Claude
- 相关 ADR：0021、0022
- 涉及：`install.sh`、`apps/hub`、`apps/runtime`、`apps/cli`
- 契约：不改
- 依赖：P2-9（`upgrade` 与 `doctor` 在 P2-9 里实现，本切片在它们的基础上改）

接入实验室服务器时（2026-10-29）发现的问题。

## 1. 下载要有进度（人类提出）
- 现象：网络慢时 `install.sh` 下载几十 MB 的压缩包没有任何输出，分不清是卡住了还是在下载。
- 修法：
  - `install.sh`：标准错误是终端时，下载压缩包用 `curl -fL --progress-bar`（显示进度条与百分比）；不是终端时（CI、日志）保持安静。
    `SHA256SUMS` 很小，不需要进度。下载前打印将要下载的版本与平台。
  - 给 `curl` 加连接超时（`--connect-timeout 20`）与低速超时（`--speed-limit 1024 --speed-time 60`）：一分钟内平均低于 1 KB/s 时放弃，
    并提示"下载太慢或卡住，请检查网络或代理（https_proxy）后重试"。
  - `lumio upgrade` 与 `lumio-runtime upgrade`（P2-9）用同样的规则：终端里显示进度（已下载 / 总大小 / 百分比，每秒刷新一行），同样的超时与提示。

## 2. 配对失败要说出原因
- 现象：`lumio-runtime join` 只说"执行器配对失败，请检查 Hub 地址并生成新的配对码后重试"。这次真实原因是 Tailscale 转发到了一个旧版本的 Hub，
  但从提示里看不出来。
- 修法：join 先请求 `<地址>/health`，再调用 join 接口，按情况给出不同的提示（都不打印配对码与令牌）：
  - 连不上（DNS、超时、TLS）：说明是哪一种，提示检查地址、Tailscale、代理（`no_proxy`）；
  - `/health` 的版本与本程序不一致：提示"Hub 是 <版本>，执行器是 <版本>，请先升级 Hub"；
  - join 返回 404（旧 Hub 没有这个接口）：同上；
  - join 返回 401：配对码无效、过期或已用，重新运行 `lumio runtime add <名称>`；
  - 其他：打印 HTTP 状态码。
  `lumio login` 同样处理。

## 3. setup 要发现"另一个 Hub"
- 现象：Mac 上残留一个 P2-1 时手动装的 launchd 服务 `io.lumio.hub.p2-1`（监听 7421），`tailscale serve` 转发到它，`setup` 没有发现。
- 修法（`lumio-hub setup`）：
  - 启动后确认 `/health` 的版本等于本程序的版本，不一致就报错并说明"端口上是另一个 Hub"；
  - 列出名字以 `io.lumio.` 开头、但不是 `io.lumio.hub` / `io.lumio.runtime` 的 launchd 服务（Linux：`lumio-*.service` 之外的 lumio 相关用户服务），
    提示人确认后用 `launchctl bootout` 停掉（不自动删除）；
  - 设置了对外地址时，从本机请求 `<对外地址>/health`，版本不一致就提示"对外地址指向的不是这个 Hub"；若找得到 `tailscale`，
    同时显示 `tailscale serve status` 中转发的目标端口，与 Hub 的端口不一致时给出改正命令（`tailscale serve --bg <端口>`）。
- `lumio doctor`（P2-9）加上同样的三项检查。

## 验收标准
1. `bun run check` 通过（PR 上的 Check 通过后再合并）。
2. 测试：`install.sh` 在终端与非终端下的 `curl` 参数（用假的 curl 记录参数）；join / login 的五种失败各自的提示（假的 Hub）；
   setup 发现版本不一致的 Hub、多余的 launchd 服务、对外地址指向别的 Hub（注入命令与 HTTP）。
3. 人类验收：在慢网络下运行安装命令能看到进度；故意用旧版本或错误地址配对，能看到对应的原因。
