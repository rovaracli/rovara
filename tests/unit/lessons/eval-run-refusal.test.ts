// Lane 7 (0.5.12, DECISIONS 38/49): an eval or replay run NEVER feeds learning. Lessons learn only from historical outcomes. The task record carries a marker; every learning path (the task-end reflection, the
// human-edit reflection, the nightly re-reflection, the outcome judge and the counters, and any later repo-only reflection) refuses a marked task before it calls a model, spends, or writes.
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { lessonSubjectSource } from "../../../packages/broker/src/aws/broker/lesson-subject-source.js";
import { taskKey, taskOwnerKey } from "../../../packages/broker/src/developer/task-records.js";
import { isEvalRunMark } from "../../../packages/broker/src/lessons/eval-run.js";
import { createHumanEditExtractor, type HumanEditExtractorDeps } from "../../../packages/broker/src/lessons/human-edit.js";
import { recordTaskOutcome } from "../../../packages/broker/src/lessons/counters.js";
import { reflectNightly } from "../../../packages/broker/src/lessons/reflect-nightly.js";
import { reflectSubject } from "../../../packages/broker/src/lessons/reflect.js";
import type { ProcessDeps } from "../../../packages/broker/src/lessons/process.js";
import { InMemoryLessonStore } from "../../../packages/broker/src/lessons/store.js";
import { learnFromEndedTask, learnFromEndedTaskTyped, type TaskLearningDeps, type TaskSubjectBase } from "../../../packages/broker/src/lessons/task-end.js";
import type { OutcomeRowReader } from "../../../packages/broker/src/lessons/task-outcome-rows.js";
import { FakeDynamoDb } from "../../support/fake-dynamodb.js";
import { Alerts, Audit, BASE, Clock, Judge, KEY, MERGED, MemoryVectors, PROJECT, ScriptedModel, Spend, WS, candidateJson, embedder, facts, lessonRecord, memberSpan, reply, seed, settings, verifier } from "./lesson-helpers.js";

const LINK = "https://github.com/acme/api/pull/7";
const baseFacts = (rest: Record<string, unknown> = {}): TaskSubjectBase["facts"] => ({
  workspaceId: WS, project: PROJECT, taskId: "task-1", repositories: ["api"], baseCommit: BASE, mergedCommit: MERGED, outcome: "merged",
  task: { developerId: "creator", startedBy: { developerId: "starter" }, agent: { agentId: "a" } },
  rest: { initiatorTrust: "member", steeringTrust: ["member"], intentTrust: "member", links: [LINK], spans: [memberSpan("Use withRetry for HTTP retries in api.", { eventId: "ev-p" })], ...rest },
});

class Rows implements OutcomeRowReader {
  asked: string[] = [];
  async sendBack(input: { requestId: string }): Promise<undefined> { this.asked.push(`sendback:${input.requestId}`); return undefined; }
  async revertedBy(): Promise<undefined> { this.asked.push("reverted_by"); return undefined; }
}

function world(rest: Record<string, unknown> = {}) {
  const store = new InMemoryLessonStore();
  const audit = new Audit();
  const clock = new Clock();
  const model = new ScriptedModel([reply(candidateJson({ type: "fact", evidenceSpanIds: ["S1"] }))]);
  const judgeModel = new ScriptedModel();
  const spend = new Spend();
  const rows = new Rows();
  const configured = settings({ mode: "On" });
  const base: TaskSubjectBase = { facts: baseFacts(rest), sendBackRequestIds: ["req-1"] };
  const process: ProcessDeps = {
    store, embedder, vectors: new MemoryVectors(), judgeModel, spend, audit, alerts: new Alerts(), now: clock.now,
    verifier: verifier("valid"), facts: facts(), settings: configured, newId: (() => { let n = 0; return () => `les_${String(++n).padStart(4, "0")}`; })(),
  };
  const reflect = { model, spend, audit, settings: configured, edition: "public" as const, now: clock.now, newId: () => "run-1" };
  const deps: TaskLearningDeps = { source: { read: async () => base }, rows, settings: configured, reflect, process };
  return { deps, store, model, judgeModel, spend, rows, audit, reflect, process, configured, base };
}

describe("the marker", () => {
  it("absent or false is a real task; anything else, even a malformed value, is an eval run (fail closed)", () => {
    for (const real of [undefined, false, null]) expect(isEvalRunMark(real), String(real)).toBe(false);
    for (const marked of [true, "yes", "false", 1, 0, {}, []]) expect(isEvalRunMark(marked), JSON.stringify(marked)).toBe(true);
  });
});

describe("the production task source", () => {
  const TASK = randomUUID();
  const record = (over: Record<string, unknown> = {}) => ({
    ...taskKey(TASK), entityType: "DEVELOPER_TASK", taskId: TASK, orgId: WS, project: PROJECT, developerId: "creator-1", developerName: "Creator", provider: "oidc", client: "web",
    requestText: "Make the retries use withRetry", title: "Retries", agent: { agentId: "a" }, startedBy: { developerId: "starter-1" }, ownerKey: taskOwnerKey("creator-1", TASK),
    workflow: { schemaVersion: 1, definitionId: "agentx-task-to-pr", definitionVersion: "1.0.0", taskId: TASK, ownerId: taskOwnerKey("creator-1", TASK), revision: 3, stage: "WAIT_FOR_MERGE", state: "COMPLETE", outcome: "SUCCEEDED",
      createdAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-01T00:00:00.000Z", artifacts: [], decisions: [], reviewBase: [{ repositoryId: "api", baseCommitSha: "a".repeat(40) }], pullRequests: [] },
    ...over,
  });
  const source = (over: Record<string, unknown>) => {
    const db = new FakeDynamoDb();
    db.set(record(over));
    return lessonSubjectSource({ documentClient: db, tableName: "state", repositoriesOf: async () => ["api"], standing: async () => "member", isErased: async () => false, visibility: async () => ({ kind: "shared" }), now: () => 1_800_000_000_000 });
  };
  it("reads a real task (positive control) and nothing at all of a marked one, however the mark is written", async () => {
    const real = source({});
    expect(await real.projectOf!({ workspaceId: WS, taskId: TASK })).toBe(PROJECT);
    expect(await real.read({ workspaceId: WS, taskId: TASK })).toBeDefined();
    for (const mark of [true, "yes", {}]) {
      const marked = source({ evalRun: mark });
      expect(await marked.projectOf!({ workspaceId: WS, taskId: TASK }), JSON.stringify(mark)).toBeUndefined();
      expect(await marked.read({ workspaceId: WS, taskId: TASK }), JSON.stringify(mark)).toBeUndefined();
    }
  });
});

describe("the task-end reflection", () => {
  it("a real task is reflected (positive control)", async () => {
    const w = world();
    expect(await learnFromEndedTask(w.deps, { workspaceId: WS, taskId: "task-1" })).toBe("reflected");
    expect(w.model.calls).toHaveLength(1);
    expect(w.spend.asked.length).toBeGreaterThan(0);
  });
  it("a marked task reads no rows, calls no model, spends nothing, writes no lesson and counts no outcome", async () => {
    const w = world({ evalRun: true });
    const counters = { store: w.store, judge: new Judge(), settings: w.configured, audit: w.audit, alerts: new Alerts(), now: new Clock().now };
    await seed(w.store, lessonRecord());
    const result = await learnFromEndedTaskTyped({ ...w.deps, counters: counters }, { workspaceId: WS, taskId: "task-1" });
    expect(result).toEqual({ status: "eval_run", retry: false });
    expect(w.model.calls).toEqual([]);
    expect(w.judgeModel.calls).toEqual([]);
    expect(counters.judge.calls).toBe(0);
    expect(w.rows.asked).toEqual([]);
    expect(w.spend.asked).toEqual([]);
    expect((await w.store.listAllHeads(KEY)).map((l) => l.id)).toEqual(["les_aaaa1111"]);
    expect((await w.store.get(KEY, "les_aaaa1111"))!.counters).toMatchObject({ helpful: 0, harmful: 0 });
  });
});

describe("the reflector itself", () => {
  it("refuses a marked subject before any model call, for any caller (task end, human edit, nightly, a later repo-only reflection)", async () => {
    const w = world();
    const subject = { kind: "task" as const, id: "task-1", workspaceId: WS, project: PROJECT, repositories: ["api"], baseCommit: BASE, initiatorTrust: "member" as const, steeringTrust: ["member" as const], intentTrust: "member" as const, spans: [memberSpan("Use withRetry for HTTP retries in api.")] };
    expect((await reflectSubject(w.reflect, subject)).status).toBe("ok");
    const second = world();
    expect(await reflectSubject(second.reflect, { ...subject, evalRun: true })).toMatchObject({ status: "ineligible", reason: "eval_run", drafts: [] });
    expect(second.model.calls).toEqual([]);
  });
  it("the nightly re-reflection skips a marked subject", async () => {
    const w = world();
    const subject = { kind: "task" as const, id: "task-1", workspaceId: WS, project: PROJECT, repositories: ["api"], baseCommit: BASE, initiatorTrust: "member" as const, steeringTrust: ["member" as const], intentTrust: "member" as const, evalRun: true, spans: [memberSpan("Use withRetry.")] };
    const drafts: unknown[] = [];
    const report = await reflectNightly(w.reflect, { projects: async () => [PROJECT], subjects: async () => [subject] }, async (_s, d) => { drafts.push(...d); }, { workspaceId: WS, sinceMs: 0 });
    expect(report).toMatchObject({ subjects: 1, reflected: 0, skipped: 1 });
    expect(w.model.calls).toEqual([]);
    expect(drafts).toEqual([]);
  });
});

describe("the human-edit reflection", () => {
  const edit = {
    workspaceId: WS, project: PROJECT, repo: "acme/api", taskId: "task-1", pullRequest: { number: 7, url: LINK }, trust: "member" as const, authorCount: 1, authors: ["rae"],
    files: [{ path: "src/fetch.ts", additions: 1, deletions: 1, symbols: ["function load()"], hunks: ["@@ -1,2 +1,2 @@", "-fetch()", "+await withRetry(() => fetch())"] }],
    link: LINK, audience: { kind: "project" as const }, scope: "github:repo/77",
  };
  const extractor = (w: ReturnType<typeof world>, standing: string[]) => {
    const deps: HumanEditExtractorDeps = { source: { read: async () => w.base }, settings: w.configured, reflect: w.reflect, process: w.process, standing: async (_o, who) => { standing.push(who); return "member"; }, isErased: async () => false };
    return createHumanEditExtractor(deps);
  };
  it("a real task is learned from (positive control); a marked task is refused before the authors are even looked up", async () => {
    const real = world();
    expect(await extractor(real, []).extract(edit)).toEqual({ candidates: 1 });
    const marked = world({ evalRun: true });
    const asked: string[] = [];
    expect(await extractor(marked, asked).extract(edit)).toEqual({ candidates: 0 });
    expect(marked.model.calls).toEqual([]);
    expect(asked).toEqual([]);
  });
});

describe("the outcome judge and the counters", () => {
  it("a marked outcome is not judged, marks nothing and queues nothing", async () => {
    const store = new InMemoryLessonStore();
    const judge = new Judge();
    const deps = { access: undefined as never, store, judge, settings: settings(), audit: new Audit(), alerts: new Alerts(), now: new Clock().now };
    await seed(store, lessonRecord());
    const outcome = { ...KEY, taskId: "task-1", outcome: "merged" as const, sendBacks: 0, mergedAt: 1_800_000_000_000, corrections: [{ kind: "send_back" as const, paths: ["src/a.ts"], text: "use the helper", at: 1, authorId: "dev-ann" }], evalRun: true };
    expect(await recordTaskOutcome(deps as never, outcome)).toEqual({ harmful: [], queuedHelpful: [] });
    expect(judge.calls).toBe(0);
  });
});

describe("every place a lesson model is called is accounted for", () => {
  // A new file that calls a learning model (a repo-only reflection, a consolidation pass) must be added here WITH its refusal of a marked task and a test above. The list is the checklist.
  const ACCOUNTED = {
    "reflect.ts": "the reflector: buildReflectorInput refuses evalRun before the request is built; every reflection (task end, human edit, nightly) goes through reflectSubject",
    "curate.ts": "the curator's judge: only receives drafts, and drafts come only from reflectSubject",
    "draft-retry.ts": "wraps the curator's judge; same drafts",
    "judge-model.ts": "the outcome judge: called only from recordTaskOutcome, which returns first for evalRun, and never reached from task end for a marked task",
    "model-gate.ts": "the install's lessons switch (decision 47), the lock on the model itself",
    "counters.ts": "recordTaskOutcome returns first for evalRun",
  } as const;
  it("the files under lessons/ that call a model are exactly the accounted ones", () => {
    const dir = path.join(process.cwd(), "packages/broker/src/lessons");
    const calling = readdirSync(dir).filter((name) => name.endsWith(".ts")).filter((name) => /\.(complete|quote|rate)\(|model\.complete|judgeModel\./u.test(readFileSync(path.join(dir, name), "utf8").replace(/\/\/.*$/gmu, ""))).filter((name) => !["routes.ts"].includes(name));
    expect(calling.sort()).toEqual(Object.keys(ACCOUNTED).sort());
  });
});
