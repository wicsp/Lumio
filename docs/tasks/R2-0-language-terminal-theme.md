# R2-0 v0.2.1：英文界面与中文切换、终端输出样式、Web 主题、升级不重复下载

- 依据：[ADR 0028](../adr/0028-language-terminal-theme.md)（Accepted，2026-11-03），以及 ADR 0021、0027
- 契约：不改 `packages/schema`
- 来源：v0.2.0 在作者 Mac 上真实升级与切换时（2026-11-03）发现的问题，加上作者为开源提出的语言与主题要求

## 切片

每个切片一个 PR。R2-1 → R2-2 有先后（R2-2 要翻译 R2-1 新写的输出）；R2-3 与它们无关，可并行。

| 编号 | 内容 | 负责 | 涉及 | 依赖 |
|---|---|---|---|---|
| R2-1 | 终端输出样式；`upgrade` 已是最新时不下载；`switch` 显示 doctor 结果 | 后端（Codex） | `packages/platform`、`apps/cli`、`apps/hub` | — |
| R2-2 | 命令行与 Hub 错误说明的中英文 | 后端（Codex） | `apps/cli`、`apps/hub`、`apps/runtime`、`packages/platform`、`packages/api-client`（只加请求头选项）、各包错误 | R2-1 |
| R2-3 | Web 主题切换与中英文界面 | Claude | `apps/web` | — |
| R2-4 | 发布 v0.2.1，作者机器上验收 | 人类 + Claude | 文档 | R2-1 至 R2-3 |

## R2-1 终端输出与升级（Codex）

照 ADR 0028 第 2、4 节实现，此时文字仍用现有中文（R2-2 再翻译）。

- **公共终端工具**（放在 `packages/platform`）：
  - 判断是否终端、是否允许颜色（`NO_COLOR`、`FORCE_COLOR`、`TERM=dumb`、非 TTY）；
  - 绿/红/黄三种着色；
  - 大小格式化（B、KB、MB、GB，1024 进制，一位小数）与速度；
  - 原地刷新的进度行：终端宽度自适应，结束时换行；非终端时只在开始和结束各输出一行。
- **下载**（`download.ts` 与 `install.sh`）：用上面的进度行显示「版本、平台、进度条、百分比、已下载/总大小、速度」，不再输出字节数。
  `install.sh` 保持 `curl --progress-bar`，但下载前那一行显示可读的大小（大小未知时省略）。
- **`upgrade` 先确定目标版本再下载**：
  - 未指定 `--version` 时，请求 `releases/latest`，不跟随重定向，从 `Location` 里的 `/tag/vX.Y.Z` 读出版本。
  - 目标版本等于本机版本，且兼容链接与服务文件都已是当前写法时，输出「已是最新版本 X.Y.Z」，不下载。
  - 读不到版本（网络异常、自建镜像不重定向）时退回现有流程：下载、校验之后再比较。
  - 进度行里显示目标版本号。
- **`doctor`**：结果分通过 / 提醒 / 失败三种，颜色与符号按 ADR 0028。
  - 「助手模型未配置」等可选项改为提醒。
  - 汇总写成「25 项通过，1 项提醒，0 项失败」，只有存在失败时退出码才非零。
  - 发现 `lumio-hub` / `lumio-runtime` 仍是转发垫片时，失败项的修复提示写明「再运行一次 lumio upgrade」。
- **`switch --retire-legacy`**：最后一步运行 doctor 时，把 doctor 的输出原样显示给用户。退役已完成、只是 doctor 有失败项时，
  输出「切换已完成；以下检查未通过：…」并以非零退出，**不要**再说「切换已停止」和恢复步骤（那只适用于退役之前的步骤失败）。
- **验收**：
  - 格式化与颜色判断的单元测试；
  - 进度行在终端与非终端两种模式下的输出快照；
  - `upgrade` 已是最新时不发起下载请求（合成 release 服务记录请求）；读不到版本时退回下载；
  - `doctor` 三种状态与退出码；
  - `switch` 中 doctor 失败时的输出与退出码。

## R2-2 命令行与 Hub 的中英文（Codex）

照 ADR 0028 第 1 节实现。

- **语言判断**：共用一个函数，规则见 ADR 0028 第 1 节，`LUMIO_LANG` 优先。后台服务（`hub serve`、`runtime serve`）的日志固定英文。
- **文案表**：每个 app 一份 `messages.ts`，导出 `en` 与 `zh` 两张同键的表，带参数的条目用函数。
  - 测试检查：两张表键集合相同；同一条目的参数个数相同；源代码里除文案表外不再出现中文（允许注释，可用简单的扫描测试实现）。
- **库错误**：各包错误类已带 `code`。需要给人看的错误补上参数字段，由 app 层查表生成文字；库里不再拼接中文说明。
- **Hub**：API 错误的 `message` 按请求 `Accept-Language` 选择语言。`packages/api-client` 的 `createClient` 增加可选的 `language` 选项，
  用于发送该请求头（这是 api-client 唯一的改动；Web 一侧由 R2-3 接上）。CLI 按自己的语言传入。
- **其他文字**：`install.sh` 的提示同样按 `LANG`/`LC_ALL` 选择中英文。setup 的交互问题、doctor 的检查名与修复提示、升级与切换的进度都要翻译。
- **验收**：
  - 同一命令在 `LANG=en_US.UTF-8` 与 `LANG=zh_CN.UTF-8` 下输出对应语言；`LUMIO_LANG` 覆盖系统语言；
  - Hub 对 `Accept-Language: zh-CN` 与 `en` 返回对应语言的错误说明，`code` 不变；
  - 现有测试中断言中文文字的地方，改为在指定 `zh` 时断言，或改为断言 `code`。

## R2-3 Web 主题与语言（Claude）

- **主题**：侧栏底部（窄屏放在设置菜单）切换「跟随系统 / 浅色 / 深色」，保存在 `localStorage`，即时生效，`theme-color` 跟着变。
  CSS 由 `prefers-color-scheme` 媒体查询改为 `:root[data-theme]` 加媒体查询兜底。
- **语言**：同一位置切换「English / 中文」，默认按 `navigator.language`。所有界面文字移入 `client/i18n.ts` 的 `en` / `zh` 文案表，
  日期与相对时间按语言格式化。请求带 `Accept-Language`（R2-2 合并后 Hub 的错误说明随之变化；之前仍显示 Hub 返回的原文）。
  切换后重新渲染当前模块，保留未保存的草稿。
- **验收**：两张表键一致的测试；中英文、浅色/深色共四种组合在桌面和 390px 宽度下逐页截图检查；切换不丢正在编辑的任务说明草稿。

## R2-4 发布与验收（人类 + Claude）

1. R2-1 至 R2-3 合并后打 `v0.2.1` 标签。
2. Mac：`lumio upgrade`（只需一次），观察进度行；`lumio doctor` 看颜色与三种状态。用 `LANG=en_US.UTF-8 lumio doctor` 看英文输出。
3. 服务器：`lumio-runtime upgrade`。
4. Web：切换语言与主题，刷新后选择仍在。

## 不做

- 不翻译开发文档、ADR、任务说明，不翻译用户内容与 agent 汇报。
- 不做自动升级执行器（另行讨论）。
