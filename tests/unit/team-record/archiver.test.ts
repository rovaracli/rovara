import { describe, expect, it } from "vitest";
import { runArchive, toLakeEventRow, type HotArchiveSource } from "../../../packages/broker/src/team-record/archiver.js";
import { actorSourceHash, scopeHash, sourceHash } from "../../../packages/broker/src/team-record/lake-sql.js";
import { LakeError, type LakeClient } from "../../../packages/broker/src/team-record/lake.js";
import type { RecordEventLike } from "../../../packages/broker/src/team-record/shared-types.js";
import type { VectorIndex, VectorItem } from "../../../packages/broker/src/team-record/vectors.js";

const NOW = Date.UTC(2026, 5, 1);
const event = (id: string, over: Partial<RecordEventLike> = {}): RecordEventLike => ({
  id, workspaceId: "ws1", project: "p1", scope: "github:repo/1", source: "github", sourceRef: { system: "github", id: `pr-${id}` }, kind: "github.pr",
  occurredAt: "2026-01-01T00:00:00Z", trust: "member", audience: { kind: "project" }, text: `text ${id}`, links: [], retention: "D", embeddingRef: `event:${id}`, ...over,
});
const meta = { audience_kind: "project", scope: "s", project: "p1", trust: "member", tier: "hot", kind: "event", ref: "x" } as const;

function harness(rows: RecordEventLike[], opts: { liveOverride?: (ids: string[], call: number) => string[]; filterLiveThrowsOn?: number; lakeFail?: boolean; putFail?: string[]; missingVectors?: string[] } = {}) {
  const marked: string[] = [];
  const sql: Array<{ sql: string; parameters: readonly string[] }> = [];
  const archived = new Set<string>();
  let liveCalls = 0;
  const queued: Array<{ kind: string; sourceHash?: string }> = [];
  const vectorDeletes: string[] = [];
  const source: HotArchiveSource = {
    listArchivable: async ({ limit, cursor }) => {
      const pending = rows.filter((r) => !archived.has(r.id));
      const start = cursor === undefined ? 0 : Number(cursor);
      const page = pending.slice(start, start + limit);
      return { rows: page, ...(start + limit < pending.length ? { nextCursor: String(start + limit) } : {}) };
    },
    filterLive: async (_ws, ids) => { liveCalls += 1; if (liveCalls === opts.filterLiveThrowsOn) throw new Error("hot down"); return new Set(opts.liveOverride ? opts.liveOverride(ids, liveCalls) : ids); },
    markArchived: async (_ws, ids) => { for (const id of ids) { marked.push(id); archived.add(id); } },
  };
  const lake: LakeClient = {
    now: () => NOW,
    query: async () => ({ rows: [], truncated: false }),
    execute: async (s, p) => { if (opts.lakeFail) throw new LakeError("lake_unavailable"); sql.push({ sql: s, parameters: p }); },
  };
  const puts: VectorItem[] = [];
  const vectors: VectorIndex = {
    dimension: 4,
    put: async (items) => { puts.push(...items); const failed = items.filter((i) => opts.putFail?.includes(i.key)).map((i) => i.key); return { done: items.length - failed.length, failed }; },
    get: async (keys) => keys.filter((k) => !opts.missingVectors?.includes(k)).map((key) => ({ key, vector: [1, 0, 0, 0], metadata: { ...meta } })),
    query: async () => [], delete: async (keys) => { vectorDeletes.push(...keys); return { done: keys.length, failed: [] }; },
  };
  const lakeDeletes = { enqueue: async (_ws: string, targets: Array<{ kind: string; sourceHash?: string }>) => { queued.push(...targets); } };
  return { deps: { source, lake, vectors, lakeDeletes: lakeDeletes as never, tableBucket: "rovara-lake", rowsPerInsert: 2 }, marked, sql, puts, queued, vectorDeletes };
}
const budget = { maxRows: 100, maxMs: 60_000 };

describe("lake event rows", () => {
  it("keeps text only under retention D and always carries the source hash and the restricted ACL", () => {
    expect(toLakeEventRow(event("a"), "2026-05-01T00:00:00Z").text).toBe("text a");
    expect(toLakeEventRow(event("a", { retention: "C" }), "2026-05-01T00:00:00Z").text).toBeNull();
    expect(toLakeEventRow(event("a", { retention: "B" }), "2026-05-01T00:00:00Z").text).toBeNull();
    const restricted = toLakeEventRow(event("a", { audience: { kind: "restricted", acl: { source: "slack", scope: "slack:T/C", principals: ["U1"], capturedAt: "2026-01-01T00:00:00Z", liveCheck: "none" } } }), "2026-05-01T00:00:00Z");
    expect(restricted.audience_kind).toBe("restricted");
    expect(restricted.audience_scope).toBe("slack:T/C");
    expect((JSON.parse(restricted.acl_json as string) as { principals: string[] }).principals).toEqual(["U1"]);
    expect(restricted.source_hash).toBe(sourceHash("github", "pr-a"));
  });
});

describe("archiver: erasure keys", () => {
  it("I-3: every lake row carries the actor's source hash and the place's scope hash, also for project-wide rows with no developer id", () => {
    const row = toLakeEventRow(event("a", { actor: { sourceId: "U123", trust: "outsider" } }), "2026-05-01T00:00:00Z");
    expect(row.actor_source_hash).toBe(actorSourceHash("github", "U123"));
    expect(row.actor_developer_id).toBeNull();
    expect(row.scope_hash).toBe(scopeHash("github:repo/1"));
    expect(row.audience_scope).toBeNull();
    expect(toLakeEventRow(event("b"), "2026-05-01T00:00:00Z").actor_source_hash).toBeNull();
  });
  it("I-3: a restricted row without an explicit scope uses its ACL scope; a row with neither is refused", () => {
    const restrictedNoScope = event("a", { scope: undefined, audience: { kind: "restricted", acl: { source: "slack", scope: "slack:T/C9", capturedAt: "2026-01-01T00:00:00Z", liveCheck: "none" } } });
    expect(toLakeEventRow(restrictedNoScope, "2026-05-01T00:00:00Z").scope_hash).toBe(scopeHash("slack:T/C9"));
    expect(() => toLakeEventRow(event("a", { scope: undefined }), "2026-05-01T00:00:00Z")).toThrow(/no source scope/);
  });
  it("I-3: the archiver skips a row with no scope and counts it", async () => {
    const h = harness([event("a", { scope: undefined }), event("b")]);
    expect(await runArchive(h.deps, { workspaceId: "ws1", budget })).toMatchObject({ archived: 1, skippedNoScope: 1 });
    expect(h.marked).toEqual(["b"]);
  });
  it("M-9: Public Slack text never reaches the lake, whatever the stored retention", () => {
    expect(toLakeEventRow(event("a", { source: "slack" }), "2026-05-01T00:00:00Z", "public").text).toBeNull();
    expect(toLakeEventRow(event("a", { source: "slack" }), "2026-05-01T00:00:00Z", "enterprise").text).toBe("text a");
  });
});

describe("archiver: delete during the run (I-4)", () => {
  it("queues the lake delete and deletes the vector of a row that died after the first check, and does not mark it archived", async () => {
    const h = harness([event("a"), event("b")], { liveOverride: (ids, call) => (call === 2 ? ids.filter((id) => id !== "b") : ids) });
    const summary = await runArchive(h.deps, { workspaceId: "ws1", budget });
    expect(summary).toMatchObject({ archived: 1, lateTombstoned: 1 });
    expect(h.marked).toEqual(["a"]);
    expect(h.queued).toEqual([{ kind: "source", sourceHash: sourceHash("github", "pr-b") }]);
    expect(h.vectorDeletes).toEqual(["event:b"]);
  });
  it("when the second check cannot be made it queues the batch's lake deletes, marks nothing and stops", async () => {
    const h = harness([event("a"), event("b")], { filterLiveThrowsOn: 2 });
    const summary = await runArchive(h.deps, { workspaceId: "ws1", budget });
    expect(summary.halted).toBe("hot_unavailable");
    expect(h.marked).toEqual([]);
    expect(h.queued).toHaveLength(2);
    expect(h.vectorDeletes).toEqual([]);
  });
});

describe("archiver", () => {
  it("inserts in batches, re-tags vectors as lake, and marks rows archived", async () => {
    const h = harness([event("a"), event("b"), event("c")]);
    const summary = await runArchive(h.deps, { workspaceId: "ws1", budget });
    expect(summary).toMatchObject({ archived: 3, vectorsRetagged: 3, retryLater: 0, skippedTombstoned: 0 });
    expect(h.sql).toHaveLength(2);
    expect(h.puts.every((p) => p.metadata.tier === "lake")).toBe(true);
    expect(h.marked.sort()).toEqual(["a", "b", "c"]);
  });
  it("sends no raw text to the lake for a C row, and does not touch its vector", async () => {
    const h = harness([event("a", { retention: "C" })]);
    await runArchive(h.deps, { workspaceId: "ws1", budget });
    expect(h.sql[0]!.parameters.join("|")).not.toContain("text a");
    expect(h.puts).toHaveLength(0);
    expect(h.marked).toEqual(["a"]);
  });
  it("never archives a tombstoned row, nor one that was deleted during the run", async () => {
    const h = harness([event("a", { tombstone: { at: "2026-02-01T00:00:00Z", cause: "source_deleted" } }), event("b"), event("c")], { liveOverride: (ids, call) => (call === 1 ? ids.filter((id) => id !== "c") : ids) });
    const summary = await runArchive(h.deps, { workspaceId: "ws1", budget });
    expect(summary.skippedTombstoned).toBe(2);
    expect(h.marked).toEqual(["b"]);
    expect(h.sql.flatMap((s) => s.parameters).join("|")).not.toContain("pr-a");
  });
  it("refuses a row from another workspace", async () => {
    const h = harness([event("a", { workspaceId: "other" })]);
    await runArchive(h.deps, { workspaceId: "ws1", budget });
    expect(h.sql).toHaveLength(0);
    expect(h.marked).toEqual([]);
  });
  it("halts when the lake is down, marks nothing, and reports where to resume", async () => {
    const h = harness([event("a"), event("b"), event("c")], { lakeFail: true });
    const summary = await runArchive(h.deps, { workspaceId: "ws1", budget });
    expect(summary.halted).toBe("lake_unavailable");
    expect(summary.archived).toBe(0);
    expect(h.marked).toEqual([]);
  });
  it("leaves a row unmarked when its vector re-tag fails, so the next run retries it", async () => {
    const h = harness([event("a"), event("b")], { putFail: ["event:b"] });
    const first = await runArchive(h.deps, { workspaceId: "ws1", budget });
    expect(first).toMatchObject({ archived: 1, retryLater: 1 });
    expect(h.marked).toEqual(["a"]);
    const second = await runArchive({ ...h.deps, vectors: { ...h.deps.vectors, put: async (items) => ({ done: items.length, failed: [] }) } }, { workspaceId: "ws1", budget });
    expect(second.archived).toBe(1);
    expect(h.marked).toEqual(["a", "b"]);
  });
  it("archives a row whose vector is already gone and counts it", async () => {
    const h = harness([event("a")], { missingVectors: ["event:a"] });
    expect(await runArchive(h.deps, { workspaceId: "ws1", budget })).toMatchObject({ archived: 1, vectorsMissing: 1 });
  });
  it("stops at the row budget and returns a cursor", async () => {
    const h = harness(Array.from({ length: 20 }, (_, i) => event(`e${i}`)));
    const summary = await runArchive(h.deps, { workspaceId: "ws1", budget: { maxRows: 4, maxMs: 60_000 } });
    expect(summary.archived).toBeLessThanOrEqual(10);
    expect(summary.halted).toBe("budget");
    expect(summary.cursor).toBeDefined();
  });
  it("is idempotent: the insert statement itself skips ids already in the lake", async () => {
    const h = harness([event("a")]);
    await runArchive(h.deps, { workspaceId: "ws1", budget });
    expect(h.sql[0]!.sql).toContain("WHERE NOT EXISTS");
  });
});
