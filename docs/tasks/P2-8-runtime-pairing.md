# P2-8 加一台执行器、另一台机器上的 CLI：一次性配对码

- 负责：后端（Codex）　Review：Claude
- 相关 ADR：**0021**（第 3 节）、**0022**（部署模式、网络由部署者负责），先读；0019（执行器）、0020（提权助手）
- 涉及：`apps/hub`、`apps/runtime`、`apps/cli`、`packages/api-client`、`install.sh`、`infra/`
- 契约：`packages/schema/src/setup.ts` 的 `RuntimeInviteRequest`、`RuntimeInvite`、`RuntimeJoinRequest`、`RuntimeJoin`、
  `ClientInviteRequest`、`ClientInvite`、`ClientJoinRequest`、`ClientJoin`、`HubSigningKey`、`signingKeyFingerprint`（已合并，**不得修改**）
- 依赖：P2-7

## 目标
- 在任何已配置好的 CLI 上 `lumio runtime add server` 打印一行命令；把它粘到那台机器（Linux 或 macOS）上运行，执行器就装好、配好、
  启动并连上 Hub。人不碰令牌。
- 服务器模式下，在 Mac 上用 `lumio login <Hub 地址> --code <配对码>` 配好 CLI（配对码在 Hub 上用 `lumio login-code` 生成）。
- 有 root 的服务器再运行 `sudo ~/.local/bin/lumio-runtime install-sudo-helper`，提权助手就装好（ADR 0020 的手动步骤全部自动化）。

## 范围

### apps/hub
1. **配对码**（新表）：`POST /v1/runtime-invites`（只有 human）：
   - 名称对应的 runtime 身份不存在就建；生成 128 位随机配对码（小写 base32），存 SHA-256 哈希、过期时间（10 分钟）、是否已用；
     同一名称已有未用的配对码时作废旧的。
   - 没配置 `LUMIO_PUBLIC_URL` → 400，提示"Hub 还没有对外地址：服务器模式用 `lumio-hub setup --server` 设置；
     单机模式想让别的机器连进来，也需要先设置一个它们能访问的地址（如 Tailscale 地址）"。
   - 返回 `RuntimeInvite`，其中 `command` 为
     `curl -fsSL https://raw.githubusercontent.com/wicsp/Lumio/main/install.sh | sh -s -- runtime --hub <LUMIO_PUBLIC_URL> --code <配对码>`。
   - 审计记录名称与身份，不记配对码。
2. `POST /v1/runtime/join`（**不需要令牌**，授权表里明确给 `role: null` 这一条）：
   - 配对码有效 → 标为已用、**吊销该身份所有旧令牌**、新建令牌（标签 `runtime-<名称>-<日期>`），返回 `RuntimeJoin`。
   - 无效、过期、已用 → 都返回同一个 401，不区分原因。失败次数限制：全局每分钟 10 次，超过后 1 分钟内一律拒绝（防暴力尝试）。
   - 日志与审计里不出现配对码和令牌。
3. **CLI 配对**：`POST /v1/client-invites`（只有 human）→ `ClientInvite`（`command` 为 `lumio login <LUMIO_PUBLIC_URL> --code <配对码>`）；
   `POST /v1/client/join`（不需要令牌）→ 为**发起邀请的那个 human 身份**新建标签为 `name` 的令牌，返回 `ClientJoin`。
   配对码的规则（有效期、一次有效、哈希存储、相同的 401、尝试次数限制、不进日志）与执行器配对共用同一套实现。
4. `GET /v1/runtime/signing-key`（只有 runtime）→ `HubSigningKey`（公钥与指纹）。
   `lumio-hub signing-key` 的输出也加上同一个指纹（用 `signingKeyFingerprint`）。

### apps/cli、packages/api-client
5. `lumio runtime add <名称> [--json]`：调用 invite，打印"在那台机器上运行（10 分钟内有效，只能用一次）："和那一行命令。
6. `lumio login-code [--name cli@<主机名>]`：调用 client invite，打印那一行 `lumio login …` 命令。
   `lumio login <Hub 地址> --code <配对码> [--vault <本机 vault 路径>]`：调用 client join，写 `~/.config/lumio/config.json`（0600）；
   已有配置时询问是否覆盖。`lumio logout`：删除配置文件里的令牌。
7. `lumio runtime remove <名称>`：吊销该身份的全部令牌（执行器之后会失联）；不删除历史 Job。需要一个 Hub 接口，按"不改契约"的原则
   复用现有的管理逻辑：只允许 human；返回 204。

### apps/runtime
8. 复用 P2-7 实现的 `lumio-runtime install-service`（Linux：systemd 用户服务；macOS：`io.lumio.runtime.plist`）。
9. `lumio-runtime join --hub <地址> --code <配对码>`：
   - 调用 join 换取令牌；写 `~/.config/lumio-runtime/runtime.env`（0600，目录 0700）：`LUMIO_HUB_URL`、`LUMIO_TOKEN`、`LUMIO_RUNTIME_NAME`、
     `LUMIO_RUNTIME_STATE_DIR`（绝对路径）、`PATH`（**当前 shell 的 PATH**，保证 systemd 里也找得到 agent）。已有文件时保留其中其他设置
     （如 `LUMIO_RUNTIME_ALLOWED_COMMANDS`、`LUMIO_RUNTIME_SUDO_COMMAND`、`LUMIO_RUNTIME_TAGS`），只替换上面几项。
   - 调用 install-service。Linux 上写 `~/.config/systemd/user/lumio-runtime.service`（`ExecStart` 为 `lumio-runtime` 的绝对路径，
     `EnvironmentFile` 为上面的文件，`Restart=always`），`systemctl --user daemon-reload`、`enable --now`（已在运行则 `restart`）。
   - 检查 `loginctl show-user $USER -p Linger`：没有开启时提示"退出登录后执行器会停止；请管理员运行 `loginctl enable-linger <用户名>`"。
   - 没有 systemd 用户服务（`systemctl --user` 不可用）：不报错退出，打印用 `nohup` 或 crontab `@reboot` 运行的方法。
   - 判断是否连上：执行器每次登记成功时在状态目录写一个小文件（时间与检测到的 agent）。join 启动服务后最多等 30 秒读这个文件
     （runtime 令牌不能调用 `GET /v1/runtimes`）；成功后打印"已连上 Hub；检测到：codex 0.163.0、pi 1.4.0"；
     超时则打印日志位置（Linux：`journalctl --user -u lumio-runtime -n 30`；macOS：状态目录里的日志文件）。
   - Hub 地址是 `http://` 且不是本机地址时，提示令牌会以明文传输，照常继续。
   - 令牌不打印到终端。
10. `sudo lumio-runtime install-sudo-helper`（仅 Linux；必须以 root 运行，从 `SUDO_USER` 得到执行器账号；没有 `SUDO_USER` 就报错）：
   - 读该账号的 `runtime.env` 得到 Hub 地址与令牌，调用 `GET /v1/runtime/signing-key` 与 `RuntimeInfo`（登记时返回的身份）。
   - **打印公钥指纹，要求人输入 `yes` 确认它与 Hub 所在机器上 `lumio-hub signing-key` 显示的一致**；不一致或非交互终端 → 不安装。
   - 安装：复制自身到 `/usr/local/libexec/lumio-sudo-helper`（root:root 0755）、写 `/etc/lumio/sudo.json`（0644）、
     建 `/var/lib/lumio-sudo`（0700）、写 `/etc/sudoers.d/lumio` 到临时文件，`visudo -cf` 校验通过后再改名就位（0440）；
     在 `runtime.env` 里设置 `LUMIO_RUNTIME_SUDO_COMMAND`；以该账号身份重启执行器服务（`runuser -u <账号> -- systemctl --user restart …`，
     需要设置 `XDG_RUNTIME_DIR=/run/user/<uid>`），失败时提示人自己重启。
   - 可重复运行（升级助手程序时再运行一次）。`--uninstall` 撤销以上全部（保留 `/var/lib/lumio-sudo/used`）。
11. `install.sh runtime …`：装好程序后运行 `lumio-runtime join --hub … --code …`。

### 文档
12. `infra/systemd/README.md`、`infra/sudo-helper.md`：正常情况用上面两条命令；手动步骤移到"手动安装"一节。

## 不做
- 一个配对码配多台机器；Hub 主动连接执行器；macOS 上的提权助手；Nix。

## 验收标准
1. `bun run check` 通过。
2. Hub 测试：只有 human 能生成配对码；配对码 10 分钟过期、只能用一次、新码作废旧码；join 成功后旧令牌失效、新令牌能登记；
   无效 / 过期 / 已用都返回相同的 401；超过尝试次数后被限制；配对码与令牌不出现在日志、审计、错误里；没配置对外地址时 400；
   CLI 配对得到的令牌属于发起邀请的 human 身份，执行器配对码不能用于 client join，反之亦然。
3. 执行器测试（注入运行命令的函数与临时 HOME）：`runtime.env` 的内容与权限、保留已有设置、PATH 取自当前环境；
   systemd 单元与 launchd plist 的内容；有 / 没有 systemd 用户服务、没有 linger 三种提示；`lumio login` 写出的配置与权限；`install-sudo-helper` 在非 root、无 `SUDO_USER`、
   指纹未确认、`visudo` 校验失败时都不安装，全部通过时写出的文件内容与权限正确（文件路径可注入，测试不碰真实 `/etc`）。
4. 端到端：真实 Hub + `lumio runtime add` + `lumio-runtime join`（用临时 HOME、跳过 systemd，直接在进程里启动执行器）→ 执行器在线。
5. 人类验收：Mac 上 `lumio runtime add server`（Hub 对外地址用 Tailscale 提供），实验室服务器上粘贴运行，`lumio runtime list` 显示在线。
