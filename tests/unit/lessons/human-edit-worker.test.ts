// Lessons capture lane, integration with lane 2: a human fix-up commit rides the LessonsReflect queue as a sibling message (ids only), and the LessonsWorker reads and learns from it under the reflection's own lease,
// deadline, single-attempt model client and `callStartedAt` rules. A human-edit extraction is a learning model call: it is never paid twice.
import { describe, expect, it, vi } from "vitest";
import { LESSONS_REFLECT_MAX_ATTEMPTS } from "@agentx/contracts";
import { humanEditEnqueue } from "../../../packages/broker/src/aws/broker/lessons-wiring.js";
import { createHumanEditExtractor, learnFromHumanEdit, type HumanEditExtractorDeps } from "../../../packages/broker/src/lessons/human-edit.js";
import { currentLearningAttempt, withLearningAttempt } from "../../../packages/broker/src/lessons/learning-deadline.js";
import type { ProcessDeps } from "../../../packages/broker/src/lessons/process.js";
import { dynamoReflectClaims, reflectClaimKey } from "../../../packages/broker/src/lessons/reflect-claims.js";
import { HumanEditMessageSchema, humanEditJobOf, humanEditLeaseOutcome, humanEditMessageOf, parseHumanEditMessage, parseReflectMessage, sqsReflectQueue } from "../../../packages/broker/src/lessons/reflect-queue.js";
import { runReflectMessage, handleReflectBatch, type ReflectWorkerDeps } from "../../../packages/broker/src/lessons/reflect-worker.js";
import { InMemoryLessonStore } from "../../../packages/broker/src/lessons/store.js";
import type { TaskSubjectBase } from "../../../packages/broker/src/lessons/task-end.js";
import type { HumanEditInput, HumanEditJob } from "../../../packages/broker/src/team-record/sources/codehost.js";
import { FakeDynamoDb } from "../../support/fake-dynamodb.js";
import { TEST_ORG } from "../../support/orgs.js";
import { Alerts, Audit, BASE, Clock, MERGED, MemoryVectors, PROJECT, ScriptedModel, Spend, candidateJson, embedder, facts, memberSpan, reply, settings, verifier } from "./lesson-helpers.js";

const LINK = "https://github.com/acme/api/pull/7";
const hex = (n: number): string => n.toString(16).padStart(40, "0");
const TASK = "task-1";
const job = (over: Partial<HumanEditJob> = {}): HumanEditJob => ({
  repo: { host: "github", id: "77", fullName: "acme/api", isPrivate: true, defaultBranch: "main", workspaceId: TEST_ORG, project: PROJECT }, project: PROJECT, taskId: TASK,
  pullRequest: { number: 7, url: LINK }, candidateHeadSha: hex(1), headSha: hex(2), headRef: "feature/fix", ...over,
});
const bodyOf = (j: HumanEditJob = job(), requestId = "req-1") => JSON.stringify(humanEditMessageOf(j, requestId));

describe("the human-edit message", () => {
  it("is coordinates only: the company, the task, the repository's address, the pull request, the two commits; round-trips to the tap's job", () => {
    const message = humanEditMessageOf(job(), "req-1");
    expect(Object.keys(message).sort()).toEqual(["candidateHeadSha", "headRef", "headSha", "kind", "orgId", "project", "pullRequest", "repo", "requestId", "taskId"]);
    expect(humanEditJobOf(parseHumanEditMessage(JSON.stringify(message))!)).toEqual(job());
    // No diff, no file name, no line, no commit message, no person (positive control: the job really names a pull request, a repository and a branch).
    expect(JSON.stringify(message)).toContain("acme/api");
    for (const word of ["withRetry", "patch", "hunk", "src/", "author", "email"]) expect(JSON.stringify(message), word).not.toContain(word);
  });
  it("is exactly that: extra text, a title, a diff, a bad commit, a non-https link or a bad company is not a message; and it is not a reflection (nor a reflection a human edit)", () => {
    const good = humanEditMessageOf(job(), "req-1");
    for (const bad of [{ title: "Fix" }, { patch: "+x" }, { headSha: "abc" }, { headSha: "A".repeat(40) }, { orgId: "not-an-org" }, { taskId: "has space" }, { pullRequest: { number: 7, url: "http://x" } }, { pullRequest: { number: 7, url: LINK, title: "Fix" } },
      { repo: { ...good.repo, owner: "x" } }, { headRef: "a b" }, { kind: "reflection" }, { requestId: "x".repeat(300) }]) {
      expect(parseHumanEditMessage(JSON.stringify({ ...good, ...bad })), JSON.stringify(bad)).toBeUndefined();
    }
    expect(parseHumanEditMessage("not json")).toBeUndefined();
    expect(parseReflectMessage(JSON.stringify(good))).toBeUndefined();
    expect(parseHumanEditMessage(JSON.stringify({ orgId: TEST_ORG, taskId: TASK, outcome: "merged", requestId: "r" }))).toBeUndefined();
    expect(HumanEditMessageSchema.safeParse(good).success).toBe(true);
    // A job whose workspace is not a company id cannot be queued at all.
    expect(() => humanEditMessageOf(job({ repo: { ...job().repo, workspaceId: "somebody-else" } }), "r")).toThrow();
  });
  it("goes to the same queue as a reflection, as that JSON; the lease is per task and head commit", async () => {
    const sent: Array<{ QueueUrl?: string; MessageBody?: string }> = [];
    const queue = sqsReflectQueue({ send: async (command) => { sent.push((command as { input: { QueueUrl?: string; MessageBody?: string } }).input); } }, "https://queue.example/q");
    await queue.send(humanEditMessageOf(job(), "req-1"));
    expect(sent).toEqual([{ QueueUrl: "https://queue.example/q", MessageBody: bodyOf() }]);
    await expect(queue.send({ ...humanEditMessageOf(job(), "r"), headSha: "nope" })).rejects.toThrow();
    expect(humanEditLeaseOutcome({ headSha: hex(2) })).toBe(`human_edit-${hex(2)}`);
  });
});

describe("what the broker queues at a merge", () => {
  it("one message of ids per job, with a fresh request id; a queue that did not take it is one fixed line and the error goes to the tap", async () => {
    const sent: unknown[] = [];
    const enqueue = humanEditEnqueue({ send: async (message) => { sent.push(message); } }, undefined, () => "req-9");
    await enqueue(job());
    expect(sent).toEqual([humanEditMessageOf(job(), "req-9")]);
    const logs: Array<[string, Record<string, string | number>]> = [];
    const failing = humanEditEnqueue({ send: async () => { throw new Error("queue down: a person's words"); } }, (event, fields) => logs.push([event, fields]));
    await expect(failing(job())).rejects.toThrow();
    expect(logs).toEqual([["learning.human_edit_enqueue_failed", { taskId: TASK }]]);
    expect(JSON.stringify(logs)).not.toContain("person");
  });
});

// ---- the worker -----------------------------------------------------------------------------------------------------------------------------------------------------------------------

/** A model that, like the real path (`aws/broker/learning-model.ts`), marks the lease just before it is called. */
class MarkingModel extends ScriptedModel {
  override async complete(request: Parameters<ScriptedModel["complete"]>[0]) {
    await currentLearningAttempt()?.callStarting?.();
    return super.complete(request);
  }
}
const baseOf = (): TaskSubjectBase => ({
  facts: {
    workspaceId: TEST_ORG, project: PROJECT, taskId: TASK, repositories: ["api"], baseCommit: BASE, mergedCommit: MERGED, outcome: "merged",
    task: { developerId: "creator", startedBy: { developerId: "starter" }, agent: { agentId: "a" } },
    rest: { initiatorTrust: "member", steeringTrust: ["member"], intentTrust: "member", links: [LINK], spans: [{ kind: "intent", text: "Make retries use the helper", trust: "member", authorId: "creator" }, memberSpan("Do not do that", { kind: "send_back", authorId: "starter", eventId: "ev-sb" })] },
  },
  sendBackRequestIds: [],
});
const inputOf = (j: HumanEditJob, authors: string[]): HumanEditInput => ({
  workspaceId: j.repo.workspaceId, project: j.project, repo: j.repo.fullName, taskId: j.taskId, pullRequest: j.pullRequest, trust: "member", authorCount: authors.length, authors,
  files: [{ path: "src/fetch.ts", additions: 1, deletions: 1, symbols: [], hunks: ["@@ -1,2 +1,2 @@", "-fetch()", "+await withRetry(() => fetch())"] }], link: j.pullRequest.url, audience: { kind: "project" }, scope: "github:repo/77",
});

function fixture(over: { mode?: "Off" | "On"; model?: ScriptedModel; outsiders?: string[]; erased?: string[]; readFails?: () => boolean; authors?: string[] } = {}) {
  const store = new InMemoryLessonStore();
  const audit = new Audit();
  const clock = new Clock();
  const model = over.model ?? new MarkingModel([reply(candidateJson({ type: "convention", evidenceSpanIds: ["S1"], citations: [{ kind: "pr", url: LINK }] }))]);
  const configured = settings({ mode: over.mode ?? "On" });
  const reflectSpend = new Spend();
  const process: ProcessDeps = {
    store, embedder, vectors: new MemoryVectors(), judgeModel: new ScriptedModel(), spend: new Spend(), audit, alerts: new Alerts(), now: clock.now,
    verifier: verifier("valid"), facts: facts(), settings: configured, newId: (() => { let n = 0; return () => `les_${String(++n).padStart(4, "0")}`; })(),
  };
  const deps: HumanEditExtractorDeps = {
    source: { read: async () => baseOf() }, settings: configured, reflect: { model, spend: reflectSpend, audit, settings: configured, edition: "public", now: clock.now, newId: () => "run-1" }, process,
    standing: async (_org, who) => (over.outsiders?.includes(who) ? "outsider" : "member"),
    isErased: async (_org, who) => over.erased?.includes(who) === true,
  };
  const extractor = createHumanEditExtractor(deps);
  const runs: HumanEditJob[] = [];
  // The Team record's `humanEdit.run(job, { leased: true })` stands in here: it proves the authors and hands the lines on (its own rules are in `human-edit-wiring.test.ts`); the extractor is the real one.
  const run = async (j: HumanEditJob): Promise<"handed_on" | "skipped"> => {
    runs.push(j);
    if (over.readFails?.() === true) throw new Error("the host did not answer");
    const out = await extractor.extract(inputOf(j, over.authors ?? ["rae"]));
    return out.candidates >= 0 ? "handed_on" : "skipped";
  };
  return { store, model, runs, settings: configured, run, extractor, reflectSpend };
}

function setup(over: Parameters<typeof fixture>[0] = {}, workerOver: Partial<ReflectWorkerDeps> = {}) {
  const f = fixture(over);
  const db = new FakeDynamoDb();
  const logs: Array<{ event: string; fields: Record<string, string | number> }> = [];
  const claims = dynamoReflectClaims({ documentClient: db, tableName: "state", keysOutcome: async () => "clear", newAttemptId: (() => { let n = 0; return () => `att-${++n}`; })() });
  const learn = vi.fn(async () => ({ status: "reflected" as const, retry: false }));
  let now = 1_000_000;
  const deps: ReflectWorkerDeps = {
    claims, learn, humanEdit: (j) => learnFromHumanEdit({ run: f.run, settings: f.settings }, j),
    now: () => now, deadlineMs: 240_000, log: (event, fields) => logs.push({ event, fields }), ...workerOver,
  };
  const lease = () => db.get(reflectClaimKey(TEST_ORG, TASK, humanEditLeaseOutcome({ headSha: hex(2) })).pk, "CLAIM") as Record<string, unknown> | undefined;
  return { ...f, db, deps, learn, logs, lease, tick: (ms: number) => { now += ms; }, classes: () => logs.filter((l) => l.event === "lessons_worker.result").map((l) => l.fields["class"]) };
}

describe("the worker runs a human edit under the reflection's lease", () => {
  it("runs it once and keeps the lesson; a redelivery (or a second message for the same edit) never runs the model again", async () => {
    const w = setup();
    expect(await runReflectMessage(w.deps, bodyOf())).toEqual({ result: "reflected", retry: false });
    expect(w.model.calls).toHaveLength(1);
    expect(w.runs).toHaveLength(1);
    expect(await w.store.list({ workspaceId: TEST_ORG, project: PROJECT })).toHaveLength(1);
    // The lease is `done`, keyed by the task and the head commit; the reflection of the same task has its own.
    expect(w.lease()).toMatchObject({ leaseState: "done", attempt: 1 });
    expect(await runReflectMessage(w.deps, bodyOf(job(), "req-2"))).toEqual({ result: "already", retry: false });
    expect(w.model.calls).toHaveLength(1);
    expect(w.runs).toHaveLength(1);
    expect(w.classes()).toEqual(["reflected", "already"]);
    // Another head commit of the same task is its own edit.
    const other = job({ headSha: hex(3) });
    w.model.replies.push(reply(candidateJson({ type: "convention", evidenceSpanIds: ["S1"], citations: [{ kind: "pr", url: LINK }] })));
    expect((await runReflectMessage(w.deps, bodyOf(other, "req-3"))).result).toBe("reflected");
    expect(w.runs).toHaveLength(2);
    // And a task-end reflection of the same task is not blocked by, and does not block, the edit.
    expect((await runReflectMessage(w.deps, JSON.stringify({ orgId: TEST_ORG, taskId: TASK, outcome: "merged", requestId: "r" }))).result).toBe("reflected");
    expect(w.learn).toHaveBeenCalledTimes(1);
  });

  it("F2: every result line says whether the message was a human edit or a reflection (fixed words), whatever the class; so an operator can tell them apart in the dead-letter queue", async () => {
    const w = setup();
    const kinds = () => w.logs.filter((l) => l.event === "lessons_worker.result").map((l) => `${String(l.fields["kind"])}:${String(l.fields["class"])}`);
    await runReflectMessage(w.deps, bodyOf());
    await runReflectMessage(w.deps, bodyOf(job(), "req-2"));
    await runReflectMessage(w.deps, JSON.stringify({ orgId: TEST_ORG, taskId: TASK, outcome: "merged", requestId: "r" }));
    await runReflectMessage({ ...w.deps, humanEdit: undefined }, bodyOf(job({ headSha: hex(9) })));
    expect(kinds()).toEqual(["human_edit:reflected", "human_edit:already", "reflection:reflected", "human_edit:human_edit_unavailable"]);
    // The kind carries no person or text: only the two words.
    expect(JSON.stringify(w.logs)).not.toContain("withRetry");
  });

  it("MONEY: a redelivery after a model call started is never run again, whether the call failed, the worker died or the lease ran out (callStartedAt)", async () => {
    // The call started (the lease is marked) and the model failed: the attempt is a fault with no `final` note, so the message comes back...
    const failed = setup({ model: new MarkingModel([new Error("provider timeout")]) });
    const first = await runReflectMessage(failed.deps, bodyOf());
    expect(first.retry).toBe(true);
    expect(failed.model.calls).toHaveLength(1);
    expect(failed.lease()).toMatchObject({ leaseState: "retry" });
    expect(typeof failed.lease()!["callStartedAt"]).toBe("number");
    // ...and the next delivery finds the mark: spent, nothing is run, nothing is paid.
    failed.tick(120_000);
    failed.model.replies.push(reply(candidateJson({ type: "convention", evidenceSpanIds: ["S1"], citations: [{ kind: "pr", url: LINK }] })));
    expect(await runReflectMessage(failed.deps, bodyOf(job(), "req-2"))).toEqual({ result: "already", retry: false });
    expect(failed.model.calls).toHaveLength(1);
    expect(failed.runs).toHaveLength(1);
    expect(failed.lease()).toMatchObject({ leaseState: "spent" });
    // A worker that died mid-call: the lease is `running` past its time, with the mark. Same answer.
    const died = setup();
    await died.deps.claims.take({ orgId: TEST_ORG, taskId: TASK, outcome: humanEditLeaseOutcome({ headSha: hex(2) }) }, 1_000_000).then(async (taken) => {
      if (taken.kind !== "taken") throw new Error("expected a lease");
      await died.deps.claims.markCallStarted(taken.lease, 1_000_001);
    });
    died.tick(10 * 60_000);
    expect(await runReflectMessage(died.deps, bodyOf())).toEqual({ result: "already", retry: false });
    expect(died.model.calls).toHaveLength(0);
    expect(died.runs).toHaveLength(0);
  });

  it("a fault from BEFORE any model call (the host did not answer) is retried, and the retry runs it; the model is called once in all", async () => {
    let failing = true;
    const w = setup({ readFails: () => failing });
    const first = await runReflectMessage(w.deps, bodyOf());
    expect(first).toEqual({ result: "not_reflected", retry: true });
    expect(w.model.calls).toHaveLength(0);
    expect(w.lease()).toMatchObject({ leaseState: "retry", attempt: 1 });
    expect(w.lease()!["callStartedAt"]).toBeUndefined();
    failing = false;
    expect(await runReflectMessage(w.deps, bodyOf())).toEqual({ result: "reflected", retry: false });
    expect(w.lease()).toMatchObject({ leaseState: "done", attempt: 2 });
    expect(w.model.calls).toHaveLength(1);
    // The attempts are capped like a reflection's.
    expect(LESSONS_REFLECT_MAX_ATTEMPTS).toBe(3);
  });

  it("a final fault the model path noted (a call that may have been billed) is not retried at all", async () => {
    const w = setup({ model: new (class extends MarkingModel { override async complete(request: Parameters<ScriptedModel["complete"]>[0]) { try { return await super.complete(request); } finally { const a = currentLearningAttempt(); if (a !== undefined) a.fault = "final"; } } })([new Error("provider 500")]) });
    expect(await runReflectMessage(w.deps, bodyOf())).toEqual({ result: "not_reflected", retry: false });
    expect(w.lease()).toMatchObject({ leaseState: "done" });
  });

  it("learning Off (or Collect) reads nothing from the host and calls no model; the lease is ended", async () => {
    const w = setup({ mode: "Off" });
    expect(await runReflectMessage(w.deps, bodyOf())).toEqual({ result: "off", retry: false });
    expect(w.runs).toHaveLength(0);
    expect(w.model.calls).toHaveLength(0);
    expect(w.lease()).toMatchObject({ leaseState: "done" });
  });

  it("ERASURE and OUTSIDERS still hold: an erased author, an outsider among the authors, or an edit by a crowd makes no model call and keeps nothing", async () => {
    const cases: Array<[string, Parameters<typeof setup>[0]]> = [["erased", { erased: ["rae"] }], ["outsider", { outsiders: ["sam"], authors: ["rae", "sam"] }], ["crowd", { authors: ["a", "b", "c", "d", "e", "f"] }]];
    for (const [name, over] of cases) {
      const w = setup(over);
      expect((await runReflectMessage(w.deps, bodyOf())).retry, name).toBe(false);
      expect(w.runs, name).toHaveLength(1);
      expect(w.model.calls, name).toHaveLength(0);
      expect(await w.store.list({ workspaceId: TEST_ORG, project: PROJECT }), name).toEqual([]);
    }
    // Positive control: the same job with live members does reach the model.
    const live = setup();
    await runReflectMessage(live.deps, bodyOf());
    expect(live.model.calls).toHaveLength(1);
  });

  it("the deadline is the reflection's: no draft is started once the signal is aborted, and the model is called under the attempt (its lease mark is written first)", async () => {
    const w = setup({}, { deadlineMs: 5_000 });
    const seen: Array<{ deadlineAt: number; signal: boolean; marked: boolean }> = [];
    const f = fixture({ model: new (class extends MarkingModel { override async complete(request: Parameters<ScriptedModel["complete"]>[0]) { const r = await super.complete(request); const a = currentLearningAttempt(); seen.push({ deadlineAt: a!.deadlineAt, signal: a!.signal !== undefined, marked: true }); return r; } })([reply(candidateJson({ type: "convention", evidenceSpanIds: ["S1"], citations: [{ kind: "pr", url: LINK }] }))]) });
    w.deps.humanEdit = (j) => learnFromHumanEdit({ run: f.run, settings: f.settings }, j);
    expect((await runReflectMessage(w.deps, bodyOf())).result).toBe("reflected");
    expect(seen).toEqual([{ deadlineAt: 1_005_000, signal: true, marked: true }]);
    expect(typeof w.lease()!["callStartedAt"]).toBe("number");
  });

  it("a worker without the human-edit handler does not drop the message: it comes back (and ends in the dead-letter queue, which alarms), and no lease is taken", async () => {
    const w = setup();
    delete w.deps.humanEdit;
    expect(await handleReflectBatch(w.deps, { Records: [{ messageId: "m1", body: bodyOf() }] })).toEqual({ batchItemFailures: [{ itemIdentifier: "m1" }] });
    expect(w.lease()).toBeUndefined();
    expect(w.classes()).toEqual(["human_edit_unavailable"]);
  });

  it("an invalid message is dropped like any poison message; a reflection message is still four ids", async () => {
    const w = setup();
    expect(await runReflectMessage(w.deps, JSON.stringify({ ...humanEditMessageOf(job(), "r"), patch: "+x" }))).toEqual({ result: "invalid", retry: false });
    expect(w.runs).toHaveLength(0);
  });
});

describe("learnFromHumanEdit", () => {
  it("never throws; a thrown fault is a retry only while the model path has not called it final", async () => {
    const boom = learnFromHumanEdit({ run: async () => { throw new Error("x"); }, settings: settings({ mode: "On" }) }, job());
    // Outside a worker nothing is retried.
    expect(await boom).toEqual({ status: "not_reflected", retry: false });
    expect(await learnFromHumanEdit({ run: async () => "skipped", settings: settings({ mode: "On" }) }, job())).toEqual({ status: "no_facts", retry: false });
    expect(await learnFromHumanEdit({ run: async () => "handed_on", settings: settings({ mode: "On" }) }, job())).toEqual({ status: "reflected", retry: false });
  });
});

describe("the extractor and the attempt", () => {
  const inAttempt = <T>(fault: "retryable" | "final" | undefined, work: () => Promise<T>) => withLearningAttempt({ deadlineAt: Date.now() + 10_000, ...(fault === undefined ? {} : { fault }) }, work);
  it("a spend look that could not be read (retryable: nothing held or sent) throws so the lease can try again; a refusal that will not change is quiet; no model is called either way", async () => {
    const f = fixture();
    f.reflectSpend.admitted = false;
    await expect(inAttempt("retryable", () => f.extractor.extract(inputOf(job(), ["rae"])))).rejects.toThrow();
    expect(await inAttempt(undefined, () => f.extractor.extract(inputOf(job(), ["rae"])))).toEqual({ candidates: 0 });
    expect(await f.extractor.extract(inputOf(job(), ["rae"]))).toEqual({ candidates: 0 });
    expect(f.model.calls).toHaveLength(0);
  });
  it("no draft is started once the attempt's signal is aborted (the model was paid for; what is cut is lost, never repeated)", async () => {
    const controller = new AbortController();
    const f = fixture({ model: new (class extends MarkingModel { override async complete(request: Parameters<ScriptedModel["complete"]>[0]) { const r = await super.complete(request); controller.abort(); return r; } })([reply(candidateJson({ type: "convention", evidenceSpanIds: ["S1"], citations: [{ kind: "pr", url: LINK }] }))]) });
    const out = await withLearningAttempt({ deadlineAt: Date.now() + 10_000, signal: controller.signal }, () => f.extractor.extract(inputOf(job(), ["rae"])));
    expect(out).toEqual({ candidates: 0 });
    expect(f.model.calls).toHaveLength(1);
    expect(await f.store.list({ workspaceId: TEST_ORG, project: PROJECT })).toEqual([]);
  });
});
