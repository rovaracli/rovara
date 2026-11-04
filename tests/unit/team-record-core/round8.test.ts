// Fix round 8 (Opus recheck-7, N-13 / N-14 / N-15): access is checked at READ time against one record per place, so what the rows say never decides.
// Every case below leaves the rows in a bad state on purpose (stale, half rewritten, never rewritten) and still expects zero hits for the person who was removed.
import { describe, expect, it } from "vitest";
import { applyAudienceEvent, applyMemberEvents } from "../../../packages/broker/src/team-record/access.js";
import { runDeleteWorker } from "../../../packages/broker/src/team-record/delete-worker.js";
import { recordSearch } from "../../../packages/broker/src/team-record/query.js";
import { createCaptureModePort, createRecordSink, createSourceConfigPort } from "../../../packages/broker/src/team-record/sink.js";
import { createSlackRecordTap, withChannelInfoCache, type SlackChannelInfo } from "../../../packages/broker/src/team-record/sources/slack.js";
import { listScopeWork } from "../../../packages/broker/src/team-record/store.js";
import { ORG_A, addSource, caller, githubDraft, rows, world, type World } from "../../support/team-record-core.js";
import { deleteDeps } from "../../support/team-record-delete.js";

const T1 = "2026-10-30T09:00:00.000Z";
const T2 = "2026-10-30T10:00:00.000Z";
const T3 = "2026-10-30T11:00:00.000Z";
const SC = "slack:T1/C9";
const acl = (scope: string, principals: string[], capturedAt = T1) => ({ kind: "restricted" as const, acl: { source: "slack", scope, principals, capturedAt, liveCheck: "none" as const } });
const person = (dev: string, uid: string, groups: string[] = []) => caller({ developerId: dev, identities: { ids: { slack: [uid] }, groups: groups.length === 0 ? {} : { slack: groups } } });
const U = { U1: person("dev-1", "U1"), U2: person("dev-2", "U2"), U3: person("dev-3", "U3") };
const slackRow = (id: string, scope: string, principals = ["U1", "U2"], capturedAt = T1) => githubDraft({ source: "slack", kind: "slack.message", repo: undefined, sourceRef: { system: "T1", id, version: "1" }, audience: acl(scope, principals, capturedAt), actor: { sourceId: "U2", trust: "member" }, text: "layoff plan", links: [] });
const search = (w: World, who: typeof U.U1, query = "layoff") => recordSearch({ table: w.table, modes: w.deps.modes, now: () => w.clock.ms }, { kind: "caller", caller: who }, "web", { query, limit: 50 });
const hits = async (w: World, who: keyof typeof U) => (await search(w, U[who])).hits.length;
const principalsOf = (w: World) => [...new Set(rows(w, "TEAM_RECORD_EVENT").map((r) => ((r.audience as { acl: { principals: string[] } }).acl.principals).join(",")))].sort().join("|");
async function seed(w: World, n: number, scope = SC, principals = ["U1", "U2"]) {
  await addSource(w, { source: "slack", scope });
  for (let i = 0; i < n; i += 1) await w.sink.put(slackRow(`m${String(i)}${scope}`, scope, principals));
}
const sinkOf = (w: World) => createRecordSink(w.deps, { budget: { maxItems: 5_000, maxMs: 30_000 } });
const crashAtUpdate = (w: World, n: number) => {
  let updates = 0;
  w.db.injectFault({ command: "UpdateCommand", match: () => { updates += 1; return updates === n; }, error: { name: "InternalServerError" } });
};
/** Every rewrite of a row fails (the access record's own writes are untouched): the rows can never be brought in line. */
const noRowRewrites = (w: World) => w.db.injectFault({ command: "UpdateCommand", match: (input) => !String((input.Key as { sk?: string } | undefined)?.sk).startsWith("ACCESS#"), error: { name: "InternalServerError" }, times: 100_000 });
const crashed = async (run: () => Promise<unknown>) => { try { await run(); } catch { return true; } return false; };
const finish = async (w: World) => {
  for (let run = 0; run < 20; run += 1) {
    await runDeleteWorker(deleteDeps(w).deps, ORG_A, { maxRequests: 50, maxItems: 500, maxMs: 20_000 });
    if ((await listScopeWork(w.table, ORG_A, 10)).length === 0) return;
  }
  throw new Error("the worker did not finish");
};

describe("N-13 / N-14 the access record decides, whatever the rows say", () => {
  it("rows that can never be rewritten: the removed person still gets nothing, the others keep reading", async () => {
    const w = world();
    await seed(w, 40);
    noRowRewrites(w);
    expect(await crashed(() => sinkOf(w).changePrincipals({ workspaceId: ORG_A, scope: SC, remove: ["U1"], at: T1 }))).toBe(true);
    expect(principalsOf(w)).toBe("U1,U2"); // untouched: the rows still list U1
    expect(await hits(w, "U1")).toBe(0);
    expect(await hits(w, "U2")).toBe(0); // hidden for everyone while the item stands (fail closed)
  });

  it("an audience narrowed to U2 with every row rewrite failing: U1 gets nothing, with the rows still listing U1", async () => {
    const w = world();
    await seed(w, 30);
    noRowRewrites(w);
    expect(await crashed(() => sinkOf(w).replaceScopeAudience({ workspaceId: ORG_A, scope: SC, audience: acl(SC, ["U2"], T2), at: T2 }))).toBe(true);
    expect(principalsOf(w)).toBe("U1,U2");
    expect(await hits(w, "U1")).toBe(0);
    expect(await hits(w, "U3")).toBe(0);
  });

  it("the same, once the item is gone: U2 reads, U1 does not, with every row still listing U1", async () => {
    const w = world();
    await seed(w, 20);
    await applyMemberEvents(w.table, ORG_A, { scope: SC, remove: ["U1"], at: T1 });
    expect(principalsOf(w)).toBe("U1,U2");
    expect(await hits(w, "U1")).toBe(0);
    expect(await hits(w, "U2")).toBe(20);
  });

  it("G1 add-only crash, a leave completes, the join is redelivered: U3 stays out", async () => {
    const w = world();
    await seed(w, 100);
    crashAtUpdate(w, 21); // the access write is update 1; this is row 20
    expect(await crashed(() => sinkOf(w).changePrincipals({ workspaceId: ORG_A, scope: SC, add: ["U3"], at: T1 }))).toBe(true);
    await sinkOf(w).changePrincipals({ workspaceId: ORG_A, scope: SC, remove: ["U3"], at: T2 });
    await sinkOf(w).changePrincipals({ workspaceId: ORG_A, scope: SC, add: ["U3"], at: T1 }); // the redelivery of the older join
    expect(await hits(w, "U3")).toBe(0);
    await finish(w);
    expect(await hits(w, "U3")).toBe(0);
    expect(await hits(w, "U2")).toBeGreaterThan(0);
  }, 120_000);

  it("G3 two taps at the same moment: the later leave wins whatever the order", async () => {
    const w = world();
    await seed(w, 100);
    await Promise.all([
      sinkOf(w).changePrincipals({ workspaceId: ORG_A, scope: SC, add: ["U3"], remove: ["U1"], at: T1 }),
      sinkOf(w).changePrincipals({ workspaceId: ORG_A, scope: SC, remove: ["U3"], at: T2 }),
    ]);
    expect(await hits(w, "U3")).toBe(0);
    expect(await hits(w, "U1")).toBe(0);
    await finish(w);
    expect(await hits(w, "U3")).toBe(0);
    expect(await hits(w, "U2")).toBeGreaterThan(0);
  }, 120_000);

  it("an older event never overrides a newer one, and a removal beats an add of the same time", async () => {
    const w = world();
    await seed(w, 5);
    const applied = async (event: { add?: string[]; remove?: string[]; at: string }) => { const { applied: done } = await applyMemberEvents(w.table, ORG_A, { scope: SC, ...event }); return done.add.length + done.remove.length; };
    expect(await applied({ remove: ["U1"], at: T2 })).toBe(1);
    expect(await applied({ add: ["U1"], at: T1 })).toBe(0); // older add: ignored
    expect(await hits(w, "U1")).toBe(0);
    expect(await applied({ add: ["U1"], at: T2 })).toBe(0); // same time: the removal wins
    expect(await hits(w, "U1")).toBe(0);
    expect(await applied({ add: ["U1"], at: T3 })).toBe(1); // a newer add is a real re-join
    expect(await hits(w, "U1")).toBe(5);
    // the other way round: the add is processed first, the older removal after it
    await applied({ add: ["U3"], at: T3 });
    expect(await applied({ remove: ["U3"], at: T3 })).toBe(1); // a removal at the same time beats the add
    expect(await applied({ remove: ["U1"], at: T1 })).toBe(0); // an older removal does not undo the re-join
    expect(await hits(w, "U1")).toBe(5);
  });

  it("a place first seen from a stale list captured AFTER the leave: the leave event still applies", async () => {
    const w = world();
    await addSource(w, { source: "slack", scope: SC });
    await w.sink.put(slackRow("first", SC, ["U1", "U2"], T3)); // the first row of the place, built from a cached list, captured at T3
    await applyMemberEvents(w.table, ORG_A, { scope: SC, remove: ["U1"], at: T2 });
    expect(await hits(w, "U1")).toBe(0);
    expect(await hits(w, "U2")).toBe(1);
  });

  it("N-15 a queue read that throws still leaves the removal in force", async () => {
    const w = world();
    await seed(w, 15);
    w.db.injectFault({ command: "QueryCommand", error: { name: "InternalServerError" }, times: 1 });
    expect(await crashed(() => sinkOf(w).changePrincipals({ workspaceId: ORG_A, scope: SC, remove: ["U1"], at: T1 }))).toBe(true);
    expect(await hits(w, "U1")).toBe(0);
    await sinkOf(w).changePrincipals({ workspaceId: ORG_A, scope: SC, remove: ["U1"], at: T1 }); // the retry
    expect(await hits(w, "U1")).toBe(0);
    expect(await hits(w, "U2")).toBe(15);
  });

  it("N-13 a row captured after the leave (built from a stale list) still loses the person on the pass", async () => {
    const w = world();
    await addSource(w, { source: "slack", scope: SC });
    for (let i = 0; i < 10; i += 1) await w.sink.put(slackRow(`late${String(i)}`, SC, ["U1", "U2"], T3)); // captured at T3, after the leave at T2
    await sinkOf(w).changePrincipals({ workspaceId: ORG_A, scope: SC, remove: ["U1"], at: T2 });
    expect(principalsOf(w)).toBe("U2");
    expect(await hits(w, "U1")).toBe(0);
    // ...but a replay of an older join does not grant a row captured after it
    await sinkOf(w).changePrincipals({ workspaceId: ORG_A, scope: SC, add: ["U3"], at: T1 });
    expect(principalsOf(w)).toBe("U2");
  });
});

describe("N-13 / C1 / C2 through the Slack tap", () => {
  const TEAM = "T0TEAM00001";
  const PRIV = "G0123456789";
  const BASE = 1793358000;
  const ts = (sec: number) => `${String(BASE + sec)}.000100`;
  const slackPerson = (dev: string, uid: string, groups: string[] = []) => caller({ developerId: dev, identities: { ids: { slack: [uid] }, groups: groups.length === 0 ? {} : { slack: groups } } });
  const V1 = slackPerson("dev-1", "U0USER00001");
  const V2 = slackPerson("dev-2", "U0USER00002");
  function setup() {
    const w = world();
    const live: { info: SlackChannelInfo } = { info: { kind: "private", extShared: false, memberIds: ["U0USER00001", "U0USER00002"] } };
    const directory = withChannelInfoCache({ channelInfo: async () => live.info });
    const tap = createSlackRecordTap({
      edition: "enterprise", sink: w.sink, distiller: { distillTransient: async () => ({ accepted: true }) },
      actors: { resolve: async () => ({ trust: "member" }), resolveDeveloper: async () => ({ trust: "member" }) },
      mode: createCaptureModePort(w.deps), config: createSourceConfigPort(w.deps),
      resolveWorkspace: async () => ({ workspaceId: ORG_A, project: "web" }), directory,
    } as never);
    return { w, live, tap };
  }
  const message = (t: number, text: string, channel: string, user = "U0USER00002") => ({ type: "event_callback", team_id: TEAM, event: { type: "message", channel, user, text, ts: ts(t) } });

  it("C1 a message built from the stale member cache after U1 left, with the leave delivered late: U1 finds nothing", async () => {
    const { w, live, tap } = setup();
    await addSource(w, { source: "slack", scope: `slack:${TEAM}/${PRIV}`, retention: "D" });
    await tap(message(0, "kickoff zebra alpha", PRIV)); // fills the cache with [U1, U2]
    live.info = { kind: "private", extShared: false, memberIds: ["U0USER00002"] };
    await tap(message(630, "layoff plan zebra beta", PRIV)); // posted after the leave, built from the cached list
    await tap({ type: "event_callback", team_id: TEAM, event: { type: "member_left_channel", channel: PRIV, channel_type: "G", user: "U0USER00001", event_ts: ts(600) } });
    expect((await search(w, V1, "zebra")).hits).toHaveLength(0);
    expect((await search(w, V2, "zebra")).hits).toHaveLength(2);
    // a message that arrives later with the old cached list (a retry) cannot give the person access back
    await tap(message(640, "more zebra gamma", PRIV));
    expect((await search(w, V1, "zebra")).hits).toHaveLength(0);
  });

  it("final review 3 C1: the bot's own join (it comes first, on every invite), then a person's leave: the leaver can no longer read what was recorded", async () => {
    const { w, live, tap } = setup();
    await addSource(w, { source: "slack", scope: `slack:${TEAM}/${PRIV}`, retention: "D" });
    live.info = { kind: "private", extShared: false, memberIds: ["U0USER00001", "U0USER00002", "U0ROVARABOT"] };
    await tap({ type: "event_callback", team_id: TEAM, event: { type: "member_joined_channel", channel: PRIV, channel_type: "G", user: "U0ROVARABOT", inviter: "U0USER00001", event_ts: ts(0) } });
    await tap(message(10, "kickoff zebra alpha", PRIV));
    expect((await search(w, V1, "zebra")).hits).toHaveLength(1); // still a member
    await tap({ type: "event_callback", team_id: TEAM, event: { type: "member_left_channel", channel: PRIV, channel_type: "G", user: "U0USER00001", event_ts: ts(60) } });
    expect((await search(w, V1, "zebra")).hits).toHaveLength(0);
    expect((await search(w, V2, "zebra")).hits).toHaveLength(1);
    // a later message, even one built from a cached list that still names the leaver, does not give the access back
    await tap(message(70, "more zebra beta", PRIV));
    expect((await search(w, V1, "zebra")).hits).toHaveLength(0);
  });

  it("C2 a public channel turns private with the broker clock behind Slack's: the team group loses the old rows", async () => {
    const { w, live, tap } = setup();
    const CH = "C0123456789";
    await addSource(w, { source: "slack", scope: `slack:${TEAM}/${CH}`, retention: "D" });
    live.info = { kind: "public", extShared: false };
    const slackNow = Math.floor(Date.now() / 1000) + 5;
    await tap({ type: "event_callback", team_id: TEAM, event: { type: "message", channel: CH, user: "U0USER00002", text: "secret roadmap quokka", ts: `${String(slackNow)}.000100` } });
    const teamMember = slackPerson("dev-9", "U0USER00009", [TEAM]);
    expect((await search(w, teamMember, "quokka")).hits).toHaveLength(1); // public: the team group reads it
    live.info = { kind: "private", extShared: false, memberIds: ["U0USER00002"] };
    await tap({ type: "event_callback", team_id: TEAM, event: { type: "channel_convert_to_private", channel: CH, event_ts: `${String(slackNow + 1)}.000100` } });
    expect((await search(w, teamMember, "quokka")).hits).toHaveLength(0);
    expect((await search(w, V2, "quokka")).hits).toHaveLength(1);
  });
});

describe("the read-time check itself", () => {
  it("a restricted row whose place has no access record is dropped (fail closed)", async () => {
    const w = world();
    await seed(w, 5);
    expect(await hits(w, "U2")).toBe(5);
    for (const item of w.db.find((row) => row.entityType === "TEAM_RECORD_ACCESS")) w.db.delete({ pk: String(item.pk), sk: String(item.sk) });
    expect(await hits(w, "U2")).toBe(0);
  });

  it("a record that cannot be read fails the call as unavailable: never visible, never reported as hidden", async () => {
    const w = world();
    await seed(w, 5);
    w.db.injectFault({ command: "BatchGetCommand", error: { name: "InternalServerError" }, times: 100 });
    await expect(search(w, U.U2)).rejects.toThrow(/RUNTIME_UNAVAILABLE/);
    const [record] = w.db.find((row) => row.entityType === "TEAM_RECORD_ACCESS");
    w.db.set({ ...record, seeded: "yes" });
    await expect(search(w, U.U2)).rejects.toThrow(/RUNTIME_UNAVAILABLE/);
  });

  it("a restricted record on a place above hides the rows below it", async () => {
    const w = world();
    await seed(w, 5);
    expect(await hits(w, "U2")).toBe(5);
    await applyAudienceEvent(w.table, ORG_A, { scope: "slack:T1", audience: acl("slack:T1", ["U9"], T1), at: T1 });
    expect(await hits(w, "U2")).toBe(0);
    await applyMemberEvents(w.table, ORG_A, { scope: "slack:T1", add: ["U2"], at: T2 });
    expect(await hits(w, "U2")).toBe(5);
  });

  it("a shared task (no person) never reads a place a record restricts, even for a row the project can see", async () => {
    const w = world();
    await addSource(w, { source: "slack", scope: SC, audienceDefault: "project" });
    await w.sink.put(githubDraft({ source: "slack", kind: "slack.message", repo: undefined, sourceRef: { system: "T1", id: "p1", version: "1" }, audience: { kind: "project" }, scope: SC, actor: { sourceId: "U2", trust: "member" }, text: "layoff plan", links: [] }));
    const shared = () => recordSearch({ table: w.table, modes: w.deps.modes, now: () => w.clock.ms }, { kind: "shared", orgId: ORG_A }, "web", { query: "layoff", limit: 10 });
    expect((await shared()).hits).toHaveLength(1);
    await applyAudienceEvent(w.table, ORG_A, { scope: SC, audience: acl(SC, ["U2"], T1), at: T1 });
    expect((await shared()).hits).toHaveLength(0);
    expect(await hits(w, "U3")).toBe(0);
    expect(await hits(w, "U2")).toBe(1);
  });

  it("the records of a page are fetched in two batches (headers, then the reader's entries) for the whole request", async () => {
    const w = world();
    for (const channel of ["C1", "C2", "C3"]) await seed(w, 5, `slack:T1/${channel}`);
    const before = w.db.commandNames().filter((name) => name === "BatchGetCommand").length;
    expect((await search(w, U.U2)).hits).toHaveLength(15);
    // one batch for the three headers and one for the reader's own entries, for the whole request
    expect(w.db.commandNames().filter((name) => name === "BatchGetCommand").length - before).toBe(2);
  });

  it("a snapshot-fed place follows a newer snapshot until the first event, then only events", async () => {
    const w = world();
    await addSource(w, { source: "github", scope: "github:repo/5" });
    const gh = (id: string, principals: string[], capturedAt: string) => githubDraft({ sourceRef: { system: "github.com", id, version: "1" }, links: [], audience: { kind: "restricted", acl: { source: "github", scope: "github:repo/5", principals, capturedAt, liveCheck: "none" } } });
    const ghCaller = (id: string) => caller({ developerId: `d-${id}`, identities: { ids: { github: [id] }, groups: {} } });
    await w.sink.put(gh("a", ["1", "2"], T1));
    await w.sink.put(gh("b", ["2"], T2)); // 1 was removed at the source
    expect((await search(w, ghCaller("1"), "withRetry")).hits).toHaveLength(0);
    expect((await search(w, ghCaller("2"), "withRetry")).hits.length).toBeGreaterThan(0);
    await applyMemberEvents(w.table, ORG_A, { scope: "github:repo/5", add: ["3"], at: T2 }); // the first event: from now on only events feed it
    await w.sink.put(gh("c", ["1", "2"], T3)); // an old-looking snapshot cannot grant 1 again
    expect((await search(w, ghCaller("1"), "withRetry")).hits).toHaveLength(0);
  });
});
