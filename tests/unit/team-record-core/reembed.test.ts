// The re-embed job (review H1 and M3): rows that should have a vector and do not get one from their kept text; rows whose text is gone stay keyword-only; nothing runs unbounded; a vector never
// outlives its row because of the job. Plus what ingest records on a row it embeds (the spec, a cut).
import { describe, expect, it } from "vitest";
import { TEAM_RECORD_EMBEDDER } from "@agentx/contracts";
import { REEMBED_IDLE_MS, REEMBED_SWEEP_MAX_CHECKS, readReembedStates, reembedRows, reembedRun, sweepReembedState, sweepReembedStateRun, type ReembedBudget, type ReembedRun } from "../../../packages/broker/src/team-record/reembed.js";
import { eventFromItem } from "../../../packages/broker/src/team-record/store.js";
import { expireRawText } from "../../../packages/broker/src/team-record/text-expiry.js";
import type { RecordEmbedder } from "../../../packages/broker/src/team-record/types.js";
import { GITHUB_SCOPE, ORG_A, ORG_B, addSource, githubDraft, rows, world, type World } from "../../support/team-record-core.js";

const DAY = 86_400_000;
const SPEC = TEAM_RECORD_EMBEDDER.spec;
const BUDGET: ReembedBudget = { maxRows: 100, maxScanned: 1_000, callMs: 1, warmCallMs: 1 };

/** The job's embedder: the current spec, and a hook that sees every text it is asked for. */
function jobEmbedder(over: Partial<RecordEmbedder & { truncate: (text: string) => boolean; during: (text: string) => Promise<void> | void; fail: boolean }> = {}): RecordEmbedder & { readonly spec: string; calls: string[]; deadlines: Array<number | undefined>; fail: boolean } {
  const calls: string[] = [];
  const deadlines: Array<number | undefined> = [];
  const embedder = {
    spec: SPEC, calls, deadlines, fail: over.fail ?? false,
    async embed(text: string) { return (await embedder.embedWithInfo(text)).vector; },
    async embedWithInfo(text: string, _purpose?: "document" | "query", call?: { deadline?: number }) {
      calls.push(text);
      deadlines.push(call?.deadline);
      if (embedder.fail) throw new Error("secret text of the failure");
      await over.during?.(text);
      return { vector: [0.4, 0.5, 0.6], truncated: over.truncate?.(text) ?? false };
    },
  };
  return embedder;
}

async function put(w: World, id: string, extra: Record<string, unknown> = {}) {
  return w.sink.put(githubDraft({ sourceRef: { system: "github.com", id, version: "1" }, links: [], text: `text of ${id}`, retention: "C", ...extra }));
}
const stored = (w: World, id: string) => rows(w, "TEAM_RECORD_EVENT").find((item) => (item.sourceRef as { id: string }).id === id)!;
const idOf = (w: World, id: string) => stored(w, id).id as string;

async function setup(): Promise<World> {
  const w = world();
  await addSource(w, { source: "github", scope: GITHUB_SCOPE, retention: "C" });
  return w;
}
/** Makes a stored row look like one embedded by the Titan-era broker: a vector reference and no spec. */
function asLegacy(w: World, id: string): void {
  const item = stored(w, id);
  delete item.embeddingSpec;
  item.embeddingRef = `event:${item.id as string}`;
  delete item.embedPending;
  w.db.set(item);
}
const logger = (w: World) => (event: string, fields: Record<string, unknown>): void => { w.logs.push({ event, fields: { ...fields } }); };
/** One turn of one workspace in a run that has a day to go (so the run's own deadline never ends a test by accident). */
const run = (w: World, embedder: RecordEmbedder & { spec: string }, budget: ReembedBudget = BUDGET, shared: ReembedRun = { deadline: w.clock.ms + 86_400_000, warm: false, failuresInARow: 0 }) => reembedRows({ table: w.table, embedder, vectors: w.vectors, now: () => w.clock.ms, log: logger(w) }, ORG_A, budget, shared);

describe("what ingest records on a row it embeds", () => {
  it("the spec the vector was made with, and whether the text was cut", async () => {
    const w = await setup();
    w.deps.embedder = jobEmbedder({ truncate: (text) => text.includes("long") });
    await put(w, "fits");
    await put(w, "long-one", { text: "a long text" });
    expect(stored(w, "fits")).toMatchObject({ embeddingSpec: SPEC, embeddingRef: expect.stringMatching(/^event:/) as string });
    expect(stored(w, "fits")).not.toHaveProperty("embeddingTruncated");
    expect(stored(w, "fits")).not.toHaveProperty("embedPending");
    expect(stored(w, "long-one")).toMatchObject({ embeddingSpec: SPEC, embeddingTruncated: true });
    expect(w.logs.filter((entry) => entry.event === "record.embed_truncated")).toHaveLength(1);
    // the row still reads (the strict schema knows the new fields)
    expect(eventFromItem(stored(w, "long-one"))).toMatchObject({ embeddingTruncated: true });
  });
  it("a row written while the embedder was away keeps embedPending and no vector", async () => {
    const w = await setup();
    w.deps.embedder = jobEmbedder({ fail: true });
    await put(w, "pending");
    expect(stored(w, "pending")).toMatchObject({ embedPending: true });
    expect(stored(w, "pending")).not.toHaveProperty("embeddingRef");
  });
});

describe("the re-embed job", () => {
  it("embeds a row that is embedPending, from its kept text, and then leaves it alone", async () => {
    const w = await setup();
    w.deps.embedder = jobEmbedder({ fail: true });
    await put(w, "pending");
    const job = jobEmbedder();
    expect(await run(w, job)).toMatchObject({ embedded: 1, failed: 0, skipped: 0, more: false });
    expect(job.calls).toEqual(["text of pending"]);
    expect(stored(w, "pending")).toMatchObject({ embeddingSpec: SPEC, embeddingRef: `event:${idOf(w, "pending")}` });
    expect(stored(w, "pending")).not.toHaveProperty("embedPending");
    expect(w.vectorItems.at(-1)).toMatchObject({ key: `event:${idOf(w, "pending")}`, vector: [0.4, 0.5, 0.6], metadata: { kind: "event", project: "web", tier: "hot" } });
    expect(await run(w, job)).toMatchObject({ embedded: 0 });
    expect(job.calls).toHaveLength(1);
  });

  it("embeds again a row whose vector is of another spec or of the Titan era (no spec recorded), and a row stored while the install had no embedder, and leaves a current row alone", async () => {
    const w = await setup();
    w.deps.embedder = jobEmbedder();
    for (const id of ["current", "titan", "other"]) await put(w, id);
    delete w.deps.embedder;
    await put(w, "never");
    asLegacy(w, "titan");
    const other = stored(w, "other");
    other.embeddingSpec = "0123456789abcdef";
    w.db.set(other);
    const job = jobEmbedder();
    expect(stored(w, "never")).toMatchObject({ embedPending: true });
    expect(await run(w, job)).toMatchObject({ embedded: 3 });
    expect(job.calls.sort()).toEqual(["text of never", "text of other", "text of titan"]);
    expect(stored(w, "titan")).toMatchObject({ embeddingSpec: SPEC });
    expect(stored(w, "other")).toMatchObject({ embeddingSpec: SPEC });
    expect(stored(w, "never")).toMatchObject({ embeddingSpec: SPEC });
    expect(stored(w, "current")).toMatchObject({ embeddingSpec: SPEC });
  });

  it("records a cut on the row and counts it", async () => {
    const w = await setup();
    w.deps.embedder = jobEmbedder({ fail: true });
    await put(w, "big", { text: "long text" });
    expect(await run(w, jobEmbedder({ truncate: () => true }))).toMatchObject({ embedded: 1 });
    expect(stored(w, "big")).toMatchObject({ embeddingTruncated: true });
    expect(w.logs.some((entry) => entry.event === "record.embed_truncated")).toBe(true);
  });

  it("cannot re-embed a row whose raw text expired: it stays without a vector (keyword-only), and nothing is asked of the embedder", async () => {
    const w = await setup();
    w.deps.embedder = jobEmbedder();
    await put(w, "old");
    asLegacy(w, "old");
    w.clock.ms += 40 * DAY;
    expect(await expireRawText({ table: w.table, vectors: w.vectors, now: () => w.clock.ms }, ORG_A)).toMatchObject({ expired: 1 });
    expect(stored(w, "old")).not.toHaveProperty("text");
    expect(stored(w, "old")).not.toHaveProperty("embeddingSpec");
    const job = jobEmbedder();
    expect(await run(w, job)).toMatchObject({ embedded: 0, scanned: 0 });
    expect(job.calls).toEqual([]);
  });

  it("stops after two failures in a row (the embedder is down), reports more work, and logs counts only", async () => {
    const w = await setup();
    w.deps.embedder = jobEmbedder({ fail: true });
    for (const id of ["a", "b", "c"]) await put(w, id);
    const job = jobEmbedder({ fail: true });
    expect(await run(w, job)).toMatchObject({ embedded: 0, failed: 2, more: true });
    expect(job.calls).toHaveLength(2);
    expect(JSON.stringify(w.logs)).not.toContain("secret");
    job.fail = false;
    expect(await run(w, job)).toMatchObject({ embedded: 3, failed: 0, more: false });
  });

  it("is bounded in rows and in time: it leaves the rest for the next run", async () => {
    const w = await setup();
    w.deps.embedder = jobEmbedder({ fail: true });
    for (const id of ["a", "b", "c", "d"]) await put(w, id);
    const job = jobEmbedder();
    expect(await run(w, job, { ...BUDGET, maxRows: 2 })).toMatchObject({ embedded: 2, more: true });
    // no call is started unless the call's longest wait still fits in the run
    expect(await run(w, job, { ...BUDGET, callMs: 20, warmCallMs: 20 }, { deadline: w.clock.ms + 10, warm: false, failuresInARow: 0 })).toMatchObject({ embedded: 0, more: true });
    expect(await run(w, job)).toMatchObject({ embedded: 2, more: false });
  });

  it("takes the rows closest to losing their text first", async () => {
    const w = await setup();
    w.deps.embedder = jobEmbedder({ fail: true });
    await put(w, "newer", { occurredAt: new Date(w.clock.ms - 1 * DAY).toISOString() });
    await put(w, "older", { occurredAt: new Date(w.clock.ms - 20 * DAY).toISOString() });
    const job = jobEmbedder();
    await run(w, job, { ...BUDGET, maxRows: 1 });
    expect(job.calls).toEqual(["text of older"]);
  });

  it("removes the vector again when the row was erased while it was being embedded, and marks nothing", async () => {
    const w = await setup();
    w.deps.embedder = jobEmbedder({ fail: true });
    await put(w, "gone");
    const job = jobEmbedder({ during: () => { const item = stored(w, "gone"); delete item.text; delete item.textExpiresAt; w.db.set(item); } });
    expect(await run(w, job)).toMatchObject({ embedded: 0, skipped: 1, failed: 0 });
    expect(w.vectorDeletes.flat()).toEqual([`event:${idOf(w, "gone")}`]);
    expect(stored(w, "gone")).not.toHaveProperty("embeddingSpec");
  });

  it("does not touch another workspace's rows, and a vector index that refuses the put counts as a failure", async () => {
    const w = await setup();
    await addSource(w, { orgId: ORG_B, source: "github", scope: GITHUB_SCOPE, retention: "C" });
    w.deps.embedder = jobEmbedder({ fail: true });
    await w.sink.put(githubDraft({ workspaceId: ORG_B, sourceRef: { system: "github.com", id: "b-row", version: "1" }, links: [], text: "workspace B text" }));
    const job = jobEmbedder();
    expect(await run(w, job)).toMatchObject({ embedded: 0, scanned: 0 });
    expect(job.calls).toEqual([]);
    await put(w, "a-row");
    w.vectors.failPut = true;
    expect(await run(w, job)).toMatchObject({ embedded: 0, failed: 1 });
    expect(stored(w, "a-row")).toMatchObject({ embedPending: true });
  });
});

// ---- review R2 and R3: every row is reached, workspaces take turns, and a run ends inside its deadline

/** Stores `count` rows in a workspace, each with its own, later expiry than the one before (the index is read soonest-expiry first). */
async function fill(w: World, orgId: typeof ORG_A, prefix: string, count: number, from = 0): Promise<void> {
  for (let index = from; index < from + count; index += 1) {
    await w.sink.put(githubDraft({ workspaceId: orgId, sourceRef: { system: "github.com", id: `${prefix}${String(index).padStart(5, "0")}`, version: "1" }, links: [], text: `text of ${prefix}${String(index)}`, retention: "C", occurredAt: new Date(w.clock.ms - 25 * DAY + index * 1000).toISOString() }));
  }
}
const pendingCount = (w: World, orgId: typeof ORG_A): number => w.db.find((item) => item.entityType === "TEAM_RECORD_EVENT" && item.workspaceId === orgId && item.embedPending === true).length;
const directory = (w: World, orgs: Array<typeof ORG_A>): void => { for (const orgId of orgs) w.db.set({ pk: "TEAM_RECORD_ORGS", sk: orgId, entityType: "TEAM_RECORD_ORG", orgId, at: "2026-10-30T12:00:00.000Z" }); };
const runAll = (w: World, embedder: RecordEmbedder & { spec: string }, budget: ReembedBudget, runMs: number) => reembedRun({ table: w.table, embedder, vectorsFor: async () => w.vectors, now: () => w.clock.ms, log: logger(w) }, w.clock.ms, budget, runMs);

describe("the re-embed job reaches every row (review R2)", () => {
  it("reaches a pending row behind more than 1,000 rows that are already current, over successive runs (a stored cursor), and not by luck of order", async () => {
    const w = await setup();
    w.deps.embedder = jobEmbedder();
    await fill(w, ORG_A, "cur", 1_050);
    w.deps.embedder = jobEmbedder({ fail: true });
    await fill(w, ORG_A, "new", 60, 2_000);
    expect(pendingCount(w, ORG_A)).toBe(60);
    const job = jobEmbedder();
    // run 1 reads the first 1,000 rows (all current): nothing to embed, but it remembers where it stopped
    const first = await run(w, job);
    expect(first).toMatchObject({ embedded: 0, more: true });
    expect(first.scanned).toBeGreaterThanOrEqual(1_000);
    expect(job.calls).toEqual([]);
    // run 2 continues from there and reaches every pending row; the pass then ends
    const second = await run(w, job);
    expect(second).toMatchObject({ embedded: 60, more: false });
    expect(pendingCount(w, ORG_A)).toBe(0);
    expect(job.calls).toHaveLength(60);
    // the pass is over, with work found: the next one starts again from the beginning (and finds nothing to do)
    const third = await run(w, job);
    expect(third.embedded).toBe(0);
  }, 120_000);

  it("a turn stopped in the middle of a page repeats that page, so no row is skipped; a row that failed once is retried on the next pass, not at the head of every run", async () => {
    const w = await setup();
    w.deps.embedder = jobEmbedder({ fail: true });
    await fill(w, ORG_A, "row", 7);
    const job = jobEmbedder();
    expect(await run(w, job, { ...BUDGET, maxRows: 3 })).toMatchObject({ embedded: 3, more: true });
    expect(await run(w, job, { ...BUDGET, maxRows: 3 })).toMatchObject({ embedded: 3, more: true });
    expect(await run(w, job, { ...BUDGET, maxRows: 3 })).toMatchObject({ embedded: 1, more: false });
    expect(new Set(job.calls).size).toBe(7);
    expect(pendingCount(w, ORG_A)).toBe(0);
  });

  it("drops a stored cursor that is not a key of the workspace's own index (the pass starts again)", async () => {
    const w = await setup();
    w.deps.embedder = jobEmbedder({ fail: true });
    await fill(w, ORG_A, "row", 2);
    w.db.set({ pk: "TEAM_RECORD_ORGS", sk: `REEMBED#${ORG_A}`, entityType: "TEAM_RECORD_REEMBED_STATE", orgId: ORG_A, servedAt: 1, idleUntil: 0, passWork: 5, cursor: { pk: "x", sk: "y", gsi5pk: `WS#${ORG_B}#TEXTDUE`, textDueAt: "2099-01-01T00:00:00.000Z" } });
    expect(await run(w, jobEmbedder())).toMatchObject({ embedded: 2, more: false });
  });

  it("N1: a stored cursor whose due time has passed is dropped, so the pass starts again instead of DynamoDB refusing the start key (the workspace re-embeds again)", async () => {
    const w = await setup();
    w.deps.embedder = jobEmbedder();
    await fill(w, ORG_A, "cur", 150);
    // pending rows that only expire in about 7 days from now (their index time is far beyond the cursor)
    w.deps.embedder = jobEmbedder({ fail: true });
    await fill(w, ORG_A, "late", 2, 600_000);
    const job = jobEmbedder();
    // run 1 reads one page of 100 rows and stores the cursor on the last of them (due in about 5 days)
    expect(await run(w, job, { ...BUDGET, maxScanned: 100 })).toMatchObject({ embedded: 0, more: true });
    const cursorDue = (w.db.get({ pk: "TEAM_RECORD_ORGS", sk: `REEMBED#${ORG_A}` })!.cursor as { textDueAt: string }).textDueAt;
    expect(Date.parse(cursorDue)).toBeGreaterThan(w.clock.ms);
    // six days later the cursor's time is in the past: the old query refused its own start key (ValidationException) and the workspace was never served again
    w.clock.ms += 6 * DAY;
    expect(Date.parse(cursorDue)).toBeLessThan(w.clock.ms);
    expect(await run(w, job)).toMatchObject({ embedded: 2, more: false });
    expect(pendingCount(w, ORG_A)).toBe(0);
    expect(w.db.refusals).toEqual([]);
  }, 120_000);

  it("N1: if DynamoDB still refuses the start key, that workspace's state is reset and the turn goes on from the beginning (and the saved state has no cursor of the old pass)", async () => {
    const w = await setup();
    w.deps.embedder = jobEmbedder();
    await fill(w, ORG_A, "cur", 150);
    w.deps.embedder = jobEmbedder({ fail: true });
    await fill(w, ORG_A, "late", 2, 600_000);
    const job = jobEmbedder();
    await run(w, job, { ...BUDGET, maxScanned: 100 });
    expect(w.db.get({ pk: "TEAM_RECORD_ORGS", sk: `REEMBED#${ORG_A}` })!.cursor).toBeDefined();
    w.db.injectFault({ command: "QueryCommand", match: (input) => input.ExclusiveStartKey !== undefined && input.IndexName === "gsi5", error: { name: "ValidationException", message: "The provided starting key is outside query boundaries based on provided conditions" } });
    expect(await run(w, job)).toMatchObject({ embedded: 2, more: false });
    expect(pendingCount(w, ORG_A)).toBe(0);
    expect(w.db.get({ pk: "TEAM_RECORD_ORGS", sk: `REEMBED#${ORG_A}` })).toMatchObject({ passWork: 0, idleUntil: 0 });
    expect(w.db.get({ pk: "TEAM_RECORD_ORGS", sk: `REEMBED#${ORG_A}` })!.cursor).toBeUndefined();
  }, 120_000);

  it("a pass that found nothing to do lets the workspace rest for an hour, and the next pass after that looks again", async () => {
    const w = await setup();
    directory(w, [ORG_A]);
    w.deps.embedder = jobEmbedder();
    await fill(w, ORG_A, "row", 3);
    const job = jobEmbedder();
    const first = await runAll(w, job, BUDGET, 1_000_000);
    expect(first).toMatchObject({ orgs: 1, details: { embedded: 0 } });
    expect((await readReembedStates(w.table)).get(ORG_A)).toMatchObject({ idleUntil: w.clock.ms + REEMBED_IDLE_MS });
    // resting: not read at all (no turn, counted as idle)
    const second = await runAll(w, job, BUDGET, 1_000_000);
    expect(second).toMatchObject({ orgs: 0, details: { idle: 1 } });
    // a row written meanwhile with no vector is found once the hour is over
    w.deps.embedder = jobEmbedder({ fail: true });
    await fill(w, ORG_A, "late", 1, 100);
    w.clock.ms += REEMBED_IDLE_MS + 1;
    expect(await runAll(w, job, BUDGET, 1_000_000)).toMatchObject({ orgs: 1, details: { embedded: 1 } });
  });
});

describe("workspaces take turns (review R2)", () => {
  it("a workspace with a large backlog does not hold every run: the least recently served goes first and each run's time is shared", async () => {
    const w = await setup();
    await addSource(w, { orgId: ORG_B, source: "github", scope: GITHUB_SCOPE, retention: "C" });
    directory(w, [ORG_A, ORG_B]);
    w.deps.embedder = jobEmbedder({ fail: true });
    await fill(w, ORG_A, "a", 6);
    await fill(w, ORG_B, "b", 6);
    // every call takes one second of the (fake) clock; a run is 3.5 s: the first workspace gets 3 s of it, the second would get 0.5 s, which is too little to start a turn
    const job = jobEmbedder({ during: () => { w.clock.ms += 1_000; } });
    const perOrg = (orgId: typeof ORG_A): number => w.db.find((item) => item.entityType === "TEAM_RECORD_EVENT" && item.workspaceId === orgId && item.embedPending !== true).length;
    const one = await runAll(w, job, BUDGET, 3_500);
    expect(one).toMatchObject({ orgs: 1, skippedOrgs: 1 });
    expect([perOrg(ORG_A), perOrg(ORG_B)]).toEqual([3, 0]);
    // the next run starts with the workspace that waited
    const two = await runAll(w, job, BUDGET, 3_500);
    expect(two.details.embedded).toBe(3);
    expect([perOrg(ORG_A), perOrg(ORG_B)]).toEqual([3, 3]);
    const three = await runAll(w, job, BUDGET, 3_500);
    expect(three.details.embedded).toBe(3);
    expect([perOrg(ORG_A), perOrg(ORG_B)]).toEqual([6, 3]);
  }, 60_000);

  it("shares one run between workspaces when there is time for both, and stops the whole run after two failures in a row over workspaces", async () => {
    const w = await setup();
    await addSource(w, { orgId: ORG_B, source: "github", scope: GITHUB_SCOPE, retention: "C" });
    directory(w, [ORG_A, ORG_B]);
    w.deps.embedder = jobEmbedder({ fail: true });
    await fill(w, ORG_A, "a", 2);
    await fill(w, ORG_B, "b", 2);
    const up = jobEmbedder();
    expect(await runAll(w, up, BUDGET, 1_000_000)).toMatchObject({ orgs: 2, details: { embedded: 4 } });
    w.deps.embedder = jobEmbedder({ fail: true });
    await fill(w, ORG_A, "c", 2, 50);
    await fill(w, ORG_B, "d", 2, 50);
    const down = jobEmbedder({ fail: true });
    const stopped = await runAll(w, down, BUDGET, 1_000_000);
    // one failure in each workspace is two in a row: the run ends, the second workspace is not asked again
    expect(down.calls).toHaveLength(2);
    expect(stopped.details.failed).toBe(2);
  });
});

describe("a turn that starts no call, and a workspace that is closing (N4, N5)", () => {
  it("N4: a workspace whose turn started no call keeps its old servedAt, so it stays at the front of the order", async () => {
    const w = await setup();
    directory(w, [ORG_A]);
    w.deps.embedder = jobEmbedder({ fail: true });
    await fill(w, ORG_A, "r", 3);
    w.db.set({ pk: "TEAM_RECORD_ORGS", sk: `REEMBED#${ORG_A}`, entityType: "TEAM_RECORD_REEMBED_STATE", orgId: ORG_A, servedAt: 777, idleUntil: 0, passWork: 0 });
    const job = jobEmbedder();
    // a cold call needs 20 s but the run has 10 s: no call is started, and the turn does not count as a turn
    await runAll(w, job, { ...BUDGET, callMs: 20_000 }, 10_000);
    expect(job.calls).toEqual([]);
    expect((await readReembedStates(w.table)).get(ORG_A)).toMatchObject({ servedAt: 777 });
    // a turn that does call moves it
    await runAll(w, job, { ...BUDGET, callMs: 20_000 }, 30_000);
    expect(job.calls).toHaveLength(3);
    expect((await readReembedStates(w.table)).get(ORG_A)!.servedAt).toBe(w.clock.ms);
  });

  it("N5: a workspace with a whole-workspace erase job, or one that is closing, is not served in the re-embed run (positive control: it is served when neither holds)", async () => {
    const w = await setup();
    await addSource(w, { orgId: ORG_B, source: "github", scope: GITHUB_SCOPE, retention: "C" });
    directory(w, [ORG_A, ORG_B]);
    w.deps.embedder = jobEmbedder({ fail: true });
    await fill(w, ORG_A, "a", 2);
    await fill(w, ORG_B, "b", 2);
    const closing = new Set<string>();
    const runWith = (job: ReturnType<typeof jobEmbedder>) => reembedRun({ table: w.table, embedder: job, vectorsFor: async () => w.vectors, isClosing: async (orgId) => closing.has(orgId), now: () => w.clock.ms, log: logger(w) }, w.clock.ms, BUDGET, 1_000_000);
    // A has an erase job; B is closing: neither is touched
    w.db.set({ pk: "TEAM_RECORD_ORGS", sk: `ERASE#${ORG_A}#workspace#all`, entityType: "TEAM_RECORD_ERASE_JOB", orgId: ORG_A, job: { kind: "workspace", phase: "hot", projects: [] } });
    closing.add(ORG_B);
    const blocked = jobEmbedder();
    const first = await runWith(blocked);
    expect(blocked.calls).toEqual([]);
    expect(first.details).toMatchObject({ closing: 2, embedded: 0 });
    expect(pendingCount(w, ORG_A)).toBe(2);
    expect(pendingCount(w, ORG_B)).toBe(2);
    expect(w.db.get({ pk: "TEAM_RECORD_ORGS", sk: `REEMBED#${ORG_A}` })).toBeUndefined();
    // a project erase of A does not stop A (only the whole-workspace erase does); B is open again
    w.db.delete({ pk: "TEAM_RECORD_ORGS", sk: `ERASE#${ORG_A}#workspace#all` });
    w.db.set({ pk: "TEAM_RECORD_ORGS", sk: `ERASE#${ORG_A}#project#p`, entityType: "TEAM_RECORD_ERASE_JOB", orgId: ORG_A, job: { kind: "project", project: "p", cause: "project_archived" } });
    closing.clear();
    const open = jobEmbedder();
    expect(await runWith(open)).toMatchObject({ details: { embedded: 4 } });
    expect(pendingCount(w, ORG_A) + pendingCount(w, ORG_B)).toBe(0);
  });

  it("N5: the hourly clean-up deletes REEMBED# rows of workspaces that left the directory or are closing, and keeps those of open ones", async () => {
    const w = await setup();
    directory(w, [ORG_A, ORG_B]);
    for (const orgId of [ORG_A, ORG_B]) w.db.set({ pk: "TEAM_RECORD_ORGS", sk: `REEMBED#${orgId}`, entityType: "TEAM_RECORD_REEMBED_STATE", orgId, servedAt: 5, idleUntil: 0, passWork: 0 });
    const gone = "org_gone0000000000000000" as typeof ORG_A;
    w.db.set({ pk: "TEAM_RECORD_ORGS", sk: `REEMBED#${gone}`, entityType: "TEAM_RECORD_REEMBED_STATE", orgId: gone, servedAt: 5, idleUntil: 0, passWork: 0 });
    // nothing closing: only the one outside the directory goes
    expect(await sweepReembedState(w.table, async () => false)).toBe(1);
    expect([...(await readReembedStates(w.table)).keys()].sort()).toEqual([ORG_A, ORG_B].sort());
    // B closing: its row goes too
    expect(await sweepReembedState(w.table, async (orgId) => orgId === ORG_B)).toBe(1);
    expect([...(await readReembedStates(w.table)).keys()]).toEqual([ORG_A]);
  });

  // EMB-7 M1: the sweep read one State per workspace with no limit, so it could eat the hourly run's GitHub pass.
  describe("EMB-7 M1: the clean-up has a time limit and a cap per run, and resumes next hour", () => {
    const HOUR = 3_600_000;
    const orgNames = (count: number): Array<typeof ORG_A> => Array.from({ length: count }, (_, index) => `org_sweep${String(index).padStart(15, "0")}` as typeof ORG_A);
    function crowd(w: World, orgs: Array<typeof ORG_A>): void {
      directory(w, orgs);
      for (const orgId of orgs) w.db.set({ pk: "TEAM_RECORD_ORGS", sk: `REEMBED#${orgId}`, entityType: "TEAM_RECORD_REEMBED_STATE", orgId, servedAt: 5, idleUntil: 0, passWork: 0 });
    }

    it("starts nothing once the deadline has passed: no directory read, no check, no delete", async () => {
      const w = await setup();
      const orgs = orgNames(3);
      crowd(w, orgs);
      const asked: string[] = [];
      const run = await sweepReembedStateRun(w.table, async (orgId) => { asked.push(orgId); return true; }, { now: () => w.clock.ms, deadline: w.clock.ms });
      expect(run).toMatchObject({ deleted: 0, checked: 0, stopped: true });
      expect(asked).toEqual([]);
      expect((await readReembedStates(w.table)).size).toBe(3);
    });

    it("stops checking workspaces when the deadline comes (each check takes time) and leaves the rest for the next hour", async () => {
      const w = await setup();
      const orgs = orgNames(10);
      crowd(w, orgs);
      const start = w.clock.ms;
      // every check costs 100 ms; the limit is 350 ms: four checks start (0, 100, 200, 300), the fifth would start at 400
      const asked: string[] = [];
      const first = await sweepReembedStateRun(w.table, async (orgId) => { asked.push(orgId); w.clock.ms += 100; return true; }, { now: () => w.clock.ms, deadline: start + 350 });
      expect(asked).toHaveLength(4);
      expect(first).toMatchObject({ deleted: 4, checked: 4, stopped: true, left: 6 });
      expect((await readReembedStates(w.table)).size).toBe(6);
      // the next hour continues with the ones not yet reached (they were closing: all go) and the first four are gone, so nothing is checked twice
      w.clock.ms = start + HOUR;
      const second = await sweepReembedStateRun(w.table, async (orgId) => { asked.push(orgId); return true; }, { now: () => w.clock.ms, deadline: w.clock.ms + 60_000 });
      expect(second).toMatchObject({ deleted: 6, stopped: false, left: 0 });
      expect(new Set(asked).size).toBe(10);
      expect((await readReembedStates(w.table)).size).toBe(0);
    });

    it("checks at most maxChecks workspaces per run, and a different slice each hour, so every live workspace is reached over successive hours", async () => {
      const w = await setup();
      const orgs = orgNames(7);
      crowd(w, orgs);
      const start = w.clock.ms;
      const seen = new Set<string>();
      // nobody is closing: every state stays, so the rotation (not deletion) must be what moves the window
      for (let hour = 0; hour < 4; hour += 1) {
        w.clock.ms = start + hour * HOUR;
        const asked: string[] = [];
        const run = await sweepReembedStateRun(w.table, async (orgId) => { asked.push(orgId); return false; }, { now: () => w.clock.ms, maxChecks: 2 });
        expect(asked.length).toBeLessThanOrEqual(2);
        expect(run).toMatchObject({ deleted: 0, checked: asked.length, stopped: true });
        for (const id of asked) seen.add(id);
      }
      expect(seen.size).toBe(7);
    });

    it("a workspace outside the directory is removed without a closing check, and a failing closing check keeps the state (fail safe) and goes on", async () => {
      const w = await setup();
      const [a, b] = orgNames(2);
      crowd(w, [a!, b!]);
      const gone = "org_gone0000000000000000" as typeof ORG_A;
      w.db.set({ pk: "TEAM_RECORD_ORGS", sk: `REEMBED#${gone}`, entityType: "TEAM_RECORD_REEMBED_STATE", orgId: gone, servedAt: 5, idleUntil: 0, passWork: 0 });
      const asked: string[] = [];
      const run = await sweepReembedStateRun(w.table, async (orgId) => { asked.push(orgId); if (orgId === a) throw new Error("table down"); return true; }, { now: () => w.clock.ms });
      expect(asked.sort()).toEqual([a, b].sort());
      expect(run).toMatchObject({ deleted: 2, failed: 1, stopped: false });
      expect([...(await readReembedStates(w.table)).keys()]).toEqual([a]);
    });

    it("the default cap is bounded (a number of checks that fits an hourly run)", () => {
      expect(REEMBED_SWEEP_MAX_CHECKS).toBeGreaterThan(0);
      expect(REEMBED_SWEEP_MAX_CHECKS).toBeLessThanOrEqual(500);
    });
  });
});

describe("one deadline for the whole run (review R3)", () => {
  it("every call is handed the run's end, and the first call of a run is started only if its full cold wait still fits", async () => {
    const w = await setup();
    directory(w, [ORG_A]);
    w.deps.embedder = jobEmbedder({ fail: true });
    await fill(w, ORG_A, "r", 3);
    const start = w.clock.ms;
    const job = jobEmbedder();
    // 20 s cold wait but only 10 s of the run left: nothing is sent
    const tooLate = await runAll(w, job, { ...BUDGET, callMs: 20_000 }, 10_000);
    expect(job.calls).toEqual([]);
    expect(tooLate.details).toMatchObject({ embedded: 0, more: 1 });
    // with room, every call carries the same run end
    const ok = await runAll(w, job, { ...BUDGET, callMs: 20_000 }, 30_000);
    expect(ok.details.embedded).toBe(3);
    expect(new Set(job.deadlines)).toEqual(new Set([start + 30_000]));
  });

  it("a slow call (the cold start) leaves no time for a second one: the run ends at its deadline and the rest waits for the next run", async () => {
    const w = await setup();
    directory(w, [ORG_A]);
    w.deps.embedder = jobEmbedder({ fail: true });
    await fill(w, ORG_A, "r", 4);
    // the first call takes 20 s of the 25 s run; a warm call needs 8 s, so a second call would end after the deadline: it is not started
    const job = jobEmbedder({ during: () => { w.clock.ms += 20_000; } });
    const started = w.clock.ms;
    const summary = await runAll(w, job, { ...BUDGET, callMs: 20_000, warmCallMs: 8_000 }, 25_000);
    expect(job.calls).toHaveLength(1);
    expect(summary.details).toMatchObject({ embedded: 1, more: 1 });
    expect(w.clock.ms - started).toBeLessThanOrEqual(25_000);
    // the next run continues with the rows that are left
    const next = jobEmbedder();
    expect(await runAll(w, next, BUDGET, 25_000)).toMatchObject({ details: { embedded: 3 } });
  });
});
