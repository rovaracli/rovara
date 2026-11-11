// Fix round 10 (Opus recheck-9): erasure never short-circuits and leaves the id nowhere (R9-2, R9-3), deleting a place purges every item unit under it (R9-4), a comment with
// its own visibility gets its own unit (R9-5), and the low items (registry, conversion read failure, queued sink seed, overlay tie).
import { describe, expect, it } from "vitest";
import { aclUnitOfSource, recordAccessMemberKey, recordAccessPersonPrefix, RECORD_SOURCES } from "@agentx/cloud-contracts";
import { applyAudienceEvent, applyMemberEvents } from "../../../packages/broker/src/team-record/access.js";
import { runDeleteWorker } from "../../../packages/broker/src/team-record/delete-worker.js";
import { ERASE_SWEEP_DELAY_MS, erasePerson, runErasureSweeps } from "../../../packages/broker/src/team-record/erase.js";
import { recordSearch } from "../../../packages/broker/src/team-record/query.js";
import { createCaptureModePort, createSourceConfigPort } from "../../../packages/broker/src/team-record/sink.js";
import { createSlackRecordTap, withChannelInfoCache, type SlackChannelInfo } from "../../../packages/broker/src/team-record/sources/slack.js";
import { createQueuedSink } from "../../../packages/broker/src/team-record/sources/queue.js";
import { listScopeWork } from "../../../packages/broker/src/team-record/store.js";
import { ORG_A, addSource, caller, githubDraft, rows, world, type World } from "../../support/team-record-core.js";
import { deleteDeps } from "../../support/team-record-delete.js";

const T1 = "2026-10-30T09:00:00.000Z";
const T2 = "2026-10-30T10:00:00.000Z";
const T3 = "2026-10-30T11:00:00.000Z";
const ID = "U-erase-me-7";
const acl = (scope: string, principals: string[], capturedAt = T1) => ({ kind: "restricted" as const, acl: { source: "slack", scope, principals, capturedAt, liveCheck: "none" as const } });
const slackRow = (id: string, scope: string, principals: string[], actor = "U-poster") => githubDraft({ source: "slack", kind: "slack.message", repo: undefined, sourceRef: { system: "T1", id, version: "1" }, audience: acl(scope, principals), actor: { sourceId: actor, trust: "member" }, text: "layoff plan", links: [] });
const people = (id: string) => caller({ developerId: `dev-${id}`, identities: { ids: { slack: [id] }, groups: {} } });
const search = (w: World, who: ReturnType<typeof people>) => recordSearch({ table: w.table, modes: w.deps.modes, now: () => w.clock.ms }, { kind: "caller", caller: who }, "web", { query: "layoff", limit: 20 });
const everything = (w: World): string => JSON.stringify(w.db.find(() => true));
/** The erase's own second pass, due after its delay: until it has run the erase is complete but not final (the schedule holds the ids). */
const sweep = async (w: World, d: ReturnType<typeof deleteDeps>): Promise<void> => { w.clock.ms += ERASE_SWEEP_DELAY_MS + 1; await runErasureSweeps(d.deps, ORG_A, w.clock.ms); };
async function place(w: World, scope: string, principals: string[], posters = 1) {
  await addSource(w, { source: "slack", scope });
  for (let i = 0; i < posters; i += 1) await w.sink.put(slackRow(`m${String(i)}${scope}`, scope, principals));
}

describe("R9-2 erasure never short-circuits", () => {
  it("a person in more than 200 places is erased in one or more runs: marker first, every step recorded, entries and index gone", async () => {
    const w = world();
    const scopes = Array.from({ length: 230 }, (_, i) => `slack:T1/C${String(i)}`);
    for (const scope of scopes) await place(w, scope, [ID, "U-poster"]);
    const d = deleteDeps(w);
    let result = await erasePerson(d.deps, ORG_A, { identities: [{ system: "slack:T1", sourceId: ID }], scopes }, "e1");
    for (let run = 0; run < 6 && !result.complete; run += 1) result = await erasePerson(d.deps, ORG_A, { identities: [{ system: "slack:T1", sourceId: ID }], scopes }, "e1");
    expect(result).toMatchObject({ complete: true, steps: { principals: true, access: true, lessons: true } });
    expect(w.db.find((item) => String(item.sk).startsWith(recordAccessPersonPrefix(ID)))).toEqual([]);
    expect((await applyMemberEvents(w.table, ORG_A, { scope: scopes[0] as string, add: [ID], at: T3 })).applied.add).toEqual([]);
  }, 120_000);

  it("a row pass that runs out of budget does not skip the other steps: the marker is already in, and the next run finishes", async () => {
    const w = world();
    await place(w, "slack:T1/CBIG", [ID, "U-poster"], 40);
    await place(w, "slack:T1/CSMALL", [ID, "U-poster"], 1);
    const d = deleteDeps(w);
    const first = await erasePerson(d.deps, ORG_A, { identities: [{ system: "slack:T1", sourceId: ID }], projects: ["web"] }, "e2", { maxItems: 5, maxMs: 0 });
    expect(first.complete).toBe(false);
    expect(first.steps).toMatchObject({ access: false, lessons: true }); // the access step could not finish, and the lessons step ran on its own
    // a join now writes nothing: the marker went in first
    expect((await applyMemberEvents(w.table, ORG_A, { scope: "slack:T1/CBIG", add: [ID], at: T3 })).applied.add).toEqual([]);
    let again = first;
    for (let run = 0; run < 5 && !again.complete; run += 1) again = await erasePerson(d.deps, ORG_A, { identities: [{ system: "slack:T1", sourceId: ID }], projects: ["web"] }, "e2", { maxItems: 5 });
    expect(again.complete).toBe(true);
  }, 120_000);

  it("the steps are independent: when the place passes run out of time the access step still works on its own budget", async () => {
    const w = world();
    const scopes = Array.from({ length: 40 }, (_, i) => `slack:T1/C${String(i)}`);
    for (const scope of scopes) await place(w, scope, [ID, "U-poster"]);
    let t = 0;
    const d = deleteDeps(w, { now: () => { t += 3; return w.clock.ms + t; } });
    const before = w.db.find((item) => String(item.sk).startsWith(recordAccessPersonPrefix(ID))).length;
    const first = await erasePerson(d.deps, ORG_A, { identities: [{ system: "slack:T1", sourceId: ID }], scopes: [...scopes, ...Array.from({ length: 60 }, (_, i) => `slack:T1/X${String(i)}`)] }, "e5", { maxItems: 500, maxMs: 40 });
    expect(first.steps?.principals).toBe(false); // the explicit list ran out of time...
    const after = w.db.find((item) => String(item.sk).startsWith(recordAccessPersonPrefix(ID))).length;
    expect(after).toBeLessThan(before); // ...and the access step still removed units on its own budget
  });

  it("an interrupted row pass (the table fails in the middle) is resumed by the next run", async () => {
    const w = world();
    await place(w, "slack:T1/C1", [ID, "U-poster"], 30);
    const d = deleteDeps(w);
    let updates = 0;
    w.db.injectFault({ command: "UpdateCommand", match: () => { updates += 1; return updates === 10; }, error: { name: "InternalServerError" } });
    const first = await erasePerson(d.deps, ORG_A, { identities: [{ system: "slack:T1", sourceId: ID }] }, "e3");
    expect(first).toMatchObject({ complete: false, steps: { access: false, lessons: true } }); // the failed step is recorded, the others still ran
    expect((await applyMemberEvents(w.table, ORG_A, { scope: "slack:T1/C1", add: [ID], at: T3 })).applied.add).toEqual([]); // the marker is in
    const done = await erasePerson(d.deps, ORG_A, { identities: [{ system: "slack:T1", sourceId: ID }] }, "e3");
    expect(done.complete).toBe(true);
  });
});

describe("R9-3 after a complete erase the id is nowhere", () => {
  it("scans the whole store: rows of places the person never posted in, headers, entries and index items", async () => {
    const w = world();
    await place(w, "slack:T1/CPOSTED", [ID, "U-poster"], 2);
    await place(w, "slack:T1/CSILENT", [ID, "U-poster"], 2); // the person is in it and never posted
    const d = deleteDeps(w);
    await w.sink.put(slackRow("by-person", "slack:T1/CPOSTED", [ID, "U-poster"], ID));
    expect(everything(w)).toContain(ID);
    const result = await erasePerson(d.deps, ORG_A, { identities: [{ system: "slack:T1", sourceId: ID }], projects: ["web"] }, "e4");
    expect(result.complete).toBe(true);
    await sweep(w, d);
    expect(everything(w)).not.toContain(ID);
    expect(d.lessons.audienceScrubs[0]).toEqual({ project: "web", ids: [ID] }); // the lessons of the project lose the id from their audience snapshots too
    // the others keep reading both places
    expect((await search(w, people("U-poster"))).hits.length).toBeGreaterThan(0);
  });
});

describe("R9-4 deleting a place purges every item unit under it", () => {
  const issue = (id: string, parentId?: string, principals = ["P1"]) => githubDraft({
    source: "jira", kind: parentId === undefined ? "ticket.created" : "ticket.comment", repo: undefined, sourceRef: { system: "jira.example", id, version: "1", ...(parentId === undefined ? {} : { parentId }) },
    audience: { kind: "restricted", acl: { source: "jira", scope: "jira:project/KEY", principals, capturedAt: T1, liveCheck: "none" } }, scope: "jira:project/KEY", actor: { sourceId: "u9", trust: "member" }, trust: "member", text: `Billing ${id}`, links: [],
  });
  const settle = async (w: World) => { for (let run = 0; run < 6 && (await listScopeWork(w.table, ORG_A, 5)).length > 0; run += 1) await runDeleteWorker(deleteDeps(w).deps, ORG_A, { maxRequests: 10, maxItems: 500, maxMs: 10_000 }); };
  const accessKinds = (w: World) => w.db.find((item) => String(item.entityType).startsWith("TEAM_RECORD_ACCESS")).map((item) => String(item.entityType));

  it("a Jira project: item headers, entries and index items are gone with it", async () => {
    const w = world();
    await addSource(w, { source: "jira", scope: "jira:project/KEY" });
    await w.sink.put(issue("KEY-1"));
    await w.sink.put(issue("KEY-2", undefined, ["P2"]));
    await w.sink.put(issue("KEY-2#c", "KEY-2", ["P3"])); // a comment with its own list: a child unit
    expect(accessKinds(w).length).toBeGreaterThan(6);
    await w.sink.tombstone({ workspaceId: ORG_A, system: "jira.example", scope: "jira:project/KEY", cause: "source_deleted" });
    await settle(w);
    expect(accessKinds(w)).toEqual([]);
  });

  it("a whole Slack workspace: every channel's record goes", async () => {
    const w = world();
    await place(w, "slack:T1/C1", ["U1"]);
    await place(w, "slack:T1/C2", ["U2"]);
    await w.sink.tombstone({ workspaceId: ORG_A, system: "T1", scope: "slack:T1", cause: "source_deleted" });
    await settle(w);
    expect(accessKinds(w)).toEqual([]);
  });

  it("R9-5 a comment with its own visibility narrows only itself", async () => {
    const w = world();
    await addSource(w, { source: "jira", scope: "jira:project/KEY" });
    await w.sink.put(issue("KEY-1", undefined, ["A", "B"]));
    await w.sink.put({ ...issue("KEY-1#c1", "KEY-1", ["A"]), occurredAt: "2026-10-30T10:30:00.000Z" });
    const reader = (id: string) => caller({ developerId: `d-${id}`, identities: { ids: { jira: [id] }, groups: {} } });
    const seen = async (id: string) => (await recordSearch({ table: w.table, modes: w.deps.modes, now: () => w.clock.ms }, { kind: "caller", caller: reader(id) }, "web", { query: "billing", limit: 20 })).hits.length;
    expect(await seen("A")).toBe(2);
    expect(await seen("B")).toBe(1); // the issue, not the comment
    // a later comment with the issue's own list shares the issue's unit
    const before = w.db.find((item) => item.entityType === "TEAM_RECORD_ACCESS").length;
    await w.sink.put(issue("KEY-1#c2", "KEY-1", ["A", "B"]));
    expect(w.db.find((item) => item.entityType === "TEAM_RECORD_ACCESS").length).toBe(before);
    expect(await seen("B")).toBe(2);
  });
});

describe("the low items", () => {
  it("the unit of a source is declared next to the source list, for every source", () => {
    for (const source of RECORD_SOURCES) expect(["item", "place"]).toContain(aclUnitOfSource(source));
    expect([aclUnitOfSource("jira"), aclUnitOfSource("linear"), aclUnitOfSource("mcp"), aclUnitOfSource("slack"), aclUnitOfSource("github"), aclUnitOfSource("rovara"), aclUnitOfSource("codehost:examplehost")]).toEqual(["item", "item", "item", "place", "place", "place", "place"]);
  });

  const TEAM = "T0TEAM00001";
  const CH = "C0123456789";
  const ts = (sec: number) => `${String(1793358000 + sec)}.000100`;
  function tapOf(sinkFor: (w: World) => never) {
    const w = world();
    const live: { info: SlackChannelInfo; failRead: boolean } = { info: { kind: "public", extShared: false }, failRead: false };
    const directory = withChannelInfoCache({ channelInfo: async () => { if (live.failRead) throw new Error("slack down"); return live.info; } });
    const tap = createSlackRecordTap({
      edition: "enterprise", sink: sinkFor(w), distiller: { distillTransient: async () => ({ accepted: true }) }, actors: { resolve: async () => ({ trust: "member" }), resolveDeveloper: async () => ({ trust: "member" }) },
      mode: createCaptureModePort(w.deps), config: createSourceConfigPort(w.deps), resolveWorkspace: async () => ({ workspaceId: ORG_A, project: "web" }), directory,
    } as never);
    return { w, live, tap };
  }
  const message = (channel: string, t: number, text: string) => ({ type: "event_callback", team_id: TEAM, event: { type: "message", channel, user: "U0USER00002", text, ts: ts(t) } });

  it("R9-7 a conversion whose member list cannot be read retries: the channel is not locked, the next fresh list seeds it", async () => {
    const { w, live, tap } = tapOf((world) => world.sink as never);
    await addSource(w, { source: "slack", scope: `slack:${TEAM}/${CH}`, retention: "D" });
    await tap(message(CH, 0, "public zebra one"));
    live.failRead = true;
    live.info = { kind: "private", extShared: false, memberIds: ["U0USER00001", "U0USER00002"] };
    await tap({ type: "event_callback", team_id: TEAM, event: { type: "channel_convert_to_private", channel: CH, event_ts: ts(10) } });
    live.failRead = false;
    await tap(message(CH, 20, "private zebra two"));
    await tap(message(CH, 30, "private zebra three"));
    const member = caller({ developerId: "dev-1", identities: { ids: { slack: ["U0USER00001"] }, groups: {} } });
    const stranger = caller({ developerId: "dev-9", identities: { ids: { slack: ["U0USER00009"] }, groups: { slack: [TEAM] } } });
    const mine = (await recordSearch({ table: w.table, modes: w.deps.modes, now: () => w.clock.ms }, { kind: "caller", caller: member }, "web", { query: "zebra", limit: 20 })).hits.length;
    expect(mine).toBe(2); // the new private messages (the old public one stays closed to everyone until rewritten with a list)
    expect((await recordSearch({ table: w.table, modes: w.deps.modes, now: () => w.clock.ms }, { kind: "caller", caller: stranger }, "web", { query: "zebra", limit: 20 })).hits).toHaveLength(0);
    expect(w.db.find((item) => item.entityType === "TEAM_RECORD_ACCESS")[0]).toMatchObject({ seeded: true, mode: "restricted" });
  });

  it("R9-7 a list that could not be read clears the unit instead of removing everyone by event", async () => {
    const w = world();
    await place(w, "slack:T1/C1", ["U1", "U2", "U3"]);
    expect(w.db.find((item) => item.entityType === "TEAM_RECORD_ACCESS_MEMBER")).toHaveLength(3);
    await applyAudienceEvent(w.table, ORG_A, { scope: "slack:T1/C1", audience: { kind: "restricted", acl: { source: "slack", scope: "slack:T1/C1", principals: [], capturedAt: T2, liveCheck: "none" } }, at: T2 });
    expect(w.db.find((item) => item.entityType === "TEAM_RECORD_ACCESS_MEMBER")).toEqual([]);
    expect(w.db.find((item) => item.entityType === "TEAM_RECORD_ACCESS")[0]).toMatchObject({ seeded: false, mode: "restricted" });
  });

  it("R9-8 the production queued sink seeds the unit at the first member event", async () => {
    const { w, live, tap } = tapOf((world) => createQueuedSink({ send: async () => undefined }, world.sink) as never);
    const PRIV = "G0123456789";
    await addSource(w, { source: "slack", scope: `slack:${TEAM}/${PRIV}`, retention: "D" });
    live.info = { kind: "private", extShared: false, memberIds: ["U0USER00001", "U0USER00002", "U0ROVARABOT"] };
    await tap({ type: "event_callback", team_id: TEAM, event: { type: "member_joined_channel", channel: PRIV, channel_type: "G", user: "U0ROVARABOT", event_ts: ts(0) } });
    expect(w.db.find((item) => item.entityType === "TEAM_RECORD_ACCESS")[0]).toMatchObject({ seeded: true });
  });

  it("the overlay tie: a removal at exactly the time of the row's snapshot denies", async () => {
    const w = world();
    await addSource(w, { source: "slack", scope: "slack:T1/C9" });
    await w.sink.put(slackRow("a", "slack:T1/C9", ["U1", "U2"]));
    await applyMemberEvents(w.table, ORG_A, { scope: "slack:T1/C9", remove: ["U1"], at: T1 }); // the snapshot's own time
    w.db.set({ ...w.db.find((item) => item.entityType === "TEAM_RECORD_ACCESS")[0]!, seeded: false });
    expect((await search(w, people("U1"))).hits).toHaveLength(0);
    expect((await search(w, people("U2"))).hits).toHaveLength(1);
    expect(rows(w, "TEAM_RECORD_EVENT")).toHaveLength(1);
    expect(w.db.get(recordAccessMemberKey(ORG_A, "slack:T1/C9", "U1").pk, recordAccessMemberKey(ORG_A, "slack:T1/C9", "U1").sk)).toBeDefined();
  });
});
