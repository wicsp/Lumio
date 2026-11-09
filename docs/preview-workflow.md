# 实验分支与本机试用

`preview` 是本机试用的集成分支，可以同时试用多个尚未进入 `main` 的功能。验收以单个功能为单位。通过的功能从自己的分支开 PR 进入 `main`，其他功能继续在各自的分支修改。

## 分支关系

- 功能分支从最新的 `origin/main` 开，避免把其他待验收功能带进自己的 PR。确实依赖另一个未合入的功能时，先说明依赖并确定合并顺序。
- `preview` 通过合并或 revert 向前推进。部署检出只做快进更新。
- 新功能仍须带测试，契约改动仍须经人类批准。仅供试用的提交可以先跑受影响的测试。完整规则见 [AGENTS.md](../AGENTS.md)。

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

## 合入一个功能

一次由一个集成会话负责。在干净的 worktree 中，从最新 `origin/preview` 建立集成分支，合入功能分支，运行受影响的测试并编译。示例中的 `feature_branch` 是远端功能分支名。

```sh
git fetch origin
git switch -c codex/preview-integration-example origin/preview
git merge --no-ff --no-commit "origin/$feature_branch"
bun install --frozen-lockfile
# 用 bun test 加上受影响的测试路径
build_dir=$(mktemp -d)
bun run apps/cli/src/build-binary.ts --outfile "$build_dir/lumio"
git commit -m "preview: integrate $feature_branch"
git push origin HEAD:refs/heads/preview
```

如果远端已前进，重新获取最新的 `origin/preview`，解决冲突并复验后再推送。推送后 GitHub Actions 会跑完整检查，供集成会话发现组合版本的问题。失败时修复或撤下相关功能。

主线有新合并时，串行把 `origin/main` 合入 `preview`，验证组合结果后推送。只在 `preview` 上解决的冲突如果影响功能行为，要把相应修正带回该功能分支，并试用修正后的版本。

如果需要撤下某个功能，在 `preview` 上执行 `git revert -m 1 <集成合并提交>`。重新试用该功能时，先撤销这次 revert，再合入修复提交，并将两步作为一批测试和推送。若功能后来已在 `main` 合入，同步主线时也要核对原 revert 是否仍抵消功能，必要时在同一批同步中撤销它。

## 本机更新

Mac 使用专用部署检出，首次执行：

```sh
git clone --single-branch --branch preview ssh://git@github.com/wicsp/Lumio.git ~/Projects/lumio-preview
```

之后执行这一条命令：

```sh
(cd ~/Projects/lumio-preview && ./scripts/update-preview.sh)
```

命令要求已配置 [独立试用服务](native-assistant-trial.md#本机部署与停止) 和仓库指定的 Bun。它使用 `io.lumio.native-trial.*` 两个 launchd 服务及 `~/.local/share/lumio-native-trial/`，地址为 <http://127.0.0.1:7421>。这个实例使用独立状态，知识 vault 保持未挂载。部署检出用于快进更新，功能开发在其他 worktree 中进行。

命令依次快进拉取、安装锁定依赖、编译、替换程序、重启 Hub 并验证其版本，然后重启 Runtime。部署成功的 SHA 写到试用目录的 `preview-commit`。构建失败时当前服务继续运行。替换后的启动失败可查试用目录下的 `logs/`，上一次的程序保存在 `bin/lumio.previous`。恢复程序前要核对试用数据库的迁移兼容性。运行中的试用任务会受到重启影响，更新前先等任务结束。已有 launchd 服务重启时沿用已加载的 plist，修改 plist 后按[独立试用服务说明](native-assistant-trial.md#本机部署与停止)重新加载。Runtime 重新连通的自动检查列入 [I1-0](tasks/I1-0-preview-updater.md)。

## 验收与发布

1. 用户在试用实例上确认通过的功能，并提供当时的 `preview-commit`。
2. 每个通过的功能从自己的分支开一个 PR 到 `main`，完整 CI 通过后合并。若功能分支为解决主线冲突而改变了试用结果，先把变化合入 `preview` 重新验收。
3. 将合并后的 `origin/main` 同步到 `preview`。试用分支上可以继续集成其他待验收功能。
4. 正式 `v*` 标签指向 `main` 上的提交。Release workflow 校验主线归属并重新跑全量检查后发布。
