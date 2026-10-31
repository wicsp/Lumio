# Lumio

个人研究工作台：论文笔记、想法、项目/任务、实验结果，以及在多台设备上给 AI 派活。

- 数据**不在本仓库**：知识正文在独立 vault（Markdown + frontmatter）；项目/任务、执行与助手状态在 SQLite；过程记录与产物用 JSONL/文件。
- 本仓库只放代码：TypeScript monorepo，运行在 [Bun](https://bun.com) 上。

先读：[`docs/DESIGN.md`](docs/DESIGN.md)（现行设计）→ [`AGENTS.md`](AGENTS.md)（AI 的规则）；文档导航见 [`docs/README.md`](docs/README.md)

## 目录

| 路径 | 内容 |
|---|---|
| `packages/schema` | 契约：用 Zod 定义的实体与 job 协议，唯一事实来源 |
| `packages/knowledge` | 知识文档、解析、补全、链接与引用用例 |
| `packages/work` | Project、Task、讨论、关系与显式派活 |
| `packages/execution` | Job、Routine、设备能力与执行规则 |
| `packages/assistant` | 对话、记忆、模型端口与工具循环 |
| `packages/storage` | 文件/索引/SQLite 适配、JSONL、产物、备份与显式迁移 |
| `packages/foundation`、`packages/platform` | ID/错误，以及终端、诊断、安装维护 |
| `packages/core` | 旧 API 兼容转发，应用已改用明确模块 |
| `packages/api-client` | 调用 Hub 的 SDK，所有客户端共用 |
| `apps/cli` | `lumio` 命令行 |
| `apps/hub` | HTTP、鉴权/审计、模块组装与跨模块协调 |
| `apps/runtime` | 每台设备上的 daemon，领取 job 并调用 agent |
| `apps/feishu-bot` | 飞书入口与通知 |
| `apps/web` `apps/chrome-ext` `apps/mobile` | 后期客户端 |
| `sdk/python` | 实验侧的薄客户端（后期），类型从导出的 JSON Schema 生成 |
| `infra/` | Docker / Nix（后期） |

## 安装

macOS arm64、Linux x64/arm64，无需安装 Bun：

```sh
curl -fsSL https://raw.githubusercontent.com/wicsp/Lumio/main/install.sh | sh
```

程序装到 `~/.local/bin`；按终端提示把它加入 PATH。默认单机模式会配置 Hub、本机执行器和 CLI，
vault 默认在 `~/.config/lumio/vault`，可用 `lumio-hub setup --vault /已有的笔记目录` 指定。
安装可重复运行，CLI 配置文件会自动更新，令牌不显示在终端。
指定已有 vault 也可以只运行一行：

```sh
curl -fsSL https://raw.githubusercontent.com/wicsp/Lumio/main/install.sh | sh -s -- --vault "/已有的笔记目录"
```

安装脚本会尝试从终端询问设置；没有终端时使用已有配置或默认值，并打印实际配置与修改方法。
`setup` 和 `install-service` 须用安装后的独立程序运行，源码入口会拒绝安装后台服务。

服务器模式（Hub 与 vault 在服务器上）：

```sh
curl -fsSL https://raw.githubusercontent.com/wicsp/Lumio/main/install.sh | sh -s -- --server
```

设置监听地址与对外地址，HTTPS 交给反向代理，见 [Caddy 示例](infra/README.md#caddy-反向代理)。
没有公网地址时，Tailscale 是一种办法；检测到已安装时 setup 可以帮助配置。
加执行器使用 `lumio runtime add <名称>`（P2-8 提供）。安装到的版本须已包含相应命令。

只下载程序或指定版本：在安装脚本参数里使用 `--no-setup` 或 `--version vX.Y.Z`。
后台服务、日志与手动安装见 [macOS](infra/launchd/README.md)、[Linux](infra/systemd/README.md)。
知识正文可用任意 Markdown 编辑器编辑；Task/Project 描述通过带版本副本编辑，状态与负责人通过 Lumio 修改。
已有任务笔记需按[迁移与回退说明](docs/migration-v2.md)显式切换；启动不自动迁移数据。
内置助手的模型配置与记忆命令见[助手说明](docs/assistant.md)。

## 源码开发

```sh
bun install
bun run check          # 类型检查 + 依赖边界检查 + 测试
bun run schema:export  # 把契约导出为 JSON Schema（packages/schema/json/）
```

## 当前阶段

四模块重构已在本分支实现：Knowledge、Work、Execution、Assistant 独立用例与存储端口，Hub 负责组合。
保留现有可靠派活、离线交付和审批路径，增加数据库业务对象、JSONL/文件归档与可验证备份。
实现和验收证据见 [R0-0](docs/tasks/R0-0-four-module-refactor.md)。真实数据切换、安装升级和发布不在自动测试中执行。

文档入口：[`docs/README.md`](docs/README.md)。
