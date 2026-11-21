import type { Actor } from "@lumio/schema";
import type { Client } from "./api.ts";
import { formatTime } from "./commands.ts";
import { h } from "./dom.ts";
import { t } from "./i18n.ts";

const actorsByClient = new WeakMap<Client, { until: number; actors: Promise<Map<string, Actor>> }>();

export const unknownObject = (id: string): string => t("Unknown object {0}", id);

export function proposalActor(client: Client, id: string): Promise<Actor | undefined> {
  let entry = actorsByClient.get(client);
  if (!entry || entry.until <= Date.now()) {
    const actors = client.actors().then(list => new Map(list.map(actor => [actor.id, actor])), () => {
      if (actorsByClient.get(client)?.actors === actors) actorsByClient.delete(client);
      return new Map<string, Actor>();
    });
    entry = { until: Date.now() + 15_000, actors };
    actorsByClient.set(client, entry);
  }
  return entry.actors.then(actors => actors.get(id));
}

export function actorLabel(actor: Actor): string {
  if (actor.name.startsWith("work-system-")) return "Lumio";
  return actor.role === "human" ? t("{0} (person)", actor.name) : actor.name;
}

export function proposalTime(iso: string, className?: string): HTMLElement {
  return h("time", { datetime: iso, title: iso, class: className }, formatTime(iso));
}

export function proposalProject(client: Client, id: string): HTMLElement {
  const name = h("span", { title: id }, unknownObject(id));
  void client.workProject(id).then(project => { name.textContent = project.title; }, () => {});
  return name;
}
