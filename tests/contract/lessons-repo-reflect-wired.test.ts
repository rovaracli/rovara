// Lessons in the repo, lane R1b (decision 50c): the WIRED path from a merged task's end to a repo-only lesson in the Dynamo store. The real task-end handler sends ids to the queue, the queue's consumer is the real reflect
// worker (lease, deadline) running `learnFromEndedTaskTyped` with the PRODUCTION subject source (`lessonSubjectSource`) over a fake task table, the runtime the broker builds (`createLessonsRuntime`) stores the drafts.
// Mutation checks (done by hand, see the lane's report): a forbidden input added to the repo-only prompt fails the prompt test; the once-key removed fails the redelivery test; the gate removed fails the switch-off test.
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { lessonSubjectSource, type PullRequestFeedbackView } from "../../packages/broker/src/aws/broker/lesson-subject-source.js";
import { taskKey, taskOwnerKey } from "../../packages/broker/src/developer/task-records.js";
import type { CapturedWords } from "../../packages/broker/src/lessons/captured-rows.js";
import { setLearnedLessonsGate } from "../../packages/broker/src/lessons/policy.js";
import type { PipelineModel } from "../../packages/broker/src/lessons/ports.js";
import { dynamoPauseStore } from "../../packages/broker/src/lessons/pause.js";
import { dynamoReflectClaims } from "../../packages/broker/src/lessons/reflect-claims.js";
import type { ReflectQueue, ReflectQueueMessage } from "../../packages/broker/src/lessons/reflect-queue.js";
import { handleReflectBatch } from "../../packages/broker/src/lessons/reflect-worker.js";
import { createLessonsRuntime } from "../../packages/broker/src/lessons/runtime.js";
import { learnFromEndedTaskTyped, learningTaskEndHandler, type TaskLearningDeps } from "../../packages/broker/src/lessons/task-end.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { PROJECT, WS, allowAllAccess } from "../unit/lessons/lesson-helpers.js";

afterEach(() => { setLearnedLessonsGate(undefined); });

const KEY = { workspaceId: WS, project: PROJECT };
const T0 = 1_800_000_000_000;
const TASK = randomUUID();
const CREATOR = "creator-1";
const PR = "https://github.com/acme/api/pull/7";
const HEAD = "d".repeat(40);
const PLACE = "github:repo/9";
const INTENT = "Make the retries use withRetry";
const REPO_SYSTEM = "one repository's own review";

const taskRecord = () => ({
  ...taskKey(TASK), entityType: "DEVELOPER_TASK", taskId: TASK, orgId: WS, project: PROJECT, developerId: CREATOR, developerName: "Creator", provider: "oidc", client: "web",
  requestText: INTENT, title: "Retries", agent: { agentId: "a" }, startedBy: { developerId: CREATOR }, ownerKey: taskOwnerKey(CREATOR, TASK),
  workflow: {
    schemaVersion: 1, definitionId: "agentx-task-to-pr", definitionVersion: "1.0.0", taskId: TASK, ownerId: taskOwnerKey(CREATOR, TASK), revision: 3, stage: "WAIT_FOR_MERGE", state: "COMPLETE", outcome: "MERGED",
    createdAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-01T00:00:00.000Z", artifacts: [], decisions: [],
    pullRequests: [{ repositoryId: "api", number: 7, url: PR, candidateDigest: "b".repeat(64), required: true, state: "MERGED" }],
  },
});
const words = (id: string, who: string, text: string): CapturedWords => ({ id, authorDeveloperId: who, authorSourceId: `acct-${who}`, source: "github", ownText: true, text, audience: { kind: "project" }, scope: PLACE });

const candidate = (title: string, body: string) => ({ type: "convention", title, description: body, body, scope: { repos: ["api"], paths: ["src/**"] }, stages: ["IMPLEMENT"], citations: [], evidenceSpanIds: ["S1"] });

class World {
  now = T0;
  comments: Record<string, CapturedWords> = { "review_comment:11": words("acme/api#pr7:review_comment11", "rae", "Use withRetry for HTTP retries in api, not a hand-rolled loop.") };
  feedback: PullRequestFeedbackView = { comments: [{ kind: "review_comment", id: "11" }], headRevision: HEAD, title: "Retries use withRetry", body: "Moves the retries.\n\n## Lessons used\nRovara used 1 lesson." };
  mode: "Off" | "Collect" | "Suggest" | "On" = "On";
  calls: Array<{ purpose: string; repoOnly: boolean; system: string; user: string; maxHoldUsd?: number }> = [];
  private readonly tasks = new FakeDynamoDb();
  private readonly record = new FakeDynamoDb({ indexKeys: { gsi1: { partition: "gsi1pk" }, gsi2: { partition: "gsi2pk" }, gsi3: { partition: "gsi3pk", sort: "gsi3sk" }, gsi4: { partition: "gsi4pk" }, gsi5: { partition: "gsi5pk", sort: "textDueAt" } } });
  private readonly state = new FakeDynamoDb();
  readonly table = { documentClient: this.record, tableName: "record" };
  readonly runtime;
  readonly learning: TaskLearningDeps;

  constructor() {
    this.tasks.set(taskRecord());
    const pause = dynamoPauseStore(this.table, () => this.now);
    const model: PipelineModel = {
      quote: async () => ({ ok: true, usd: 0.01 }),
      complete: async (request) => {
        const repoOnly = request.system.includes(REPO_SYSTEM);
        this.calls.push({ purpose: request.purpose, repoOnly, system: request.system, user: request.user, ...(request.maxHoldUsd === undefined ? {} : { maxHoldUsd: request.maxHoldUsd }) });
        // The curator's judge rides the same model (a different purpose): it answers a duplicate question, not a reflection.
        if (request.purpose !== "reflect") return { text: JSON.stringify({ verdict: "different", rating: "unrelated" }), costUsd: 0.001, model: "judge-model" };
        const text = JSON.stringify({ candidates: [repoOnly ? candidate("Retries go through withRetry", "Reviewers ask that HTTP retries in api use withRetry, not a hand-rolled loop.") : candidate("Name the retry helper", "The first reflection learned that the retry helper is named withRetry in api.")] });
        return { text, costUsd: 0.01, model: "reflect-model" };
      },
    };
    this.runtime = createLessonsRuntime({
      table: this.table, now: () => this.now, reader: { file: async () => undefined }, repositoriesOf: async () => ["api"], pause, model, spend: { admit: async () => true, look: async () => "ok" }, edition: "public",
      audit: async () => undefined, evidence: { documentClient: this.record, tableName: "state", signInTableName: "signin", now: () => this.now }, linkedAccounts: async () => [], taskVisibility: allowAllAccess.taskVisibility,
      names: { memberName: async () => "x", isErased: async () => false },
    });
    const settings = { read: async () => ({ mode: this.mode, preset: "standard" as const }) };
    const source = lessonSubjectSource({
      documentClient: this.tasks, tableName: "tasks", repositoriesOf: async () => ["api"], standing: async () => "member", isErased: async () => false, visibility: async () => ({ kind: "shared" }), now: () => this.now,
      captured: { rememberedNote: async () => undefined, pullRequestWords: async ({ surface, commentId }) => this.comments[`${surface}:${commentId}`] }, rememberedNoteIds: async () => [], sourceExcluded: async () => false,
      pullRequestFeedback: async () => this.feedback,
    });
    this.learning = {
      source, rows: { sendBack: async () => undefined, revertedBy: async () => undefined }, settings,
      reflect: { model, spend: { admit: async () => true }, audit: this.runtime.routes.audit, settings, edition: "public", now: () => this.now, pause },
      process: { ...this.runtime.routes, settings },
    };
  }

  readonly queue: ReflectQueue = {
    send: async (message: ReflectQueueMessage) => {
      const claims = dynamoReflectClaims({ documentClient: this.state, tableName: "state", keysOutcome: async () => "clear" });
      const result = await handleReflectBatch({ claims, learn: (request) => learnFromEndedTaskTyped(this.learning, request), now: () => this.now, deadlineMs: 60_000, log: () => undefined }, { Records: [{ messageId: `m-${Math.random()}`, body: JSON.stringify(message) }] });
      expect(result.batchItemFailures).toEqual([]);
    },
  };
  async end(outcome: "merged" | "closed" = "merged"): Promise<void> {
    await learningTaskEndHandler(() => ({ queue: this.queue }))({} as never, { orgId: WS, taskId: TASK, outcome, runLimitUsd: 1, spentUsd: 0 });
  }
  repoCalls = () => this.calls.filter((call) => call.purpose === "reflect" && call.repoOnly);
  mainCalls = () => this.calls.filter((call) => call.purpose === "reflect" && !call.repoOnly);
  lessons = async () => this.runtime.store.list(KEY);
}

describe("a merged task's pull request is reflected on a second time, over the repository's own words, through the real task-end path into the Dynamo store", () => {
  it("a merged pull request with a member's review comment: one repo-only call, and its lesson is repo-only for that repository; the task's own reflection is unchanged", async () => {
    const w = new World();
    await w.end();
    expect(w.repoCalls()).toHaveLength(1);
    expect(w.mainCalls()).toHaveLength(1);
    const lessons = await w.lessons();
    expect(lessons).toHaveLength(2);
    const repo = lessons.find((lesson) => lesson.title === "Retries go through withRetry")!;
    const main = lessons.find((lesson) => lesson.title === "Name the retry helper")!;
    expect(repo.provenance.repoOnly).toEqual({ place: PLACE });
    expect(repo.provenance.repoBlockCodes).toBeUndefined();
    expect(repo.provenance.sourceKinds).toEqual(["pr_comment"]);
    // The task's own reflection still sees the task (its text, its start) and is not repo-only: it was never changed.
    expect(main.provenance.repoOnly).toBeUndefined();
    expect(main.provenance.repoBlockCodes).toEqual(["task_inputs_unproved", "intent_not_repo"]);
    expect(w.mainCalls()[0]!.user).toContain(INTENT);
  });

  it("the repo-only prompt holds the repository's comment, the merge fact, the link and the title and description, and none of the task's own text", async () => {
    const w = new World();
    await w.end();
    const { user, system } = w.repoCalls()[0]!;
    expect(user).toContain("Use withRetry for HTTP retries in api, not a hand-rolled loop.");
    expect(user).toContain("Retries use withRetry");
    expect(user).toContain("Moves the retries.");
    expect(user).toContain(PR);
    expect(user).toContain("outcome merged");
    expect(user).not.toContain(INTENT);
    expect(user).not.toContain("Lessons used");
    expect(user).not.toMatch(/kind=(intent|plan|send_back|remembered|loaded_lesson|review_finding|ci_failure)/u);
    expect(system).toMatch(/<<span [0-9a-f]{16} \.\.\.>>/u);
  });

  it("the repo-only call is paid by the task's one Public cap: it is asked to hold at most what the first reflection left", async () => {
    const w = new World();
    await w.end();
    expect(w.mainCalls()[0]!.maxHoldUsd).toBeCloseTo(0.15, 6);
    expect(w.repoCalls()[0]!.maxHoldUsd).toBeCloseTo(0.14, 6);
  });

  it("switch off (and unreadable) and the modes Off and Collect: zero calls of any kind and nothing stored", async () => {
    for (const gate of [() => false, () => { throw new Error("unreadable"); }]) {
      setLearnedLessonsGate(gate);
      const w = new World();
      await w.end();
      expect(w.calls).toEqual([]);
      expect(await w.lessons()).toEqual([]);
    }
    setLearnedLessonsGate(undefined);
    for (const mode of ["Off", "Collect"] as const) {
      const w = new World();
      w.mode = mode;
      await w.end();
      expect(w.calls, mode).toEqual([]);
    }
  });

  it("no repository-visible correction: no repo-only call (no comment at all, or praise only), and the task's own reflection still runs", async () => {
    const none = new World();
    none.feedback = { ...none.feedback, comments: [] };
    await none.end();
    expect(none.repoCalls()).toEqual([]);
    expect(none.mainCalls()).toHaveLength(1);
    const praise = new World();
    praise.comments = { "review_comment:11": words("acme/api#pr7:review_comment11", "rae", "LGTM, nice work") };
    await praise.end();
    expect(praise.repoCalls()).toEqual([]);
    expect(praise.mainCalls()).toHaveLength(1);
  });

  it("a task that did not merge makes no repo-only call", async () => {
    const w = new World();
    await w.end("closed");
    expect(w.repoCalls()).toEqual([]);
  });

  it("a redelivery makes no second call: the worker's lease stops the whole message, and below the lease the once-key stops the repo-only call", async () => {
    const w = new World();
    await w.end();
    await w.end();
    expect(w.repoCalls()).toHaveLength(1);
    expect(w.mainCalls()).toHaveLength(1);
    // Past the lease (the first reflection has no key of its own): the once-key per task and head is the only lock on the repo-only call.
    await learnFromEndedTaskTyped(w.learning, { workspaceId: WS, taskId: TASK });
    expect(w.mainCalls()).toHaveLength(2);
    expect(w.repoCalls()).toHaveLength(1);
  });
});
