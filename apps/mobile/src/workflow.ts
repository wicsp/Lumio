import { createHash } from "node:crypto";
import type { PlistValue } from "./plist.ts";

/**
 * 快捷指令（Shortcuts）文件的构造工具。
 *
 * 快捷指令文件是一个 property list：`WFWorkflowActions` 是动作列表，动作之间用"魔法变量"（上一个动作的输出，按 UUID 引用）传值。
 * 这里只封装 Lumio 用到的动作与参数编码；UUID 由快捷指令名和动作序号算出，同样的输入总是生成同样的文件。
 */

type Aggrandizement = { Type: string; [key: string]: PlistValue };

/** 对一个值的引用：某个动作的输出，或命名变量；可以带"取词典键""取属性"等修饰。 */
export interface Ref {
  readonly kind: "ref";
  readonly value: { [key: string]: PlistValue };
}

const ref = (value: { [key: string]: PlistValue }): Ref => ({ kind: "ref", value });

/** 在引用上加一层修饰（返回新引用）。 */
function aggrandize(base: Ref, item: Aggrandizement): Ref {
  const list = (base.value.Aggrandizements as PlistValue[] | undefined) ?? [];
  return ref({ ...base.value, Aggrandizements: [...list, item] });
}

/** 取词典里的键，支持 `error.message` 这样的点路径。 */
export const key = (base: Ref, name: string) => aggrandize(base, { Type: "WFDictionaryValueVariableAggrandizement", DictionaryKey: name });

/** 当作某种类型使用（例如把文件当作词典读）。 */
export const asType = (base: Ref, type: string) => aggrandize(base, { Type: "WFCoercionVariableAggrandizement", CoercionItemClass: type });

/** 快捷指令收到的输入（例如经 `shortcuts://run-shortcut?...&input=text&text=…` 传入的文字）。 */
export const shortcutInput: Ref = ref({ Type: "ExtensionInput" });

export const variable = (name: string): Ref => ref({ Type: "Variable", VariableName: name });

/** 单个变量参数。 */
export const attach = (value: Ref): PlistValue => ({ Value: value.value, WFSerializationType: "WFTextTokenAttachment" });

/** 文本参数，可以混入变量。 */
export function text(...parts: (string | Ref)[]): PlistValue {
  let string = "";
  const attachments: { [range: string]: PlistValue } = {};
  for (const part of parts) {
    if (typeof part === "string") { string += part; continue; }
    attachments[`{${string.length}, 1}`] = part.value;
    string += "￼";
  }
  if (Object.keys(attachments).length === 0) return string;
  return { Value: { string, attachmentsByRange: attachments }, WFSerializationType: "WFTextTokenString" };
}

const textToken = (...parts: (string | Ref)[]): PlistValue => {
  const value = text(...parts);
  return typeof value === "string" ? { Value: { string: value }, WFSerializationType: "WFTextTokenString" } : value;
};

/** 词典动作与网络请求表单里的一项。 */
export type Field =
  | { type: "text"; value: (string | Ref)[] }
  | { type: "number"; value: number | Ref }
  | { type: "dict"; value: [string, Field][] }
  | { type: "array"; value: Field[] }
  | { type: "file"; value: Ref };

export const f = {
  text: (...value: (string | Ref)[]): Field => ({ type: "text", value }),
  number: (value: number | Ref): Field => ({ type: "number", value }),
  dict: (...value: [string, Field][]): Field => ({ type: "dict", value }),
  array: (...value: Field[]): Field => ({ type: "array", value }),
  file: (value: Ref): Field => ({ type: "file", value }),
};

const ITEM_TYPE = { text: 0, dict: 1, array: 2, number: 3, file: 5 } as const;

function fieldValue(field: Field): PlistValue {
  switch (field.type) {
    case "text": return textToken(...field.value);
    case "number": return textToken(typeof field.value === "number" ? String(field.value) : field.value);
    // Nested Dictionary items wrap the serialized dictionary once more.
    case "dict": return { Value: dictionary(field.value), WFSerializationType: "WFDictionaryFieldValue" };
    case "array": return { Value: field.value.map(item => ({ WFItemType: ITEM_TYPE[item.type], WFValue: fieldValue(item) })), WFSerializationType: "WFArrayParameterState" };
    // The form field state wraps a text-token attachment, not its raw reference.
    case "file": return { Value: attach(field.value), WFSerializationType: "WFTokenAttachmentParameterState" };
  }
}

/** 词典参数（`WFDictionaryFieldValue`）。 */
export function dictionary(items: [string, Field][]): PlistValue {
  return {
    Value: {
      WFDictionaryFieldValueItems: items.map(([name, field]) => ({ WFItemType: ITEM_TYPE[field.type], WFKey: textToken(name), WFValue: fieldValue(field) })),
    },
    WFSerializationType: "WFDictionaryFieldValue",
  };
}

/** If 的条件：100 = 有任何值，101 = 没有任何值。 */
export const HAS_VALUE = 100;
export const HAS_NO_VALUE = 101;

export interface Action {
  WFWorkflowActionIdentifier: string;
  WFWorkflowActionParameters: { [key: string]: PlistValue };
}

export class Workflow {
  readonly actions: Action[] = [];
  private count = 0;

  constructor(readonly name: string) {}

  private uuid(): string {
    const hex = createHash("sha256").update(`lumio-shortcut:${this.name}:${this.count++}`).digest("hex").toUpperCase();
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
  }

  /** 加一个动作；返回它的输出引用。 */
  add(identifier: string, parameters: { [key: string]: PlistValue }, output = "Output"): Ref {
    const id = this.uuid();
    this.actions.push({ WFWorkflowActionIdentifier: `is.workflow.actions.${identifier}`, WFWorkflowActionParameters: { ...parameters, UUID: id } });
    return ref({ Type: "ActionOutput", OutputUUID: id, OutputName: output });
  }

  /** If 块：`then` 里的动作只在条件成立时执行。 */
  when(input: Ref, condition: number, then: () => void, otherwise?: () => void): void {
    const group = this.uuid();
    const flow = (mode: number, extra: { [key: string]: PlistValue } = {}) => {
      const id = this.uuid();
      this.actions.push({
        WFWorkflowActionIdentifier: "is.workflow.actions.conditional",
        WFWorkflowActionParameters: { GroupingIdentifier: group, WFControlFlowMode: mode, UUID: id, ...extra },
      });
    };
    flow(0, { WFCondition: condition, WFInput: { Type: "Variable", Variable: attach(input) } });
    then();
    if (otherwise) { flow(1); otherwise(); }
    flow(2);
  }

  toPlist(options: { glyph: number; color: number }): PlistValue {
    return {
      WFQuickActionSurfaces: [],
      WFWorkflowActions: this.actions as unknown as PlistValue[],
      WFWorkflowClientVersion: "2607.0.2",
      WFWorkflowHasOutputFallback: false,
      WFWorkflowHasShortcutInputVariables: true,
      WFWorkflowIcon: { WFWorkflowIconGlyphNumber: options.glyph, WFWorkflowIconStartColor: options.color },
      WFWorkflowImportQuestions: [],
      WFWorkflowInputContentItemClasses: ["WFStringContentItem"],
      WFWorkflowMinimumClientVersion: 900,
      WFWorkflowMinimumClientVersionString: "900",
      WFWorkflowName: this.name,
      WFWorkflowOutputContentItemClasses: [],
      WFWorkflowTypes: [],
    };
  }
}
