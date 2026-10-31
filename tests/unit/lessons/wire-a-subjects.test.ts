// Wiring lane A, LR-W1: the reflector subject of a finished task carries the real initiator, reverter and send-back actors, so send-backs and reverts count as measured outcomes
// (and a person's own never does); and a lesson-set rollback runs the normal tier check again on every restored lesson.
import { describe, expect, it } from "vitest";
import { rollbackLessonSetSettled } from "../../../packages/broker/src/lessons/rollback.js";
import type { ApproveDeps } from "../../../packages/broker/src/lessons/approve.js";
import type { ProcessDeps } from "../../../packages/broker/src/lessons/process.js";
import { reflectSubject } from "../../../packages/broker/src/lessons/reflect.js";
import { NO_REASON_TEXT, buildTaskReflectSubject, taskStartActor, type TaskSubjectFacts } from "../../../packages/broker/src/lessons/task-subject.js";
import { InMemoryLessonStore } from "../../../packages/broker/src/lessons/store.js";
import { Alerts, Audit, BASE, Clock, KEY, MERGED, MemoryVectors, PROJECT, ScriptedModel, Spend, WS, allowAllAccess, autoSettings, candidateJson, directory, draft, embedder, facts, lessonRecord, memberSpan, reply, seed, settings, verifier } from "./lesson-helpers.js";

const base = (over: Partial<TaskSubjectFacts> = {}): TaskSubjectFacts => ({
  workspaceId: WS, project: PROJECT, taskId: "task-1", repositories: ["api"], baseCommit: BASE, mergedCommit: MERGED, outcome: "merged",
  task: { developerId: "creator", startedBy: { developerId: "starter" }, agent: { agentId: "a" } }, sendBacks: [],
  rest: { initiatorTrust: "member", steeringTrust: ["member"], intentTrust: "member", links: ["https://github.com/acme/api/pull/7"], spans: [memberSpan("Use withRetry for HTTP retries in api.", { eventId: "ev-p" })] },
  ...over,
});
const reflect = (facts: TaskSubjectFacts) => reflectSubject(
  { model: new ScriptedModel([reply(candidateJson({ type: "fact", evidenceSpanIds: ["S1"] }))]), spend: new Spend(), audit: new Audit(), settings: settings(), edition: "public", now: new Clock().now },
  buildTaskReflectSubject(facts));
const measured = async (facts: TaskSubjectFacts): Promise<boolean | undefined> => (await reflect(facts)).drafts[0]?.provenance.measured;

describe("who started the task", () => {
  it("is the record's startedBy; an agent run with none names nobody; a task from before agent runs was started by its creator", () => {
    expect(taskStartActor({ developerId: "creator", startedBy: { developerId: " starter " }, agent: {} })).toBe("starter");
    expect(taskStartActor({ developerId: "creator", agent: {} })).toBeUndefined();
    expect(taskStartActor({ developerId: "creator" })).toBe("creator");
    expect(taskStartActor({ developerId: "creator", startedBy: { developerId: "  " } })).toBeUndefined();
  });
});

describe("the subject carries the real ids", () => {
  it("initiatorId comes from the task record, revertedBy only for a reverted task, and neither is ever taken from rest", () => {
    const subject = buildTaskReflectSubject(base({ outcome: "reverted", revert: { actorDeveloperId: " rita " } }));
    expect(subject).toMatchObject({ kind: "task", id: "task-1", initiatorId: "starter", revertedBy: "rita", outcome: "reverted" });
    expect(buildTaskReflectSubject(base({ outcome: "merged", revert: { actorDeveloperId: "rita" } })).revertedBy).toBeUndefined();
    expect(buildTaskReflectSubject(base({ outcome: "reverted" })).revertedBy).toBeUndefined();
    const sneaky = buildTaskReflectSubject({ ...base(), rest: { ...base().rest, initiatorId: "evil", revertedBy: "evil" } as never });
    expect(sneaky.initiatorId).toBe("starter");
    expect(sneaky.revertedBy).toBeUndefined();
  });
  it("a human send-back becomes a send_back span by that person; an automatic one adds no span", () => {
    const subject = buildTaskReflectSubject(base({ sendBacks: [
      { id: "sb1", origin: "human", actorDeveloperId: "sam", actorTrust: "member", reasonText: "use the shared helper" },
      { id: "sb2", origin: "human", actorDeveloperId: "sam", actorTrust: "member" },
      { id: "sb3", origin: "automatic" },
      { id: "sb4", origin: "human", reasonText: "who am I" },
    ] }));
    const backs = subject.spans.filter((s) => s.kind === "send_back");
    expect(backs.map((s) => [s.eventId, s.authorId, s.trust, s.text])).toEqual([
      ["sb1", "sam", "member", "use the shared helper"], ["sb2", "sam", "member", NO_REASON_TEXT], ["sb4", undefined, "outsider", "who am I"],
    ]);
  });
});

describe("send-backs and reverts now count as measured outcomes, through the reflector", () => {
  it("a send-back by a third person is measured; by the initiator, by the lesson's own author, or by nobody known is not", async () => {
    expect(await measured(base({ sendBacks: [{ id: "sb1", origin: "human", actorDeveloperId: "sam", actorTrust: "member", reasonText: "use the shared helper" }] }))).toBe(true);
    expect(await measured(base({ sendBacks: [{ id: "sb1", origin: "human", actorDeveloperId: "starter", actorTrust: "member", reasonText: "use the shared helper" }] }))).toBe(false);
    expect(await measured(base({ sendBacks: [{ id: "sb1", origin: "human", actorDeveloperId: "ann", actorTrust: "member", reasonText: "use the shared helper" }] }))).toBe(false);
    expect(await measured(base({ sendBacks: [{ id: "sb1", origin: "human", reasonText: "use the shared helper" }] }))).toBe(false);
    expect(await measured(base({ sendBacks: [{ id: "sb1", origin: "automatic" }] }))).toBe(false);
  });
  it("a send-back is not measured for a task nobody started (no initiator): fail closed", async () => {
    expect(await measured(base({ task: { developerId: "creator", agent: {} }, sendBacks: [{ id: "sb1", origin: "human", actorDeveloperId: "sam", actorTrust: "member", reasonText: "use the shared helper" }] }))).toBe(false);
  });
  it("a revert by a third person is measured; by the starter, by the author, or with no known person is not; a case difference cannot fake independence", async () => {
    expect(await measured(base({ outcome: "reverted", revert: { actorDeveloperId: "rita" } }))).toBe(true);
    expect(await measured(base({ outcome: "reverted", revert: { actorDeveloperId: "Starter" } }))).toBe(false);
    expect(await measured(base({ outcome: "reverted", revert: { actorDeveloperId: "ANN" } }))).toBe(false);
    expect(await measured(base({ outcome: "reverted", revert: {} }))).toBe(false);
    expect(await measured(base({ outcome: "reverted" }))).toBe(false);
  });
});

describe("rollback runs the tier check again on every restored lesson", () => {
  async function rollback() {
    const store = new InMemoryLessonStore();
    const clock = new Clock();
    const check = verifier("valid");
    const v1 = lessonRecord({ id: "les_rb000001", tier: 0, type: "fact", approvals: [{ approvalId: "a0", by: "bob", at: 1, mode: "one" }], provenance: { ...draft().provenance, authors: ["carl"], measured: true } });
    await seed(store, v1);
    await seed(store, { ...v1, version: 2, citations: [{ ...v1.citations[0]!, startLine: 40, endLine: 50 } as never] });
    let n = 0;
    const deps: ApproveDeps & ProcessDeps = {
      access: allowAllAccess, store, directory: directory(), settings: autoSettings(), audit: new Audit(), now: clock.now, embedder, vectors: new MemoryVectors(), judgeModel: new ScriptedModel(),
      spend: new Spend(), alerts: new Alerts(), verifier: check, facts: facts(), newId: () => `les_x${++n}`,
    };
    const out = await rollbackLessonSetSettled(deps, { ...KEY, targetSetVersion: 1, actorId: "owner" });
    return { out, store, check };
  }
  it("each restored lesson is verified and tiered again, and never goes live by itself under an auto policy", async () => {
    const { out, store, check } = await rollback();
    expect(out).toMatchObject({ ok: true, restored: ["les_rb000001"] });
    expect(check.calls).toBeGreaterThan(0);
    const lesson = (await store.get(KEY, "les_rb000001"))!;
    expect(lesson.reviewRequired).toBe(true);
    expect(lesson.approvals.some((a) => a.mode === "auto")).toBe(false);
  });
});
