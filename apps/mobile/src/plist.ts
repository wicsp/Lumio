/** 最小的 XML property list 序列化，只覆盖快捷指令文件用到的类型。 */

export type PlistValue = string | number | boolean | PlistValue[] | { [key: string]: PlistValue };

const escape = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function write(value: PlistValue, indent: string): string {
  if (typeof value === "string") return `${indent}<string>${escape(value)}</string>`;
  if (typeof value === "boolean") return `${indent}<${value}/>`;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("plist 不支持非有限数字");
    return Number.isInteger(value) ? `${indent}<integer>${value}</integer>` : `${indent}<real>${value}</real>`;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return `${indent}<array/>`;
    return [`${indent}<array>`, ...value.map(item => write(item, `${indent}\t`)), `${indent}</array>`].join("\n");
  }
  const keys = Object.keys(value);
  if (keys.length === 0) return `${indent}<dict/>`;
  const lines = [`${indent}<dict>`];
  for (const key of keys) {
    lines.push(`${indent}\t<key>${escape(key)}</key>`, write(value[key]!, `${indent}\t`));
  }
  lines.push(`${indent}</dict>`);
  return lines.join("\n");
}

export function toPlist(value: PlistValue): string {
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">`,
    `<plist version="1.0">`,
    write(value, ""),
    `</plist>`,
    "",
  ].join("\n");
}
