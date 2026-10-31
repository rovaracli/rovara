// Wiring lane A (privacy and erasure), LR-L1: ONE source-key normaliser (so erasing `mallory` also forgets `member:Mallory`), raw id compares on approvals and groups,
// the cool-off for a team-of-one author's own restored approval, and sweepExpired reaching a lesson that names an erased person.
import { describe, expect, it } from "vitest";
import { approveLesson, rollbackLessonSet, type ApproveDeps } from "../../../packages/broker/src/lessons/approve.js";
import { lessonDeletionPort } from "../../../packages/broker/src/lessons/deletion.js";
import { buildWeeklyDigest } from "../../../packages/broker/src/lessons/digest.js";
import { sweepExpired } from "../../../packages/broker/src/lessons/expiry.js";
import { loadLessonsForStage, type LoadDeps, type LoadRequest } from "../../../packages/broker/src/lessons/load.js";
import { attributableSources, isHeldBySource, noteCandidateSources } from "../../../packages/broker/src/lessons/sources.js";
import { InMemoryLessonStore } from "../../../packages/broker/src/lessons/store.js";
import { memberOfSource, normId, normSource, sameSource } from "../../../packages/broker/src/lessons/types.js";
import { Alerts, Audit, Clock, KEY, MemoryVectors, PROJECT, WS, allowAllAccess, directory, draft, embedder, lessonRecord, seed, settings } from "./lesson-helpers.js";

const DAY = 86_400_000;

describe("LR-L1 one source-key normaliser", () => {
  it("ids compare in NFC (an accented name typed two ways is one person), and canonical developer ids (64 lowercase hex) are untouched by case folding", () => {
    expect(normId("Jos\u00e9")).toBe(normId("Jose\u0301"));
    expect(sameSource("member:Jos\u00e9", "member:Jose\u0301")).toBe(true);
    const hex = "ab".repeat(32);
    expect(normId(hex)).toBe(hex);
  });
  it("member keys ignore case, spaces and the prefix's case; other keys are only trimmed", () => {
    expect(normSource("member:Mallory")).toBe("member:mallory");
    expect(normSource(" Member: MALLORY ")).toBe("member:mallory");
    expect(memberOfSource("MEMBER:Ann")).toBe("ann");
    expect(memberOfSource("slack:C1")).toBeUndefined();
    expect(normSource(" slack:C1 ")).toBe("slack:C1");
    expect(sameSource("member:Ann", "member:ann")).toBe(true);
    expect(sameSource("slack:C1", "slack:c1")).toBe(false);
  });

  it("forgetSource removes the events and the pause under every spelling", async () => {
    const store = new InMemoryLessonStore();
    for (const source of ["member:Mallory", "member:mallory", "member: MALLORY", "member:ann"]) await store.recordSourceEvent(KEY, { at: 1_800_000_000_000, source });
    await store.setFlags(KEY, { pausedSources: { "member:Mallory": { at: 1, reason: "spike" }, "member:ann": { at: 1, reason: "spike" } } });
    await store.forgetSource(KEY, "member:mallory");
    expect(await store.sourceDays(KEY, "member:Mallory", 1, 1_800_000_000_000)).toEqual([0]);
    expect(await store.sourceDays(KEY, "member:mallory", 1, 1_800_000_000_000)).toEqual([0]);
    expect(await store.sourceDays(KEY, "member:ann", 1, 1_800_000_000_000)).toEqual([1]);
    expect(Object.keys((await store.flags(KEY)).pausedSources ?? {})).toEqual(["member:ann"]);
    // and the reverse spelling
    await store.setFlags(KEY, { pausedSources: { "member:mallory": { at: 1, reason: "spike" } } });
    await store.forgetSource(KEY, "member:Mallory");
    expect((await store.flags(KEY)).pausedSources).toEqual({});
  });

  it("erasing 'mallory' leaves no 'member:Mallory' event or pause, and the digest cannot print one", async () => {
    const store = new InMemoryLessonStore();
    const clock = new Clock();
    await store.recordSourceEvent(KEY, { at: clock.now(), source: "member:Mallory" });
    await store.setFlags(KEY, { pausedSources: { "member:Mallory": { at: clock.now(), reason: "spike" } } });
    const digestBefore = await buildWeeklyDigest(store, KEY, clock.now() - 7 * DAY, { principals: [], groups: [] }, allowAllAccess);
    expect(digestBefore.pausedSources.join().toLowerCase()).toContain("mallory"); // control: the digest does print a paused member source
    const port = lessonDeletionPort({ store, vectors: new MemoryVectors(), audit: new Audit(), now: clock.now });
    await port.erasePerson(WS, PROJECT, { developerId: "mallory" }, new Set());
    expect(await store.sourceDays(KEY, "member:Mallory", 1, clock.now())).toEqual([0]);
    const digest = await buildWeeklyDigest(store, KEY, clock.now() - 7 * DAY, { principals: [], groups: [] }, allowAllAccess);
    expect(JSON.stringify(digest).toLowerCase()).not.toContain("mallory");
  });

  it("counting and pausing use the canonical key: 'member:Ann' and 'member:ann' are one source, and a late event of an erased person under any spelling records nothing", async () => {
    const store = new InMemoryLessonStore();
    const clock = new Clock();
    const deps = { now: clock.now, audit: new Audit() };
    for (let i = 0; i < 5; i += 1) await noteCandidateSources(deps, store, KEY, ["member:Ann"], new Alerts());
    for (let i = 0; i < 5; i += 1) await noteCandidateSources(deps, store, KEY, ["member:ann"], new Alerts());
    expect(await store.sourceDays(KEY, "member:ann", 1, clock.now())).toEqual([10]);
    await store.fence(KEY, { people: ["Mallory"] });
    await noteCandidateSources(deps, store, KEY, ["Member:MALLORY", "member:mallory"], new Alerts());
    expect(await store.sourceDays(KEY, "member:mallory", 1, clock.now())).toEqual([0]);
  });

  it("a hold on 'member:Ann' holds a lesson whose source is 'member:ann', and attributable sources leave members out in any spelling", () => {
    expect(isHeldBySource({ pausedSources: { "member:Ann": { at: 1, reason: "spike" } } }, ["member:ann"])).toBe(true);
    expect(isHeldBySource({ pausedSources: { "slack:C1": { at: 1, reason: "spike" } } }, ["member:ann"])).toBe(false);
    expect(attributableSources({ sources: [], inputSources: ["Member:Ann", "slack:C1"] })).toEqual(["slack:C1"]);
  });
});

describe("LR-L1 raw id compares", () => {
  function setup(dir: ReturnType<typeof directory>, s = settings()) {
    const store = new InMemoryLessonStore();
    const clock = new Clock();
    const deps: ApproveDeps = { access: allowAllAccess, store, directory: dir, settings: s, audit: new Audit(), now: clock.now };
    return { store, deps, clock };
  }
  const tier2 = () => lessonRecord({ id: "les_pend0001", status: "pending", tier: 2, tierReasons: ["escalation_words"], approvals: [], type: "convention", pendingExpiresAt: 9e15, provenance: { ...lessonRecord().provenance, authors: ["carl"] } });

  it("a required group lists 'Bob' and 'bob' approves: the group is represented", async () => {
    const { deps, store } = setup(directory({ groups: { "security-leads": ["Bob"] } }), settings({ approval: { requiredGroup: "security-leads" } }));
    await seed(store, tier2());
    await approveLesson(deps, { ...KEY, lessonId: "les_pend0001", approverId: "ann" });
    expect(await approveLesson(deps, { ...KEY, lessonId: "les_pend0001", approverId: "bob" })).toMatchObject({ ok: true, status: "active" });
  });

  it("the reviewer-stage check counts 'Bob' and 'bob' as one person", async () => {
    const store = new InMemoryLessonStore();
    const vectors = new MemoryVectors();
    const deps: LoadDeps = { access: allowAllAccess, store, embedder, vectors, settings: settings(), audit: new Audit(), now: new Clock().now };
    const two = [{ approvalId: "a", by: "Bob", at: 1, mode: "one" as const }, { approvalId: "b", by: "bob", at: 2, mode: "second_person" as const }];
    const lessons = [lessonRecord({ id: "les_rsame001", type: "review_check", tier: 2, stages: ["REVIEW"], approvals: two }), lessonRecord({ id: "les_rtwo00001", type: "review_check", tier: 2, stages: ["REVIEW"], approvals: [two[0]!, { ...two[1]!, by: "carl" }] })];
    await seed(store, ...lessons);
    for (const l of lessons) await vectors.upsert(l.workspaceId, l.project, l.id, await embedder.embed(`${l.title}\n${l.description}\n${l.body}`), { status: l.status });
    const request: LoadRequest = { workspaceId: WS, project: PROJECT, taskId: "task-1", stage: "REVIEW", round: 1, intent: "Retry failed HTTP calls in the api service", repos: ["api"], files: ["src/retry/client.ts"], languages: [], taskAudience: { kind: "shared" } };
    const loaded = (await loadLessonsForStage(deps, request)).context?.lessons.map((l) => l.id) ?? [];
    expect(loaded).toEqual(["les_rtwo00001"]);
  });
});

describe("LR-L1 a team-of-one author's own restored approval needs the cool-off", () => {
  async function restore(over: { lossAgoMs: number | null; authors: string[]; by?: string }) {
    const store = new InMemoryLessonStore();
    const clock = new Clock();
    const v1 = lessonRecord({ id: "les_rb000001", tier: 1, tierReasons: ["not_a_fact"], type: "convention", approvals: [{ approvalId: "a0", by: over.by ?? "owner", at: 1, mode: "one" }], provenance: { ...draft().provenance, authors: over.authors } });
    await seed(store, v1);
    await seed(store, { ...v1, version: 2, citations: [{ ...v1.citations[0]!, startLine: 40, endLine: 50 } as never] });
    const dir = directory({ eligibleIds: ["owner"], ownerIds: ["owner"], lastEligibleLossAtMs: over.lossAgoMs === null ? null : clock.now() - over.lossAgoMs });
    const deps: ApproveDeps = { access: allowAllAccess, store, directory: dir, settings: settings(), audit: new Audit(), now: clock.now };
    await rollbackLessonSet(deps, { ...KEY, targetSetVersion: 1, actorId: "owner" });
    return (await store.get(KEY, "les_rb000001"))!;
  }
  it("the author's own approval in a team of one, with an eligible loss one hour ago, does not restore active", async () => {
    expect((await restore({ lossAgoMs: 3_600_000, authors: ["owner"] })).status).toBe("pending");
  });
  it("the same approval after the cool-off, or with no loss, restores active (controls)", async () => {
    expect((await restore({ lossAgoMs: 2 * DAY, authors: ["owner"] })).status).toBe("active");
    expect((await restore({ lossAgoMs: null, authors: ["Owner"] })).status).toBe("active");
  });
  it("a non-author's approval in the same team needs no cool-off (control)", async () => {
    expect((await restore({ lossAgoMs: 3_600_000, authors: ["carl"] })).status).toBe("active");
  });
});

describe("LR-L1 sweepExpired and a lesson that names an erased person", () => {
  it("an expired lesson by an erased person is moved to expired, and what is written no longer names them", async () => {
    const store = new InMemoryLessonStore();
    const clock = new Clock();
    await seed(store, lessonRecord({ id: "les_old00001", status: "active", expiresAt: clock.now() - 1, approvals: [{ approvalId: "a", by: "ann", at: 1, mode: "one" }], provenance: { ...draft().provenance, authors: ["Mallory"], sources: ["member:Mallory"], inputSources: [] } }));
    await store.fence(KEY, { people: ["mallory"] });
    const out = await sweepExpired({ now: clock.now, audit: new Audit() }, store, KEY);
    expect(out.expired).toEqual(["les_old00001"]);
    const head = (await store.getHead(KEY, "les_old00001"))!;
    expect(head.status).toBe("expired");
    expect(JSON.stringify(head).toLowerCase()).not.toContain("mallory");
  });
  it("a pending lesson nobody decided in time is expired the same way", async () => {
    const store = new InMemoryLessonStore();
    const clock = new Clock();
    await seed(store, lessonRecord({ id: "les_pen00001", status: "pending", pendingExpiresAt: clock.now() - 1, approvals: [], provenance: { ...draft().provenance, authors: ["mallory"] } }));
    await store.fence(KEY, { people: ["mallory"] });
    expect((await sweepExpired({ now: clock.now, audit: new Audit() }, store, KEY)).expired).toEqual(["les_pen00001"]);
  });
});
