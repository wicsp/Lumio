# 内置助手

助手拥有自己的对话、轮次、工具记录和显式记忆，不要求配置知识目录。
对话和记忆保存在 Hub 的业务数据库中；备份需包含业务数据库与托管文件，不能只备份 vault。

## 配置模型

Hub 支持兼容 Chat Completions 的 HTTP 服务；不预设供应商、服务地址或模型。
可以通过 Web 设置页或以下命令配置（仅 human）：

```sh
lumio hub assistant setup
lumio hub assistant status
lumio hub assistant clear
# 非交互模式：密钥只经标准输入，不能放在参数里
凭据管理器输出命令 | lumio hub assistant setup --base-url http://127.0.0.1:8080/v1 --model 你的模型名 --api-key-stdin
```

交互式密钥输入不回显。setup 先用一次最小请求验证，失败不写配置；`--skip-check` 可跳过验证。
配置经运行中的 Hub 原子写入私有环境文件 `~/.config/lumio/hub.env`（目录 700、文件 600），保留其他项目，
在进程内重新加载模型适配器；下一轮对话立即使用新配置，不重启服务。尚无 CLI 连接配置时，命令复用同一个本地配置实现。
status 只显示地址、模型和密钥是否设置；clear 删除这三项。密钥只写不读，不进入响应、日志或审计详情。

HTTP 接口（human 专用）：

- `GET /v2/assistant/config` → `AssistantConfigView`，包含 `base_url`、`model`、`api_key_set`、`managed`。
- `PUT /v2/assistant/config` 接受 `AssistantConfigUpdate`。`api_key` 缺省保留原密钥，`clear_api_key: true` 删除密钥；二者不能同时提供。
  `check` 缺省为 true；验证失败返回 `INVALID`，reason 为 `assistant-config-address|auth|model|response|timeout`，不改变原配置。
- `DELETE /v2/assistant/config` 清除模型配置并返回新的安全视图。

安装生成的 macOS 服务不再将模型密钥复制进 plist；Linux 服务用管理标记区分环境文件中的配置与外部注入。
旧版服务可重新执行 `lumio hub setup` 更新服务定义。直接由外部运行环境注入的配置返回 `managed=false`，接口拒绝修改或清除；需在外部环境中修改。
`lumio doctor` 显示本机助手是否配置；未配置仅提醒。

高级用法：也可在 **Hub 服务的运行环境**中配置，例如本机模型服务：

```sh
export LUMIO_ASSISTANT_BASE_URL='http://127.0.0.1:8080/v1'
export LUMIO_ASSISTANT_MODEL='你的模型名'
# 若服务要求鉴权，由凭据管理器向 Hub 环境注入 LUMIO_ASSISTANT_API_KEY。
```

地址填 API 基础路径，程序追加 `/chat/completions`。不接受地址内的用户名、密码、查询参数或片段。
密钥不写入仓库或 `config.json`；更换服务环境后重启 Hub。交互终端里的环境变量不会自动传给已经启动的后台服务。
不配置模型仍可使用 Work、Execution 和 Knowledge；聊天会明确提示尚未配置。

```sh
lumio chat '帮我梳理这个想法'
lumio chat list
lumio chat show conv_01J9Z3K8M2N4P6Q8R0S2T4V6W8
lumio chat '接着讨论' --conversation conv_01J9Z3K8M2N4P6Q8R0S2T4V6W8 --stream
```

`--json` 返回完整结果；`--stream` 返回逐行事件；`--model` 可为本轮指定同一服务支持的模型。
同一 `--request-id` 的相同请求返回已保存结果。连接中断或结果不明时先 `chat show` 核对，勿换请求编号盲目重复副作用操作。
响应截断、工具参数非法、未知工具、输出限制和服务错误会明确失败，不自动重试模型请求。

## 显式记忆

```sh
lumio chat memory remember '回答时先给结论，再解释理由' --json
lumio chat memory list --json
lumio chat memory forget mem_01J9Z3K8M2N4P6Q8R0S2T4V6W8 --json
```

只有用户明确保存的偏好或事实进入记忆，不从聊天自动提取。每位用户只能读取和遗忘自己的记忆。
`--request-id` 支持重试同一命令；遗忘后重放旧 remember 请求返回 forgotten，不恢复原文。
遗忘清除活动记忆和记忆命令回执中的原文；已发生的聊天、模型请求快照、审计与历史备份按各自保留规则管理。

`remember --sources '<ResourceRef JSON 数组>'` 供接入来源适配器后的场景使用。
默认没有来源读取适配器，带来源的保存会被拒绝。接入时保存、重放和每次使用都要按助手 agent 权限重查来源，不能借聊天用户身份绕过私密规则。

## 工具边界

Hub 将 `packages/schema` 中的 `CAPABILITIES` 注册为助手工具；名称经 `toolName()` 转换，参数使用 Zod 的 JSON Schema 导出。
HTTP 与助手都经同一个能力执行层校验参数、授权并调用所属模块的公开接口。

工具身份始终是持久的独立 agent，不继承对话用户的操作权限：

- 可读取公开笔记、任务、项目、执行轮次、例行任务、待批准提议和需要处理的事项。
- 可创建任务和项目、更新字段、评论任务；任务状态仅可设置为 todo / active / waiting / paused。指定负责人不会派活。
- 不能完成或取消任务、派活、创建或修改例行任务、批准或拒绝提议、删除或归档、标记轮次已查看。拒绝原因会返回模型。
- 只有 human 拥有的对话，通过 Hub 进程内组装的工具才能读取私密笔记；每次读取在工具记录中设置 `private_read` 并审计。
  HTTP agent 令牌不能访问这条路径，私密读取不会自动存入记忆。

成功写入在 `AssistantToolCall.change` 保存目标、更新前字段和写入后的 revision；新建和评论没有可逆 patch。
`GET /v2/assistant/conversations/<id>/tools` 返回对话拥有者可见的工具记录。
`POST /v2/assistant/tools/<id>/undo`（human，带 `request_id`）将原 `before` 作为普通更新 patch、`after_revision` 作为 `expected_revision`。
对象已有后续修改时返回 `CONFLICT`，不会覆盖；成功后标记 `change.undone`。创建和评论暂不提供撤回。

## 提问与验收

`GET /v2/work/attention`（能力 `work.attention.list`）只显示每个任务最新一轮已写回的结果：提问为 question，正常结束为 review，失败或结果不明为 failed。
新一轮派出、任务变为 done / cancelled / paused、轮次已查看后消失；旧轮次不会残留。

```sh
lumio attention --json
lumio task continue task_01J9Z3K8M2N4P6Q8R0S2T4V6W8 --comment '使用第一份合成输入'
lumio task ack task_01J9Z3K8M2N4P6Q8R0S2T4V6W8 --round 1
```

回答与派活共用事务，失败不保存评论，同一 request_id 重试不重复评论。`ack` 只记录已查看，不改变任务状态，仅 human 可用。
给派出 agent 的固定说明要求：需要信息或确认时，用 `<lumio-question>` 提出一个明确问题并结束本轮；做完按「结果 / 改动 / 验证」汇报，不宣布任务完成。

工具调用有 prepared/running/succeeded/failed/unknown 记录。进程中断或写入结果不明时不自动重放；先核查实际结果。
运行日志中的 JSONL 用于过程追踪，不代替对话、任务和执行状态的数据库权威记录。

每次模型调用前保存一份不可变请求快照，记录所属轮次和工具身份；存储失败不调用模型。快照不代表远端已接收，不用来自动重放，随业务备份保留。
