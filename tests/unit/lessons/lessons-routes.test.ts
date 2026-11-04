// L3b: the Lessons tab, Sources tab and task-page lessons routes. Authority is the point: who may see a lesson, who may decide it, the two-person rule, the Auditor, a stale
// version, a lesson from a source the viewer cannot see, and text that never reaches a viewer.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AgentXError, LESSON_TIER_REASONS, LESSON_VIEW_STATUSES, LessonsViewReaderSchema, type OrgId } from "@agentx/contracts";
import { LESSON_STATUSES } from "../../../packages/broker/src/lessons/types.js";
import { routeLessons, type LessonRouteDependencies } from "../../../packages/broker/src/lessons/routes.js";
import { InMemoryLessonStore } from "../../../packages/broker/src/lessons/store.js";
import type { AccessCheckPort } from "../../../packages/broker/src/team-record/access-port.js";
import type { DeveloperCaller } from "../../../packages/broker/src/aws/developer-routes.js";
import type { LessonRouteDependencies as _Deps } from "../../../packages/broker/src/lessons/routes.js";
import { Alerts, Audit, Clock, KEY, MemoryVectors, PROJECT, ScriptedModel, Spend, WS, allowAllAccess, directory, draft, embedder, facts, Judge, lessonRecord, seed, settings, verifier } from "./lesson-helpers.js";
import { addSource, world } from "../../support/team-record-core.js";
import { webRouteAllowed } from "../../../packages/broker/src/aws/web-auth.js";

void (undefined as unknown as _Deps);
const NAMES: Record<string, string> = { ann: "Ann Archer", bob: "Bob Baker", owner: "Olga Owner", carl: "Carl Cole", mallory: "Mallory Mole" };
const names = { memberName: async (_org: OrgId, id: string) => NAMES[id], isErased: async (_org: OrgId, id: string) => id === "erased-1" };

const callerOf = (developerId: string, over: { [K in keyof DeveloperCaller]?: DeveloperCaller[K] | undefined } = {}): DeveloperCaller => ({ developerId, sessionId: "s", amr: "browser", name: developerId, orgId: WS as OrgId, orgRole: "member", browserSession: true, ...over }) as unknown as DeveloperCaller;
const url = (path: string) => new URL("https://rovara.test" + path);
const base = `/v1/app/projects/${PROJECT}/lessons`;

const pending = (over: Parameters<typeof lessonRecord>[0] = {}) => lessonRecord({
  id: "les_pend0001", status: "pending", tier: 1, tierReasons: ["scope_not_one_repo"], approvals: [], type: "convention", title: "Use the shared retry helper", body: "Call withRetry for HTTP calls in api.",
  pendingExpiresAt: 9e15, provenance: { ...lessonRecord().provenance, authors: ["carl"] }, ...over,
});

function setup(over: { eligible?: string[]; access?: AccessCheckPort; value?: Parameters<typeof settings>[0]; withTable?: boolean } = {}) {
  const store = new InMemoryLessonStore();
  const audit = new Audit();
  const clock = new Clock();
  const w = world();
  let n = 0;
  const dir = directory({ eligibleIds: over.eligible ?? ["owner", "ann", "bob"] });
  const lessons = {
    store, directory: dir, settings: settings(over.value ?? {}), access: over.access ?? allowAllAccess, audit, now: clock.now, newId: () => `ap-${++n}`, names,
    ...(over.withTable === false ? {} : { sources: { table: w.table } }),
    embedder, vectors: new MemoryVectors(), judgeModel: new ScriptedModel(), spend: new Spend(), alerts: new Alerts(), verifier: verifier("valid"), facts: facts(), judge: new Judge(),
  };
  const taken = new Map<string, number>();
  const rate = { fail: false, async take(who: DeveloperCaller, bucket: string, limit: number) { if (this.fail) throw new Error("rate down"); const key = `${bucket}|${who.developerId}`; const n = (taken.get(key) ?? 0) + 1; taken.set(key, n); return n <= limit; } };
  const deps = { lessons, rate: (who: DeveloperCaller, bucket: string, limit: number) => rate.take(who, bucket, limit), projectFor: async (_who: unknown, raw: string) => ({ name: decodeURIComponent(raw), role: "maintainer" as const }), taskFor: async () => ({ project: PROJECT }) } as unknown as LessonRouteDependencies;
  const call = (caller: DeveloperCaller, method: string, path: string, body: unknown = {}) => routeLessons(deps, caller, method, url(path), () => body);
  return { store, audit, clock, deps, call, w, dir, rate, taken };
}
const refused = async (promise: Promise<unknown>): Promise<AgentXError> => { try { await promise; } catch (error) { if (error instanceof AgentXError) return error; throw error; } throw new Error("expected a refusal"); };

describe("the Lessons tab read", () => {
  it("shows a maintainer what waits, with who approved first and how many people are needed, and shows the active list with counts and expiry", async () => {
    const { store, call } = setup();
    await seed(store, pending({ id: "les_tier2001", tier: 2, tierReasons: ["reviewer_stage"], stages: ["REVIEW"], type: "review_check", approvals: [{ approvalId: "a1", by: "ann", at: 5, mode: "one" }] }), pending(), lessonRecord({ id: "les_act00001", counters: { loaded: 4, helpful: 3, harmful: 1, citationStale: 0 } }));
    const view = LessonsViewReaderSchema.parse(await call(callerOf("bob"), "GET", base));
    expect(view).toMatchObject({ canDecide: true, mode: "On", approval: { tier0: "one", tier1: "one" } });
    const two = view.waiting.find((l) => l.id === "les_tier2001")!;
    expect(two.needs).toMatchObject({ required: 2, have: 1, first: { name: "Ann Archer" } });
    expect(two.canApprove).toBe(true);
    const one = view.waiting.find((l) => l.id === "les_pend0001")!;
    expect(one.needs).toMatchObject({ required: 1, have: 0 });
    expect(view.active[0]).toMatchObject({ id: "les_act00001", counters: { loaded: 4, helpful: 3, harmful: 1 } });
    expect(view.active[0]!.expiresAt).toBeGreaterThan(0);
    expect(view.active[0]!.citations[0]).toMatchObject({ kind: "code", check: "valid" });
  });

  it("a person who is not a maintainer or admin reads the active lessons only: no queue, no approvers, no counts of hidden things, no buttons", async () => {
    const { store, call } = setup();
    await seed(store, pending(), lessonRecord({ id: "les_act00001" }), lessonRecord({ id: "les_ret00001", status: "retired" }));
    const view = LessonsViewReaderSchema.parse(await call(callerOf("mallory"), "GET", base));
    expect(view).toMatchObject({ canDecide: false, waiting: [], removed: [], queued: 0, hidden: 0, snapshots: [] });
    expect(view.active.map((l) => l.id)).toEqual(["les_act00001"]);
    expect(view.active.every((l) => !l.canApprove && !l.canReject && !l.canRetire)).toBe(true);
  });

  it("an incomplete or failing approver directory decides nobody", async () => {
    const { store, call, dir } = setup();
    await seed(store, pending());
    dir.value.complete = false;
    expect(LessonsViewReaderSchema.parse(await call(callerOf("ann"), "GET", base))).toMatchObject({ canDecide: false, waiting: [] });
  });

  it("a lesson from a source the viewer cannot see is not listed and its words are nowhere in the answer; a maintainer only gets a count", async () => {
    const secret = "Quarterly layoff planning is in the finance channel";
    const restricted = lessonRecord({ id: "les_rest0001", title: secret, status: "active", provenance: { ...lessonRecord().provenance, audience: { kind: "restricted", acl: { source: "slack", scope: "slack:T1/CPRIV", principals: ["U9"], capturedAt: "2026-10-30T00:00:00.000Z", liveCheck: "none" } } } });
    const denyAll: AccessCheckPort = { mayRead: async (_o, _v, places) => places.map(() => false) };
    const { store, call } = setup({ access: denyAll });
    await seed(store, restricted, lessonRecord({ id: "les_open0001" }));
    const answer = await call(callerOf("ann"), "GET", base);
    expect(JSON.stringify(answer)).not.toContain("layoff");
    expect(LessonsViewReaderSchema.parse(answer)).toMatchObject({ hidden: 1, active: [{ id: "les_open0001" }] });
    expect(JSON.stringify(await call(callerOf("mallory"), "GET", base))).not.toContain("layoff");
  });

  it("names an erased person, or one who cannot be read, as a former member and never shows an id", async () => {
    const { store, call } = setup();
    await seed(store, pending({ provenance: { ...lessonRecord().provenance, authors: ["erased-1", "unknown-9"] } }));
    const view = LessonsViewReaderSchema.parse(await call(callerOf("bob"), "GET", base));
    expect(view.waiting[0]!.from.map((p) => p.name)).toEqual(["a former member"]);
    expect(JSON.stringify(view)).not.toMatch(/erased-1|unknown-9/u);
  });

  it("shows a lock from the company as the reason the mode is stricter than the project's choice", async () => {
    const { call } = setup({ value: { mode: "On", companyLock: "Suggest" } });
    expect(LessonsViewReaderSchema.parse(await call(callerOf("ann"), "GET", base))).toMatchObject({ mode: "Suggest", lockedByCompany: true });
    const own = setup({ value: { mode: "Suggest", companyLock: "On" } });
    expect(LessonsViewReaderSchema.parse(await own.call(callerOf("ann"), "GET", base))).toMatchObject({ mode: "Suggest", lockedByCompany: false });
  });

  it("answers undefined for a path it does not own", async () => {
    const { call } = setup();
    expect(await call(callerOf("ann"), "GET", "/v1/app/projects/p/learning")).toBeUndefined();
    expect(await call(callerOf("ann"), "DELETE", base)).toBeUndefined();
  });
});

describe("approving", () => {
  const approve = (s: ReturnType<typeof setup>, who: string, id = "les_pend0001", version = 1, edit?: { title: string; description: string; body: string }) =>
    s.call(callerOf(who), "POST", `${base}/${id}/approve`, { expectedVersion: version, ...(edit === undefined ? {} : { edit }) });

  it("one tap from a maintainer makes a low-risk lesson live, and audits it", async () => {
    const s = setup();
    await seed(s.store, pending());
    expect(await approve(s, "ann")).toEqual({ status: "active", needs: "nothing" });
    expect((await s.store.get(KEY, "les_pend0001"))!.status).toBe("active");
    expect(s.audit.actions()).toEqual(expect.arrayContaining(["lesson.approved", "lesson.activated"]));
  });

  it("a reviewer, check or security lesson needs a second person: the first approval leaves it waiting, the same person cannot give the second, a different maintainer finishes it", async () => {
    const s = setup();
    await seed(s.store, pending({ tier: 2, tierReasons: ["escalation_words"] }));
    expect(await approve(s, "ann")).toEqual({ status: "pending", needs: "second_person" });
    expect((await refused(approve(s, "ann", "les_pend0001", 2))).code).toBe("CHANGE_STALE");
    expect((await s.store.get(KEY, "les_pend0001"))!.status).toBe("pending");
    expect(await approve(s, "bob", "les_pend0001", 2)).toEqual({ status: "active", needs: "nothing" });
    expect((await s.store.get(KEY, "les_pend0001"))!.approvals.map((a) => a.by)).toEqual(["ann", "bob"]);
  });

  it("the person who gave the first approval is shown no Approve button, and the others are", async () => {
    const s = setup();
    await seed(s.store, pending({ tier: 2, tierReasons: ["escalation_words"] }));
    await approve(s, "ann");
    const mine = LessonsViewReaderSchema.parse(await s.call(callerOf("ann"), "GET", base)).waiting[0]!;
    expect(mine).toMatchObject({ canApprove: false, canReject: true, needs: { required: 2, have: 1, first: { name: "Ann Archer", you: true } } });
    expect(LessonsViewReaderSchema.parse(await s.call(callerOf("bob"), "GET", base)).waiting[0]!).toMatchObject({ canApprove: true, needs: { first: { name: "Ann Archer" } } });
    expect(JSON.stringify(LessonsViewReaderSchema.parse(await s.call(callerOf("bob"), "GET", base)))).not.toMatch(/"you":true/u);
  });

  it("the pilot default needs one person even for a low-risk cited fact", async () => {
    const s = setup();
    await seed(s.store, lessonRecord({ id: "les_fact0001", status: "pending", tier: 0, tierReasons: ["cited_fact"], approvals: [], pendingExpiresAt: 9e15, provenance: { ...lessonRecord().provenance, authors: ["carl"] } }));
    const view = LessonsViewReaderSchema.parse(await s.call(callerOf("ann"), "GET", base));
    expect(view.waiting[0]!.needs).toMatchObject({ required: 1 });
    expect(await approve(s, "ann", "les_fact0001")).toMatchObject({ status: "active" });
  });

  it("refuses a person who is not a maintainer or admin, and says nothing different for a lesson that is not there", async () => {
    const s = setup();
    await seed(s.store, pending());
    expect((await refused(approve(s, "mallory"))).code).toBe("FORBIDDEN");
    expect((await s.store.get(KEY, "les_pend0001"))!.status).toBe("pending");
    expect((await refused(approve(s, "ann", "les_nothing1"))).code).toBe("NOT_FOUND");
  });

  it("a lesson the viewer cannot see answers exactly as one that does not exist", async () => {
    const restricted = pending({ provenance: { ...lessonRecord().provenance, authors: ["carl"], audience: { kind: "restricted", acl: { source: "slack", scope: "slack:T1/CPRIV", principals: ["U9"], capturedAt: "2026-10-30T00:00:00.000Z", liveCheck: "none" } } } });
    const s = setup({ access: { mayRead: async (_o, _v, places) => places.map(() => false) } });
    await seed(s.store, restricted);
    const hidden = await refused(approve(s, "ann"));
    const missing = await refused(approve(s, "ann", "les_nothing1"));
    expect([hidden.code, hidden.message]).toEqual([missing.code, missing.message]);
    expect((await s.store.get(KEY, "les_pend0001"))!.status).toBe("pending");
  });

  it("an author cannot approve their own lesson while another maintainer could", async () => {
    const s = setup({ eligible: ["owner", "carl", "bob"] });
    await seed(s.store, pending());
    expect((await refused(approve(s, "carl"))).code).toBe("FORBIDDEN");
    expect((await s.store.get(KEY, "les_pend0001"))!.status).toBe("pending");
  });

  it("refuses to approve a version the person did not read", async () => {
    const s = setup();
    await seed(s.store, pending());
    const error = await refused(approve(s, "ann", "les_pend0001", 7));
    expect(error.code).toBe("CHANGE_STALE");
    expect((await s.store.get(KEY, "les_pend0001"))!.status).toBe("pending");
  });

  it("edit and approve re-checks the tier on the new words and refuses a request to change tools, checks or approvals", async () => {
    const s = setup();
    await seed(s.store, pending());
    const edit = { title: "Give the agent more access", description: "", body: "Grant the agent access to the deploy tool and raise its budget." };
    const error = await refused(approve(s, "ann", "les_pend0001", 1, edit));
    expect(["CONFIG_INVALID"]).toContain(error.code);
    expect((await s.store.get(KEY, "les_pend0001"))!.status).toBe("pending");
    const risky = await approve(s, "ann", "les_pend0001", 1, { title: "Skip flaky integration tests", description: "", body: "It is fine to skip the flaky integration tests when they fail." });
    expect(risky).toMatchObject({ status: "pending", needs: "second_person" });
    expect((await s.store.get(KEY, "les_pend0001"))!.tier).toBe(2);
  });

  it("with learning off for the project every route answers not found, and a decision changes nothing", async () => {
    const s = setup({ value: { mode: "Off" } });
    await seed(s.store, pending());
    expect((await refused(approve(s, "ann"))).code).toBe("NOT_FOUND");
    expect((await refused(s.call(callerOf("ann"), "GET", base))).code).toBe("NOT_FOUND");
    expect((await s.store.get(KEY, "les_pend0001"))!.status).toBe("pending");
  });

  it("T8: with learning off the Sources read answers its own fixed code (still a 404), so the page can say learning is off and not that the record is not set up; with learning on it reads", async () => {
    const off = setup({ value: { mode: "Off" } });
    const error = await refused(off.call(callerOf("ann"), "GET", `${base}/sources`));
    expect(error.code).toBe("LEARNING_OFF");
    expect(error.statusCode).toBe(404);
    expect(error.message).toBe("LEARNING_OFF: Learning is off for this project.");
    // A member (no maintainer role in the call) is told the same; the other lessons routes keep answering not found.
    expect((await refused(off.call(callerOf("bob"), "GET", `${base}/sources`))).code).toBe("LEARNING_OFF");
    expect((await refused(off.call(callerOf("ann"), "GET", `${base}/digest`))).code).toBe("NOT_FOUND");
    const on = setup();
    expect(await on.call(callerOf("ann"), "GET", `${base}/sources`)).toMatchObject({ sources: expect.any(Array) as unknown });
  });

  it("T8 round 1: the Sources read says why learning is off, each in a fixed code: the project's own Off, the company's lock, a setting that cannot be read", async () => {
    const codeOf = async (value: Parameters<typeof settings>[0]) => { const s = setup({ value }); const error = await refused(s.call(callerOf("ann"), "GET", `${base}/sources`)); return [error.code, error.statusCode, error.message] as const; };
    expect(await codeOf({ mode: "Off" })).toEqual(["LEARNING_OFF", 404, "LEARNING_OFF: Learning is off for this project."]);
    // The company's lock forces Off while the project's own choice is on.
    expect(await codeOf({ mode: "On", companyLock: "Off" })).toEqual(["LEARNING_LOCKED", 404, "LEARNING_LOCKED: Learning is off for this project because of a company setting."]);
    expect((await codeOf({ companyLock: "Off" }))[0]).toBe("LEARNING_LOCKED"); // the project's own choice is the default
    // A setting that does not parse (a mode, a lock, an expiry) is not "off": the person is asked to retry.
    expect((await codeOf({ mode: "Sometimes" as never }))[0]).toBe("RUNTIME_UNAVAILABLE");
    expect((await codeOf({ companyLock: "Sometimes" as never }))[0]).toBe("RUNTIME_UNAVAILABLE");
    expect(await codeOf({ expiryDays: 0 })).toEqual(["RUNTIME_UNAVAILABLE", 503, "RUNTIME_UNAVAILABLE: The learning setting for this project could not be read."]);
    // A reader that throws gives the same.
    const broken = setup();
    broken.deps.lessons.settings = { read: async () => { throw new Error("dynamodb down: secret detail"); } };
    const error = await refused(routeLessons(broken.deps, callerOf("ann"), "GET", url(`${base}/sources`), () => ({})));
    expect([error.code, error.statusCode]).toEqual(["RUNTIME_UNAVAILABLE", 503]);
    expect(error.message).not.toContain("secret detail");
    // The other routes keep answering plain not found whatever the reason.
    const locked = setup({ value: { mode: "On", companyLock: "Off" } });
    expect((await refused(locked.call(callerOf("ann"), "GET", base))).code).toBe("NOT_FOUND");
    // Positive controls: learning on reads.
    expect(await setup({ value: { mode: "On", companyLock: "Collect" } }).call(callerOf("ann"), "GET", `${base}/sources`)).toMatchObject({ sources: expect.any(Array) as unknown });
  });

  it("a write needs a live browser session and a writer role: a token and the Auditor are refused and nothing changes", async () => {
    const s = setup();
    await seed(s.store, pending());
    const body = { expectedVersion: 1 };
    expect((await refused(s.call(callerOf("ann", { browserSession: undefined }), "POST", `${base}/les_pend0001/approve`, body))).code).toBe("FORBIDDEN");
    expect((await refused(s.call(callerOf("ann", { orgRole: "auditor" as never }), "POST", `${base}/les_pend0001/approve`, body))).code).toBe("FORBIDDEN");
    expect((await refused(s.call(callerOf("ann", { orgRole: "auditor" as never }), "POST", `${base}/les_pend0001/retire`, {}))).code).toBe("FORBIDDEN");
    expect((await refused(s.call(callerOf("ann", { orgRole: "auditor" as never }), "POST", `${base}/rollback`, { targetSetVersion: 0, expectedSetVersion: 1 }))).code).toBe("FORBIDDEN");
    expect((await s.store.get(KEY, "les_pend0001"))!.status).toBe("pending");
  });

  it("rejects a body with a field it does not take", async () => {
    const s = setup();
    await seed(s.store, pending());
    expect((await refused(s.call(callerOf("ann"), "POST", `${base}/les_pend0001/approve`, { expectedVersion: 1, tier: 0 }))).code).toBe("CONFIG_INVALID");
  });
});

describe("rate limits", () => {
  it("every write takes from the person's own row first: decisions, edits, rollbacks and marks, each with its limit", async () => {
    const s = setup();
    await seed(s.store, pending());
    await s.call(callerOf("ann"), "POST", `${base}/les_pend0001/approve`, { expectedVersion: 1, edit: { title: "A title", description: "", body: "Use the helper in api." } }).catch(() => undefined);
    await s.call(callerOf("ann"), "POST", `${base}/les_pend0001/reject`, { expectedVersion: 1, reason: "x" }).catch(() => undefined);
    await s.call(callerOf("ann"), "POST", `${base}/les_pend0001/retire`, {}).catch(() => undefined);
    await s.call(callerOf("ann"), "POST", `${base}/rollback`, { targetSetVersion: 0, expectedSetVersion: 0 }).catch(() => undefined);
    await s.call(callerOf("ann"), "POST", "/v1/app/tasks/11111111-1111-4111-8111-111111111111/lessons/les_pend0001/feedback", { kind: "helpful" }).catch(() => undefined);
    expect(Object.fromEntries(s.taken)).toEqual({ "LESSON_DECISIONS|ann": 3, "LESSON_EDITS|ann": 1, "LESSON_ROLLBACKS|ann": 1, "LESSON_MARKS|ann": 1 });
  });
  it("marks: past the limit the request is refused with 429 and nothing is recorded", async () => {
    const s = setup();
    await seed(s.store, lessonRecord({ id: "les_load0001" }));
    const task = "/v1/app/tasks/11111111-1111-4111-8111-111111111111/lessons/les_load0001/feedback";
    for (let i = 0; i < 60; i += 1) await s.call(callerOf("mallory"), "POST", task, { kind: "helpful" }).catch(() => undefined);
    expect((await refused(s.call(callerOf("mallory"), "POST", task, { kind: "helpful" }))).code).toBe("TOO_MANY_REQUESTS");
    expect((await s.store.get(KEY, "les_load0001"))!.counters.helpful).toBe(0);
  });
  it("a rate row that cannot be read refuses the request, and a person who may not decide cannot spend another person's budget", async () => {
    const s = setup();
    await seed(s.store, pending());
    s.rate.fail = true;
    expect((await refused(s.call(callerOf("ann"), "POST", `${base}/les_pend0001/approve`, { expectedVersion: 1 }))).code).toBe("RUNTIME_UNAVAILABLE");
    expect((await s.store.get(KEY, "les_pend0001"))!.status).toBe("pending");
    s.rate.fail = false;
    await s.call(callerOf("mallory"), "POST", `${base}/les_pend0001/approve`, { expectedVersion: 1 }).catch(() => undefined);
    expect(s.taken.get("LESSON_DECISIONS|ann")).toBeUndefined();
  });
  it("an Auditor or a token is refused before any budget is taken", async () => {
    const s = setup();
    await seed(s.store, pending());
    await s.call(callerOf("ann", { orgRole: "auditor" as never }), "POST", `${base}/les_pend0001/approve`, { expectedVersion: 1 }).catch(() => undefined);
    await s.call(callerOf("ann", { browserSession: undefined }), "POST", `${base}/les_pend0001/approve`, { expectedVersion: 1 }).catch(() => undefined);
    expect(s.taken.size).toBe(0);
  });
});

describe("fix round 1 at the route", () => {
  it("read-only viewers get the lessons without who approved them; people who decide get the names", async () => {
    const s = setup();
    await seed(s.store, lessonRecord({ id: "les_act00001", approvals: [{ approvalId: "a", by: "bob", at: 1, mode: "one" }] }));
    const reader = LessonsViewReaderSchema.parse(await s.call(callerOf("mallory"), "GET", base));
    expect(reader.active[0]!.approvals).toEqual([]);
    expect(JSON.stringify(reader)).not.toContain("Bob Baker");
    expect(LessonsViewReaderSchema.parse(await s.call(callerOf("ann"), "GET", base)).active[0]!.approvals[0]!.by.name).toBe("Bob Baker");
  });

  it("a tier-2 lesson whose first approver left the project is not stuck: the card no longer counts them, the next approval is the first, the one after finishes it", async () => {
    const s = setup({ eligible: ["owner", "ann", "bob", "carl"] });
    await seed(s.store, pending({ tier: 2, tierReasons: ["escalation_words"] }));
    await s.call(callerOf("ann"), "POST", `${base}/les_pend0001/approve`, { expectedVersion: 1 });
    s.dir.value.eligibleIds = ["owner", "bob", "carl"];
    const card = LessonsViewReaderSchema.parse(await s.call(callerOf("bob"), "GET", base)).waiting[0]!;
    expect(card.needs).toMatchObject({ required: 2, have: 0 });
    expect(card.needs!.first).toBeUndefined();
    expect(await s.call(callerOf("bob"), "POST", `${base}/les_pend0001/approve`, { expectedVersion: card.version })).toEqual({ status: "pending", needs: "second_person" });
    const next = LessonsViewReaderSchema.parse(await s.call(callerOf("carl"), "GET", base)).waiting[0]!;
    expect(next.needs).toMatchObject({ have: 1, first: { name: "Bob Baker" } });
    expect(await s.call(callerOf("carl"), "POST", `${base}/les_pend0001/approve`, { expectedVersion: next.version })).toEqual({ status: "active", needs: "nothing" });
  });

  it("rollback is rolled back from the set the person saw: a write that lands between the check and the store's write makes it a conflict", async () => {
    const s = setup();
    const a = lessonRecord({ id: "les_rb000001", tier: 1, tierReasons: ["not_a_fact"], type: "convention", approvals: [{ approvalId: "a0", by: "gone", at: 1, mode: "one" }] });
    await seed(s.store, a);
    const before = await s.store.setVersion(KEY);
    await s.store.commit(KEY, before, [{ ...a, version: 2, body: "A newer wording." }], 2);
    const now = await s.store.setVersion(KEY);
    const real = s.store.setVersion.bind(s.store);
    let reads = 0;
    s.store.setVersion = async (key) => {
      const seen = await real(key);
      reads += 1;
      // The route's own check is the first read; right after it, another maintainer's write lands.
      if (reads === 1) await s.store.commit(KEY, seen, [{ ...(await s.store.get(KEY, "les_rb000001"))!, version: 3, body: "Written after the person looked." }], 3);
      return seen;
    };
    const error = await refused(s.call(callerOf("ann"), "POST", `${base}/rollback`, { targetSetVersion: before, expectedSetVersion: now }));
    expect(error.code).toBe("CHANGE_STALE");
    expect((await s.store.get(KEY, "les_rb000001"))!.body).toBe("Written after the person looked.");
  });

  it("restoring a set and then approving works through the route, with the approval count starting again", async () => {
    const s = setup();
    const a = lessonRecord({ id: "les_rb000001", tier: 1, tierReasons: ["not_a_fact"], type: "convention", approvals: [{ approvalId: "a0", by: "gone", at: 1, mode: "one" }] });
    await seed(s.store, a);
    const before = await s.store.setVersion(KEY);
    await s.store.commit(KEY, before, [{ ...a, version: 2, body: "A newer wording." }], 2);
    const now = await s.store.setVersion(KEY);
    await s.call(callerOf("ann"), "POST", `${base}/rollback`, { targetSetVersion: before, expectedSetVersion: now });
    const card = LessonsViewReaderSchema.parse(await s.call(callerOf("bob"), "GET", base)).waiting[0]!;
    expect(card.needs).toMatchObject({ have: 0 });
    expect(await s.call(callerOf("bob"), "POST", `${base}/les_rb000001/approve`, { expectedVersion: card.version })).toMatchObject({ status: "active" });
  });

  it("the digest and a lesson's history share a read budget; a refused read is a 429", async () => {
    const s = setup();
    await seed(s.store, pending());
    for (let i = 0; i < 60; i += 1) await s.call(callerOf("ann"), "GET", `${base}/digest`);
    expect((await refused(s.call(callerOf("ann"), "GET", `${base}/les_pend0001/history`))).code).toBe("TOO_MANY_REQUESTS");
    expect(s.taken.get("LESSON_READS|ann")).toBe(61);
    expect(LessonsViewReaderSchema.parse(await s.call(callerOf("ann"), "GET", base)).canDecide).toBe(true);
  });
});

describe("rejecting, removing and rolling back", () => {
  it("reject keeps the reason and refuses a stale version; retire is the kill switch for an active lesson", async () => {
    const s = setup();
    await seed(s.store, pending(), lessonRecord({ id: "les_act00001" }));
    expect((await refused(s.call(callerOf("ann"), "POST", `${base}/les_pend0001/reject`, { expectedVersion: 9, reason: "No" }))).code).toBe("CHANGE_STALE");
    expect(await s.call(callerOf("ann"), "POST", `${base}/les_pend0001/reject`, { expectedVersion: 1, reason: "Too vague" })).toEqual({ done: true });
    expect((await s.store.get(KEY, "les_pend0001"))!).toMatchObject({ status: "rejected", rejectedReason: "Too vague" });
    expect(await s.call(callerOf("bob"), "POST", `${base}/les_act00001/retire`, {})).toEqual({ done: true });
    expect((await s.store.get(KEY, "les_act00001"))!.status).toBe("retired");
    expect((await refused(s.call(callerOf("mallory"), "POST", `${base}/les_act00001/retire`, {}))).code).toBe("FORBIDDEN");
  });

  it("rolls the lesson set back to an earlier version only for a maintainer, only from the version they saw, and restored lessons come back waiting", async () => {
    const s = setup();
    // Its approver has since left the project, so the earlier approval does not stand and the restored lesson waits for a person.
    const a = lessonRecord({ id: "les_rb000001", tier: 1, tierReasons: ["not_a_fact"], type: "convention", approvals: [{ approvalId: "a0", by: "gone", at: 1, mode: "one" }] });
    await seed(s.store, a);
    const before = await s.store.setVersion(KEY);
    await s.store.commit(KEY, before, [{ ...a, version: 2, body: "A newer wording that nobody approved.", updatedAt: 2 }], 2);
    const now = await s.store.setVersion(KEY);
    expect(now).toBeGreaterThan(before);
    const view = LessonsViewReaderSchema.parse(await s.call(callerOf("ann"), "GET", base));
    expect(view.snapshots.map((x) => x.setVersion)).toContain(before);
    expect((await refused(s.call(callerOf("mallory"), "POST", `${base}/rollback`, { targetSetVersion: before, expectedSetVersion: now }))).code).toBe("FORBIDDEN");
    expect((await refused(s.call(callerOf("ann"), "POST", `${base}/rollback`, { targetSetVersion: before, expectedSetVersion: now - 1 }))).code).toBe("CHANGE_STALE");
    expect((await refused(s.call(callerOf("ann"), "POST", `${base}/rollback`, { targetSetVersion: 424242, expectedSetVersion: now }))).code).toBe("NOT_FOUND");
    const out = await s.call(callerOf("ann"), "POST", `${base}/rollback`, { targetSetVersion: before, expectedSetVersion: now });
    expect(out).toMatchObject({ restored: 1 });
    const restored = (await s.store.get(KEY, "les_rb000001"))!;
    expect(restored.status).toBe("pending");
    expect(restored.body).toBe(a.body);
    expect(s.audit.actions()).toContain("lesson.rolled_back");
  });

  it("history lists versions and who approved each, for a maintainer only", async () => {
    const s = setup();
    await seed(s.store, pending());
    await s.call(callerOf("ann"), "POST", `${base}/les_pend0001/approve`, { expectedVersion: 1 });
    const history = (await s.call(callerOf("bob"), "GET", `${base}/les_pend0001/history`)) as { versions: Array<{ version: number; approvedBy: Array<{ name: string }> }> };
    expect(history.versions.map((v) => v.version)).toEqual([2, 1]);
    expect(history.versions[0]!.approvedBy.map((p) => p.name)).toEqual(["Ann Archer"]);
    expect((await refused(s.call(callerOf("mallory"), "GET", `${base}/les_pend0001/history`))).code).toBe("FORBIDDEN");
  });
});

describe("the weekly digest", () => {
  it("leads with the lessons that matter most, for a maintainer only", async () => {
    const s = setup();
    const measured = lessonRecord({ id: "les_meas0001", status: "pending", approvals: [], pendingExpiresAt: 9e15, provenance: { ...lessonRecord().provenance, measured: true } });
    await seed(s.store, lessonRecord({ id: "les_plain001", type: "preference" }), measured);
    const digest = (await s.call(callerOf("ann"), "GET", `${base}/digest`)) as { top: Array<{ id: string }>; waiting: Array<{ id: string }> };
    expect(digest.top[0]!.id).toBe("les_meas0001");
    expect(digest.waiting.map((l) => l.id)).toEqual(["les_meas0001"]);
    expect((await refused(s.call(callerOf("mallory"), "GET", `${base}/digest`))).code).toBe("FORBIDDEN");
  });
});

describe("the Sources tab", () => {
  it("lists what is kept and how it is doing; a source kept for maintainers is named only to a maintainer; paused sources are marked", async () => {
    const s = setup();
    await addSource(s.w, { project: PROJECT, source: "slack", scope: "slack:T1/CPRIV", retention: "C", audienceDefault: "maintainers", exclude: ["a", "b"] });
    await addSource(s.w, { project: PROJECT, source: "github", scope: "github:repo/9", retention: "D", audienceDefault: "project" });
    await s.store.setFlags(KEY, { pausedSources: { "slack:CPRIV": { at: 1, reason: "spike" }, "ci": { at: 1, reason: "spike" } } });
    const maintainer = (await s.call(callerOf("ann"), "GET", `${base}/sources`)) as { sources: Array<Record<string, unknown>>; otherPaused: number };
    const slack = maintainer.sources.find((r) => r.kind === "slack")!;
    expect(slack).toMatchObject({ scope: "slack:T1/CPRIV", retention: "C", paused: true, excluded: 2, health: "unknown" });
    expect(maintainer.otherPaused).toBe(1);
    const member = (await s.call(callerOf("mallory"), "GET", `${base}/sources`)) as { sources: Array<Record<string, unknown>>; otherPaused: number };
    expect(member.sources.find((r) => r.kind === "slack")).not.toHaveProperty("scope");
    expect(JSON.stringify(member)).not.toContain("CPRIV");
    expect(member.sources.find((r) => r.kind === "github")).toMatchObject({ scope: "github:repo/9" });
    expect(member.otherPaused).toBe(0);
  });

  it("answers not found where the team record is not set up", async () => {
    const s = setup({ withTable: false });
    expect((await refused(s.call(callerOf("ann"), "GET", `${base}/sources`))).code).toBe("NOT_FOUND");
  });
});

describe("the task page: lessons the agent loaded", () => {
  it("lists the loaded lessons, with no words for one the viewer cannot see, and takes one mark per person", async () => {
    const s = setup();
    await seed(s.store, lessonRecord({ id: "les_load0001" }));
    await s.store.putManifest({ taskId: "11111111-1111-1111-1111-111111111111", workspaceId: WS, project: PROJECT, stage: "IMPLEMENT", round: 1, setVersion: 1, memory: "live", at: 1, bytes: 10, lessons: [{ id: "les_load0001", version: 1, score: 0.5, why: "scope", citation: "valid" }] });
    const task = "/v1/app/tasks/11111111-1111-1111-1111-111111111111/lessons";
    const rows = (await s.call(callerOf("mallory"), "GET", task)) as { lessons: Array<{ lessonId: string; visible: boolean; title?: string }> };
    expect(rows.lessons).toMatchObject([{ lessonId: "les_load0001", visible: true }]);
    expect(await s.call(callerOf("mallory"), "POST", `${task}/les_load0001/feedback`, { kind: "wrong_here" })).toEqual({ done: true });
    expect((await refused(s.call(callerOf("mallory"), "POST", `${task}/les_load0001/feedback`, { kind: "wrong_here" }))).code).toBe("CHANGE_STALE");
    expect((await s.store.get(KEY, "les_load0001"))!.counters.harmful).toBe(1);
    expect((await refused(s.call(callerOf("mallory"), "POST", `${task}/les_other001/feedback`, { kind: "helpful" }))).code).toBe("NOT_FOUND");
    const taskFeedback = `${task}/les_load0001/feedback`;
    expect((await refused(s.call(callerOf("mallory", { browserSession: undefined }), "POST", taskFeedback, { kind: "helpful" }))).code).toBe("FORBIDDEN");
    expect((await refused(s.call(callerOf("mallory", { orgRole: "auditor" as never }), "POST", taskFeedback, { kind: "helpful" }))).code).toBe("FORBIDDEN");
    expect((await s.store.get(KEY, "les_load0001"))!.counters.helpful).toBe(0);
    const dark = setup({ access: { mayRead: async (_o, _v, places) => places.map(() => false) } });
    await seed(dark.store, lessonRecord({ id: "les_load0001", title: "Secret title", provenance: { ...lessonRecord().provenance, sourceScopes: ["slack:T1/CPRIV"] } }));
    await dark.store.putManifest({ taskId: "11111111-1111-1111-1111-111111111111", workspaceId: WS, project: PROJECT, stage: "IMPLEMENT", round: 1, setVersion: 1, memory: "live", at: 1, bytes: 10, lessons: [{ id: "les_load0001", version: 1, score: 0.5, why: "scope", citation: "valid" }] });
    const hidden = await dark.call(callerOf("mallory"), "GET", task);
    expect(JSON.stringify(hidden)).not.toContain("Secret");
    expect((hidden as { lessons: Array<{ visible: boolean; canMark: boolean }> }).lessons[0]).toMatchObject({ visible: false, canMark: false });
  });
});

describe("the words the screens know", () => {
  it("the contract's statuses are the store's, and every tier reason the classifier writes has words", () => {
    expect([...LESSON_VIEW_STATUSES]).toEqual([...LESSON_STATUSES]);
    const source = readFileSync(new URL("../../../packages/broker/src/lessons/tier.ts", import.meta.url), "utf8");
    const written = new Set([...source.matchAll(/(?:escalation|why)\.push\("(\w+)"\)/gu)].map((m) => m[1]!).concat([...source.matchAll(/reasons: \["(\w+)"\]/gu)].map((m) => m[1]!), ["supersedes_higher_tier"]));
    for (const reason of written) if (reason !== "capability_request" && reason !== "outsider_source" && reason !== "ineligible_task") expect(LESSON_TIER_REASONS as readonly string[], reason).toContain(reason);
    expect(written.size).toBeGreaterThan(10);
  });
});

describe("what a browser may reach", () => {
  const task = "11111111-1111-4111-8111-111111111111";
  it("the project's lessons routes are under the projects family, and under tasks only the lessons read and the feedback write are open", () => {
    expect(webRouteAllowed("GET", `/v1/web/projects/${PROJECT}/lessons`)).toBe(true);
    expect(webRouteAllowed("POST", `/v1/web/projects/${PROJECT}/lessons/les_pend0001/approve`)).toBe(true);
    expect(webRouteAllowed("GET", `/v1/web/tasks/${task}/lessons`)).toBe(true);
    expect(webRouteAllowed("POST", `/v1/web/tasks/${task}/lessons/les_pend0001/feedback`)).toBe(true);
    expect(webRouteAllowed("POST", `/v1/web/tasks/${task}/lessons`)).toBe(false);
    expect(webRouteAllowed("GET", `/v1/web/tasks/${task}/lessons/les_pend0001/feedback`)).toBe(false);
    expect(webRouteAllowed("DELETE", `/v1/web/tasks/${task}/lessons`)).toBe(false);
    expect(webRouteAllowed("GET", `/v1/web/tasks/${task}`)).toBe(false);
    expect(webRouteAllowed("GET", `/v1/web/tasks/${task}/lessons/x`)).toBe(false);
    expect(webRouteAllowed("POST", `/v1/web/tasks/${task}/continue-as-task`)).toBe(true);
    expect(webRouteAllowed("GET", `/v1/web/tasks/${task}/loaded-knowledge`)).toBe(true);
    expect(webRouteAllowed("GET", `/v1/web/tasks/${task}/loaded-knowledge/op1/plan/items/3/text`)).toBe(true);
    expect(webRouteAllowed("GET", `/v1/web/tasks/${task}/loaded-knowledge/op1/review.CRITIC/items/0/text`)).toBe(true);
    expect(webRouteAllowed("POST", `/v1/web/tasks/${task}/loaded-knowledge`)).toBe(false);
    expect(webRouteAllowed("GET", `/v1/web/tasks/${task}/loaded-knowledge/op1/plan/items/3`)).toBe(false);
    expect(webRouteAllowed("GET", `/v1/web/tasks/${task}/loaded-knowledge/../x`)).toBe(false);
    // Upper-case task ids are not task ids here (the broker's own patterns are lower-case only).
    expect(webRouteAllowed("GET", `/v1/web/tasks/${"ABCDEFAB-1111-4111-8111-111111111111"}/lessons`)).toBe(false);
    expect(webRouteAllowed("GET", `/v1/web/tasks/${"ABCDEFAB-1111-4111-8111-111111111111"}/loaded-knowledge`)).toBe(false);
  });
});

void draft; void Clock;
