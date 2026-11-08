# 原生 Codex Assistant 本地试用

本切片对应 ADR 0041/0042、任务 M1-0。程序版本 `0.2.0-native-trial`，Bun 1.4.4，macOS，Codex CLI **0.166.0**；尚未合并或发布。

## 打开与登录

1. 打开 <http://127.0.0.1:7421/#assistant>。这是独立试用 Hub；现有 7420 服务及原业务数据不受影响。
2. 如果新浏览器要求配对，在本机终端运行：

   ```sh
   ~/.local/share/lumio-native-trial/login.sh
   ```

   复制输出中 `--code` 后的配对码填入页面。配对码十分钟内有效、只能使用一次，长期令牌不用手动复制。
3. 选择 `Codex · 官方客户端` Profile，输入消息并发送，创建隔离会话。首次不会调用模型，消息保留为草稿。
4. 点击「使用 Codex 登录」，再点「打开官方登录页」，按官方流程登录自己的 ChatGPT 账号并输入设备码。登录完成后动态显示该账号可用的模型与 effort，再发送草稿。
5. 同一对话内继续聊天；可以选模型/强度、压缩上下文、审批或中断。新原生对话使用另一份客户端状态，需独立登录。登录码过期或试用服务重启后重新点击登录按钮，不沿用旧设备码。

正式试用没有复制你的全局 Codex 登录。官方账号认证仍需你本人完成；设备码登录如被账号设置限制，按官方提示开启或处理。

## 可以试什么

数据库里只有两条标为「试玩」的合成任务，没有挂载知识 vault。例如：

- “读取试用任务，给我一个简短总结。”
- “新建一个叫『周末测试』的任务，并告诉我它的 ID。”
- 下一轮追问上一条结果，或切换模型与 effort 后继续同一个 thread。

设置页的「AI 配置」管理连接与 Profile。可添加 DeepSeek、豆包或其他兼容 API 的 Hub 连接，密钥只写不读；DeepSeek 提供已验证的思考模式和 low/high/max，其他未验证服务仅开放默认思考设置。旧单 API 配置折叠保留。

原生会话首版只有 Codex。Claude 原生接入、任务/Routine 选择这些 Profile、Job3 迁移、Linux 隔离不在此切片；旧 Job2 和摘要任务执行不变。

## 断线、恢复与未知结果

- 普通网页离开不会取消原生运行；重新打开对话查看保存状态。执行器闲置断线可恢复原 thread；本地状态丢失会失败，不偷偷创建替代 thread。
- 活跃断线、中断或受理结果不明进入 unknown；同一所有者的原生运行冻结，不自动重放消息和写操作。
- 先检查工作区、任务变化、工具回执与相关进程是否确实停止，再勾选检查确认、填写结论并记录核查。旧会话关闭后才可开新的原生环境；这不撤销之前的副作用。
- 删除到回收站的原生对话不能继续调用工具。若其中有未核查 unknown，先恢复对话并核查，再彻底删除，避免丢失证据。
- 彻底删除清理 Hub 的原生交付、事件与工具记录；只留用于拒绝重放/确认迟到事件的 ID。Runtime 的官方历史、认证和工作区是设备私有状态，不等于被业务删除操作擦除；本试用保留它们供核查，勿当作跨设备数据擦除功能。

## 本机部署与停止

- 程序/私有配置/状态：`~/.local/share/lumio-native-trial/`；包含凭据，目录 700、凭据文件 600，不上传或分享。
- 服务：`io.lumio.native-trial.hub`、`io.lumio.native-trial.runtime`。服务定义位于自己的 `~/Library/LaunchAgents/` 下；不使用正式 Lumio 的标签。
- Hub 仅监听 `127.0.0.1:7421`；Runtime 显式启用 `LUMIO_NATIVE_SESSIONS=1`。日志在试用目录的 `logs/`，不含原生认证材料。

停止试用，不删除数据：

```sh
trial_uid="$(id -u)"
launchctl bootout "gui/$trial_uid/io.lumio.native-trial.runtime"
launchctl bootout "gui/$trial_uid/io.lumio.native-trial.hub"
```

启动：

```sh
trial_uid="$(id -u)"
launchctl bootstrap "gui/$trial_uid" "$HOME/Library/LaunchAgents/io.lumio.native-trial.hub.plist"
launchctl bootstrap "gui/$trial_uid" "$HOME/Library/LaunchAgents/io.lumio.native-trial.runtime.plist"
```

停止后保留整个试用目录作为一致的本地核查材料；恢复正式使用只需继续打开原 Hub，无需把试用库覆盖回原业务库。是否合并代码由试用者决定。
