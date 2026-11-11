// Golden recorder for Rovara Code: what an unchanged Rovara Code does today, scenario by scenario, so a later change that
// should leave it alone can be shown to have left it alone. A record has two halves.
//   Broker half: the real broker (the developer-task harness or the Slack thread harness, on a model-proxy install) starts
//     the task and the scenario's operation. The record keeps that operation, its outbox item, the invocation inside it, the
//     invocation as the EC2 delivery posts it to a worker that advertises every feature (`forWorker`), the task's own items,
//     and the model key the operation's capability asks for.
//   Worker half: the real worker runs that `forWorker` invocation on Pi's scripted faux model and a real git workspace.
//     The record keeps what the model is offered (system prompt, tool names, skills) and each reviewer session's prompt.
// Time is fixed (2026-10-20T00:00:00Z) and every id comes from golden-ids.ts, so a record is the same on every run.
// The test that owns the fixtures mocks node:crypto's randomUUID with goldenUuid; this file only seeds it.
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getCurrentSystemPrompt, getCurrentTools, fauxAssistantMessage, type TranscriptContext } from "@earendil-works/pi-ai";
import { expect, vi } from "vitest";
import { WorkflowFeedbackBundleSchema, createCandidateManifest } from "@rovara-code/contracts";
import { WORKER_INVOCATION_FEATURES } from "@agentx/cloud-contracts";
import { WorkerInvocationSchema, WorkflowSnapshotSchema, collectWorkflowFeedbackBundles, createWorkflowSnapshot, type WorkerInvocation } from "@agentx/cloud-contracts";
import { indexActivity } from "../../packages/broker/src/aws/activity-index.js";
import type { Notice } from "../../packages/broker/src/developer/notifications.js";
import { createNotifierHandler } from "../../packages/broker/src/aws/developer-task-notifier.js";
import { startTaskWorkflowFeedbackReviewFromWebhook } from "../../packages/broker/src/aws/developer-tasks.js";
import { createEc2Delivery } from "../../packages/broker/src/aws/ec2-delivery.js";
import type { Ec2OutboxRecord } from "../../packages/broker/src/aws/lambda.js";
import { createOrchestratorRuntime, runOrchestratorTurn } from "../../packages/orchestrator/src/orchestrator.js";
import type { OrchestrationApi } from "../../packages/orchestrator/src/orchestration-tools.js";
import { createDefaultPiSessionAdapter, createWorkerResources, type PiSessionAdapter, type PiSessionInput } from "../../packages/worker/src/pi-session.js";
import { runTaskInvocation } from "../../packages/worker/src/run-task.js";
import type { FeedbackBundleReadResult } from "../../packages/worker/src/callback-client.js";
import { createFixtureDirectory } from "../fixtures/index.js";
import { developerIdForSlackUser } from "../../packages/broker/src/aws/admin-actions.js";
import type { ChatGptConnections } from "../../packages/broker/src/chatgpt/connections.js";
import { planAnswer, planDocument } from "./plan-documents.js";
import { MAYA, createSingleAnswerPlanBroker, recordStream, type createDeveloperTaskBroker } from "./developer-task-broker.js";
import { fakeModelAccess } from "./fake-model-access.js";
import { FAUX_MODEL, fauxModelRuntime } from "./faux-model.js";
import { goldenUuid, seedGoldenIds } from "./golden-ids.js";
import { TEST_ORG } from "./orgs.js";
import { SLACK_CHANNEL, SLACK_TEAM, call, createBroker, ensureWorkspace, finishOperation, loadSlackBroker, markReady, orchestratorPrincipal, registerSlackProject, serviceCall } from "./slack-broker.js";
import { runLimitAck } from "./run-limit-ack.js";

export { goldenUuid };

/** The scenarios, in the order whose position seeds each one's ids. New scenarios go at the end. */
export const GOLDEN_SCENARIOS = [
  "plan-quick",
  "plan-full-requirements",
  "plan-full-design",
  "plan-full-implementation-plan",
  "plan-review-decision",
  "implement",
  "checks",
  "review",
  "feedback-review",
  "task-no-workflow",
  "task-no-workflow-no-proxy",
  "shared-task",
  "slack-thread-operation",
  "chatgpt-task",
  "orchestrator-turn",
  "plan-ready-quick",
  "plan-ready-full",
] as const;
export type GoldenScenario = (typeof GOLDEN_SCENARIOS)[number];

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export interface GoldenReviewSession { role: "CRITIC" | "SECURITY" | "FEEDBACK"; prompt: string; tools: string[] }

export interface GoldenRecord {
  scenario: GoldenScenario;
  /** The scenario's operation as the broker stored it; null for an orchestrator turn, which has none. */
  operation: Json | null;
  /** The operation's outbox item. */
  outbox: Json | null;
  /** The invocation inside the outbox item, parsed by the worker's schema. */
  invocation: Json | null;
  /** The invocation as the EC2 delivery posts it to a worker that lists every invocation feature. */
  forWorker: Json | null;
  /** What the model of the scenario's main session is offered; null where no model session runs (CHECKS) or the turn is the orchestrator's. */
  piInputs: { systemPrompt: string; tools: string[]; skills: string[] } | null;
  /** Each reviewer session the worker started, in order. */
  reviewSessions: GoldenReviewSession[];
  orchestratorTurn?: { modelAccessResponse: Json; tools: string[]; systemPrompt: string };
  /** The decision request that made the operation, for a scenario that is a decision (status and the workflow it left). */
  decision?: Json;
  /** Every item of the task's own partition (`DEVTASK#<id>`), the record where change 5 adds fields and a RECIPE item. */
  taskItems?: Json[];
  /**
   * The model key the operation's capability asks for, and every call the proxy received by the end of the scenario (key
   * requests, spend reads, settles and revokes), by method. Change 3 adds reservations and settlement here.
   */
  modelAccess?: { status: number; response: Json; mintKeyCalls: Json[]; calls: { [method: string]: Json[] } };
  /**
   * What happens when the operation ends (change 3 and the usage part of change 5): the usage event the worker sent, the
   * operation as it ended, the usage and failure index items the stream writer made from them, and every write that
   * writer did. A ChatGPT-plan counter write (`PERSONAL#`) would show among the writes.
   */
  afterRun?: { status: "SUCCEEDED" | "FAILED"; operation: Json; usageEvent: Json; indexResult: Json; indexItems: Json[]; indexWrites: Json[] };
  /** Every Slack post the notifier made for the task, in order (change 4: the plan-ready message). */
  notifications?: Json[];
  /** How the worker's run of the invocation ended: it returns, or throws (a scripted model gives no plan and no change). */
  workerRun?: { ended: "returned" | "threw"; error?: { name: string; code?: string } };
}

// ---- the clock, the ids and the canonical form ----

export const GOLDEN_CLOCK = "2026-10-20T00:00:00Z";
const PROXY_URL = "http://internal-proxy.example.test:4000";
const FIXTURE_DIRECTORY = resolve(dirname(fileURLToPath(import.meta.url)), "../fixtures/rovara-code-golden");
export const GOLDEN_FIXTURE_DIRECTORY = FIXTURE_DIRECTORY;

/** JSON with sorted keys, Sets as sorted arrays and no undefined, so a record compares and hashes the same every run. */
function canonical(value: unknown): Json {
  if (value instanceof Set) return [...value].map(canonical).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  if (Array.isArray(value)) return value.map((entry) => canonical(entry === undefined ? null : entry));
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, entry]) => entry !== undefined && typeof entry !== "function")
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return Object.fromEntries(entries.map(([key, entry]) => [key, canonical(entry)]));
  }
  if (typeof value === "bigint") return value.toString();
  return value as Json;
}

/** A copy of the object without the named keys. */
function without<T extends object, K extends keyof T>(value: T, ...keys: K[]): Omit<T, K> {
  const copy: Record<PropertyKey, unknown> = { ...(value as Record<PropertyKey, unknown>) };
  for (const key of keys) delete copy[key];
  return copy as Omit<T, K>;
}

// ---- the worker's workspace ----

const GIT_ENVIRONMENT = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Golden", GIT_AUTHOR_EMAIL: "golden@example.test", GIT_AUTHOR_DATE: GOLDEN_CLOCK,
  GIT_COMMITTER_NAME: "Golden", GIT_COMMITTER_EMAIL: "golden@example.test", GIT_COMMITTER_DATE: GOLDEN_CLOCK,
};
const git = (directory: string, ...args: string[]) => execFileSync("git", ["-C", directory, ...args], { encoding: "utf8", env: GIT_ENVIRONMENT }).trim();
const SOURCE_BEFORE = "export function retry(attempts: number) {\n  return attempts;\n}\n";
const SOURCE_AFTER = "export function retry(attempts: number) {\n  return Math.max(1, attempts);\n}\n";

/** A repository with one commit whose id is the same on every machine, and (when asked) one uncommitted change on top. */
async function writeFixtureRepository(directory: string, changed: boolean): Promise<string> {
  await mkdir(join(directory, "src"), { recursive: true });
  await writeFile(join(directory, "README.md"), "# Demo\n");
  await writeFile(join(directory, "src/retry.ts"), SOURCE_BEFORE);
  git(directory, "init", "--quiet", "--initial-branch=main");
  git(directory, "add", ".");
  git(directory, "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "base");
  const base = git(directory, "rev-parse", "HEAD");
  if (changed) await writeFile(join(directory, "src/retry.ts"), SOURCE_AFTER);
  return base;
}

let baseCommit: string | undefined;
/** The id of the fixture repository's one commit: what the broker is told preparation checked out. */
async function fixtureBaseCommit(): Promise<string> {
  if (baseCommit === undefined) {
    const directory = await createFixtureDirectory("agentx-golden-base-");
    try { baseCommit = await writeFixtureRepository(directory, false); } finally { await rm(directory, { recursive: true, force: true }); }
  }
  return baseCommit;
}

// ---- Pi's view of a session ----

type ModelView = { systemPrompt: string; messages: unknown[]; tools: string[] };
const modelView = (context: TranscriptContext): ModelView => ({
  systemPrompt: getCurrentSystemPrompt(context.messages) ?? "",
  messages: JSON.parse(JSON.stringify(context.messages.filter((message) => (message as { role: string }).role !== "system"))) as unknown[],
  tools: getCurrentTools(context.messages).map((tool) => tool.name),
});
/** The text of a conversation's first user message: the prompt a session was given. */
function firstUserText(view: ModelView): string {
  const message = view.messages.find((entry) => (entry as { role?: string }).role === "user") as { content?: unknown } | undefined;
  const content = message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((part) => (part as { type?: string; text?: string }).type === "text" ? String((part as { text?: string }).text) : "").join("");
  return "";
}

const FEEDBACK_CRITIC = "You are AgentX's independent PR-feedback critic.";
const isReviewer = (prompt: string) => /Review role: (CODE|SECURITY)\./.test(prompt) || prompt.startsWith(FEEDBACK_CRITIC);

/** A model whose every answer is "Done.", except a reviewer, which finds nothing. Records what each call was offered. */
async function scriptedModel() {
  const { modelRuntime, faux } = await fauxModelRuntime();
  const views: ModelView[] = [];
  const answer = (context: TranscriptContext) => {
    const view = modelView(context);
    views.push(view);
    const prompt = firstUserText(view);
    return fauxAssistantMessage(isReviewer(prompt) ? JSON.stringify({ findings: [] }) : "Done.");
  };
  faux.setResponses(Array.from({ length: 24 }, () => answer));
  const inputs: PiSessionInput[] = [];
  const base = createDefaultPiSessionAdapter({ modelRuntime: async () => ({ runtime: modelRuntime, model: FAUX_MODEL }) });
  const adapter: PiSessionAdapter = {
    create: async (input) => { inputs.push(input); return base.create(input); },
    ...(base.open === undefined ? {} : { open: async (input) => { inputs.push(input); return base.open!(input); } }),
  };
  return { adapter, views, inputs };
}

/** A prepared workspace for the invocation: the manifest the worker reads and the fixture repository it names. */
async function preparedWorkspace(invocation: WorkerInvocation, changed: boolean) {
  const rootPath = await createFixtureDirectory("agentx-golden-worker-");
  const state = await createFixtureDirectory("agentx-golden-state-");
  const directory = join(rootPath, "repo/demo");
  const base = await writeFixtureRepository(directory, changed);
  await mkdir(join(rootPath, ".agentx"), { recursive: true });
  await writeFile(join(rootPath, ".agentx/preparation-manifest.json"), JSON.stringify({
    schemaVersion: 2, projectName: "payments", projectRevision: invocation.projectRevision,
    repositories: [{ name: "demo", path: "repo/demo", defaultBranch: "main", resolvedCommit: base, resolvedAt: GOLDEN_CLOCK, completedAt: GOLDEN_CLOCK }],
    completedSetupSteps: [], readinessResults: [], creationIdentity: "golden", complete: true, updatedAt: GOLDEN_CLOCK,
  }));
  return { rootPath, state, directory, base, cleanup: async () => { await rm(rootPath, { recursive: true, force: true }); await rm(state, { recursive: true, force: true }); } };
}

/** The feedback bundle reader of a FEEDBACK_REVIEW operation: one pull request on the fixture repository's tree. */
function feedbackBundles(directory: string): (binding: { taskId: string; workflowRevision: number; candidateDigest: string }) => Promise<FeedbackBundleReadResult> {
  return async (binding) => {
    const tree = git(directory, "rev-parse", "HEAD^{tree}");
    const body = "Handle zero attempts before returning.";
    const comments = [{ id: "review-comment-1", threadId: "thread-1", kind: "REVIEW_COMMENT" as const, url: "https://github.com/example/demo/pull/7#discussion_r1",
      author: "reviewer", updatedAt: GOLDEN_CLOCK, bodyDigest: createHash("sha256").update(body).digest("hex"), bodyBytes: Buffer.byteLength(body), path: "src/retry.ts", line: 2, body }];
    const bundle = { schemaVersion: 1 as const, taskId: binding.taskId, repositoryId: "demo", number: 7, headSha: "a".repeat(40), headTreeSha: tree,
      candidateDigest: binding.candidateDigest, commentSetDigest: createHash("sha256").update(JSON.stringify(comments), "utf8").digest("hex"),
      producer: "agentx-github-reconciler", version: "1", recordedAt: GOLDEN_CLOCK, comments, sourceDeliveryIds: ["delivery-1"] };
    const bytes = JSON.stringify(bundle);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    return {
      taskRequirements: "Fix the retry bug",
      bundles: [{ ref: { ...without(bundle, "sourceDeliveryIds", "comments"), sha256, objectKey: `feedback/${sha256}.json`, comments: comments.map((comment) => without(comment, "body")) }, bytes }],
    };
  };
}

/** Runs the worker on the invocation the broker would post and reports what the models were offered. */
async function workerHalf(forWorker: WorkerInvocation): Promise<Pick<GoldenRecord, "piInputs" | "reviewSessions" | "workerRun">> {
  if (forWorker.kind !== "task") throw new Error("a golden worker half runs a task invocation");
  const mode = forWorker.payload.workflowMode;
  // CHECKS runs the owner's checks with no model; nothing is offered to one.
  if (mode === "CHECKS") return { piInputs: null, reviewSessions: [] };
  const workspace = await preparedWorkspace(forWorker, mode === "REVIEW");
  const stateBefore = process.env.AGENTX_WORKER_STATE_DIR;
  process.env.AGENTX_WORKER_STATE_DIR = workspace.state;
  try {
    const { adapter, views, inputs } = await scriptedModel();
    let workerRun: NonNullable<GoldenRecord["workerRun"]> = { ended: "returned" };
    try {
      await runTaskInvocation(forWorker, {
        rootPath: workspace.rootPath, model: FAUX_MODEL, piAdapter: adapter, taskShell: { kind: "local" },
        eventSink: async () => undefined, artifactSink: async () => undefined,
        checkRunners: { runProjectCommand: async () => ({ exitCode: 0, timedOut: false, stdout: "", stderr: "" }), runAgentCommand: async () => ({ exitCode: 0, timedOut: false, output: "" }) },
        ...(mode === "FEEDBACK_REVIEW" ? { feedbackBundleReader: feedbackBundles(workspace.directory) } : {}),
      });
    } catch (error) {
      // A scripted model gives no plan and no change, so a run may end in an error. What the models were offered is what the
      // record is about, and how the run ended is kept beside it so a change in that shows too.
      const code = (error as { code?: unknown }).code;
      workerRun = { ended: "threw", error: { name: error instanceof Error ? error.name : typeof error, ...(typeof code === "string" ? { code } : {}) } };
    }
    const root = realpathSync(workspace.rootPath);
    const normalize = (text: string) => text.split(root).join("<workspace>").split(workspace.rootPath).join("<workspace>");
    const reviewers = views.filter((view) => isReviewer(firstUserText(view)));
    const main = views.find((view) => !reviewers.includes(view));
    const first = inputs[0];
    const skills = first === undefined ? [] : (await createWorkerResources(first)).resourceLoader.getSkills().skills.map((skill) => skill.name);
    // A reviewer that is asked a second time in its session (a retry) has the same first message; it is one session.
    const distinct = reviewers.filter((view, index) => reviewers.findIndex((other) => firstUserText(other) === firstUserText(view)) === index);
    const reviewSessions = distinct.map((view): GoldenReviewSession => {
      const prompt = firstUserText(view);
      return { role: prompt.startsWith(FEEDBACK_CRITIC) ? "FEEDBACK" : /Review role: SECURITY\./.test(prompt) ? "SECURITY" : "CRITIC", prompt: normalize(prompt), tools: view.tools };
    });
    // A REVIEW run opens a read-only session of its own for the invocation's prompt, then one session per reviewer; a
    // FEEDBACK_REVIEW run has only its critic, so it has no main session.
    return {
      piInputs: main === undefined ? null : { systemPrompt: normalize(main.systemPrompt), tools: main.tools, skills },
      reviewSessions,
      workerRun,
    };
  } finally {
    if (stateBefore === undefined) delete process.env.AGENTX_WORKER_STATE_DIR; else process.env.AGENTX_WORKER_STATE_DIR = stateBefore;
    await workspace.cleanup();
  }
}

// ---- the broker half ----

const operationsOf = (db: { find(predicate: (item: Record<string, unknown>) => boolean): Array<Record<string, unknown>> }, workspaceId: string) =>
  db.find((item) => item.pk === `WORKSPACE#${workspaceId}` && item.entityType === "OPERATION");

type Db = Awaited<ReturnType<typeof createDeveloperTaskBroker>>["db"];

interface BrokerHandles {
  db: Db;
  handler: Awaited<ReturnType<typeof createDeveloperTaskBroker>>["handler"];
  access: ReturnType<typeof fakeModelAccess> | undefined;
}

type Captured = Omit<GoldenRecord, "scenario">;

const USAGE_EVENT_TIME = "2026-10-20T00:00:00.000Z";
const MODEL_ACCESS_METHODS = ["upsertOrg", "upsertMember", "spend", "orgSpend", "keySpend", "mintKey", "revokeKey"] as const;

/** Every call the proxy received so far, by method. */
function proxyCalls(access: NonNullable<BrokerHandles["access"]>): { [method: string]: Json[] } {
  return Object.fromEntries(MODEL_ACCESS_METHODS.map((method) => [method, access[method].mock.calls.map((args: unknown[]) => canonical(args))]));
}

/**
 * Ends the operation the way a worker's run does: its usage event, then its terminal result. Then the stream writer makes the
 * usage and failure index items from what the table recorded, and every write it does is kept. A ChatGPT task reports usage
 * on the plan's model.
 */
async function endOperation(handles: BrokerHandles, workspaceId: string, operationId: string, status: "SUCCEEDED" | "FAILED", chatgpt: boolean): Promise<NonNullable<GoldenRecord["afterRun"]>> {
  const { db, handler } = handles;
  const capability = (db.find((item) => item.entityType === "OUTBOX" && item.operationId === operationId)[0]?.invocation as { callbackCapability: string }).callbackCapability;
  const stream = recordStream(db);
  const payload = { schemaVersion: 1, outcome: status, provider: chatgpt ? "openai" : "amazon-bedrock", modelId: chatgpt ? "gpt-6.1-sol" : "default-model", cacheRetention: "short",
    tokens: { input: 1200, output: 300, cacheRead: 400, cacheWrite: 100, total: 2000 }, cacheReadRatio: 0.25, costUsd: 0.0421 };
  const posted = await call(handler, { method: "POST", path: `/v1/internal/workspaces/${workspaceId}/operations/${operationId}/events`,
    headers: { "x-agentx-callback-capability": capability }, body: { events: [{ type: "usage", timestamp: USAGE_EVENT_TIME, payload }] } });
  if (posted.status !== 200) throw new Error(`the usage event was refused: ${JSON.stringify(posted.body)}`);
  await finishOperation(handler, db, workspaceId, operationId, status);
  const writes: Json[] = [];
  const noteWrite = (change: "INSERT" | "MODIFY" | "REMOVE", item: Record<string, unknown> | undefined) =>
    writes.push(canonical({ change, pk: item?.pk, sk: item?.sk, entityType: item?.entityType }));
  const stopListening = db.onWrite(({ before, after }) => noteWrite(before === undefined ? "INSERT" : after === undefined ? "REMOVE" : "MODIFY", after ?? before));
  let result: Json;
  try {
    result = canonical(await indexActivity(stream.take(), {
      get: async (key) => db.get(key.pk, key.sk),
      put: async (item) => { noteWrite(db.get(item.pk as string, item.sk as string) === undefined ? "INSERT" : "MODIFY", item); db.set(item); },
    }, () => undefined, undefined, TEST_ORG));
  } finally {
    stopListening();
  }
  return {
    status,
    operation: canonical(db.get(`WORKSPACE#${workspaceId}`, `OPERATION#${operationId}`)),
    usageEvent: canonical(db.find((item) => item.entityType === "EVENT" && item.type === "usage" && item.operationId === operationId)[0]),
    indexResult: result,
    indexItems: db.find((item) => item.entityType === "USAGE_INDEX" || item.entityType === "FAILURE_INDEX").map(canonical),
    indexWrites: writes,
  };
}

/**
 * The operation's outbox item, its invocation, the invocation as the EC2 delivery posts it, what the worker's models are
 * offered, the model key its capability asks for, and (unless `end` is false) what happens when the operation ends.
 */
async function captureOperation(handles: BrokerHandles, workspaceId: string, operationId: string, taskId?: string, options: { end?: "SUCCEEDED" | "FAILED" | false } = {}): Promise<Captured> {
  const { db, handler, access } = handles;
  const operation = db.get(`WORKSPACE#${workspaceId}`, `OPERATION#${operationId}`);
  const outbox = db.find((item) => item.entityType === "OUTBOX" && item.operationId === operationId)[0];
  if (operation === undefined || outbox === undefined) throw new Error(`no operation or outbox item for ${operationId}`);
  const invocation = WorkerInvocationSchema.parse(outbox.invocation);
  const posted: string[] = [];
  const delivery = await createEc2Delivery({
    applicationPlanNotNegotiated: async () => undefined,
    planQualityNotNegotiated: async () => undefined, setupRecipesNotNegotiated: async () => undefined,
    sessions: { ensureSession: async () => ({ ready: true as const, generation: 1, privateIp: "10.0.0.7" }) },
    binding: async () => ({ deploymentMode: "ec2-ebs" }) as never,
    sign: async () => new Uint8Array(64).fill(7),
    post: async (_url, init) => { posted.push(init.body); return { status: 200, body: "{}" }; },
    progress: async () => undefined,
    workerFeatures: async () => WORKER_INVOCATION_FEATURES,
    now: () => Date.parse(GOLDEN_CLOCK),
  })(outbox as unknown as Ec2OutboxRecord, invocation);
  if (delivery !== "DELIVERED" || posted.length !== 1) throw new Error(`the delivery of ${operationId} was ${JSON.stringify(delivery)}`);
  const forWorker = WorkerInvocationSchema.parse(JSON.parse(posted[0]!));
  // The task's own items as the operation started; the end of the operation below may change them.
  const taskItems = taskId === undefined ? undefined : db.find((item) => item.pk === `DEVTASK#${taskId}`).map(canonical);
  let key: { status: number; response: Json } | undefined;
  if (access !== undefined) {
    // The model key the worker would ask this operation's capability for (a task's key is capped at the task's budget).
    const asked = await call(handler, { method: "GET", path: "/v1/internal/model-access", headers: { "x-agentx-callback-capability": invocation.callbackCapability } });
    key = { status: asked.status, response: canonical(asked.body) };
  }
  const worker = await workerHalf(forWorker);
  const status = options.end ?? "SUCCEEDED";
  const afterRun = status === false ? undefined : await endOperation(handles, workspaceId, operationId, status, invocation.kind === "task" && invocation.payload.chatgpt !== undefined);
  return {
    operation: canonical(operation), outbox: canonical(outbox), invocation: canonical(invocation), forWorker: canonical(forWorker),
    ...worker,
    ...(taskItems === undefined ? {} : { taskItems }),
    ...(access === undefined || key === undefined ? {} : { modelAccess: { ...key, mintKeyCalls: access.mintKey.mock.calls.map((callArguments) => canonical(callArguments[0])), calls: proxyCalls(access) } }),
    ...(afterRun === undefined ? {} : { afterRun }),
  };
}

/** What the developer-task scenarios add to the broker's inputs while `recordGolden` runs (Plan 3 Task 15 records them with `agents: {}`). */
let recordingBrokerExtra: Record<string, unknown> = {};

export async function developerBroker(proxy: boolean, brokerExtra: Record<string, unknown> = {}) {
  const access = proxy ? fakeModelAccess() : undefined;
  const harness = await createSingleAnswerPlanBroker({ brokerExtra: { ...(access === undefined ? {} : { modelAccess: { access, proxyUrl: PROXY_URL }, cloud: true }), ...recordingBrokerExtra, ...brokerExtra } });
  if (access !== undefined) {
    access.setMemberSpent(TEST_ORG, MAYA.developerId, 0);
    access.setOrgSpent(TEST_ORG, 0);
  }
  const handles: BrokerHandles = { db: harness.db, handler: harness.handler, access };
  const start = async (extra: Record<string, unknown> = {}) => {
    const started = await harness.dev(MAYA, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions: "Fix the retry bug", client: "test-client", ...extra });
    if (started.status !== 200) throw new Error(`the start was refused: ${JSON.stringify(started.body)}`);
    const taskId = String((started.body.task as { taskId: string }).taskId);
    const workspaceId = String((harness.db.get(`DEVTASK#${taskId}`, "META") as { workspaceId: string }).workspaceId);
    return { taskId, workspaceId };
  };
  const preparedBase = async () => ({ result: { preparedBase: [{ repositoryId: "demo", baseCommitSha: await fixtureBaseCommit() }] } });
  const finishPrepare = async (workspaceId: string) => {
    const prepare = operationsOf(harness.db, workspaceId).find((item) => item.kind === "prepare");
    await harness.finish(workspaceId, String(prepare!.id), "SUCCEEDED", await preparedBase());
  };
  const operationWhere = (workspaceId: string, predicate: (item: Record<string, unknown>) => boolean) => {
    const found = operationsOf(harness.db, workspaceId).filter(predicate).at(-1);
    if (found === undefined) throw new Error("the scenario's operation was not made");
    return String(found.id);
  };
  return { harness, handles, start, finishPrepare, operationWhere, access };
}

export type DeveloperBroker = Awaited<ReturnType<typeof developerBroker>>;

/** Finishes the planning step with a structured plan document and returns the stored plan's digest (the owner's approval names it). */
export async function finishPlanning(broker: DeveloperBroker, taskId: string, workspaceId: string, operationId: string): Promise<{ digest: string; revision: number }> {
  await broker.harness.artifact(workspaceId, operationId, "plan.md", planAnswer(planDocument()));
  await broker.harness.finish(workspaceId, operationId, "SUCCEEDED", { result: { workflowMode: "PLAN" } });
  const waiting = (await broker.harness.dev(MAYA, "GET", `/v1/dev/tasks/${taskId}`)).body.task as { workflow: { revision: number; artifacts: Array<{ sha256: string }> } };
  return { digest: String(waiting.workflow.artifacts.at(-1)!.sha256), revision: waiting.workflow.revision };
}

export const decide = (broker: DeveloperBroker, taskId: string, plan: { digest: string; revision: number }, decision: "APPROVE" | "REQUEST_CHANGES", reason: string) =>
  broker.harness.dev(MAYA, "POST", `/v1/dev/tasks/${taskId}/workflow/decision`, {
    requestId: randomUUID(), expectedRevision: plan.revision, decision, reason, artifactDigest: plan.digest, ...(decision === "APPROVE" ? runLimitAck(broker.harness.db, taskId) : {}),
  });

const REQUIRED_CHECK = { id: "required-1", label: "npm test", command: { cwd: "repo/demo", executable: "npm", args: ["test"], timeoutSeconds: 30 } };

/** Sets the task's check policy, as the planning step's approved checks would. */
function requireCheck(broker: DeveloperBroker, taskId: string): void {
  const record = broker.harness.db.get(`DEVTASK#${taskId}`, "META") as Record<string, unknown> & { workflow: Record<string, unknown> };
  broker.harness.db.set({ ...record, workflow: { ...record.workflow, checkPolicy: { required: [REQUIRED_CHECK], optional: [], selectedOptionalIds: [] } } });
}

/** A Quick task approved and implemented; returns the task, its ids and the finished candidate. */
async function implementedQuickTask(broker: DeveloperBroker) {
  const { taskId, workspaceId } = await broker.start({ workflow: true, workflowPath: "QUICK" });
  requireCheck(broker, taskId);
  await broker.finishPrepare(workspaceId);
  const plan = await finishPlanning(broker, taskId, workspaceId, broker.operationWhere(workspaceId, (item) => item.workflowMode === "PLAN"));
  const approved = await decide(broker, taskId, plan, "APPROVE", "Approved");
  if (approved.status !== 200) throw new Error(`the approval was refused: ${JSON.stringify(approved.body)}`);
  const implementationId = broker.operationWhere(workspaceId, (item) => item.workflowMode === "IMPLEMENT");
  const base = await fixtureBaseCommit();
  const candidate = createCandidateManifest([{ repositoryId: "demo", commitSha: "d".repeat(40), treeSha: "b".repeat(40), baseCommitSha: base }]);
  const checks = { status: "verified", source: "project", preambleVersion: "1", preambleSha256: "c".repeat(64),
    checks: [{ id: "readiness:0", label: "npm test", source: "project", before: "passed", after: "passed", class: "passing", output: "", durationMs: 12 }], extraTry: "not_needed", agentClaim: "success" };
  // `unverified`: the agent reported no checks, which blocks the task at its checks.
  const finishImplementation = (options: { unverified?: boolean } = {}) => broker.harness.finish(workspaceId, implementationId, "SUCCEEDED", { result: options.unverified === true
    ? { workflowCandidateRepositories: candidate.repositories,
        checks: { status: "not_verified", notVerifiedReason: "no_checks", source: "none", preambleVersion: "1", preambleSha256: "c".repeat(64), checks: [], extraTry: "not_needed", agentClaim: "failure" } }
    : { workflowCandidateRepositories: candidate.repositories, workflowCheckCandidateRepositories: candidate.repositories, checks } });
  return { taskId, workspaceId, plan, implementationId, candidate, finishImplementation };
}

async function recordPlan(broker: DeveloperBroker, phase: "QUICK" | "REQUIREMENTS" | "DESIGN" | "IMPLEMENTATION_PLAN"): Promise<Captured> {
  const { taskId, workspaceId } = await broker.start({ workflow: true, workflowPath: phase === "QUICK" ? "QUICK" : "FULL" });
  await broker.finishPrepare(workspaceId);
  const planning = () => broker.operationWhere(workspaceId, (item) => item.workflowMode === "PLAN" && item.status === "ACCEPTED");
  const earlierPhases = phase === "QUICK" || phase === "REQUIREMENTS" ? 0 : phase === "DESIGN" ? 1 : 2;
  for (let done = 0; done < earlierPhases; done += 1) {
    const plan = await finishPlanning(broker, taskId, workspaceId, planning());
    const approved = await decide(broker, taskId, plan, "APPROVE", "Approved");
    if (approved.status !== 200) throw new Error(`the approval was refused: ${JSON.stringify(approved.body)}`);
  }
  return captureOperation(broker.handles, workspaceId, planning(), taskId, { end: "FAILED" });
}

async function brokerScenario(scenario: GoldenScenario): Promise<Captured> {
  switch (scenario) {
    case "plan-quick": return recordPlan(await developerBroker(true), "QUICK");
    case "plan-full-requirements": return recordPlan(await developerBroker(true), "REQUIREMENTS");
    case "plan-full-design": return recordPlan(await developerBroker(true), "DESIGN");
    case "plan-full-implementation-plan": return recordPlan(await developerBroker(true), "IMPLEMENTATION_PLAN");
    case "plan-review-decision": {
      const broker = await developerBroker(true);
      const { taskId, workspaceId } = await broker.start({ workflow: true, workflowPath: "QUICK" });
      await broker.finishPrepare(workspaceId);
      const plan = await finishPlanning(broker, taskId, workspaceId, broker.operationWhere(workspaceId, (item) => item.workflowMode === "PLAN"));
      const first = broker.operationWhere(workspaceId, (item) => item.workflowMode === "PLAN");
      const response = await decide(broker, taskId, plan, "REQUEST_CHANGES", "Use the existing helper.");
      if (response.status !== 200) throw new Error(`the decision was refused: ${JSON.stringify(response.body)}`);
      const replanning = broker.operationWhere(workspaceId, (item) => item.workflowMode === "PLAN" && item.id !== first);
      const record = await captureOperation(broker.handles, workspaceId, replanning, taskId, { end: "FAILED" });
      const workflow = (response.body.task as { workflow: { stage: string; state: string; revision: number } }).workflow;
      return { ...record, decision: canonical({ status: response.status, stage: workflow.stage, state: workflow.state, revision: workflow.revision }) };
    }
    case "implement": {
      const broker = await developerBroker(true);
      const { taskId, workspaceId } = await broker.start({ workflow: true, workflowPath: "QUICK" });
      requireCheck(broker, taskId);
      await broker.finishPrepare(workspaceId);
      const plan = await finishPlanning(broker, taskId, workspaceId, broker.operationWhere(workspaceId, (item) => item.workflowMode === "PLAN"));
      const response = await decide(broker, taskId, plan, "APPROVE", "Approved");
      if (response.status !== 200) throw new Error(`the approval was refused: ${JSON.stringify(response.body)}`);
      return captureOperation(broker.handles, workspaceId, broker.operationWhere(workspaceId, (item) => item.workflowMode === "IMPLEMENT"), taskId, { end: "SUCCEEDED" });
    }
    case "checks": {
      const broker = await developerBroker(true);
      const { taskId, workspaceId, finishImplementation } = await implementedQuickTask(broker);
      // The code is blocked at its checks (the agent reported none), and the owner asks AgentX to run the selected checks again.
      await finishImplementation({ unverified: true });
      const blocked = (broker.harness.db.get(`DEVTASK#${taskId}`, "META") as { workflow: { revision: number } }).workflow;
      const retried = await broker.harness.dev(MAYA, "POST", `/v1/dev/tasks/${taskId}/workflow/retry`, { requestId: randomUUID(), expectedRevision: blocked.revision, instructions: "Run the checks again." });
      if (retried.status !== 200) throw new Error(`the retry was refused: ${JSON.stringify(retried.body)}`);
      return captureOperation(broker.handles, workspaceId, broker.operationWhere(workspaceId, (item) => item.workflowMode === "CHECKS"), taskId, { end: "SUCCEEDED" });
    }
    case "review": {
      const broker = await developerBroker(true);
      const { taskId, workspaceId, finishImplementation } = await implementedQuickTask(broker);
      await finishImplementation();
      return captureOperation(broker.handles, workspaceId, broker.operationWhere(workspaceId, (item) => item.workflowMode === "REVIEW"), taskId, { end: "FAILED" });
    }
    case "feedback-review": return feedbackReviewScenario();
    case "task-no-workflow": return plainTask(await developerBroker(true), {});
    case "task-no-workflow-no-proxy": return plainTask(await developerBroker(false), {});
    case "shared-task": return plainTask(await developerBroker(true), { shareToChannel: true, shareMode: "view" });
    case "slack-thread-operation": return slackThreadOperation(false);
    case "chatgpt-task": return slackThreadOperation(true);
    case "orchestrator-turn": return orchestratorScenario();
    case "plan-ready-quick": return planReady("QUICK");
    case "plan-ready-full": return planReady("FULL");
  }
}

/** A task started with no workflow: after preparation its prompt runs as the task's one operation. */
async function plainTask(broker: DeveloperBroker, extra: Record<string, unknown>): Promise<Captured> {
  const { taskId, workspaceId } = await broker.start(extra);
  await broker.finishPrepare(workspaceId);
  return captureOperation(broker.handles, workspaceId, broker.operationWhere(workspaceId, (item) => item.kind === "task"), taskId, { end: "SUCCEEDED" });
}

// ---- the plan-ready message (change 4) ----

/**
 * A shared workflow task whose planning step ends with a plan: the notifier (over the real stream records, with Slack faked)
 * posts the task's messages, among them "<document> is ready for your approval". The record's operation is the planning step;
 * its `taskItems` and `modelAccess.calls` are taken after the plan was announced.
 */
async function planReady(path: "QUICK" | "FULL"): Promise<Captured> {
  const broker = await developerBroker(true);
  const stream = recordStream(broker.harness.db);
  const posts: Json[] = [];
  const queue: Array<{ notice: Notice; attempt: number }> = [];
  let ts = 1_695_500_000_000_100;
  const handle = createNotifierHandler({
    documentClient: broker.harness.db, tableName: "state",
    enqueue: async (notices) => { for (const notice of notices) queue.push({ notice, attempt: 0 }); },
    retryLater: async () => undefined,
    post: async (input) => { posts.push(canonical(input)); ts += 1; const text = String(ts); return { ts: `${text.slice(0, 10)}.${text.slice(10)}` }; },
    update: async () => undefined, postEphemeral: async () => undefined,
    readArtifact: async (key) => {
      const body = broker.harness.s3.objects.get(key);
      if (body === undefined) throw new Error(`no stored document at ${key}`);
      return body;
    },
    now: () => Date.parse(GOLDEN_CLOCK), log: () => undefined, deliveryFailed: () => undefined,
  });
  const pump = async () => {
    await handle({ Records: stream.take().map((record) => ({ ...record, eventSource: "aws:dynamodb" })) });
    const batch = queue.splice(0, queue.length);
    await handle({ Records: batch.map((entry, index) => ({ eventSource: "aws:sqs", messageId: `m${index}`, receiptHandle: `r${index}`, body: JSON.stringify(entry.notice), attributes: { ApproximateReceiveCount: "1" } })) });
  };
  const { taskId, workspaceId } = await broker.start({ shareToChannel: true, workflow: true, workflowPath: path });
  await pump();
  await broker.finishPrepare(workspaceId);
  await pump();
  const planning = broker.operationWhere(workspaceId, (item) => item.workflowMode === "PLAN");
  const record = await captureOperation(broker.handles, workspaceId, planning, taskId, { end: false });
  await finishPlanning(broker, taskId, workspaceId, planning);
  await pump();
  // The task's items and the proxy's calls are those after the plan was made and announced, where the plan-ready message's
  // estimate (change 4, Task 34's `task.runEstimate`) lands.
  const { access } = broker;
  return {
    ...record,
    taskItems: broker.harness.db.find((item) => item.pk === `DEVTASK#${taskId}`).map(canonical),
    ...(access === undefined || record.modelAccess === undefined ? {} : { modelAccess: { ...record.modelAccess, calls: proxyCalls(access) } }),
    notifications: posts,
  };
}

// ---- a task whose candidate is waiting for merge, and the critic that reads the pull request's feedback ----

async function feedbackReviewScenario(): Promise<Captured> {
  const currentFeedback = { pullRequest: { number: 7, url: "https://github.com/example/demo/pull/7", state: "open" as const,
    headBranch: "feature", baseBranch: "main", headCommit: "a".repeat(40), headTreeSha: "b".repeat(40), title: "Fix retry", body: "" }, comments: [], threads: [] };
  const broker = await developerBroker(true, { githubPullRequests: { getPullRequestFeedback: async () => currentFeedback } });
  const { harness } = broker;
  const { taskId, workspaceId } = await broker.start({ workflow: true, workflowPath: "QUICK" });
  const base = await fixtureBaseCommit();
  await broker.finishPrepare(workspaceId);
  await harness.finish(workspaceId, broker.operationWhere(workspaceId, (item) => item.workflowMode === "PLAN"), "FAILED", { error: "the scenario moves the workspace on without a plan" });
  const task = harness.db.get(`DEVTASK#${taskId}`, "META") as Record<string, unknown> & { ownerKey: string };
  const candidate = createCandidateManifest([{ repositoryId: "demo", commitSha: "a".repeat(40), treeSha: "b".repeat(40), baseCommitSha: base }]);
  const now = GOLDEN_CLOCK.replace("Z", ".000Z");
  const planContent = "Approved plan: address the linked PR feedback after owner approval.";
  const planSha = createHash("sha256").update(planContent).digest("hex");
  const planKey = `private/${task.ownerKey}/${workspaceId}/approved-plan.md`;
  harness.s3.objects.set(planKey, planContent);
  let workflow = WorkflowSnapshotSchema.parse({
    ...createWorkflowSnapshot({ taskId, ownerId: task.ownerKey, now }),
    stage: "WAIT_FOR_MERGE", state: "WAITING", candidate,
    artifacts: [{ id: "plan-v1", type: "plan", version: 1, sha256: planSha, producer: "agentx-owner-approved", objectKey: planKey, createdAt: now }],
    decisions: [{ requestId: randomUUID(), workflowRevision: 1, decision: "APPROVE", actorId: task.ownerKey, actorRole: "TASK_OWNER", reason: "Approved plan", artifactDigest: planSha, at: now }],
    verification: { candidateDigest: candidate.digest, producer: "broker", environmentId: workspaceId, recordedAt: now, results: [{ checkId: "unit", status: "PASS" }] },
    reviews: ["CRITIC", "SECURITY"].map((role) => ({ operationId: randomUUID(), candidateDigest: candidate.digest, role, provider: "test", version: "1", status: "PASS", findings: [], readOnly: true, recordedAt: now })),
    pullRequests: [{ repositoryId: "demo", number: 7, url: "https://github.com/example/demo/pull/7", headSha: "a".repeat(40), candidateDigest: candidate.digest, required: true, state: "OPEN" }],
  });
  const bundle = WorkflowFeedbackBundleSchema.parse({ schemaVersion: 1, taskId, repositoryId: "demo", number: 7, headSha: "a".repeat(40), headTreeSha: "b".repeat(40),
    candidateDigest: candidate.digest, commentSetDigest: createHash("sha256").update("[]").digest("hex"), producer: "agentx-github-reconciler", version: "1", recordedAt: now,
    comments: [], sourceDeliveryIds: ["delivery-test"] });
  const bundleBytes = JSON.stringify(bundle);
  const bundleDigest = createHash("sha256").update(bundleBytes).digest("hex");
  const bundleKey = `private/${task.ownerKey}/${workspaceId}/feedback/${bundleDigest}.json`;
  harness.s3.objects.set(bundleKey, bundleBytes);
  workflow = collectWorkflowFeedbackBundles(workflow, { bundleRefs: [{ ...without(bundle, "sourceDeliveryIds", "comments"), sha256: bundleDigest, objectKey: bundleKey, comments: bundle.comments }], threadObservations: [] }, now);
  harness.db.set({ ...task, workflow, updatedAt: now });
  const routeDeps = { documentClient: harness.db, tableName: "state", actions: harness.actions, orgId: TEST_ORG,
    checkAccess: async () => ({ revision: 1, policy: {} as never, access: "granted" as const, channelIds: [], role: "contributor" as const }), projectChannelIds: async () => [], now: () => Date.parse(now) };
  if (!await startTaskWorkflowFeedbackReviewFromWebhook(routeDeps, taskId)) throw new Error("the feedback critic did not start");
  return captureOperation(broker.handles, workspaceId, broker.operationWhere(workspaceId, (item) => item.workflowMode === "FEEDBACK_REVIEW"), taskId, { end: "FAILED" });
}

// ---- Slack threads ----

const THREAD = `${SLACK_TEAM}/${SLACK_CHANNEL}/1695500000.000001`;
const SLACK_USER = "U0123456789";
export const GOLDEN_THREAD_MODELS={default:{provider:"amazon-bedrock",modelId:"us.anthropic.claude-sonnet-4-6",label:"Balanced"},approved:[{provider:"amazon-bedrock",modelId:"us.anthropic.claude-sonnet-4-6",label:"Balanced"},{provider:"openai",modelId:"gpt-6.1-sol",label:"Personal plan"}]};

/** A task the Slack orchestrator starts in a thread's workspace; with `chatgpt`, its asker has a working ChatGPT plan and the install's switch is on. */
async function slackThreadOperation(chatgpt: boolean): Promise<Captured> {
  await loadSlackBroker();
  const access = fakeModelAccess();
  const owner = developerIdForSlackUser(SLACK_USER);
  const connections = chatgpt ? {
    settings: async () => ({ enabled: true, preferredModel: "gpt-6.1-sol" }),
    view: async () => ({ connected: true, status: "connected", connectedAt:"2026-10-01T00:00:00.000Z", email: "maya@example.test", models: ["gpt-5.5", "gpt-6.1-sol"] }),
    accessToken: async () => ({ access: "never-recorded", expiresAt: Date.parse("2026-10-20T01:00:00.000Z"), models: [] }),
    markStatus: async () => undefined, refreshModels: async () => undefined,
  } as unknown as ChatGptConnections : undefined;
  const { handler, db } = createBroker({ extra: { modelAccess: { access, proxyUrl: PROXY_URL }, cloud: true, ...(connections === undefined ? {} : { chatgpt: connections }) } });
  await registerSlackProject(handler, { models: GOLDEN_THREAD_MODELS });
  access.setMemberSpent(TEST_ORG, owner, 0);
  access.setOrgSpent(TEST_ORG, 0);
  const workspace = await ensureWorkspace(handler, THREAD, SLACK_USER);
  const workspaceId = workspace.body.workspaceId as string;
  markReady(db, workspaceId);
  const conversation = await serviceCall(handler, THREAD, SLACK_USER, "POST", `/v1/service/workspaces/${workspaceId}/conversations`, {});
  const conversationId = (conversation.body.conversation as { id: string }).id;
  const task = await serviceCall(handler, THREAD, SLACK_USER, "POST", `/v1/service/workspaces/${workspaceId}/tasks`, { requestId: randomUUID(), conversationId, prompt: "Fix the retry bug" });
  if (task.status !== 202) throw new Error(`the thread task was refused: ${JSON.stringify(task.body)}`);
  return captureOperation({ db, handler, access }, workspaceId, (task.body.operation as { id: string }).id, undefined, { end: "SUCCEEDED" });
}

// ---- the Slack assistant's turn ----

async function orchestratorScenario(): Promise<Captured> {
  await loadSlackBroker();
  const access = fakeModelAccess();
  const { handler } = createBroker({ extra: { modelAccess: { access, proxyUrl: PROXY_URL }, cloud: true } });
  await registerSlackProject(handler);
  access.setMemberSpent(TEST_ORG, developerIdForSlackUser(SLACK_USER), 0);
  access.setOrgSpent(TEST_ORG, 0);
  const turnId = "EvGolden0001";
  const response = await call(handler, { method: "POST", path: "/v1/service/model-access", service: { principal: orchestratorPrincipal, thread: THREAD, slackUser: SLACK_USER }, body: { orgId: TEST_ORG, turnId } });
  const { modelRuntime, faux } = await fauxModelRuntime();
  const views: ModelView[] = [];
  faux.setResponses([(context) => { views.push(modelView(context)); return fauxAssistantMessage("Done."); }]);
  const stateDirectory = await createFixtureDirectory("agentx-golden-orchestrator-");
  const catalog = { connector: "github", skipped: [], tools: [{ name: "github__list_issues", upstreamName: "list_issues", description: "List issues.", access: "read" as const,
    scopes: [{ alias: "demo", schemaHash: "a".repeat(64) }], inputSchema: { type: "object", properties: { state: { type: "string" } }, required: [] } }] };
  try {
    const runtime = await createOrchestratorRuntime({
      stateDirectory, projectInstructions: "Delegate work (revision 1).", modelRuntime,
      api: { discoverConnectorTools: async () => catalog, callConnectorTool: async () => ({ content: [] }) } as unknown as OrchestrationApi,
      context: { workspaceId: "00000000-0000-4000-8000-0000000000aa", conversationId: "00000000-0000-4000-8000-0000000000bb" },
      model: FAUX_MODEL, replySurface: "slack", repositories: ["demo"],
      connectors: [{ name: "github", type: "github", label: "GitHub issues", scopes: ["demo"], connected: true }],
    });
    await runOrchestratorTurn(runtime, "Please fix the retry bug in the payments project.");
    runtime.session.dispose();
  } finally {
    await rm(stateDirectory, { recursive: true, force: true });
  }
  const view = views[0];
  if (view === undefined) throw new Error("the orchestrator never called its model");
  return {
    operation: null, outbox: null, invocation: null, forWorker: null, piInputs: null, reviewSessions: [],
    orchestratorTurn: {
      modelAccessResponse: canonical({ status: response.status, body: response.body, mintKeyCalls: access.mintKey.mock.calls.map((callArguments) => callArguments[0]) }),
      tools: view.tools,
      systemPrompt: view.systemPrompt.split(stateDirectory).join("<state>"),
    },
  };
}

// ---- the public interface ----

/**
 * Records one scenario, with the clock fixed at 2026-10-20T00:00:00Z and the ids seeded for the scenario. Only Date is faked,
 * so timers and promises behave as they always do.
 */
export async function recordGolden(scenario: GoldenScenario, options: { brokerExtra?: Record<string, unknown> } = {}): Promise<GoldenRecord> {
  seedGoldenIds(GOLDEN_SCENARIOS.indexOf(scenario) + 1);
  vi.useFakeTimers({ now: new Date(GOLDEN_CLOCK), toFake: ["Date"] });
  recordingBrokerExtra = options.brokerExtra ?? {};
  try {
    const record = await brokerScenario(scenario);
    return canonical({ ...record, scenario }) as unknown as GoldenRecord;
  } finally {
    recordingBrokerExtra = {};
    vi.useRealTimers();
  }
}

const fixturePath = (name: string) => join(FIXTURE_DIRECTORY, `${name}.json`);
export const updatingGolden = (): boolean => process.env.UPDATE_GOLDEN === "1";

/** The record as it is stored: sorted keys, two-space indent and a final newline. */
export function goldenText(record: unknown): string {
  return `${JSON.stringify(canonical(record), null, 2)}\n`;
}

type PathStep = string | number;
function steps(path: string): PathStep[] {
  return path.split(/\.|\[(\d+)\]/).filter((part): part is string => part !== undefined && part !== "").map((part) => (/^\d+$/.test(part) ? Number(part) : part));
}
function valueAt(root: unknown, path: string): { found: boolean; value?: unknown } {
  let current = root;
  for (const step of steps(path)) {
    if (current === null || typeof current !== "object" || !(step in (current))) return { found: false };
    current = (current as Record<PathStep, unknown>)[step];
  }
  return { found: true, value: current };
}
function withoutPath<T>(root: T, path: string): T {
  const copy = structuredClone(root);
  const all = steps(path);
  let current: unknown = copy;
  for (const step of all.slice(0, -1)) {
    if (current === null || typeof current !== "object") return copy;
    current = (current as Record<PathStep, unknown>)[step];
  }
  const last = all.at(-1);
  if (current !== null && typeof current === "object" && last !== undefined) {
    if (Array.isArray(current) && typeof last === "number") current.splice(last, 1); else delete (current as Record<PathStep, unknown>)[last];
  }
  return copy;
}

/**
 * Compares a record with its fixture. A listed path must equal `expected` exactly (`undefined` means the path is absent), and
 * is left out of the comparison with the fixture; everything else must equal the fixture. `change` names the item of the
 * plan's "Deliberate changes" the path belongs to. With UPDATE_GOLDEN=1 the fixture is written instead and nothing is compared.
 */
export function expectGolden(name: GoldenScenario, record: unknown, deliberate: Array<{ path: string; expected: unknown; change: 1 | 2 | 3 | 4 | 5 | 6 | 7 }> = []): void {
  if (updatingGolden()) {
    mkdirSync(FIXTURE_DIRECTORY, { recursive: true });
    writeFileSync(fixturePath(name), goldenText(record));
    return;
  }
  if (!existsSync(fixturePath(name))) throw new Error(`no golden fixture for ${name}; record it with UPDATE_GOLDEN=1`);
  let expected: unknown = JSON.parse(readFileSync(fixturePath(name), "utf8"));
  let actual: unknown = JSON.parse(goldenText(record));
  for (const { path, expected: value, change } of deliberate) {
    const found = valueAt(actual, path);
    if (value === undefined) expect(found.found, `deliberate change ${String(change)}: ${path} is absent`).toBe(false);
    else {
      expect(found.found, `deliberate change ${String(change)}: ${path} is present`).toBe(true);
      expect(found.value, `deliberate change ${String(change)}: ${path}`).toEqual(JSON.parse(JSON.stringify(value)));
    }
    expected = withoutPath(expected, path);
    actual = withoutPath(actual, path);
  }
  expect(actual, `${name} against its golden fixture`).toEqual(expected);
}
