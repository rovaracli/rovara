// Review items 1 and 2: the sink's audience and member changes versus an erase, for every interleaving; and a queued change replayed after the person was erased.
import { describe, expect, it } from "vitest";
import { runDeleteWorker } from "../../../packages/broker/src/team-record/delete-worker.js";
import { erasePerson } from "../../../packages/broker/src/team-record/erase.js";
import { listScopeWork } from "../../../packages/broker/src/team-record/store.js";
import { queueScopeWork } from "../../../packages/broker/src/team-record/scope-work.js";
import { ORG_A, addSource, githubDraft, rows, world, type World } from "../../support/team-record-core.js";
import { deleteDeps } from "../../support/team-record-delete.js";
import { dirtyInterleavings } from "../../support/erase-interleave.js";

const T1 = "2026-10-30T09:00:00.000Z";
const T2 = "2026-10-30T10:00:00.000Z";
const T3 = "2026-10-30T13:00:00.000Z"; // after the world clock (12:00): an erase scrub captures rows at 12:00, and an older change is never replayed over a newer capture
const SC = "slack:T1/C30";
const acl = (principals: string[], capturedAt: string) => ({ kind: "restricted" as const, acl: { source: "slack" as const, scope: SC, principals, capturedAt, liveCheck: "none" as const } });
const slackRow = (id: string, principals: string[], at: string) => githubDraft({ source: "slack", kind: "slack.message", repo: undefined, occurredAt: at, sourceRef: { system: "T1", id, version: "1" }, audience: acl(principals, at), actor: { sourceId: "U1", trust: "member" }, text: "launch plan", links: [] });

async function seeded(): Promise<World> {
  const w = world();
  await addSource(w, { source: "slack", scope: SC });
  await w.sink.put(slackRow("m1", ["U1", "UX"], T1));
  await w.sink.put(slackRow("m2", ["U1", "UX"], T2));
  return w;
}

describe("item 1: the sink's audience and member changes versus an erase", () => {
  it("replaceScopeAudience: whatever storage call the erase lands after, no row names the person once the second pass has run", async () => {
    const result = await dirtyInterleavings({ person: "UX", seed: seeded, op: (w) => w.sink.replaceScopeAudience({ workspaceId: ORG_A, scope: SC, audience: acl(["U1", "UX", "U2"], T3), at: T3 }) });
    expect(result.dirty).toEqual([]);
  });
  it("changePrincipals (a join of the person): the same", async () => {
    const result = await dirtyInterleavings({ person: "UX", seed: async () => { const w = await seeded(); return w; }, op: (w) => w.sink.changePrincipals({ workspaceId: ORG_A, scope: SC, add: ["UX", "U3"], at: T3 }) });
    expect(result.dirty).toEqual([]);
  });
});

describe("item 2: a queued change is replayed with the markers read again", () => {
  it("a queued audience item that names a person erased since is replayed without them (every caller of the rewrite is covered)", async () => {
    const w = await seeded();
    const d = deleteDeps(w);
    await queueScopeWork({ table: w.table, now: () => w.clock.ms }, ORG_A, { type: "audience", system: "scope", scope: SC, audience: acl(["U1", "UX"], T3), changeAt: T3, hidePending: true });
    expect((await erasePerson(d.deps, ORG_A, { identities: [{ system: "slack:T1", sourceId: "UX" }], projects: ["web"] }, "q1")).complete).toBe(true);
    await runDeleteWorker(d.deps, ORG_A);
    expect((await listScopeWork(w.table, ORG_A, 50)).filter((entry) => entry.type === "audience")).toEqual([]);
    expect(JSON.stringify(rows(w, "TEAM_RECORD_EVENT"))).not.toContain("UX");
  });
  it("a queued principals item whose add names a person erased since adds nobody", async () => {
    const w = await seeded();
    const d = deleteDeps(w);
    await queueScopeWork({ table: w.table, now: () => w.clock.ms }, ORG_A, { type: "principals", system: "scope", scope: SC, add: ["UX", "U3"], changeAt: T3, hidePending: true });
    expect((await erasePerson(d.deps, ORG_A, { identities: [{ system: "slack:T1", sourceId: "UX" }], projects: ["web"] }, "q2")).complete).toBe(true);
    await runDeleteWorker(d.deps, ORG_A);
    const principals = rows(w, "TEAM_RECORD_EVENT").map((row) => (row.audience as { acl: { principals: string[] } }).acl.principals);
    expect(JSON.stringify(principals)).not.toContain("UX");
    expect(JSON.stringify(principals)).toContain("U3");
  });
});
