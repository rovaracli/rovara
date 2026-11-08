// The re-embed job (review H1 and M3): rows that should have a vector and do not get one from their kept text; rows whose text is gone stay keyword-only; nothing runs unbounded; a vector never
// outlives its row because of the job. Plus what ingest records on a row it embeds (the spec, a cut).
import { describe, expect, it } from "vitest";
import { TEAM_RECORD_EMBEDDER } from "@agentx/contracts";
import { reembedRows, type ReembedBudget } from "../../../packages/broker/src/team-record/reembed.js";
import { eventFromItem } from "../../../packages/broker/src/team-record/store.js";
import { expireRawText } from "../../../packages/broker/src/team-record/text-expiry.js";
import type { RecordEmbedder } from "../../../packages/broker/src/team-record/types.js";
import { GITHUB_SCOPE, ORG_A, ORG_B, addSource, githubDraft, rows, world, type World } from "../../support/team-record-core.js";

const DAY = 86_400_000;
const SPEC = TEAM_RECORD_EMBEDDER.spec;
const BUDGET: ReembedBudget = { maxRows: 100, maxScanned: 1_000, maxMs: 1_000_000, callMs: 1, warmCallMs: 1 };

/** The job's embedder: the current spec, and a hook that sees every text it is asked for. */
function jobEmbedder(over: Partial<RecordEmbedder & { truncate: (text: string) => boolean; during: (text: string) => Promise<void> | void; fail: boolean }> = {}): RecordEmbedder & { readonly spec: string; calls: string[]; fail: boolean } {
  const calls: string[] = [];
  const embedder = {
    spec: SPEC, calls, fail: over.fail ?? false,
    async embed(text: string) { return (await embedder.embedWithInfo(text)).vector; },
    async embedWithInfo(text: string) {
      calls.push(text);
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
const run = (w: World, embedder: RecordEmbedder & { spec: string }, budget: ReembedBudget = BUDGET) => reembedRows({ table: w.table, embedder, vectors: w.vectors, now: () => w.clock.ms, log: (event, fields) => { w.logs.push({ event, fields: { ...fields } }); } }, ORG_A, budget);

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
    expect(await run(w, job, { ...BUDGET, maxMs: 10, callMs: 20, warmCallMs: 20 })).toMatchObject({ embedded: 0, more: true });
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
