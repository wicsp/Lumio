# apps/mobile — iPhone 捕获快捷指令

原生手机 App 以后再说；现在用系统"快捷指令"做 macOS 捕获小助手（ADR 0066）的弱化版，只用系统自带动作，不需要第三方 App。

| 快捷指令 | 建议的触发方式 | 做什么 |
|---|---|---|
| Lumio 配对 | 手动运行一次 | 输入 Hub 地址和配对码，换取令牌，存到 iCloud 云盘 `快捷指令/Lumio/config.json` |
| Lumio 收藏 | 轻点背面两下 | 截屏 → 本机识字 → 存为资料（进 Inbox 与知识库），震一下提示"已收藏" |
| Lumio 问一问 | 操作按钮 | 截屏 → 听写 → 把这句话和截图一起发给主对话 → 显示回复 |

截屏总是第一步，所以截到的是按下时正在看的界面。问一问在听写时取消，什么都不会上传。

## 生成与签名

```sh
bun run apps/mobile/build.ts          # 生成未签名文件到 apps/mobile/dist/
bun run apps/mobile/build.ts --sign   # macOS：再用 shortcuts sign 签名到 apps/mobile/dist/signed/
```

iOS 只导入签名过的快捷指令，签名要在登录了 Apple ID 的 Mac 上做。把 `dist/signed/` 里的三个文件用隔空投送或 iCloud 云盘发到 iPhone，点开即可添加。

## 在 iPhone 上设置

1. Hub 要能从手机访问（同一局域网的地址，或 Tailscale 等）；地址怎么暴露由部署者决定。
2. 在 Lumio 设置里生成配对码（或 `lumio login-code --name ios`），运行"Lumio 配对"，填 Hub 地址和配对码。
3. 设置 → 操作按钮 → 快捷指令 → 选"Lumio 问一问"。
4. 设置 → 辅助功能 → 触控 → 轻点背面 → 轻点两下 → 选"Lumio 收藏"。
5. 第一次运行时，iOS 会询问是否允许截屏、访问 Hub 地址、使用听写，都选"始终允许"。

## 与桌面小助手的差别

iOS 拿不到前台 App、网址、选中文字和光标位置，识字结果也没有位置。所见里 `app.name` 记为 `iPhone`，
识字作为一块覆盖整张截图的文字（`ios-vision@1`，单块截断在 2400 字），Hub 按"没有指向"用整屏文字。
"指的是哪一段"靠说话补充，例如"中间那段""第二条评论"。捕获渠道用现有的 `share`。

助手回复用"显示结果"弹出；回复较慢时快捷指令可能先超时，这一轮仍在 Hub 上继续，到 Lumio 主对话里看结果。

## 测试

`test/shortcuts.test.ts` 用一个最小解释器按动作顺序运行生成的快捷指令，模拟 Hub 响应，再用 `@lumio/schema` 校验发出的每个请求体。
它保证参数编码拼出的请求符合契约；动作在 iOS 上的实际行为要在手机上验收。
