import { describe, expect, it } from "vitest";
import { recordActorSourceHash, recordScopeHash, teamRecordSourceHash, workspaceVectorBucketKey } from "@agentx/contracts";
import { ensureWorkspaceVectorBucket, getWorkspaceVectorBucket, tableHotArchiveSource, tableHotStatsSource } from "../../../packages/broker/src/team-record/hot-source.js";
import { expireRawText } from "../../../packages/broker/src/team-record/text-expiry.js";
import { tableLakeDeleteQueue } from "../../../packages/broker/src/team-record/lake-queue.js";
import { erasePerson } from "../../../packages/broker/src/team-record/erase.js";
import { createRecordSink } from "../../../packages/broker/src/team-record/sink.js";
import { eventFromItem } from "../../../packages/broker/src/team-record/store.js";
import { GITHUB_SCOPE, ORG_A, ORG_B, addSource, get, githubDraft, rows, world, type World } from "../../support/team-record-core.js";
import { deleteDeps, idsOf, seedComments } from "../../support/team-record-delete.js";

const DAY = 86_400_000;
const days = (w: World, n: number) => new Date(w.clock.ms - n * DAY).toISOString();
const PROJECT = { kind: "project" as const };
const projects = { async projects() { return ["web", "api"]; } };

async function putAt(w: World, id: string, daysAgo: number, extra: Record<string, unknown> = {}) {
  return w.sink.put(githubDraft({ sourceRef: { system: "github.com", id, version: "1" }, occurredAt: days(w, daysAgo), links: [], ...extra }));
}

describe("every row carries its place", () => {
  it("stores the scope on the row, from the snapshot, the draft, or Rovara's project place; a row with none is refused", async () => {
    const w = world();
    await addSource(w, { source: "github", scope: GITHUB_SCOPE });
    await putAt(w, "a", 1);
    await w.sink.put(githubDraft({ source: "rovara", kind: "rovara.merged", repo: undefined, sourceRef: { system: "rovara", id: "m1", version: "1" }, audience: PROJECT, trust: "rovara", actor: undefined, text: undefined, retention: "C" }));
    const byId = Object.fromEntries(rows(w, "TEAM_RECORD_EVENT").map((item) => [(item.sourceRef as { id: string }).id, item.scope]));
    expect(byId).toEqual({ a: GITHUB_SCOPE, m1: "rovara:project/web" });
    expect(await w.sink.put(githubDraft({ audience: PROJECT, sourceRef: { system: "github.com", id: "z", version: "1" } }))).toEqual({ status: "refused", reason: "no_scope" });
  });
});

describe("archive source (for the storage lane's archiver)", () => {
  it("lists live rows older than the cutoff across projects, oldest first within a page, resumes by cursor, and skips tombstoned and archived rows", async () => {
    const w = world();
    await addSource(w, { source: "github", scope: GITHUB_SCOPE });
    await addSource(w, { project: "api", source: "github", scope: "github:repo/77" });
    for (const [id, age] of [["old-1", 120], ["old-2", 100], ["new-1", 10]] as const) await putAt(w, id, age);
    await w.sink.put(githubDraft({ project: "api", sourceRef: { system: "github.com", id: "api-old", version: "1" }, occurredAt: days(w, 95), links: [], audience: { kind: "restricted", acl: { source: "github", scope: "github:repo/77", principals: ["1"], capturedAt: "2026-10-30T10:00:00.000Z", liveCheck: "none" } } }));
    const source = tableHotArchiveSource(w.table, projects, tableLakeDeleteQueue(w.table), () => w.clock.ms);
    const ids: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await source.listArchivable({ workspaceId: ORG_A, olderThan: days(w, 90), limit: 1, ...(cursor === undefined ? {} : { cursor }) });
      ids.push(...page.rows.map((row) => row.sourceRef.id));
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor !== undefined && pages < 10);
    expect(ids.sort()).toEqual(["api-old", "old-1", "old-2"]);
    expect((await source.listArchivable({ workspaceId: ORG_A, olderThan: days(w, 90), limit: 10 })).rows.every((row) => row.scope.length > 0)).toBe(true);
    await w.sink.tombstone({ workspaceId: ORG_A, system: "github.com", sourceIds: ["old-1"], cause: "source_deleted" });
    const fresh = tableHotArchiveSource(w.table, projects, tableLakeDeleteQueue(w.table), () => w.clock.ms);
    const again = (await fresh.listArchivable({ workspaceId: ORG_A, olderThan: days(w, 90), limit: 10 })).rows.map((row) => row.sourceRef.id).sort();
    expect(again).toEqual(["api-old", "old-2"]);
    await fresh.markArchived(ORG_A, (await fresh.listArchivable({ workspaceId: ORG_A, olderThan: days(w, 90), limit: 10 })).rows.map((row) => row.id), "2026-10-30T00:00:00Z");
    expect((await tableHotArchiveSource(w.table, projects, tableLakeDeleteQueue(w.table), () => w.clock.ms).listArchivable({ workspaceId: ORG_A, olderThan: days(w, 90), limit: 10 })).rows).toEqual([]);
  });

  it("never lists another workspace's rows", async () => {
    const w = world();
    await addSource(w, { orgId: ORG_B, source: "github", scope: GITHUB_SCOPE });
    await w.sink.put(githubDraft({ workspaceId: ORG_B, sourceRef: { system: "github.com", id: "b", version: "1" }, occurredAt: days(w, 120), links: [] }));
    expect((await tableHotArchiveSource(w.table, projects, tableLakeDeleteQueue(w.table), () => w.clock.ms).listArchivable({ workspaceId: ORG_A, olderThan: days(w, 90), limit: 10 })).rows).toEqual([]);
  });

  it("filterLive drops a row deleted since the listing, and markArchived does not mark a row that died after the last check", async () => {
    const w = world();
    await addSource(w, { source: "github", scope: GITHUB_SCOPE });
    await putAt(w, "x", 120);
    await putAt(w, "y", 121);
    const source = tableHotArchiveSource(w.table, projects, tableLakeDeleteQueue(w.table), () => w.clock.ms);
    const listed = (await source.listArchivable({ workspaceId: ORG_A, olderThan: days(w, 90), limit: 10 })).rows;
    const [x, y] = ["x", "y"].map((name) => listed.find((row) => row.sourceRef.id === name)!.id);
    expect([...(await source.filterLive(ORG_A, [x!, y!, "never-listed"]))].sort()).toEqual([x, y].sort());
    await w.sink.tombstone({ workspaceId: ORG_A, system: "github.com", sourceIds: ["x"], cause: "source_deleted" });
    expect([...(await source.filterLive(ORG_A, [x!, y!]))]).toEqual([y]);
    // x died after the check: the mark does not land
    // The lake copy of a row that died during the run is queued for deletion AFTER the archive write, and the caller is told which ids were lost.
    expect(await source.markArchived(ORG_A, [x!, y!, "never-listed"], "2026-10-30T00:00:00Z")).toEqual([x]);
    expect((await tableLakeDeleteQueue(w.table).listPending(ORG_A, 20)).map((entry) => entry.target)).toContainEqual({ kind: "source", sourceHash: teamRecordSourceHash("github.com", "x") });
    const stored = rows(w, "TEAM_RECORD_EVENT");
    expect(stored.find((item) => (item.sourceRef as { id: string }).id === "x")!.archivedAt).toBeUndefined();
    expect(stored.find((item) => (item.sourceRef as { id: string }).id === "y")!.archivedAt).toBe("2026-10-30T00:00:00Z");
    // the mark is not part of the row's contract: it still parses
    expect(eventFromItem(stored.find((item) => (item.sourceRef as { id: string }).id === "y"))).toBeDefined();
  });
});

describe("hot statistics (the recent side)", () => {
  async function seedStats(w: World) {
    await addSource(w, { source: "github", scope: GITHUB_SCOPE });
    await addSource(w, { source: "linear", scope: "linear:team/ENG", audienceDefault: "project" });
    const rovara = (kind: string, id: string, structured: Record<string, string | number | boolean>, age = 2, audience: unknown = PROJECT) => w.sink.put(githubDraft({ source: "rovara", kind: kind as never, repo: undefined, sourceRef: { system: "rovara", id, version: "1" }, audience: audience as never, trust: "rovara", actor: undefined, text: undefined, structured, occurredAt: days(w, age), retention: "C", links: [] }));
    await rovara("rovara.send_back", "sb1", { stage: "REVIEW" });
    await rovara("rovara.send_back", "sb2", { stage: "REVIEW" });
    await rovara("rovara.send_back", "sb3", { stage: "PLAN" });
    await rovara("rovara.send_back", "sb-old", { stage: "PLAN" }, 200);
    await rovara("rovara.send_back", "sb-priv", { stage: "PLAN" }, 2, { kind: "restricted", acl: { source: "rovara", scope: "rovara:task/t9", principals: ["dev-9"], capturedAt: "2026-10-30T10:00:00.000Z", liveCheck: "none" } });
    await rovara("rovara.task", "t1", { outcome: "merged", sendBacks: 2 });
    await rovara("rovara.task", "t2", { outcome: "reverted", sendBacks: 0 });
    await rovara("rovara.task", "t3", { outcome: "closed", sendBacks: 1 });
    await w.sink.put(githubDraft({ source: "linear", kind: "ticket.created", repo: undefined, sourceRef: { system: "linear.app", id: "E1", version: "1" }, audience: PROJECT, scope: "linear:team/ENG", structured: { component: "billing" }, links: [], occurredAt: days(w, 3) }));
    await w.sink.put(githubDraft({ source: "linear", kind: "ticket.created", repo: undefined, sourceRef: { system: "linear.app", id: "E2", version: "1" }, audience: PROJECT, scope: "linear:team/ENG", links: [], occurredAt: days(w, 3) }));
    await w.sink.put(githubDraft({ kind: "github.ci", sourceRef: { system: "github.com", id: "ci1", version: "1" }, audience: PROJECT, scope: GITHUB_SCOPE, structured: { check: "unit", conclusion: "failure" }, links: [], occurredAt: days(w, 3) }));
    await w.sink.put(githubDraft({ kind: "github.ci", sourceRef: { system: "github.com", id: "ci2", version: "1" }, audience: PROJECT, scope: GITHUB_SCOPE, structured: { check: "unit", conclusion: "success" }, links: [], occurredAt: days(w, 3) }));
  }
  const window = (w: World) => ({ workspaceId: ORG_A, project: "web", since: days(w, 90), until: new Date(w.clock.ms).toISOString() });

  it("counts project-wide, live, unarchived rows by the template's group, matching the lake's definitions", async () => {
    const w = world();
    await seedStats(w);
    const hot = tableHotStatsSource(w.table);
    expect(await hot.groupedCounts({ ...window(w), template: "send_backs_by_stage" })).toEqual([{ group: "REVIEW", count: 2 }, { group: "PLAN", count: 1 }]);
    expect(await hot.groupedCounts({ ...window(w), template: "tickets_by_component" })).toEqual([{ group: "billing", count: 1 }, { group: "unknown", count: 1 }]);
    expect(await hot.groupedCounts({ ...window(w), template: "ci_failures_by_test" })).toEqual([{ group: "unit", count: 1 }]);
    expect(await hot.mergeTotals(window(w))).toEqual({ tasks: 3, merged: 1, reverted: 1, send_backs: 3 });
  });

  it("leaves out tombstoned and archived rows, another project and another workspace", async () => {
    const w = world();
    await seedStats(w);
    await w.sink.tombstone({ workspaceId: ORG_A, system: "rovara", sourceIds: ["sb1"], cause: "source_deleted" });
    const hot = tableHotStatsSource(w.table);
    expect((await hot.groupedCounts({ ...window(w), template: "send_backs_by_stage" }))[0]).toEqual({ group: "PLAN", count: 1 });
    const archive = tableHotArchiveSource(w.table, projects, tableLakeDeleteQueue(w.table), () => w.clock.ms);
    const old = (await archive.listArchivable({ workspaceId: ORG_A, olderThan: days(w, 1), limit: 50 })).rows.find((row) => row.sourceRef.id === "sb2")!;
    await archive.markArchived(ORG_A, [old.id], "2026-10-30T00:00:00Z");
    expect(await hot.groupedCounts({ ...window(w), template: "send_backs_by_stage" })).toEqual([{ group: "PLAN", count: 1 }]);
    expect(await hot.groupedCounts({ ...window(w), project: "api", template: "send_backs_by_stage" })).toEqual([]);
    expect(await hot.groupedCounts({ ...window(w), workspaceId: ORG_B, template: "send_backs_by_stage" })).toEqual([]);
  });
});

describe("vector bucket of a workspace", () => {
  const choose = (_id: string, buckets: readonly string[]) => buckets[buckets.length - 1]!;
  it("assigns once, reads back the same after the list changes, and agrees under a race", async () => {
    const w = world();
    expect(await getWorkspaceVectorBucket(w.table, ORG_A)).toBeUndefined();
    expect(await ensureWorkspaceVectorBucket(w.table, ORG_A, ["b1", "b2"], choose)).toBe("b2");
    expect(await ensureWorkspaceVectorBucket(w.table, ORG_A, ["b1", "b2", "b3"], choose)).toBe("b2");
    expect(await get(w, workspaceVectorBucketKey(ORG_A))).toMatchObject({ bucket: "b2" });
    const race = world();
    const results = await Promise.all([ensureWorkspaceVectorBucket(race.table, ORG_A, ["x", "y"], (_i, b) => b[0]!), ensureWorkspaceVectorBucket(race.table, ORG_A, ["x", "y"], (_i, b) => b[1]!)]);
    expect(new Set(results).size).toBe(1);
    expect(await ensureWorkspaceVectorBucket(w.table, ORG_B, ["b1"], choose)).toBe("b1");
  });
  it("refuses a bucket the chooser invents", async () => {
    await expect(ensureWorkspaceVectorBucket(world().table, ORG_A, ["b1"], () => "other")).rejects.toThrow();
  });
});

describe("retention C text expiry", () => {
  it("removes the text and the vector after 30 days and keeps the row, only for rows that are due", async () => {
    const w = world();
    await addSource(w, { source: "github", scope: GITHUB_SCOPE, retention: "C" });
    await putAt(w, "due", 40, { retention: "C" });
    await putAt(w, "fresh", 5, { retention: "C" });
    expect(w.vectorItems).toHaveLength(2);
    const result = await expireRawText({ table: w.table, vectors: w.vectors, now: () => w.clock.ms }, ORG_A);
    expect(result).toMatchObject({ expired: 0 }); // "due" arrived late, so its text lives a day
    w.clock.ms += 2 * DAY;
    const next = await expireRawText({ table: w.table, vectors: w.vectors, now: () => w.clock.ms }, ORG_A);
    expect(next).toMatchObject({ expired: 1, blocked: 0 });
    const stored = rows(w, "TEAM_RECORD_EVENT");
    const due = stored.find((item) => (item.sourceRef as { id: string }).id === "due")!;
    expect(due.text).toBeUndefined();
    expect(due.embeddingRef).toBeUndefined();
    expect(due.textExpiresAt).toBeUndefined();
    expect(eventFromItem(due)).toBeDefined();
    expect(stored.find((item) => (item.sourceRef as { id: string }).id === "fresh")!.text).toBeDefined();
    expect(w.vectorDeletes.flat()).toEqual([`event:${eventFromItem(due)!.id}`]);
  });
  it("keeps the text while the vector cannot be deleted, and is bounded", async () => {
    const w = world();
    await addSource(w, { source: "github", scope: GITHUB_SCOPE, retention: "C" });
    for (const id of ["a", "b", "c"]) await putAt(w, id, 40, { retention: "C" });
    w.clock.ms += 2 * DAY;
    w.vectors.delete = async (keys: string[]) => ({ done: 0, failed: keys });
    expect(await expireRawText({ table: w.table, vectors: w.vectors, now: () => w.clock.ms }, ORG_A)).toMatchObject({ expired: 0, blocked: 3, alarm: true });
    expect(rows(w, "TEAM_RECORD_EVENT").every((item) => typeof item.text === "string")).toBe(true);
    expect(await expireRawText({ table: w.table, now: () => w.clock.ms }, ORG_A)).toMatchObject({ expired: 0, blocked: 3, alarm: true });
    w.vectors.delete = async (keys: string[]) => ({ done: keys.length, failed: [] });
    const first = await expireRawText({ table: w.table, vectors: w.vectors, now: () => w.clock.ms }, ORG_A, { maxItems: 1, maxMs: 20_000 });
    expect(first).toMatchObject({ expired: 1, more: true });
    const rest = await expireRawText({ table: w.table, vectors: w.vectors, now: () => w.clock.ms }, ORG_A, { maxItems: 10, maxMs: 20_000 });
    expect(first.expired + rest.expired).toBe(3);
    expect(rest.more).toBe(false);
    // finished rows left the index: a next night has nothing to read
    expect(await expireRawText({ table: w.table, vectors: w.vectors, now: () => w.clock.ms }, ORG_A)).toMatchObject({ expired: 0, blocked: 0, alarm: false });
  });
});

describe("lake targets the storage lane asked for", () => {
  it("hashes match the lake's definitions", () => {
    expect(recordScopeHash("slack:T1/C9")).toMatch(/^[0-9a-f]{64}$/);
    expect(recordActorSourceHash("T1", "U7")).not.toBe(teamRecordSourceHash("T1", "U7"));
    expect(recordScopeHash("a")).not.toBe(recordScopeHash("b"));
  });

  it("a deleted place is queued for the lake as a scope target before any hot row is touched", async () => {
    const w = world();
    await seedComments(w);
    const d = deleteDeps(w);
    await createRecordSink(w.deps, { lakeQueue: d.lake }).tombstone({ workspaceId: ORG_A, system: "github.com", scope: GITHUB_SCOPE, cause: "source_deleted" });
    expect(d.lake.enqueued).toEqual([{ kind: "scope", hash: recordScopeHash(GITHUB_SCOPE) }]);
    expect(d.lake.rowsAtEnqueue[0]).toBe(3);
    expect(rows(w, "TEAM_RECORD_EVENT").every((item) => item.tombstone !== undefined)).toBe(true);
  });

  it("a place that turns private is queued as a scope target, one that turns public is not", async () => {
    const w = world();
    await seedComments(w);
    const d = deleteDeps(w);
    const sink = createRecordSink(w.deps, { lakeQueue: d.lake });
    const priv = { kind: "restricted" as const, acl: { source: "github" as const, scope: GITHUB_SCOPE, principals: ["1"], capturedAt: "2026-10-30T13:00:00.000Z", liveCheck: "none" as const } };
    await sink.replaceScopeAudience({ workspaceId: ORG_A, scope: GITHUB_SCOPE, audience: priv, at: "2026-10-30T13:00:00.000Z" });
    expect(d.lake.enqueued).toEqual([{ kind: "scope", hash: recordScopeHash(GITHUB_SCOPE) }]);
    await sink.replaceScopeAudience({ workspaceId: ORG_A, scope: GITHUB_SCOPE, audience: PROJECT, at: "2026-10-30T14:00:00.000Z" });
    expect(d.lake.enqueued).toHaveLength(1);
  });

  it("a person with no developer id is erased by source identity, hot and lake, including rows made before and after they were mapped", async () => {
    const w = world();
    await addSource(w, { source: "github", scope: GITHUB_SCOPE });
    await putAt(w, "anon-1", 1, { actor: { sourceId: "U77", trust: "outsider" }, trust: "outsider" });
    await putAt(w, "anon-2", 1, { actor: { sourceId: "U77", trust: "outsider" }, trust: "outsider" });
    await putAt(w, "mapped", 1, { actor: { sourceId: "U77", developerId: "dev-7", trust: "member" } });
    await putAt(w, "other", 1, { actor: { sourceId: "U88", trust: "outsider" }, trust: "outsider" });
    expect(rows(w, "TEAM_RECORD_EVENT").filter((item) => item.gsi4pk !== undefined)).toHaveLength(3);
    const d = deleteDeps(w);
    const result = await erasePerson(d.deps, ORG_A, { developerId: "dev-7", identities: [{ system: "github.com", sourceId: "U77" }] }, "e-7");
    expect(result).toMatchObject({ rows: 3, complete: true });
    expect(idsOf(w)).toEqual(["other"]);
    expect(d.lake.enqueued).toEqual([{ kind: "actor", developerId: "dev-7" }, { kind: "actor_source", hash: recordActorSourceHash("github.com", "U77") }, ...d.lake.enqueued.slice(2)]);
    expect(d.lake.enqueued.filter((target) => target.kind === "source")).toHaveLength(3);
    // by identity alone
    const solo = world();
    await addSource(solo, { source: "github", scope: GITHUB_SCOPE });
    await putAt(solo, "anon", 1, { actor: { sourceId: "U77", trust: "outsider" }, trust: "outsider" });
    expect(await erasePerson(deleteDeps(solo).deps, ORG_A, { identities: [{ system: "github.com", sourceId: "U77" }] }, "e-8")).toMatchObject({ rows: 1, complete: true });
    await expect(erasePerson(deleteDeps(solo).deps, ORG_A, {}, "e-9")).rejects.toThrow();
  });

  it("the lake queue refuses a target with anything but a hash", async () => {
    const w = world();
    const queue = tableLakeDeleteQueue(w.table);
    await expect(queue.enqueue(ORG_A, [{ kind: "scope", hash: "slack:T1/C9" }])).rejects.toThrow();
    await expect(queue.enqueue(ORG_A, [{ kind: "actor_source", hash: "x'; DROP" }])).rejects.toThrow();
    await queue.enqueue(ORG_A, [{ kind: "scope", hash: recordScopeHash("slack:T1/C9") }, { kind: "scope", hash: recordScopeHash("slack:T1/C9") }]);
    expect(await queue.listPending(ORG_A, 10)).toHaveLength(1);
  });
});
