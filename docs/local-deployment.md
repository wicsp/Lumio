# 主线开发与本机部署

从最新的 `origin/main` 建立功能分支。每个 PR 通过交叉 review 和完整 CI 后合入 `main`。本机只维护一个日常实例，监听 `127.0.0.1:7420`，默认从 `main` 的已提交版本构建。隔离测试使用临时目录、临时端口和合成数据。

更新日常实例前，确认 Hub 和 Runtime 的活跃工作已经结束。用 `lumio hub backup business <新目录>` 创建业务快照，并用 `lumio hub backup verify <目录>` 校验。备份当前程序、服务定义和 Runtime 状态供回退。涉及迁移时先用合成数据验证，并确认备份可恢复。业务备份、vault 与安装配置的边界见 [Hub 部署与备份](design/hub.md#存放)。

从指定提交的独立源码目录用仓库固定的 Bun 构建。安装新程序后重启 Hub。仅 Web 更新可保留 Runtime 进程；Runtime 有改动时，等在途工作结束后再重启。核对 `/health` 的版本、页面资源和 Runtime 在线状态。

对外发布时，从 `main` 上已验收的提交推送正式 `v*` 标签。Release workflow 校验提交属于主线，重跑全量检查并创建 GitHub Release。
