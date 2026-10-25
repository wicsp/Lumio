# P1-2 Hub 服务骨架：配置、令牌、查询 API、CLI 远程模式

- 负责：后端（Codex）　Review：Claude
- 相关 ADR：0007（部署与安全）、0014（第 2、3、6、7 节）、0012（私密实体）
- 涉及：`apps/hub`、`packages/api-client`、`apps/cli`
- 依赖：P1-1

## 目标
一个常驻的 Hub 进程，通过带认证的 HTTP API 提供 P1-1 的查询能力；CLI 设置 `LUMIO_HUB_URL` 后改为调用 Hub。
从第一版开始就满足 ADR 0007 的部署与安全要求。

## 范围

### apps/hub
1. **启动**：`lumio-hub`（`bun build --compile` 的产物）或 `bun apps/hub/src/main.ts`。
2. **配置**（环境变量，全部可选，除 vault）：
   | 变量 | 默认 | 说明 |
   |---|---|---|
   | `LUMIO_VAULT` | — | 必填 |
   | `LUMIO_STATE_DIR` | `~/.local/share/lumio/` | 索引与运行状态 |
   | `LUMIO_HUB_LISTEN` | `127.0.0.1:7420` | 监听地址 |
   | `LUMIO_TRUSTED_PROXY` | 空 | 可信反向代理的 IP；为空时忽略所有 `X-Forwarded-*` 头 |
3. **HTTP**：用 `Bun.serve`，**不引入 Web 框架**。只讲 HTTP，不处理 TLS（ADR 0007）。
   - `GET /health`：不需要认证，返回 `{"ok":true,"version":"…"}`。
   - `GET /v1/search?q=…&type=…&limit=…` → `SearchResult`
   - `GET /v1/notes/<引用>` → `NoteDetail`
   - `GET /v1/notes/<引用>/links` → `LinksResult`
   - 三个查询端点都支持 `include_private=true`。**`agent` 令牌带这个参数时返回 403**；不带时私密实体一律排除
     （ADR 0014 第 6 节）。私密笔记对 agent 令牌表现为"不存在"（`show` 返回 404）。
   - 引用需 URL 编码。错误响应统一为 `{"error":{"code":"…","message":"…"}}`，状态码 400/401/403/404/500。
   - 查询逻辑**直接调用 `@lumio/core`**，不在 Hub 中重写。
4. **令牌**（ADR 0014 第 6 节）：
   - 存在 `<状态目录>/hub.sqlite`：名称、角色（`human` | `agent`）、SHA-256 哈希、创建时间、吊销时间。
   - 子命令：`lumio-hub token create <名称> --role human|agent`（只打印一次明文令牌）、`token list`、`token revoke <名称>`。
   - 令牌明文格式：`lumio_` + 32 字节随机数的 base64url。比较哈希时使用定长比较。
   - 除 `/health` 外所有请求需要 `Authorization: Bearer <令牌>`；缺失为 401，已吊销为 401。
   - 日志中**不得出现令牌**，只记录令牌名称。
5. **日志**：每个请求一行：时间、令牌名称、方法、路径（不含查询参数中的内容）、状态码、耗时、客户端 IP
   （仅当请求来自 `LUMIO_TRUSTED_PROXY` 时才采用 `X-Forwarded-For`）。
6. **launchd**：在 `infra/launchd/` 提供一个 plist 模板和说明，让 Hub 在 Mac 登录后自动运行。只提供模板，不自动安装。

### packages/api-client
7. 实现调用上述 API 的客户端：`createClient({ url, token, fetch? })`，返回值用 `@lumio/schema` 校验后再返回；
   错误转换成带 `code` 的错误类。

### apps/cli
8. 设置了 `LUMIO_HUB_URL` 和 `LUMIO_TOKEN` 时，`search`、`show`、`links` 通过 api-client 调用 Hub；
   否则保持本地模式。两种模式的 `--json` 输出必须完全相同。
   只设置其中一个时报错，说明两个都需要。

## 不做
- 不实现文件监听、自动提交、提议（P1-3、P1-4）。
- 不做 HTTPS、OAuth、多用户。

## 验收标准
1. `bun run check` 通过。
2. 测试在随机端口启动 Hub，覆盖：`/health` 无需认证；无令牌、错误令牌、已吊销令牌均为 401；三个查询端点的响应通过 schema 校验。
3. **同一个合成 vault 上，本地模式与 Hub 模式的 `--json` 输出逐字节相同**（每个命令至少一个用例）。
4. 私密实体：agent 令牌查不到、`show` 私密笔记返回 404、带 `include_private=true` 返回 403；human 令牌加参数后可以查到。
5. 日志测试：令牌明文不出现在任何日志行；未配置可信代理时伪造的 `X-Forwarded-For` 被忽略。
6. 默认只监听 `127.0.0.1`（测试中断言绑定地址）。
7. 测试使用临时的状态目录和合成 vault。
