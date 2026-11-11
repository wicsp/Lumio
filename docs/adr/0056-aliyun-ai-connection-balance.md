# ADR 0056：AI Connection 查询阿里云账户余额

- 状态：Implemented
- 日期：2026-11-11
- 人类批准：2026-11-11
- 接续：ADR 0052、ADR 0055

## 背景

Lumio 已能在 AI Connection 的「用量与余额」中显示余额或订阅额度。百炼的 DashScope API Key 授权模型和语音调用。查询阿里云资金账户需要单独的 RAM 凭据；返回金额属于该凭据对应的阿里云账户。同一账户可为多条连接及其他云产品付费。

## 决定

- 在现有 `dashscope` 连接上增加可选的阿里云余额查询。使用官方 DashScope OpenAI 兼容地址的现有 `openai-compatible` 连接也可配置。Hub 按协议、域名、端口和路径校验官方地址。连接所有者在「用量与余额」明确绑定用于结算的账户。界面把金额标为「阿里云账户余额」，并提示同一账户的多个连接可能显示同一金额。Coding Plan、Token Plan 和按模型分配的额度是独立数据，本提案只查询账户金额。
- 为现有用量接口增加仅所有者可调用的 `PUT /v2/ai/connections/:id/usage/aliyun-billing`。请求为 `{ site, access_key_id, access_key_secret }` 或 `{ clear: true }`，`site` 枚举为 `china` 和 `international`。返回现有用量视图，其可选 `aliyun_billing_configured` 字段表示是否已配置。RAM 凭据写入 Hub 私有业务库，和模型密钥独立保存，受相同的文件与备份权限保护。配置读取、回执、日志、浏览器恢复副本、Runtime 与 agent 工具均无账务凭据。首次配置与轮换均提交完整凭据，采用仅有余额查询权限的 RAM 身份。
- Hub 用 RAM 凭据签名调用 `BssOpenApi/2017-12-14` 的 `QueryAccountBalance`。按显式选择的账务站点使用固定的 HTTPS 端点 `business.aliyuncs.com` 或 `business.ap-southeast-1.aliyuncs.com`，拒绝重定向。复用现有查询的超时、响应大小限制与标准化错误。RAM 授权以官方 API 授权表为准，验收时用最小权限验证。
- 扩展 `AIQuotaSnapshot`，增加 `source: "aliyun-billing"`，保存 `sampled_at`、`currency`、`cash_balance` 和 `available_amount`。币种按阿里云接口支持 CNY、USD、JPY，金额保留有符号的十进制字符串。沿用现有用量读取与手动刷新接口，卡片显示现金余额、可用额度和采集时间。第一版仅手动刷新。
- 临时失败保留当前绑定最近的成功快照并显示采集状态。配置清除、轮换、连接改为不受支持的地址或连接删除时，在同一事务中作废旧快照；以绑定代次丢弃变更前已发出的请求结果。账务授权失效时清除快照。已有连接可继续使用，直到所有者主动配置余额查询。

## 验收

- 使用合成凭据和响应验证签名、固定端点、业务层错误、负数可用额度及币种，使用 `@lumio/schema` 校验配置与读数。
- 验证所有者权限、凭据不回传、超时后保留最近读数、授权失效及清除后读数消失，以及并发刷新时旧绑定的响应无法覆盖当前状态。
- 用 Web 设置页现有连接完成配置与刷新，核对余额字段、币种、更新时间和失败状态。连接所有者可在日常实例配置已授权的 RAM 凭据后，核对官方账户结果。

## 参考

- [QueryAccountBalance 接口](https://help.aliyun.com/zh/user-center/developer-reference/api-bssopenapi-2017-12-14-queryaccountbalance)
- [账务 API 端点](https://help.aliyun.com/zh/user-center/developer-reference/api-bssopenapi-2017-12-14-endpoint)
- [账务 API 授权](https://help.aliyun.com/en/user-center/developer-reference/api-calling-authorization)
- [百炼计费与套餐](https://help.aliyun.com/zh/model-studio/bill-query-and-cost-management)
