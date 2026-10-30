# P2-9 自检与升级：`lumio doctor`、`lumio selftest`、`upgrade`

- 负责：后端（Codex）　Review：Claude
- 相关 ADR：**0021**（第 4 节，先读）
- 涉及：`apps/cli`、`apps/runtime`、`apps/hub`（只在需要时补充状态信息）、`docs/tasks/README.md`
- 契约：不改。需要新的响应格式时先说明，由 Claude 起草
- 依赖：P2-8

## 目标
人不再按清单手动验收：`lumio doctor` 说明哪里不对、怎么修；`lumio selftest` 用真实 agent 把关键路径跑一遍并给出通过 / 失败；
`lumio upgrade`、`lumio-runtime upgrade` 一条命令升级。

## 范围

### `lumio doctor [--json]`
1. 逐项检查，每项输出 `✓` 或 `✗ <问题>  → <怎么修>`，最后一行汇总；有 `✗` 时退出码 1。`--json` 输出每项的 `{ name, ok, problem?, fix? }`。
   - 配置：配置文件存在、权限 0600、能解析。
   - Hub：`/health` 可达；版本与 CLI 一致（不一致 → "运行 `lumio upgrade`"）；令牌有效（`/v1/actors`）。
   - 后台服务（Hub 在本机时）：macOS 上 `io.lumio.hub` 已加载（`launchctl print gui/<uid>/io.lumio.hub`），Linux 上 `lumio-hub.service` 在运行；本机执行器同理。
   - vault：`/v1/status` 正常；Hub 的问题列表非空时逐条列出。
   - 对外地址（设置了时）：从本机请求 `<LUMIO_PUBLIC_URL>/health` 可达；是 `http://` 且不是本机地址时给出警告（不算失败）。
   - 执行器：每个已登记的执行器在线与否（离线 → 最近一次时间与"在服务器上运行 `lumio-runtime doctor`"）、检测到的 agent 与版本、
     不在适配器验证范围内的版本。
   - 例行任务：`GET /v1/routines` 里有 `problem` 的逐条列出。
   - 待批准的提议数量（有则提示 `lumio proposals`）。
2. 检查逻辑写成可注入的函数，便于测试。

### `lumio-runtime doctor`（执行器所在机器）
3. 同样的输出格式：`runtime.env` 存在且 0600、能连 Hub 并通过认证、systemd 服务在运行、linger、每个 agent 在 `runtime.env` 的 PATH 里能找到且版本受支持、
   后台服务在运行（systemd 或 launchd）、状态目录权限、待交回的结果数、提权助手（配置了 `LUMIO_RUNTIME_SUDO_COMMAND` 时：助手文件存在且 root 所有、`sudo -n -l` 显示有这一条）。

### `lumio selftest [--runtime <名称>] [--agents codex,claude-code,pi] [--notes]`
4. 默认对指定执行器（只登记了一个时自动选它）上检测到的每个 agent，经 Hub 提交 `job submit`（`workdir: "~"`），**提示词要求 agent 不修改任何文件**：
   - **执行与汇报**：第 1 轮"记住暗号 <随机词>，只回复 OK"→ 状态 `done`，取到汇报。
   - **接着会话**：第 2 轮用第 1 轮的会话（claude 用 CLI 生成的 UUID，pi 用随机名称，codex 用返回的 `session_id`）问"暗号是什么"→ 汇报里含暗号。
   - **提问**：第 3 轮要求它用 `<lumio-question>` 问一个问题 → 状态 `waiting_for_human`、`question` 非空。
   - **取消**：第 4 轮让它"等待 120 秒再回复"，提交后取消 → 状态 `cancelled`，且在 30 秒内收到。
   每一轮有总超时（默认 5 分钟），超时记为失败并给出 `lumio job show <job>`。
5. `--notes`：在 vault 的 `plan/tasks/` 新建一篇 `Lumio 自检 <日期时间>.md`（CLI 本地写入，与 `lumio new` 相同的方式），负责人为第一个可用 agent，
   `assignee: pi@server`（实际写所选 agent 与执行器，`workdir` 可不写）；等待 Hub 派出并写回第 1 轮（最多 5 分钟）→ 检查区块标题、`assignee` 变回 `human`；最后把这篇笔记的 `status` 改为 `done`（不删除）。
6. 输出：每项 `✓/✗`、耗时、失败时的 job 编号与一句原因；`--json` 输出结构化结果。全部通过退出码 0。
7. 自检不需要 `LUMIO_RUNTIME_ALLOWED_COMMANDS`、不提权、不修改工作目录以外的内容。

### 升级
8. `lumio upgrade [--version vX.Y.Z]`：从 GitHub Release 下载并校验（与 install.sh 相同的逻辑）→ 替换 `~/.local/bin` 里的三个程序 →
   重启本机的 Hub 与执行器服务（launchd：`kickstart -k`；systemd：`restart`）→ 等待 `/health` 显示新版本。已是最新则直接说明。
9. `lumio-runtime upgrade [--version …]`（只有执行器的机器）：同上，替换后重启执行器服务；装了提权助手时提示
   "还需运行 `sudo lumio-runtime install-sudo-helper` 更新助手程序"。

### 文档
10. `docs/tasks/README.md` 的"等人类回来处理"改写为：安装（Hub 一行、每台执行器一行）→ `lumio doctor` → `lumio selftest --notes` →
    只有自检覆盖不到的项目（iPad 上看一眼笔记、合上 Mac 后例行任务补写、提权的真实安装）才需要人手动做。

## 不做
- 自动更新、定时自检、把自检结果发到飞书（P3）。

## 验收标准
1. `bun run check` 通过。
2. 测试：doctor 每一项的正常与异常（注入 HTTP、命令执行与文件系统）；selftest 用真实 Hub + 执行器 + 假 agent 跑完全部项目且通过，
   再分别让假 agent 不记得暗号、不提问、不响应取消，确认对应项目判为失败、其他项目不受影响；`--notes` 用合成 vault；
   upgrade 用本地起的 HTTP 服务模拟 Release，覆盖校验失败不替换、已是最新。
3. 人类验收：`lumio doctor` 全部 `✓`，`lumio selftest --notes` 全部通过。
