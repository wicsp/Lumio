# 0062 在 Web 设置 Hub 的资料抓取代理

- 状态：Implemented（I1-3b，2026-11-11 人类批准）
- 日期：2026-11-11
- 领域：Inbox、Hub 配置、权限与安全、HTTP 契约
- 关联：[ADR 0057 第 7 节](0057-inbox-and-captured-sources.md#7-权限)、I1-3a、I1-3b

## 背景

I1-3a 支持用 Hub 服务环境中的 `HTTPS_PROXY`、`HTTP_PROXY` 和 `NO_PROXY` 控制资料抓取。用户希望打开 Lumio Web 就能配置代理，保存后可以立即重试抓取。

## 决定

- 在 Web「设置 → Hub 与执行器」添加「资料抓取代理」。人可填一个 HTTP 或 HTTPS 代理地址，供 Hub 抓取 HTTP 和 HTTPS 网址时共用，并可填写 `NO_PROXY`。选择「跟随服务环境」即可恢复部署者配置的路由。界面说明代理地址是从 Hub 所在机器访问的。
- Web 配置是 Hub 范围的私有安装配置。保存后从下一次抓取尝试生效，同一次尝试的重定向使用同一份配置。Hub 在状态目录用权限为 `0600` 的独立文件原子写入配置，安装备份一并保留。已有实例初始跟随服务环境，无需迁移。
- 在 `packages/schema` 定义 `GET /v2/inbox/proxy-settings` 的视图和 `PUT` 的严格请求，只有已配对的 human 可以调用。修改使用 `expected_revision` 防止覆盖并发写入，Hub 审计修改者和结果。接口返回 `Cache-Control: no-store`。
  - 视图包含 `revision` 和 `mode`（`environment` 或 `custom`）。自定义模式还返回去掉用户信息的 `proxy_origin` 和 `no_proxy`。
  - 更新指定模式和当前版本。首次切换到自定义模式时提供 `proxy_url`，后续省略它可保留原地址和凭据。更新时提交完整的 `no_proxy` 字符串，空字符串清除直连列表。切回环境模式时清除已保存的自定义地址和直连列表。
- 代理地址只接受 HTTP 或 HTTPS，允许可选的代理身份凭据。Hub 只在连接该代理时使用凭据，读取接口、保存回执、错误、日志和审计均省略凭据。表单中的完整地址只在当前页面内存保留到保存或离开。agent、Runtime 和内置助手没有读取或修改入口。
- 已配对的 human 可以选择 Hub 信任的抓取代理。Hub 对目标网址和每一跳重定向仍执行 ADR 0057 第 7 节的检查。命中 `NO_PROXY` 时解析域名并连接通过检查的公网 IP。该配置仅用于 Hub 的资料抓取。Hub 的其他请求、Runtime 和系统代理使用各自的配置。
- 合成测试覆盖人类权限、凭据脱敏、保存后立即生效、重启后保留、并发覆盖保护、恢复环境配置，以及经假代理抓取时的地址检查。

## 影响范围

由 `packages/schema` 定义契约，`apps/hub` 持久化配置并接入抓取，`packages/api-client` 和 `apps/web` 提供表单入口。配置说明同步更新到部署文档。依赖沿用仓库现有依赖。

## 修订记录

- 2026-11-11：人类批准 Web 代理设置及其 Hub 契约，按 I1-3b 实现。
