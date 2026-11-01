// Wiring lane wire-lessons, broker side: approved lessons reach a stage's worker payload, only where learning is on, and the worker's report is applied only to the manifest that stage recorded.
// Covers: the approved-only and stale-citation filters of the loader, the dispatch call (`learnedContextForOperation`), the old-worker fallback at delivery, the load report hook,
// and the directory, audit sink and citation verifier the runtime is built from.
import { afterEach, describe, expect, it, vi } from "vitest";
import { LearnedContextSchema, LEARNED_CONTEXT_FEATURE, LEARNED_LOAD_REPORT_FIELD, type LoadReport, type WorkerInvocation } from "../../../packages/contracts/src/index.js";
import { withoutLearnedContext } from "../../../packages/broker/src/aws/ec2-delivery.js";
import { LESSON_LOAD_DEADLINE_MS, learnedContextForOperation, lessonStageOf } from "../../../packages/broker/src/aws/broker/lessons-dispatch.js";
import { afterWorkerEvents } from "../../../packages/broker/src/aws/broker/lessons-report.js";
import { createCitationVerifier } from "../../../packages/broker/src/lessons/citation-verifier.js";
import { lessonAuditSink } from "../../../packages/broker/src/lessons/audit-sink.js";
import { approvedForUse, type LoadDeps } from "../../../packages/broker/src/lessons/load.js";
import { DEFAULT_APPROVAL_POLICY } from "../../../packages/broker/src/lessons/policy.js";
import { NO_EMBEDDER, NO_VECTORS } from "../../../packages/broker/src/lessons/runtime.js";
import { InMemoryLessonStore } from "../../../packages/broker/src/lessons/store.js";
import type { Lesson } from "../../../packages/broker/src/lessons/types.js";
import { Audit, Clock, KEY, PROJECT, WS, allowAllAccess, lessonRecord, seed, settings } from "./lesson-helpers.js";

afterEach(() => { vi.useRealTimers(); });

const ann = { approvalId: "ap-ann", by: "ann", at: 1, mode: "one" as const };
const bob = { approvalId: "ap-bob", by: "bob", at: 2, mode: "second_person" as const };
const auto = { approvalId: "ap-auto", by: "system:auto", at: 1, mode: "auto" as const };
const conv = (id: string, over: Partial<Lesson> = {}): Lesson => lessonRecord({ id, type: "convention", tier: 1, stages: ["UNDERSTAND", "PLAN", "IMPLEMENT"], approvals: [ann], ...over });

describe("only approved lessons are used", () => {
  it("tier 0: the pilot default needs one person; an automatic approval alone is not enough", () => {
    const tier0 = (approvals: Lesson["approvals"]) => lessonRecord({ tier: 0, approvals });
    expect(approvedForUse(tier0([auto]), DEFAULT_APPROVAL_POLICY)).toBe(false);
    expect(approvedForUse(tier0([]), DEFAULT_APPROVAL_POLICY)).toBe(false);
    expect(approvedForUse(tier0([ann]), DEFAULT_APPROVAL_POLICY)).toBe(true);
    expect(approvedForUse(tier0([auto, ann]), DEFAULT_APPROVAL_POLICY)).toBe(true);
    // A policy that asks for two people for tier 0 is honoured; one that allows automatic go-live is the only case an automatic approval counts.
    expect(approvedForUse(tier0([ann]), { ...DEFAULT_APPROVAL_POLICY, tier0: "two" })).toBe(false);
    expect(approvedForUse(tier0([ann, bob]), { ...DEFAULT_APPROVAL_POLICY, tier0: "two" })).toBe(true);
    expect(approvedForUse(tier0([auto]), { ...DEFAULT_APPROVAL_POLICY, tier0: "auto" })).toBe(true);
  });

  it("tier 1 needs one person, tier 2 two (or the audited sole-owner exception), and a lesson sent back to a person needs one whatever its tier", () => {
    expect(approvedForUse(lessonRecord({ tier: 1, approvals: [auto] }), DEFAULT_APPROVAL_POLICY)).toBe(false);
    expect(approvedForUse(lessonRecord({ tier: 1, approvals: [ann] }), DEFAULT_APPROVAL_POLICY)).toBe(true);
    expect(approvedForUse(lessonRecord({ tier: 2, approvals: [ann] }), DEFAULT_APPROVAL_POLICY)).toBe(false);
    expect(approvedForUse(lessonRecord({ tier: 2, approvals: [ann, bob] }), DEFAULT_APPROVAL_POLICY)).toBe(true);
    expect(approvedForUse(lessonRecord({ tier: 2, approvals: [ann, { ...ann, approvalId: "again" }] }), DEFAULT_APPROVAL_POLICY)).toBe(false);
    expect(approvedForUse(lessonRecord({ tier: 2, approvals: [{ ...ann, mode: "sole_owner_exception" }] }), DEFAULT_APPROVAL_POLICY)).toBe(true);
    expect(approvedForUse(lessonRecord({ tier: 0, approvals: [auto], reviewRequired: true }), { ...DEFAULT_APPROVAL_POLICY, tier0: "auto" })).toBe(false);
  });
});

// ---- the dispatch call

function world(over: { settings?: ReturnType<typeof settings>; store?: InMemoryLessonStore; identity?: { principals: string[]; groups: string[] } } = {}) {
  const store = over.store ?? new InMemoryLessonStore();
  const clock = new Clock();
  const load: LoadDeps = { store, embedder: NO_EMBEDDER, vectors: NO_VECTORS, settings: over.settings ?? settings(), access: allowAllAccess, audit: new Audit(), now: clock.now };
  const identityCalls: string[] = [];
  const lessons = { load, directory: { identity: async (_w: string, developer: string) => { identityCalls.push(developer); return over.identity ?? { principals: [], groups: [] }; }, eligibility: async () => { throw new Error("not used"); } } };
  return { host: { lessons } as never, store, load, identityCalls };
}
const task = (over: Record<string, unknown> = {}) => ({ taskId: "task-1", orgId: WS, project: PROJECT, title: "Retry failed HTTP calls", shared: true, developerId: "d".repeat(64), developerName: "Maya", provider: "slack", workflow: { revision: 4 }, ...over }) as never;
const definition = { repositories: [{ name: "api", url: "https://github.com/acme/api" }] } as never;
/** The install switch for lessons reaching an agent, on (it is off by default and apart from the Team record's flag). */
const ON = { LEARNED_LESSONS_ENABLED: "1" };
const ask = (host: never, over: Record<string, unknown> = {}, env: NodeJS.ProcessEnv = ON) => learnedContextForOperation(host, { orgId: WS, task: task(), workflowMode: "IMPLEMENT", definition, ...over }, env);

describe("learnedContextForOperation", () => {
  it("returns the approved, in-scope lessons for the stage, records the manifest, and names the stage's manifest for the report", async () => {
    const w = world();
    await seed(w.store, conv("les_approved1"), conv("les_unapproved", { approvals: [auto] }), conv("les_otherrepo", { scope: { repos: ["web"] } }));
    const result = await ask(w.host);
    expect(LearnedContextSchema.safeParse(result.learnedContext).success).toBe(true);
    expect(result.learnedContext?.lessons.map((l) => l.id)).toEqual(["les_approved1"]);
    expect(result.learnedContext?.stage).toBe("IMPLEMENT");
    expect(result.load).toEqual({ taskId: "task-1", project: PROJECT, stage: "IMPLEMENT", round: 4 });
    const manifests = await w.store.manifests(KEY, "task-1");
    expect(manifests).toHaveLength(1);
    expect(manifests[0]!.lessons.map((e) => e.id)).toEqual(["les_approved1"]);
    expect(manifests[0]!).toMatchObject({ stage: "IMPLEMENT", round: 4 });
  });

  it("drops a lesson whose broker-side citation check is stale, and one that is not active", async () => {
    const w = world();
    await seed(w.store, conv("les_fresh0001"), conv("les_staleone1", { citationChecks: [{ index: 0, result: "stale", at: 1 }] }), conv("les_pending01", { status: "pending" }), conv("les_stalestat", { status: "stale" }));
    expect((await ask(w.host)).learnedContext?.lessons.map((l) => l.id)).toEqual(["les_fresh0001"]);
  });

  it("with learning Off for the project nothing is loaded, sent or recorded, and the store is not even read", async () => {
    const store = new InMemoryLessonStore();
    const reads = vi.spyOn(store, "list");
    const w = world({ store, settings: settings({ mode: "Off" }) });
    await seed(store, conv("les_approved1"));
    reads.mockClear();
    const result = await ask(w.host);
    expect(result).toEqual({});
    expect(await store.manifests(KEY, "task-1")).toEqual([]);
    expect(reads).not.toHaveBeenCalled();
  });

  it("a company lock that is stricter than the project turns it off too (stricter only)", async () => {
    const w = world({ settings: settings({ mode: "On", companyLock: "Collect" }) });
    await seed(w.store, conv("les_approved1"));
    expect(await ask(w.host)).toEqual({});
  });

  it("a settings reader that fails reads as Off", async () => {
    const w = world({ settings: { read: async () => { throw new Error("down"); } } });
    await seed(w.store, conv("les_approved1"));
    expect(await ask(w.host)).toEqual({});
  });

  it("with the install switch off, nothing is loaded, recorded or sent even though lesson ports exist and an approved lesson matches", async () => {
    const w = world();
    await seed(w.store, conv("les_approved1"));
    expect(await ask(w.host)).toMatchObject({ learnedContext: { lessons: [{ id: "les_approved1" }] } });
    const before = (await w.store.manifests({ workspaceId: WS, project: PROJECT }, "task-1")).length;
    for (const value of [undefined, "0", "", "true", "yes", " 1", "01"]) {
      const env: NodeJS.ProcessEnv = value === undefined ? {} : { LEARNED_LESSONS_ENABLED: value };
      expect(await ask(w.host, { task: task({ taskId: "task-2" }) }, env), String(value)).toEqual({});
    }
    expect(await w.store.manifests({ workspaceId: WS, project: PROJECT }, "task-2")).toEqual([]);
    expect((await w.store.manifests({ workspaceId: WS, project: PROJECT }, "task-1")).length).toBe(before);
    expect(w.identityCalls).toEqual([]);
  });

  it("does nothing where the install has no lesson ports", async () => {
    expect(await learnedContextForOperation({}, { orgId: WS, task: task(), workflowMode: "IMPLEMENT", definition }, ON)).toEqual({});
  });

  it("only the five coding stages of a Rovara Code task carry lessons", async () => {
    const w = world();
    await seed(w.store, conv("les_approved1", { type: "convention", stages: ["UNDERSTAND", "PLAN", "IMPLEMENT"] }));
    for (const mode of ["CHECKS", "SETUP_DRAFT", "SPEC_WRITE", "FEEDBACK_REVIEW", undefined, "constructor", "__proto__"]) expect(await ask(w.host, { workflowMode: mode }), String(mode)).toEqual({});
    for (const mode of ["UNDERSTAND", "PLAN", "IMPLEMENT"]) expect((await ask(w.host, { workflowMode: mode })).learnedContext?.stage, mode).toBe(mode);
    expect(lessonStageOf("PLAN_CRITIQUE")).toBe("PLAN_CRITIQUE");
    expect(lessonStageOf("REVIEW")).toBe("REVIEW");
    expect(lessonStageOf("hasOwnProperty")).toBeUndefined();
    expect(await ask(w.host, { legacyTask: true })).toEqual({});
    expect(await ask(w.host, { agentRun: {} })).toEqual({});
    expect(await ask(w.host, { task: undefined })).toEqual({});
    expect(await ask(w.host, { task: task({ purpose: "diagnosis" }) })).toEqual({});
    expect(await ask(w.host, { task: task({ purpose: "setup_draft" }) })).toEqual({});
    expect(await ask(w.host, { task: task({ orgId: "org_bbbbbbbbbbbbbbbbbbbb" }) })).toEqual({});
  });

  it("a private task reads what its owner may read: a restricted lesson reaches the owner who passes its ACL and nobody else", async () => {
    const restricted = (principals: string[]) => ({ kind: "restricted" as const, acl: { source: "slack" as const, scope: "slack:T/C9", principals, capturedAt: "x", liveCheck: "none" as const } });
    const base = conv("les_restricted");
    const secret = { ...base, provenance: { ...base.provenance, audience: restricted(["U-owner"]) } };
    const member = world({ identity: { principals: ["U-owner"], groups: [] } });
    await seed(member.store, secret);
    expect((await ask(member.host, { task: task({ shared: false }) })).learnedContext?.lessons.map((l) => l.id)).toEqual(["les_restricted"]);
    expect(member.identityCalls).toEqual(["d".repeat(64)]);
    const stranger = world({ identity: { principals: ["U-other"], groups: [] } });
    await seed(stranger.store, secret);
    expect(await ask(stranger.host, { task: task({ shared: false }) })).toEqual({});
    // A shared task is nobody in particular: it reads no restricted lesson.
    const shared = world();
    await seed(shared.store, secret);
    expect(await ask(shared.host)).toEqual({});
  });

  it("never throws: a store that fails sends nothing", async () => {
    const store = new InMemoryLessonStore();
    vi.spyOn(store, "setVersion").mockRejectedValue(new Error("down"));
    expect(await ask(world({ store }).host)).toEqual({});
  });

  it("never waits longer than the deadline for a slow store", async () => {
    vi.useFakeTimers();
    const store = new InMemoryLessonStore();
    vi.spyOn(store, "setVersion").mockImplementation(() => new Promise(() => undefined));
    const pending = ask(world({ store }).host);
    await vi.advanceTimersByTimeAsync(LESSON_LOAD_DEADLINE_MS + 10);
    expect(await pending).toEqual({});
  });
});

// ---- an older worker

describe("an older worker", () => {
  const invocation = (payload: Record<string, unknown> = {}): WorkerInvocation => ({ protocolVersion: 1, kind: "task", operationId: "op", workspaceId: "ws", fence: 1, projectRevision: 1, callbackCapability: "c".repeat(64), payload: { conversationId: "c", prompt: "do it", ...payload } }) as never;
  const context = { v: 1, setVersion: 1, stage: "IMPLEMENT", lessons: [] };

  it("is sent the stage without learnedContext (never refused for it); a worker that lists the feature gets it unchanged", () => {
    const withLessons = invocation({ learnedContext: context });
    const stripped = withoutLearnedContext(withLessons, ["task.workflowMode"]);
    expect(stripped).not.toBe(withLessons);
    expect((stripped as { payload: Record<string, unknown> }).payload).not.toHaveProperty("learnedContext");
    expect((stripped as { payload: Record<string, unknown> }).payload).toMatchObject({ conversationId: "c", prompt: "do it" });
    expect(withoutLearnedContext(withLessons, [])).not.toBe(withLessons);
    expect(withoutLearnedContext(withLessons, ["task.workflowMode", LEARNED_CONTEXT_FEATURE])).toBe(withLessons);
    const plain = invocation();
    expect(withoutLearnedContext(plain, [])).toBe(plain);
  });
});

// ---- the worker's report

describe("afterWorkerEvents", () => {
  const report = (stage: LoadReport["stage"], citation: LoadReport["lessons"][number]["citation"] = "valid"): LoadReport => ({ v: 1, stage, lessons: [{ id: "les_approved1", version: 1, citation }] });
  const events = (...payloads: unknown[]) => ({ events: payloads.map((payload) => ({ type: "progress", timestamp: "2026-11-01T00:00:00.000Z", payload })) });
  const operation = (over: Record<string, unknown> = {}) => ({ id: "op-1", orgId: WS, workspaceId: "ws-1", learnedLoad: { taskId: "task-1", project: PROJECT, stage: "IMPLEMENT", round: 4 }, ...over }) as never;

  async function loaded(s = settings()) {
    const w = world({ settings: s });
    await seed(w.store, conv("les_approved1"));
    await ask(w.host);
    const dependencies = { lessons: { ...(w.host as { lessons: object }).lessons, settings: s, counters: { store: w.store, judge: { rate: async () => { throw new Error("no"); } }, settings: s, audit: new Audit(), now: new Clock().now } }, documentClient: {}, tableName: "t" } as never;
    return { w, dependencies };
  }

  it("applies the report to the stage's manifest: the lesson counts as loaded, once", async () => {
    const { w, dependencies } = await loaded();
    await afterWorkerEvents(dependencies, operation(), events({ [LEARNED_LOAD_REPORT_FIELD]: report("IMPLEMENT") }));
    expect((await w.store.get(KEY, "les_approved1"))!.counters.loaded).toBe(1);
    expect((await w.store.manifests(KEY, "task-1"))[0]!.lessons[0]!.citation).toBe("valid");
    await afterWorkerEvents(dependencies, operation(), events({ [LEARNED_LOAD_REPORT_FIELD]: report("IMPLEMENT") }));
    expect((await w.store.get(KEY, "les_approved1"))!.counters.loaded).toBe(1);
  });

  it("a stale report counts toward the stale limit, not as loaded", async () => {
    const { w, dependencies } = await loaded();
    await afterWorkerEvents(dependencies, operation(), events({ [LEARNED_LOAD_REPORT_FIELD]: report("IMPLEMENT", "stale_dropped") }));
    const lesson = (await w.store.get(KEY, "les_approved1"))!;
    expect(lesson.counters).toMatchObject({ loaded: 0, citationStale: 1 });
  });

  it("ignores a report for another stage, a malformed one, an operation that recorded no load, and a report with the project's learning Off", async () => {
    const { w, dependencies } = await loaded();
    await afterWorkerEvents(dependencies, operation(), events({ [LEARNED_LOAD_REPORT_FIELD]: report("REVIEW") }));
    await afterWorkerEvents(dependencies, operation(), events({ [LEARNED_LOAD_REPORT_FIELD]: { v: 2, stage: "IMPLEMENT", lessons: [] } }, { [LEARNED_LOAD_REPORT_FIELD]: { ...report("IMPLEMENT"), extra: 1 } }, { message: "hi" }));
    await afterWorkerEvents(dependencies, operation({ learnedLoad: undefined }), events({ [LEARNED_LOAD_REPORT_FIELD]: report("IMPLEMENT") }));
    expect((await w.store.get(KEY, "les_approved1"))!.counters.loaded).toBe(0);
    const off = await loaded(settings({ mode: "Off" }));
    await afterWorkerEvents(off.dependencies, operation(), events({ [LEARNED_LOAD_REPORT_FIELD]: report("IMPLEMENT") }));
    expect((await off.w.store.get(KEY, "les_approved1"))!.counters.loaded).toBe(0);
  });

  it("learning turned Off after the load: the report is not applied and nothing of the stage's loaded knowledge is stored", async () => {
    let mode: "On" | "Off" = "On";
    const reader = { read: async () => ({ mode }) } as never;
    const { w, dependencies } = await loaded(reader);
    mode = "Off";
    await afterWorkerEvents(dependencies, operation(), events({ [LEARNED_LOAD_REPORT_FIELD]: report("IMPLEMENT") }));
    expect((await w.store.get(KEY, "les_approved1"))!.counters.loaded).toBe(0);
    mode = "On";
    await afterWorkerEvents(dependencies, operation(), events({ [LEARNED_LOAD_REPORT_FIELD]: report("IMPLEMENT") }));
    expect((await w.store.get(KEY, "les_approved1"))!.counters.loaded).toBe(1);
  });

  it("does nothing, and cannot fail the events, where the install has no lesson ports or the body is not events", async () => {
    await expect(afterWorkerEvents({ documentClient: {}, tableName: "t" } as never, operation(), events({ [LEARNED_LOAD_REPORT_FIELD]: report("IMPLEMENT") }))).resolves.toBeUndefined();
    const { dependencies } = await loaded();
    await expect(afterWorkerEvents(dependencies, operation(), { events: "no" })).resolves.toBeUndefined();
    await expect(afterWorkerEvents(dependencies, operation(), null)).resolves.toBeUndefined();
  });
});

// ---- the pieces the runtime is made of

describe("the lessons audit sink", () => {
  it("writes the events that have a contract name, with only the facts that action allows, and skips bookkeeping", async () => {
    const written: Array<{ action: string; facts?: Record<string, unknown>; orgId: string; actor: unknown; target: unknown }> = [];
    const sink = lessonAuditSink(async (event) => { written.push(event as never); }, () => Date.parse("2026-11-01T00:00:00.000Z"));
    const member = "a".repeat(64);
    await sink.emit({ action: "lesson.approved", workspaceId: WS, project: PROJECT, lessonId: "les_aaaa1111", actor: member, facts: { tier: 1, mode: "one", count: 1 } });
    await sink.emit({ action: "lesson.helpful", workspaceId: WS, project: PROJECT, lessonId: "les_aaaa1111", actor: member, facts: {} });
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({ action: "lesson.approved", orgId: WS, actor: { kind: "member", id: member }, target: { kind: "lesson", id: "les_aaaa1111" }, facts: { tier: 1, approvals: 1, soleOwner: false } });
    await sink.emit({ action: "lesson.sole_owner_exception", workspaceId: WS, project: PROJECT, lessonId: "les_aaaa1111", actor: "someone", facts: { tier: 2 } });
    expect(written[1]).toMatchObject({ action: "lesson.approved", actor: { kind: "system", id: "rovara" }, facts: { soleOwner: true } });
  });

  it("a ledger that is down makes the write fail, so the library's fail-closed paths refuse", async () => {
    const sink = lessonAuditSink(async () => { throw new Error("down"); }, Date.now);
    await expect(sink.emit({ action: "lesson.approved", workspaceId: WS, project: PROJECT, lessonId: "les_aaaa1111", facts: {} })).rejects.toThrow();
  });
});

describe("the citation verifier", () => {
  const COMMIT = "abcdef0123456789abcdef0123456789abcdef01";
  const text = ["// header", "export function withRetry(fn) {", "  return fn();", "}"].join("\n");
  const verifier = (file: (input: { path: string }) => Promise<string | undefined>, repos: string[] = ["api"]) => createCitationVerifier({ reader: { file: async (input) => file(input) }, repositoriesOf: async () => repos, timeoutMs: 50 });
  const input = (over: Record<string, unknown> = {}) => ({ workspaceId: WS, project: PROJECT, repo: "api", commit: COMMIT, path: "src/retry/index.ts", startLine: 2, endLine: 3, anchor: "export function withRetry(fn) {", ...over });

  it("valid at the start line, moved when found once elsewhere, stale when gone", async () => {
    expect(await verifier(async () => text).verify(input())).toEqual({ result: "valid" });
    expect(await verifier(async () => `${"\n".repeat(10)}${text}`).verify(input())).toMatchObject({ result: "moved", startLine: 12 });
    expect(await verifier(async () => "nothing here").verify(input())).toEqual({ result: "stale" });
    expect(await verifier(async () => undefined).verify(input())).toEqual({ result: "stale" });
  });

  it("answers unknown, never valid, when it cannot tell: another project's repository, a short commit, an unsafe path, no project, a slow or failing host, an oversize file", async () => {
    const ok = verifier(async () => text);
    expect((await verifier(async () => text, ["web"]).verify(input())).result).toBe("unknown");
    expect((await ok.verify(input({ commit: "abc123" }))).result).toBe("unknown");
    expect((await ok.verify(input({ path: "../secrets" }))).result).toBe("unknown");
    expect((await ok.verify(input({ project: undefined }))).result).toBe("unknown");
    expect((await verifier(async () => { throw new Error("host down"); }).verify(input())).result).toBe("unknown");
    expect((await verifier(() => new Promise(() => undefined)).verify(input())).result).toBe("unknown");
    expect((await verifier(async () => "x".repeat(1024 * 1024 + 1)).verify(input())).result).toBe("unknown");
  });
});
