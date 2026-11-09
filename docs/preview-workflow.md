# 实验分支与本机试用

`preview` 收集准备一起试用的改动。功能开发继续使用独立分支和 worktree，契约审批、测试数据隔离和新功能带测试的规则照常执行。只供试用的功能提交可以先跑受影响的测试。集成会话负责构建组合结果、解决冲突并推送。

## 合入一个功能

在干净的集成 worktree 中，从最新 `origin/preview` 建立该会话的集成分支。把选定的已提交功能合入，运行受影响的测试和本机编译。通过后提交并直接推送到 `preview`。示例中的 `feature_ref` 是待合入的提交或分支。

```sh
git fetch origin
git switch -c codex/preview-integration-example origin/preview
git merge --no-ff --no-commit "$feature_ref"
bun install --frozen-lockfile
# 用 bun test 加上受影响的测试路径
build_dir=$(mktemp -d)
bun run apps/cli/src/build-binary.ts --outfile "$build_dir/lumio"
git commit -m "preview: integrate <功能>"
git push origin HEAD:refs/heads/preview
```

一次由一个会话集成。推送被拒绝时重新获取远端，基于最新 `origin/preview` 解决冲突并复验。禁止强推。主线有相关改动时，同样串行把 `origin/main` 合入 `preview`，先验证组合版本。

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

命令依次快进拉取、安装锁定依赖、编译、替换程序、重启 Hub 并验证其版本，然后重启 Runtime。部署成功的 SHA 写到试用目录的 `preview-commit`。构建失败时当前服务继续运行。替换后的启动失败可查试用目录下的 `logs/`，上一次的程序保存在 `bin/lumio.previous`。恢复程序前要核对试用数据库的迁移兼容性。运行中的试用任务会受到重启影响，更新前先等任务结束。

## 验收与发布

用户确认所验收的 SHA 后，冻结这一批改动并开一个 `preview → main` PR。若之后加入新提交或解决主线冲突，要重新试用变化后的版本。通过完整 CI 后用合并提交合入 `main`，使后续批次能沿用共同历史。只在合入后的主线提交上推送正式 `v*` 标签。Release workflow 校验主线归属并重新跑全量检查后再发布。
