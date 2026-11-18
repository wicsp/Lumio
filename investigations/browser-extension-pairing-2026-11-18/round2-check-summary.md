第二轮配对复现通过，但全仓检查未通过；按仓库提交前检查规则暂未提交。

## 检查环境

- 日期：2026-11-18。
- 基线：刷新后的 `origin/main`，`0d98d3ac92c627432d7db4cd51f366fafce0fff6`。
- 分支：`codex/browser-extension-pairing-investigation`，独立 worktree。
- Bun：1.4.4；使用现有 lockfile，`bun install --frozen-lockfile --ignore-scripts`，未修改依赖或 lockfile。
- 缓存、测试临时目录位于本 worktree 的 node_modules 下，没有访问生产 Hub 或真实 vault。
- 清除本轮注入的 LUMIO_TOKEN、LUMIO_HUB_URL、LUMIO_VAULT 后运行检查，避免测试子进程继承真实连接。

```sh
env -u LUMIO_TOKEN -u LUMIO_HUB_URL -u LUMIO_VAULT \
  TMPDIR="$PWD/node_modules/.investigation-test-state/tmp" bun run check
```

## 结果

类型检查通过。依赖检查通过：673 modules、3362 dependencies，无违规。

```text
1713 pass
4 skip
6 fail
2 snapshots, 19210 expect() calls
Ran 1723 tests across 238 files. [287.39s]
error: script "check" exited with code 1
```

失败项均位于未修改的产品测试文件中：

| 测试文件 / 用例 | 实际失败证据 |
|---|---|
| `apps/runtime/test/job-codex-sandbox.test.ts` / Codex Job Seatbelt supports Git according to the stage grant | `sandbox-exec: sandbox_apply: Operation not permitted`，在启动内层沙箱时失败 |
| `apps/runtime/test/native-isolation.test.ts` / native outer boundary denies synthetic vault, credentials, sibling sessions and symlink reads | 预期读取允许的合成文件成功，实际内层进程退出 71、输出为空；该测试调用 `/usr/bin/sandbox-exec` |
| `apps/runtime/test/pi-job.test.ts` / Pi uses the existing job controls for tool events, questions, approval, decline and continuation | 首轮 fixture 预期 exit_code=0，实际为 1；执行链 `job-interactive.ts → pi-job.ts:122` 通过 `/usr/bin/sandbox-exec` 启动，测试未输出子进程 stderr，不能仅凭退出码独立证明失败原因 |
| `apps/hub/test/jobs.test.ts` / Codex App Server and the Claude Agent SDK apply same-round answers and approvals | `The Codex Job could not start a command inside the Runtime sandbox` |
| `apps/hub/test/jobs.test.ts` / an existing Codex login drives a Work Job through refresh, questions and approval and is revoked on logout | `Fixture sign-in failed: error (native.version_unsupported)`，尚未进一步定位 |
| `apps/hub/test/watch.test.ts` / real recursive fs.watch completes a new note in seconds and its own write settles | 合成笔记未在十秒内补全；Idea 契约校验报缺少 id/created/updated/type，尚未进一步定位 |

完整检查输出保留在本 worktree 的 `node_modules/.investigation-test-state/check.log`（被 Git 忽略，不列为调查交付文件）。未跳过、修改或弱化失败测试。

## 与本次配对调查的关系

同一最新基线上，`repro.ts` 全部断言通过；日志见 `round2-evidence.log`。再次确认旧 bundle 请求 `/v1/client/join` 得到 401，码未消费；新构建请求 `/v2/setup/client/join` 用同一码成功，剪藏接口返回 202。

第一轮的相关 26 项测试也在本次全仓运行中通过（包括最新 pairing.test.ts 的其他用例），六项失败中没有扩展、配对、API client 或 setup 契约测试。尚未实测生产浏览器、生产系统时间与证书。

## 提交阻塞

AGENTS.md 第 8 条要求“提交前必须通过 `bun run check`”。Git 权限已生效，fetch 与建立独立分支成功；当前阻塞是外层沙箱限制系统沙箱测试，以及上述尚未核验的其他基线失败。需要 full 权限重跑系统级隔离测试并核验剩余失败；不使用 root，不修改生产配置，不部署。检查通过前不提交或推送。
