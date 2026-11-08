# V0-0：AI 配置底座与原生 Codex 会话验证报告

验证日期：2026-11-08（UTC / Asia/Singapore）。结论：**Codex 官方 app-server 接成 Assistant 的核心技术路径可行；恢复、隔离与计费归属只能部分确认，不能把原型直接当生产实现。** DeepSeek API、Claude Code 接 DeepSeek、Codex exec/resume、pi 的基本配置与续聊已实测。豆包缺凭据，明确保留实测缺口。

本报告响应下载的 `V0-0-ai-config-and-native-session-spike.md`，并对下载的 `0039-ai-profiles-and-reasoning-config.md`、`0040-native-agent-sessions.md` 提建议。三份附件是验证任务与待审设计输入，没有据此修改正式契约或把 Proposed 当作已批准设计。

## 1. 范围与环境

| 项目 | 本轮实测 |
|---|---|
| 系统 / 运行时 | macOS Darwin arm64；Bun 1.3.13；Node 24.18.0 |
| Codex | codex-cli **0.166.0**，位于要求的 0.160–0.200 范围内；仅验证这个版本 |
| Claude Code | **2.1.310**；`--bare -p`；DeepSeek 官方 Anthropic 端点，API 计费 |
| pi | **1.4.0**；非交互 JSON 与本地 RPC；DeepSeek API 计费 |
| API | DeepSeek `/v1`、`/anthropic/v1/messages`；豆包仅文档核验 |
| Git 基线 | `origin/main` 的 `191dfbcf54cb20f21bc072fb5d6d27cb22343b6d` |
| 隔离 | 独立 worktree、`codex/v0-ai-session-spike` 分支；合成工作目录、独立客户端状态；不部署 |

原工作树有另一会话未提交的改动，因此没有在那里 pull、切分支、暂存或写文件；fetch 后从已提交的远端基线创建新 worktree。仅修改新工作树的 `AGENTS.md`、`docs/DESIGN.md` 开发流程规则，以及本报告和 `scripts/spike/`。未修改 `apps/`、`packages/`、契约、锁文件或业务数据；没有新增依赖。

每项日期与版本均适用上表，JSON 证据另存实际时间。模型目录与供应商行为是当日快照，不代表整个版本区间、所有账户或其他操作系统。

使用本地已登录的 ChatGPT 认证仅供官方 Codex 进程使用，临时复制后删除；子进程剔除 OpenAI API key / base URL 环境变量。没有实现第三方 OAuth、直接请求私有订阅端点、修改全局 Codex / Claude / pi 配置。原生探针记录全局 Codex 配置前后校验相同。没有读写真实 vault。

## 2. 证据与复现

全部脚本和命令见 [`scripts/spike/README.md`](../../scripts/spike/README.md)。关键入口：

```bash
SPIKE_OUT=$(mktemp -d)
chmod 700 "$SPIKE_OUT"
bun scripts/spike/codex-session.ts --use-local-codex-login --out "$SPIKE_OUT/native.json"
bun scripts/spike/session-config.ts --use-local-codex-login --out "$SPIKE_OUT/config.json"
bun scripts/spike/providers.ts --use-local-pi-deepseek-key --out "$SPIKE_OUT/providers.json"
bun scripts/spike/cli-probes.ts --use-local-credentials --out "$SPIKE_OUT/cli.json"
# 自行配置 ARK_API_KEY / ARK_MODEL 后才会发起请求：
bun scripts/spike/doubao.ts --out "$SPIKE_OUT/doubao.json"
```

命令会使用本人订阅/API 额度。报告与提交证据只含事件名、字段结构、数值与合成结果，不含密钥、令牌、邮箱或 reasoning 正文；原始客户端测试会话留在私有临时目录，不提交。

| 证据文件（均在 `scripts/spike/evidence/`） | 内容 |
|---|---|
| [`native-evidence.json`](../../scripts/spike/evidence/native-evidence.json) | 成功全流程、模型目录、审批、211 条有序结构事件、用量、崩溃检查 |
| [`session-config-isolated-evidence.json`](../../scripts/spike/evidence/session-config-isolated-evidence.json) | MCP 隔离、实际工具调用、不同恢复方式 |
| [`default-connector-discovery.json`](../../scripts/spike/evidence/default-connector-discovery.json) | 未显式关闭连接器时的清单数量；未调用账号连接器 |
| [`cli-evidence.json`](../../scripts/spike/evidence/cli-evidence.json)、[`最终重跑`](../../scripts/spike/evidence/cli-final-evidence.json) | 三种 CLI、持久化模型/强度元数据、Claude 工具事件；最终脚本重跑通过 |
| [`provider-evidence.json`](../../scripts/spike/evidence/provider-evidence.json) | DeepSeek 两模型 × 七档接受性与工具续接 |
| [`provider-controls-evidence.json`](../../scripts/spike/evidence/provider-controls-evidence.json) | 缺失/空/null/完整 reasoning 对照，先测缺失再测完整 |
| [`doubao-evidence.json`](../../scripts/spike/evidence/doubao-evidence.json) | 缺少凭据与模型开通信息的 blocked 记录 |
| [`protocol-methods-0.166.0.json`](../../scripts/spike/evidence/protocol-methods-0.166.0.json) | 安装版本导出的完整 85 个通知、10 个服务端请求方法名 |

## 3. A：统一配置与思考强度

### A1. DeepSeek 思考续接——部分可行

实测官方 `/v1/models` 返回 `deepseek-flash`、`deepseek-v4-pro`；两者均接受 `thinking:{type:"enabled"}` 和 `reasoning_effort` 的七个请求值 `minimal/low/medium/high/xhigh/max/ultra`，14 次均 HTTP 200。这里证实的是**参数被接受**，不是内部推理预算已由服务端回显。

[官方思考模式文档](https://api-docs.deepseek.com/guides/thinking_mode/) 的映射为 `minimal/low → low`、`medium/high/xhigh → high`、`max/ultra → max`。该映射来自文档，不能用本轮 token 数证明同档等价。

工具首轮真实返回 `role/content/reasoning_content/tool_calls`，`reasoning_content` 为字符串。完整 assistant 消息原样回传，再附 `role:"tool"`、匹配的 `tool_call_id` 与合成结果，续接成功。另起 user 轮后继续带工具也成功。

**文档与实测不一致：**上述文档写缺少工具场景的 reasoning 会返回 400；本次两个模型的缺失、空字符串、null、完整值四组均返回 200。对照特意先发送缺失组，避免把“先完整请求成功”当作必需前提；服务自身仍有缓存，未证明内部如何处理丢失状态。Flash 后续 user 轮删掉以前全部 reasoning 也被接受。

摘录：

```text
initial: HTTP 200, finish=tool_calls, reasoningType=string
flash/pro controls: missing=200, empty=200, null=200, full=200
```

ADR 建议：provider 的续接状态必须无损保存；按官方协议回传，不依赖宽松校验，也不能写死“缺字段必定 400”。档位记录 requested 与 documented mapping，不能把请求成功当作实际预算证明。脚本：`providers.ts`，可加 `--controls-only` 只跑续接对照。

### A2. 豆包（火山方舟）——部分可行，未完成真实调用

本机未取得 `ARK_API_KEY` 和已开通的模型 ID；没有用其他账号或猜测凭据。`doubao.ts` 已运行并输出 blocked，没有伪装成成功。

[方舟深度思考文档](https://docs.volcengine.com/docs/ark/deep-thinking?lang=zh) 当前说明：Chat API 用 `thinking.type` 开关和 `reasoning_effort`，Responses 用 `reasoning.effort`；档位集合为 `none/minimal/low/medium/high/xhigh/max`，但模型映射不同。例如 Seed 2.1 Pro 260915 的 `none → minimal`、`xhigh/max → high`。部分模型返回摘要 `reasoning_content` 和 `encrypted_content`；工具续接应原样带回加密字段，单回摘要可能降低效果，缺失不一定报错。

[Responses 思考文档](https://docs.volcengine.com/docs/ark/responses-api-deep-thinking?lang=zh) 提供 `previous_response_id` 管理续接，不能与手工消息拼接混作同一种状态。

ADR 建议：能力表按 provider + 协议 + 精确模型版本维护；区分摘要展示与不可改写的续接状态。待提供可用凭据/模型后跑 `doubao.ts` 的完整/删加密/删全部状态对照；档位矩阵、流式拼接与真实效果仍未验证。

### A3. DeepSeek Anthropic 地址与 Claude 工具闭环——可行

官方地址为 `https://api.deepseek.com/anthropic`，实际 Messages 请求为 `/anthropic/v1/messages`；直连返回 HTTP 200，内容块类型为 `thinking/text`。地址依据 [DeepSeek Anthropic 接口文档](https://api-docs.deepseek.com/guides/anthropic_api/)。

实际给隔离的 Claude 子进程注入 `ANTHROPIC_BASE_URL` 与 API key，使用：

```text
claude --bare -p --model deepseek-flash --effort low
  --tools Read --allowedTools Read --output-format json
  --strict-mcp-config --mcp-config '{"mcpServers":{}}' --setting-sources ''
```

提示它读取临时合成文件。结果 `exit=0/subtype=success/is_error=false`，返回文件标记；合成会话记录中确认 `tool_use:Read → tool_result`，不只是文本回答。恢复后切 `deepseek-v4-pro/high` 也成功。

ADR 建议：**执行客户端与实际模型服务商分开**；`engine=claude` 不代表模型或计费来自 Anthropic。此项使用 DeepSeek API，不是 Claude 订阅。

### A4. Codex exec / resume 模型与强度——可行（0.166.0）

实测命令的关键参数：

```text
codex exec --skip-git-repo-check --sandbox read-only
  -m gpt-6.1-sol -c 'model_reasoning_effort="low"' --json <合成提示>
codex exec resume <测试 thread ID> --skip-git-repo-check
  -c 'sandbox_mode="read-only"' -m gpt-6.1-terra
  -c 'model_reasoning_effort="medium"' --json <续聊提示>
```

两次退出 0，恢复能回答前轮 codeword。JSON stdout 有 `turn.completed.usage`，但这组输出没有直接回显所用 effort。临时测试会话的 `turn_context` 元数据实际记录：

```json
[{"model":"gpt-6.1-sol","effort":"low"},
 {"model":"gpt-6.1-terra","effort":"medium"}]
```

不能只看命令行请求值就声称已验证实际采用。ADR 建议：保存 requested/effective 与观测来源；支持版本由探测决定，不能把这次结果外推到整个 0.160–0.200 区间。`exec resume` 的沙箱在本次用 `-c` 指定。

### A5. Claude Code 模型、effort 与 resume——部分可行

2.1.310 的 `-p --model <id> --effort <level>` 可用；`--resume <id>` 可更换模型和 effort。真实 API 请求的持久化元数据为：

```json
[{"model":"deepseek-flash","thinking":{"type":"adaptive","display":"omitted"},"output_config":{"effort":"low"}},
 {"model":"deepseek-v4-pro","thinking":{"type":"adaptive","display":"omitted"},"output_config":{"effort":"high"}}]
```

本轮证实客户端发送上述配置、DeepSeek 接受并完成同一 session；不声称服务端回显了内部实际预算。Claude 官方订阅模型的同组测试未执行，因此不能据此承诺 Claude 原生订阅接入已验收。

[Claude 模型配置文档](https://code.claude.com/docs/en/model-config) 说明 CLI effort 是单会话设置，组织上限等可影响生效值。ADR 建议：展示请求值和限制/实际值的区别，适配器按客户端版本做能力探测，不统一硬塞一个枚举。

### A6. pi 模型与 thinking——可行（1.4.0，DeepSeek）

实际参数：`pi -p --mode json --provider deepseek --model deepseek-flash --thinking low --session-id <合成 UUID>`，关闭扩展、MCP、skills、上下文文件与工具；随后相同 session ID 改为 `deepseek-v4-pro --thinking high`。两次退出 0，后一轮保留 codeword，assistant 事件回显对应 provider/model。

本机 `pi --help` 的 thinking 值：`off/minimal/low/medium/high/xhigh/max`。原会话初始记录只有 `thinking_level_change:low`，因此额外用 `--mode rpc` 的 `get_state` 检查恢复后的运行状态：`success=true/model=deepseek-v4-pro/thinkingLevel=high`。不能用初始持久化项代表后续实际状态。

ADR 建议：pi 的 thinking 枚举和 provider 原生 effort 分层，仍需供应商映射；不从 pi 支持 OAuth 推断 Lumio 获得第三方订阅接入许可。本轮未验证 pi 的订阅登录路径。

### A7. 非交互用量与计费归属——部分可行

| 路径 | 本轮观测到的用量 | 计费归属的证据与限制 |
|---|---|---|
| DeepSeek 直连 | prompt/completion/total、cache、reasoning token | 明确使用 DeepSeek 官方端点 + API key；HTTP usage 不等于最终账单 |
| Codex exec | `turn.completed.usage` 的 input/cached/output/reasoning | 子进程无 API key，官方客户端 `account/read.type=chatgpt`；不能仅从 usage 判断 |
| Codex app-server | `thread/tokenUsage/updated` 的 total/last + context window | 同上；有 `account/rateLimits/updated` 事件，但不是每轮金额 |
| Claude + DeepSeek | result 的 usage、按模型 modelUsage 与估算 cost | 实际路由为 DeepSeek；结果中仍出现 `provider:firstParty/costBasis:unknown`，这些标签不能证明是 Anthropic 订阅计费 |
| pi + DeepSeek | message_end 的 input/output/reasoning/cache 与 cost | provider/model 可见，cost 是客户端估计，归属应来自 Connection 的认证方式 |
| 豆包 | 未实测 | 缺凭据，不能验证账单与 token 字段 |

Codex exec 首轮例：input=17988、cached=12288、output=5；pi Flash 例：input=512、output=42、reasoning=40。缓存与 reasoning 可能是其他总量的子集，不能盲目重复相加。Claude 恢复输出的 modelUsage 含历史模型，不能把整份累计值再记成单轮费用。

ADR 建议：保存原始 usage 结构与作用域（单次/累计）、归属来源、估算标记；`subscription/API/unknown` 由连接与客户端认证状态共同决定。未知金额显示 unknown，不填 0，也不根据“有 cost 字段”判断 API 账单。

## 4. B：Codex app-server 原生会话

本节全部基于 0.166.0。主流程是官方 `codex app-server --listen stdio://`，换行 JSON-RPC；初始化声明 `experimentalApi:true`，未引入 SDK 依赖。官方说明见 [app-server 文档](https://developers.openai.com/codex/app-server)。

### B1. 生命周期、历史与事件——可行；事件覆盖有边界

实际完成 `thread/start`、`thread/read`、`thread/turns/list(itemsView:"full")`、`turn/start`、`turn/interrupt`、`thread/compact/start`、`thread/resume`。首两轮历史均 completed，保留 codeword。压缩本轮通过 `item/completed` 的 `contextCompaction` 确认完成，不能只等一个 `thread/compacted` 名称。

完整方法索引见 `protocol-methods-0.166.0.json`（85 通知 + 10 服务端请求，由**安装版本**导出，而非从最新网页猜测）。与本任务相关的分组：

| 分类 | 协议名 | 实测 |
|---|---|---|
| 正文 | `item/agentMessage/delta`、`item/started/completed` | 已观察 |
| 工具 | commandExecution / mcpToolCall 类型；`item/commandExecution/outputDelta`、`item/mcpToolCall/progress` 等 | 两种工具项已观察；没有声称每种增量都触发 |
| 思考摘要 | `item/reasoning/summaryPartAdded`、`summaryTextDelta` | 主流程已观察；只保留类型，不摘正文 |
| 思考其他 | `item/reasoning/textDelta` | 协议声明，本轮未观察 |
| 审批 | `item/commandExecution/requestApproval`、`mcpServer/elicitation/request`、`serverRequest/resolved` | 已观察并回答；前两者是服务端请求 |
| 用量 | `thread/tokenUsage/updated`、`account/rateLimits/updated` | 已观察 |
| 错误 | `error` 通知、JSON-RPC error、turn.error | 协议声明；成功主流程 errors=[]，未系统触发所有失败分支 |
| 生命周期 | thread/started、settings/status、turn/started/completed、contextCompaction | 已观察 |

ADR 建议：事件按类型与 item/turn/thread ID 归档，未知类型可保留并降级展示；错误通知、RPC 错误、失败轮次分别处理。协议完整清单与实测覆盖清单分开维护。

### B2. 每轮覆盖模型与 effort——可行

同一 thread 的 `turn/start` 首轮 `{model:"gpt-6.1-sol",effort:"low"}`、次轮 `{model:"gpt-6.1-terra",effort:"medium"}`，均 completed。`thread/settings/updated` 回显切换后的模型与 effort，历史仍连贯。

ADR 建议：每轮冻结 profile revision 和 requested/effective 设置；不能把 thread 最后设置当作所有历史轮次设置。此处有效配置回显不等于供应商证明实际推理预算。

### B3. 审批往返、等待与配置优先级——部分可行

真实命令审批的参数含 `threadId/turnId/itemId`、`command/cwd/reason`、`commandActions`、`availableDecisions` 等，完整脱敏字段结构在 native evidence。JSON-RPC 的请求 ID 须原样回传；本轮接受格式为：

```json
{"id":"<收到的原始请求ID>","result":{"decision":"accept"}}
```

仅接受精确匹配的合成 `printf` 标记命令，没有写持久规则或允许整个 session。实际保持审批 **65002 ms** 后接受，turn completed，标记文件正确。只证明该版本/运行条件能等待超过 65 秒；没有找到并验证无限等待或最大等待时限，不能承诺手机隔夜再批仍有效。

临时 `config.toml` 故意设 `approval_policy=never/sandbox_mode=read-only`；显式 `thread/start` 的 `on-request/user/workspace-write` 生效并真正弹出审批。未测试企业 managed requirements；不能宣称覆盖所有上层策略。恢复后的配置见 B4，不能只信最初锁定。

MCP 工具审批是另一格式：`mcpServer/elicitation/request`，回答 `{action:"accept",content:{}}`；用命令审批的 `decision` 回答会失败。首次探针据此修正后，合成 MCP 闭环成功。

ADR 建议：审批按请求类型编解码，绑定服务端实例 + request ID + thread/turn/item；超时/断连标过期，不跨重启重放旧接受消息。每次启动、恢复与发起轮次前核对有效策略，不能只设置一次。

### B4. 每会话 MCP、沙箱、网络、开发者指令——部分可行，恢复必须重新施加并校验

`session-config.ts` 在同一进程创建 alpha、beta：各自 `config.mcp_servers` 配置不同的本地合成 echo MCP，设置不同的 `sandbox_workspace_write.network_access`；`developerInstructions` 注入独立 codeword。实测：

```text
alpha: MCP=[alpha], networkAccess=false
beta:  MCP=[beta],  networkAccess=true
plain: MCP=[]
alpha tool: synthetic_echo_alpha completed; developerCodeReturned=true
```

这是实际配置回显与合成工具调用验证；没有把网络 flag 回显写成“已对所有网络路径做渗透测试”。命令沙箱不能替代 MCP 服务本身的网络/文件权限。

**恢复边界：**同进程 resume 保留设置；新进程只带 thread ID 时，回到默认 readOnly，MCP 清单重新出现账号连接器 `codex_apps`。在已经加载的 thread 上再 resume 覆盖，本轮未改变这组设置。重启到**另一个新进程，首次 resume 就显式传入完整配置**后恢复为 workspaceWrite、network=false、两个 tmp 排除=true、MCP=[alpha]。

另一次主流程恢复虽然显式带 workspace-write，未带 tmp 排除选项时，这两个选项从 true 回到 false。结论是 thread ID 不是完整权限快照。

初始未显式关闭 apps 的独立 HOME 探针仍发现账号关联工具；后续通过 `features.apps=false` 与 `apps._default.enabled=false`，实测仅剩合成白名单。没有调用那些账号工具。[官方配置说明](https://developers.openai.com/codex/config-reference/) 也明确连接器流量不受命令沙箱网络限制，因此 `networkAccess=false` 不代表没有其他出网工具。

ADR 建议：完整启动/恢复配置由 Lumio 快照持有并在首次加载时施加，再读实际工具清单和权限做 fail-closed 校验；运行中配置变化不能依赖重复 resume。是否需重建进程必须纳入 profile 切换策略。MCP 白名单之外，还须限制 apps/skills/hooks/插件/环境等工具来源；本轮未验证这些所有来源，也未验证对恶意输入的完整隔离。

### B5. 多 thread 与崩溃恢复——部分可行

同一个 app-server 中两 thread 并行生成均 completed，ID 不同、历史均可读取。空闲时 SIGKILL 服务，重新启动后用原状态目录恢复 thread，下一轮成功；活动时崩溃也可恢复，详情见 B6。

这只证明两个合成 thread 的功能性，不是长期稳定性、压力测试或跨账户隔离验收。客户端待处理 RPC 在进程退出时必须失败，而非永远等待。

ADR 建议：一个进程可以复用同账户的 thread，但不能把它当不同账户/权限的强隔离边界。首版优先按账户和权限配置隔离进程；持久化 native thread ID、客户端版本、配置快照与进程实例关系。恢复不能依赖进程内存。

### B6. 中断、杀进程与工具是否执行——部分可行；不能仅凭历史判断

正常 `turn/interrupt`：合成命令已写 STARTED、尚未写 FINISHED，轮次返回 interrupted，检查时 FINISHED=false，随后能压缩和续聊。没有把这一点外推为所有工具都可撤销。

崩溃实验更关键：执行 `STARTED → sleep 15 → FINISHED`，确认 STARTED 后 SIGKILL **app-server 进程本身**。恢复历史把该轮标为 interrupted，当时完整历史里没有完成的 commandExecution 项；但原命令到时后 **FINISHED=true**。这说明 shell 子进程可继续产生副作用，interrupted 不是“从未执行”或“已经停止”的证明。

```text
before kill: started=true, finished=false
recovered turn: interrupted
after original deadline: finished=true
next turn without replay: completed
```

未模拟系统重启、杀整个进程组、远程 MCP 已提交写入、磁盘损坏或 Hub/Runtime 链路断开。即便成功清理本地进程，也不能撤回已经提交的远端操作。

ADR 建议：工具未知状态与 conversation 是否可继续分开；断连/崩溃时保守标 unknown，不自动补发工具。Runtime 要管理进程组及受控退出，并对自己的工具保存执行意图、幂等键和结果；native shell/MCP 的未知副作用交给人核查，不能以重放恢复。

### B7. 动态模型与强度目录——可行

`model/list {limit:100}` 返回 8 个可用模型，包含 model/id、`defaultReasoningEffort` 与 `supportedReasoningEfforts[].reasoningEffort`。例如 gpt-6.1-sol 默认 low、gpt-6.1-terra 默认 low，支持 low/medium/high/xhigh/max/ultra；gpt-6-luna 没有 ultra。完整快照见 native evidence。

ADR 建议：目录按运行客户端/登录账户实时发现并带时间戳缓存；UI 根据选中模型约束档位。不要把这一账户的 8 个模型固化成所有用户的能力。

### B8. ChatGPT 登录状态下用量——可行；金额未知

`account/read` 脱敏后为 `{type:"chatgpt",requiresOpenaiAuth:true}`，无 OpenAI API key 环境注入。主流程观察到 14 次 `thread/tokenUsage/updated`。首例结构：

```json
{"total":{"inputTokens":18655,"cachedInputTokens":12032,"outputTokens":5,"reasoningOutputTokens":0,"totalTokens":18660},
 "last":{"inputTokens":18655,"cachedInputTokens":12032,"outputTokens":5,"reasoningOutputTokens":0,"totalTokens":18660},
 "modelContextWindow":475000}
```

因此订阅路径也可以展示 token 用量；不能据此推算扣了多少钱、剩多少可用对话或 API 等价金额。ADR 建议：订阅计费标记取认证事实，金额留 unknown，total/last 分开处理。

## 5. 最小原型的事件顺序

入口即 `scripts/spike/codex-session.ts`，已跑通用户要求的两轮、审批、interrupt、resume；此外补了压缩、多 thread 与两种杀进程恢复。以下为语义顺序，不假设异步通知的每次交错都相同；逐条类型顺序见 native evidence 的 trace。

```text
initialize → initialized
thread/start → thread/started → thread/settings/updated
turn/start → turn/started → item/started(userMessage)
  → [reasoning summary events] → item/agentMessage/delta
  → item/completed(agentMessage) → tokenUsage → turn/completed
第二轮：模型/effort 覆盖 → completed
命令轮：item/started(commandExecution)
  → item/commandExecution/requestApproval
  → 等待 65002ms → result.decision=accept → serverRequest/resolved
  → item/completed(commandExecution) → agentMessage → turn/completed
长命令：STARTED → turn/interrupt → turn/completed(interrupted)
thread/compact/start → item/completed(contextCompaction)
thread/resume → 新轮 → turn/completed
```

这里的 reasoning 只指客户端公开摘要事件，没有读取或承诺复刻隐藏系统提示、完整内部推理。能做原生对话会话壳与上下文控制，但“和官方界面所有表现完全相同”仍涉及官方工具、系统配置、个性化和客户端功能，不能由这些探针保证。

## 6. ADR 0039/0040 需要修改的地方

以下交给 Claude 修订 Proposed 文档，本轮未修改这些 ADR，也未审批 schema。

1. **先处理编号冲突。** 基线已存在 `docs/adr/0039-task-structure-and-readiness.md`；下载的 AI Profiles 0039 不能直接覆盖或占用相同编号。合入时与另一个会话协调分配新编号，并更新交叉引用。
2. **统一配置继续分 Connection / Profile / Binding。** Connection 明确 provider、协议、认证方式和执行 host；engine 与模型服务商、计费方分开。Profile 保存原生档位与 revision，Binding 管 cwd、审批、沙箱、工具白名单及凭据作用域，不把权限变成模型配置。
3. **档位与观测分层。** 保留 requested、effective/reported、文档映射及来源；无回显时允许 unknown。Codex 用动态目录；DeepSeek 接受七档不代表七个独立预算；Claude/pi 的枚举不能直接共享一个无来源字符串。
4. **供应商续接状态要完整保存。** DeepSeek reasoning、方舟 encrypted_content/摘要、Responses 续接 ID 按协议处理；展示摘要与协议状态分开。不能把所有引擎都降成 role/content 数组，也不能假定缺字段一定报错。
5. **恢复是重新绑定受控环境。** 持久化配置快照，不只存 thread ID；首次恢复前施加完整配置并核对实际沙箱、MCP/apps 清单。重复 resume 不能作为热更新配置的可靠手段；校验不符拒绝发送用户上下文。
6. **原生会话只承诺公开能力。** Assistant 展示流式正文、公开 reasoning 摘要与工具事件；Execution 可以输出摘要。两者共用配置底座，但不要用 Job 终态摘要充当 Assistant 的完整对话历史，也不要承诺完全复制官方产品 UI/隐藏上下文。
7. **审批协议不止一种。** 按命令、文件、MCP elicitation 等分别适配；pending approval 绑定进程实例与请求上下文，65 秒只是下界，断连/重启需过期处理。on-request/user 必须核对实际生效状态，不能承诺压过管理员策略。
8. **未知副作用必须保守处理。** app-server 被杀不一定杀掉工具子进程；interrupted 或历史缺工具项不能证明未执行。完善 Runtime 进程组管理、幂等和核查流程，不自动重放未知写操作。
9. **隔离与权限是首版前置条件。** 独立 HOME 不等于关闭账号连接器，network=false 不约束所有工具；MCP 服务自身也有宿主权限。需要排除真实 vault 的读取暴露，而非仅保证 cwd 不在 vault。工具目录、会话身份与 session credential 的生产授权尚未验证。
10. **用量、估算、账单分开。** 订阅可有 token；模型 cost 与 provider 标签不证明实际账单。以连接认证事实归属，用 unknown 表示无金额证据，避免累计用量重复记账。
11. **验收缺口明确保留。** 豆包真实请求、Claude 官方订阅、多账户/恶意输入隔离、managed policy、长时审批、压力测试、完整错误分支、Lumio 跨设备实时通道与能力目录 MCP 身份鉴权，均未因本次 spike 而完成。

## 7. 验证与进入下一阶段的建议

本轮完成 A1–A7、B1–B8 的逐项结论及可复现探针；做不到的已列出阻塞。正式实现可以继续走“官方客户端管理原生 session”方向，但应先把 B4/B6 的恢复与副作用边界写入设计，并保留豆包、Claude 订阅的验收门槛。

本次验证不构成商业授权、订阅条款、地区可用性或托管转售许可的证明；这些问题不能从官方客户端技术可调用推导出来。本轮未开展法律/商业条款审查。

仓库验证：`bun install --frozen-lockfile` 使用现有锁定依赖；`bun run check`（TypeScript、依赖方向与全量自动测试）；另执行实网合成探针、`git diff --check`、输出脱敏检查。完整检查结果为 **1223 pass、3 skip、0 fail**（1226 tests / 151 files）；后续仅补跑修改脚本的类型检查和对应合成探针。
