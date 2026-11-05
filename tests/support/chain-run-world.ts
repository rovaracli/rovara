import { fixtureActor, seedMaintainerGrant } from "./money-authority.js";
// Plan 4 Task 6: a world for the chain runner's tests (and the tasks after it): two orgs on one FakeDynamoDb, the agent and chain stores, project roles,
// and a recording stand-in for Plan 3's `startAgentRun` that keeps one task per request id, as the real one does. Nothing here is the runner: the tests
// call `startChainRun`, `advanceChainRun`, `onStepTaskEnded` and the rest, and read the records through `world.run`, `world.attempts` and `world.events`.
import { AgentStore } from "../../packages/broker/src/agents/store.js";
import { addToRoster } from "../../packages/broker/src/agents/roster.js";
import type { AgentCaller, AgentAccessDeps } from "../../packages/broker/src/agents/access.js";
import type { AgentRunRequest, AgentRunResult } from "../../packages/broker/src/agents/runs.js";
import type { TaskEndEvent, TaskPauseEvent } from "../../packages/broker/src/agents/task-end.js";
import type { ChainRunRecord, ChainRunnerDependencies, StepAttemptRecord } from "../../packages/broker/src/chains/runner.js";
import type { RunEventType } from "../../packages/broker/src/chains/run-events.js";
import { ChainStore, chainDigest, type ChainRecord } from "../../packages/broker/src/chains/store.js";
import { validateChainForPublish } from "../../packages/broker/src/chains/validate.js";
import { taskAgentRunKey, taskKey, taskOwnerKey } from "../../packages/broker/src/developer/task-records.js";
import { DeveloperSignInStore } from "../../packages/broker/src/developer/store.js";
import type { AdmissionDependencies } from "../../packages/broker/src/org/budget.js";
import type { AgentOwner } from "../../packages/contracts/src/agent-node.js";
import type { RecipeOverlay } from "../../packages/contracts/src/agent-recipe-node.js";
import { ChainDefinitionSchema, type ChainDefinitionInput } from "../../packages/contracts/src/chains.js";
import type { OrgId, OrgRole } from "../../packages/contracts/src/org.js";
import { orgMemberKey } from "../../packages/contracts/src/org-node.js";
import { chainRunKey, orgProjectCatalogKey, runRequestKey } from "../../packages/contracts/src/org-scoped-keys.js";
// The package the broker imports, not its source: an error must be an instance of the class the broker tests for.
import { agentXError, type AgentXError } from "@agentx/contracts";
import { FakeDynamoDb } from "./fake-dynamodb.js";
import { fakeModelAccess } from "./fake-model-access.js";
import { FakeProjectMembers } from "./fake-project-members.js";
import { TEST_ORG } from "./orgs.js";

export const ORG_A = TEST_ORG;
export const ORG_B = "org_bbbbbbbbbbbbbbbbbbbb" as OrgId;
export const PRIYA = "a".repeat(64); // a member, contributor on web
export const MAX = "b".repeat(64); // a member, maintainer of web
export const CARL = "c".repeat(64); // a member, contributor on web
export const DANA = "d".repeat(64); // an org admin
export const VIV = "e".repeat(64); // a member, viewer on web
export const ARJUN = "f".repeat(64); // a member with no role on web
export const STRANGER = "1".repeat(64); // a member of org B
export const ROLES: Record<string, OrgRole> = { [PRIYA]: "member", [MAX]: "member", [CARL]: "member", [DANA]: "admin", [VIV]: "member", [ARJUN]: "member" };
export const NAMES: Record<string, string> = { [PRIYA]: "Priya", [MAX]: "Max", [CARL]: "Carl", [DANA]: "Dana", [VIV]: "Viv", [ARJUN]: "Arjun" };
export const START = Date.parse("2026-10-22T09:00:00.000Z");
const SCRATCH: RecipeOverlay = { instructions: "x", sequence: [{ id: "work", name: "Work", kind: "agent", workspace: "none" }] };
const DIGEST = "d".repeat(64);

export const callerOf = (developerId: string, orgId: OrgId = ORG_A): AgentCaller => ({ orgId, developerId, orgRole: ROLES[developerId] ?? "member" });

/** One stored event of a run. */
export interface RunEventRow { seq: number; at: string; type: RunEventType; stepSeq?: number; text: string }

/** What the fake `startAgentRun` kept of one task. */
export interface FakeTask { taskId: string; request: AgentRunRequest; result: AgentRunResult }

export interface WorldOptions {
  /** Gives the runner the model proxy's admission, so a start is admitted against the chain's budget. */
  admission?: boolean;
  /** Gives the gate world the Audit Ledger's outbox (`GateWorld.audit`). */
  audit?: boolean;
}

export function setupWorld(options: WorldOptions = {}) {
  const db = new FakeDynamoDb();
  const clock = { now: START };
  let agentCounter = 0;
  let chainCounter = 0;
  const agents = new AgentStore({ documentClient: db, tableName: "T", now: () => clock.now, newId: () => `agt_${String(++agentCounter).padStart(20, "0")}` });
  const chains = new ChainStore({ documentClient: db, tableName: "T", now: () => clock.now, newId: () => `chn_${String(++chainCounter).padStart(20, "0")}`, agents });
  const projectMembers = new FakeProjectMembers();
  const signInStore = new DeveloperSignInStore({ documentClient: db, tableName: "T", now: () => clock.now });
  for (const [developerId, role] of Object.entries(ROLES)) {
    db.set({ ...orgMemberKey(ORG_A, developerId), entityType: "ORG_MEMBER", orgId: ORG_A, developerId, role, joinedAt: "2026-10-01T00:00:00.000Z" });
    db.set({ pk: `DEVELOPER#${developerId}`, sk: "META", developerId });
    projectMembers.setOrgRole(ORG_A, developerId, role);
  }
  db.set({ ...orgMemberKey(ORG_B, STRANGER), entityType: "ORG_MEMBER", orgId: ORG_B, developerId: STRANGER, role: "member", joinedAt: "2026-10-01T00:00:00.000Z" });
  for (const project of ["web", "api"]) {
    db.set({ ...orgProjectCatalogKey(ORG_A, project), entityType: "PROJECT_CATALOG", name: project });
    projectMembers.addProject(ORG_A, project);
  }
  projectMembers.grant(ORG_A, "web", PRIYA, "contributor");
  projectMembers.grant(ORG_A, "web", MAX, "maintainer");
  projectMembers.grant(ORG_A, "web", CARL, "contributor");
  projectMembers.grant(ORG_A, "web", VIV, "viewer");

  // ---- the stand-in for startAgentRun
  const starts: AgentRunRequest[] = [];
  const tasks = new Map<string, FakeTask>();
  const byRequest = new Map<string, FakeTask>();
  const hooks = {
    /** The next calls throw this instead of starting anything (a refusal, or a transient failure when it is not an AgentXError). */
    refuse: [] as Error[],
    /** The next call starts the task, then throws this before returning: the process died after the task existed. */
    crashAfterStart: [] as Error[],
    /** Called when a task has been started, before the call returns. */
    onStarted: undefined as ((task: FakeTask) => void) | undefined,
    /** The next cancel requests throw this instead of being recorded (a worker that could not be asked, or a transient outage). */
    cancelFails: [] as Error[],
  };
  /** Every request to cancel a step's task (Plan 3's cancel, as the task's owner), in order. A repeat of a request id is recorded again: Plan 3 answers it as the first. */
  const cancels: Array<{ orgId: OrgId; taskId: string; owner: { developerId: string }; requestId: string }> = [];
  const cancelTask = async (request: { orgId: OrgId; taskId: string; owner: { developerId: string }; requestId: string }): Promise<void> => {
    const failure = hooks.cancelFails.shift();
    if (failure !== undefined) throw failure;
    cancels.push(structuredClone(request));
    // Plan 3's cancel leaves its idempotency item beside the task's owner key and workspace when it takes a request (`cancelTask` in developer-tasks.ts).
    const task = db.get(taskKey(request.taskId));
    if (task !== undefined) db.set({ pk: `IDEMPOTENCY#${String(task["ownerKey"])}#${String(task["workspaceId"])}`, sk: `REQUEST#${request.requestId}`, entityType: "IDEMPOTENCY", payloadHash: "cancel" });
  };
  const startAgentRun = async (request: AgentRunRequest): Promise<AgentRunResult> => {
    starts.push(structuredClone(request));
    const refusal = hooks.refuse.shift();
    if (refusal !== undefined) throw refusal;
    const known = byRequest.get(request.requestId);
    if (known !== undefined) return known.result;
    const taskId = `task-${String(tasks.size + 1)}`;
    const limit = request.runLimitUsd ?? 20;
    const granted = Math.min(limit, 2);
    const result: AgentRunResult = { taskId, runLimitUsd: granted, stopAtUsd: granted, paused: request.runLimitUsd === 0 };
    const task: FakeTask = { taskId, request: structuredClone(request), result };
    tasks.set(taskId, task);
    byRequest.set(request.requestId, task);
    db.set({
      ...taskKey(taskId), entityType: "DEVELOPER_TASK", taskId, orgId: request.orgId, developerId: request.owner.developerId, project: request.project, ownerKey: taskOwnerKey(request.owner.developerId, taskId), workspaceId: `ws-${taskId}`,
      ...(request.chain === undefined ? {} : { chain: request.chain }),
    });
    // Plan 3's run request item, written in the start's commit: how a task is found from the request that started it.
    db.set({ ...runRequestKey(request.orgId, request.requestId), entityType: "RUN_REQUEST", orgId: request.orgId, taskId, fingerprint: "f".repeat(64), runLimitUsd: result.runLimitUsd, stopAtUsd: result.stopAtUsd, paused: result.paused });
    // An agent-step run keeps its state beside the task (a coding task has none).
    if (request.agent.agentId !== "rovara-code") db.set({ ...taskAgentRunKey(taskId), entityType: "AGENT_RUN", orgId: request.orgId, revision: 1, state: "RUNNING", cursor: 0, input: request.input, steps: [], reports: [] });
    hooks.onStarted?.(task);
    const crash = hooks.crashAfterStart.shift();
    if (crash !== undefined) throw crash;
    return result;
  };
  const callerFor = async (orgId: OrgId, developerId: string): Promise<AgentCaller | undefined> => {
    const role = orgId === ORG_A ? ROLES[developerId] : undefined;
    return role === undefined ? undefined : { orgId, developerId, orgRole: role };
  };
  const access = options.admission === true ? fakeModelAccess() : undefined;
  if (access !== undefined) access.setOrgSpent(ORG_A, 0);
  const admission: AdmissionDependencies | undefined = access === undefined ? undefined : { documentClient: db, tableName: "T", access, now: () => clock.now, cloud: false };

  // The runner's own client: it can be made to let something happen just before a transaction it is about to send (a write that lands between its reads and its write).
  const rules: Array<{ when: (command: { constructor: { name: string }; input: Record<string, unknown> }) => boolean; then: () => void | Promise<void>; times: number }> = [];
  const client = {
    send: async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
      const rule = rules.find((candidate) => candidate.times > 0 && candidate.when(command));
      if (rule !== undefined) {
        rule.times -= 1;
        await rule.then();
      }
      return db.send(command);
    },
  };
  /** Runs `then` just before the next `times` transactions whose text holds `touches`. */
  const beforeTransaction = (touches: string, then: () => void | Promise<void>, times = 1) => {
    rules.push({ when: (command) => command.constructor.name === "TransactWriteCommand" && JSON.stringify(command.input).includes(touches), then, times });
  };
  const deps: ChainRunnerDependencies = {
    store: agents, chains, projectMembers, signInStore, documentClient: client, tableName: "T", now: () => clock.now, confirmOrigin: "https://cell.example.com",
    chainRuns: { startAgentRun, callerFor, cancelTask, ...(admission === undefined ? {} : { admission }) },
  };
  const agentDeps: AgentAccessDeps = { store: agents, projectMembers, documentClient: db, tableName: "T", signInStore };

  /** Creates a chain and publishes `definition` (every agent step pinned), owned by `owner`. */
  const publish = async (definition: ChainDefinitionInput, extra: { owner?: AgentOwner; accountable?: { developerId: string }; name?: string; by?: string; budgetUsd?: number } = {}): Promise<ChainRecord> => {
    const by = extra.by ?? PRIYA;
    const owner = extra.owner ?? { kind: "member" as const, developerId: PRIYA };
    const created = await chains.create({
      orgId: ORG_A, name: extra.name ?? `Chain ${String(chainCounter + 1)}`, owner, ...(extra.accountable === undefined ? {} : { accountable: extra.accountable }), definition, createdBy: by,
    });
    const checked = await validateChainForPublish(agentDeps, callerOf(by), ORG_A, ChainDefinitionSchema.parse(definition));
    if (checked.problems.length > 0) throw new Error(`the test's chain has problems: ${JSON.stringify(checked.problems)}`);
    await chains.publish({
      orgId: ORG_A, chainId: created.chainId, expectedDraftRevision: created.draftRevision, pinned: checked.pinned, digest: chainDigest(checked.pinned), guardrailsRevision: checked.guardrailsRevision, by,
    });
    if (extra.budgetUsd !== undefined) {
      // A member who sets the budget of a project's chain does it as the project's maintainer, so the write pins their grant (S1-M2); the row is only for this seed.
      const actor = fixtureActor(chains, ORG_A, by), unseed = owner.kind === "project" && actor.role === "member" ? seedMaintainerGrant(db, ORG_A, actor.developerId, owner.project) : () => undefined;
      try { await chains.setBudget(ORG_A, created.chainId, extra.budgetUsd, actor.developerId, undefined, { ...({}), actor }); } finally { unseed(); }
    }
    return (await chains.get(ORG_A, created.chainId))!;
  };

  /** A custom agent with one published version, owned by `owner`, on the rosters of `onProjects`. */
  const customAgent = async (name: string, owner: string = DANA, onProjects: string[] = ["web"]) => {
    const created = await agents.create({ orgId: ORG_A, name, owner: { kind: "member", developerId: owner }, overlay: SCRATCH, createdBy: owner });
    await agents.publish({ orgId: ORG_A, agentId: created.agentId, expectedDraftRevision: created.draftRevision, digest: DIGEST, by: owner });
    for (const project of onProjects) await addToRoster(deps, { orgId: ORG_A, project, agentId: created.agentId, by: DANA });
    return (await agents.get(ORG_A, created.agentId))!;
  };

  // ---- reads of what the runner wrote
  const run = (runId: string, orgId: OrgId = ORG_A) => db.get(chainRunKey(orgId, runId, "META")) as unknown as ChainRunRecord | undefined;
  const items = (runId: string, prefix: "STEP#" | "EVENT#", orgId: OrgId = ORG_A) =>
    db.find((item) => item.pk === chainRunKey(orgId, runId, "META").pk && String(item.sk).startsWith(prefix)).sort((a, b) => String(a.sk).localeCompare(String(b.sk)));
  const attempts = (runId: string, orgId: OrgId = ORG_A) => items(runId, "STEP#", orgId) as unknown as StepAttemptRecord[];
  const events = (runId: string, orgId: OrgId = ORG_A) => items(runId, "EVENT#", orgId) as unknown as RunEventRow[];
  /** Moves the run's version on, as any other change to it would. */
  const touchRun = (runId: string) => {
    const meta = db.get(chainRunKey(ORG_A, runId, "META"))!;
    db.set({ ...meta, version: (meta["version"] as number) + 1 });
  };
  /** Publishes `definition` as the chain's next version. */
  const publishAgain = async (chainId: string, definition: ChainDefinitionInput, by = PRIYA) => {
    const draft = (await chains.getDraft(ORG_A, chainId))!;
    await chains.saveDraft({ orgId: ORG_A, chainId, definition, expectedRevision: draft.revision, by });
    const chain = (await chains.get(ORG_A, chainId))!;
    const checked = await validateChainForPublish(agentDeps, callerOf(by), ORG_A, ChainDefinitionSchema.parse(definition));
    if (checked.problems.length > 0) throw new Error(`the test's chain has problems: ${JSON.stringify(checked.problems)}`);
    await chains.publish({ orgId: ORG_A, chainId, expectedDraftRevision: chain.draftRevision, pinned: checked.pinned, digest: chainDigest(checked.pinned), guardrailsRevision: checked.guardrailsRevision, by });
  };
  const chainOf = async (chainId: string) => (await chains.get(ORG_A, chainId))!;
  const openItems = () => db.find((item) => item.pk === "OPEN_CHAIN_RUNS");

  // ---- events the task layer would tell
  const taskOf = (taskId: string): FakeTask => {
    const task = tasks.get(taskId);
    if (task === undefined) throw new Error(`no task ${taskId}`);
    return task;
  };
  const endEvent = (taskId: string, extra: Partial<TaskEndEvent> = {}): TaskEndEvent => {
    const { request, result } = taskOf(taskId);
    return {
      orgId: request.orgId, taskId, ...(request.chain === undefined ? {} : { chain: request.chain }), outcome: "succeeded", runLimitUsd: result.runLimitUsd, stopAtUsd: result.stopAtUsd, spentUsd: 0.5, ...extra,
    };
  };
  const pauseEvent = (taskId: string, extra: Partial<TaskPauseEvent> = {}): TaskPauseEvent => {
    const { request } = taskOf(taskId);
    return { orgId: request.orgId, taskId, ...(request.chain === undefined ? {} : { chain: request.chain }), scope: { kind: "task", taskId }, ...extra };
  };
  const refusal = (code: Parameters<typeof agentXError>[0], message: string): AgentXError => agentXError(code, message);

  return { db, clock, beforeTransaction, touchRun, publishAgain, agents, chains, projectMembers, deps, agentDeps, access, starts, tasks, hooks, cancels, startAgentRun, publish, customAgent, run, attempts, events, chainOf, openItems, endEvent, pauseEvent, taskOf, refusal };
}

export type ChainWorld = ReturnType<typeof setupWorld>;

/** Who and what decided a gate, as Task 8's handler tells the runner: the approval the gate's attempt waits on, and the decider's name. */
export const decisionBy = (w: ChainWorld, runId: string, seq: number, name = "Someone") => ({ approvalId: w.attempts(runId).find((attempt) => attempt.seq === seq)?.approvalId ?? "apr_aaaaaaaaaaaaaaaaaaaa", name });
