# S1-1 语音预研

2026-11-11，Hub 与浏览器实验基线为 `7b7342f`，提交前同步到 `origin/main` 的 `cb9dd89`。范围见 [S1-0](../tasks/S1-0-speech.md) 和 [ADR 0055](../adr/0055-speech-input-and-output.md)。

**建议首版接入阿里云百炼 Fun-ASR-Realtime（北京），使用人维护的完整热词表。** 20 句真人语音中，17 词热词组 CER 为 5.51%，火山豆包 2.0 为 11.92%；词表中的 19 次常用技术词和项目名命中分别为 16 次、10 次。Fun-ASR 的松手定稿 p95 为 934 ms，火山为 271 ms。首版按本批样本的准确率与热词效果选择 Fun-ASR，火山保留作后续候选。

## 流式识别

| 服务商与模型 | 中英混说与热词 | 松手时的结束信号 | 国内公开按量价 |
|---|---|---|---|
| 阿里云 `fun-asr-realtime` | 同一模型支持中文、英语及方言。用主工作空间的预编译词表，普通词权重 4。热词不另收费。 | 发 `finish-task`，累积 `sentence_end` 片段，收到 `task-finished` 后交付整句。 | 北京 ¥1.188/音频小时。 |
| 火山豆包流式语音识别 2.0 小时版 `volc.seedasr.sauc.duration` | `bigmodel_async` 提供中英双向实时识别。测试用一遍流式，热词经 `request.corpus.context` 随请求直传，上限 100 tokens。 | 最后一帧音频带结束标记，收到最后一个响应时交付全量文本。 | ¥1.00/音频小时。 |

公开单价未计免费额度、税和账户折扣。每家共跑无热词、12 词和 17 词三组，各 122.06 秒，按标价估算阿里云合计约 ¥0.121，火山约 ¥0.102。先前全静音试跑单独作废，以上金额只估算有效语料的三组实验，实际账单取决于服务商的计费粒度和账户额度。 [阿里云流式协议](https://www.alibabacloud.com/help/en/model-studio/fun-asr-realtime-websocket-api) · [阿里云热词](https://www.alibabacloud.com/help/en/model-studio/improve-asr-accuracy) · [阿里云定价](https://help.aliyun.com/zh/model-studio/model-pricing) · [火山实时协议](https://docs.volcengine.com/docs/doubao-voice/bidirectional-streaming-automatic-speech-recognition-websocket?lang=zh) · [火山热词](https://docs.volcengine.com/docs/doubao-voice/hot-words-and-context?lang=zh) · [火山定价](https://docs.volcengine.com/docs/doubao-voice/billing-instructions?lang=zh)

### 对比口径与进度

- 人录 20 句，含中英混说、安排任务的口语、项目名、技术词、执行器和 citekey。首批 WAV 的采样格式正确，但录音脚本默认选到了 Oray 虚拟音频设备，20 段样本全为零。该轮云端试跑作废。录音脚本改成先选设备、试音并回放，评测也在连接服务前逐句检查时长和信号电平。重录的 20 句均通过预检，总长 122.06 秒，每句 4.84–8.89 秒，峰值范围 8975–20812。测试集和录音脚本在仓库外。
- 每家测三个条件，各 20 句，逐句建连并以 100 ms 帧实时回放。热词组固定发送同一份 17 词词表，无热词组省略词表。先测 12 个常用术语与项目名，再扩充执行器名、三条 citekey 和 `connect-src` 五项。下表使用无热词组和完整 17 词组。无热词和 12 词两组按录音编号奇偶交替先后顺序，随后独立补跑 17 词组。两家独立会话并行跑同一份语料。保持服务商默认文本规整，火山关闭二遍。服务商 ready 后模拟开始采集，首个临时结果从这个时刻计时，含首帧采集时间与录音开头的停顿。单列建连与启动开销。松手时发送结束消息，收到服务商明确结束信号时计为定稿；额外统计最后非空定稿片段的到达时刻。没有在松手前收到非空临时结果的样本单独计数。
- CER 汇总所有句子的编辑距离后除以参考字符总数。文本经 NFKC、统一小写、去空白和标点；数字与汉字保留原写法。技术词忽略字母大小写，按边界匹配，保留执行器名的 `@`、`connect-src` 的连字符以及 citekey 拼写。热词组比较同一批语音的词命中数、额外误报次数和 CER，执行器名和 citekey 等额外单列。延迟报告样本数、p50、p95。单个说话人的 20 句是首轮选型样本，实测从 Mac 直连服务商，正式部署还会有浏览器到 Hub 的网络开销。
- `--smoke` 使用合成 PCM 和本机两个模拟流式协议，验证分帧、终止事件、延迟计时与评分。正式对比使用重录后在本机验证过的测试集。

所有延迟单位为 ms。首临时列括号表示松手前得到非空临时结果的句数。

| 服务商 | 热词 | 成功句数 | CER | 常用词命中 / 应出现 | 常用词额外命中 | 执行器等命中 / 应出现 | 首临时 p50 / p95 (n) | 松手定稿 p50 / p95 |
|---|---|---|---|---|---|---|---|---|
| Fun-ASR | 关 | 20/20 | 9.09% | 9/19 | 0 | 2/7 | 1017 / 2014 (20/20) | 329 / 1065 |
| Fun-ASR | 17 词 | 20/20 | 5.51% | 16/19 | 0 | 4/7 | 1089 / 1834 (20/20) | 304 / 934 |
| 豆包 2.0 | 关 | 20/20 | 12.37% | 6/19 | 0 | 0/7 | 1582 / 2213 (19/20) | 187 / 484 |
| 豆包 2.0 | 17 词 | 20/20 | 11.92% | 10/19 | 0 | 0/7 | 1550 / 2224 (20/20) | 151 / 271 |

完整热词组里，Fun-ASR 相对无热词减少 24 个字符编辑错误（61 → 37）；豆包减少 3 个（83 → 80）。两家的所列热词都没有出现额外命中。Fun-ASR 三条 citekey 和 `connect-src` 在完整热词组全部命中，`codex@macsp` 三次都未完整命中。用户仍需检查执行器名的拼写，输入框里的确认流程保留实际作用。

| 词或完整标识 | Fun-ASR 关 | Fun-ASR 17 词 | 豆包关 | 豆包 17 词 |
|---|---|---|---|---|
| `Lumio` | 1/2 | 1/2 | 0/2 | 2/2 |
| `北极星` | 2/2 | 2/2 | 2/2 | 2/2 |
| `Atlas` | 2/2 | 2/2 | 1/2 | 1/2 |
| `WebSocket` | 1/1 | 1/1 | 0/1 | 0/1 |
| `AudioWorklet` | 0/1 | 1/1 | 0/1 | 0/1 |
| `Project Lantern` | 2/2 | 2/2 | 2/2 | 2/2 |
| `青岚计划` | 0/2 | 2/2 | 0/2 | 2/2 |
| `Paper Trail` | 0/1 | 1/1 | 1/1 | 1/1 |
| `SQLite` | 0/1 | 1/1 | 0/1 | 0/1 |
| `Tailscale` | 0/1 | 1/1 | 0/1 | 0/1 |
| `PCM16` | 1/1 | 1/1 | 0/1 | 0/1 |
| `citekey` | 0/3 | 1/3 | 0/3 | 0/3 |
| `codex@macsp` | 0/3 | 0/3 | 0/3 | 0/3 |
| `vaswani2017attention` | 0/1 | 1/1 | 0/1 | 0/1 |
| `he2016deep` | 1/1 | 1/1 | 0/1 | 0/1 |
| `brown2020language` | 1/1 | 1/1 | 0/1 | 0/1 |
| `connect-src` | 0/1 | 1/1 | 0/1 | 0/1 |

12 词组用于观察补入完整标识前后的差别。Fun-ASR 的 CER 也是 5.51%，常用词 16/19，执行器等 1/7；豆包 CER 为 11.77%，常用词 10/19，执行器等 0/7。补入完整标识后，Fun-ASR 的标识命中增加，CER 总编辑数保持相同。豆包在 12 词与 17 词组之间有一个字符编辑差异。热词是本轮识别条件，单轮样本的波动与词表变化一起体现在结果中。

| 服务商与组别 | 建连/启动 p50 / p95 | 含建连首临时 p50 / p95 | 松手后 ≤1s | 最长松手定稿 |
|---|---|---|---|---|
| Fun-ASR 关 | 322 / 520 | 1379 / 2389 | 18/20 | 1690 |
| Fun-ASR 17 词 | 281 / 344 | 1401 / 2148 | 20/20 | 995 |
| 豆包 2.0 关 | 301 / 427 | 1969 / 2756 | 19/20 | 3686 |
| 豆包 2.0 17 词 | 278 / 379 | 1856 / 2498 | 20/20 | 597 |

18 句含英文或标识的混说子集，CER 分别为 Fun-ASR关热词 9.47%、Fun-ASR17词 5.94%、豆包关热词 13.00%、豆包17词 12.84%。这批录音的首临时结果 p50 约 1.1–1.6 秒，指标含录音开头停顿、网络以及模型等待语音的时间，实际按住说话的首字体验需要在 S1-4 验收。完整热词组的两家定稿 p95 都在 ADR 0055 的 1 秒目标内；两家完整热词组的 20 句都在 1 秒内定稿。单个说话人、每条件一次的结果支持首轮选型，条件间的时间顺序与服务波动也会影响结果。更多口音与噪声场景留到试用验证。

## Bun 1.4.4 与 Hub

[Hub 探针](../../scripts/spike/speech/hub.ts) 用 Bun 的加载钩子把实验分支注入真实 Hub 模块。启动临时状态目录、随机 loopback 端口和合成身份。使用现有的 `browserAllowed`、HTTP 路由、认证与真实 Web CSP。

| 请求 | 实测 |
|---|---|
| loopback、`LUMIO_PUBLIC_URL`、`LUMIO_WEB_ORIGINS` 的合法 Origin/Host | 101 |
| 外部 Origin、错误 Host、`Origin: null` | 403 |
| 无 Origin、无 `Sec-Fetch-Site` 的原生客户端 | 101，沿用现有浏览器门禁语义 |
| 普通 GET 语音路径及无令牌的 `/v2/work/tasks` | 401 |
| 有合成令牌的 `/v2/work/tasks` 与 `/health` | 200 |
| Chromium 154、macOS Safari 27.0.1、iOS 27.0 模拟器 Safari，同源 WebSocket | 返回文本 `ready`，并原样回传 4 字节二进制帧 |
| Chromium 154、macOS Safari 27.0.1、iOS 27.0 模拟器 Safari，跨端口 WebSocket 对照 | `securitypolicyviolation` 报 `connect-src`，本机对照端口可连接 |

在 `browserAllowed` 之后、HTTP Bearer 认证之前，为精确路径和 GET 升级握手调用 `server.upgrade(request)`。Bun 负责 101，成功后从 `fetch` 返回 `undefined`，仅对正常 HTTP 响应调用 `webResponse`。把升级记为 101，日志使用固定路由。S1-3 在第一条 `start` 中认证 human，认证成功前拒绝音频。现行浏览器门禁允许无浏览器头的请求，首帧认证因此仍有必要。 [Bun WebSocket](https://bun.com/docs/runtime/http/websockets)

本机页面保留 `connect-src 'self'`。浏览器由 `location` 派生同源 `ws:` 或 `wss:`，部署时让 HTTPS 代理转发 Upgrade，保留公网 Host 与 Origin，并把公开 HTTPS 来源纳入现行 Hub 配置。上表公开来源的 101 使用的是带相应头部的原始 HTTP 握手。真实 WSS 代理链路仍需在部署验收验证。WebKit 已有同源 WebSocket 的 CSP 修复和测试记录。 [WebKit CSP 源匹配修复](https://bugs.webkit.org/show_bug.cgi?id=235873)

## Safari 与 iOS PWA 的采集

- macOS Safari 27.0.1 在安全的 loopback 上完成真实麦克风试验。音轨和默认 AudioContext 均为 48 kHz。得到 50 帧，每帧 1280 字节，共 32,000 个 PCM16LE 样本，峰值 270。音频在浏览器内存中分析。
- iOS 27.0 的 iPhone 模拟器 Safari 标签页，同源 WebSocket 有二进制回包。两种合成信号的离线 AudioWorklet 输出分别为 50 帧、32,000 样本。44.1 kHz 输入的 1 kHz 分量约 0.24998，10 kHz 经抽样折回的 6 kHz 分量约 0.000193；48 kHz 对应约 0.25000 和 0.000116。桌面 Safari 的两组离线结果与之相符。模拟器浏览器的合成信号验证了跨帧重采样、低通和输出格式。iPhone/iPad 真机主屏幕 PWA 的录音与恢复仍需验证。 [WebKit AudioWorklet 支持](https://webkit.org/blog/11648/new-webkit-features-in-safari-14-1/) · [Web Audio API](https://www.w3.org/TR/webaudio-1.0/)
- **重采样放在浏览器的 AudioWorklet。** 首次用点击或触摸启动默认 `AudioContext`，调用 `resume()` 和 `getUserMedia({audio: true})`，将媒体源接到同源加载的 worklet。用 worklet 的 `sampleRate` 作为输入采样率，按实际渲染块长度处理。混成单声道，连续低通再重采样，跨块保留滤波历史与小数相位。按 40 ms 打包 640 个样本，以 `DataView.setInt16(offset, value, true)` 写出小端帧。通过 `MessagePort` 转移缓冲区，主线程只管 WebSocket 发送与背压。Hub 收到的已经是协议所需的 PCM16。适配火山时可把帧长配置为 100 ms，或在 Hub 合并 PCM 字节后加服务商的二进制帧头。WebKit 曾记录指定麦克风采样率和非默认 Context 采样率的问题。本轮选择默认 Context，在 worklet 内完成转换。 [WebKit 麦克风采样率问题](https://bugs.webkit.org/show_bug.cgi?id=217147) · [WebKit iPadOS 音频图问题](https://bugs.webkit.org/show_bug.cgi?id=274507)
- S1-4 应显式请求 worklet 冲刷尾部并等最后一帧入队，再发送 `end`。测试探针只观察前两秒的完整帧。取消、页面隐藏、切换音频路由或 Context 中断时释放轨道和节点。前台恢复后由新手势开启采集。iOS 验收时在可信 HTTPS 部署上从主屏幕启动，核对 `display-mode: standalone`、首次授权和冷启动后再次授权、连续录两次、锁屏或来电后重新录音，以及蓝牙切换时的输入采样率和正常语速。 [WebKit 主屏幕权限记录](https://bugs.webkit.org/show_bug.cgi?id=327237) · [WebKit 后台恢复 WebSocket 问题](https://bugs.webkit.org/show_bug.cgi?id=308073)

## 复现

```sh
bun scripts/spike/speech/asr.ts --smoke
bun scripts/spike/speech/hub.ts
bun scripts/spike/speech/hub.ts --serve
```

浏览器打开最后一条打印的 `BROWSER_URL`，先读 WebSocket 结果，再分别点击合成信号和麦克风按钮。也可以加 `?auto=tone` 自动跑合成信号。探针的 WebSocket 只做实验回显，限定在 loopback。

先执行 `bun scripts/spike/speech/asr.ts --validate` 对 20 段 WAV 做离线预检。真实 ASR 对比需要环境中的 `DASHSCOPE_API_KEY`、`DASHSCOPE_WORKSPACE_ID`、`DASHSCOPE_REGION`（`singapore` 或 `beijing`），以及 `VOLCENGINE_SPEECH_API_KEY`。阿里云凭据需能在主工作空间管理热词表。评测会创建临时词表并在结束时删除。脚本从 `transcripts.tsv` 和 20 段 WAV 读取测试集，流式发送音频与固定词表，标准文本只在本地评分。输出为计数、计时和失败状态。

```sh
bun scripts/spike/speech/asr.ts "$HOME/lumio-speech-testset" > /tmp/lumio-s1-1-asr.json
```

## 验证与范围

- Bun 版本为 1.4.4。最后一次完整检查通过，1430 pass、4 skip、0 fail。另跑 ASR 模拟服务冒烟测试、静音输入拒绝测试、Hub 真实路由探针与最终类型检查。首次检查曾有两条 Native Assistant 测试超时，在关闭实验进程、隔离临时目录后复跑通过。
- 提交只包含本文和一次性脚本。package/app、契约和依赖均无改动。真实 vault 与现有 Hub 实例未用于实验。测试音频、标准文本及录音脚本保留在仓库外。主屏幕 PWA 真机与真实 WSS 代理的验收范围见上文。
- 本轮语料指纹为 SHA-256 `215f5c089bff429ff004a53506136092094b714c239e2d27668b18ada3dc95dc`。计算顺序为标准文本字节，再依编号追加每个 WAV 的文件名 UTF-8 字节与文件字节。
