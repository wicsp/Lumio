import { attach, asType, dictionary, f, HAS_NO_VALUE, HAS_VALUE, key, shortcutInput, text, variable, Workflow, type Ref } from "./workflow.ts";

/**
 * iPhone 上的全局捕获（ADR 0066 第 1 节提到的"轻点背面 + 快捷指令"弱化版）。
 *
 * 两个快捷指令，全部只用系统自带动作：
 * - **配对**不单独成一个快捷指令：Lumio 设置页显示二维码，内容是
 *   `shortcuts://run-shortcut?name=Lumio%20收藏&input=text&text={"hub":…,"code":…}`；
 *   相机扫码后"Lumio 收藏"收到这段输入，换取 human 令牌，存到 iCloud 云盘 `快捷指令/Lumio/config.json`，提示已配对后结束（不截屏）。
 *   两个快捷指令共用这份配置；"问一问"也认同样的输入。
 * - **Lumio 收藏**（建议绑轻点背面）：截屏 → 本机识字 → `POST /v2/glances` → `POST /v2/inbox/captures`，等同桌面小助手的轻点。
 * - **Lumio 问一问**（建议绑操作按钮）：截屏 → 听写 → 上传所见 → 发给主对话，显示回复，等同桌面小助手的按住说话。
 *
 * 与桌面小助手的差别（iOS 拿不到）：没有前台 App 名、网址、选中文字和光标，识字没有位置。
 * 所以 `app.name` 固定为 "iPhone"，识字作为一块覆盖整张截图的文字送出，Hub 按"没有指向"（`pointing: none`）用整屏文字。
 * 捕获渠道用现有的 `share`（从别的 App 分享进 Lumio），不新增契约。
 */

export const CONFIG_PATH = "Lumio/config.json";
export const OCR_ENGINE = "ios-vision@1";
export const APP_NAME = "iPhone";
export const SHORTCUT_REVISION = 3;
/** 识字块单块上限是 5000 个 UTF-16 码元；正则按字符截，留出余量给表情等代理对。 */
export const OCR_MAX_CHARS = 2400;
/** 截图长边上限，与 GLANCE_LIMITS.max_image_edge 一致。 */
export const IMAGE_EDGE = 2048;

interface Config { hub: Ref; token: Ref }

function notify(w: Workflow, title: string, ...body: (string | Ref)[]) {
  w.add("notification", { WFNotificationActionTitle: title, WFNotificationActionBody: text(...body), WFNotificationActionSound: true });
}

/** 扫码收到的快捷指令名，二维码按名字启动它；apps/web 的设置页用同一个名字。 */
export const PAIR_SHORTCUT_NAME = "Lumio 收藏";

/** 收到扫码输入时：用其中的 Hub 地址和配对码换取令牌并保存，提示后结束。没有输入时什么也不做。 */
function pairFromInput(w: Workflow) {
  w.when(shortcutInput, HAS_VALUE, () => {
    const payload = w.add("detect.dictionary", { WFInput: attach(shortcutInput) }, "Dictionary");
    const hub = w.add("text.replace", { WFInput: text(key(payload, "hub")), WFReplaceTextFind: "/+$", WFReplaceTextReplace: "", WFReplaceTextRegularExpression: true }, "Updated Text");
    const response = w.add("downloadurl", {
      WFURL: text(hub, "/v2/setup/client/join"),
      WFHTTPMethod: "POST",
      WFHTTPBodyType: "JSON",
      ShowHeaders: true,
      WFHTTPHeaders: dictionary([["Accept-Language", f.text("zh")]]),
      WFJSONValues: dictionary([["code", f.text(key(payload, "code"))]]),
    }, "Contents of URL");
    failUnless(w, response, "token");
    const config = w.add("dictionary", { WFItems: dictionary([["hub", f.text(hub)], ["token", f.text(key(response, "token"))]]) }, "Dictionary");
    const json = w.add("gettext", { WFTextActionText: text(config) }, "Text");
    const file = w.add("setitemname", { WFInput: attach(json), WFName: "config.json", WFDontIncludeFileExtension: false }, "Renamed Item");
    w.add("documentpicker.save", { WFInput: attach(file), WFAskWhereToSave: false, WFFileDestinationPath: CONFIG_PATH, WFSaveFileOverwrite: true }, "Saved File");
    notify(w, "Lumio 已配对", hub);
    w.add("exit", {});
  });
}

/** 读配对时保存的地址与令牌；没有配对过时提示并结束。 */
function loadConfig(w: Workflow): Config {
  const file = w.add("documentpicker.open", { WFGetFilePath: CONFIG_PATH, WFFileErrorIfNotFound: false, WFShowFilePicker: false }, "File");
  w.when(file, HAS_NO_VALUE, () => {
    notify(w, "Lumio 还没有配对", "在 Lumio 设置 → iPhone 里生成配对二维码，用相机扫一下。");
    w.add("exit", {});
  });
  const config = w.add("detect.dictionary", { WFInput: attach(file) }, "Dictionary");
  return { hub: key(config, "hub"), token: key(config, "token") };
}

/** 本次运行的请求 ID 前缀：`ios-<毫秒时间>-<随机数>`，各请求再加后缀，满足 RequestId 的格式。 */
function requestBase(w: Workflow): { id: Ref; captured: Ref } {
  const now = w.add("date", { WFDateActionMode: "Current Date" }, "Date");
  const stamp = w.add("format.date", { WFDate: text(now), WFDateFormatStyle: "Custom", WFDateFormat: "yyyyMMddHHmmssSSS" }, "Formatted Date");
  const captured = w.add("format.date", { WFDate: text(now), WFDateFormatStyle: "ISO 8601", WFISO8601IncludeTime: true }, "Formatted Date");
  const random = w.add("number.random", { WFRandomNumberMinimum: 100000, WFRandomNumberMaximum: 999999 }, "Random Number");
  const id = w.add("gettext", { WFTextActionText: text("ios-", stamp, "-", random) }, "Text");
  return { id, captured };
}

/** 截屏并整理成所见：缩到长边 2048、转 JPEG、本机识字。前面只允许不可见的判断，免得截到别的界面。 */
function glance(w: Workflow) {
  const screenshot = w.add("takescreenshot", {}, "Screenshot");
  const resized = w.add("image.resize", { WFImage: attach(screenshot), WFImageResizeKey: "Longest Edge", WFImageResizeLength: String(IMAGE_EDGE) }, "Resized Image");
  const jpeg = w.add("image.convert", { WFInput: attach(resized), WFImageFormat: "JPEG", WFImageCompressionQuality: 0.8, WFImagePreserveMetadata: false }, "Converted Image");
  const width = w.add("properties.images", { WFInput: attach(jpeg), WFContentItemPropertyName: "Width" }, "Width");
  const height = w.add("properties.images", { WFInput: attach(jpeg), WFContentItemPropertyName: "Height" }, "Height");
  const ocr = w.add("extracttextfromimage", { WFImage: attach(jpeg) }, "Text from Image");
  const matches = w.add("text.match", { WFMatchTextPattern: `[\\s\\S]{1,${OCR_MAX_CHARS}}`, WFMatchTextCaseSensitive: true, text: text(ocr) }, "Matches");
  const first = w.add("getitemfromlist", { WFInput: attach(matches), WFItemSpecifier: "First Item" }, "Item from List");
  return { jpeg, width, height, ocrText: first };
}

/** 生成 GlanceCreate 并上传，返回所见 ID。识字为空时不带 ocr。失败时提示 Hub 的错误并结束。 */
function uploadGlance(w: Workflow, config: Config, base: { id: Ref; captured: Ref }, shot: ReturnType<typeof glance>): Ref {
  const common: [string, ReturnType<typeof f.text>][] = [
    ["request_id", f.text(base.id, "-g")],
    ["captured", f.text(base.captured)],
    ["app", f.dict(["name", f.text(APP_NAME)])],
    ["image", f.dict(["format", f.text("jpeg")], ["width", f.number(shot.width)], ["height", f.number(shot.height)])],
  ];
  // Shortcuts can resolve the End If output to empty when a multipart field consumes it.
  // Save either branch's dictionary explicitly and convert it to JSON text before uploading.
  const metaName = "Glance Metadata";
  const setMeta = (fields: Parameters<typeof dictionary>[0]) => {
    const meta = w.add("dictionary", { WFItems: dictionary(fields) }, "Dictionary");
    w.add("setvariable", { WFVariableName: metaName, WFInput: attach(meta) });
  };
  setMeta(common);
  w.when(shot.ocrText, HAS_VALUE, () => {
    setMeta([
      ...common,
      ["ocr", f.array(f.dict(
        ["text", f.text(shot.ocrText)],
        ["box", f.dict(["x", f.number(0)], ["y", f.number(0)], ["w", f.number(shot.width)], ["h", f.number(shot.height)])],
      ))],
      ["ocr_engine", f.text(OCR_ENGINE)],
    ]);
  });
  const meta = w.add("detect.text", { WFInput: attach(variable(metaName)) }, "Text");
  const response = w.add("downloadurl", {
    WFURL: text(config.hub, "/v2/glances"),
    WFHTTPMethod: "POST",
    WFHTTPBodyType: "Form",
    ShowHeaders: true,
    WFHTTPHeaders: dictionary([["Authorization", f.text("Bearer ", config.token)], ["Accept-Language", f.text("zh")]]),
    WFFormValues: dictionary([["meta", f.text(meta)], ["image", f.file(shot.jpeg)]]),
  }, "Contents of URL");
  failUnless(w, response, "id");
  return key(response, "id");
}

/** 响应里没有 `field` 时，提示 Hub 返回的错误并结束。 */
function failUnless(w: Workflow, response: Ref, field: string) {
  w.when(key(response, field), HAS_NO_VALUE, () => {
    notify(w, "Lumio 失败", key(response, "error.message"));
    w.add("exit", {});
  });
}

function postJson(w: Workflow, config: Config, path: string, body: [string, ReturnType<typeof f.text>][]): Ref {
  return w.add("downloadurl", {
    WFURL: text(config.hub, path),
    WFHTTPMethod: "POST",
    WFHTTPBodyType: "JSON",
    ShowHeaders: true,
    WFHTTPHeaders: dictionary([["Authorization", f.text("Bearer ", config.token)], ["Accept-Language", f.text("zh")]]),
    WFJSONValues: dictionary(body),
  }, "Contents of URL");
}

export function saveShortcut(): Workflow {
  const w = new Workflow(PAIR_SHORTCUT_NAME);
  w.add("comment", { WFCommentActionText: `Lumio iPhone · v${SHORTCUT_REVISION}` });
  pairFromInput(w);
  const shot = glance(w);
  const config = loadConfig(w);
  const base = requestBase(w);
  const id = uploadGlance(w, config, base, shot);
  const result = postJson(w, config, "/v2/inbox/captures", [
    ["request_id", f.text(base.id, "-c")],
    ["channel", f.text("share")],
    ["glance", f.text(id)],
  ]);
  failUnless(w, result, "capture.id");
  w.add("vibrate", {});
  notify(w, "已收藏", "已存入 Lumio");
  return w;
}

export function askShortcut(): Workflow {
  const w = new Workflow("Lumio 问一问");
  w.add("comment", { WFCommentActionText: `Lumio iPhone · v${SHORTCUT_REVISION}` });
  pairFromInput(w);
  const shot = glance(w);
  const config = loadConfig(w);
  const said = w.add("dictatetext", { WFDictateTextStopListening: "After Pause" }, "Dictated Text");
  const base = requestBase(w);
  const id = uploadGlance(w, config, base, shot);
  const main = postJson(w, config, "/v2/assistant/main", [["request_id", f.text(base.id, "-m")]]);
  failUnless(w, main, "conversation");
  const reply = postJson(w, config, "/v2/assistant/chat", [
    ["request_id", f.text(base.id, "-t")],
    ["conversation", f.text(key(main, "conversation"))],
    ["message", f.text(said)],
    ["glance", f.text(id)],
  ]);
  failUnless(w, reply, "turn.id");
  const messages = w.add("getvalueforkey", { WFInput: attach(reply), WFDictionaryKey: "messages", WFGetDictionaryValueType: "Value" }, "Dictionary Value");
  const last = w.add("getitemfromlist", { WFInput: attach(messages), WFItemSpecifier: "Last Item" }, "Item from List");
  w.add("showresult", { Text: text(key(asType(last, "WFDictionaryContentItem"), "content")) });
  return w;
}

export const SHORTCUTS = [
  { file: "Lumio 收藏.shortcut", build: saveShortcut, icon: { glyph: 59777, color: 4282601983 } },
  { file: "Lumio 问一问.shortcut", build: askShortcut, icon: { glyph: 59766, color: 4271458815 } },
] as const;
