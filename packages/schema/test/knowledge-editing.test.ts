import { test, expect } from "bun:test";
import { KnowledgeUpdateRequest, KnowledgeReferencesRequest, KnowledgeRelatedResult } from "../src/index.ts";
test("editing contracts reject stale-format revisions, unknown metadata and ambiguous reference sources", () => {
    const valid = { request_id: "edit-test-00000001", expected_revision: "a".repeat(64), title: "Note", body: "" };
    expect(KnowledgeUpdateRequest.parse(valid)).toEqual(valid);
    for (const patch of [{ id: "spoof" }, { expected_revision: "today" }, { title: " " }, { body: "x".repeat(500001) }])
        expect(KnowledgeUpdateRequest.safeParse({ ...valid, ...patch }).success).toBe(false);
    expect(KnowledgeReferencesRequest.safeParse({ source_kind: "idea", query: "" }).success).toBe(false);
    expect(KnowledgeReferencesRequest.parse({ source_kind: "idea", query: "X" }).query).toBe("X");
    expect(KnowledgeRelatedResult.safeParse({ method: "semantic", hits: [] }).success).toBe(false);
});
