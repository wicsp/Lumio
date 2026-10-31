# 内置助手

助手拥有自己的对话、轮次、工具记录和显式记忆，不要求配置知识目录。
对话和记忆保存在 Hub 的业务数据库中；备份需包含业务数据库与托管文件，不能只备份 vault。

## 配置模型

Hub 支持兼容 Chat Completions 的 HTTP 服务；不预设供应商、服务地址或模型。
在 **Hub 服务的运行环境**中配置，例如本机模型服务：

```sh
export LUMIO_ASSISTANT_BASE_URL='http://127.0.0.1:8080/v1'
export LUMIO_ASSISTANT_MODEL='你的模型名'
# 若服务要求鉴权，由凭据管理器向 Hub 环境注入 LUMIO_ASSISTANT_API_KEY。
```

地址填 API 基础路径，程序追加 `/chat/completions`。不接受地址内的用户名、密码、查询参数或片段。
密钥不写入仓库或 Lumio 配置文件；更换服务环境后重启 Hub。交互终端里的环境变量不会自动传给已经启动的后台服务。
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
遗忘清除活动记忆和记忆命令回执中的原文；已发生的聊天、审计与历史备份按各自保留规则管理。

`remember --sources '<ResourceRef JSON 数组>'` 供接入来源适配器后的场景使用。
默认没有来源读取适配器，带来源的保存会被拒绝。接入时保存、重放和每次使用都要按助手 agent 权限重查来源，不能借聊天用户身份绕过私密规则。

## 工具边界

当前默认启用对话与显式记忆，不自动开启知识检索、Work 写入、派活、批准或私密访问。
领域循环支持通过 Hub 组装注入工具，每个工具通过公开接口与统一授权执行，并自行用对应契约校验参数。
工具身份是持久的独立 agent；对话 owner 只表示数据归属，不能当作操作权限。
如以后增加人类委托能力，需单独规定权限和审批，不因工具循环已经可用而默认授权。

工具调用有 prepared/running/succeeded/failed/unknown 记录。进程中断或写入结果不明时不自动重放；先核查实际结果。
运行日志中的 JSONL 用于过程追踪，不代替对话、任务和执行状态的数据库权威记录。
