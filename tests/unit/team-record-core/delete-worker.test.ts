import { describe, expect, it } from "vitest";
import { recordDerivationKey, recordFactKey, teamRecordSourceHash, AuditEventInputSchema } from "@agentx/contracts";
import { DELETE_BACKLOG_SECONDS, DEFAULT_DELETE_BUDGET, runDeleteWorker } from "../../../packages/broker/src/team-record/delete-worker.js";
import { listScopeWork, getRecordFact } from "../../../packages/broker/src/team-record/store.js";
import { createRecordSink } from "../../../packages/broker/src/team-record/sink.js";
import { ORG_A, ORG_B, GITHUB_SCOPE, addSource, get, githubDraft, rows, world } from "../../support/team-record-core.js";
import { FACT_A, FACT_B, addFact, deleteDeps, eventsOf, idsOf, seedComments } from "../../support/team-record-delete.js";

const HOUR = 3_600_000;
const lessonOf = (id: string, sourceEvents: string[], extra: Record<string, unknown> = {}) => ({ id, version: 1, status: "active", citations: [], provenance: { sourceEvents }, counters: { citationStale: 0 }, ...extra });
const codeCitation = { kind: "code" as const, repo: "acme/api", path: "src/a.ts", startLine: 1, endLine: 2, anchor: "x", commit: "abc1234" };

describe("delete worker: a source deleted something", () => {
  it("removes the row, its vector, the derived facts, queues the lake and settles lessons, in the privacy order", async () => {
    const w = world();
    await seedComments(w);
    const d = deleteDeps(w);
    const ids = Object.fromEntries(eventsOf(w).map((event) => [event.sourceRef.id, event.id]));
    await addFact(w, FACT_A, [{ system: "github.com", sourceId: "c-1" }]);                                          // only from the deleted item
    await addFact(w, FACT_B, [{ system: "github.com", sourceId: "c-1" }, { system: "github.com", sourceId: "c-3" }]); // c-3 stays
    d.lessons.list.push(lessonOf("les_only", [ids["c-1"]!]), lessonOf("les_coded", [ids["c-1"]!], { citations: [codeCitation], lastValidatedAt: "2026-10-30T10:00:00.000Z" }), lessonOf("les_mixed", [ids["c-1"]!, ids["c-3"]!]), lessonOf("les_other", [ids["c-3"]!]));
    await w.sink.tombstone({ workspaceId: ORG_A, system: "github.com", sourceIds: ["c-1"], cause: "source_deleted" });
    expect(idsOf(w)).toEqual(["c-1", "c-2", "c-3"]); // hidden, not yet deleted

    const summary = await runDeleteWorker(d.deps, ORG_A);
    expect(idsOf(w)).toEqual(["c-2", "c-3"]);
    expect(w.vectorDeletes.flat()).toEqual(expect.arrayContaining([`event:${ids["c-1"]!}`, `fact:${FACT_A}`, `fact:${FACT_B}`]));
    expect(await get(w, recordFactKey(ORG_A, "web", FACT_A))).toBeUndefined();
    expect(await get(w, recordFactKey(ORG_A, "web", FACT_B))).toBeUndefined(); // no distiller port: deleted
    expect(await get(w, recordDerivationKey(ORG_A, "web", "github.com", "c-1", FACT_A))).toBeUndefined();
    expect(summary).toMatchObject({ rows: 1, facts: 2, finished: 1, blocked: 0, backlog: false });
    expect(d.lessons.withdrawn).toEqual(["les_only"]);                // all sources gone, no code citation
    expect(d.lessons.trimmed.sort()).toEqual(["les_coded", "les_mixed"]); // kept: valid code citation, or sources left
    expect(await listScopeWork(w.table, ORG_A, 10)).toEqual([]);
    const hash = teamRecordSourceHash("github.com", "c-1");
    expect(d.lake.enqueued).toEqual(expect.arrayContaining([{ kind: "source", sourceHash: hash }, { kind: "fact", factId: FACT_A }, { kind: "fact", factId: FACT_B }]));
    // the lake was told before the hot row went
    expect(d.lake.rowsAtEnqueue[0]).toBe(3);
    // audit: ids and fixed words only
    const events = d.audit.map((event) => AuditEventInputSchema.parse(event));
    expect(events.map((event) => event.action).sort()).toEqual(["lesson.withdrawn", "record.tombstoned"]);
    expect(JSON.stringify(events)).not.toContain("retries");
  });

  it("re-distils a fact from the sources that are left when a distiller is there, and keeps its audience and trust", async () => {
    const w = world();
    await seedComments(w);
    const calls: unknown[] = [];
    const d = deleteDeps(w, { redistil: { async redistil(input) { calls.push(input); return { text: "Retries use withRetry (from what is left)." }; } } });
    await addFact(w, FACT_B, [{ system: "github.com", sourceId: "c-1" }, { system: "github.com", sourceId: "c-3" }], { trust: "member", audience: { kind: "project" } });
    await w.sink.tombstone({ workspaceId: ORG_A, system: "github.com", sourceIds: ["c-1"], cause: "source_deleted" });
    const summary = await runDeleteWorker(d.deps, ORG_A);
    expect(summary).toMatchObject({ facts: 1, redistilled: 1 });
    expect(calls).toEqual([expect.objectContaining({ remaining: [{ system: "github.com", sourceId: "c-3" }], trust: "member", audience: { kind: "project" } })]);
    const replacement = rows(w, "TEAM_RECORD_FACT");
    expect(replacement).toHaveLength(1);
    expect(replacement[0]!.id).not.toBe(FACT_B);
    expect(replacement[0]!.derivedFrom).toEqual(["github.com:c-3"]);
    expect(await getRecordFact(w.table, ORG_A, "web", replacement[0]!.id as string)).toMatchObject({ text: "Retries use withRetry (from what is left)." });
    // the new fact is linked to c-3, so a later delete of c-3 finds it
    expect(rows(w, "TEAM_RECORD_DERIVATION").some((link) => link.factId === replacement[0]!.id)).toBe(true);
  });

  it("a distiller that cannot, throws or answers nothing leaves the fact deleted, never kept with deleted content", async () => {
    for (const redistil of [async () => undefined, async () => { throw new Error("model down"); }]) {
      const w = world();
      await seedComments(w);
      await addFact(w, FACT_B, [{ system: "github.com", sourceId: "c-1" }, { system: "github.com", sourceId: "c-3" }]);
      await w.sink.tombstone({ workspaceId: ORG_A, system: "github.com", sourceIds: ["c-1"], cause: "source_deleted" });
      await runDeleteWorker(deleteDeps(w, { redistil: { redistil } }).deps, ORG_A);
      expect(rows(w, "TEAM_RECORD_FACT")).toHaveLength(0);
    }
  });

  it("keeps a row whose vector could not be deleted, still hidden and without text, and finishes on the next run", async () => {
    const w = world();
    await seedComments(w);
    const d = deleteDeps(w);
    await w.sink.tombstone({ workspaceId: ORG_A, system: "github.com", sourceIds: ["c-2"], cause: "source_deleted" });
    w.vectors.delete = async (keys: string[]) => ({ done: 0, failed: keys });
    const first = await runDeleteWorker(d.deps, ORG_A);
    expect(first).toMatchObject({ rows: 0, blocked: 1, finished: 0, stillHidden: 1 });
    const kept = rows(w, "TEAM_RECORD_EVENT").find((item) => (item.sourceRef as { id: string }).id === "c-2")!;
    expect(kept.tombstone).toBeDefined();
    expect(kept.text).toBeUndefined();
    expect(await listScopeWork(w.table, ORG_A, 10)).toHaveLength(1);
    w.vectors.delete = async (keys: string[]) => { w.vectorDeletes.push(keys); return { done: keys.length, failed: [] }; };
    const second = await runDeleteWorker(d.deps, ORG_A);
    expect(second).toMatchObject({ rows: 1, finished: 1, blocked: 0 });
    expect(idsOf(w)).toEqual(["c-1", "c-3"]);
  });

  it("with no vector port the rows stay blocked (a vector might exist), and a thrown delete is the same", async () => {
    const w = world();
    await seedComments(w);
    await w.sink.tombstone({ workspaceId: ORG_A, system: "github.com", sourceIds: ["c-2"], cause: "source_deleted" });
    expect(await runDeleteWorker(deleteDeps(w, { vectors: undefined }).deps, ORG_A)).toMatchObject({ blocked: 1, rows: 0 });
    w.vectors.delete = async () => { throw new Error("s3 vectors down"); };
    expect(await runDeleteWorker(deleteDeps(w).deps, ORG_A)).toMatchObject({ blocked: 1, rows: 0 });
    expect(idsOf(w)).toEqual(["c-1", "c-2", "c-3"]);
  });

  it("deletes inside the hour on a fake clock, and raises the backlog alarm for a request older than an hour that could not finish", async () => {
    const w = world();
    await seedComments(w);
    const d = deleteDeps(w);
    await w.sink.tombstone({ workspaceId: ORG_A, system: "github.com", sourceIds: ["c-2"], cause: "source_deleted" });
    w.clock.ms += 30 * 60_000;
    expect(await runDeleteWorker(d.deps, ORG_A)).toMatchObject({ rows: 1, backlog: false, oldestAgeSeconds: 1_800 });
    // a second request that cannot finish for over an hour
    await w.sink.tombstone({ workspaceId: ORG_A, system: "github.com", sourceIds: ["c-3"], cause: "source_deleted" });
    w.vectors.delete = async (keys: string[]) => ({ done: 0, failed: keys });
    w.clock.ms += HOUR + 1_000;
    const late = await runDeleteWorker(d.deps, ORG_A);
    expect(late.backlog).toBe(true);
    expect(late.oldestAgeSeconds).toBeGreaterThan(DELETE_BACKLOG_SECONDS);
    expect(d.logs).toContain("record.delete_backlog");
    // hidden all along: a tombstoned row is never shown
    const stuck = rows(w, "TEAM_RECORD_EVENT").find((item) => (item.sourceRef as { id: string }).id === "c-3")!;
    expect(stuck.tombstone).toBeDefined();
    expect(stuck.text).toBeUndefined();
  });

  it("queues the lake delete of a source item that kept no row (retention B), before anything else", async () => {
    const w = world();
    const d = deleteDeps(w);
    await w.sink.tombstone({ workspaceId: ORG_A, system: "T1", sourceIds: ["T1/C9/1.1"], cause: "source_deleted" });
    const summary = await runDeleteWorker(d.deps, ORG_A);
    expect(summary).toMatchObject({ finished: 1, rows: 0 });
    expect(d.lake.enqueued).toEqual([{ kind: "source", sourceHash: teamRecordSourceHash("T1", "T1/C9/1.1") }]);
  });

  it("finishes a scope delete that ran out of budget: hidden first, then deleted, and the scope reads visible again only for what remains", async () => {
    const w = world();
    await seedComments(w);
    await createRecordSink(w.deps, { budget: { maxItems: 1, maxMs: 8_000 } }).tombstone({ workspaceId: ORG_A, system: "github.com", scope: GITHUB_SCOPE, cause: "source_deleted" });
    expect((await listScopeWork(w.table, ORG_A, 10))[0]).toMatchObject({ hidePending: true });
    const summary = await runDeleteWorker(deleteDeps(w).deps, ORG_A);
    expect(summary).toMatchObject({ rows: 3, finished: 1 });
    expect(idsOf(w)).toEqual([]);
    expect(await listScopeWork(w.table, ORG_A, 10)).toEqual([]);
  });

  it("finishes principal changes that did not finish in budget", async () => {
    const w = world();
    await seedComments(w);
    await createRecordSink(w.deps, { budget: { maxItems: 1, maxMs: 8_000 } }).changePrincipals({ workspaceId: ORG_A, scope: GITHUB_SCOPE, remove: ["123"], at: "2026-10-30T13:00:00.000Z" });
    expect((await listScopeWork(w.table, ORG_A, 10))[0]).toMatchObject({ type: "principals", hidePending: true });
    const summary = await runDeleteWorker(deleteDeps(w).deps, ORG_A);
    expect(summary).toMatchObject({ finished: 1, stillHidden: 0 });
    for (const event of eventsOf(w)) expect((event.audience as { acl: { principals: string[] } }).acl.principals).toEqual(["456"]);
    expect(await listScopeWork(w.table, ORG_A, 10)).toEqual([]);
  });

  it("never reads or deletes another workspace's work or rows", async () => {
    const w = world();
    await seedComments(w);
    await addSource(w, { orgId: ORG_B, source: "github", scope: GITHUB_SCOPE });
    await w.sink.put(githubDraft({ workspaceId: ORG_B, sourceRef: { system: "github.com", id: "c-1", version: "1" }, links: [] }));
    await w.sink.tombstone({ workspaceId: ORG_B, system: "github.com", sourceIds: ["c-1"], cause: "source_deleted" });
    const summary = await runDeleteWorker(deleteDeps(w).deps, ORG_A);
    expect(summary.requests).toBe(0);
    expect(rows(w, "TEAM_RECORD_EVENT")).toHaveLength(4);
    expect(await runDeleteWorker(deleteDeps(w).deps, ORG_B)).toMatchObject({ rows: 1, finished: 1 });
    expect(idsOf(w)).toEqual(["c-1", "c-2", "c-3"]);
  });

  it("is bounded: a run takes at most the request budget and stops at its time", async () => {
    const w = world();
    await seedComments(w);
    for (const id of ["c-1", "c-2", "c-3"]) await w.sink.tombstone({ workspaceId: ORG_A, system: "github.com", sourceIds: [id], cause: "source_deleted" });
    const summary = await runDeleteWorker(deleteDeps(w).deps, ORG_A, { ...DEFAULT_DELETE_BUDGET, maxRequests: 2 });
    expect(summary.requests).toBe(2);
    expect((await listScopeWork(w.table, ORG_A, 10))).toHaveLength(1);
  });
});
