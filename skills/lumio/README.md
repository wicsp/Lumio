# 安装 lumio skill

一份 skill，Claude Code、Codex、pi 共用（ADR 0014 第 2 节）。用符号链接安装，仓库更新后自动生效。

## 1. 让 `lumio` 命令可用
```sh
cd ~/Projects/lumio
bun build apps/cli/src/main.ts --compile --outfile ~/.local/bin/lumio
bun build apps/hub/src/main.ts --compile --outfile ~/.local/bin/lumio-hub
```
确认 `~/.local/bin` 在 `PATH` 里。代码更新后重新运行这两条。

## 2. 安装 skill
```sh
mkdir -p ~/.claude/skills ~/.agents/skills
ln -s ~/Projects/lumio/skills/lumio ~/.claude/skills/lumio   # Claude Code
ln -s ~/Projects/lumio/skills/lumio ~/.agents/skills/lumio   # Codex、pi 都读这里
```

## 3. 给每个 agent 一个自己的身份和令牌
每个 agent 用 **agent 角色**的令牌，不要把你自己的 human 令牌给 AI。
```sh
lumio-hub actor create claude-code@mac --role agent
lumio-hub token create claude-code-mac --actor claude-code@mac   # 只显示一次
```
Codex（`codex@mac`）、pi（`pi@mac`）同理。

然后让各 agent 运行命令时带上这两个环境变量（`LUMIO_HUB_URL=http://127.0.0.1:7420`，`LUMIO_TOKEN=<该 agent 的令牌>`）：
- **Claude Code**：`~/.claude/settings.json` 的 `"env"` 里加这两项。
- **Codex**：`~/.codex/config.toml` 的 `[shell_environment_policy]` 下 `set = { LUMIO_HUB_URL = "…", LUMIO_TOKEN = "…" }`。
- **pi**：在启动 pi 的 shell 里 `export` 这两个变量（例如写一个只给 pi 用的启动脚本）。

**不要**在你自己的 `~/.zshrc` 里全局导出 human 令牌：从这个 shell 启动的 agent 会继承它，拿到你的全部权限。

令牌是明文写在这些配置文件里的，它们只在你本机；不要提交到任何仓库。泄露时用 `lumio-hub token revoke <标签>` 吊销。

## 4. 自动验收（P1-6）
用合成 vault 检查某个 agent 是否按 skill 行事，不碰真实 vault：
```sh
skills/lumio/eval/run.sh claude   # 也可以是 codex、pi
```
会打印 agent 的回复，再逐项检查：给出了 `[[文件名]]`、推荐了相关笔记、没推荐无关论文、vault 无改动、私密笔记没泄露、
Hub 没收到写链接或提议请求。全部通过时退出码为 0。
