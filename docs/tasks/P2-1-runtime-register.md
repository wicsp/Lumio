# P2-1 执行器骨架：登记、能力、在线情况

- 负责：后端（Codex）　Review：Claude
- 相关 ADR：0019（第 1、5、7 节）、0016（身份、授权、审计）、0007（只讲 HTTP、令牌）
- 涉及：`apps/runtime`、`apps/hub`、`packages/api-client`、`apps/cli`
- 契约：`packages/schema/src/job.ts` 的 `RuntimeRegistration`、`RuntimeInfo`、`RuntimeHeartbeat`、`RuntimeSync`；
  `actor.ts` 的角色 `runtime`（已批准，**本任务不得修改**）
- 依赖：P2-0

## 目标
服务器上常驻一个 `lumio-runtime`，向 Mac 上的 Hub 登记"我是谁、装了哪些 agent、有什么标签"，并定时报平安。
在 Mac 上 `lumio runtime list` 能看到它是否在线。这一步还不派活。

## 范围

### apps/runtime
1. **配置**（环境变量）：
   | 变量 | 默认 | 说明 |
   |---|---|---|
   | `LUMIO_HUB_URL` | — | 必填 |
   | `LUMIO_TOKEN` | — | 必填；`runtime` 角色的令牌 |
   | `LUMIO_RUNTIME_NAME` | — | 必填；符合 `RuntimeName`，如 `server` |
   | `LUMIO_RUNTIME_TAGS` | 空 | 逗号分隔，如 `gpu:4,lab` |
   | `LUMIO_RUNTIME_MAX_CONCURRENT` | `1` | |
   | `LUMIO_RUNTIME_STATE_DIR` | `~/.local/share/lumio-runtime/` | 本地状态（P2-2 起存队列与待交回结果） |
   | `LUMIO_RUNTIME_POLL_SECONDS` | `5` | 轮询间隔 |
2. **检测 agent**：启动时对 `codex`、`claude`、`pi` 各运行一次 `--version`（不经过 shell，10 秒超时），解析版本号；
   找不到或解析失败的不登记。隔离级别按固定表声明：`codex` → `os`，`claude-code` → `none`，`pi` → `none`
   （P2-3 会按实际参数复核）。
3. **登记与轮询**：启动时 `POST /v1/runtime/register`（`RuntimeRegistration`），之后每隔 `POLL_SECONDS` 秒
   `POST /v1/runtime/sync`（`RuntimeHeartbeat`，本切片中三项均为空）→ 收到 `RuntimeSync`（本切片中均为空，忽略内容）。
   Hub 不可达时按指数退避重试（最长 60 秒），**进程不退出**；恢复后重新登记。
4. 日志：每次登记成功、失联、恢复各一行；**不打印令牌**。
5. **开机自启**：`infra/systemd/lumio-runtime.service`（`systemd --user` 单元模板）与说明；只提供模板，不自动安装。

### apps/hub
6. `hub.sqlite` 新表 `runtimes`：执行器身份 ID（主键）、最近一次登记内容、`last_seen`。
   **一个 `runtime` 身份只对应一个执行器名称**；另一个身份用同一个名称登记时返回 409。
7. 端点：
   - `POST /v1/runtime/register`、`POST /v1/runtime/sync`：只有 `runtime` 角色允许。
   - `GET /v1/runtimes` → `RuntimeInfo[]`（按名称排序）：`human` 允许；`agent`、`runtime` 拒绝。
     `online` = 最近 3 分钟内轮询过。
   - 全部经 `authorize`；规则表加入上述规则，并加入"`runtime` 角色对查询、提议、操作、身份等**所有已有端点一律拒绝**"。
8. `lumio-hub actor create <名称> --role runtime` 可用（`ActorRole` 已含 `runtime`）。

### packages/api-client、apps/cli
9. api-client：`runtimes()`。
10. `lumio runtime list [--json]`：人类可读输出每行：名称、在线 / 失联（含最近一次时间）、agent 及版本、标签。

## 不做
- 不派活、不执行任何命令（P2-2）。
- 不实现 `RuntimeSync` 里的 jobs、cancel、routines。

## 验收标准
1. `bun run check` 通过。
2. 测试在随机端口启动 Hub 与一个执行器（假的 `codex`/`claude`/`pi` 可执行文件放在临时 PATH 中，输出固定版本）：
   - 登记内容与 `GET /v1/runtimes` 一致，通过 `RuntimeInfo` 校验；找不到的 agent 不出现。
   - 停掉 Hub 再启动：执行器不退出，恢复后 `online` 重新为 true；停掉执行器超过阈值后 `online` 为 false（用注入的时钟）。
3. 授权：`runtime` 令牌访问 `search`、`show`、`links`、`check`、`status`、`operations`、`proposals`、`actors`、`runtimes` 全部 403；
   `human` 与 `agent` 令牌访问 `runtime/register`、`runtime/sync` 为 403；规则表逐条有测试。
4. 同一名称被另一个 `runtime` 身份登记时 409。
5. 日志中不出现令牌。
6. 人类在实验室服务器上手动验证一次：按 `infra/systemd` 的说明启动，Mac 上 `lumio runtime list` 显示在线，
   列出服务器上实际装的 agent 与版本。PR 中写出步骤。
