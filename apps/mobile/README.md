# apps/mobile — iPhone 捕获快捷指令

原生手机 App 以后再说；现在用系统"快捷指令"做 macOS 捕获小助手（ADR 0066）的弱化版，只用系统自带动作，不需要第三方 App。

| 快捷指令 | 建议的触发方式 | 做什么 |
|---|---|---|
| Lumio 收藏 | 轻点背面两下 | 截屏 → 本机识字 → 存为资料（进 Inbox 与知识库），震一下提示"已收藏" |
| Lumio 问一问 | 操作按钮 | 截屏 → 听写 → 把这句话和截图一起发给主对话 → 显示回复 |

截屏总是第一个可见动作，所以截到的是按下时正在看的界面。问一问在听写时取消，什么都不会上传。配对时会同步生成链接的 Lumio 界面语言：中文用普通话（`zh-CN`），英文用英语（`en-US`）。听写、提示和 Hub 请求采用同一语言。切换 Lumio 语言后重新配对即可同步手机。旧链接和旧配置没有语言时沿用中文。

**配对不单独成一个快捷指令。** Lumio 设置 → Hub 与执行器 → iPhone 生成配对二维码，内容是
`shortcuts://run-shortcut?name=Lumio%20收藏&input=text&text={"hub":…,"code":…}`。相机扫码启动"Lumio 收藏"，
它收到这段输入就用配对码换取令牌，存到 iCloud 云盘 `快捷指令/Lumio/config.json`，提示已配对后结束（这次不截屏）。
两个快捷指令共用这份配置。没配对时运行，会提示去设置页扫码。

## 生成与签名（发版时）

```sh
bun run apps/mobile/build.ts          # 生成未签名文件到 apps/mobile/dist/（不提交）
bun run apps/mobile/build.ts --sign   # 在登录了 Apple ID 的 Mac 上签名到 apps/mobile/signed/，然后提交
```

iOS 只导入签名过的快捷指令。`shortcuts sign --mode anyone` 签出的文件谁都能导入，文件里不含地址或令牌，所有用户共用同一份，
所以用户不需要 Mac（Windows、Linux 都行）。GitHub 的 macOS 机器没有 Apple ID，签名只能在维护者的 Mac 上做；
快捷指令很少改，改了生成器就顺手重签并提交 `signed/`。设置页的安装二维码指向
`https://raw.githubusercontent.com/wicsp/Lumio/main/apps/mobile/signed/<名字>.shortcut`。

## 在 iPhone 上设置

1. Hub 要能从手机访问（同一局域网的地址，或 Tailscale 等）；地址怎么暴露由部署者决定。
2. 电脑上打开 Lumio → 设置 → Hub 与执行器 → iPhone：用 iPhone 相机扫两个安装二维码，添加快捷指令。
3. 点"生成配对二维码"，确认地址是手机能访问的，再用相机扫一下。手机上不用打字。
4. 设置 → 操作按钮 → 快捷指令 → 选"Lumio 问一问"；设置 → 辅助功能 → 触控 → 轻点背面 → 轻点两下 → 选"Lumio 收藏"。
5. 第一次运行时，iOS 会询问是否允许截屏、访问 Hub 地址、使用听写，都选"始终允许"。

## 与桌面小助手的差别

iOS 拿不到前台 App、网址、选中文字和光标位置，识字结果也没有位置。所见里 `app.name` 记为 `iPhone`，
识字作为一块覆盖整张截图的文字（`ios-vision@1`，单块截断在 2400 字），Hub 按"没有指向"用整屏文字。
"指的是哪一段"靠说话补充，例如"中间那段""第二条评论"。捕获渠道用现有的 `share`。

助手回复用"显示结果"弹出；回复较慢时快捷指令可能先超时，这一轮仍在 Hub 上继续，到 Lumio 主对话里看结果。

## 测试

`test/shortcuts.test.ts` 用一个最小解释器按动作顺序运行生成的快捷指令，模拟 Hub 响应，再用 `@lumio/schema` 校验发出的每个请求体。
它保证参数编码拼出的请求符合契约；动作在 iOS 上的实际行为要在手机上验收。
