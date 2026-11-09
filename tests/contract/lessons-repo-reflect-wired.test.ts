// Lessons in the repo, lane R1b (decision 50c): the WIRED path from a merged task's end to a repo-only lesson in the Dynamo store. The real task-end handler sends ids to the queue, the queue's consumer is the real reflect
// worker (lease, deadline) running `learnFromEndedTaskTyped` with the PRODUCTION subject source (`lessonSubjectSource`) and the real capture adapter over a fake code host, the runtime the broker builds
// (`createLessonsRuntime`) stores the drafts, and the real human-edit extractor owns a change request someone pushed to after Rovara.
// Mutation checks (done by hand, see the lane's report): a forbidden input added to the repo-only prompt fails the prompt test; the once-key removed fails the redelivery test; the gate removed fails the switch-off test.
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type { ChangeRequestFeedback, CodeHost } from "@agentx/contracts";
import { createWorkflowSnapshot } from "../../packages/contracts/src/task-workflow-node.js";
import { workflowPullRequestBody } from "../../packages/broker/src/aws/developer-tasks.js";
import { rovaraPullRequestBody } from "../../packages/broker/src/rovara-code/pull-request-body.js";
import { lessonSubjectSource } from "../../packages/broker/src/aws/broker/lesson-subject-source.js";
import { taskKey, taskOwnerKey } from "../../packages/broker/src/developer/task-records.js";
import type { CapturedWords } from "../../packages/broker/src/lessons/captured-rows.js";
import { createHumanEditExtractor } from "../../packages/broker/src/lessons/human-edit.js";
import { noteTaskHeld } from "../../packages/broker/src/lessons/repo-reflect.js";
import { loadLessonsForStage } from "../../packages/broker/src/lessons/load.js";
import { setLearnedLessonsGate } from "../../packages/broker/src/lessons/policy.js";
import type { PipelineModel } from "../../packages/broker/src/lessons/ports.js";
import { dynamoPauseStore } from "../../packages/broker/src/lessons/pause.js";
import { dynamoReflectClaims } from "../../packages/broker/src/lessons/reflect-claims.js";
import type { ReflectQueue, ReflectQueueMessage } from "../../packages/broker/src/lessons/reflect-queue.js";
import { handleReflectBatch } from "../../packages/broker/src/lessons/reflect-worker.js";
import { createLessonsRuntime } from "../../packages/broker/src/lessons/runtime.js";
import { learnFromEndedTaskTyped, learningTaskEndHandler, type TaskLearningDeps } from "../../packages/broker/src/lessons/task-end.js";
import { captureAdapterOf } from "../../packages/broker/src/team-record/sources/capture-adapters.js";
import type { HumanEditInput } from "../../packages/broker/src/team-record/sources/codehost.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { PROJECT, WS, allowAllAccess } from "../unit/lessons/lesson-helpers.js";

afterEach(() => { setLearnedLessonsGate(undefined); });

const KEY = { workspaceId: WS, project: PROJECT };
const T0 = 1_800_000_000_000;
const TASK = randomUUID();
const CREATOR = "creator-1";
const HEAD = "d".repeat(40);
const PUSHED = "e".repeat(40);
const MERGE = "f".repeat(40);
const PLACE = "github:repo/9";
const INTENT = "Make the retries use withRetry";
const REPO_SYSTEM = "one repository's own review";
const SLACK_PLAN = "PLANSUMMARY from the Slack ask: customer Initech wants the Q4 churn export";

/** Descriptions as Rovara's own builders write them (version 1 and version 2): plan summary, status block, names, task link. None of it may reach the repo-only prompt. */
const TASK_ID = "8b579b4b-eaa7-4bf2-87bc-6da86b97c9e6";
const attribution = { requester: { state: "named" as const, name: "Jane Doe", ref: "a".repeat(16) }, approver: { state: "named" as const, name: "John Roe", ref: "b".repeat(16) } };
const snapshot = (definitionVersion: string) => createWorkflowSnapshot({ taskId: TASK_ID, ownerId: "a".repeat(64), now: "2026-10-25T12:00:00.000Z", definitionVersion } as never);
const V2_BODY = rovaraPullRequestBody({ summary: [SLACK_PLAN], fallbackTitle: "Retries", workflow: snapshot("1.1.0"), context: { attribution }, reviewLines: () => [], pageUrl: "https://app.rovara.example/t/abc" });
const V1_BODY = workflowPullRequestBody({ title: "Retries" } as never, snapshot("1.0.0"), `${SLACK_PLAN}\nmore`, "https://app.rovara.example/t/abc", { attribution });

interface Options { humanEdits?: boolean; prUrl?: string; registeredUrl?: string; pushedHead?: string; mergedHead?: string; body?: string; title?: string; sameText?: boolean; rovaraHeadKnown?: boolean }
const words = (id: string, who: string, text: string): CapturedWords => ({ id, authorDeveloperId: who, authorSourceId: `acct-${who}`, source: "github", ownText: true, text, audience: { kind: "project" }, scope: PLACE });
const candidate = (title: string, body: string) => ({ type: "convention", title, description: body, body, scope: { repos: ["api"], paths: ["src/**"] }, stages: ["IMPLEMENT"], citations: [], evidenceSpanIds: ["S1"] });

class World {
  now = T0;
  comments: Record<string, CapturedWords> = { "review_comment:11": words("acme/api#pr7:review_comment11", "rae", "Use withRetry for HTTP retries in api, not a hand-rolled loop.") };
  commentIds: string[] = ["11"];
  mode: "Off" | "Collect" | "Suggest" | "On" = "On";
  outsiders = new Set<string>();
  quoteFailures = 0;
  calls: Array<{ purpose: string; repoOnly: boolean; system: string; user: string; maxHoldUsd?: number }> = [];
  private readonly opts: Required<Omit<Options, "rovaraHeadKnown">> & { rovaraHeadKnown: boolean };
  private readonly tasks = new FakeDynamoDb();
  private readonly record = new FakeDynamoDb({ indexKeys: { gsi1: { partition: "gsi1pk" }, gsi2: { partition: "gsi2pk" }, gsi3: { partition: "gsi3pk", sort: "gsi3sk" }, gsi4: { partition: "gsi4pk" }, gsi5: { partition: "gsi5pk", sort: "textDueAt" } } });
  private readonly state = new FakeDynamoDb();
  readonly table = { documentClient: this.record, tableName: "record" };
  readonly runtime;
  readonly learning: TaskLearningDeps;

  constructor(options: Options = {}) {
    this.opts = { prUrl: "https://github.com/acme/api/pull/7", registeredUrl: "https://github.com/acme/api", pushedHead: HEAD, mergedHead: HEAD, body: V2_BODY, title: "Retries use withRetry", sameText: false, rovaraHeadKnown: true, humanEdits: true, ...options };
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
      humanEditsSupported: () => this.opts.humanEdits, repositoryUrlsOf: async () => ({ api: this.opts.registeredUrl }), repositoryAddress: (_host, fullName) => adapter.repositoryAddress?.(fullName),
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
    expect(main.provenance.repoOnly).toBeUndefined();
    expect(main.provenance.repoBlockCodes).toEqual(["task_inputs_unproved", "intent_not_repo"]);
    expect(w.mainCalls()[0]!.user).toContain(INTENT);
  });

  it("review M2 and L-b (P3a/P3b, real description shapes): the prompt holds the repository's comment, the merge fact and the link; no description, no title (plan summary from Slack, names, task link) and none of the task's own text", async () => {
    for (const body of [V1_BODY, V2_BODY]) {
      // Positive control: Rovara's own description really holds what must not reach the prompt (the quoted plan summary, the names, the task link).
      for (const planted of ["PLANSUMMARY", "Jane Doe", "John Roe", "app.rovara.example"]) expect(body, planted).toContain(planted);
      const w = new World({ body });
      await w.end();
      const { user, system } = w.repoCalls()[0]!;
      expect(user).toContain("Use withRetry for HTTP retries in api, not a hand-rolled loop.");
      // review L-b: no Rovara-written text at all, the title included (the host's title here is "Retries use withRetry").
      expect(user).not.toContain("Retries use withRetry");
      expect(user).toContain("https://github.com/acme/api/pull/7");
      expect(user).toContain("outcome merged");
      for (const forbidden of [INTENT, "PLANSUMMARY", "Initech", "Jane Doe", "John Roe", "app.rovara.example", "Requested by"]) expect(user, forbidden).not.toContain(forbidden);
      expect(user).not.toMatch(/kind=(intent|plan|send_back|remembered|loaded_lesson|review_finding|ci_failure)/u);
      expect(system).toMatch(/<<span [0-9a-f]{16} \.\.\.>>/u);
    }
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
    none.commentIds = [];
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
    await learnFromEndedTaskTyped(w.learning, { workspaceId: WS, taskId: TASK });
    expect(w.mainCalls()).toHaveLength(2);
    expect(w.repoCalls()).toHaveLength(1);
  });

  it("review L1 (P4): a quote that fails before the call spends nothing and takes no key; the next delivery reflects the change request", async () => {
    const w = new World();
    w.quoteFailures = 0;
    const real = w.learning.reflect.model;
    let n = 0;
    (w.learning.reflect as { model: PipelineModel }).model = { ...real, quote: async (r) => { n += 1; if (n === 2) throw new Error("quote down"); return real.quote!(r); } };
    await learnFromEndedTaskTyped(w.learning, { workspaceId: WS, taskId: TASK });
    expect(w.repoCalls()).toHaveLength(0);
    await learnFromEndedTaskTyped(w.learning, { workspaceId: WS, taskId: TASK });
    expect(w.repoCalls()).toHaveLength(1);
  });
});

describe("review H1: the repo-only lesson is never merged into the task's own lesson", () => {
  it("P1: both reflections learn the same advice and the curator's judge says 'same': two lessons, the repo-only one keeps its mark, they are linked both ways, and a task is given only one of them (the repo-only one)", async () => {
    const w = new World({ sameText: true });
    await w.end();
    expect(w.repoCalls()).toHaveLength(1);
    const lessons = await w.lessons();
    expect(lessons).toHaveLength(2);
    const repo = lessons.find((lesson) => lesson.provenance.repoOnly !== undefined)!;
    const main = lessons.find((lesson) => lesson.provenance.repoOnly === undefined)!;
    expect(repo.provenance.repoOnly).toEqual({ place: PLACE });
    expect(repo.possibleDuplicateOf).toBe(main.id);
    expect(main.repoTwins).toEqual([repo.id]);
    // Both go live (a person approved them); the loader gives the task one.
    const live = await Promise.all([repo, main].map(async (lesson) => ({ ...lesson, status: "active" as const, approvals: [{ approvalId: "a", by: "ann", at: 1, mode: "one" as const }] })));
    const store = w.runtime.store;
    const setVersion = await store.setVersion(KEY);
    expect((await store.commit(KEY, setVersion, live.map((lesson) => ({ ...lesson, version: lesson.version + 1 })), w.now)).ok).toBe(true);
    const loaded = await loadLessonsForStage({ ...w.runtime.routes, access: allowAllAccess, store, embedder: w.runtime.routes.embedder, vectors: w.runtime.routes.vectors, settings: w.learning.settings, audit: w.runtime.routes.audit, now: () => w.now }, {
      workspaceId: WS, project: PROJECT, taskId: "task-9", stage: "IMPLEMENT", round: 1, intent: "Retry failed HTTP calls in the api service", repos: ["api"], files: ["src/retry/client.ts"], languages: [], taskAudience: { kind: "shared" },
    });
    expect((loaded.context?.lessons ?? []).map((l) => l.id)).toEqual([repo.id]);
  });
});

describe("review M1: the repository is proved from the registered repository URL, before anything is paid", () => {
  it("P2a: the project's name for the repository differs from the host's name: the lesson is repo-only", async () => {
    const w = new World({ prUrl: "https://github.com/acme/backend-api/pull/7", registeredUrl: "https://github.com/acme/backend-api" });
    await w.end();
    expect(w.repoCalls()).toHaveLength(1);
    expect((await w.lessons()).find((l) => l.title === "Retries go through withRetry")!.provenance.repoOnly).toEqual({ place: PLACE });
  });
  it("P2b: capitals in the host's name: the registered URL matches without case", async () => {
    const w = new World({ prUrl: "https://github.com/Acme/Api/pull/7", registeredUrl: "https://github.com/acme/api.git" });
    await w.end();
    expect(w.repoCalls()).toHaveLength(1);
    expect((await w.lessons()).find((l) => l.title === "Retries go through withRetry")!.provenance.repoOnly).toEqual({ place: PLACE });
  });
  it("a pull request that is not in the project's registered repository is not reflected, and nothing is paid for it", async () => {
    const w = new World({ registeredUrl: "https://github.com/acme/other" });
    await w.end();
    expect(w.repoCalls()).toEqual([]);
    expect(w.mainCalls()).toHaveLength(1);
  });
});

describe("one owner per pull request: the human-edit job owns it when someone pushed after Rovara", () => {
  it("nobody pushed after Rovara: the task end makes the one comment-only call, and a later job finds the key taken (no double call)", async () => {
    const w = new World();
    await w.end();
    expect(w.repoCalls()).toHaveLength(1);
    expect(w.repoCalls()[0]!.user).not.toContain("withRetryEDIT");
    await w.extractor().extract(w.editInput());
    expect(w.repoCalls()).toHaveLength(1);
  });

  it("a person pushed after Rovara: the task end makes no repo-only call; the job makes ONE call with the comments and the edits; a second job makes none", async () => {
    const w = new World({ mergedHead: PUSHED });
    await w.end();
    expect(w.repoCalls()).toHaveLength(0);
    expect(w.mainCalls()).toHaveLength(1);
    await w.extractor().extract(w.editInput());
    expect(w.repoCalls()).toHaveLength(1);
    const prompt = w.repoCalls()[0]!.user;
    expect(prompt).toContain("Use withRetry for HTTP retries in api, not a hand-rolled loop.");
    expect(prompt).toContain("withRetryEDIT");
    expect(prompt).not.toContain(INTENT);
    const lesson = (await w.lessons()).find((l) => l.provenance.repoOnly !== undefined)!;
    expect(lesson.provenance.repoOnly).toEqual({ place: PLACE });
    expect(lesson.provenance.readFrom).toEqual(expect.arrayContaining(["rae", "ann"]));
    await w.extractor().extract(w.editInput());
    await w.end();
    expect(w.repoCalls()).toHaveLength(1);
  });

  it("the job runs first, then the task end: still one call", async () => {
    const w = new World({ mergedHead: PUSHED });
    await w.extractor().extract(w.editInput());
    await w.end();
    expect(w.repoCalls()).toHaveLength(1);
  });

  it("the job cannot use the edit (its author is not a member): it still makes the comment-only call, without the edit's lines", async () => {
    const w = new World({ mergedHead: PUSHED });
    w.outsiders.add("ann");
    await w.end();
    await w.extractor().extract(w.editInput());
    expect(w.repoCalls()).toHaveLength(1);
    expect(w.repoCalls()[0]!.user).toContain("Use withRetry for HTTP retries in api");
    expect(w.repoCalls()[0]!.user).not.toContain("withRetryEDIT");
  });

  it("a pull request with edits but no review comment is reflected by the job on the edits alone", async () => {
    const w = new World({ mergedHead: PUSHED });
    w.commentIds = [];
    await w.end();
    expect(w.repoCalls()).toHaveLength(0);
    await w.extractor().extract(w.editInput());
    expect(w.repoCalls()).toHaveLength(1);
    expect(w.repoCalls()[0]!.user).toContain("withRetryEDIT");
  });
});

describe("review L-f: Public's cap is per task across the task-end run and the human-edit job", () => {
  it("the job's repo-only call is asked to hold at most what the task end left of the 0.15 cap (not a fresh 0.15)", async () => {
    const w = new World({ mergedHead: PUSHED });
    await w.end();
    expect(w.mainCalls()[0]!.maxHoldUsd).toBeCloseTo(0.15, 6);
    await w.extractor().extract(w.editInput());
    expect(w.repoCalls()).toHaveLength(1);
    // The first reflection held 0.01 (its quote); that is one whole cent of the task's total.
    expect(w.repoCalls()[0]!.maxHoldUsd).toBeCloseTo(0.14, 6);
  });
  it("a job that finds the task's cap used up makes no call", async () => {
    const w = new World({ mergedHead: PUSHED });
    await w.end();
    await noteTaskHeld(w.runtime.store, KEY, TASK, 0.15);
    await w.extractor().extract(w.editInput());
    expect(w.repoCalls()).toHaveLength(0);
  });
});

describe("review M-a: the task end leaves a pull request to the human-edit job only on a host that reads human edits", () => {
  it("a host whose adapter does not support human edits: the task end owns the change request even though the head moved", async () => {
    const w = new World({ mergedHead: PUSHED, humanEdits: false });
    await w.end();
    expect(w.repoCalls()).toHaveLength(1);
  });
});

describe("review M-a: the extractor's comment-only fallback (what the tap calls when it skips a pull request)", () => {
  const skipped = (w: World) => ({ workspaceId: WS, project: PROJECT, taskId: TASK, link: w.editInput().link });
  it("makes ONE comment-only call for a pull request the task end left to the job, with the same once-key (a second call, or the task end, makes none)", async () => {
    const w = new World({ mergedHead: PUSHED });
    await w.end();
    expect(w.repoCalls()).toHaveLength(0);
    await w.extractor().commentsOnly!(skipped(w));
    expect(w.repoCalls()).toHaveLength(1);
    expect(w.repoCalls()[0]!.user).toContain("Use withRetry for HTTP retries in api, not a hand-rolled loop.");
    expect(w.repoCalls()[0]!.user).not.toContain("withRetryEDIT");
    expect((await w.lessons()).find((l) => l.provenance.repoOnly !== undefined)?.provenance.repoOnly).toEqual({ place: PLACE });
    await w.extractor().commentsOnly!(skipped(w));
    await w.extractor().extract(w.editInput());
    await w.end();
    expect(w.repoCalls()).toHaveLength(1);
  });
  it("is gated like every learning call: Off, Collect and a switch that is off make no call and read nothing from the task", async () => {
    for (const mode of ["Off", "Collect"] as const) {
      const w = new World({ mergedHead: PUSHED });
      w.mode = mode;
      await w.extractor().commentsOnly!(skipped(w));
      expect(w.calls, mode).toEqual([]);
    }
    setLearnedLessonsGate(() => false);
    const w = new World({ mergedHead: PUSHED });
    await w.extractor().commentsOnly!(skipped(w));
    expect(w.calls).toEqual([]);
  });
});
