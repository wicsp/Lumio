import { AsyncLocalStorage } from "node:async_hooks";
import { AssistantService, type AssistantContext, type AssistantModel, type AssistantTool } from "@lumio/assistant";
import { AssistantChatRequest } from "@lumio/schema";
import type { SqliteAssistantStore } from "@lumio/storage";
import type { AssistantMainConversations } from "./assistant-main.ts";
import { HubError } from "./errors.ts";
import { workbenchToolSpecs, type WorkbenchTools } from "./workbench-tools.ts";

type ChatOptions = NonNullable<Parameters<AssistantService["chat"]>[2]>;
type NativeContext = NonNullable<AssistantContext["native"]>;
type Context = AssistantContext & { native?: {
  run(input: Parameters<NativeContext["run"]>[0], event?: ChatOptions["event"]): ReturnType<NativeContext["run"]>;
} };
interface WorkbenchChat {
  conversation: string;
  request: string;
  owner: string;
  event?: ChatOptions["event"];
  returnedTools: ReadonlyMap<string, string>;
}

/** Keeps the regular assistant's tool list intact. Only the main conversation uses the workbench tools. */
export class WorkbenchAssistant extends AssistantService {
  private readonly mainChat: AssistantService;
  private readonly scope = new AsyncLocalStorage<WorkbenchChat>();

  constructor(store: SqliteAssistantStore, model: AssistantModel, tools: AssistantTool[], context: Context,
    private readonly main: AssistantMainConversations, workbench: WorkbenchTools) {
    super(store, model, tools, context);
    const { native, resolveModel } = context;
    const workbenchTools = workbenchToolSpecs.map(({ name, description, input_schema }): AssistantTool => ({
      spec: { name, description, input_schema },
      effect: "read",
      execute: (args, tool) => {
        const scope = this.scope.getStore();
        const actor = context.toolActor;
        const turn = scope && store.receipt(scope.owner, scope.request)?.turn;
        if (!scope || scope.owner !== tool.owner || !actor || actor.id !== tool.actor || !turn) {
          throw new HubError("FORBIDDEN", { key: "server.request_not_authorized", args: [] });
        }
        return workbench.execute(name, args, {
          owner: scope.owner, conversation: scope.conversation, turn, tool: tool.request,
          identity: { actor, label: "assistant-tools" }, returnedTools: scope.returnedTools,
          active: () => !tool.signal?.aborted, emit: scope.event,
        });
      },
    }));
    this.mainChat = new AssistantService(store, this.trackResults(model), [...tools, ...workbenchTools], {
      ...context,
      // The shared native adapter is cancelled by the regular service.
      native: native && {
        ...native,
        cancel: undefined,
        run: input => native.run(input, this.scope.getStore()?.event),
      },
      resolveModel: resolveModel && ((profile, owner) => {
        const selection = resolveModel(profile, owner);
        return { ...selection, model: this.trackResults(selection.model) };
      }),
    });
  }

  override chat(input: unknown, owner: string, options: ChatOptions = {}) {
    const parsed = AssistantChatRequest.safeParse(input);
    if (!parsed.success || !parsed.data.conversation || !this.main.isMain(owner, parsed.data.conversation)) {
      return super.chat(input, owner, options);
    }
    const { conversation, request_id } = parsed.data;
    return this.scope.run({ conversation, owner, request: request_id, event: options.event, returnedTools: new Map() },
      () => this.mainChat.chat(parsed.data, owner, options));
  }

  override setModel(model: AssistantModel): void {
    super.setModel(model);
    this.mainChat.setModel(this.trackResults(model));
  }

  override abortTrashed(id: string): void {
    super.abortTrashed(id);
    this.mainChat.abortTrashed(id);
  }

  private trackResults(model: AssistantModel): AssistantModel {
    return {
      complete: (input, options) => {
        const scope = this.scope.getStore();
        if (scope) {
          const returned = new Map<string, string>();
          for (const message of input.messages) {
            if (message.role === "tool" && message.tool_call_id) returned.set(message.tool_call_id, message.content);
          }
          scope.returnedTools = returned;
        }
        return model.complete(input, options);
      },
    };
  }
}
