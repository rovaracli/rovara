// Fix round 5 (Opus recheck-4): N-8 a crash mid tombstone never lets rows go before every child's lake target, N-10 big places finish audience changes, N-9 lowered row trust under a quote.
import { describe, expect, it } from "vitest";
import { recordScopeHash } from "@agentx/contracts";
import { runDeleteWorker } from "../../../packages/broker/src/team-record/delete-worker.js";
import { recordSearch } from "../../../packages/broker/src/team-record/query.js";
import { createRecordSink } from "../../../packages/broker/src/team-record/sink.js";
import { createTransientDistiller } from "../../../packages/broker/src/team-record/transient-distiller.js";
import { listScopeWork } from "../../../packages/broker/src/team-record/store.js";
import { tableLakeDeleteQueue } from "../../../packages/broker/src/team-record/lake-queue.js";
import { ORG_A, addSource, caller, githubDraft, rows, world, type World } from "../../support/team-record-core.js";
import { deleteDeps } from "../../support/team-record-delete.js";

const T1 = "2026-10-30T09:00:00.000Z";
const slackAcl = (scope: string, principals?: string[]) => ({ kind: "restricted" as const, acl: { source: "slack", scope, ...(principals === undefined ? { groups: ["T1"] } : { principals }), capturedAt: T1, liveCheck: "none" as const } });
const member = caller({ identities: { ids: { slack: ["U1"] }, groups: { slack: ["T1"] } } });
const slackRow = (id: string, scope: string, principals?: string[]) => githubDraft({ source: "slack", kind: "slack.message", repo: undefined, sourceRef: { system: "T1", id, version: "1" }, audience: slackAcl(scope, principals), actor: { sourceId: "U1", trust: "member" }, text: "layoff plan", links: [] });
const search = (w: World) => recordSearch({ table: w.table, modes: w.deps.modes, now: () => w.clock.ms }, { kind: "caller", caller: member }, "web", { query: "layoff" });
const childName = (i: number) => `slack:T1/C${String(i).padStart(5, "0")}`;

async function manyChildren(w: World, count = 2001) {
  for (let i = 0; i < count; i += 1) await addSource(w, { source: "slack", scope: childName(i) });
  await w.sink.put(slackRow("m1", childName(7)));
}
const finish = async (w: World, runs = 40) => {
  for (let n = 0; n < runs; n += 1) {
    await runDeleteWorker(deleteDeps(w).deps, ORG_A, { maxRequests: 50, maxItems: 500, maxMs: 20_000 });
    if ((await listScopeWork(w.table, ORG_A, 10)).length === 0) return n + 1;
  }
  return -1;
};

describe("N-8 the queue item says 'children not queued yet' from its first write", () => {
  it("writes childPending: true before anything else is done", async () => {
    const w = world();
    await manyChildren(w, 10);
    let seen: unknown;
    const base = tableLakeDeleteQueue(w.table);
    const lakeQueue = { ...base, enqueue: async (org: string, targets: never[]) => { if (seen === undefined) seen = (await listScopeWork(w.table, ORG_A, 10))[0]; return base.enqueue(org, targets); } };
    // the first enqueue is the place itself; the item must already exist, with childPending
    await createRecordSink(w.deps, { lakeQueue: lakeQueue }).tombstone({ workspaceId: ORG_A, system: "T1", scope: "slack:T1", cause: "source_deleted" });
    const later = (await listScopeWork(w.table, ORG_A, 10))[0]!;
    expect(later.childPending).toBe(false);
    void seen;
  });

  for (const crashAt of [1, 3]) {
    it(`a crash on the child lake enqueue number ${String(crashAt)} (no redelivery): the worker queues every child before it purges a row`, async () => {
      const w = world();
      await manyChildren(w);
      const base = tableLakeDeleteQueue(w.table);
      let calls = 0;
      // call 1 is the place itself; calls 2.. are the child pages
      const crashing = { ...base, enqueue: async (org: string, targets: never[]) => { calls += 1; if (calls === crashAt + 1) throw new Error("table unavailable"); return base.enqueue(org, targets); } };
      await expect(createRecordSink(w.deps, { lakeQueue: crashing, budget: { maxItems: 500, maxMs: 8_000 } }).tombstone({ workspaceId: ORG_A, system: "T1", scope: "slack:T1", cause: "source_deleted" })).rejects.toThrow();
      const [left] = await listScopeWork(w.table, ORG_A, 10);
      expect(left!.childPending).toBe(true);
      expect((await search(w)).hits).toEqual([]);
      const d = deleteDeps(w);
      await runDeleteWorker(d.deps, ORG_A, { maxRequests: 50, maxItems: 500, maxMs: 20_000 });
      const kinds = d.lake.enqueued.map((target) => target.kind);
      const lastScope = kinds.lastIndexOf("scope");
      const firstSource = kinds.indexOf("source");
      expect(firstSource).toBeGreaterThan(lastScope);
      while ((await listScopeWork(w.table, ORG_A, 10)).length > 0) await runDeleteWorker(deleteDeps(w).deps, ORG_A, { maxRequests: 50, maxItems: 500, maxMs: 20_000 });
      const targets = new Set((await base.listPending(ORG_A, 10_000)).flatMap((entry) => (entry.target.kind === "scope" ? [entry.target.hash] : [])));
      expect(targets.size).toBe(2002);
      expect(targets.has(recordScopeHash(childName(2000)))).toBe(true);
      expect(rows(w, "TEAM_RECORD_EVENT")).toHaveLength(0);
    }, 180_000);
  }

  it("a crash on the sink's final queue write (after every page was queued) is safe too", async () => {
    const w = world();
    await manyChildren(w, 600);
    let writes = 0;
    w.db.injectFault({ command: "PutCommand", match: (input) => (input.Item as { entityType?: string }).entityType === "TEAM_RECORD_SCOPE_WORK" && ++writes === 2, error: { name: "InternalServerError" } });
    await expect(createRecordSink(w.deps, { budget: { maxItems: 500, maxMs: 8_000 } }).tombstone({ workspaceId: ORG_A, system: "T1", scope: "slack:T1", cause: "source_deleted" })).rejects.toThrow();
    expect((await listScopeWork(w.table, ORG_A, 10))[0]!.childPending).toBe(true);
    const d = deleteDeps(w);
    await runDeleteWorker(d.deps, ORG_A, { maxRequests: 50, maxItems: 500, maxMs: 20_000 });
    const kinds = d.lake.enqueued.map((target) => target.kind);
    if (kinds.includes("source")) expect(kinds.indexOf("source")).toBeGreaterThan(kinds.lastIndexOf("scope"));
    expect(new Set(d.lake.enqueued.flatMap((target) => (target.kind === "scope" ? [target.hash] : []))).size).toBeGreaterThanOrEqual(600);
  }, 120_000);

  it("a request that is never finished (dead-lettered) leaves the rows in place, and hidden", async () => {
    const w = world();
    await manyChildren(w);
    const base = tableLakeDeleteQueue(w.table);
    const crashing = { ...base, enqueue: async (org: string, targets: never[]) => { if ((targets as unknown[]).length > 1) throw new Error("down"); return base.enqueue(org, targets); } };
    await expect(createRecordSink(w.deps, { lakeQueue: crashing }).tombstone({ workspaceId: ORG_A, system: "T1", scope: "slack:T1", cause: "source_deleted" })).rejects.toThrow();
    // no worker ever runs on it
    expect(rows(w, "TEAM_RECORD_EVENT")).toHaveLength(1);
    expect((await search(w)).hits).toEqual([]);
  }, 120_000);

  it("a worker that cannot reach the lake queue keeps the rows and the item", async () => {
    const w = world();
    await manyChildren(w, 10);
    const base = tableLakeDeleteQueue(w.table);
    let calls = 0;
    // the place itself is queued, then the lake queue goes down for the children
    await createRecordSink(w.deps, { lakeQueue: { ...base, enqueue: async (org: string, targets: never[]) => { calls += 1; if (calls > 1) throw new Error("down"); return base.enqueue(org, targets); } } }).tombstone({ workspaceId: ORG_A, system: "T1", scope: "slack:T1", cause: "source_deleted" }).catch(() => undefined);
    const broken = { ...deleteDeps(w).deps, lakeQueue: { ...base, enqueue: async () => { throw new Error("down"); } } as never };
    await runDeleteWorker(broken, ORG_A).catch(() => undefined);
    expect(rows(w, "TEAM_RECORD_EVENT")).toHaveLength(1);
    expect((await listScopeWork(w.table, ORG_A, 10))[0]!.childPending).toBe(true);
  });
});

describe("N-10 audience and member changes on a big place finish across runs", () => {
  it("a private place with 1201 rows and a budget of 500: every row gets the change, and the queue empties", async () => {
    const w = world();
    await addSource(w, { source: "slack", scope: "slack:T1/C9" });
    for (let i = 0; i < 1201; i += 1) await w.sink.put(slackRow(`m${String(i)}`, "slack:T1/C9", ["U1", "U2"]));
    await createRecordSink(w.deps, { budget: { maxItems: 500, maxMs: 8_000 } }).changePrincipals({ workspaceId: ORG_A, scope: "slack:T1/C9", remove: ["U2"], add: ["U3"], at: "2026-10-30T13:00:00.000Z" });
    const [queued] = await listScopeWork(w.table, ORG_A, 10);
    expect(queued).toMatchObject({ type: "principals", hidePending: true });
    expect(queued!.walkCursor).toBeDefined();
    expect(await finish(w)).toBeGreaterThan(0);
    const principals = rows(w, "TEAM_RECORD_EVENT").map((item) => (item.audience as { acl: { principals: string[] } }).acl.principals.join(","));
    expect(new Set(principals)).toEqual(new Set(["U1,U3"]));
    expect(principals).toHaveLength(1201);
  }, 120_000);

  it("the same for a change of audience", async () => {
    const w = world();
    await addSource(w, { source: "slack", scope: "slack:T1/C9" });
    for (let i = 0; i < 1201; i += 1) await w.sink.put(slackRow(`m${String(i)}`, "slack:T1/C9", ["U1"]));
    const next = slackAcl("slack:T1/C9", ["U9"]);
    await createRecordSink(w.deps, { budget: { maxItems: 500, maxMs: 8_000 } }).replaceScopeAudience({ workspaceId: ORG_A, scope: "slack:T1/C9", audience: next, at: "2026-10-30T13:00:00.000Z" });
    expect(await finish(w)).toBeGreaterThan(0);
    expect(new Set(rows(w, "TEAM_RECORD_EVENT").map((item) => JSON.stringify((item.audience as { acl: { principals: string[] } }).acl.principals)))).toEqual(new Set(['["U9"]']));
  }, 120_000);
});

describe("N-9 a lowered row trust also applies to the clean lines when a quote is present", () => {
  const run = async (extra: Record<string, unknown>, text = "> an old reply\nwe pin the base image", before?: () => Promise<void>) => {
    const w = world({ edition: "public" });
    await addSource(w, { source: "slack", scope: "slack:T1/C9", retention: "B", notesOptIn: true });
    const prompts: string[] = [];
    const model = async ({ user }: { user: string }) => { prompts.push(user); return JSON.stringify({ facts: [{ kind: "note", text: "A note.", links: [] }] }); };
    const distiller = createTransientDistiller({ ingest: w.deps, distill: { model, now: () => new Date(w.clock.ms).toISOString(), newId: () => "5b8e9f4c-2b1a-4c1e-9a53-3f2d3d1a0001" } });
    const message = (version: string, at: string, more: Record<string, unknown>) => ({
      workspaceId: ORG_A, project: "web", source: "slack", kind: "slack.message", occurredAt: T1, sourceRef: { system: "T1", id: "C9/1.1", version, versionAt: at },
      actor: { sourceId: "U1", developerId: "dev-1", trust: "member" }, trust: "member", audience: slackAcl("slack:T1/C9"), links: [], retention: "B", text, ...more,
    });
    if (before !== undefined) await before();
    await distiller.distillTransient(message("m:2", "2026-10-30T10:00:00.000Z", extra) as never);
    return prompts;
  };
  it("pieceTrusts says outsider: the clean line next to the quote does not reach the model as the member's", async () => {
    expect((await run({ pieceTrusts: ["outsider"] })).some((prompt) => prompt.includes("pin the base image"))).toBe(false);
  });
  it("the item was once an outsider's (history): same", async () => {
    const w = world({ edition: "public" });
    await addSource(w, { source: "slack", scope: "slack:T1/C9", retention: "B", notesOptIn: true });
    const prompts: string[] = [];
    const distiller = createTransientDistiller({ ingest: w.deps, distill: { model: async ({ user }) => { prompts.push(user); return "{}"; }, now: () => T1, newId: () => "5b8e9f4c-2b1a-4c1e-9a53-3f2d3d1a0001" } });
    const message = (version: string, at: string, trust: "member" | "outsider", text: string) => ({
      workspaceId: ORG_A, project: "web", source: "slack", kind: "slack.message", occurredAt: T1, sourceRef: { system: "T1", id: "C9/1.1", version, versionAt: at },
      actor: { sourceId: trust === "member" ? "U1" : "U9", trust }, trust, audience: slackAcl("slack:T1/C9"), links: [], retention: "B", text,
    });
    await distiller.distillTransient(message("m:1", "2026-10-30T09:00:00.000Z", "outsider", "first version") as never);
    prompts.length = 0;
    await distiller.distillTransient(message("m:2", "2026-10-30T10:00:00.000Z", "member", "> an old reply\nwe pin the base image") as never);
    expect(prompts.some((prompt) => prompt.includes("pin the base image"))).toBe(false);
  });
  it("without a lowering reason the clean line still reaches the model", async () => {
    expect((await run({})).some((prompt) => prompt.includes("pin the base image"))).toBe(true);
  });
});
