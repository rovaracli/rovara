// Fix round 7 (Opus recheck-6, N-12): a stale queue item is never replayed over a later change, and a later change never runs inline over a standing one.
import { describe, expect, it } from "vitest";
import { runDeleteWorker } from "../../../packages/broker/src/team-record/delete-worker.js";
import { recordSearch } from "../../../packages/broker/src/team-record/query.js";
import { createRecordSink } from "../../../packages/broker/src/team-record/sink.js";
import { listScopeWork } from "../../../packages/broker/src/team-record/store.js";
import { queueScopeWork } from "../../../packages/broker/src/team-record/scope-work.js";
import { ORG_A, addSource, caller, githubDraft, rows, world, type World } from "../../support/team-record-core.js";
import { deleteDeps } from "../../support/team-record-delete.js";

const T1 = "2026-10-30T09:00:00.000Z";
const acl = (scope: string, principals: string[], capturedAt = T1) => ({ kind: "restricted" as const, acl: { source: "slack", scope, principals, capturedAt, liveCheck: "none" as const } });
const u1 = caller({ identities: { ids: { slack: ["U1"] }, groups: {} } });
const u2 = caller({ developerId: "dev-2", identities: { ids: { slack: ["U2"] }, groups: {} } });
const u3 = caller({ developerId: "dev-3", identities: { ids: { slack: ["U3"] }, groups: {} } });
const T2 = "2026-10-30T10:00:00.000Z";
const SC = "slack:T1/C9";
const slackRow = (id: string, scope: string) => githubDraft({ source: "slack", kind: "slack.message", repo: undefined, sourceRef: { system: "T1", id, version: "1" }, audience: acl(scope, ["U1", "U2"]), actor: { sourceId: "U2", trust: "member" }, text: "layoff plan", links: [] });
const hits = async (w: World, who = u1) => (await recordSearch({ table: w.table, modes: w.deps.modes, now: () => w.clock.ms }, { kind: "caller", caller: who }, "web", { query: "layoff", limit: 50 })).hits.length;
const principalsOf = (w: World) => new Set(rows(w, "TEAM_RECORD_EVENT").map((item) => ((item.audience as { acl: { principals: string[] } }).acl.principals).join(",")));
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


const sinkOf = (w: World, maxItems = 5_000) => createRecordSink(w.deps, { budget: { maxItems, maxMs: 30_000 } });
const state = async (w: World) => ({ rows: [...principalsOf(w)].map((p) => p.split(",").sort().join(",")).sort().join("|"), queue: (await listScopeWork(w.table, ORG_A, 10)).length, u1: await hits(w, u1), u2: await hits(w, u2), u3: await hits(w, u3) });
const crashed = async (run: () => Promise<unknown>) => { try { await run(); } catch { return true; } return false; };

describe("N-12 an older change that is still queued", () => {
  for (const [label, later] of [["a later clock", T2], ["the same clock", T1]] as const) {
    it(`S4 principals (${label}): A crashes and is redelivered, then B removes U3; after the worker U3 is still out`, async () => {
      const w = world();
      await seed(w, 100);
      crashAtUpdate(w, 20);
      expect(await crashed(() => sinkOf(w).changePrincipals({ workspaceId: ORG_A, scope: SC, add: ["U3"], remove: ["U1"], at: T1 }))).toBe(true);
      await sinkOf(w).changePrincipals({ workspaceId: ORG_A, scope: SC, add: ["U3"], remove: ["U1"], at: T1 }); // the redelivery
      await sinkOf(w).changePrincipals({ workspaceId: ORG_A, scope: SC, remove: ["U3"], at: later });
      expect((await state(w)).u3).toBe(0);
      expect((await state(w)).u1).toBe(0);
      await finish(w);
      expect(await state(w)).toMatchObject({ rows: "U2", queue: 0, u1: 0, u3: 0 });
      expect(await hits(w, u2)).toBeGreaterThan(0);
    }, 120_000);

    it(`S1 audience (${label}): a widen crashes, then a narrowing to U2; after the worker U1 and U3 are still out`, async () => {
      const w = world();
      await seed(w, 100);
      crashAtUpdate(w, 20);
      expect(await crashed(() => sinkOf(w).replaceScopeAudience({ workspaceId: ORG_A, scope: SC, audience: acl(SC, ["U1", "U2", "U3"]), at: T1 }))).toBe(true);
      await sinkOf(w).replaceScopeAudience({ workspaceId: ORG_A, scope: SC, audience: acl(SC, ["U2"], later), at: later });
      expect(await hits(w, u1)).toBe(0);
      expect(await hits(w, u3)).toBe(0);
      await finish(w);
      expect(await state(w)).toMatchObject({ rows: "U2", queue: 0, u1: 0, u3: 0 });
      expect(await hits(w, u2)).toBeGreaterThan(0);
    }, 120_000);
  }

  it("the reverse order: a narrowing crashes, then a widen; the newest list wins and nobody sees rows meanwhile", async () => {
    const w = world();
    await seed(w, 100);
    crashAtUpdate(w, 20);
    expect(await crashed(() => sinkOf(w).replaceScopeAudience({ workspaceId: ORG_A, scope: SC, audience: acl(SC, ["U2"]), at: T1 }))).toBe(true);
    await sinkOf(w).replaceScopeAudience({ workspaceId: ORG_A, scope: SC, audience: acl(SC, ["U1", "U2", "U3"], T2), at: T2 });
    expect(await state(w)).toMatchObject({ u1: 0, u2: 0, u3: 0 });
    await finish(w);
    expect(await state(w)).toMatchObject({ rows: "U1,U2,U3", queue: 0 });
    expect(await hits(w, u3)).toBeGreaterThan(0);
  }, 120_000);

  it("a later change does not run inline over a standing one: it only queues", async () => {
    const w = world();
    await seed(w, 50);
    crashAtUpdate(w, 10);
    expect(await crashed(() => sinkOf(w).changePrincipals({ workspaceId: ORG_A, scope: SC, remove: ["U1"], at: T1 }))).toBe(true);
    const before = principalsOf(w);
    let updates = 0;
    const real = w.table.documentClient;
    w.table.documentClient = { send: async (command: unknown) => { const sent = command as { constructor: { name: string }; input?: { Key?: { sk?: string } } }; if (sent.constructor.name === "UpdateCommand" && !String(sent.input?.Key?.sk).startsWith("ACCESS#")) updates += 1; return real.send(command); } };
    await sinkOf(w).changePrincipals({ workspaceId: ORG_A, scope: SC, add: ["U3"], at: T2 }); // even an add-only change waits behind it
    w.table.documentClient = real;
    expect(updates).toBe(0);
    expect(principalsOf(w)).toEqual(before);
    expect(await listScopeWork(w.table, ORG_A, 10)).toHaveLength(2);
    await finish(w);
    expect(principalsOf(w)).toEqual(new Set(["U2,U3"]));
  }, 120_000);

  it("the worker replays the two items oldest first even when both were queued in the same millisecond", async () => {
    const w = world();
    await seed(w, 20);
    await queueScopeWork({ table: w.table, now: () => w.clock.ms }, ORG_A, { type: "principals", system: "scope", scope: SC, add: ["U3"], changeAt: T1, hidePending: true });
    await queueScopeWork({ table: w.table, now: () => w.clock.ms }, ORG_A, { type: "principals", system: "scope", scope: SC, remove: ["U3"], changeAt: T2, hidePending: true }, (await listScopeWork(w.table, ORG_A, 10))[0]!.at);
    await finish(w);
    expect(principalsOf(w)).toEqual(new Set(["U1,U2"]));
  }, 120_000);

  it("a change to another place is not held back by the item", async () => {
    const w = world();
    await seed(w, 20);
    crashAtUpdate(w, 5);
    expect(await crashed(() => sinkOf(w).changePrincipals({ workspaceId: ORG_A, scope: SC, remove: ["U1"], at: T1 }))).toBe(true);
    await addSource(w, { source: "slack", scope: "slack:T1/C7" });
    await w.sink.put(slackRow("other", "slack:T1/C7"));
    await sinkOf(w).changePrincipals({ workspaceId: ORG_A, scope: "slack:T1/C7", remove: ["U1"], at: T2 });
    expect((await listScopeWork(w.table, ORG_A, 10))).toHaveLength(1);
  }, 120_000);

  it("two partial changes (both over the budget) still end right", async () => {
    const w = world();
    await seed(w, 300);
    await sinkOf(w, 100).changePrincipals({ workspaceId: ORG_A, scope: SC, add: ["U3"], remove: ["U1"], at: T1 });
    await sinkOf(w, 100).changePrincipals({ workspaceId: ORG_A, scope: SC, add: ["U1"], remove: ["U3"], at: T2 });
    await finish(w);
    expect(await state(w)).toMatchObject({ rows: "U1,U2", queue: 0 });
  }, 120_000);
});

describe("N-12 a replay never rewrites a row captured after the item", () => {
  it("principals: an item from T1 over rows that a T2 change already wrote leaves them alone", async () => {
    const w = world();
    await seed(w, 20);
    await sinkOf(w).changePrincipals({ workspaceId: ORG_A, scope: SC, remove: ["U1"], at: T2 });
    await queueScopeWork({ table: w.table, now: () => w.clock.ms }, ORG_A, { type: "principals", system: "scope", scope: SC, add: ["U3"], changeAt: T1, hidePending: true });
    await finish(w);
    expect(principalsOf(w)).toEqual(new Set(["U2"]));
    expect(await hits(w, u3)).toBe(0);
  }, 120_000);

  it("audience: a widen item from T1 over rows that a T2 narrowing already wrote leaves them alone", async () => {
    const w = world();
    await seed(w, 20);
    await sinkOf(w).replaceScopeAudience({ workspaceId: ORG_A, scope: SC, audience: acl(SC, ["U2"], T2), at: T2 });
    await queueScopeWork({ table: w.table, now: () => w.clock.ms }, ORG_A, { type: "audience", system: "scope", scope: SC, audience: acl(SC, ["U1", "U2", "U3"]), changeAt: T1, hidePending: true });
    await finish(w);
    expect(principalsOf(w)).toEqual(new Set(["U2"]));
    expect(await hits(w, u1)).toBe(0);
  }, 120_000);
});
