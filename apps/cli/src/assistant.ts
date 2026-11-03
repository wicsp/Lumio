import { language } from "@lumio/platform";
import { text as msg } from "./messages.ts";
import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { createClient } from "@lumio/api-client";
import { AssistantMemoryCommandRequest } from "@lumio/schema";
import { hubCredentials } from "./config.ts";

export async function runAssistant(args: string[], log: (line: string) => void): Promise<number> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, strict: true, options: {
    sources: { type: "string" }, json: { type: "boolean" }, stream: { type: "boolean" }, conversation: { type: "string" }, model: { type: "string" }, "request-id": { type: "string" },
  } });
  const client = createClient({ ...hubCredentials(), language: language() });
  if (positionals[0] === "memory") {
    const [, action, ...text] = positionals;
    const emit = (value: unknown) => log(values.json ? JSON.stringify(value) : JSON.stringify(value, null, 2));
    if (action === "list" && !text.length) { emit(await client.memories()); return 0; }
    if ((action === "remember" && text.length) || (action === "forget" && text.length === 1)) {
      const input = AssistantMemoryCommandRequest.parse({ request_id: values["request-id"] ?? randomUUID(), operation: {
        op: `assistant.memory.${action}`, args: action === "remember" ? { content: text.join(" "), ...(values.sources ? { sources: JSON.parse(values.sources) } : {}) } : { memory: text[0] },
      } });
      emit(await client.memoryCommand(input)); return 0;
    }
    throw new Error(msg("assistant.usage_lumio_chat_memory_list_remember_content_forget_memory_id_json"));
  }
  if (positionals[0] === "list" && positionals.length === 1) {
    const conversations = await client.conversations();
    if (values.json) log(JSON.stringify(conversations)); else for (const conversation of conversations) log(`${conversation.id}  ${conversation.title}`);
    return 0;
  }
  if (positionals[0] === "show" && positionals.length === 2) {
    const detail = await client.conversation(positionals[1]!);
    if (values.json) log(JSON.stringify(detail)); else for (const message of detail.messages) log(`${message.role}: ${message.content}`);
    return 0;
  }
  const message = positionals.join(" ").trim();
  if (!message) throw new Error(msg("assistant.usage_lumio_chat_message_conversation_id_model_model_json_stream_lum"));
  const input = { request_id: values["request-id"] ?? randomUUID(), conversation: values.conversation, model: values.model, message };
  if (values.stream) {
    let successful = false;
    for await (const event of client.assistantEvents(input)) { log(JSON.stringify(event)); if (event.type === "result") successful = true; }
    return successful ? 0 : 1;
  }
  const result = await client.assistantChat(input);
  if (values.json) log(JSON.stringify(result));
  else {
    log(result.messages.filter((value) => value.role === "assistant").at(-1)?.content ?? result.turn.error ?? msg("assistant.no_reply_produced_in_this_turn"));
    log(msg("assistant.conversation_turn", result.conversation.id, result.turn.id, result.turn.status));
  }
  return result.turn.status === "done" ? 0 : 1;
}
