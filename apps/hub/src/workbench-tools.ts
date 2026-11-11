import {
  AssistantEvent, ID_PREFIXES, MODULE_ID_PREFIXES, WorkbenchAction, WorkbenchSearchResult, toolName,
  type ResourceRef, type WorkbenchSection,
} from "@lumio/schema";
import type { SqliteAssistantStore } from "@lumio/storage";
import type { AssistantMainConversations } from "./assistant-main.ts";
import { HubError } from "./errors.ts";
import type { Resources } from "./resources.ts";
import type { Identity } from "./store.ts";

const descriptions = {
  navigate: "Navigate the user's workbench to a section or a visible object in that section.",
  highlight: "Highlight visible objects on the user's current page.",
  show: "Open a workbench panel with visible objects, a project's dependency graph, or search cards returned by a tool this turn.",
  clear: "Close the workbench panel and clear highlights.",
} satisfies Record<WorkbenchAction["action"], string>;

const [navigate, highlight, show, clear] = WorkbenchAction.options;
const toolArgs = {
  navigate: navigate.omit({ action: true }),
  highlight: highlight.omit({ action: true }),
  show: show.omit({ action: true }),
  clear: clear.omit({ action: true }),
};

export const workbenchToolSpecs = WorkbenchAction.options.map(action => {
  const operation = action.shape.action.value;
  return {
    operation,
    name: toolName(`ui.${operation}`),
    description: descriptions[operation],
    input_schema: toolArgs[operation].toJSONSchema(),
  };
});

const navigationTargets = {
  overview: [],
  knowledge: MODULE_ID_PREFIXES.knowledge,
  work: [ID_PREFIXES.task, ID_PREFIXES.project],
  execution: [ID_PREFIXES.job],
  assistant: [ID_PREFIXES.conversation],
  approvals: [],
  inbox: [],
} satisfies Record<WorkbenchSection, readonly string[]>;

type Stream = (event: AssistantEvent) => void;
interface ActionContext {
  owner: string;
  conversation: string;
  turn: string;
  tool: string;
  identity: Identity;
  returnedTools: ReadonlyMap<string, string>;
  active: () => boolean;
  emit?: Stream;
}

const unavailable = () => new HubError("CONFLICT", { key: "workbench.stream_unavailable", args: [] });
const invalid = () => new HubError("INVALID", { key: "workbench.invalid_action", args: [] });
const idOnly = ({ id, module }: ResourceRef): ResourceRef => ({ id, module });

function actionRefs(action: WorkbenchAction): ResourceRef[] {
  switch (action.action) {
    case "navigate": {
      if (!action.target) return [];
      const { id } = action.target;
      const allowed: readonly string[] = navigationTargets[action.section];
      if (!allowed.includes(id.slice(0, id.indexOf("_")))) throw invalid();
      action.target = idOnly(action.target);
      return [action.target];
    }
    case "highlight":
      action.refs = action.refs.map(idOnly);
      return action.refs;
    case "show":
      if (action.panel.kind === "refs") {
        action.panel.refs = action.panel.refs.map(idOnly);
        return action.panel.refs;
      }
      if (action.panel.kind === "dependency_graph") {
        action.panel.project = idOnly(action.panel.project);
        return [action.panel.project];
      }
      return [];
    case "clear":
      return [];
  }
}

export function workbenchSearchCards(value: unknown): WorkbenchSearchResult[] {
  // Read only structured cards at the result boundary. Tool text cannot supply cards.
  const results = value && typeof value === "object" && "results" in value ? value.results : value;
  if (!Array.isArray(results)) return [];
  return results.flatMap(candidate => {
    const parsed = WorkbenchSearchResult.safeParse(candidate);
    return parsed.success ? [parsed.data] : [];
  });
}

function searchCards(content: string): WorkbenchSearchResult[] {
  try { return workbenchSearchCards(JSON.parse(content)); } catch { return []; }
}

export class WorkbenchTools {
  constructor(private readonly main: AssistantMainConversations, private readonly assistant: SqliteAssistantStore,
    private readonly resources: Resources) {}

  async execute(name: string, args: Record<string, unknown>, context: ActionContext): Promise<{ displayed: true }> {
    const spec = workbenchToolSpecs.find(spec => spec.name === name);
    if (!spec) throw invalid();
    const parsed = WorkbenchAction.safeParse({ action: spec.operation, ...args });
    if (!parsed.success || "action" in args) throw invalid();
    const action = parsed.data;
    const { owner, conversation, turn, tool, identity, emit } = context;
    const available = () => context.active() && this.main.isMain(owner, conversation)
      && this.assistant.turn(turn)?.status === "running";
    const call = this.assistant.call(tool);
    if (identity.actor.role !== "agent" || !this.main.isMain(owner, conversation)
      || this.assistant.turn(turn)?.conversation !== conversation || call?.turn !== turn || call.name !== name || call.status !== "running") {
      throw new HubError("FORBIDDEN", { key: "server.request_not_authorized", args: [] });
    }
    if (!emit || !available()) throw unavailable();
    for (const ref of actionRefs(action)) {
      // Display always uses the tool agent's access. The chat's private-read exception does not apply.
      if ((await this.resources.resolve(ref.id, identity)).status !== "visible") {
        throw new HubError("FORBIDDEN", { key: "workbench.resource_unavailable", args: [] });
      }
    }
    if (action.action === "show" && action.panel.kind === "search") {
      const returned = [...context.returnedTools].flatMap(([id, content]) => {
        const source = this.assistant.call(id);
        return source?.turn === turn && source.status === "succeeded" && !source.private_read ? searchCards(content) : [];
      });
      if (!action.panel.results.every(card => returned.some(value =>
        card.url === value.url && card.title === value.title && (card.snippet === undefined || card.snippet === value.snippet)))) {
        throw new HubError("FORBIDDEN", { key: "workbench.search_result_unavailable", args: [] });
      }
    }
    if (!available()) throw unavailable();
    const event = AssistantEvent.parse({ type: "ui", turn, tool, action });
    try { emit(event); } catch { throw unavailable(); }
    return { displayed: true };
  }
}
