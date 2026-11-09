# 主线开发与本机沙盒

## 日常开发与发布

从最新的 `origin/main` 建立功能分支。每个 PR 通过交叉 review 和完整 CI 后合入 `main`。开发者用主线构建的日常实例验收功能；发现问题，在主线上修复或 revert。准备对外发布时，从已验收的主线提交推送正式 `v*` 标签。Release workflow 校验提交属于主线，重跑全量检查并创建 GitHub Release。

从源码更新有日常数据的 7420 前，先用 `lumio hub backup business <新目录>` 创建业务快照，再用 `lumio hub backup verify <目录>` 校验。涉及迁移时先在独立沙盒验证，并确认备份可恢复。业务备份、vault 和安装配置的边界见 [Hub 部署与备份](design/hub.md#存放)。

## 按需试用一个分支

遇到高风险改动或需要合入前体验时，可以把指定提交部署到独立的 7421。先更新本地远端引用，再从包含本脚本的仓库检出运行：

```sh
git fetch origin
./scripts/update-preview.sh origin/feature-branch
```

派给 agent 的命令统一使用 `lumio`。新版本的 Runtime 会优先提供本实例的二进制和任务临时凭据。

脚本也接受本地分支名、标签或提交 SHA。它从指定提交导出源码构建，工作树里的未提交改动不会进入试用程序。成功后在试用目录的 `preview-commit` 记录部署的 SHA。

脚本使用现有的 [独立试用服务](native-assistant-trial.md#本机部署与停止) 和仓库指定的 Bun。构建完成才替换程序，重启后核对 Hub 版本再重启 Runtime。旧程序保存在 `bin/lumio.previous`；换回旧程序前先核对试用数据库的迁移兼容性。更新前等试用任务结束。

## 用命令行连接试用实例

这台 Mac 的 `~/.local/bin` 里有两个入口。按你要操作的数据选择命令。

| 命令 | 默认连接 | 程序和客户端配置 |
| --- | --- | --- |
| `lumio` | [7420 日常实例](http://127.0.0.1:7420) | `~/.local/bin/lumio`，读取 `~/.config/lumio/config.json` |
| `lumio-preview` | [7421 试用实例](http://127.0.0.1:7421) | 使用 `~/.local/share/lumio-native-trial/bin/lumio` 和 `~/.local/share/lumio-native-trial/client.json` |

```sh
lumio hub status
lumio-preview hub status
lumio-preview task list --status active --json
lumio-preview --version
```

`lumio-preview` 直接转发日常子命令和参数，并使用试用配置中的 token。即使当前 shell 已设置其他 Hub 地址、token 或 vault，试用入口也会使用自己的连接配置。两个实例各有自己的任务、项目、助手会话和执行记录。试用实例当前没有挂载知识 vault，`new` 和 `sync` 这类本地文件命令需要显式指定试用 vault。

试用配置已经配好。检查连接用 `lumio-preview hub status`，更新试用程序和服务用下文的 `update-preview.sh`。会访问默认安装的配置或管理本机服务的命令（如 `login`、`logout`、`doctor`、`upgrade` 和 `hub setup`）由试用入口拦截。
