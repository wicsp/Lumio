# R0-5 设备能力与执行事实的归属收尾

- 依据：ADR 0025 第 1、2、3、5 节；既有 RuntimeRegistration/RuntimeInfo/Job 契约与协议 2。
- 范围：新增 RuntimeRegistryStore 与 ExecutionStore.cancelRequested/ExecutionJobs.live 端口契约，以及 Storage、Hub 必需调用方的连带修改；公开 schema 字段、HTTP 与协议保持不变。
- 状态：已实现并验证。不引入依赖、不操作真实设备。

把身份不变更设备名、设备名不被另一身份占用、能力记录和在线时限规则移入 Execution。
Runtime SQLite 表由 Storage 实现；Hub 保留鉴权、身份与应用组装，旧 HubStore 方法只转发。
高权限审批通过 Execution 公开事实查询确认 Job 已指派、未结束且未请求取消，不直接读取执行表。
重用每个业务库的执行存储适配器，避免每次 HTTP 请求重复初始化表。

## 验证

纯端口测试不启动 Hub、Task 或 Knowledge，验证能力替换、名称归属、在线阈值与非法契约输入；
原有 Hub 登记、取消与高权限审批端到端测试继续通过。定向测试 17 pass；LUMIO_LIVE=0 bun run check：785 pass、3 skip、0 fail，类型、契约导出与依赖检查通过。
