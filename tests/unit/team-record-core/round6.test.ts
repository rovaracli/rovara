// Fix round 6 (Opus recheck-5, N-11): a place that narrows, or is deleted, is hidden from the first write of the change, never only after a pass.
import { describe, expect, it } from "vitest";
import { recordScopeHash } from "@agentx/cloud-contracts";
import { runDeleteWorker } from "../../../packages/broker/src/team-record/delete-worker.js";
import { recordSearch } from "../../../packages/broker/src/team-record/query.js";
import { createRecordSink } from "../../../packages/broker/src/team-record/sink.js";
import { listScopeWork } from "../../../packages/broker/src/team-record/store.js";
import { tableLakeDeleteQueue } from "../../../packages/broker/src/team-record/lake-queue.js";
import { ORG_A, addSource, caller, githubDraft, rows, world, type World } from "../../support/team-record-core.js";
import { deleteDeps } from "../../support/team-record-delete.js";

const T1 = "2026-10-30T09:00:00.000Z";
const acl = (scope: string, principals: string[]) => ({ kind: "restricted" as const, acl: { source: "slack", scope, principals, capturedAt: T1, liveCheck: "none" as const } });
const u1 = caller({ identities: { ids: { slack: ["U1"] }, groups: {} } });
const u2 = caller({ developerId: "dev-2", identities: { ids: { slack: ["U2"] }, groups: {} } });
const slackRow = (id: string, scope: string) => githubDraft({ source: "slack", kind: "slack.message", repo: undefined, sourceRef: { system: "T1", id, version: "1" }, audience: acl(scope, ["U1", "U2"]), actor: { sourceId: "U2", trust: "member" }, text: "layoff plan", links: [] });
const hits = async (w: World, who = u1) => (await recordSearch({ table: w.table, modes: w.deps.modes, now: () => w.clock.ms }, { kind: "caller", caller: who }, "web", { query: "layoff", limit: 50 })).hits.length;
const principalsOf = (w: World) => new Set(rows(w, "TEAM_RECORD_EVENT").map((item) => ((item.audience as { acl: { principals: string[] } }).acl.principals).join(",")));
const budget = { budget: { maxItems: 500, maxMs: 8_000 } };
async function seed(w: World, n: number) {
  await addSource(w, { source: "slack", scope: "slack:T1/C9" });
  for (let i = 0; i < n; i += 1) await w.sink.put(slackRow(`m${String(i)}`, "slack:T1/C9"));
}
/** Throws at the Nth row rewrite (an UpdateCommand), once. */
const crashAtUpdate = (w: World, n: number) => {
  let updates = 0;
  w.db.injectFault({ command: "UpdateCommand", match: () => { updates += 1; return updates === n; }, error: { name: "InternalServerError" } });
};
const finish = async (w: World) => {
  for (let run = 0; run < 20; run += 1) {
    await runDeleteWorker(deleteDeps(w).deps, ORG_A, { maxRequests: 50, maxItems: 500, maxMs: 20_000 });
    if ((await listScopeWork(w.table, ORG_A, 10)).length === 0) return;
  }
  throw new Error("the worker did not finish");
};

describe("N-11 narrowing hides the place before the first pass", () => {
  for (const [rowsCount, crashAt] of [[300, 100], [1201, 701]] as const) {
    it(`a member list that loses U1: a crash at row ${String(crashAt)} of ${String(rowsCount)} leaves U1 no hit, an item, and the worker finishes it`, async () => {
      const w = world();
      await seed(w, rowsCount);
      expect(await hits(w)).toBeGreaterThan(0);
      crashAtUpdate(w, crashAt);
      await expect(createRecordSink(w.deps, { budget: { maxItems: 5_000, maxMs: 30_000 } }).changePrincipals({ workspaceId: ORG_A, scope: "slack:T1/C9", remove: ["U1"], add: ["U3"], at: T1 })).rejects.toThrow();
      expect(await hits(w)).toBe(0);
      expect(await hits(w, u2)).toBe(0); // hidden for everyone until the change is finished
      expect(await listScopeWork(w.table, ORG_A, 10)).toHaveLength(1);
      await finish(w);
      expect(principalsOf(w)).toEqual(new Set(["U2,U3"]));
      expect(await hits(w)).toBe(0);
      expect(await hits(w, u2)).toBeGreaterThan(0);
    }, 120_000);
  }

  it("an audience that narrows to U2 only: same", async () => {
    const w = world();
    await seed(w, 300);
    crashAtUpdate(w, 100);
    await expect(createRecordSink(w.deps, budget).replaceScopeAudience({ workspaceId: ORG_A, scope: "slack:T1/C9", audience: acl("slack:T1/C9", ["U2"]), at: T1 })).rejects.toThrow();
    expect(await hits(w)).toBe(0);
    expect(await listScopeWork(w.table, ORG_A, 10)).toHaveLength(1);
    await finish(w);
    expect(principalsOf(w)).toEqual(new Set(["U2"]));
  }, 120_000);

  it("U1 searching from inside the pass finds nothing, at every sample", async () => {
    const w = world();
    await seed(w, 300);
    const real = w.table.documentClient;
    let updates = 0;
    let busy = false;
    const samples: number[] = [];
    w.table.documentClient = { send: async (command: unknown) => {
      const result = await real.send(command);
      if (!busy && (command as { constructor: { name: string } }).constructor.name === "UpdateCommand") {
        updates += 1;
        if (updates % 50 === 0) { busy = true; samples.push(await hits(w)); busy = false; }
      }
      return result;
    } };
    await createRecordSink(w.deps, budget).changePrincipals({ workspaceId: ORG_A, scope: "slack:T1/C9", remove: ["U1"], at: T1 });
    w.table.documentClient = real;
    expect(samples.length).toBeGreaterThanOrEqual(4);
    expect(samples.every((count) => count === 0)).toBe(true);
  }, 120_000);

  it("a pass that completes leaves no queue item, and the people who kept access see the rows at once", async () => {
    const w = world();
    await seed(w, 100);
    await createRecordSink(w.deps, budget).changePrincipals({ workspaceId: ORG_A, scope: "slack:T1/C9", remove: ["U1"], at: T1 });
    expect(await listScopeWork(w.table, ORG_A, 10)).toEqual([]);
    expect(await hits(w, u2)).toBeGreaterThan(0);
    expect(await hits(w)).toBe(0);
  }, 120_000);

  it("a pass over more rows than the budget keeps the cursor on the item", async () => {
    const w = world();
    await seed(w, 1201);
    await createRecordSink(w.deps, budget).changePrincipals({ workspaceId: ORG_A, scope: "slack:T1/C9", remove: ["U1"], at: T1 });
    const [item] = await listScopeWork(w.table, ORG_A, 10);
    expect(item!.walkCursor).toBeDefined();
    expect(await hits(w, u2)).toBe(0);
    await finish(w);
    expect(principalsOf(w)).toEqual(new Set(["U2"]));
  }, 120_000);

  it("a member who only joins hides nothing (stale rows are narrower, never wider)", async () => {
    const w = world();
    await seed(w, 30);
    let itemWrites = 0;
    const real = w.table.documentClient;
    w.table.documentClient = { send: async (command: unknown) => { if ((command as { input?: { Item?: { entityType?: string } } }).input?.Item?.entityType === "TEAM_RECORD_SCOPE_WORK") itemWrites += 1; return real.send(command); } };
    await createRecordSink(w.deps, budget).changePrincipals({ workspaceId: ORG_A, scope: "slack:T1/C9", add: ["U3"], at: T1 });
    w.table.documentClient = real;
    expect(itemWrites).toBe(0);
    expect(principalsOf(w)).toEqual(new Set(["U1,U2,U3"]));
  });
});

describe("N-11 a deleted place is hidden before the close and the lake call", () => {
  for (const [name, fault] of [
    ["the place is closed (call 1)", (input: { Item?: { entityType?: string } }) => input.Item?.entityType === "TEAM_RECORD_SCOPE_CLOSED"],
    ["the place's own lake target is queued (call 2)", (input: { Item?: { entityType?: string } }) => input.Item?.entityType === "TEAM_RECORD_LAKE_DELETE"],
  ] as const) {
    it(`a crash when ${name}: nothing is searchable, and the worker closes the place, queues the targets and deletes the rows`, async () => {
      const w = world();
      await seed(w, 20);
      w.db.injectFault({ command: "PutCommand", match: (input) => fault(input), error: { name: "InternalServerError" } });
      await expect(w.sink.tombstone({ workspaceId: ORG_A, system: "T1", scope: "slack:T1/C9", cause: "source_deleted" })).rejects.toThrow();
      expect(await hits(w)).toBe(0);
      expect(await hits(w, u2)).toBe(0);
      expect(await listScopeWork(w.table, ORG_A, 10)).toHaveLength(1);
      await finish(w);
      expect(rows(w, "TEAM_RECORD_EVENT")).toHaveLength(0);
      expect((await tableLakeDeleteQueue(w.table).listPending(ORG_A, 500)).map((entry) => entry.target)).toContainEqual({ kind: "scope", hash: recordScopeHash("slack:T1/C9") });
      expect(await w.sink.put(slackRow("late", "slack:T1/C9"))).toEqual({ status: "refused", reason: "scope_closed" });
    }, 120_000);
  }
});
