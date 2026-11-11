// Lessons in the repo, lane R1b: the world of the wired tests (support file). The WIRED path from a merged task's end to a repo-only lesson in the Dynamo store. The real task-end handler sends ids to the queue, the queue's consumer is the real reflect
// worker (lease, deadline) running `learnFromEndedTaskTyped` with the PRODUCTION subject source (`lessonSubjectSource`) and the real capture adapter over a fake code host, the runtime the broker builds
// (`createLessonsRuntime`) stores the drafts, and the real human-edit extractor owns a change request someone pushed to after Rovara.
// Mutation checks (done by hand, see the lane's report): a forbidden input added to the repo-only prompt fails the prompt test; the once-key removed fails the redelivery test; the gate removed fails the switch-off test.
import { randomUUID } from "node:crypto";
import { expect } from "vitest";
import type { ChangeRequestFeedback, CodeHost } from "@rovara-code/contracts";
import { createWorkflowSnapshot } from "../../packages/cloud-contracts/src/task-workflow-node.js";
import { workflowPullRequestBody } from "../../packages/broker/src/aws/developer-tasks.js";
import { rovaraPullRequestBody } from "../../packages/broker/src/rovara-code/pull-request-body.js";
import { lessonSubjectSource } from "../../packages/broker/src/aws/broker/lesson-subject-source.js";
import { taskKey, taskOwnerKey } from "../../packages/broker/src/developer/task-records.js";
import type { CapturedWords } from "../../packages/broker/src/lessons/captured-rows.js";
import { createHumanEditExtractor } from "../../packages/broker/src/lessons/human-edit.js";
import type { PipelineModel } from "../../packages/broker/src/lessons/ports.js";
import { dynamoPauseStore } from "../../packages/broker/src/lessons/pause.js";
import { dynamoReflectClaims } from "../../packages/broker/src/lessons/reflect-claims.js";
import type { ReflectQueue, ReflectQueueMessage } from "../../packages/broker/src/lessons/reflect-queue.js";
import { handleReflectBatch } from "../../packages/broker/src/lessons/reflect-worker.js";
import { createLessonsRuntime } from "../../packages/broker/src/lessons/runtime.js";
import { learnFromEndedTaskTyped, learningTaskEndHandler, type TaskLearningDeps } from "../../packages/broker/src/lessons/task-end.js";
import { captureAdapterOf } from "../../packages/broker/src/team-record/sources/capture-adapters.js";
import type { HumanEditInput } from "../../packages/broker/src/team-record/sources/codehost.js";
import { noteLearningFault } from "../../packages/broker/src/lessons/learning-deadline.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { PROJECT, WS, allowAllAccess } from "../unit/lessons/lesson-helpers.js";
export { PROJECT, WS };


export const KEY = { workspaceId: WS, project: PROJECT };
export const T0 = 1_800_000_000_000;
export const TASK = randomUUID();
const CREATOR = "creator-1";
export const HEAD = "d".repeat(40);
export const PUSHED = "e".repeat(40);
export const MERGE = "f".repeat(40);
export const PLACE = "github:repo/9";
export const INTENT = "Make the retries use withRetry";
export const REPO_SYSTEM = "one repository's own review";
export const SLACK_PLAN = "PLANSUMMARY from the Slack ask: customer Initech wants the Q4 churn export";

/** Descriptions as Rovara's own builders write them (version 1 and version 2): plan summary, status block, names, task link. None of it may reach the repo-only prompt. */
const TASK_ID = "8b579b4b-eaa7-4bf2-87bc-6da86b97c9e6";
const attribution = { requester: { state: "named" as const, name: "Jane Doe", ref: "a".repeat(16) }, approver: { state: "named" as const, name: "John Roe", ref: "b".repeat(16) } };
const snapshot = (definitionVersion: string) => createWorkflowSnapshot({ taskId: TASK_ID, ownerId: "a".repeat(64), now: "2026-10-25T12:00:00.000Z", definitionVersion } as never);
export const V2_BODY = rovaraPullRequestBody({ summary: [SLACK_PLAN], fallbackTitle: "Retries", workflow: snapshot("1.1.0"), context: { attribution }, reviewLines: () => [], pageUrl: "https://app.rovara.example/t/abc" });
export const V1_BODY = workflowPullRequestBody({ title: "Retries" } as never, snapshot("1.0.0"), `${SLACK_PLAN}\nmore`, "https://app.rovara.example/t/abc", { attribution });

export interface Options { prUrl?: string; registeredUrl?: string; pushedHead?: string; mergedHead?: string; body?: string; title?: string; sameText?: boolean; rovaraHeadKnown?: boolean }
export const words = (id: string, who: string, text: string): CapturedWords => ({ id, authorDeveloperId: who, authorSourceId: `acct-${who}`, source: "github", ownText: true, text, audience: { kind: "project" }, scope: PLACE });
const candidate = (title: string, body: string) => ({ type: "convention", title, description: body, body, scope: { repos: ["api"], paths: ["src/**"] }, stages: ["IMPLEMENT"], citations: [], evidenceSpanIds: ["S1"] });

export class World {
  now = T0;
  comments: Record<string, CapturedWords> = { "review_comment:11": words("acme/api#pr7:review_comment11", "rae", "Use withRetry for HTTP retries in api, not a hand-rolled loop.") };
  commentIds: string[] = ["11"];
  mode: "Off" | "Collect" | "Suggest" | "On" = "On";
  outsiders = new Set<string>();
  quoteFailures = 0;
  /** How many of the task's own (non repo-only) reflection calls fail with a model error before one answers. */
  mainFailures = 0;
  calls: Array<{ purpose: string; repoOnly: boolean; system: string; user: string; maxHoldUsd?: number }> = [];
  private readonly opts: Required<Omit<Options, "rovaraHeadKnown">> & { rovaraHeadKnown: boolean };
  private readonly tasks = new FakeDynamoDb();
  private readonly record = new FakeDynamoDb({ indexKeys: { gsi1: { partition: "gsi1pk" }, gsi2: { partition: "gsi2pk" }, gsi3: { partition: "gsi3pk", sort: "gsi3sk" }, gsi4: { partition: "gsi4pk" }, gsi5: { partition: "gsi5pk", sort: "textDueAt" } } });
  private readonly state = new FakeDynamoDb();
  readonly table = { documentClient: this.record, tableName: "record" };
  readonly runtime;
  readonly learning: TaskLearningDeps;

  constructor(options: Options = {}) {
    this.opts = { prUrl: "https://github.com/acme/api/pull/7", registeredUrl: "https://github.com/acme/api", pushedHead: HEAD, mergedHead: HEAD, body: V2_BODY, title: "Retries use withRetry", sameText: false, rovaraHeadKnown: true, ...options };
    this.tasks.set({
      ...taskKey(TASK), entityType: "DEVELOPER_TASK", taskId: TASK, orgId: WS, project: PROJECT, developerId: CREATOR, developerName: "Creator", provider: "oidc", client: "web",
      requestText: INTENT, title: "Retries", agent: { agentId: "a" }, startedBy: { developerId: CREATOR }, ownerKey: taskOwnerKey(CREATOR, TASK),
      workflow: {
        schemaVersion: 1, definitionId: "agentx-task-to-pr", definitionVersion: "1.0.0", taskId: TASK, ownerId: taskOwnerKey(CREATOR, TASK), revision: 3, stage: "WAIT_FOR_MERGE", state: "COMPLETE", outcome: "MERGED",
        createdAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-01T00:00:00.000Z", artifacts: [], decisions: [],
        pullRequests: [{ repositoryId: "api", number: 7, url: this.opts.prUrl, ...(this.opts.rovaraHeadKnown ? { headSha: this.opts.pushedHead } : {}), candidateDigest: "b".repeat(64), required: true, state: "MERGED" }],
      },
    });
    const pause = dynamoPauseStore(this.table, () => this.now);
    const model: PipelineModel = {
      quote: async () => { if (this.quoteFailures > 0) { this.quoteFailures -= 1; throw new Error("quote down"); } return { ok: true, usd: 0.01 }; },
      complete: async (request) => {
        const repoOnly = request.system.includes(REPO_SYSTEM);
        if (request.purpose === "reflect" && !repoOnly && this.mainFailures > 0) { this.mainFailures -= 1; noteLearningFault("retryable"); throw new Error("provider down"); }
        this.calls.push({ purpose: request.purpose, repoOnly, system: request.system, user: request.user, ...(request.maxHoldUsd === undefined ? {} : { maxHoldUsd: request.maxHoldUsd }) });
        // The curator's judge rides the same model (a different purpose): it answers the duplicate question for every candidate.
        if (request.purpose !== "reflect") {
          const count = (request.user.match(/^\d+\. state=/gmu) ?? []).length;
          return { text: JSON.stringify({ verdicts: Array.from({ length: count }, (_, i) => ({ n: i + 1, verdict: this.opts.sameText ? "same" : "different" })), escalate: false }), costUsd: 0.001, model: "judge-model" };
        }
        const same = this.opts.sameText;
        const text = JSON.stringify({ candidates: [repoOnly && !same ? candidate("Retries go through withRetry", "Reviewers ask that HTTP retries in api use withRetry, not a hand-rolled loop.") : candidate("Name the retry helper", "The first reflection learned that the retry helper is named withRetry in api.")] });
        return { text, costUsd: 0.01, model: "reflect-model" };
      },
    };
    this.runtime = createLessonsRuntime({
      table: this.table, now: () => this.now, reader: { file: async () => undefined }, repositoriesOf: async () => ["api"], pause, model, spend: { admit: async () => true, look: async () => "ok" }, edition: "public",
      audit: async () => undefined, evidence: { documentClient: this.record, tableName: "state", signInTableName: "signin", now: () => this.now }, linkedAccounts: async () => [], taskVisibility: allowAllAccess.taskVisibility,
      names: { memberName: async () => "x", isErased: async () => false },
    });
    const settings = { read: async () => ({ mode: this.mode, preset: "standard" as const }) };
    // The real capture adapter over a fake code host: the host's feedback carries the description Rovara wrote; the adapter decides what of it the lessons code sees.
    const host: Pick<CodeHost, "feedback"> = {
      feedback: async () => ({
        comments: this.commentIds.map((id) => ({ id, kind: "review_comment", url: "", author: "x", updatedAt: "2026-11-01T00:00:00.000Z", body: "unused", line: 3 })), threads: [],
        changeRequest: { ref: {}, state: "merged", sourceBranch: "rovara/x", targetBranch: "main", headRevision: this.opts.mergedHead, mergeRevision: MERGE, title: this.opts.title, body: this.opts.body, headTreeRevision: "a".repeat(40) },
      }) as unknown as ChangeRequestFeedback,
    };
    const adapter = captureAdapterOf({
      host: "github", codeHost: host, pullRequestAddress: (url) => { const m = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)$/u.exec(url); return m === null ? undefined : { host: "github", repository: `${m[1]}/${m[2]}`.toLowerCase(), number: Number(m[3]) }; },
      repositoryAddress: (fullName) => `https://github.com/${fullName}`, refOf: () => ({}) as never, scopeOf: () => ({ system: "webhook" }) as never,
    });
    const source = lessonSubjectSource({
      documentClient: this.tasks, tableName: "tasks", repositoriesOf: async () => ["api"], standing: async (_org, who) => (this.outsiders.has(who) ? "outsider" : "member"), isErased: async () => false, visibility: async () => ({ kind: "shared" }), now: () => this.now,
      captured: { rememberedNote: async () => undefined, pullRequestWords: async ({ surface, commentId }) => this.comments[`${surface}:${commentId}`] }, rememberedNoteIds: async () => [], sourceExcluded: async () => false,
      pullRequestAddress: (url) => adapter.pullRequestAddress(url), pullRequestFeedback: (input) => adapter.pullRequestFeedback!({ workspaceId: input.orgId, project: input.project, taskId: input.taskId, address: input.address, url: input.url }),
      repositoryUrlsOf: async () => ({ api: this.opts.registeredUrl }), repositoryAddress: (_host, fullName) => adapter.repositoryAddress?.(fullName),
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
  /** The human-edit job's extractor, over the same source, settings, model and store. */
  extractor = () => createHumanEditExtractor({
    source: this.learning.source, settings: this.learning.settings, reflect: this.learning.reflect, process: this.learning.process,
    standing: async (_org, who) => (this.outsiders.has(who) ? "outsider" : "member"), isErased: async () => false,
  });
  editInput = (over: Partial<HumanEditInput> = {}): HumanEditInput => ({
    workspaceId: WS, project: PROJECT, repo: "acme/api", taskId: TASK, pullRequest: { number: 7, url: this.opts.prUrl }, trust: "member", authorCount: 1, authors: ["ann"], audience: { kind: "project" }, scope: PLACE,
    files: [{ path: "src/fetch.ts", additions: 1, deletions: 1, symbols: ["function load()"], hunks: ["@@ -1,2 +1,2 @@", "-for (;;) { try { fetch() } catch {} }", "+await withRetryEDIT(() => fetch())"] }], link: this.opts.prUrl, ...over,
  });
  repoCalls = () => this.calls.filter((call) => call.purpose === "reflect" && call.repoOnly);
  mainCalls = () => this.calls.filter((call) => call.purpose === "reflect" && !call.repoOnly);
  lessons = async () => this.runtime.store.list(KEY);
}

