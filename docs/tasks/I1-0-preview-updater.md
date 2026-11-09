# I1-0 试用更新命令加固

- 依据：[实验分支流程](../preview-workflow.md)（2026-11-09 改为按单个功能验收）
- 涉及：`scripts/update-preview.sh`、`scripts/update-preview.test.ts`
- 负责：Codex（实现），Claude review
- 不改契约、不加依赖、不碰真实 vault 与正式 Lumio 服务（`io.lumio.hub` 等）

## 背景

`update-preview.sh` 已经能快进拉取、编译、替换程序、重启 Hub 并核对版本。review 发现几处可以收紧的地方，本切片只做这些，不改变命令的用法和输出路径。

## 要求

1. **整段解析后再执行**：把脚本主体包进函数（如 `main() { …; }; main "$@"`，最后一行之前不执行任何操作），
   让 bash 在 `git pull` 改写脚本文件之前就读完全部内容。
   拉取后若脚本本身有变化，仍用新版本重新执行（目标提交的部署逻辑以目标提交为准），但锁要连续持有：
   通过环境变量（如 `LUMIO_PREVIEW_LOCK_HELD=<锁路径>`）把已持有的锁交给新进程，通过 exec 接管时同时核对锁路径和锁中记录的当前进程 PID；单靠环境变量中的路径不能证明持有锁。不先释放再重新获取；
   重新执行最多一次，防止循环。
2. **Runtime 重启后要确认**：Hub 版本核对通过、重启 Runtime 之后，在限定时间内确认试用 Runtime 已重新连上 Hub，
   超时则报错并指向试用日志。先核实现有手段（试用目录下的 CLI 配置、已有的 Hub 查询接口等），
   能用现有接口做到就不改 Hub；如果需要新的接口或改动 `/health` 输出，先停下来说明。
3. **版本核对不依赖 JSON 排版**：`/health` 的版本用 JSON 解析读取（如 `bun -e` 读标准输入），不用 `grep '"version":"…"'`。
4. **plist 不会重新读取**：在 `restart` 旁注明 `kickstart -k` 只重启已加载的服务；plist 校验通过但与已加载的定义不一致时
   （比较 `launchctl print` 里的程序路径与 plist），提示用户按试用文档 `bootout` 再 `bootstrap`，不自动重载。
5. 保留现有行为：分支与干净检查、Darwin 检查、试用目录与 plist 校验、更新锁、Bun 版本检查、构建失败不影响运行中服务、
   只在上次部署成功时覆盖 `bin/lumio.previous`、成功后才写 `preview-commit`。

## 验收

- `shellcheck scripts/update-preview.sh` 通过；`bun run check` 通过。
- 测试（在 Linux CI 上可跑，不调用 launchctl）：现有两项继续通过；新增：
  - 锁已存在时拒绝运行，且不删除别人的锁；
  - 交接锁的环境变量指向其他路径时拒绝运行；
  - 脚本文件在 `main` 调用之前没有任何会产生副作用的顶层命令（可以用静态检查：除函数定义、`set`、`umask` 外，最后一行才调用 `main`）。
- 人工（Mac，由人类执行）：在试用实例上连续运行两次更新（第二次无新提交）都成功；`preview` 推送一个修改了更新脚本的提交后，
  运行一次即用新脚本完成部署；人为让 Hub 启动失败时，`bin/lumio.previous` 保持上一次成功的程序。
