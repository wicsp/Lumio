import type { AIConfiguration, AIProfile, AssistantDefaultBinding, AssistantDefaultBindingUpdate } from "@lumio/schema";
import { newRequestId } from "./commands.ts";

type LegacyStorage = Pick<Storage, "getItem" | "removeItem">;

/** 旧版只存在浏览器里的默认 Profile（ADR 0083 之前），仅用于一次性迁移到 Hub。 */
const legacyKey = (owner: string) => `lumio.assistant.default-profile:${owner}`;

/** 读写账号默认 Profile 所需的接口；测试可传入假实现。 */
export interface AssistantDefaultClient {
  assistantDefault(): Promise<AssistantDefaultBinding | null>;
  setAssistantDefault(input: AssistantDefaultBindingUpdate): Promise<AssistantDefaultBinding | null>;
}

const chatProfile = (profile: AIProfile) => profile.engine === "lumio" || profile.engine === "codex";

/**
 * 账号默认助手 Profile 存在 Hub（ADR 0083）：网页、F18 和后台任务读到的是同一个值。
 * Hub 还没有记录、而这个浏览器留有旧版选择时，把它迁移到 Hub 并清掉本地副本。
 * 返回 Profile ID，没有默认时返回空字符串。
 */
export async function loadAssistantDefault(client: AssistantDefaultClient, config: AIConfiguration, storage?: LegacyStorage): Promise<string> {
  const binding = await client.assistantDefault();
  if (binding) return config.profiles.some(profile => profile.id === binding.profile) ? binding.profile : "";
  const owner = config.profiles[0]?.owner;
  if (!owner) return "";
  let saved: string | null = null;
  let local: LegacyStorage | undefined;
  try { local = storage ?? localStorage; saved = local.getItem(legacyKey(owner)); } catch { return ""; }
  const profile = config.profiles.find(item => item.id === saved && chatProfile(item));
  if (!saved) return "";
  if (!profile) { try { local.removeItem(legacyKey(owner)); } catch { /* 下次再清 */ } return ""; }
  try {
    await client.setAssistantDefault({ request_id: newRequestId("assistant-default"), profile: profile.id });
    try { local.removeItem(legacyKey(owner)); } catch { /* Hub 已有记录，本地副本不再读取 */ }
  } catch { /* 迁移失败时本次仍按旧选择显示，下次再试 */ }
  return profile.id;
}

export function saveAssistantDefault(client: AssistantDefaultClient, profile: string, revision?: number) {
  return client.setAssistantDefault({ request_id: newRequestId("assistant-default"), profile: profile || null,
    ...(revision !== undefined ? { expected_revision: revision } : {}) });
}

/**
 * 主对话可直接调用的 Profile：`lumio` 引擎、连接在 Hub 上并带 API 地址。规则与 Hub 一致（ADR 0083）：
 * 账号默认可用时用它，否则用第一个可用的；都没有时返回 undefined，由 Hub 的旧 API 设置兜底。
 */
export function mainProfile(config: AIConfiguration, defaultProfile?: string): string | undefined {
  const usable = config.profiles.filter(profile => profile.engine === "lumio" &&
    config.connections.some(connection => connection.id === profile.connection && connection.host === "hub" && !!connection.base_url));
  return usable.find(profile => profile.id === defaultProfile)?.id ?? usable[0]?.id;
}

export function assistantProfiles(all: readonly AIProfile[], existing: boolean, nativeProfile?: string): readonly AIProfile[] {
  const profiles = all.filter(profile => profile.engine === "lumio" || profile.engine === "codex");
  if (nativeProfile) return profiles.filter(profile => profile.id === nativeProfile);
  if (existing) return profiles.filter(profile => profile.engine === "lumio");
  return profiles;
}
