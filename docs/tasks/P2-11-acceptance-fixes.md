# P2-11 第一次验收发现的问题

- 负责：后端（Codex）　Review：Claude
- 相关 ADR：0021、0022、**0023**（先读）
- 涉及：`apps/hub`、`apps/runtime`、`apps/cli`、`packages/core`、`install.sh`
- 契约：不改
- 依赖：P2-8

人类在 Mac 上第一次用 `install.sh` 安装并验收（2026-10-28）时发现以下问题。

## 1. 交互输入在真实终端里打不进字（必须修）
- 现象：`curl -fsSL …/install.sh | sh -s -- --vault …` 时，`lumio-hub setup` 显示了问题，但在 macOS 终端里**完全无法输入**，只能 Ctrl-C。
  install.sh 用 `< /dev/tty` 运行 setup，setup 用 `node:readline/promises` 读。自动测试用的是注入的 `ask`，从没在真实终端里跑过。
- 同样的写法还出现在 `lumio login`（覆盖确认）与 `lumio-runtime install-sudo-helper`（指纹确认），很可能有同样的问题。
- 修法：写一个共用的"在终端里问一句"的函数（每个 app 各放一份，不跨 app import；或放进 `packages/core`，它不做网络请求，可以放）：
  直接打开 `/dev/tty` 读写——向它写提示，按行读取回答；打不开 `/dev/tty` 时视为非交互，按各命令已有的非交互规则处理。三处都改用它。
- 验证：必须在**真实伪终端**里跑一遍，并写成测试（例如用 `script -q /dev/null …`（macOS）/ `script -qc …`（Linux）包一层，
  向它写入回答），覆盖：管道运行 install.sh 后回答 setup 的问题；`lumio login` 覆盖确认；指纹确认。PR 里写明在真实终端里手动试过。

## 2. 单机模式不要问 Tailscale
- 现象：单机模式下 setup 的第一个问题是"用 Tailscale 提供对外地址？"，让人摸不着头脑（ADR 0022：Tailscale 是补充）。
- 修法：只在 `--server` 时询问。单机模式下需要让别的机器连进来（如作者用 Tailscale 让实验室服务器连回 Mac），用 `lumio-hub setup --server`
  或新增的 `--public-url <地址>`（直接设置对外地址，不改监听地址；地址是 Tailscale serve 的 https 地址时 Hub 仍只听本机）。
  `lumio runtime add` 在没有对外地址时的提示里写上这两种做法。

## 3. CLI 重新登录时不要保留旧令牌
- 现象：`client.join` 遇到同名令牌时把旧令牌改名为 `<名称>#<随机>` 后保留，同一台机器反复 `lumio login` 会累积仍然有效的令牌。
- 修法：同一个 human 身份、同名的旧令牌 → 吊销后新建；同名但属于其他身份 → 拒绝邀请（409，提示换一个名称）。

## 4. 补全时写出开关字段（ADR 0023）
- `packages/core` 的补全：任务缺 `status` 写 `todo`；例行任务缺 `status` 写 `active`；任务缺 `assignee` 写 `human`（P2-13 / ADR 0024 取代旧开关）。
  空值视为缺失。其他字段规则不变。
- 测试：三种情况各自写入；已有值不动；不新增旧的轮次开关字段；Hub 的监听补全后照常提交。

## 5. 文档
- ADR 0021 第 3 节标为已实现（P2-8），写修订记录；`docs/tasks/README.md` 中 P2-8、P2-11 标 ✅。
- `docs/personal-setup.md`：作者的单机模式 + Tailscale 用 `--public-url`（或 `--server`）设置。

## 验收标准
1. `bun run check` 通过。
2. 上面每一项都有测试；第 1 项有真实伪终端测试。
3. 人类验收：重新运行 `curl … | sh -s -- --vault …` 能正常回答问题；`lumio runtime add server` 生成的命令在实验室服务器上运行后执行器在线。
