import { test, expect } from "bun:test";
import { AIConnectionInput, AIUsageBinding, NativeAction, NativeRuntimeCommand, NativeRuntimeMessage, NativeRuntimeView, AssistantChatRequest, AssistantModelResponse } from "../src/index.ts";
const profile = "aip_" + "0".repeat(26);
const binding = { profile, purpose: "assistant", revision: 1, workdir: "managed-session", approval_policy: "on-request", reviewer: "user", sandbox: "workspace-write", command_network: false, tools: [], timeout_seconds: 120 };
test("AI configuration keeps credentials and permissions in separate contracts", () => {
    expect(AIConnectionInput.safeParse({ name: "Codex", kind: "codex-account", host: "hub" }).success).toBe(false);
    expect(AIConnectionInput.safeParse({ name: "Codex", kind: "codex-account", host: "mac", api_key: "synthetic" }).success).toBe(false);
    expect(AIConnectionInput.safeParse({ name: "API", kind: "deepseek", host: "hub", base_url: "https://user:pass@example.test/v1" }).success).toBe(false);
    expect(AIUsageBinding.safeParse(binding).success).toBe(true);
    expect(AIUsageBinding.safeParse({ ...binding, approval_policy: "never" }).success).toBe(false);
});
test("native protocol rejects silent permission expansion and old approval shapes", () => {
    expect(NativeAction.safeParse({ action: "approval", approval: "id", accept: true }).success).toBe(false);
    expect(NativeAction.safeParse({ action: "resolve", resolution: "retry-at-own-risk", note: "" }).success).toBe(false);
    expect(NativeRuntimeMessage.safeParse({ type: "hello", protocol: 2, instance: "test", version: "test", isolation: "macos-seatbelt" }).success).toBe(false);
    expect(NativeRuntimeCommand.safeParse({ type: "turn", command: "test", session: "bad", turn: "bad", message: "x", model: "x", sandbox: "none" }).success).toBe(false);
});
test("reasoning continuation is distinct from display text", () => {
    expect(AssistantModelResponse.parse({ content: "answer", tool_calls: [], continuation: { reasoning_content: "synthetic protocol state", encrypted_content: "synthetic encrypted state" } }).continuation?.encrypted_content).toBe("synthetic encrypted state");
    expect(AssistantChatRequest.safeParse({ request_id: "synthetic-request-1234", message: "x", effort: "low", approval_policy: "never" }).success).toBe(false);
});

test("native login links can only open official HTTPS authentication pages",()=>{
 expect(NativeRuntimeView.safeParse({state:"login_required",models:[],login_url:"https://auth.openai.com/codex/device"}).success).toBe(true);
 for(const login_url of ["javascript:alert(1)","https://chatgpt.com.example.test/login","https://evil.test/login"])expect(NativeRuntimeView.safeParse({state:"login_required",models:[],login_url}).success).toBe(false);
});
