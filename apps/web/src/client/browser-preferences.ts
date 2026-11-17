/**
 * 浏览器本地的枚举偏好。用稳定的键和值保存各项选择，文案可以独立重命名。
 * 旧版遇到新版选项时回到默认值，并保留原值，升级回来仍能恢复选择。
 * Hub 管理的功能、权限和设备设置应继续通过对应 API 读写。
 */
type Option = { value: string; label: string };
type ChoiceStorage = Pick<Storage, "getItem" | "setItem">;

export function browserChoice<const Options extends readonly Option[]>(
  definition: { key: string; label: string; options: Options; fallback: NoInfer<Options[number]["value"]> },
  storage: () => ChoiceStorage | undefined = () => globalThis.localStorage,
  events: EventTarget | undefined = globalThis.window,
) {
  type Value = Options[number]["value"];
  const { key, options, fallback } = definition;
  const listeners = new Set<(value: Value) => void>();
  const option = (value: string | null | undefined) => options.find(item => item.value === value);
  function read(): Value {
    try { return option(storage()?.getItem(key))?.value ?? fallback; }
    catch { return fallback; }
  }
  let current: Value = fallback;
  let unsaved = false;

  function publish(value: Value): void {
    if (value === current) return;
    current = value;
    for (const listener of listeners) listener(value);
  }

  function sync(event: Event): void {
    const change = event as StorageEvent;
    if (change.key !== key && change.key !== null) return;
    try { if (change.storageArea !== storage()) return; }
    catch { return; }
    unsaved = false;
    publish(read());
  }

  return {
    label: definition.label,
    options,
    /** 存储受限时仍应用到当前页面，返回 false 便于设置页提示。 */
    choose(value: string): boolean {
      const selected = option(value);
      if (!selected) return false;
      let saved = false;
      try {
        const local = storage();
        if (local) {
          local.setItem(key, selected.value);
          saved = true;
        }
      } catch { /* 当前页面仍应用所选值 */ }
      unsaved = !saved;
      publish(selected.value);
      return saved;
    },
    subscribe(listener: (value: Value) => void): () => void {
      if (!listeners.size) {
        if (!unsaved) current = read();
        events?.addEventListener("storage", sync);
      }
      listeners.add(listener);
      listener(current);
      return () => {
        listeners.delete(listener);
        if (!listeners.size) events?.removeEventListener("storage", sync);
      };
    },
  };
}

export const sidebarUsageStyle = browserChoice({
  key: "lumio.web.sidebar-usage-style",
  label: "Collapsed sidebar usage style",
  options: [{ value: "bars", label: "Bars" }, { value: "arcs", label: "Arcs" }],
  fallback: "bars",
});
