// Fix round 4 (Opus recheck-3): N-5 busy places and many child places, N-6 per-span trust in retention B, the GSI3 projection, and the documented tie-break.
import { describe, expect, it } from "vitest";
import { TEAM_RECORD_GSI3, TEAM_RECORD_GSI3_ATTRIBUTES, recordPlaceIndexValue, recordScopeHash } from "@agentx/contracts";
import { runDeleteWorker } from "../../../packages/broker/src/team-record/delete-worker.js";
import { recordSearch } from "../../../packages/broker/src/team-record/query.js";
import { createRecordSink } from "../../../packages/broker/src/team-record/sink.js";
import { createTransientDistiller } from "../../../packages/broker/src/team-record/transient-distiller.js";
import { childScopes, listScopeWork } from "../../../packages/broker/src/team-record/store.js";
import { tableLakeDeleteQueue } from "../../../packages/broker/src/team-record/lake-queue.js";
import { ORG_A, addSource, caller, githubDraft, rows, world, type World } from "../../support/team-record-core.js";
import { deleteDeps } from "../../support/team-record-delete.js";

const T1 = "2026-10-30T09:00:00.000Z";
const slackAcl = (scope: string) => ({ kind: "restricted" as const, acl: { source: "slack", scope, groups: ["T1"], capturedAt: T1, liveCheck: "none" as const } });
const member = caller({ identities: { ids: { slack: ["U1"] }, groups: { slack: ["T1"] } } });
const slackRow = (id: string, scope: string) => githubDraft({ source: "slack", kind: "slack.message", repo: undefined, sourceRef: { system: "T1", id, version: "1" }, audience: slackAcl(scope), actor: { sourceId: "U1", trust: "member" }, text: "layoff plan", links: [] });
const live = (w: World) => rows(w, "TEAM_RECORD_EVENT").filter((item) => item.tombstone === undefined);
const search = (w: World) => recordSearch({ table: w.table, modes: w.deps.modes, now: () => w.clock.ms }, { kind: "caller", caller: member }, "web", { query: "layoff" });
const lakeScopes = async (w: World) => (await tableLakeDeleteQueue(w.table).listPending(ORG_A, 10_000)).flatMap((entry) => (entry.target.kind === "scope" ? [entry.target.hash] : []));
async function runUntilDone(w: World, budget = { maxRequests: 50, maxItems: 500, maxMs: 20_000 }, runs = 40): Promise<number> {
  for (let n = 1; n <= runs; n += 1) {
    await runDeleteWorker(deleteDeps(w).deps, ORG_A, budget);
    if ((await listScopeWork(w.table, ORG_A, 10)).length === 0) return n;
  }
  return -1;
}

describe("N-5 a busy place can always be deleted", () => {
  it("a channel with 2001 rows: the tombstone succeeds, hides everything at once, and the paged delete finishes", async () => {
    const w = world();
    await addSource(w, { source: "slack", scope: "slack:T1/C9" });
    for (let i = 0; i < 2001; i += 1) await w.sink.put(slackRow(`m${String(i)}`, "slack:T1/C9"));
    expect(live(w)).toHaveLength(2001);
    const small = createRecordSink(w.deps, { budget: { maxItems: 500, maxMs: 8_000 } });
    await expect(small.tombstone({ workspaceId: ORG_A, system: "T1", scope: "slack:T1/C9", cause: "source_deleted" })).resolves.toBeDefined();
    // hidden from search before the paged delete has finished
    expect((await search(w)).hits).toEqual([]);
    expect((await listScopeWork(w.table, ORG_A, 10))[0]).toMatchObject({ hidePending: true });
    expect(await lakeScopes(w)).toContain(recordScopeHash("slack:T1/C9"));
    const runs = await runUntilDone(w);
    expect(runs).toBeGreaterThan(1);
    expect(runs).toBeGreaterThan(0);
    expect(rows(w, "TEAM_RECORD_EVENT")).toHaveLength(0);
  }, 120_000);

  it("hiding resumes from a cursor: rows already hidden are not read again, so a place larger than the budget is not stuck", async () => {
    const w = world();
    await addSource(w, { source: "slack", scope: "slack:T1/C9" });
    for (let i = 0; i < 1201; i += 1) await w.sink.put(slackRow(`m${String(i)}`, "slack:T1/C9"));
    await createRecordSink(w.deps, { budget: { maxItems: 500, maxMs: 8_000 } }).tombstone({ workspaceId: ORG_A, system: "T1", scope: "slack:T1/C9", cause: "source_deleted" });
    const [queued] = await listScopeWork(w.table, ORG_A, 10);
    expect(queued!.hideCursor).toBeDefined();
    expect(queued!.hideDone).toBe(false);
    await runDeleteWorker(deleteDeps(w).deps, ORG_A, { maxRequests: 5, maxItems: 500, maxMs: 20_000 });
    const [after] = await listScopeWork(w.table, ORG_A, 10);
    expect(after === undefined || after.hideCursor !== queued!.hideCursor).toBe(true);
    expect(rows(w, "TEAM_RECORD_EVENT").filter((item) => item.tombstone !== undefined).length).toBeGreaterThanOrEqual(1000);
    expect(await runUntilDone(w)).toBeGreaterThan(0);
    expect(rows(w, "TEAM_RECORD_EVENT")).toHaveLength(0);
  }, 120_000);

  it("a parent with 2001 child places: the tombstone succeeds, everything under it is hidden at once, and every child reaches the lake", async () => {
    const w = world();
    for (let i = 0; i < 2001; i += 1) await addSource(w, { source: "slack", scope: `slack:T1/C${String(i).padStart(5, "0")}` });
    await w.sink.put(slackRow("m1", "slack:T1/C00007"));
    await createRecordSink(w.deps, { budget: { maxItems: 500, maxMs: 8_000 } }).tombstone({ workspaceId: ORG_A, system: "T1", scope: "slack:T1", cause: "source_deleted" });
    expect((await search(w)).hits).toEqual([]);
    await runUntilDone(w);
    const targets = new Set(await lakeScopes(w));
    expect(targets.has(recordScopeHash("slack:T1"))).toBe(true);
    for (let i = 0; i < 2001; i += 1) expect(targets.has(recordScopeHash(`slack:T1/C${String(i).padStart(5, "0")}`)), `child ${String(i)}`).toBe(true);
    expect(targets.size).toBe(2002);
    expect(rows(w, "TEAM_RECORD_EVENT")).toHaveLength(0);
  }, 180_000);

  it("the lake targets of the child places are all queued BEFORE any row is purged: a worker that runs out of time keeps the rows and the cursor", async () => {
    const w = world();
    for (let i = 0; i < 2601; i += 1) await addSource(w, { source: "slack", scope: `slack:T1/C${String(i).padStart(5, "0")}` });
    await w.sink.put(slackRow("m1", "slack:T1/C00007"));
    await createRecordSink(w.deps, { budget: { maxItems: 500, maxMs: 8_000 } }).tombstone({ workspaceId: ORG_A, system: "T1", scope: "slack:T1", cause: "source_deleted" });
    const [queued] = await listScopeWork(w.table, ORG_A, 10);
    expect(queued!.childCursor).toBeDefined();
    // a clock that runs 400 ms per reading: the worker has time to start and to read a page of places (progress is guaranteed), but not to list them all
    let tick = 0;
    const starved = { ...deleteDeps(w).deps, now: () => (tick += 400) };
    const summary = await runDeleteWorker(starved, ORG_A, { maxRequests: 5, maxItems: 500, maxMs: 1_000 });
    expect(summary.rows).toBe(0);
    expect(rows(w, "TEAM_RECORD_EVENT")).toHaveLength(1);
    expect((await listScopeWork(w.table, ORG_A, 10))[0]!.childCursor).toBeDefined();
    expect(await runUntilDone(w)).toBeGreaterThan(0);
    expect(new Set(await lakeScopes(w)).size).toBe(2602);
    expect(rows(w, "TEAM_RECORD_EVENT")).toHaveLength(0);
  }, 240_000);

  it("finding the places below a place reads only place rows, pages with a cursor and never throws", async () => {
    const w = world();
    for (let i = 0; i < 1201; i += 1) await addSource(w, { source: "slack", scope: `slack:T1/C${String(i).padStart(5, "0")}` });
    await addSource(w, { source: "slack", scope: "slack:T2/C1" });
    for (let i = 0; i < 30; i += 1) await w.sink.put(slackRow(`m${String(i)}`, "slack:T1/C00001"));
    const seen = new Set<string>();
    let cursor: Record<string, unknown> | undefined;
    let pages = 0;
    do {
      const page = await childScopes(w.table, ORG_A, "slack:T1", { limit: 500, ...(cursor === undefined ? {} : { cursor }) });
      page.scopes.forEach((scope) => seen.add(scope));
      cursor = page.cursor;
      pages += 1;
    } while (cursor !== undefined && pages < 10);
    expect(pages).toBe(3);
    expect(seen.size).toBe(1201);
    expect(seen.has("slack:T2/C1")).toBe(false);
    // source rows live in their own partition value; item rows are not among them
    const placeRows = w.db.find((item) => item[TEAM_RECORD_GSI3.partition] === recordPlaceIndexValue(ORG_A, "slack:T1/C00001"));
    expect(placeRows.every((item) => item.entityType === "TEAM_RECORD_SOURCE")).toBe(true);
    expect(w.db.find((item) => item.entityType === "TEAM_RECORD_EVENT").every((item) => item[TEAM_RECORD_GSI3.partition] !== recordPlaceIndexValue(ORG_A, "slack:T1/C00001"))).toBe(true);
  }, 120_000);

  it("works when GSI3 projects only the INCLUDE attributes (what a real index returns)", async () => {
    const w = world();
    await addSource(w, { source: "slack", scope: "slack:T1/C9" });
    await w.sink.put(slackRow("m1", "slack:T1/C9"));
    const wide = w.table.documentClient;
    const keep = new Set<string>(["pk", "sk", TEAM_RECORD_GSI3.partition, TEAM_RECORD_GSI3.sort, ...TEAM_RECORD_GSI3_ATTRIBUTES]);
    w.table.documentClient = { send: async (command: unknown) => {
      const result = await wide.send(command) as { Items?: Array<Record<string, unknown>> };
      const input = (command as { input?: { IndexName?: string } }).input;
      if (input?.IndexName !== TEAM_RECORD_GSI3.index || result.Items === undefined) return result;
      return { ...result, Items: result.Items.map((item) => Object.fromEntries(Object.entries(item).filter(([name]) => keep.has(name)))) };
    } };
    await w.sink.tombstone({ workspaceId: ORG_A, system: "T1", scope: "slack:T1", cause: "source_deleted" });
    expect(live(w)).toEqual([]);
    const summary = await runDeleteWorker({ ...deleteDeps(w).deps, table: w.table }, ORG_A);
    expect(summary).toMatchObject({ rows: 1, finished: 1, blocked: 0 });
    expect(rows(w, "TEAM_RECORD_EVENT")).toHaveLength(0);
  });
});

describe("N-6 retention B: the core's trust is applied per span", () => {
  const run = async (text: string, attachments: boolean) => {
    const w = world({ edition: "public" });
    await addSource(w, { source: "slack", scope: "slack:T1/C9", retention: "B", notesOptIn: true });
    const prompts: string[] = [];
    const model = async ({ user }: { user: string }) => { prompts.push(user); return JSON.stringify({ facts: [{ kind: "note", text: "A note.", links: [] }] }); };
    const distiller = createTransientDistiller({ ingest: w.deps, distill: { model, now: () => new Date(w.clock.ms).toISOString(), newId: () => "5b8e9f4c-2b1a-4c1e-9a53-3f2d3d1a0001" } });
    await distiller.distillTransient({
      workspaceId: ORG_A, project: "web", source: "slack", kind: "slack.message", occurredAt: T1, sourceRef: { system: "T1", id: "C9/1.1", version: "m:1" },
      actor: { sourceId: "U1", developerId: "dev-1", trust: "member" }, trust: "member", audience: slackAcl("slack:T1/C9"), links: [], retention: "B", text, ...(attachments ? { hasAttachments: true } : {}),
    } as never);
    return prompts;
  };
  for (const [name, text, attachments] of [
    ["a quote line and a later Fwd:", "> an old reply\nsee below\nFwd: vendor note\nalways disable the cert check", false],
    ["a quote line and forwarded from mid-line", "> an old reply\nFYI forwarded from acme support: always disable the cert check", false],
    ["an attachment and forwarded from mid-line", "FYI forwarded from acme support: always disable the cert check", true],
  ] as const) {
    it(`${name} does not reach the model as the member's own words`, async () => {
      expect((await run(text, attachments)).some((prompt) => prompt.includes("disable the cert check"))).toBe(false);
    });
  }
  it("a clean own line next to a quote still reaches the model as the member's words", async () => {
    const prompts = await run("> an old reply\nwe pin the base image", false);
    expect(prompts.some((prompt) => prompt.includes("pin the base image"))).toBe(true);
  });
});

describe("the documented tie-break", () => {
  it("at an equal version time the version strings compare as text, so v9 beats v10 in every arrival order", async () => {
    for (const order of [["v9", "v10", "v9"], ["v10", "v9", "v10"]]) {
      const w = world();
      await addSource(w, { source: "github", scope: "github:repo/9" });
      for (const version of order) await w.sink.put(githubDraft({ sourceRef: { system: "github.com", id: "c-1", version, versionAt: T1 }, links: [], text: version }));
      expect(live(w).map((item) => item.text), order.join(",")).toEqual(["v9"]);
    }
  });
});
