# 0073 笔记图床与 Markdown 图片

- 状态：Accepted（2026-11-17 人类批准）
- 日期：2026-11-17
- 领域：知识编辑、Hub 配置、Web 渲染与 HTTP 契约
- 关联：[K5-0](../tasks/K5-0-note-image-hosting.md)、ADR 0026、0035、0062，W1-0

## 背景

用户已经用 uPic 把图片上传到 Cloudflare R2，希望在 Lumio 里直接粘贴、拖入和预览图片，同时覆盖主流图床。Lumio 的共享 Markdown 渲染器目前把图片转成替代文字，页面 CSP 也禁止外域图片。托管截图及执行产物分别绑定所见和 Job，生命周期与笔记图床不同。

## 图床配置与传输

1. Hub 内置图床上传，随现有单文件发布。一套 Hub 可配置一个上传目的地和一份独立的预览 HTTPS 来源列表。预览列表可以保留旧图床域名，也可以单独开启；迁移时可以共用 uPic 的 R2 桶与图片域名。新安装默认没有上传目的地和外域预览来源，无数据库迁移。
2. `s3` 使用 `Bun.S3Client`，配置上传 endpoint、region、bucket、寻址方式、对象前缀和用于拼接长期直链的公开 URL 前缀。提供 R2、AWS S3、MinIO、Backblaze B2、DigitalOcean Spaces、OSS、COS、七牛和通用 S3 兼容入口。厂商预设的生产兼容性以各自上传及读回验证为准。R2 默认 region 为 `auto`，上传 endpoint 与图片交付域名分别配置。上传省略 ACL 头，由用户既有的访问策略控制读图。
3. `http` 使用标准 `fetch`。配置固定的 HTTPS 地址、`POST` 或 `PUT`、multipart 文件字段或原始字节、固定表单字段和请求头、响应 JSON 中提取 URL 的字段路径。可按预先配置的公开 URL 前缀拼接对象键，支持按键写入的 WebDAV 等端点。提供兰空、S.EE、Imgur、Cloudflare Images 和三月图床的请求配置示例。字段路径只读 JSON 对象属性和数组下标。返回相对路径时用配置的公开前缀解析。所有返回地址都需要通过 HTTPS 和已配置交付来源检查。
4. `github` 使用 GitHub Contents API 把图片写入指定仓库、分支和目录。公开图片地址使用配置的交付前缀，例如公共仓库的 raw 地址。图床上传只发图片字节和适配器所需元数据。浏览器请求只选择笔记和文件，不能逐次指定上传目的地或凭据。适配器限制上游响应大小和等待时间、拒绝重定向，过滤上游错误正文。配置只由配对 human 修改。自建内网图床仅允许部署者显式放行的 HTTPS 来源。
5. 复用 Hub 原子私有文件写入和版本检查模式。状态目录 `image-hosting.json` 保存带版本的安装配置，权限为 `0600`，按安装配置备份。凭据只供 Hub 请求已保存的目的地。设置读取、错误、回执、审计和日志均省略凭据，浏览器不持久化它们。省略凭据可在同一目的地保留，改变服务或上传来源须重新提供；禁用上传时清除凭据，保留显式配置的预览来源。

## HTTP 契约与权限

在 `packages/schema` 定义严格的 `ImageHostingSettings`、`ImageHostingUpdate`、私有 `ImageHostingRecord`、`ImageUploadResult` 及共享上传边界。新增接口沿用 Hub 的同源校验、鉴权、语言和 `ApiError`。

| 方法与路径 | 请求与响应 |
| --- | --- |
| `GET /v2/knowledge/image-hosting` | `ImageHostingSettings`，含 `revision`、配置状态、可公开的目的地字段、已保存凭据状态和 `preview_origins`。 |
| `PUT /v2/knowledge/image-hosting` | `ImageHostingUpdate`，含 `expected_revision`、预览来源、可选上传目的地和只写凭据，返回 `ImageHostingSettings`。 |
| `POST /v2/knowledge/notes/<id>/images` | `multipart/form-data` 中唯一的 `image` 文件，返回 `ImageUploadResult`（`url`、`media_type` 与 `size`）。 |

- 只授予配对 human。上传必须归属一个现有、公开且可编辑的知识笔记，复用文档编辑资格检查；代理、Runtime、助手工具、私密及已删除笔记无上传入口。配置和上传均审计操作及结果；上传可记录笔记 ID、适配器和字节数，不记录图片、正文、链接或原始上游响应。涉及配置的响应不缓存。
- 请求在解析前执行体积限制。单张图片最多 10 MiB，校验 PNG、JPEG、GIF、WebP、AVIF 的实际文件签名并按签名选择扩展名和媒体类型。对象键使用独立生成的 ID，放在配置前缀内。超时或中断后由人发起重试，界面需说明请求可能已在外部落盘。移除 Markdown 图片只编辑笔记，不删除外部文件。

## Markdown 与浏览器

- 文档只保存标准 Markdown 图片引用。Hub 提供的 HTML 只把配置中的精确 HTTPS 来源添加到 `img-src`。知识笔记的阅读、编辑预览和实时编辑共用相同的来源校验。其余渲染入口及未授权来源保留替代文字。禁止协议相对地址、URL 凭据、非 HTTPS 地址和原始 HTML 图片，预览不发送 Referer。
- 知识编辑器只在人选择、粘贴或拖入本地图片时上传，展示目的地、进度和失败原因；上传通过后在发起处插入图片引用，再走现有的自动保存、版本冲突和草稿恢复机制。切换文档、登出或销毁编辑器后不得把旧结果插入其他文档。新建流程在笔记取得稳定 ID 后使用同一编辑入口。设置里的预览来源变化随下一次页面加载应用。

## 备选方案

PicGo / PicList 可覆盖更多桌面上传流程，适合参考其图床配置和编辑体验。PicGo 的 R2 支持来自插件；PicList-Core 打包会带入 AWS SDK 和 `sharp` 等组件，其 HTTP 服务则增加运行时进程。Apache OpenDAL 的 Node.js 绑定带平台原生模块。采用 Bun 内置 S3 与少量 HTTP 适配器，沿用现有构建与部署，不增加 npm 依赖。

## 交付与验证

契约、Hub、API Client、Web、生成 Schema、设计分册及部署配置说明在同一功能 PR 交付。用合成数据和隔离状态验证，验收项见 [K5-0](../tasks/K5-0-note-image-hosting.md)。

## 修订记录

- 2026-11-17：人类批准图床配置、上传与预览契约，按 K5-0 一次交付。
- 2026-11-17：主线同时使用 0072，原已批准的图床提案编号顺延为 0073。
