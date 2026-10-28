# 高权限命令助手（Linux）

只在自己的、有 root 权限的服务器安装。学校服务器不配置，申请会立即返回“此执行器不支持提权”。

## 自动安装与升级

执行器配对并连上 Hub 后，在 Hub 所在机器运行 `lumio-hub signing-key` 查看公钥和指纹，
在执行器所在服务器以执行器账号运行：

```sh
sudo ~/.local/bin/lumio-runtime install-sudo-helper
```

核对两边显示的指纹一致后输入 `yes`。非交互终端、未确认指纹或 sudoers 校验失败时不会安装。
安装命令取得当前执行器身份，复制程序、保存公钥配置、校验并安装 sudoers，自动设置 runtime.env 和重启用户服务。
程序与配置由 root 所有，运行账号的配置在降回该账号后更新。重启失败会打印手动重启提示。
升级时重新运行同一条安装命令。

卸载：`sudo ~/.local/bin/lumio-runtime install-sudo-helper --uninstall`。
卸载会移除助手、配置、sudoers 和 runtime.env 中的提权命令，保留 `/var/lib/lumio-sudo/used`，避免旧批准凭据被再次使用。

## 手动安装

先在 Hub 所在机器运行 `lumio-hub signing-key`，得到 32 字节原始 Ed25519 公钥（base64url）；
用 `lumio runtime list --json` 找到服务器的 `actor`（`act_…`）。公钥不是密钥；Hub 私钥只在 hub.sqlite 中，备份权限为 0600。

在服务器构建 `bun run --cwd apps/runtime build`，然后由人用 root 完成下面的安装（替换占位值）：

```sh
install -d -o root -g root -m 0755 /usr/local/libexec
install -o root -g root -m 0755 apps/runtime/dist/lumio-runtime /usr/local/libexec/lumio-sudo-helper
install -d -o root -g root -m 0755 /etc/lumio
install -d -o root -g root -m 0700 /var/lib/lumio-sudo
```

构建输出位置见 `apps/runtime/package.json`。把 `/etc/lumio/sudo.json` 写为：

```json
{ "public_key": "<Mac 打印的公钥>", "runtime": "act_<服务器身份>" }
```

该文件和所有父目录必须由 root 所有，组与其他人不可写；文件权限设为 0644。
`/var/lib/lumio-sudo/used` 首次使用时由助手创建（0600），目录也必须 root 所有且组与其他人不可写。
助手固定读取这些路径，不接受环境变量覆盖。

用 `visudo -f /etc/sudoers.d/lumio` 添加（替换账号）：

```sudoers
<执行器账号> ALL=(root) NOPASSWD: /usr/local/libexec/lumio-sudo-helper --sudo-helper
```

执行器的 systemd EnvironmentFile 加入：

```ini
LUMIO_RUNTIME_SUDO_COMMAND=/usr/bin/sudo -n /usr/local/libexec/lumio-sudo-helper --sudo-helper
LUMIO_RUNTIME_SUDO_TIMEOUT=1800
```

第一个元素必须为绝对路径，整个前缀按空白分隔，不使用 shell 引号；安装路径不要包含空格。
重启 `systemctl --user restart lumio-runtime`。

agent 在一轮之内执行 `lumio-runtime sudo -- /usr/bin/apt-get install <软件包>`；
Mac 上用 `lumio proposals` 查看服务器、命令、来源与理由，再由人执行 `lumio proposals accept|reject <ID>`。
批准凭据 10 分钟过期、一次有效；助手在执行前 fsync 已用记录，执行失败也不会重试。助手以固定环境、工作目录 `/` 执行，30 分钟后杀掉进程组。
输出只返回调用者，Hub 只记录 argv、批准与执行状态、时间和退出码。执行器离线时执行结果保留在本地数据库，恢复后重试交回。

若助手因 `used.lock` 残留拒绝：先确认没有运行中的助手，检查审计和 used 文件，再由管理员删除该锁目录；不要删除 used 文件来重试旧凭据。
Hub 密钥丢失时，恢复备份或重新生成并更新所有服务器的公钥；旧签名随之失效。

人工验收：在临时任务中让 agent 申请安装一个软件包，在 Mac 查看并批准，确认安装成功；再拒绝一次，确认没有执行。
