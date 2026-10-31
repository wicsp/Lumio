# Lumio

个人研究工作台：论文笔记、想法、项目/任务、实验结果，以及在多台设备上给 AI 派活。

- 数据（笔记/论文/任务…）**不在本仓库**，放在独立的 vault 仓库里（Markdown + YAML frontmatter）。
- 本仓库只放代码：TypeScript monorepo，运行在 [Bun](https://bun.com) 上。

先读：[`docs/DESIGN.md`](docs/DESIGN.md)（现行设计）→ [`AGENTS.md`](AGENTS.md)（AI 的规则）；文档导航见 [`docs/README.md`](docs/README.md)

## 目录

| 路径 | 内容 |
|---|---|
| `packages/schema` | 契约：用 Zod 定义的实体与 job 协议，唯一事实来源 |
| `packages/core` | vault 解析、链接、索引、BibTeX，纯本地逻辑 |
| `packages/api-client` | 调用 Hub 的 SDK，所有客户端共用 |
| `apps/cli` | `lumio` 命令行 |
| `apps/hub` | 服务器：HTTP API、job 队列、定时调度、提议队列 |
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
加执行器：在已配置的 CLI 上运行 `lumio runtime add <名称>`，到那台机器上运行它打印的一行命令。
装好后用 `lumio doctor` 检查，用 `lumio selftest` 以真实 agent 验证；已有安装用 `lumio upgrade` 升级。

只下载程序或指定版本：在安装脚本参数里使用 `--no-setup` 或 `--version vX.Y.Z`。
后台服务、日志与手动安装见 [macOS](infra/launchd/README.md)、[Linux](infra/systemd/README.md)。
数据可用任意 Markdown 编辑器编辑，Lumio 不管理编辑器配置。

## 源码开发

```sh
bun install
bun run check          # 类型检查 + 依赖边界检查 + 测试
bun run schema:export  # 把契约导出为 JSON Schema（packages/schema/json/）
```

## 当前阶段（2026-10-31，v0.1.6）

P0–P2 已完成，可以日常使用：

- **笔记**：`lumio new paper|idea`、`lumio sync`（自动补全元数据）；`search`/`show`/`links`/`check`/`export bib`。
- **Hub**：查询 API、监听文件并自动补全与提交、操作与提议、备份；给 AI 用的 skill（`skills/lumio`）。
- **给 AI 派活**：每台设备一个执行器；任务笔记里 `assignee: pi@server` 这类负责人即交接开关；例行任务；高权限命令的审批门。
- **安装**：一行安装、配对码加执行器、`doctor` / `selftest` / `upgrade`。

接下来：自检覆盖不到的人工验收，之后规划 P3/P4，见 [`docs/tasks/README.md`](docs/tasks/README.md)。

文档入口：[`docs/README.md`](docs/README.md)。
