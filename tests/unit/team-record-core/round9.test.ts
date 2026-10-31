// Fix round 9 (Opus recheck-8): the access unit is the source's own ACL unit (R8-5), a record is one header plus one item per person (R8-2), a unit never seeded is an overlay
// of events (R8-4), an erase removes the person everywhere (R8-3), the learning lane reads through the same check (R8-1), and the low items (R8-6, R8-7, R8-8).
import { describe, expect, it } from "vitest";
import { createAccessReader, applyAudienceEvent, applyMemberEvents } from "../../../packages/broker/src/team-record/access.js";
import { createAccessCheckPort } from "../../../packages/broker/src/team-record/access-port.js";
import { runDeleteWorker } from "../../../packages/broker/src/team-record/delete-worker.js";
import { erasePerson } from "../../../packages/broker/src/team-record/erase.js";
import { pastWork, recordSearch } from "../../../packages/broker/src/team-record/query.js";
import { createCaptureModePort, createRecordSink, createSourceConfigPort } from "../../../packages/broker/src/team-record/sink.js";
import { createSlackRecordTap, withChannelInfoCache, type SlackChannelInfo } from "../../../packages/broker/src/team-record/sources/slack.js";
import { listScopeWork } from "../../../packages/broker/src/team-record/store.js";
import { buildWeeklyDigest } from "../../../packages/broker/src/lessons/digest.js";
import { learnedContextForDispatch, loadLessonsForStage, type LoadDeps } from "../../../packages/broker/src/lessons/load.js";
import { lessonPanelRows } from "../../../packages/broker/src/lessons/panel.js";
import { InMemoryLessonStore } from "../../../packages/broker/src/lessons/store.js";
import { recordAccessKey, recordAccessMemberKey, recordAccessPersonPrefix } from "@agentx/contracts";
import { ORG_A, addSource, caller, githubDraft, rows, world, type World } from "../../support/team-record-core.js";
import { deleteDeps } from "../../support/team-record-delete.js";
import { Audit, Clock, MemoryVectors, PROJECT, embedder, lessonRecord, seed as seedLessons, settings } from "../lessons/lesson-helpers.js";

const T1 = "2026-10-30T09:00:00.000Z";
const T2 = "2026-10-30T10:00:00.000Z";
const T3 = "2026-10-30T11:00:00.000Z";
const SC = "slack:T1/C9";
const acl = (scope: string, principals: string[], capturedAt = T1, groups?: string[]) => ({ kind: "restricted" as const, acl: { source: "slack", scope, ...(principals.length === 0 ? {} : { principals }), ...(groups === undefined ? {} : { groups }), capturedAt, liveCheck: "none" as const } });
const who = (dev: string, uid: string, extra: { role?: "maintainer" | "contributor"; source?: string } = {}) => caller({ developerId: dev, projectRole: extra.role ?? "contributor", identities: { ids: { [extra.source ?? "slack"]: [uid] }, groups: {} } });
const U = { U1: who("dev-1", "U1"), U2: who("dev-2", "U2"), U3: who("dev-3", "U3") };
const slackRow = (id: string, scope: string, principals = ["U1", "U2"], capturedAt = T1) => githubDraft({ source: "slack", kind: "slack.message", repo: undefined, sourceRef: { system: "T1", id, version: "1" }, audience: acl(scope, principals, capturedAt), actor: { sourceId: "U2", trust: "member" }, text: "layoff plan", links: [] });
const search = (w: World, person: typeof U.U1, query = "layoff") => recordSearch({ table: w.table, modes: w.deps.modes, now: () => w.clock.ms }, { kind: "caller", caller: person }, "web", { query, limit: 20 });
const hits = async (w: World, who: keyof typeof U) => (await search(w, U[who])).hits.length;
const accessItems = (w: World, type: string) => rows(w, type);
async function seed(w: World, n: number, scope = SC, principals = ["U1", "U2"]) {
  await addSource(w, { source: "slack", scope });
  for (let i = 0; i < n; i += 1) await w.sink.put(slackRow(`m${String(i)}${scope}`, scope, principals));
}

// ---- R8-5: the unit is the source's own ACL unit

describe("R8-5 per-item ACLs do not collapse into the place", () => {
  const issue = (id: string, key: string, audience: unknown, source: "jira" | "linear" | "mcp", place: string, extra: Record<string, unknown> = {}) => githubDraft({
    source, kind: "ticket.created", repo: undefined, sourceRef: { system: `${source}.example`, id, version: "1", ...(extra.parentId === undefined ? {} : { parentId: extra.parentId as string }) },
    audience: audience as never, scope: place, actor: { sourceId: "u9", trust: "member" }, trust: "member", text: `Billing ${key} retry storm`, links: [],
  });
  const maintainersOnly = (place: string) => ({ kind: "restricted", acl: { source: "jira", scope: place, groups: ["project:maintainers"], capturedAt: T1, liveCheck: "none" } });

  it("one security-level issue does not hide the open issues of its project", async () => {
    const w = world();
    const PLACE = "jira:project/KEY";
    await addSource(w, { source: "jira", scope: PLACE, audienceDefault: "project" });
    await w.sink.put(issue("KEY-1", "one", { kind: "project" }, "jira", PLACE));
    await w.sink.put(issue("KEY-2", "two", { kind: "project" }, "jira", PLACE));
    await w.sink.put(issue("KEY-7", "secret", maintainersOnly(PLACE), "jira", PLACE));
    const contributor = who("dev-9", "9", { source: "jira" });
    const maintainer = who("dev-8", "8", { source: "jira", role: "maintainer" });
    const query = (person: typeof contributor) => recordSearch({ table: w.table, modes: w.deps.modes, now: () => w.clock.ms }, { kind: "caller", caller: person }, "web", { query: "billing retry", limit: 20 });
    expect((await query(contributor)).hits).toHaveLength(2);
    expect((await query(maintainer)).hits).toHaveLength(3);
    // the place has no record of its own; the restricted issue has its own unit
    expect(w.db.find((item) => item.entityType === "TEAM_RECORD_ACCESS").map((item) => String(item.scope))).toEqual([expect.stringMatching(/^jira:project\/KEY\/item:/)]);
  });

  it("a newer item's list never replaces another item's: two items in one team keep their own readers", async () => {
    const w = world();
    const PLACE = "linear:team/ENG";
    await addSource(w, { source: "linear", scope: PLACE });
    const lin = (id: string, principals: string[]) => issue(id, id, { kind: "restricted", acl: { source: "linear", scope: PLACE, principals, capturedAt: id === "ENG-1" ? T1 : T2, liveCheck: "none" } }, "linear", PLACE);
    await w.sink.put(lin("ENG-1", ["P1"]));
    await w.sink.put(lin("ENG-2", ["P2"]));
    const reader = (id: string) => who(`dev-${id}`, id, { source: "linear" });
    const seen = async (person: typeof U.U1) => (await recordSearch({ table: w.table, modes: w.deps.modes, now: () => w.clock.ms }, { kind: "caller", caller: person }, "web", { query: "billing", limit: 20 })).hits.map((hit) => hit.id).length;
    expect(await seen(reader("P1"))).toBe(1);
    expect(await seen(reader("P2"))).toBe(1);
    // a new version of item 1 with a different list changes item 1 only
    const second = lin("ENG-1", ["P1", "P3"]);
    await w.sink.put({ ...second, audience: { kind: "restricted", acl: { source: "linear", scope: PLACE, principals: ["P1", "P3"], capturedAt: T3, liveCheck: "none" } }, sourceRef: { system: "linear.example", id: "ENG-1", version: "2" }, occurredAt: "2026-10-30T10:30:00.000Z" } as never);
    expect(await seen(reader("P3"))).toBe(1);
    expect(await seen(reader("P2"))).toBe(1);
  });

  it("an issue and its comments share one unit (the parent's)", async () => {
    const w = world();
    const PLACE = "jira:project/KEY";
    await addSource(w, { source: "jira", scope: PLACE });
    await w.sink.put(issue("KEY-7", "a", maintainersOnly(PLACE), "jira", PLACE));
    await w.sink.put({ ...issue("KEY-7#c1", "b", maintainersOnly(PLACE), "jira", PLACE, { parentId: "KEY-7" }), kind: "ticket.comment" } as never);
    expect(w.db.find((item) => item.entityType === "TEAM_RECORD_ACCESS")).toHaveLength(1);
  });
});

// ---- R8-2: one item per person

describe("R8-2 a record is a header plus one item per person", () => {
  it("has no size limit: a thousand joins leave the header small, and a leave is one conditional write", async () => {
    const w = world();
    await seed(w, 3);
    const people = Array.from({ length: 1_200 }, (_, i) => `P${String(i)}`);
    for (let at = 0; at < people.length; at += 200) await applyMemberEvents(w.table, ORG_A, { scope: SC, add: people.slice(at, at + 200), at: T1 });
    const header = w.db.find((item) => item.entityType === "TEAM_RECORD_ACCESS")[0]!;
    expect(JSON.stringify(header).length).toBeLessThan(600);
    expect(w.db.find((item) => item.entityType === "TEAM_RECORD_ACCESS_MEMBER").length).toBeGreaterThan(1_200);
    const sent: string[] = [];
    const real = w.table.documentClient;
    w.table.documentClient = { send: async (command: unknown) => { sent.push((command as { constructor: { name: string } }).constructor.name); return real.send(command); } };
    await applyMemberEvents(w.table, ORG_A, { scope: SC, remove: ["P7"], at: T2 });
    w.table.documentClient = real;
    expect(sent.filter((name) => name === "PutCommand" || name === "UpdateCommand")).toHaveLength(4); // marker check is a read; header guard, index, entry, fed
    expect(w.db.get(recordAccessMemberKey(ORG_A, SC, "P7").pk, recordAccessMemberKey(ORG_A, SC, "P7").sk)).toSatisfy((item: { v?: string } | undefined) => item?.v?.endsWith("|1") === true);
  });

  it("the read asks for the header and the reader's own entries only", async () => {
    const w = world();
    await seed(w, 3);
    await applyMemberEvents(w.table, ORG_A, { scope: SC, add: Array.from({ length: 300 }, (_, i) => `P${String(i)}`), at: T1 });
    const keys: number[] = [];
    const real = w.table.documentClient;
    w.table.documentClient = { send: async (command: unknown) => { const input = (command as { input?: { RequestItems?: Record<string, { Keys: unknown[] }> } }).input; if (input?.RequestItems !== undefined) keys.push(Object.values(input.RequestItems)[0]!.Keys.length); return real.send(command); } };
    expect((await search(w, U.U2)).hits).toHaveLength(3);
    w.table.documentClient = real;
    expect(keys).toEqual([2, 1]); // the headers of the channel and the team above it, then the one entry of the one id the reader has
  });
});

describe("R8-8 batching, backoff, and an unavailable record", () => {
  const withUnprocessed = (w: World, failFirst: number) => {
    const real = w.table.documentClient;
    let calls = 0;
    w.table.documentClient = {
      send: async (command: unknown) => {
        const named = command as { constructor: { name: string }; input: { RequestItems: Record<string, { Keys: Array<{ pk: string; sk: string }> }> } };
        if (named.constructor.name !== "BatchGetCommand") return real.send(command);
        calls += 1;
        const [table, spec] = Object.entries(named.input.RequestItems)[0]!;
        if (calls <= failFirst) return { Responses: { [table]: [] }, UnprocessedKeys: { [table]: { Keys: spec.Keys } } };
        return real.send(command);
      },
    };
    return () => { w.table.documentClient = real; };
  };

  it("pages past the 100-key limit and retries unprocessed keys with growing backoff", async () => {
    const w = world();
    for (let i = 0; i < 130; i += 1) await seed(w, 1, `slack:T1/C${String(i)}`);
    const restore = withUnprocessed(w, 3);
    const waits: number[] = [];
    const reader = createAccessReader(w.table, ORG_A, { sleep: async (ms) => { waits.push(ms); } });
    await reader.load(Array.from({ length: 130 }, (_, i) => `slack:T1/C${String(i)}`), { ids: () => ["U2"], groups: () => [], maintainer: false });
    restore();
    expect(waits.length).toBeGreaterThanOrEqual(3);
    expect(waits).toEqual([...waits].sort((a, b) => a - b));
    expect(new Set(waits).size).toBeGreaterThan(1);
    expect(reader.get("slack:T1/C0").kind).toBe("ok");
    expect(reader.get("slack:T1/C129").kind).toBe("ok");
  });

  it("keys that stay unprocessed read as unavailable, and a search then fails as unavailable (not hidden, not shown)", async () => {
    const w = world();
    await seed(w, 4);
    const restore = withUnprocessed(w, 1_000);
    const reader = createAccessReader(w.table, ORG_A, { sleep: async () => undefined });
    await reader.load([SC], { ids: () => ["U2"], groups: () => [], maintainer: false });
    expect(reader.get(SC).kind).toBe("unavailable");
    restore();
    w.db.injectFault({ command: "BatchGetCommand", error: { name: "ProvisionedThroughputExceededException" }, times: 100 });
    await expect(search(w, U.U2)).rejects.toThrow(/RUNTIME_UNAVAILABLE/);
  });
});

// ---- R8-4: an unseeded unit is an overlay of events

describe("R8-4 a member event before the first message", () => {
  const TEAM = "T0TEAM00001";
  const PRIV = "G0123456789";
  const ts = (sec: number) => `${String(1793358000 + sec)}.000100`;
  const slackPerson = (dev: string, uid: string) => caller({ developerId: dev, identities: { ids: { slack: [uid] }, groups: {} } });
  const V1 = slackPerson("dev-1", "U0USER00001");
  const V2 = slackPerson("dev-2", "U0USER00002");
  function setup() {
    const w = world();
    const live: { info: SlackChannelInfo; failRead: boolean } = { info: { kind: "private", extShared: false, memberIds: ["U0USER00001", "U0USER00002", "U0ROVARABOT"] }, failRead: false };
    const directory = withChannelInfoCache({ channelInfo: async () => { if (live.failRead) throw new Error("slack down"); return live.info; } });
    const tap = createSlackRecordTap({
      edition: "enterprise", sink: w.sink, distiller: { distillTransient: async () => ({ accepted: true }) },
      actors: { resolve: async () => ({ trust: "member" }), resolveDeveloper: async () => ({ trust: "member" }) }, mode: createCaptureModePort(w.deps), config: createSourceConfigPort(w.deps),
      resolveWorkspace: async () => ({ workspaceId: ORG_A, project: "web" }), directory,
    } as never);
    return { w, live, tap };
  }
  const invite = { type: "event_callback", team_id: TEAM, event: { type: "member_joined_channel", channel: PRIV, channel_type: "G", user: "U0ROVARABOT", event_ts: ts(0) } };
  const message = (t: number, text: string, user = "U0USER00002") => ({ type: "event_callback", team_id: TEAM, event: { type: "message", channel: PRIV, user, text, ts: ts(t) } });
  const seen = async (w: World, person: typeof V1) => (await search(w, person, "zebra")).hits.length;

  it("the app's own invite comes first (list readable): every member who should read the channel does", async () => {
    const { w, tap } = setup();
    await addSource(w, { source: "slack", scope: `slack:${TEAM}/${PRIV}`, retention: "D" });
    await tap(invite);
    expect(w.db.find((item) => item.entityType === "TEAM_RECORD_ACCESS")[0]).toMatchObject({ seeded: true }); // seeded from the full list at the invite, before any message
    await tap(message(10, "kickoff zebra alpha"));
    await tap(message(20, "more zebra beta", "U0USER00001"));
    expect(await seen(w, V1)).toBe(2);
    expect(await seen(w, V2)).toBe(2);
  });

  it("the member list cannot be read at the invite: the unit is an overlay, the first message seeds it, nobody is locked out", async () => {
    const { w, live, tap } = setup();
    await addSource(w, { source: "slack", scope: `slack:${TEAM}/${PRIV}`, retention: "D" });
    live.failRead = true;
    await tap(invite);
    expect(w.db.find((item) => item.entityType === "TEAM_RECORD_ACCESS")[0]).toMatchObject({ seeded: false });
    live.failRead = false;
    await tap(message(10, "kickoff zebra alpha"));
    await tap(message(20, "more zebra beta", "U0USER00001"));
    expect(await seen(w, V1)).toBe(2);
    expect(await seen(w, V2)).toBe(2);
    expect(w.db.find((item) => item.entityType === "TEAM_RECORD_ACCESS")[0]).toMatchObject({ seeded: true });
  });

  it("an overlay reads by the row's own snapshot, minus a removal newer than that snapshot", async () => {
    const w = world();
    await addSource(w, { source: "slack", scope: SC });
    await applyMemberEvents(w.table, ORG_A, { scope: SC, remove: ["U1"], at: T2 }); // unseeded: only this entry
    // read the overlay directly (the rows below are written around the sink, as a snapshot from before the removal and one from after it)
    const put = async (id: string, capturedAt: string) => w.sink.put(slackRow(id, SC, ["U1", "U2"], capturedAt));
    const header = w.db.find((item) => item.entityType === "TEAM_RECORD_ACCESS")[0]!;
    expect(header).toMatchObject({ seeded: false });
    w.db.set({ ...header, seeded: false }); // keep it unseeded while the rows come in
    await put("old", T1);
    // the first row would seed it, so check the verdict through a header forced back to unseeded
    w.db.set({ ...w.db.find((item) => item.entityType === "TEAM_RECORD_ACCESS")[0]!, seeded: false });
    expect(await hits(w, "U1")).toBe(0); // the snapshot (T1) is older than the removal (T2)
    expect(await hits(w, "U2")).toBe(1);
    await put("new", T3);
    w.db.set({ ...w.db.find((item) => item.entityType === "TEAM_RECORD_ACCESS")[0]!, seeded: false });
    expect(await hits(w, "U1")).toBe(1); // the row captured at T3 was read after the removal: only that row
  });
});

// ---- R8-3: erasure

describe("R8-3 erase removes the person from every access record", () => {
  it("leaves no entry or index item in any unit, even where the person never posted, and a later event writes nothing", async () => {
    const w = world();
    await seed(w, 2, "slack:T1/C1", ["U1", "U2"]);
    await seed(w, 2, "slack:T1/C2", ["U1", "U2"]);
    await w.sink.put(slackRow("only-here", "slack:T1/C1", ["U1", "U2"]));
    const d = deleteDeps(w);
    const result = await erasePerson(d.deps, ORG_A, { identities: [{ system: "slack:T1", sourceId: "U1" }] }, "erase-u1");
    expect(result.complete).toBe(true);
    for (const scope of ["slack:T1/C1", "slack:T1/C2"]) expect(w.db.get(recordAccessMemberKey(ORG_A, scope, "U1").pk, recordAccessMemberKey(ORG_A, scope, "U1").sk)).toBeUndefined();
    expect(w.db.find((item) => String(item.sk).startsWith(recordAccessPersonPrefix("U1")))).toEqual([]);
    expect(w.db.get(recordAccessMemberKey(ORG_A, "slack:T1/C1", "U2").pk, recordAccessMemberKey(ORG_A, "slack:T1/C1", "U2").sk)).toBeDefined();
    const again = await applyMemberEvents(w.table, ORG_A, { scope: "slack:T1/C1", add: ["U1"], at: T3 });
    expect(again.applied.add).toEqual([]);
    expect(w.db.find((item) => String(item.sk).startsWith(recordAccessPersonPrefix("U1")))).toEqual([]);
    await applyAudienceEvent(w.table, ORG_A, { scope: "slack:T1/C2", audience: acl("slack:T1/C2", ["U1", "U2"], T3), at: T3 });
    expect(w.db.get(recordAccessMemberKey(ORG_A, "slack:T1/C2", "U1").pk, recordAccessMemberKey(ORG_A, "slack:T1/C2", "U1").sk)).toBeUndefined();
  });

  it("a deleted place loses its whole record with it", async () => {
    const w = world();
    await seed(w, 2);
    await applyMemberEvents(w.table, ORG_A, { scope: SC, add: ["U7"], at: T1 });
    await w.sink.tombstone({ workspaceId: ORG_A, system: "T1", scope: SC, cause: "source_deleted" });
    for (let run = 0; run < 5 && (await listScopeWork(w.table, ORG_A, 5)).length > 0; run += 1) await runDeleteWorker(deleteDeps(w).deps, ORG_A, { maxRequests: 10, maxItems: 500, maxMs: 10_000 });
    expect(accessItems(w, "TEAM_RECORD_ACCESS")).toEqual([]);
    expect(accessItems(w, "TEAM_RECORD_ACCESS_MEMBER")).toEqual([]);
    expect(accessItems(w, "TEAM_RECORD_ACCESS_INDEX")).toEqual([]);
  });
});

// ---- R8-6, R8-7

describe("the low items", () => {
  it("R8-6 a repository turned public: its new public rows are visible, the old private rows stay private", async () => {
    const w = world();
    await addSource(w, { source: "github", scope: "github:repo/5" });
    const priv = githubDraft({ sourceRef: { system: "github.com", id: "a", version: "1" }, links: [], audience: { kind: "restricted", acl: { source: "github", scope: "github:repo/5", principals: ["1"], capturedAt: T1, liveCheck: "none" } } });
    await w.sink.put(priv);
    const open = githubDraft({ sourceRef: { system: "github.com", id: "b", version: "1" }, links: [], scope: "github:repo/5", audience: { kind: "project" }, occurredAt: "2026-10-30T10:30:00.000Z" });
    await w.sink.put(open);
    const member = who("d-9", "9", { source: "github" });
    const mine = (await search(w, member, "withRetry")).hits;
    expect(mine).toHaveLength(1);
    expect(mine[0]!.id).toBeDefined();
  });

  it("R8-7 a late, older leave does not lock out a member who rejoined after it: the rows keep them", async () => {
    const w = world();
    await seed(w, 20);
    const sink = createRecordSink(w.deps, { budget: { maxItems: 5_000, maxMs: 30_000 } });
    await sink.changePrincipals({ workspaceId: ORG_A, scope: SC, add: ["U3"], at: T2 });
    await sink.changePrincipals({ workspaceId: ORG_A, scope: SC, remove: ["U3"], at: T1 }); // delivered late
    expect(await hits(w, "U3")).toBe(20);
    expect([...new Set(rows(w, "TEAM_RECORD_EVENT").map((r) => ((r.audience as { acl: { principals: string[] } }).acl.principals).join(",")))]).toEqual(["U1,U2,U3"]);
  });
});

// ---- R8-1: learning v2 reads through the same check

describe("R8-1 learning v2 asks the access records at read time", () => {
  const WS = ORG_A;
  const restrictedAudience = (scope: string) => ({ kind: "restricted" as const, acl: { source: "slack" as const, scope, principals: ["U-member"], capturedAt: T1, liveCheck: "none" as const } });
  const lessonFor = (over: Record<string, unknown> = {}) => {
    const base = lessonRecord({ id: "les_slack001", type: "convention", tier: 1, workspaceId: WS } as never);
    return { ...base, ...over, provenance: { ...base.provenance, audience: restrictedAudience(SC), sourceScopes: [SC], ...((over.provenance as object | undefined) ?? {}) } } as never;
  };
  async function setup() {
    const w = world();
    await addSource(w, { source: "slack", scope: SC });
    await w.sink.put(slackRow("m1", SC, ["U-member", "U-other"]));
    const store = new InMemoryLessonStore();
    const vectors = new MemoryVectors();
    const clock = new Clock();
    const deps: LoadDeps = { store, embedder, vectors, settings: settings(), audit: new Audit(), now: clock.now, access: createAccessCheckPort(w.table) };
    const lesson = lessonFor();
    await seedLessons(store, lesson);
    await vectors.upsert(WS, PROJECT, (lesson as { id: string }).id, await embedder.embed("x"), { status: "active" });
    return { w, store, deps };
  }
  const request = (identity: { principals: string[]; groups: string[] } | undefined) => ({
    workspaceId: WS, project: PROJECT, taskId: "t1", stage: "IMPLEMENT" as const, round: 1, intent: "Retry failed HTTP calls", repos: ["api"], files: ["src/retry/client.ts"], languages: [],
    taskAudience: identity === undefined ? { kind: "shared" as const } : { kind: "private" as const, identity },
  });
  const member = { principals: ["U-member"], groups: [] };
  const key = { workspaceId: WS, project: PROJECT };

  it("the loader stops loading a channel's lesson into the private task of a person removed from the channel", async () => {
    const { w, deps } = await setup();
    expect((await loadLessonsForStage(deps, request(member))).context?.lessons.map((l) => l.id)).toEqual(["les_slack001"]);
    await applyMemberEvents(w.table, ORG_A, { scope: SC, remove: ["U-member"], at: T2 });
    expect((await loadLessonsForStage(deps, request(member))).context).toBeUndefined();
    expect((await learnedContextForDispatch(deps, request(member), ["task.learnedContext.v1"])).learnedContext).toBeUndefined();
  });

  it("the digest and the panel drop the lesson for a removed person, and keep it for a member", async () => {
    const { w, deps, store } = await setup();
    const asMember = await buildWeeklyDigest(store, key, deps.now(), member, deps.access);
    expect(asMember.top.map((item) => item.id)).toEqual(["les_slack001"]);
    await store.putManifest({ taskId: "t1", workspaceId: WS, project: PROJECT, stage: "IMPLEMENT", round: 1, setVersion: 1, memory: "live", at: 1, lessons: [{ id: "les_slack001", version: 1, score: 0.5, why: "scope", citation: "valid" }], bytes: 100 });
    expect((await lessonPanelRows(store, key, "t1", member, deps.access))[0]).toMatchObject({ visible: true });
    await applyMemberEvents(w.table, ORG_A, { scope: SC, remove: ["U-member"], at: T2 });
    const after = await buildWeeklyDigest(store, key, deps.now(), member, deps.access);
    expect(after.top).toEqual([]);
    expect(after.restrictedHidden).toBe(1);
    expect((await lessonPanelRows(store, key, "t1", member, deps.access))[0]).toMatchObject({ visible: false, canMark: false });
  });

  it("a project-wide lesson learned from a channel that later turned private is not shown to a shared task or a non-member", async () => {
    const { w, deps, store } = await setup();
    await seedLessons(store, lessonFor({ id: "les_proj0001", provenance: { audience: { kind: "project" }, sourceScopes: ["slack:T1/CPUB"] } }));
    await deps.vectors.upsert(WS, PROJECT, "les_proj0001", await embedder.embed("x"), { status: "active" });
    await addSource(w, { source: "slack", scope: "slack:T1/CPUB" });
    await w.sink.put(slackRow("p1", "slack:T1/CPUB", ["U-other"]));
    const idsFor = async (identity: { principals: string[]; groups: string[] } | undefined) => ((await loadLessonsForStage(deps, request(identity))).context?.lessons ?? []).map((l) => l.id);
    expect(await idsFor(undefined)).toEqual([]); // the channel is restricted: a shared task is nobody
    expect(await idsFor({ principals: ["U-stranger"], groups: [] })).toEqual([]);
    expect(await idsFor({ principals: ["U-other"], groups: [] })).toContain("les_proj0001");
  });

  it("a caller that cannot supply the access port gets no lessons, an empty digest and hidden panel rows, each with a log line", async () => {
    const { deps, store } = await setup();
    const lines: string[] = [];
    const log = (event: string) => { lines.push(event); };
    const without = { ...deps, access: undefined as never, log };
    const loaded = await loadLessonsForStage(without, request(member));
    expect(loaded.context).toBeUndefined();
    expect(loaded.skipped).toBe("access_unavailable");
    expect((await learnedContextForDispatch(without, request(member), ["task.learnedContext.v1"])).learnedContext).toBeUndefined();
    const digest = await buildWeeklyDigest(store, key, deps.now(), member, undefined as never, log);
    expect(digest.top).toEqual([]);
    expect(digest.restrictedHidden).toBe(1);
    await store.putManifest({ taskId: "t1", workspaceId: WS, project: PROJECT, stage: "IMPLEMENT", round: 1, setVersion: 1, memory: "live", at: 1, lessons: [{ id: "les_slack001", version: 1, score: 0.5, why: "scope", citation: "valid" }], bytes: 100 });
    expect((await lessonPanelRows(store, key, "t1", member, undefined as never, log))[0]).toMatchObject({ visible: false, canMark: false });
    expect(lines).toEqual(expect.arrayContaining(["learning.load_no_access_port", "learning.digest_no_access_port", "learning.panel_no_access_port"]));
  });

  it("a record that cannot be read loads no lessons (and the load says why)", async () => {
    const { w, deps } = await setup();
    w.db.injectFault({ command: "BatchGetCommand", error: { name: "InternalServerError" }, times: 100 });
    const result = await loadLessonsForStage(deps, request(member));
    expect(result.context).toBeUndefined();
    expect(result.skipped).toBe("access_unavailable");
  });

  it("past_work checks a lesson's real source places, not the joined string, and drops a lesson from a place the asker left", async () => {
    const w = world();
    for (const scope of ["slack:T1/CA", "slack:T1/CB"]) { await addSource(w, { source: "slack", scope }); await w.sink.put(slackRow(`x${scope}`, scope, ["U2"])); }
    const joined = { kind: "restricted" as const, acl: { source: "slack" as const, scope: "slack:T1/CA+slack:T1/CB", principals: ["U2"], capturedAt: T1, liveCheck: "none" as const } };
    const deps = { table: w.table, modes: w.deps.modes, now: () => w.clock.ms, tasks: { async search() { return [{ taskId: "t1", title: "T", status: "merged", pullRequests: [], planSummary: "p", audience: { kind: "project" as const }, trust: "member" as const }]; } },
      lessonsOfTask: async () => [{ title: "Both channels lesson", audience: joined, scopes: ["slack:T1/CA", "slack:T1/CB"], restrictedScopes: ["slack:T1/CA", "slack:T1/CB"] }] };
    const ask = async () => (await pastWork(deps, { kind: "caller", caller: U.U2 }, "private", "web", { query: "x" })).items[0]?.lessonsLearned ?? [];
    expect(await ask()).toEqual(["Both channels lesson"]);
    await applyMemberEvents(w.table, ORG_A, { scope: "slack:T1/CB", remove: ["U2"], at: T2 });
    expect(await ask()).toEqual([]);
  });
});

describe("the access header is the only thing a key leaks", () => {
  it("no key holds a raw person id", async () => {
    const w = world();
    await seed(w, 1);
    await applyMemberEvents(w.table, ORG_A, { scope: SC, add: ["U-secret-id"], at: T1 });
    expect(JSON.stringify(w.db.find((item) => String(item.sk).startsWith("ACCESS")).map((item) => [item.pk, item.sk]))).not.toContain("U-secret-id");
    expect(w.db.get(recordAccessKey(ORG_A, SC).pk, recordAccessKey(ORG_A, SC).sk)).toBeDefined();
  });
});
