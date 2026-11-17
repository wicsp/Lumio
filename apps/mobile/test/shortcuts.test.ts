import { describe, expect, test } from "bun:test";
import { AssistantChatRequest, CaptureCreate, ClientJoinRequest, GLANCE_LIMITS, GlanceCreate, RequestId } from "@lumio/schema";
import { toPlist } from "../src/plist.ts";
import { askShortcut, saveShortcut, CONFIG_PATH, PAIR_SHORTCUT_NAME } from "../src/shortcuts.ts";
import type { Action, Workflow } from "../src/workflow.ts";

/**
 * 用一个最小的解释器"运行"生成的快捷指令：按动作顺序求值魔法变量，模拟 Hub 的响应，
 * 收集发出的请求，再用 @lumio/schema 校验请求体。用来保证参数编码（变量、词典、表单）拼出的就是契约要的内容。
 */

type Value = unknown;
interface Request { url: string; type: string; body: Record<string, Value> }

const IDS = {
  glance: "gln_01ARZ3NDEKTSV4RRFFQ69G5FAV",
  capture: "cap_01ARZ3NDEKTSV4RRFFQ69G5FAV",
  conversation: "conv_01ARZ3NDEKTSV4RRFFQ69G5FAV",
  turn: "turn_01ARZ3NDEKTSV4RRFFQ69G5FAV",
};

class Exit extends Error {}

function run(workflow: Workflow, options: { ocr?: string; config?: boolean; fail?: string; input?: string } = {}) {
  const outputs = new Map<string, Value>();
  const requests: Request[] = [];
  const shown: string[] = [];
  const notifications: string[] = [];
  const saved: { path: string; content: Value }[] = [];
  const env = { hub: "http://hub.test:7420", token: "tok_synthetic" };

  const resolve = (ref: Record<string, Value>): Value => {
    let value = ref.Type === "ActionOutput" ? outputs.get(ref.OutputUUID as string) : ref.Type === "ExtensionInput" ? options.input : undefined;
    for (const agg of (ref.Aggrandizements as Record<string, string>[] | undefined) ?? []) {
      if (agg.Type === "WFDictionaryValueVariableAggrandizement")
        for (const part of agg.DictionaryKey!.split(".")) value = (value as Record<string, Value> | undefined)?.[part];
    }
    return value;
  };
  const str = (value: Value) => (typeof value === "object" && value !== null ? JSON.stringify(value) : value === undefined ? "" : String(value));
  const evalText = (param: Value): string => {
    if (typeof param === "string") return param;
    const p = param as { Value: Record<string, Value>; WFSerializationType: string };
    if (p.WFSerializationType === "WFTextTokenAttachment") return str(resolve(p.Value));
    const { string, attachmentsByRange = {} } = p.Value as { string: string; attachmentsByRange?: Record<string, Record<string, Value>> };
    let out = "";
    [...string].forEach((char, i) => {
      const at = attachmentsByRange[`{${string.slice(0, 0).length + [...string].slice(0, i).join("").length}, 1}`];
      out += char === "￼" && at ? str(resolve(at)) : char;
    });
    return out;
  };
  const evalItem = (item: { WFItemType: number; WFValue: Value }): Value => {
    switch (item.WFItemType) {
      case 0: return evalText(item.WFValue);
      case 1: return evalDict(item.WFValue);
      case 2: return ((item.WFValue as { Value: { WFItemType: number; WFValue: Value }[] }).Value).map(evalItem);
      case 3: { const text = evalText(item.WFValue); return Number(text); }
      case 5: return { file: resolve((item.WFValue as { Value: Record<string, Value> }).Value) };
      default: throw new Error(`未知类型 ${item.WFItemType}`);
    }
  };
  const evalDict = (param: Value): Record<string, Value> => {
    const items = (param as { Value: { WFDictionaryFieldValueItems: { WFItemType: number; WFKey: Value; WFValue: Value }[] } }).Value.WFDictionaryFieldValueItems;
    return Object.fromEntries(items.map(item => [evalText(item.WFKey), evalItem(item)]));
  };
  const attachValue = (param: Value) => resolve((param as { Value: Record<string, Value> }).Value);

  const respond = (path: string): Value => {
    if (options.fail === path) return { error: { message: "合成错误" } };
    if (path === "/v2/glances") return { id: IDS.glance };
    if (path === "/v2/inbox/captures") return { capture: { id: IDS.capture } };
    if (path === "/v2/assistant/main") return { conversation: IDS.conversation };
    if (path === "/v2/assistant/chat") return { turn: { id: IDS.turn }, messages: [{ role: "user", content: "问" }, { role: "assistant", content: "合成回答" }] };
    if (path === "/v2/setup/client/join") return { actor: "act_01ARZ3NDEKTSV4RRFFQ69G5FAV", token: env.token };
    throw new Error(`未模拟的路径 ${path}`);
  };

  const actions = workflow.actions;
  const executed: string[] = [];
  // 预先建立 If 块的跳转表。
  const groups = new Map<string, number[]>();
  actions.forEach((action, i) => {
    if (action.WFWorkflowActionIdentifier.endsWith("conditional")) {
      const g = action.WFWorkflowActionParameters.GroupingIdentifier as string;
      groups.set(g, [...(groups.get(g) ?? []), i]);
    }
  });
  let last: Value;
  const branchResult = new Map<string, Value>();
  const step = (action: Action, i: number): number => {
    const p = action.WFWorkflowActionParameters as Record<string, Value>;
    const id = p.UUID as string;
    const kind = action.WFWorkflowActionIdentifier.replace("is.workflow.actions.", "");
    executed.push(kind);
    let out: Value;
    switch (kind) {
      case "conditional": {
        const group = groups.get(p.GroupingIdentifier as string)!;
        const mode = p.WFControlFlowMode as number;
        if (mode === 0) {
          const input = attachValue((p.WFInput as { Variable: Value }).Variable);
          const has = input !== undefined && input !== "" && !(Array.isArray(input) && input.length === 0);
          const pass = p.WFCondition === 100 ? has : !has;
          if (pass) return i + 1;
          return group.length === 3 ? group[1]! + 1 : group[group.length - 1]!;
        }
        if (mode === 1) { branchResult.set(p.GroupingIdentifier as string, last); return group[2]!; }
        out = branchResult.has(p.GroupingIdentifier as string) ? branchResult.get(p.GroupingIdentifier as string) : last;
        break;
      }
      case "takescreenshot": case "image.resize": case "image.convert": out = { image: "jpeg" }; break;
      case "properties.images": out = p.WFContentItemPropertyName === "Width" ? 944 : 2046; break;
      case "extracttextfromimage": out = options.ocr ?? "合成屏幕文字"; break;
      case "text.match": {
        const source = evalText(p.text);
        out = source.match(new RegExp(p.WFMatchTextPattern as string, "g")) ?? [];
        break;
      }
      case "getitemfromlist": { const list = attachValue(p.WFInput) as Value[]; out = p.WFItemSpecifier === "First Item" ? list[0] : list.at(-1); break; }
      case "date": out = "now"; break;
      case "format.date": out = p.WFDateFormatStyle === "Custom" ? "20261117112000123" : "2026-11-17T11:20:00+08:00"; break;
      case "number.random": out = 482913; break;
      case "gettext": out = evalText(p.WFTextActionText); break;
      case "documentpicker.open": out = options.config === false ? undefined : JSON.stringify(env); break;
      case "detect.dictionary": out = JSON.parse(attachValue(p.WFInput) as string); break;
      case "dictatetext": out = "这段是什么意思"; break;
      case "dictionary": out = evalDict(p.WFItems); break;
      case "ask": out = p.WFInputType === "URL" ? `${env.hub}//` : "abcdefghijklmnopqrstuvwxyz234567"; break;
      case "text.replace": out = evalText(p.WFInput).replace(new RegExp(p.WFReplaceTextFind as string), p.WFReplaceTextReplace as string); break;
      case "setitemname": out = attachValue(p.WFInput); break;
      case "documentpicker.save": saved.push({ path: p.WFFileDestinationPath as string, content: attachValue(p.WFInput) }); break;
      case "getvalueforkey": out = (attachValue(p.WFInput) as Record<string, Value>)[p.WFDictionaryKey as string]; break;
      case "notification": notifications.push(`${p.WFNotificationActionTitle}: ${evalText(p.WFNotificationActionBody)}`); break;
      case "showresult": shown.push(evalText(p.Text)); break;
      case "vibrate": break;
      case "exit": throw new Exit();
      case "downloadurl": {
        const url = evalText(p.WFURL);
        const body = p.WFHTTPBodyType === "Form" ? evalDict(p.WFFormValues) : evalDict(p.WFJSONValues);
        const headers = evalDict(p.WFHTTPHeaders);
        if (!url.endsWith("/v2/setup/client/join")) expect(headers.Authorization).toBe(`Bearer ${env.token}`);
        requests.push({ url, type: p.WFHTTPBodyType as string, body });
        out = respond(new URL(url).pathname);
        break;
      }
      default: throw new Error(`解释器不认识动作 ${kind}`);
    }
    outputs.set(id, out);
    if (kind !== "conditional") last = out;
    return i + 1;
  };
  try {
    for (let i = 0; i < actions.length;) i = step(actions[i]!, i);
  } catch (error) {
    if (!(error instanceof Exit)) throw error;
  }
  return { requests, shown, notifications, saved, executed };
}

function checkGlance(request: Request) {
  expect(request.url).toBe("http://hub.test:7420/v2/glances");
  expect(request.type).toBe("Form");
  expect(Object.keys(request.body).sort()).toEqual(["image", "meta"]);
  const meta = GlanceCreate.parse(JSON.parse(request.body.meta as string));
  expect(meta.image).toEqual({ format: "jpeg", width: 944, height: 2046 });
  expect(meta.app.name).toBe("iPhone");
  return meta;
}

describe("iPhone 快捷指令", () => {
  test("收藏：上传所见后用它建捕获", () => {
    const { requests, notifications } = run(saveShortcut());
    expect(requests.map(r => new URL(r.url).pathname)).toEqual(["/v2/glances", "/v2/inbox/captures"]);
    const meta = checkGlance(requests[0]!);
    expect(meta.ocr).toEqual([{ text: "合成屏幕文字", box: { x: 0, y: 0, w: 944, h: 2046 } }]);
    expect(meta.ocr_engine).toBe("ios-vision@1");
    const capture = CaptureCreate.parse(requests[1]!.body);
    expect(capture).toMatchObject({ channel: "share", glance: IDS.glance });
    expect(capture.request_id).not.toBe(meta.request_id);
    expect(notifications).toEqual(["已收藏: 已存入 Lumio"]);
  });

  test("屏幕上没有文字时不带识字块", () => {
    const { requests } = run(saveShortcut(), { ocr: "" });
    const meta = checkGlance(requests[0]!);
    expect(meta.ocr).toEqual([]);
    expect(meta.ocr_engine).toBeUndefined();
  });

  test("长屏幕文字截断在单块上限内", () => {
    const { requests } = run(saveShortcut(), { ocr: "长".repeat(12_000) });
    const meta = checkGlance(requests[0]!);
    expect(meta.ocr[0]!.text.length).toBeLessThanOrEqual(5000);
    expect(meta.ocr[0]!.text.length).toBeLessThanOrEqual(GLANCE_LIMITS.max_ocr_chars);
  });

  test("问一问：所见、主对话、聊天依次发出，显示助手回复", () => {
    const { requests, shown } = run(askShortcut());
    expect(requests.map(r => new URL(r.url).pathname)).toEqual(["/v2/glances", "/v2/assistant/main", "/v2/assistant/chat"]);
    checkGlance(requests[0]!);
    RequestId.parse(requests[1]!.body.request_id);
    const chat = AssistantChatRequest.parse(requests[2]!.body);
    expect(chat).toMatchObject({ conversation: IDS.conversation, glance: IDS.glance, message: "这段是什么意思" });
    expect(new Set(requests.map(r => (r.type === "Form" ? JSON.parse(r.body.meta as string) : r.body).request_id)).size).toBe(3);
    expect(shown).toEqual(["合成回答"]);
  });

  test("Hub 返回错误时提示并停下", () => {
    const { requests, notifications } = run(saveShortcut(), { fail: "/v2/glances" });
    expect(requests).toHaveLength(1);
    expect(notifications).toEqual(["Lumio 失败: 合成错误"]);
  });

  test("没有配对时提示先配对，不发请求", () => {
    const { requests, notifications } = run(askShortcut(), { config: false });
    expect(requests).toEqual([]);
    expect(notifications[0]).toContain("扫一下");
  });

  test("扫码配对：用输入里的地址和配对码换取令牌、保存后结束，不截屏", () => {
    for (const shortcut of [saveShortcut(), askShortcut()]) {
      const input = JSON.stringify({ hub: "http://hub.test:7420//", code: "abcdefghijklmnopqrstuvwxyz234567" });
      const { requests, saved, notifications, executed } = run(shortcut, { input });
      expect(requests).toHaveLength(1);
      expect(requests[0]!.url).toBe("http://hub.test:7420/v2/setup/client/join");
      ClientJoinRequest.parse(requests[0]!.body);
      expect(saved).toEqual([{ path: CONFIG_PATH, content: JSON.stringify({ hub: "http://hub.test:7420", token: "tok_synthetic" }) }]);
      expect(notifications).toEqual(["Lumio 已配对: http://hub.test:7420"]);
      expect(executed).not.toContain("takescreenshot");
    }
  });

  test("配对码无效时提示 Hub 的错误", () => {
    const { saved, notifications } = run(saveShortcut(), { input: JSON.stringify({ hub: "http://hub.test:7420", code: "x" }), fail: "/v2/setup/client/join" });
    expect(saved).toEqual([]);
    expect(notifications).toEqual(["Lumio 失败: 合成错误"]);
  });

  test("二维码按名字启动的是收藏", () => {
    expect(saveShortcut().name).toBe(PAIR_SHORTCUT_NAME);
  });

  test("生成的文件是确定的 plist", () => {
    const a = toPlist(saveShortcut().toPlist({ glyph: 1, color: 1 }));
    expect(a).toBe(toPlist(saveShortcut().toPlist({ glyph: 1, color: 1 })));
    expect(a.startsWith("<?xml")).toBe(true);
    expect(a).toContain("is.workflow.actions.takescreenshot");
  });

  test("没有输入时截屏是第一个可见动作，避免截到快捷指令自己的界面", () => {
    for (const w of [saveShortcut(), askShortcut()]) {
      const { executed } = run(w);
      expect(executed.filter(kind => kind !== "conditional")[0]).toBe("takescreenshot");
    }
  });
});
