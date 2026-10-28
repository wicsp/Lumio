# 作者自己的部署（不属于软件设计）

这里记作者（Wenbin）自己的用法，供参考。软件本身不依赖其中任何一项（ADR 0022）。

- **单机模式**，Hub 在 MacBook 上，launchd 管理。
- **vault 在 iCloud 里**：`~/Library/Mobile Documents/iCloud~md~obsidian/Documents/Lumio`，安装时用 `lumio-hub setup --vault <这个路径>`。
  vault 的 git 目录在 iCloud 之外（`~/Projects/lumio-vault.git`）。
  - macOS 不允许后台程序随意读 iCloud 目录：要在"系统设置 → 隐私与安全性 → 完全磁盘访问权限"里加入 `~/.local/bin/lumio-hub`。
- **编辑器**：Obsidian（Mac、iPad、手机），它的配置经 iCloud 自己同步；vault 的 `.gitignore` 排除插件设置文件（可能含明文密钥）。
  建议打开 Obsidian 的"自动更新内部链接"，改名时链接跟着改。
- **实验室服务器作为执行器**：Mac 在 NAT 后面，用 Tailscale 给 Hub 一个服务器能访问的地址（`lumio-hub setup` 里选 Tailscale），
  再 `lumio runtime add server`。学校服务器没有 root，不装提权助手。
- **以后**：两台服务器都会装 Nix；私人服务器有 root，可以装提权助手。

安装时先用软件的 `install.sh` 下载三个程序，再运行：

```sh
lumio-hub setup --vault "$HOME/Library/Mobile Documents/iCloud~md~obsidian/Documents/Lumio"
```

这是作者指定已有 vault 的配置，不是默认路径。首次发布前可从源码编译并签名，再运行同一条 setup。
服务读取目录被系统拒绝时，按 setup 的提示为程序开启完全磁盘访问权限，再重跑 setup。
CLI 配置写在 `~/.config/lumio/config.json`，以后终端不需要手动 export 令牌。
