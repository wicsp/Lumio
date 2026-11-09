# I1-0 试用更新命令加固

- 依据：[实验分支流程](../preview-workflow.md)（按需部署指定提交）
- 涉及：`scripts/update-preview.sh`、`scripts/update-preview.test.ts`
- 负责：Codex（实现），Claude review
- 不改契约、不加依赖、不碰真实 vault 与正式 Lumio 服务（`io.lumio.hub` 等）

## 背景

`update-preview.sh` 已经能从指定提交导出源码、编译、替换程序、重启 Hub 并核对版本。review 发现几处可以收紧的地方，本切片只做这些，不改变命令的用法和输出路径。

## 要求

1. **Runtime 重启后要确认**：Hub 版本核对通过、重启 Runtime 之后，在限定时间内确认试用 Runtime 已重新连上 Hub，
   超时则报错并指向试用日志。先核实现有手段（试用目录下的 CLI 配置、已有的 Hub 查询接口等），
   能用现有接口做到就不改 Hub；如果需要新的接口或改动 `/health` 输出，先停下来说明。
2. **版本核对不依赖 JSON 排版**：`/health` 的版本用 JSON 解析读取（如 `bun -e` 读标准输入），不用 `grep '"version":"…"'`。
3. **plist 不会重新读取**：在 `restart` 旁注明 `kickstart -k` 只重启已加载的服务；plist 校验通过但与已加载的定义不一致时
   （比较 `launchctl print` 里的程序路径与 plist），提示用户按试用文档 `bootout` 再 `bootstrap`，不自动重载。
4. 保留现有行为：提交解析、独立源码导出、Darwin 检查、试用目录与 plist 校验、更新锁、Bun 版本检查、构建失败不影响运行中服务、
   只在上次部署成功时覆盖 `bin/lumio.previous`、成功后才写 `preview-commit`。

## 验收

- `shellcheck scripts/update-preview.sh` 通过；`bun run check` 通过。
- Linux CI 上覆盖锁已存在时拒绝运行并保留原锁，以及指定提交独立于当前工作树。
- Mac 人工验收用两个不同的提交分别更新 7421，并核对记录的 SHA。人为让 Hub 启动失败时，`bin/lumio.previous` 保持上一次成功的程序。
