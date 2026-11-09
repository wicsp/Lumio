# 本机日常部署与正式发布

## PR 开出后部署到日常实例

从最新的 `origin/main` 建立功能分支。本机开发的功能开出 PR 后，直接把该 PR 的提交部署到日常使用的 [7420](http://127.0.0.1:7420)。浏览器继续使用原来的地址，命令行继续使用 `lumio`，沿用现有数据和登录身份。人工试用、交叉 review 和 CI 并行。需要修订时，把修订推送到同一个 PR 并更新日常实例。合入前处理试用反馈，并通过交叉 review 和完整 CI。

从已推送的准确提交构建程序。部署前协调部署和服务重启，等正在执行的助手轮次结束，再备份原程序和服务配置。用 `lumio hub backup business <新目录>` 创建业务快照，再用 `lumio hub backup verify <目录>` 校验。涉及迁移时，先用隔离数据验证迁移和恢复流程。业务备份、vault 和安装配置的边界见 [Hub 部署与备份](design/hub.md#存放)。

将新程序原子替换到现有的 `lumio` 路径。纯前端或与当前 Runtime 协议兼容的 Hub 更新只重启 Hub，保留运行中的 Runtime 进程。Web 资源随 Hub 打包，Hub 重启时页面和 API 会短暂离线。Runtime 已确认的本地 Job 可以继续排队和执行，结果写入持久化 outbox，重连后补交。尚未领取的 Job 留在 Hub，恢复后再领取。

需要更新 Runtime 时，等待正在执行的 Job 结束并确认结果已交回，再重启 Runtime。运行中的 Job 遇到 Runtime 重启会进入 `unknown`，由人工核查。涉及协议变更时，先验证 Hub 与 Runtime 的版本兼容性，再决定切换顺序。参见 [Execution](design/execution.md)。

部署后确认 7420 的健康检查和 `lumio --version` 对应本次提交，并确认 Runtime 已恢复同步。保留可恢复的旧版本和备份。合入后发现的问题在主线上修复或 revert。

## 正式发布

所有功能 PR 合入 `main` 后，从主线上已验收的提交打正式 `v*` 标签。Release workflow 校验提交属于主线，重跑全量检查并创建 GitHub Release。
