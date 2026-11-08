# V0-0 合成技术验证

对应 [报告](../../docs/reviews/V0-0-spike-report.md)。只做客户端与供应商探针，不接入生产 Lumio。
Bun 1.3.13；实测 Codex 0.166.0、Claude Code 2.1.310、pi 1.4.0；无新增依赖。

## 复现

在仓库根目录运行。输出写入绝对路径的私有临时目录：

```bash
SPIKE_OUT=$(mktemp -d)
chmod 700 "$SPIKE_OUT"
bun scripts/spike/codex-session.ts --use-local-codex-login --out "$SPIKE_OUT/native.json"
bun scripts/spike/session-config.ts --use-local-codex-login --out "$SPIKE_OUT/config.json"
bun scripts/spike/providers.ts --use-local-pi-deepseek-key --out "$SPIKE_OUT/deepseek.json"
bun scripts/spike/cli-probes.ts --use-local-credentials --out "$SPIKE_OUT/cli.json"
bun scripts/spike/doubao.ts --out "$SPIKE_OUT/doubao.json"
```

- Codex 探针需要用户自己的有效本地 ChatGPT 登录（`CODEX_HOME/auth.json`，默认 `~/.codex/auth.json`）。只在 mode 700 临时目录复制一份 mode 600 的登录状态，正常退出时删除；不实现 OAuth，不改全局配置。不支持仅存钥匙串的登录状态。
- DeepSeek 优先读取环境变量 `DEEPSEEK_API_KEY`；明确指定 opt-in 时才读取 pi 的本地 DeepSeek API key。CLI 联合探针也需要这份 API key。凭据只存在内存、临时认证文件或子进程环境中，不通过参数或日志输出。
- 豆包需自行提供 `ARK_API_KEY` 与已开通的 `ARK_MODEL`；可用 `ARK_EFFORT` 选择原生档位。缺少时只输出 blocked，不能算实测通过。
- 会调用真实服务并使用本人订阅额度或 API 额度；测试输入、工具和文件全部为合成数据。不得对真实 vault 运行。
- 原型自动接受的命令严格限定为本次随机临时目录中一个 `printf` 标记写入；故意等待约 65 秒后回答。其他命令审批拒绝。MCP 探针仅接受 alpha 合成工具的 elicitation；不能把这些回调直接用于生产。
- 测试 app-server 通过 stdio 启动，每个探针有独立状态目录；MCP 测试关闭 apps 并读取实际工具清单。故意不带配置恢复的一步会发现账号连接器，但不会调用它们。
- 崩溃测试故意杀死 app-server，观察其合成 shell 子进程是否继续运行；最多等待 16 秒后读取合成标记。运行中按强制终止可能留下临时登录副本，应由本次操作者清理自己的测试目录。
- stderr 和原始响应不落盘、不打印；reasoning 只保存字段类型、事件名或 token 数。临时客户端本身仍会保存合成会话，勿公开它们。

## 文件

| 文件 | 用途 |
|---|---|
| `codex-session.ts` | 原生会话全流程、审批、中断、压缩、两 thread、杀进程恢复与副作用检查 |
| `session-config.ts` | 每 thread MCP、网络、指令与重启配置验证 |
| `rpc.ts` | 探针用 JSON-RPC 收发器，不是生产适配器 |
| `providers.ts` | DeepSeek 档位、工具续接字段对照及 Anthropic 端点 |
| `cli-probes.ts` | Codex exec/resume、pi、Claude Code + DeepSeek 工具闭环；读取合成会话元数据 |
| `doubao.ts` | 等待凭据的可选方舟 Chat API 工具续接探针 |
| `fixtures/mcp-server.ts` | 不访问网络与文件的合成 echo MCP |
| `evidence/` | 本轮脱敏证据；不含认证、邮箱、推理正文；临时路径用 `$SPIKE_ROOT` 替代 |

完整协议类型清单可重新生成到临时目录：

```bash
SCHEMA_OUT=$(mktemp -d)
CODEX_HOME="$SPIKE_OUT/schema-home" codex app-server generate-json-schema --out "$SCHEMA_OUT"
```

`protocol-methods-0.166.0.json` 是安装的 Codex 导出的协议方法名索引，不属于 `packages/schema` 的生成物，也不代表全部事件都已实测触发。
