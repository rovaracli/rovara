import { describe, expect, it } from "vitest";
import { AuditEventInputSchema, learningModeKey, learningModeLockKey, lessonKey, lessonSetKey, teamRecordPk, recordDeveloperHash } from "@agentx/contracts";
import { erasePerson, eraseProject, eraseWorkspace } from "../../../packages/broker/src/team-record/erase.js";
import { lessonFate, supportedByCode } from "../../../packages/broker/src/team-record/lesson-fate.js";
import { tableLakeDeleteQueue } from "../../../packages/broker/src/team-record/lake-queue.js";
import { ORG_A, ORG_B, GITHUB_SCOPE, addSource, githubDraft, rows, world } from "../../support/team-record-core.js";
import { FACT_A, FACT_B, addFact, deleteDeps, eventsOf, idsOf, seedComments } from "../../support/team-record-delete.js";

const lesson = (extra: Record<string, unknown> = {}) => ({ id: "les_1", version: 1, status: "active", citations: [], provenance: { sourceEvents: ["e1"] }, counters: { citationStale: 0 }, ...extra }) as Parameters<typeof lessonFate>[0];
const code = { kind: "code" as const, repo: "a/b", path: "x.ts", startLine: 1, endLine: 2, anchor: "a", commit: "abc1234" };

describe("lesson fate", () => {
  it("is withdrawn when every source is gone, unless a valid code citation alone supports it", () => {
    expect(lessonFate(lesson(), new Set(["e1"]))).toBe("withdraw");
    expect(lessonFate(lesson({ provenance: { sourceEvents: ["e1", "e2"] } }), new Set(["e1", "e2"]))).toBe("withdraw");
    expect(lessonFate(lesson({ citations: [code], lastValidatedAt: "2026-10-30T10:00:00.000Z" }), new Set(["e1"]))).toBe("keep_without_record_citations");
  });
  it("is not kept by a code citation that was never validated, was found stale, or on a lesson that is not active", () => {
    for (const extra of [{ citations: [code] }, { citations: [code], lastValidatedAt: "2026-10-30T10:00:00.000Z", counters: { citationStale: 1 } }, { citations: [code], lastValidatedAt: "2026-10-30T10:00:00.000Z", status: "pending" }]) {
      expect(supportedByCode(lesson(extra)), JSON.stringify(extra)).toBe(false);
      expect(lessonFate(lesson(extra), new Set(["e1"]))).toBe("withdraw");
    }
  });
  it("stays when sources are left (losing its record citations to the deleted rows), and is untouched when it names none", () => {
    expect(lessonFate(lesson({ provenance: { sourceEvents: ["e1", "e2"] } }), new Set(["e1"]))).toBe("keep_without_record_citations");
    expect(lessonFate(lesson(), new Set(["zzz"]))).toBe("untouched");
    expect(lessonFate(lesson({ provenance: { sourceEvents: [] }, citations: [{ kind: "record", eventId: "e9" }] }), new Set(["e9"]))).toBe("keep_without_record_citations");
  });
});

describe("erase a person", () => {
  it("removes every row their actions made, with vectors, derived facts and lessons, and queues the lake by actor", async () => {
    const w = world();
    await seedComments(w);
    const d = deleteDeps(w);
    const ids = Object.fromEntries(eventsOf(w).map((event) => [event.sourceRef.id, event.id]));
    await addFact(w, FACT_A, [{ system: "github.com", sourceId: "c-1" }, { system: "github.com", sourceId: "c-2" }]);   // both by dev-1
    await addFact(w, FACT_B, [{ system: "github.com", sourceId: "c-2" }, { system: "github.com", sourceId: "c-3" }]);   // c-3 by dev-2
    d.lessons.list.push({ id: "les_a", version: 1, status: "active", citations: [], provenance: { sourceEvents: [ids["c-1"]!, ids["c-2"]!] }, counters: { citationStale: 0 } });
    d.lessons.list.push({ id: "les_b", version: 1, status: "active", citations: [], provenance: { sourceEvents: [ids["c-3"]!] }, counters: { citationStale: 0 } });
    const result = await erasePerson(d.deps, ORG_A, { developerId: "dev-1" }, "erase-1");
    expect(result).toMatchObject({ rows: 2, facts: 2, complete: true, blocked: 0 });
    expect(idsOf(w)).toEqual(["c-3"]);
    expect(rows(w, "TEAM_RECORD_FACT")).toHaveLength(0);
    expect(w.vectorDeletes.flat()).toEqual(expect.arrayContaining([`event:${ids["c-1"]!}`, `event:${ids["c-2"]!}`]));
    expect(d.lessons.erased.flatMap((entry) => entry.purged)).toEqual(["les_a"]);
    expect(d.lake.enqueued).toEqual(expect.arrayContaining([{ kind: "actor", developerId: recordDeveloperHash("dev-1") }]));
    expect(d.lake.rowsAtEnqueue[0]).toBe(3);
    const [event] = d.audit.filter((entry) => entry.action === "record.erased");
    expect(AuditEventInputSchema.parse(event!).facts).toEqual({ cause: "person_erased", rows: 2, facts: 2, lessons: 1, vectors: 4 });
  });

  it("erases nothing of another person or another workspace, and is repeatable", async () => {
    const w = world();
    await seedComments(w);
    await addSource(w, { orgId: ORG_B, source: "github", scope: GITHUB_SCOPE });
    await w.sink.put(githubDraft({ workspaceId: ORG_B, sourceRef: { system: "github.com", id: "b-1", version: "1" }, links: [] }));
    const d = deleteDeps(w);
    await erasePerson(d.deps, ORG_A, { developerId: "dev-1" }, "e1");
    const again = await erasePerson(d.deps, ORG_A, { developerId: "dev-1" }, "e2");
    expect(again).toMatchObject({ rows: 0, complete: true });
    expect(rows(w, "TEAM_RECORD_EVENT").map((item) => item.pk)).toEqual(expect.arrayContaining([teamRecordPk(ORG_B, "web")]));
    expect(idsOf(w)).toEqual(["b-1", "c-3"]);
  });

  it("is incomplete while a vector cannot be deleted or the budget cuts the list, and complete on a later call", async () => {
    const w = world();
    await seedComments(w);
    const d = deleteDeps(w);
    w.vectors.delete = async (keys: string[]) => ({ done: 0, failed: keys });
    expect(await erasePerson(d.deps, ORG_A, { developerId: "dev-1" }, "e1")).toMatchObject({ complete: false, blocked: 2, rows: 0 });
    // the rows are hidden, text removed, even though not yet gone
    expect(rows(w, "TEAM_RECORD_EVENT").filter((item) => item.tombstone !== undefined && item.text === undefined)).toHaveLength(2);
    expect(d.audit).toEqual([]);
    w.vectors.delete = async (keys: string[]) => ({ done: keys.length, failed: [] });
    expect(await erasePerson(d.deps, ORG_A, { developerId: "dev-1" }, "e1")).toMatchObject({ complete: true, rows: 2 });
    const cut = world();
    await seedComments(cut);
    expect((await erasePerson(deleteDeps(cut).deps, ORG_A, { developerId: "dev-1" }, "e3", { maxItems: 1 })).complete).toBe(false);
  });
});

describe("erase a project and a workspace", () => {
  async function seedLearning(w: ReturnType<typeof world>, project: string) {
    const pk = teamRecordPk(ORG_A, project);
    for (const key of [lessonKey(ORG_A, project, "les_1"), lessonSetKey(ORG_A, project), learningModeKey(ORG_A, project)]) w.db.set({ ...key, entityType: "X", id: key.sk === "LESSON#les_1" ? "les_1" : undefined });
    w.db.set({ pk, sk: "LOAD#t1#PLAN#000000", entityType: "X" });
    w.db.set({ pk, sk: "SNAPSHOT#snp_1", entityType: "X" });
  }

  it("empties a project's partition (sources first), queues the lake by project, and leaves another project alone", async () => {
    const w = world();
    await seedComments(w);
    await addSource(w, { project: "api", source: "github", scope: "github:repo/77" });
    await w.sink.put(githubDraft({ project: "api", sourceRef: { system: "github.com", id: "a-1", version: "1" }, links: [], audience: { kind: "restricted", acl: { source: "github", scope: "github:repo/77", principals: ["1"], capturedAt: "2026-10-30T10:00:00.000Z", liveCheck: "none" } } }));
    await addFact(w, FACT_A, [{ system: "github.com", sourceId: "c-1" }]);
    await seedLearning(w, "web");
    const d = deleteDeps(w, { lessonVectors: { async removeAll() { /* recorded below */ } } });
    const result = await eraseProject(d.deps, ORG_A, "web", "project_archived", "arch-1");
    expect(result.complete).toBe(true);
    expect(w.db.find((item) => item.pk === teamRecordPk(ORG_A, "web"))).toEqual([]);
    expect(w.db.find((item) => item.pk === teamRecordPk(ORG_A, "api")).length).toBeGreaterThan(0);
    expect(d.lake.enqueued).toEqual(expect.arrayContaining([{ kind: "project", project: "web" }]));
    expect(d.lake.rowsAtEnqueue[0]).toBe(4);
    expect(w.vectorDeletes.flat().filter((key) => key.startsWith("event:"))).toHaveLength(3);
    expect(AuditEventInputSchema.parse(d.audit.find((e) => e.action === "record.erased")!).facts).toMatchObject({ cause: "project_archived", rows: 3 });
  });

  it("removes the pickers' listing sessions of the archived project (they sit in the company's own partition, found by their project); another project's stay", async () => {
    const w = world();
    const session = (id: string, project: string) => w.db.set({ pk: teamRecordPk(ORG_A), sk: `SRCOPT#${id}`, entityType: "TEAM_RECORD_SOURCE_OPTIONS", kind: "slack", project, pages: 1, indexExpiresAt: 9_999_999_999 });
    session("11111111-1111-4111-8111-111111111111", "web");
    session("22222222-2222-4222-8222-222222222222", "web");
    session("33333333-3333-4333-8333-333333333333", "api");
    w.db.set({ pk: teamRecordPk(ORG_B), sk: "SRCOPT#44444444-4444-4444-8444-444444444444", entityType: "TEAM_RECORD_SOURCE_OPTIONS", kind: "slack", project: "web", pages: 1 });
    const d = deleteDeps(w);
    expect((await eraseProject(d.deps, ORG_A, "web", "project_archived", "arch-opt")).complete).toBe(true);
    const left = w.db.find((item) => item.entityType === "TEAM_RECORD_SOURCE_OPTIONS").map((item) => `${String(item.pk)}|${String(item.project)}`).sort();
    expect(left).toEqual([`${teamRecordPk(ORG_A)}|api`, `${teamRecordPk(ORG_B)}|web`].sort());
  });

  it("deletes a fact with its project, never re-distilling it from what is left", async () => {
    const w = world();
    await seedComments(w);
    await addFact(w, FACT_B, [{ system: "github.com", sourceId: "c-1" }, { system: "github.com", sourceId: "c-3" }]);
    let calls = 0;
    const d = deleteDeps(w, { redistil: { async redistil() { calls += 1; return { text: "kept" }; } } });
    await eraseProject(d.deps, ORG_A, "web", "project_archived", "arch-2");
    expect(calls).toBe(0);
    expect(rows(w, "TEAM_RECORD_FACT")).toHaveLength(0);
  });

  it("tells the learning lane to drop the lessons' vectors, and is incomplete when that fails", async () => {
    const w = world();
    await seedComments(w);
    await seedLearning(w, "web");
    const removed: string[][] = [];
    const ok = deleteDeps(w, { lessonVectors: { async removeAll(_o, _p, ids) { removed.push([...ids]); } } });
    await eraseProject(ok.deps, ORG_A, "web", "project_archived", "a1");
    expect(removed).toEqual([["les_1"]]);
    const w2 = world();
    await seedLearning(w2, "web");
    const bad = deleteDeps(w2, { lessonVectors: { async removeAll() { throw new Error("down"); } } });
    expect((await eraseProject(bad.deps, ORG_A, "web", "project_archived", "a2")).complete).toBe(false);
  });

  it("is bounded and resumable: calls until complete, and a vector failure keeps it incomplete", async () => {
    const w = world();
    await seedComments(w);
    const d = deleteDeps(w);
    let calls = 0;
    for (; calls < 10; calls += 1) if ((await eraseProject(d.deps, ORG_A, "web", "project_archived", "a3", { maxItems: 2 })).complete) break;
    expect(calls).toBeGreaterThan(0);
    expect(calls).toBeLessThan(10);
    expect(w.db.find((item) => item.pk === teamRecordPk(ORG_A, "web"))).toEqual([]);
    const stuck = world();
    await seedComments(stuck);
    stuck.vectors.delete = async (keys: string[]) => ({ done: 0, failed: keys });
    expect((await eraseProject(deleteDeps(stuck).deps, ORG_A, "web", "project_archived", "a4")).complete).toBe(false);
  });

  it("closes a workspace: every project, the project-less partition and the workspace's own items, keeping the lake queue", async () => {
    const w = world();
    await seedComments(w);
    await addSource(w, { project: "api", source: "github", scope: "github:repo/77" });
    await w.sink.put(githubDraft({ project: "api", sourceRef: { system: "github.com", id: "a-1", version: "1" }, links: [], audience: { kind: "restricted", acl: { source: "github", scope: "github:repo/77", principals: ["1"], capturedAt: "2026-10-30T10:00:00.000Z", liveCheck: "none" } } }));
    await addSource(w, { orgId: ORG_B, source: "github", scope: GITHUB_SCOPE });
    await w.sink.put(githubDraft({ workspaceId: ORG_B, sourceRef: { system: "github.com", id: "b-1", version: "1" }, links: [] }));
    w.db.set({ ...learningModeLockKey(ORG_A), entityType: "X", mode: "off" });
    await w.sink.tombstone({ workspaceId: ORG_A, system: "github.com", sourceIds: ["c-1"], cause: "source_deleted" }); // leaves DELQ and DELETED# items
    const d = deleteDeps(w);
    const result = await eraseWorkspace(d.deps, ORG_A, ["web", "api"], "close-1");
    expect(result).toMatchObject({ complete: true, remainingProjects: [] });
    const left = w.db.find((item) => String(item.pk).includes(ORG_A));
    expect(left.length).toBeGreaterThan(0);
    expect(left.every((item) => String(item.sk).startsWith("LAKEDEL#"))).toBe(true);
    expect(w.db.find((item) => String(item.pk).includes(ORG_B)).length).toBeGreaterThan(0);
    const queue = await tableLakeDeleteQueue(w.table).listPending(ORG_A, 50);
    expect(queue.map((entry) => entry.target.kind)).toEqual(expect.arrayContaining(["project"]));
    expect(d.audit.filter((entry) => entry.action === "record.erased")).toHaveLength(1);
  });

  it("says which projects are left when the budget runs out", async () => {
    const w = world();
    await seedComments(w);
    await addSource(w, { project: "api", source: "github", scope: "github:repo/77" });
    const result = await eraseWorkspace(deleteDeps(w).deps, ORG_A, ["web", "api"], "close-2", { maxItems: 1 });
    expect(result.complete).toBe(false);
    expect(result.remainingProjects.length).toBeGreaterThan(0);
  });
});
