import { StoredArtifact } from "@lumio/schema";
import { StorageError } from "@lumio/storage";
import type { BusinessModules } from "./modules.ts";
import type { HubStore, Identity } from "./store.ts";
import { Jobs } from "./jobs.ts";
import { HubError } from "./errors.ts";

/** Called only after the shared route policy has allowed this explicit identity. */
export async function handleArtifacts(request: Request, identity: Identity, store: HubStore, modules: BusinessModules): Promise<Response> {
  const url = new URL(request.url), path = url.pathname;
  try {
    const privateValue = url.searchParams.get("include_private"), includePrivate = privateValue === "true";
    if (privateValue !== null && !["true", "false"].includes(privateValue)) throw new HubError("INVALID", { key: "server.include_private_must_be_true_or_false", args: [] });
    const jobMatch = /^\/v2\/execution\/jobs\/(job_[0-9A-HJKMNP-TV-Z]{26})\/artifacts$/.exec(path);
    if (jobMatch) {
      new Jobs(store).get(jobMatch[1]!);
      return Response.json(StoredArtifact.array().parse(modules.artifacts.list({ module: "execution", id: jobMatch[1]! }).filter((value) => !value.private || includePrivate)));
    }
    let artifact: StoredArtifact;
    if (request.method === "POST") {
      let body: unknown; try { body = await request.json(); } catch { throw new HubError("INVALID", { key: "artifacts.file_registration_must_be_json", args: [] }); }
      const parsed = StoredArtifact.safeParse(body);
      if (!parsed.success) throw new HubError("INVALID", { key: "artifacts.invalid_file_registration_format", args: [] });
      artifact = parsed.data;
    } else {
      const id = /^\/v2\/execution\/artifacts\/(art_[0-9A-HJKMNP-TV-Z]{26})(?:\/content)?$/.exec(path)?.[1];
      if (!id) throw new HubError("NOT_FOUND", { key: "artifacts.file_endpoint_not_found", args: [] });
      artifact = modules.artifacts.get(id);
    }
    if (artifact.owner.module !== "execution" || !artifact.owner.id.startsWith("job_")) throw new HubError("INVALID", { key: "artifacts.execution_archives_must_belong_to_a_job", args: [] });
    const job = new Jobs(store).get(artifact.owner.id);
    if (request.method === "POST" || request.method === "PUT") {
      if (identity.actor.role !== "runtime" || job.spec.runtime !== identity.actor.id || !job.assigned) throw new HubError("FORBIDDEN", { key: "artifacts.runtime_cannot_upload_execution_files_owned_by_another_runtime", args: [] });
      if (request.method === "POST") return Response.json(modules.artifacts.stage(artifact));
      if (!request.body) throw new HubError("INVALID", { key: "artifacts.file_content_is_missing", args: [] });
      const reader = request.body.getReader();
      async function* body() { try { while (true) { const chunk = await reader.read(); if (chunk.done) return; yield chunk.value; } } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); } }
      return Response.json(await modules.artifacts.publish(artifact.id, body()));
    }
    if (artifact.private && !includePrivate) throw new HubError("NOT_FOUND", { key: "artifacts.file_not_found_or_private_content_was_not_explicitly_requested", args: [] });
    if (path.endsWith("/content")) {
      const file = await modules.artifacts.path(artifact.id);
      return new Response(Bun.file(file), { headers: { "Content-Type": artifact.media_type, "Cache-Control": "no-store", "Content-Disposition": `attachment; filename="${artifact.id}.bin"`, "X-Content-Type-Options": "nosniff" } });
    }
    return Response.json(StoredArtifact.parse(artifact));
  } catch (cause) {
    if (cause instanceof StorageError) throw new HubError(cause.code === "CORRUPT" ? "INTERNAL" : cause.code, cause.params);
    throw cause;
  }
}
