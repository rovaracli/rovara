// Fix round 10 (R9-1): the approval queues, the decisions and prior-loaded go through the access records too. A person removed from a channel neither sees, approves nor rejects
// its lessons.
import { describe, expect, it } from "vitest";
import { approveLesson, listQueued, listWaiting, rejectLesson, type ApproveDeps } from "../../../packages/broker/src/lessons/approve.js";
import { loadLessonsForStage, type LoadDeps } from "../../../packages/broker/src/lessons/load.js";
import { lessonDeletionPort } from "../../../packages/broker/src/lessons/deletion.js";
import { InMemoryLessonStore } from "../../../packages/broker/src/lessons/store.js";
import { createAccessCheckPort } from "../../../packages/broker/src/team-record/access-port.js";
import { applyAudienceEvent, applyMemberEvents } from "../../../packages/broker/src/team-record/access.js";
import { ORG_A, addSource, githubDraft, world } from "../../support/team-record-core.js";
import { Audit, Clock, MemoryVectors, PROJECT, directory, embedder, lessonRecord, seed, settings } from "./lesson-helpers.js";

const WS = ORG_A;
const KEY = { workspaceId: WS, project: PROJECT };
const SC = "slack:T1/C9";
const T1 = "2026-10-30T09:00:00.000Z";
const T2 = "2026-10-30T10:00:00.000Z";
const slackAcl = (principals: string[]) => ({ kind: "restricted" as const, acl: { source: "slack" as const, scope: SC, principals, capturedAt: T1, liveCheck: "none" as const } });
const member = { principals: ["U-member"], groups: [] };

async function setup() {
  const w = world();
  await addSource(w, { source: "slack", scope: SC });
  await w.sink.put(githubDraft({ source: "slack", kind: "slack.message", repo: undefined, sourceRef: { system: "T1", id: "m1", version: "1" }, audience: slackAcl(["U-member", "U-other"]), actor: { sourceId: "U-other", trust: "member" }, text: "x", links: [] }));
  const access = createAccessCheckPort(w.table);
  const store = new InMemoryLessonStore();
  const base = lessonRecord({ workspaceId: WS });
  const prov = { ...base.provenance, audience: slackAcl(["U-member", "U-other"]), sourceScopes: [SC], authors: ["carl"] };
  await seed(store, { ...base, id: "les_pend0001", status: "pending", approvals: [], tier: 1, tierReasons: ["not_a_fact"], type: "convention", provenance: prov, pendingExpiresAt: 1_900_000_000_000 } as never);
  await seed(store, { ...base, id: "les_cand0001", status: "candidate", approvals: [], tier: 1, tierReasons: ["not_a_fact"], type: "convention", provenance: prov } as never);
  await seed(store, { ...base, id: "les_pubm0001", status: "pending", approvals: [], tier: 1, tierReasons: ["not_a_fact"], type: "convention", provenance: { ...prov, audience: { kind: "project" } }, pendingExpiresAt: 1_900_000_000_000 } as never);
  const dir = directory({ eligibleIds: ["ann", "bob", "owner"], ownerIds: ["owner"] });
  dir.identity = async (_ws, person) => (person === "ann" ? { principals: ["U-member"], groups: [] } : { principals: ["U-stranger"], groups: [] });
  const clock = new Clock();
  const deps: ApproveDeps = { access, store, directory: dir, settings: settings(), audit: new Audit(), now: clock.now };
  return { w, store, deps, access };
}

describe("R9-1 the approval queues and decisions read the access records", () => {
  it("a person removed from the channel no longer sees its lessons in the waiting and queued lists", async () => {
    const { w, store, access } = await setup();
    expect((await listWaiting(store, KEY, member, access)).map((l) => l.id).sort()).toEqual(["les_pend0001", "les_pubm0001"]);
    expect((await listQueued(store, KEY, member, access)).map((l) => l.id)).toEqual(["les_cand0001"]);
    await applyMemberEvents(w.table, ORG_A, { scope: SC, remove: ["U-member"], at: T2 });
    expect((await listWaiting(store, KEY, member, access)).map((l) => l.id)).toEqual([]); // the project lesson came from the channel too
    expect(await listQueued(store, KEY, member, access)).toEqual([]);
  });

  it("they can no longer approve or reject its lessons", async () => {
    const { w, deps } = await setup();
    await applyMemberEvents(w.table, ORG_A, { scope: SC, remove: ["U-member"], at: T2 });
    expect(await approveLesson(deps, { ...KEY, lessonId: "les_pend0001", approverId: "ann" })).toEqual({ ok: false, code: "not_permitted" });
    expect(await rejectLesson(deps, { ...KEY, lessonId: "les_pend0001", approverId: "ann", reason: "x" })).toEqual({ ok: false, code: "not_permitted" });
    expect((await deps.store.get(KEY, "les_pend0001"))).toMatchObject({ status: "pending", version: 1 });
  });

  it("a member still can; and a place that turned private hides a project lesson from a non-member", async () => {
    const { w, deps, store, access } = await setup();
    expect(await approveLesson(deps, { ...KEY, lessonId: "les_pend0001", approverId: "ann" })).toMatchObject({ ok: true });
    await applyAudienceEvent(w.table, ORG_A, { scope: "slack:T1/CPUB", audience: slackAcl([]).kind === "restricted" ? { kind: "restricted", acl: { source: "slack", scope: "slack:T1/CPUB", principals: ["U-someone"], capturedAt: T1, liveCheck: "none" } } : { kind: "project" }, at: T1 });
    await seed(store, { ...lessonRecord({ workspaceId: WS }), id: "les_turn0001", status: "pending", approvals: [], tier: 1, tierReasons: ["not_a_fact"], type: "convention", provenance: { ...lessonRecord().provenance, audience: { kind: "project" }, sourceScopes: ["slack:T1/CPUB"] }, pendingExpiresAt: 1_900_000_000_000 } as never);
    expect((await listWaiting(store, KEY, { principals: ["U-stranger"], groups: [] }, access)).map((l) => l.id)).not.toContain("les_turn0001");
    expect((await listWaiting(store, KEY, { principals: ["U-someone"], groups: [] }, access)).map((l) => l.id)).toContain("les_turn0001");
  });

  it("without the port nothing is listed and nobody decides (fail closed, with a log line)", async () => {
    const { deps, store } = await setup();
    const lines: string[] = [];
    expect(await listWaiting(store, KEY, member, undefined as never, (event) => { lines.push(event); })).toEqual([]);
    expect(await approveLesson({ ...deps, access: undefined as never }, { ...KEY, lessonId: "les_pend0001", approverId: "ann" })).toEqual({ ok: false, code: "not_permitted" });
    expect(lines).toContain("learning.approve_no_access_port");
  });
});

describe("R9-9 prior-loaded titles go through the same check", () => {
  it("a lesson whose source place turned private since is not listed for a shared task at REVIEW", async () => {
    const { w, store, access } = await setup();
    const PUB = "slack:T1/COPEN";
    await addSource(w, { source: "slack", scope: PUB, audienceDefault: "project" });
    await w.sink.put(githubDraft({ source: "slack", kind: "slack.message", repo: undefined, sourceRef: { system: "T1", id: "o1", version: "1" }, audience: { kind: "project" }, scope: PUB, actor: { sourceId: "U-other", trust: "member" }, text: "open", links: [] }));
    const vectors = new MemoryVectors();
    const clock = new Clock();
    const deps: LoadDeps = { access, store, embedder, vectors, settings: settings(), audit: new Audit(), now: clock.now };
    // a project lesson from the channel, loaded earlier in the task (a manifest), while the channel was open to everyone
    await seed(store, { ...lessonRecord({ workspaceId: WS }), id: "les_prior001", status: "active", type: "convention", tier: 1, provenance: { ...lessonRecord().provenance, audience: { kind: "project" }, sourceScopes: [PUB] } } as never);
    await store.putManifest({ taskId: "t1", workspaceId: WS, project: PROJECT, stage: "IMPLEMENT", round: 1, setVersion: 1, memory: "live", at: 1, lessons: [{ id: "les_prior001", version: 1, score: 0.5, why: "scope", citation: "valid" }], bytes: 100 });
    const request = { workspaceId: WS, project: PROJECT, taskId: "t1", stage: "REVIEW" as const, round: 1, intent: "x", repos: ["api"], files: [], languages: [], taskAudience: { kind: "shared" as const } };
    const before = await loadLessonsForStage(deps, request);
    expect(before.context?.priorLoaded?.map((p) => p.id) ?? []).toEqual(["les_prior001"]);
    await applyAudienceEvent(w.table, ORG_A, { scope: PUB, audience: { kind: "restricted", acl: { source: "slack", scope: PUB, principals: ["U-other"], capturedAt: T2, liveCheck: "none" } }, at: T2 });
    const after = await loadLessonsForStage(deps, { ...request, round: 2 });
    expect(after.context?.priorLoaded ?? []).toEqual([]);
  });
});

describe("R9-3 the learning lane's erase strips an erased id from every version's audience snapshot", () => {
  it("scrubAudienceIds leaves the id in no version of any lesson", async () => {
    const store = new InMemoryLessonStore();
    const base = lessonRecord({ workspaceId: WS });
    const prov = { ...base.provenance, audience: slackAcl(["U-erase-me-7", "U-other"]) };
    await seed(store, { ...base, id: "les_aud00001", provenance: prov });
    await store.scrub(KEY, "les_aud00001", (l) => l); // a stored head and versions exist
    const port = lessonDeletionPort({ store, vectors: new MemoryVectors(), audit: new Audit(), now: new Clock().now });
    await port.scrubAudienceIds(WS, PROJECT, ["U-erase-me-7"]);
    const all = [(await store.getHead(KEY, "les_aud00001"))!, ...(await store.versions(KEY, "les_aud00001"))];
    expect(JSON.stringify(all)).not.toContain("U-erase-me-7");
    expect(JSON.stringify(all)).toContain("U-other");
  });
});

describe("old place-scoped tracker lessons are limited to their frozen snapshot, never loaded for nobody silently", () => {
  it("a Jira lesson recorded against the place is loaded for a person its snapshot allows, and logged", async () => {
    const { w, store } = await setup();
    const lines: string[] = [];
    const access = createAccessCheckPort(w.table, { log: (event) => { lines.push(event); } });
    const clock = new Clock();
    const vectors = new MemoryVectors();
    const deps: LoadDeps = { access, store, embedder, vectors, settings: settings(), audit: new Audit(), now: clock.now };
    const base = lessonRecord({ workspaceId: WS });
    const legacy = { kind: "restricted" as const, acl: { source: "jira" as never, scope: "jira:project/KEY", principals: ["J-member"], capturedAt: T1, liveCheck: "none" as const } };
    await seed(store, { ...base, id: "les_jira0001", type: "convention", tier: 1, provenance: { ...base.provenance, audience: legacy } } as never);
    await vectors.upsert(WS, PROJECT, "les_jira0001", await embedder.embed("x"), { status: "active" });
    const request = (principals: string[]) => ({ workspaceId: WS, project: PROJECT, taskId: "t1", stage: "IMPLEMENT" as const, round: 1, intent: "Retry failed HTTP calls", repos: ["api"], files: ["src/retry/client.ts"], languages: [], taskAudience: { kind: "private" as const, identity: { principals, groups: [] } } });
    expect(((await loadLessonsForStage(deps, request(["J-member"]))).context?.lessons ?? []).map((l) => l.id)).toContain("les_jira0001");
    expect(((await loadLessonsForStage(deps, request(["J-stranger"]))).context?.lessons ?? []).map((l) => l.id)).not.toContain("les_jira0001");
    expect(lines).toContain("learning.legacy_place_scoped_lesson");
  });
});
