// Plan 4 Task 6: the chain runner's core. A run is a person's (or an event's, or a schedule's) start of a published chain version. Each agent step is a run of its own
// pinned agent through Plan 3's `startAgentRun`, started with only that step's instructions and the earlier reports as information (`handoff.ts`); each step's end,
// and each budget pause, comes back through the end and pause handlers (`index.ts` registers them); and `advanceChainRun` is the one place the run moves.
//
// The rules that keep it correct, each tested:
//   - Every state change is ONE transaction with its event and the run's `eventSeq` and `version`, conditional on the version that was read; a lost race re-reads once.
//   - Nothing is written before the start's transaction, and the open-run count, both indexes and the open item go in it.
//   - A step's attempt is written `starting` BEFORE `startAgentRun` is called, with a request id derived from the run and the attempt, so a crash leaves an attempt
//     that `advanceChainRun` re-drives to the same task, never a second one.
//   - A pause is not an end: the attempt and the run are `paused` and nothing is released or retried. An end is handled once however often it is told.
//   - Text a person is shown from a task (a failure reason) is neutralised; text that goes to another agent is redacted (`handoff.ts`).
import { createHash } from "node:crypto";
import { GetCommand, QueryCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { AGENT_REPORT_MAX_BYTES, AgentXError, BranchIdSchema, CHAIN_MAX_CONCURRENT_RUNS, CHAIN_MAX_STEP_RUNS, CHAIN_START_INPUT_MAX, ChainRunIdSchema, ChainRunStartedBySchema, StepLinkSchema, StepResultSchema, STEP_LINKS_MAX, agentXError, answeredMessage, canonicalJson, chainKey, chainRunKey, chainRunsByChainKey, chainRunsByProjectKey, isBuiltinAgentId, newPrefixedId, GATE_DEFAULT_TIMEOUT_HOURS, STEP_DEFAULT_TIMEOUT_MINUTES, UNVERIFIED_END_PREFIX, openChainRunKey, projectAllows, shortenToBytes, stepSk, type AgentId, type AgentOwner, type ChainId, type ChainRunId, type ChainRunStartedBy, type ChainRunStatus, type Edge, type OrgId, type Payer, type PinnedChainDefinition, type ResultContract, type RunInput, type StepAttemptStatus, type StepResult, type WorkOrigin } from "@rovara-code/contracts";
import { type WorkflowSnapshot, workflowAnswer } from "@agentx/cloud-contracts";
import { requireAgentAccess, type AgentCaller } from "../agents/access.js";
import type { AgentRunRequest, AgentRunResult, AgentRunStarter } from "../agents/runs.js";
import { resolveAgentForAutonomousRun, resolveAgentForTask, roleOnProject, type RosterDependencies } from "../agents/roster.js";
import { startAgentRun } from "../agents/runs.js";
import { isDeclinedEndReason, type TaskEndEvent, type TaskPauseEvent, type TaskResumeEvent } from "../agents/task-end.js";
import { Aliases, NOT_EXISTS, failedIndexes, strip, type TransactItem } from "../agents/table-writes.js";
import { requireNewWorkAllowed } from "../developer/project-roles.js";
import { taskActionRequestKey, taskAgentRunKey } from "../developer/task-records.js";
import type { AdmissionDependencies } from "../org/budget.js";
import { readProjectAiWithRevision } from "../spend/settings.js";
import type { ChainRunSpendReader } from "../spend/chain-run-spend.js";
import { createChainSessionItems } from "../agent-sessions/create.js";
import { chooseEdge, takeEdge } from "./branches.js";
import { admitChainRun, chainRunLimitUsd, chainRunPayer, runRaiseMessage, settleStepSpend, stepRunLimitUsd, type ChainRunOrigin } from "./budget.js";
import { requireChainAccess, type ChainAccessDeps } from "./access.js";
import { buildHandoff, HandoffTriggerSchema, redactSecrets, type EarlierReport, type HandoffTrigger } from "./handoff.js";
import { onChainGateDecided, openGateApproval } from "./gates.js";
import { answeredGateId, answeredGateOrigin, answeredGateStep, answeredStepName, gateStepOf, type GateStep } from "./answered-gate.js";
import { cancelAbandonedTask, cancelRequestId, closeAbandonedGate } from "./lifecycle.js";
import { neutralText, runEventItems, type RunEventInput } from "./run-events.js";
import type { ChainRouteDependencies } from "./routes.js";
import type { ChainRecord } from "./store.js";

// ---- records

const TERMINAL: ReadonlySet<string> = new Set<ChainRunStatus>(["succeeded", "failed", "cancelled", "timed_out"]);
/** Whether a run (or an attempt) has ended: nothing moves it again. */
export const isTerminalStatus = (status: string): boolean => TERMINAL.has(status);

/** How a run ends: the states nothing moves it out of. */
export type EndStatus = "succeeded" | "failed" | "cancelled" | "timed_out";

export interface ChainRunFailure { seq?: number; reason: string; message: string }

/** META of a chain run, at `chainRunKey(orgId, runId, "META")`. */
export interface ChainRunRecord {
  orgId: OrgId;
  runId: ChainRunId;
  chainId: ChainId;
  chainName: string;
  chainVersion: number;
  project: string;
  /** Who owns the chain's design (copied from the chain), used only for access and gate rules. */
  chainOwner: AgentOwner;
  /** Who owns this run, and so every step's task: the starter, or for an event or schedule start the trigger's creator or the chain's member owner. */
  owner: { developerId: string };
  startedBy: ChainRunStartedBy;
  payer: Payer;
  origin: WorkOrigin;
  status: ChainRunStatus;
  currentSeq: number;
  eventSeq: number;
  stepRuns: number;
  traversals: Record<string, number>;
  runLimitUsd: number;
  spentUsd: number;
  input?: string;
  /** The event that started the run, as much of it as a hand-off needs (each step's start item is made from it). */
  trigger?: HandoffTrigger;
  version: number;
  createdAt: string;
  updatedAt: string;
  /** When the sweep (Task 9) next looks at the run; the open item's key holds the same instant. */
  dueAt: string;
  endedAt?: string;
  failure?: ChainRunFailure;
  /** Who cancelled the run (Task 9), as the member they are. */
  cancelledBy?: string;
}

/** One attempt of one step, at `chainRunKey(orgId, runId, stepSk(seq))`. */
export interface StepAttemptRecord {
  seq: number;
  stepId: string;
  stepName: string;
  kind: "agent" | "gate";
  /** How often this step has been started in the run: 1 the first time, 2 the second (a loop, or a retry). */
  attempt: number;
  status: StepAttemptStatus;
  agent?: { agentId: AgentId; name: string; version: number };
  taskId?: string;
  grantedRunLimitUsd?: number;
  stopAtUsd?: number;
  remainingAtStartUsd?: number;
  /** The gate's approval (Task 8). */
  approvalId?: string;
  inputDigest: string;
  startedAt: string;
  endedAt?: string;
  result?: StepResult;
  failure?: { reason: string; message: string };
  branch?: { id: string; fellBack: boolean };
  /** A gate's decision, once someone decided it. */
  decision?: "approved" | "declined";
  /** The step's coding task ended Answered (it answered a question and changed no code): the run pauses at an implied gate for a person to continue or stop (see `answered-gate.ts`). */
  answered?: true;
  /** How many retries this visit of the step has used: 0 (absent) for the first attempt, 1 for its first retry (Task 9). A step entered again by an edge starts over. */
  retriesUsed?: number;
  /** Set by the sweep when the attempt ran past its time and its task was asked to stop (Task 9); the task's end then ends the attempt `timed_out`. */
  timedOutAt?: string;
  /** The limit the attempt had when it was flagged, in minutes. */
  timeoutMinutes?: number;
  /** Set when the run's own ending (a cancel, a run timeout) ended this attempt with its task still to end: the task's spend is not yet in the run's `spentUsd`. The task's end adds it, once. */
  spendPending?: boolean;
  /** When the sweep last saw the attempt paused or waiting on approvals: the time it has run is counted from here when this is later than `startedAt`. */
  timeoutBase?: string;
}

// ---- what the runner needs

/** What the runner asks of Plan 3's run start and of the people it names. */
export interface ChainRunPorts {
  /** Plan 3's `startAgentRun`, bound to its starter (H2). */
  startAgentRun(request: AgentRunRequest): Promise<AgentRunResult>;
  /** Who a member is as a caller now (their org role); undefined when they are not a member of the org. */
  callerFor(orgId: OrgId, developerId: string): Promise<AgentCaller | undefined>;
  /** The model proxy's admission, for a start to be checked against the chain's budget. Absent where there is no proxy: nothing is limited. */
  admission?: AdmissionDependencies;
  /**
   * Plan 3's cancel of a step's task, as the task's owner (the run's owner: the system acts for them). The request id makes a repeat the same cancel. Resolves when
   * the task is cancelled or already over; the task's own end still comes back through the end handler. Throws what Plan 3's cancel throws.
   */
  cancelTask(request: { orgId: OrgId; taskId: string; owner: { developerId: string }; requestId: string }): Promise<void>;
}

/** The chain routes' dependencies, and the run starts and the people they need. */
export type ChainRunnerDependencies = ChainRouteDependencies & { chainRuns: ChainRunPorts };

/** The ports from Plan 3's run starter: its `startAgentRun`, its member lookup and, with the model proxy, admission. */
export function chainRunPortsFor(starter: AgentRunStarter, admission?: AdmissionDependencies): ChainRunPorts {
  return {
    startAgentRun: (request) => startAgentRun(starter, request),
    callerFor: async (orgId, developerId) => {
      const caller = await starter.callerFor(orgId, developerId);
      return caller === undefined ? undefined : { orgId: caller.orgId, developerId: caller.developerId, orgRole: caller.orgRole };
    },
    // The owner is a member of the org or Plan 3 has already ended their tasks (creator removed): nothing is left to cancel as them.
    cancelTask: async (request) => {
      const caller = await starter.callerFor(request.orgId, request.owner.developerId);
      if (caller === undefined) return;
      if (starter.cancelTask === undefined) throw agentXError("RUNTIME_UNAVAILABLE", "a chain step's task can't be cancelled in this deployment");
      await starter.cancelTask(caller, request.taskId, request.requestId);
    },
    ...(admission === undefined ? {} : { admission }),
  };
}

/** What starts a run with no person at a keyboard: an event or a schedule, for the member who owns the run. */
export interface SystemCaller { system: "event" | "schedule"; owner: { developerId: string } }

export interface StartChainRunInput {
  orgId: OrgId;
  chainId: ChainId;
  project: string;
  origin: WorkOrigin;
  startedBy: ChainRunStartedBy;
  /** What the person said to start it (at most `CHAIN_START_INPUT_MAX` characters). */
  input?: string;
  /** The event that started it (Task 18's `TriggerEvent`). */
  trigger?: HandoffTrigger;
  /** A run id the caller chose (a trigger's, so a repeated event starts one run); else a person's is derived from the request id. */
  runId?: ChainRunId;
  requestId: string;
}

export type Deps = ChainRunnerDependencies;
export type Table = Pick<Deps, "documentClient" | "tableName" | "now">;

/** How soon the sweep (Task 9) first looks at a new run. */
const FIRST_LOOK_MS = 5 * 60_000;
/** Plan 3 and the model's own words for a step that did nothing to say. */
const DEFAULT_STEP_TEXT = "Do your job for this chain run.";
const CODING_AGENT_NAME = "Rovara Code";
const REASON_MAX = 300;
/** What a failed or cancelled task is said to have done when it left no reason of its own. */
const NO_REASON = "it did not finish";
/** The reason Plan 3's engine gives a run that was cancelled with nothing more to say. */
const PLAIN_CANCEL_REASON = "Cancelled.";

export const iso = (deps: Pick<Table, "now">): string => new Date(deps.now()).toISOString();
export const errorName = (error: unknown): string => (error instanceof Error ? error.name : "unknown");

/** The words of an error without the `CODE: ` Plan 3's errors begin with, and without a full stop at the end (the caller adds its own). */
const reasonOf = (error: AgentXError): string => trimStop(error.message.startsWith(`${error.code}: `) ? error.message.slice(error.code.length + 2) : error.message);
export const trimStop = (text: string): string => text.replace(/\.+$/u, "");
const textOf = (error: AgentXError): string => (error.message.startsWith(`${error.code}: `) ? error.message.slice(error.code.length + 2) : error.message);

/** A failure that may pass on its own, anywhere the runner moves a run along and an unknown failure is better left for the next try than thrown at a caller. */
function isTransient(error: unknown): boolean {
  if (!(error instanceof AgentXError)) return true;
  return error.statusCode >= 500 || error.code === "WORKSPACE_BUSY" || error.code === "TOO_MANY_REQUESTS";
}

/** The codes of Plan 3's `startAgentRun` that mean "try again later": the start is left as it is, to be driven again with the same request id. */
const RETRY_LATER_CODES: ReadonlySet<string> = new Set(["WORKSPACE_BUSY", "TOO_MANY_REQUESTS", "RUNTIME_UNAVAILABLE", "MODEL_PROXY_UNAVAILABLE", "SLACK_UNAVAILABLE", "AUDIT_UNAVAILABLE"]);

/** Only an `AgentXError` with one of those codes is retried. Anything else (a TypeError, a schema error) would be retried for ever, so it ends the attempt. */
const isRetryLater = (error: unknown): boolean => error instanceof AgentXError && RETRY_LATER_CODES.has(error.code);

/** What a step that could not start for an unexpected reason says: never the error's own words, which may hold a secret or an internal detail. */
const UNEXPECTED_START_REASON = "start_failed";
const unexpectedStartMessage = (stepName: string): string => `Step "${stepName}" could not start because of an unexpected error. Nothing was started.`;

// ---- reading

export async function getItem(deps: Table, key: { pk: string; sk: string }): Promise<Record<string, unknown> | undefined> {
  return ((await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: key, ConsistentRead: true }))) as { Item?: Record<string, unknown> }).Item;
}

async function queryPrefix(deps: Table, pk: string, prefix: string): Promise<Array<Record<string, unknown>>> {
  const found: Array<Record<string, unknown>> = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const page = await deps.documentClient.send(new QueryCommand({
      TableName: deps.tableName, KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)", ExpressionAttributeValues: { ":pk": pk, ":prefix": prefix }, ConsistentRead: true,
      ...(startKey === undefined ? {} : { ExclusiveStartKey: startKey }),
    })) as { Items?: Array<Record<string, unknown>>; LastEvaluatedKey?: Record<string, unknown> };
    found.push(...(page.Items ?? []));
    startKey = page.LastEvaluatedKey;
  } while (startKey !== undefined);
  return found;
}

/** The run, read under `orgId` (a run of another org is none). */
export async function readChainRun(deps: Table, orgId: OrgId, runId: ChainRunId): Promise<ChainRunRecord | undefined> {
  const item = await getItem(deps, chainRunKey(orgId, runId, "META"));
  return item === undefined || item["orgId"] !== orgId ? undefined : strip(item as { pk: string; sk: string; entityType: string }) as unknown as ChainRunRecord;
}

/** One attempt of the run, or undefined when the run has no such attempt. */
export async function readStepAttempt(deps: Table, orgId: OrgId, runId: ChainRunId, seq: number): Promise<StepAttemptRecord | undefined> {
  const item = await getItem(deps, chainRunKey(orgId, runId, stepSk(seq)));
  return item === undefined || item["orgId"] !== orgId ? undefined : strip(item as { pk: string; sk: string; entityType: string }) as unknown as StepAttemptRecord;
}

/** Every attempt of the run, in order. */
export async function readStepAttempts(deps: Table, orgId: OrgId, runId: ChainRunId): Promise<StepAttemptRecord[]> {
  const items = await queryPrefix(deps, chainRunKey(orgId, runId, "META").pk, "STEP#");
  return items.map((item) => strip(item as { pk: string; sk: string; entityType: string }) as unknown as StepAttemptRecord).sort((left, right) => left.seq - right.seq);
}

// ---- writing

export const transact = (deps: Table, items: TransactItem[]) => deps.documentClient.send(new TransactWriteCommand({ TransactItems: items }));

/** An update of one item's fields, conditional on a clause built with the same aliases. */
export function update(deps: Table, key: { pk: string; sk: string }, fields: Record<string, unknown>, when: (aliases: Aliases) => string): TransactItem {
  const aliases = new Aliases();
  const sets = Object.entries(fields).map(([name, value]) => `${aliases.name(name)} = ${aliases.value(value)}`);
  const condition = when(aliases);
  return { Update: { TableName: deps.tableName, Key: key, UpdateExpression: `SET ${sets.join(", ")}`, ConditionExpression: condition, ExpressionAttributeNames: aliases.names, ExpressionAttributeValues: aliases.values } };
}

export const runKey = (run: Pick<ChainRunRecord, "orgId" | "runId">) => chainRunKey(run.orgId, run.runId, "META");
export const attemptKey = (run: Pick<ChainRunRecord, "orgId" | "runId">, seq: number) => chainRunKey(run.orgId, run.runId, stepSk(seq));

/** The run's META moved to `fields` with its events: `eventSeq`, `version` and `updatedAt` move with them, and it applies only while the version is the one that was read. */
export function moveRun(deps: Table, run: ChainRunRecord, fields: Record<string, unknown>, events: readonly RunEventInput[]): TransactItem[] {
  const numbered = runEventItems(deps.tableName, run, events, iso(deps));
  const move = update(deps, runKey(run), { ...fields, eventSeq: numbered.eventSeq, version: run.version + 1, updatedAt: iso(deps) }, (aliases) => `${aliases.name("version")} = ${aliases.value(run.version)}`);
  return [move, ...numbered.items];
}

/** An update of an attempt that applies only while it is in one of the statuses given. */
export function moveAttempt(deps: Table, run: ChainRunRecord, seq: number, fields: Record<string, unknown>, from: readonly string[]): TransactItem {
  return update(deps, attemptKey(run, seq), fields, (aliases) => `(${from.map((status) => `${aliases.name("status")} = ${aliases.value(status)}`).join(" OR ")})`);
}

/** Whether a failed transaction was a lost race: the run has moved since it was read. Anything else is the caller's to throw. */
export async function lostRace(deps: Table, run: ChainRunRecord, error: unknown): Promise<boolean> {
  if (failedIndexes(error) === undefined) return false;
  const fresh = await readChainRun(deps, run.orgId, run.runId);
  return fresh === undefined || fresh.version !== run.version;
}

// ---- ids

/** A person's run id from their request id, so the same request is the same run: `crn_` and 20 characters of `[0-9a-z]`. */
function derivedRunId(orgId: OrgId, developerId: string, requestId: string): ChainRunId {
  const digest = createHash("sha256").update(`chain-run\0${orgId}\0${developerId}\0${requestId}`).digest("hex");
  return `crn_${BigInt(`0x${digest}`).toString(36).slice(-20).padStart(20, "0")}`;
}

const STEP_NAMESPACE = Buffer.from("6f1b7f0e3b574c469f555e1f0c6a7d21", "hex");

/** The request id of a step's start: a UUID v5 of `<runId>#<seq>`, so starting the same attempt twice is one run of Plan 3's (never two). */
export function stepRequestId(runId: string, seq: number): string {
  const hash = createHash("sha1").update(STEP_NAMESPACE).update(`${runId}#${String(seq)}`).digest();
  hash[6] = (hash[6]! & 0x0f) | 0x50;
  hash[8] = (hash[8]! & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// ---- who and what a step is

export type PinnedStep = PinnedChainDefinition["steps"][number];
type PinnedAgentStep = Extract<PinnedStep, { kind: "agent" }>;
const agentSteps = (definition: PinnedChainDefinition): PinnedAgentStep[] => definition.steps.filter((step): step is PinnedAgentStep => step.kind === "agent");

async function agentFacts(deps: Deps, orgId: OrgId, agentId: AgentId): Promise<{ name: string; archived: boolean }> {
  if (isBuiltinAgentId(agentId)) return { name: deps.store.builtinName(agentId), archived: false };
  const record = await deps.store.get(orgId, agentId);
  return record === undefined ? { name: agentId, archived: false } : { name: record.name, archived: record.status === "archived" };
}

const unavailable = (chain: string, step: string, agent: string, version: number, reason: string): AgentXError =>
  agentXError("CHAIN_UNAVAILABLE", `${chain}'s step "${step}" uses ${agent} version ${String(version)}, which can't run now: ${reason}. Ask ${chain}'s owner to publish a new version.`);

function checkInput(input: StartChainRunInput, caller: AgentCaller | SystemCaller): void {
  const person = !("system" in caller);
  if (input.input !== undefined && [...input.input].length > CHAIN_START_INPUT_MAX) throw agentXError("CONFIG_INVALID", `input: must be at most ${String(CHAIN_START_INPUT_MAX)} characters`);
  const started = ChainRunStartedBySchema.safeParse(input.startedBy);
  if (!started.success) throw agentXError("CONFIG_INVALID", `startedBy: ${started.error.issues[0]?.message ?? "is not valid"}`);
  if (person) {
    if (input.orgId !== caller.orgId) throw agentXError("CONFIG_INVALID", "orgId: a person starts runs in their own organization");
    if (input.startedBy.kind !== "member" || input.startedBy.developerId !== caller.developerId) throw agentXError("CONFIG_INVALID", "startedBy: a person's run is started by that person");
    if (!(["app", "cli", "mcp", "slack", "linear"] as const).some((origin) => origin === input.origin)) throw agentXError("CONFIG_INVALID", "origin: a person starts a run from the app, the CLI, MCP, Slack or Linear");
  } else {
    if (input.startedBy.kind !== caller.system || input.origin !== caller.system) throw agentXError("CONFIG_INVALID", `origin: a run started by ${caller.system === "event" ? "an event" : "a schedule"} says so`);
  }
}

// ---- the start

/**
 * Starts a run of a chain's current published version. The checks come first and nothing is written until the transaction (step 6): the chain is active and
 * published; a person may use it, the project and every step's agent (a shared agent acts as them), or for an event or schedule the run's owner may; every agent step
 * resolves at its pinned version; the run is admitted against the chain's budget. Then one transaction writes the run, its indexes, its open item, the chain's open-run
 * count and its first event, and the run moves to its first step. The same request is the same run: a repeat answers the stored run and writes nothing.
 */
export async function startChainRun(deps: Deps, caller: AgentCaller | SystemCaller, input: StartChainRunInput): Promise<ChainRunRecord> {
  return startOnce(deps, caller, input, 0);
}

async function startOnce(deps: Deps, caller: AgentCaller | SystemCaller, input: StartChainRunInput, round: number): Promise<ChainRunRecord> {
  if (deps.chainRuns === undefined) throw agentXError("NOT_FOUND", "chain runs are not set up in this deployment");
  const system = "system" in caller ? caller : undefined;
  const person = system === undefined ? caller as AgentCaller : undefined;
  checkInput(input, caller);
  const trigger = input.trigger === undefined ? undefined : parseTrigger(input.trigger);
  const ownerId = system === undefined ? person!.developerId : system.owner.developerId;
  const runId = input.runId ?? (person === undefined ? newPrefixedId("crn") : derivedRunId(input.orgId, person.developerId, input.requestId));
  const stored = await readChainRun(deps, input.orgId, runId);
  if (stored !== undefined) return replayOf(deps, stored, input);

  // 1 and 2: the chain, and who may start it.
  const access: ChainAccessDeps = { ...deps, store: deps.chains };
  let chain: ChainRecord;
  if (person !== undefined) chain = (await requireChainAccess(access, person, input.chainId, "view")).chain;
  else {
    const found = await deps.chains.get(input.orgId, input.chainId);
    if (found === undefined) throw agentXError("NOT_FOUND", "no chain has that ID");
    chain = found;
  }
  if (chain.status !== "active") throw agentXError("CHAIN_UNAVAILABLE", `${chain.name} is archived, so it can't start new runs.`);
  if (chain.currentVersion === undefined) throw agentXError("CHAIN_UNAVAILABLE", `${chain.name} has no published version yet, so it can't start new runs.`);
  const version = await deps.chains.getVersion(input.orgId, chain.chainId, chain.currentVersion);
  if (version === undefined) throw agentXError("CHAIN_UNAVAILABLE", `${chain.name} has no published version yet, so it can't start new runs.`);
  const steps = agentSteps(version.definition);
  const first = steps[0];
  let role: Awaited<ReturnType<typeof roleOnProject>> | undefined;
  let ownerCaller: AgentCaller | undefined;
  if (person !== undefined) {
    await requireChainAccess(access, person, chain.chainId, "use");
    const checkAccess = (deps as RosterDependencies).checkProjectAccess;
    role = checkAccess === undefined ? await roleOnProject(deps, person, input.project) : (await checkAccess(person, input.project)).role;
    await requireNewWorkAllowed(deps, input.orgId, input.project, role, "task");
  } else if (first !== undefined) {
    ownerCaller = await deps.chainRuns.callerFor(input.orgId, ownerId);
    const ownerRole = ownerCaller === undefined ? undefined : await deps.projectMembers.roleOf(input.orgId, input.project, { developerId: ownerId, orgRole: ownerCaller.orgRole });
    if (ownerCaller === undefined || ownerRole === undefined || !projectAllows(ownerRole, "start_tasks")) {
      throw unavailable(chain.name, first.name, (await agentFacts(deps, input.orgId, first.agent.agentId)).name, first.agent.version, "its owner can no longer use it");
    }
  }
  for (const step of steps) {
    const facts = await agentFacts(deps, input.orgId, step.agent.agentId);
    if (facts.archived) throw unavailable(chain.name, step.name, facts.name, step.agent.version, `${facts.name} is archived, so it can't start new work`);
    try {
      await requireAgentAccess(deps, person ?? ownerCaller!, step.agent.agentId, "use");
    } catch (error) {
      if (!(error instanceof AgentXError)) throw error;
      if (person === undefined) throw unavailable(chain.name, step.name, facts.name, step.agent.version, "its owner can no longer use it");
      throw agentXError("FORBIDDEN", `${chain.name} uses ${facts.name}, which you can't use. Ask ${facts.name}'s owner to share it with you.`);
    }
  }
  // 3: every agent step resolves at its pinned version.
  for (const step of steps) {
    try {
      if (person !== undefined) await resolveAgentForTask(deps, person, { project: input.project, agent: { agentId: step.agent.agentId, version: step.agent.version }, role: role! });
      else await resolveAgentForAutonomousRun(deps, { orgId: input.orgId, project: input.project, agentId: step.agent.agentId, version: step.agent.version });
    } catch (error) {
      if (!(error instanceof AgentXError)) throw error;
      throw unavailable(chain.name, step.name, (await agentFacts(deps, input.orgId, step.agent.agentId)).name, step.agent.version, reasonOf(error));
    }
  }
  // 4: who pays, and whether the chain's budget admits it.
  const origin = input.origin as ChainRunOrigin;
  const { settings } = await readProjectAiWithRevision(deps, input.orgId, input.project);
  const payer = chainRunPayer({ origin, project: input.project, projectPays: settings.projectPays, chainId: chain.chainId, ...(person === undefined ? {} : { startedBy: { developerId: person.developerId } }) });
  const runLimitUsd = chainRunLimitUsd(version.definition, origin);
  if (deps.chainRuns.admission !== undefined && first !== undefined) {
    const facts = await agentFacts(deps, input.orgId, first.agent.agentId);
    await admitChainRun(deps.chainRuns.admission, { orgId: input.orgId, chain: { chainId: chain.chainId, name: chain.name }, project: input.project, payer, firstAgent: { agentId: first.agent.agentId, name: facts.name } });
  }
  // 6: the run, its indexes, its open item, the chain's open-run count and its first event: one transaction.
  const createdAt = iso(deps);
  const run: ChainRunRecord = {
    orgId: input.orgId, runId, chainId: chain.chainId, chainName: chain.name, chainVersion: version.version, project: input.project, chainOwner: chain.owner, owner: { developerId: ownerId },
    startedBy: input.startedBy, payer, origin: input.origin, status: "running", currentSeq: 0, eventSeq: 1, stepRuns: 0, traversals: {}, runLimitUsd, spentUsd: 0,
    ...(input.input === undefined ? {} : { input: input.input }), ...(trigger === undefined ? {} : { trigger }), version: 1, createdAt, updatedAt: createdAt,
    dueAt: new Date(deps.now() + FIRST_LOOK_MS).toISOString(),
  };
  try {
    // Plan 5 Task 3: the run's session is created with the run, in the same transaction, so a run and its session exist together or not at all.
    await transact(deps, [...runStartItems(deps, run, chain), ...await sessionItemsOf(deps, run)]);
  } catch (error) {
    if (failedIndexes(error) === undefined) throw error;
    // A lost race on a run id the caller gave: the run that won is the answer.
    const winner = await readChainRun(deps, input.orgId, runId);
    if (winner !== undefined) return replayOf(deps, winner, input);
    const now = await deps.chains.get(input.orgId, chain.chainId);
    if (now === undefined) throw agentXError("NOT_FOUND", "no chain has that ID");
    if (now.status !== "active") throw agentXError("CHAIN_UNAVAILABLE", `${chain.name} is archived, so it can't start new runs.`);
    if (now.openRuns >= CHAIN_MAX_CONCURRENT_RUNS) throw agentXError("FORBIDDEN", `${chain.name} already has ${String(now.openRuns)} runs going. Wait for one to finish.`);
    if (now.currentVersion !== chain.currentVersion && round < 1) return startOnce(deps, caller, input, round + 1);
    throw error;
  }
  // 7: the first step. A start that could not be made now is left for the sweep; the run is already the person's.
  try {
    await advanceChainRun(deps, input.orgId, runId);
  } catch (error) {
    if (!isTransient(error)) throw error;
    (deps.log ?? ((event, fields) => console.log(JSON.stringify({ component: "broker", event, ...fields }))))("chain_run.start_deferred", { runId, error: errorName(error) });
  }
  return (await readChainRun(deps, input.orgId, runId)) ?? run;
}

function parseTrigger(trigger: HandoffTrigger): HandoffTrigger {
  const parsed = HandoffTriggerSchema.safeParse(trigger);
  if (!parsed.success) throw agentXError("CONFIG_INVALID", `trigger: ${parsed.error.issues[0]?.path.join(".") ?? ""} ${parsed.error.issues[0]?.message ?? "is not valid"}`.replace(/\s+/gu, " ").trim());
  return parsed.data;
}

/** A member's name as the session shows it, read before the start's transaction; undefined when the member has none (the session says "Someone"). */
async function memberNameOf(deps: Deps, developerId: string): Promise<string | undefined> {
  try {
    return (await deps.signInStore.getDeveloper(developerId))?.displayName;
  } catch {
    return undefined;
  }
}

/** The items of the run's session (Plan 5 Task 3): its starter by who or what began it, and its title from the first line of the input or the title of the event. */
async function sessionItemsOf(deps: Deps, run: ChainRunRecord): Promise<TransactItem[]> {
  const startedBy = run.startedBy.kind === "member" ? { kind: "member" as const, developerId: run.startedBy.developerId }
    : { kind: run.startedBy.kind, triggerId: run.startedBy.triggerId };
  const about = run.input ?? (run.startedBy.kind === "event" ? run.startedBy.title : run.trigger?.subject.title);
  const starterName = run.startedBy.kind === "member" && run.startedBy.developerId !== run.owner.developerId ? await memberNameOf(deps, run.startedBy.developerId) : undefined;
  return createChainSessionItems(deps, {
    orgId: run.orgId, runId: run.runId, chainName: run.chainName, project: run.project, owner: { developerId: run.owner.developerId, name: await memberNameOf(deps, run.owner.developerId) ?? "Someone" },
    startedBy, ...(starterName === undefined ? {} : { startedByName: starterName }), about, origin: run.origin, payer: run.payer, now: run.createdAt,
  });
}

/** The items of a run's start transaction. */
export function runStartItems(deps: Table, run: ChainRunRecord, chain: Pick<ChainRecord, "chainId" | "currentVersion">): TransactItem[] {
  const { orgId, runId, chainId, createdAt } = run;
  const aliases = new Aliases();
  const open = aliases.name("openRuns");
  const statusName = aliases.name("status");
  const versionName = aliases.name("currentVersion");
  const claim: TransactItem = {
    Update: {
      TableName: deps.tableName, Key: chainKey(orgId, chainId, "META"), UpdateExpression: `SET ${open} = ${open} + ${aliases.value(1)}`,
      ConditionExpression: `${open} < ${aliases.value(CHAIN_MAX_CONCURRENT_RUNS)} AND ${statusName} = ${aliases.value("active")} AND ${versionName} = ${aliases.value(chain.currentVersion)}`,
      ExpressionAttributeNames: aliases.names, ExpressionAttributeValues: aliases.values,
    },
  };
  const started = runEventItems(deps.tableName, { orgId, runId, eventSeq: 0 }, [{ type: "started", text: `${run.chainName} started.` }], createdAt);
  return [
    { Put: { TableName: deps.tableName, Item: { ...runKey(run), entityType: "CHAIN_RUN", ...run }, ConditionExpression: NOT_EXISTS } },
    { Put: { TableName: deps.tableName, Item: { ...chainRunsByChainKey(orgId, chainId, createdAt, runId), entityType: "CHAIN_RUN_INDEX", orgId, runId, chainId, project: run.project, createdAt } } },
    { Put: { TableName: deps.tableName, Item: { ...chainRunsByProjectKey(orgId, run.project, createdAt, runId), entityType: "CHAIN_RUN_INDEX", orgId, runId, chainId, project: run.project, createdAt } } },
    { Put: { TableName: deps.tableName, Item: { ...openChainRunKey(run.dueAt, orgId, runId), entityType: "OPEN_CHAIN_RUN", orgId, runId } } },
    claim,
    ...started.items,
  ];
}

/** The answer to a start whose run exists: the stored run, when the request is the one that made it, healed if it died before its first step. */
async function replayOf(deps: Deps, stored: ChainRunRecord, input: StartChainRunInput): Promise<ChainRunRecord> {
  const same = stored.chainId === input.chainId && stored.project === input.project && stored.input === input.input && canonicalJson(stored.startedBy) === canonicalJson(input.startedBy);
  if (!same) throw agentXError("CONFIG_INVALID", "requestId: this request id was already used for another run; use a new request id");
  if (stored.status === "running" && stored.currentSeq === 0) {
    try {
      await advanceChainRun(deps, stored.orgId, stored.runId);
    } catch (error) {
      if (!isTransient(error)) throw error;
    }
  }
  return (await readChainRun(deps, stored.orgId, stored.runId)) ?? stored;
}

// ---- the one state transition

/**
 * Moves a run along: reads it and its latest attempt, decides the one next action from the design, and writes it as one transaction conditional on the version
 * that was read. It does nothing for a run that has ended, and nothing while a step is running, paused or waiting for a gate. A lost race re-reads once and
 * stops. A `starting` attempt that never got its task (a crash, or a start that could not be made) is started again with the same request id.
 */
export async function advanceChainRun(deps: Deps, orgId: OrgId, runId: ChainRunId): Promise<void> {
  for (let pass = 0; pass < 2; pass += 1) {
    if (await advanceOnce(deps, orgId, runId) !== "raced") return;
  }
}

type Progress = "done" | "raced";

async function advanceOnce(deps: Deps, orgId: OrgId, runId: ChainRunId): Promise<Progress> {
  const run = await readChainRun(deps, orgId, runId);
  if (run === undefined || isTerminalStatus(run.status)) return "done";
  const attempts = await readStepAttempts(deps, orgId, runId);
  const latest = attempts.find((attempt) => attempt.seq === run.currentSeq);
  const definition = await designOf(deps, run);
  if (run.currentSeq === 0) return enterStep(deps, run, attempts, definition, definition.start, undefined);
  if (latest === undefined) throw agentXError("RUNTIME_UNAVAILABLE", "a chain run's latest step is missing");
  if (latest.status === "starting") return latest.taskId === undefined ? driveStart(deps, run, latest, attempts, definition) : "done";
  if (latest.status === "running" || latest.status === "paused" || latest.status === "waiting") return "done";
  return afterAttempt(deps, run, latest, attempts, definition);
}

export async function designOf(deps: Deps, run: ChainRunRecord): Promise<PinnedChainDefinition> {
  const version = await deps.chains.getVersion(run.orgId, run.chainId, run.chainVersion);
  if (version === undefined) throw agentXError("RUNTIME_UNAVAILABLE", "a chain run's version is missing");
  return version.definition;
}

export const stepOf = (definition: PinnedChainDefinition, stepId: string): PinnedStep | undefined => definition.steps.find((step) => step.id === stepId);

/**
 * The end of a run: its terminal state, its event, and the open item and the chain's open-run count given back, in one transaction (the caller adds an attempt's
 * update). The open item goes whether or not it is where the run says (a run's end must not wait on bookkeeping that drifted); the count goes last, so a caller
 * can leave it out when it is already 0.
 */
export function endRunItems(deps: Table, run: ChainRunRecord, ended: { status: EndStatus; failure?: ChainRunFailure; events: RunEventInput[]; fields?: Record<string, unknown> }): TransactItem[] {
  const text = ended.status === "succeeded" ? `${run.chainName} finished.` : ended.failure?.message ?? `${run.chainName} ${ended.status === "cancelled" ? "was cancelled" : "stopped"}.`;
  const closing: RunEventInput = { type: "ended", text };
  const aliases = new Aliases();
  const open = aliases.name("openRuns");
  const give: TransactItem = {
    Update: {
      TableName: deps.tableName, Key: chainKey(run.orgId, run.chainId, "META"), UpdateExpression: `SET ${open} = ${open} - ${aliases.value(1)}`, ConditionExpression: `${open} > ${aliases.value(0)}`,
      ExpressionAttributeNames: aliases.names, ExpressionAttributeValues: aliases.values,
    },
  };
  const dropOpen: TransactItem = { Delete: { TableName: deps.tableName, Key: openChainRunKey(run.dueAt, run.orgId, run.runId) } };
  return [...moveRun(deps, run, { status: ended.status, endedAt: iso(deps), ...(ended.failure === undefined ? {} : { failure: ended.failure }), ...ended.fields }, [...ended.events, closing]), dropOpen, give];
}

/**
 * Ends the run as failed (or `status`) because of the attempt `seq`, with the attempt's own update when it has one. If the only thing refused is the chain's open-run
 * count (it is already 0: it drifted), the run ends without giving a place back and the drift is logged; a count that is wrong is the sweep's to notice, never a reason
 * for a run that can't end.
 */
async function endRun(deps: Deps, run: ChainRunRecord, ended: { status: EndStatus; failure?: ChainRunFailure; events?: RunEventInput[]; attemptUpdate?: TransactItem; fields?: Record<string, unknown> }): Promise<Progress> {
  const base = endRunItems(deps, run, { status: ended.status, ...(ended.failure === undefined ? {} : { failure: ended.failure }), events: ended.events ?? [], ...(ended.fields === undefined ? {} : { fields: ended.fields }) });
  const attempt = ended.attemptUpdate === undefined ? [] : [ended.attemptUpdate];
  const giveAt = base.length - 1;
  try {
    await transact(deps, [...base, ...attempt]);
    return "done";
  } catch (error) {
    if (await lostRace(deps, run, error)) return "raced";
    const failed = failedIndexes(error);
    if (failed === undefined || failed.size !== 1 || !failed.has(giveAt)) throw error;
    (deps.log ?? ((event, fields) => console.log(JSON.stringify({ component: "broker", event, ...fields }))))("chain_run.open_runs_drifted", { runId: run.runId, chainId: run.chainId });
    await transact(deps, [...base.slice(0, giveAt), ...attempt]);
    return "done";
  }
}

/**
 * What follows an attempt that ended: a retry while the step has retries left (a failed or timed out attempt, whose task has ended, so never two attempts of a step at
 * once), its edge, or the end of the run. A run ends `failed` with the step's name and the task's own words; one whose task was cancelled (a person declined an approval
 * inside it, say) ends `cancelled` with the words the task gave.
 */
async function afterAttempt(deps: Deps, run: ChainRunRecord, ended: StepAttemptRecord, attempts: StepAttemptRecord[], definition: PinnedChainDefinition): Promise<Progress> {
  // The gate an answered step implied was decided: Continue goes on as if the answered step had succeeded (by its own edge); Stop ends the run, cancelled (a person's decision).
  const answeredOrigin = ended.kind === "gate" && ended.status === "succeeded" ? answeredGateOrigin(ended.stepId) : undefined;
  if (answeredOrigin !== undefined) {
    if (ended.decision === "declined") {
      return endRun(deps, run, { status: "cancelled", failure: { seq: ended.seq, reason: "answered_stop", message: `Stopped after "${answeredStepName(ended.stepName)}" answered instead of changing code.` } });
    }
    const origin = attempts.filter((candidate) => candidate.stepId === answeredOrigin && candidate.answered === true && candidate.seq < ended.seq).at(-1);
    if (origin === undefined) return endRun(deps, run, { status: "failed", failure: { seq: ended.seq, reason: "design_invalid", message: `Step "${answeredStepName(ended.stepName)}" is not in this chain's attempts.` } });
    const { answered: _answered, ...plain } = origin;
    void _answered;
    return afterAttempt(deps, run, plain, attempts, definition);
  }
  const step = stepOf(definition, ended.stepId);
  if (step === undefined) return endRun(deps, run, { status: "failed", failure: { seq: ended.seq, reason: "design_invalid", message: `Step "${ended.stepName}" is not in this chain's design.` } });
  if (ended.status === "failed" || ended.status === "timed_out") {
    const said = trimStop(ended.failure?.message ?? NO_REASON);
    const allowed = step.kind === "agent" ? step.retries ?? 0 : 0;
    const used = ended.retriesUsed ?? 0;
    if (used < allowed) {
      const retrying: RunEventInput = { type: "retrying", stepSeq: ended.seq, text: `Step "${ended.stepName}" failed: ${said}. Trying again (attempt ${String(used + 2)} of ${String(allowed + 1)}).` };
      return enterStep(deps, run, attempts, definition, step.id, { ended, traversals: run.traversals, events: [retrying], retry: used + 1 });
    }
    return endRun(deps, run, { status: "failed", failure: { seq: ended.seq, reason: ended.failure?.reason ?? "step_failed", message: `Step "${ended.stepName}" failed: ${said}.` } });
  }
  if (ended.status !== "succeeded") {
    const given = ended.failure?.message;
    const message = given !== undefined && given !== NO_REASON && given !== PLAIN_CANCEL_REASON ? given : `Step "${ended.stepName}" was cancelled.`;
    return endRun(deps, run, { status: "cancelled", failure: { seq: ended.seq, reason: ended.failure?.reason ?? "step_cancelled", message } });
  }
  // A coding step that answered a question needs a person: nothing goes on, and nothing starts, until they continue or stop.
  if (ended.answered === true && step.kind === "agent") {
    return enterStep(deps, run, attempts, definition, answeredGateId(step.id), { ended, traversals: run.traversals, events: [] }, answeredGateStep(step.id, ended.stepName));
  }
  let edge: Edge;
  let branch: { id: string; fellBack: boolean } | undefined;
  const events: RunEventInput[] = [];
  if (step.kind === "gate") edge = ended.decision === "declined" ? step.onReject : step.onApprove;
  else {
    const chosen = chooseEdge(step.next, ended.result ?? { report: "" });
    if ("error" in chosen) return endRun(deps, run, { status: "failed", failure: { seq: ended.seq, reason: "branch_invalid", message: `${ended.agent?.name ?? step.name} chose no branch this chain has.` } });
    edge = chosen.edge;
    if (chosen.branch !== undefined) {
      branch = { id: chosen.branch, fellBack: chosen.fellBack };
      const description = step.next.kind === "branch" ? step.next.choices.find((choice) => choice.id === chosen.branch)?.description ?? "" : "";
      events.push({
        type: "branch", stepSeq: ended.seq,
        text: chosen.fellBack ? `${ended.agent?.name ?? step.name} chose no designed branch, so the chain took "${chosen.branch}".` : `${ended.agent?.name ?? step.name} chose "${chosen.branch}": ${description}`,
      });
    }
  }
  // The pick is recorded whether or not the edge it names may be taken: a run that stops at a bound still shows what the agent chose.
  const branchUpdate = branch === undefined ? undefined : moveAttempt(deps, run, ended.seq, { branch }, ["succeeded"]);
  const taken = takeEdge(run, step.id, edge);
  if (!taken.ok) return endRun(deps, run, { status: "failed", failure: { seq: ended.seq, reason: "loop_limit", message: taken.message }, events, ...(branchUpdate === undefined ? {} : { attemptUpdate: branchUpdate }) });
  if (edge.to === "$end") return endRun(deps, run, { status: "succeeded", events, fields: { traversals: taken.traversals }, ...(branchUpdate === undefined ? {} : { attemptUpdate: branchUpdate }) });
  return enterStep(deps, run, attempts, definition, edge.to, { ended, traversals: taken.traversals, events, ...(branchUpdate === undefined ? {} : { branchUpdate }) });
}

/** How a step is entered after an attempt: by an edge, or (with `retry`, the retries this visit has used by then) again after a failure. */
interface Entry { ended: StepAttemptRecord; traversals: Record<string, number>; events: RunEventInput[]; branchUpdate?: TransactItem; retry?: number }

/** Writes the next step's attempt (a gate `waiting`, an agent step `starting`) with the run moved on to it and its events, then starts an agent step. */
async function enterStep(deps: Deps, run: ChainRunRecord, attempts: StepAttemptRecord[], definition: PinnedChainDefinition, targetId: string, via: Entry | undefined, implied?: GateStep): Promise<Progress> {
  const target = implied ?? stepOf(definition, targetId);
  if (target === undefined) return endRun(deps, run, { status: "failed", failure: { ...(via === undefined ? {} : { seq: via.ended.seq }), reason: "design_invalid", message: `This chain has no step "${targetId}".` } });
  if (target.kind === "agent" && run.stepRuns + 1 > CHAIN_MAX_STEP_RUNS) {
    return endRun(deps, run, {
      status: "failed", failure: { ...(via === undefined ? {} : { seq: via.ended.seq }), reason: "step_limit", message: `This run reached ${String(CHAIN_MAX_STEP_RUNS)} steps, the most a chain run may take.` },
      ...(via === undefined ? {} : { events: via.events }), ...(via?.branchUpdate === undefined ? {} : { attemptUpdate: via.branchUpdate }),
    });
  }
  const seq = run.currentSeq + 1;
  const attempt = attempts.filter((existing) => existing.stepId === target.id).length + 1;
  const startedAt = iso(deps);
  let record: StepAttemptRecord;
  let events: RunEventInput[];
  let opened: Awaited<ReturnType<typeof openGateApproval>> | undefined;
  if (target.kind === "agent") {
    const agent = { agentId: target.agent.agentId, name: (await agentFacts(deps, run.orgId, target.agent.agentId)).name, version: target.agent.version };
    const input = stepInput(run, target, attempts, seq);
    record = {
      seq, stepId: target.id, stepName: target.name, kind: "agent", attempt, status: "starting", agent, remainingAtStartUsd: stepRunLimitUsd(run),
      inputDigest: digestOf(input), startedAt, ...(via?.retry === undefined ? {} : { retriesUsed: via.retry }),
    };
    events = [{ type: "step_started", stepSeq: seq, text: `Step "${target.name}" started with ${agent.name} version ${String(agent.version)}${attempt > 1 ? ` (attempt ${String(attempt)})` : ""}.` }];
  } else {
    // The gate's approval is made first (its id is a function of the run and the attempt, so a second try, or one after a crash, finds the same record); the attempt
    // that waits on it is written after, in the one transaction that moves the run. An approval left behind by a lost race is never decidable: its gate is not live.
    opened = await openGateApproval(deps, run, target, seq);
    record = {
      seq, stepId: target.id, stepName: target.name, kind: "gate", attempt, status: "waiting", approvalId: opened.record.approvalId,
      inputDigest: digestOf({ gate: target.id, prompt: target.prompt }), startedAt,
    };
    events = [{ type: "gate_waiting", stepSeq: seq, text: opened.waitingText }];
  }
  const traversals = via?.traversals ?? run.traversals;
  // The run is looked at when the gate expires if that is sooner than it was due: its open item moves with it, in the same transaction.
  const dueAt = opened !== undefined && opened.record.expiresAt < run.dueAt ? opened.record.expiresAt : undefined;
  const items = [
    ...(via?.branchUpdate === undefined ? [] : [via.branchUpdate]),
    { Put: { TableName: deps.tableName, Item: { ...attemptKey(run, seq), entityType: "CHAIN_RUN_STEP", orgId: run.orgId, runId: run.runId, ...record }, ConditionExpression: NOT_EXISTS } },
    ...moveRun(deps, run, {
      currentSeq: seq, stepRuns: run.stepRuns + (target.kind === "agent" ? 1 : 0), traversals, status: target.kind === "agent" ? "running" : "waiting", ...(dueAt === undefined ? {} : { dueAt }),
    }, [...(via?.events ?? []), ...events]),
    ...(dueAt === undefined ? [] : [
      { Delete: { TableName: deps.tableName, Key: openChainRunKey(run.dueAt, run.orgId, run.runId) } },
      { Put: { TableName: deps.tableName, Item: { ...openChainRunKey(dueAt, run.orgId, run.runId), entityType: "OPEN_CHAIN_RUN", orgId: run.orgId, runId: run.runId } } },
    ]),
  ];
  try {
    await transact(deps, items);
  } catch (error) {
    if (await lostRace(deps, run, error)) {
      // A gate's approval that the run will never wait on (it ended, or moved on past this gate) would sit PENDING in everyone's list: it is closed.
      if (opened !== undefined) await closeAbandonedGate(deps, run, opened.record.approvalId, seq);
      return "raced";
    }
    throw error;
  }
  if (target.kind === "gate") {
    // An approval that ended before its attempt existed (it expired while the process was down) is told to the gate now: nothing else would.
    if (opened !== undefined && opened.record.status !== "PENDING") await onChainGateDecided(deps, opened.record);
    return "done";
  }
  const fresh = await readChainRun(deps, run.orgId, run.runId);
  if (fresh === undefined) return "done";
  return driveStart(deps, fresh, record, [...attempts, record], definition);
}

const digestOf = (value: unknown): string => createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");

/** What a step is started with: its instructions (or the default), and the earlier reports as information only. */
function stepInput(run: ChainRunRecord, step: PinnedAgentStep, attempts: readonly StepAttemptRecord[], seq: number): RunInput {
  const earlier: EarlierReport[] = attempts
    .filter((attempt) => attempt.kind === "agent" && attempt.status === "succeeded" && attempt.result !== undefined && attempt.agent !== undefined && attempt.seq < seq)
    .map((attempt) => ({ seq: attempt.seq, stepName: attempt.stepName, agentName: attempt.agent!.name, version: attempt.agent!.version, result: attempt.result! }));
  const context = buildHandoff({ runId: run.runId, ...(run.trigger === undefined ? {} : { trigger: run.trigger }), ...(run.input === undefined ? {} : { startInput: run.input }), earlier, mode: step.handoff ?? "previous" });
  return { text: step.instructions === undefined || step.instructions === "" ? DEFAULT_STEP_TEXT : step.instructions, context };
}

/**
 * Starts the task of a `starting` attempt: Plan 3's `startAgentRun`, with the step's own agent at its pinned version and nothing of any other step's. A refusal
 * fails the attempt with the refusal's code and the run with it (a step that never started is not retried); a failure that may pass is left for the next try.
 */
async function driveStart(deps: Deps, run: ChainRunRecord, attempt: StepAttemptRecord, attempts: StepAttemptRecord[], definition: PinnedChainDefinition): Promise<Progress> {
  const step = stepOf(definition, attempt.stepId);
  if (step === undefined || step.kind !== "agent" || attempt.agent === undefined) return endRun(deps, run, { status: "failed", failure: { seq: attempt.seq, reason: "design_invalid", message: `Step "${attempt.stepName}" is not in this chain's design.` } });
  const resultContract: ResultContract | undefined = step.next.kind === "branch" ? { branches: step.next.choices.map(({ id, description }) => ({ id, description })) } : undefined;
  const request: AgentRunRequest = {
    requestId: stepRequestId(run.runId, attempt.seq), orgId: run.orgId, project: run.project, agent: { agentId: attempt.agent.agentId, version: attempt.agent.version }, input: stepInput(run, step, attempts, attempt.seq),
    origin: "chain", owner: { developerId: run.owner.developerId }, ...(run.startedBy.kind === "member" ? { startedBy: { developerId: run.startedBy.developerId } } : {}), payer: run.payer,
    chain: { chainRunId: run.runId, stepId: step.id }, runLimitUsd: attempt.remainingAtStartUsd ?? stepRunLimitUsd(run), ...(resultContract === undefined ? {} : { resultContract }),
  };
  let started: AgentRunResult;
  try {
    started = await deps.chainRuns.startAgentRun(request);
  } catch (error) {
    if (isRetryLater(error)) throw error;
    if (!(error instanceof AgentXError)) {
      (deps.log ?? ((event, fields) => console.log(JSON.stringify({ component: "broker", event, ...fields }))))("chain_run.start_failed", { runId: run.runId, seq: attempt.seq, error: errorName(error) });
      return endRun(deps, run, {
        status: "failed", failure: { seq: attempt.seq, reason: UNEXPECTED_START_REASON, message: unexpectedStartMessage(attempt.stepName) },
        events: [{ type: "step_ended", stepSeq: attempt.seq, text: `Step "${attempt.stepName}" could not start.` }],
        attemptUpdate: moveAttempt(deps, run, attempt.seq, { status: "failed", failure: { reason: UNEXPECTED_START_REASON, message: "it could not be started" }, endedAt: iso(deps) }, ["starting"]),
      });
    }
    const refused = error;
    const message = neutralText(redactSecrets(textOf(refused)), REASON_MAX);
    const failure = { reason: refused.code, message };
    return endRun(deps, run, {
      status: "failed", failure: { seq: attempt.seq, reason: refused.code, message: `Step "${attempt.stepName}" could not start: ${trimStop(message)}.` },
      events: [{ type: "step_ended", stepSeq: attempt.seq, text: `Step "${attempt.stepName}" could not start.` }],
      attemptUpdate: moveAttempt(deps, run, attempt.seq, { status: "failed", failure, endedAt: iso(deps) }, ["starting"]),
    });
  }
  return recordStarted(deps, run, attempt, started);
}

/** The attempt gets its task and its limits, and becomes `running` (or `paused`, when the step has no limit left to run on). */
async function recordStarted(deps: Deps, run: ChainRunRecord, attempt: StepAttemptRecord, started: AgentRunResult): Promise<Progress> {
  for (let round = 0; round < 3; round += 1) {
    const current = await readChainRun(deps, run.orgId, run.runId);
    if (current === undefined || isTerminalStatus(current.status)) {
      // The run was stopped while this start was being made: the task it made has no attempt to tell it so, so it is asked to stop here.
      if (current !== undefined && (current.status === "cancelled" || current.status === "timed_out")) await cancelAbandonedTask(deps, current, attempt.seq, started.taskId);
      return "done";
    }
    const stored = (await readStepAttempts(deps, run.orgId, run.runId)).find((candidate) => candidate.seq === attempt.seq);
    if (stored === undefined || stored.status !== "starting") return "done";
    const fields = { taskId: started.taskId, grantedRunLimitUsd: started.runLimitUsd, stopAtUsd: started.stopAtUsd, status: started.paused ? "paused" : "running" };
    const items: TransactItem[] = [
      update(deps, attemptKey(current, attempt.seq), fields, (aliases) => `${aliases.name("status")} = ${aliases.value("starting")} AND attribute_not_exists(${aliases.name("taskId")})`),
      ...(started.paused ? moveRun(deps, current, { status: "paused" }, [{ type: "paused", stepSeq: attempt.seq, text: `Step "${attempt.stepName}" is paused until its spending limit is raised.` }]) : []),
    ];
    try {
      await transact(deps, items);
      return "done";
    } catch (error) {
      if (failedIndexes(error) === undefined) throw error;
    }
  }
  throw agentXError("WORKSPACE_BUSY", "the chain run kept changing while a step was recorded; try again");
}

// ---- gates (a gate is opened with an approval in `gates.ts`; its outcome comes back through here)

/** Which approval a gate's outcome is for, and who decided it (for the event's words). */
export interface GateOutcomeBy { approvalId: string; name: string }

/**
 * The run's current, waiting gate at `seq` when it waits on `approvalId`, or undefined: the run has ended or moved on, the attempt is not a gate, it was
 * already passed, or it waits on another approval (an earlier attempt of the same gate in a loop, or one that was never this gate's).
 */
async function liveGate(deps: Deps, orgId: OrgId, runId: ChainRunId, seq: number, approvalId: string): Promise<{ run: ChainRunRecord; attempt: StepAttemptRecord } | undefined> {
  const run = await readChainRun(deps, orgId, runId);
  if (run === undefined || isTerminalStatus(run.status) || run.currentSeq !== seq) return undefined;
  const attempt = await readStepAttempt(deps, orgId, runId, seq);
  if (attempt === undefined || attempt.kind !== "gate" || attempt.status !== "waiting" || attempt.approvalId !== approvalId) return undefined;
  return { run, attempt };
}

/** An update of a gate's attempt that applies only while it still waits on this approval. */
const gateAttemptUpdate = (deps: Table, run: ChainRunRecord, seq: number, approvalId: string, fields: Record<string, unknown>): TransactItem =>
  update(deps, attemptKey(run, seq), fields, (aliases) => `${aliases.name("status")} = ${aliases.value("waiting")} AND ${aliases.name("approvalId")} = ${aliases.value(approvalId)}`);

/**
 * A gate's decision, once someone eligible has made it on its approval (`gates.ts` checks who and which approval): the gate's attempt is passed with it and the
 * run goes on by the gate's `onApprove` or `onReject` edge. Only the run's current, waiting gate takes a decision, only when it waits on `by.approvalId`, and only
 * once; the attempt, the run and the `gate_decided` event are one transaction.
 */
export async function recordGateDecision(deps: Deps, orgId: OrgId, runId: ChainRunId, seq: number, decision: "approved" | "declined", by: GateOutcomeBy): Promise<void> {
  const live = await liveGate(deps, orgId, runId, seq, by.approvalId);
  if (live === undefined) return;
  const { run, attempt } = live;
  const answered = answeredGateOrigin(attempt.stepId) !== undefined;
  const words = answered ? `${by.name} chose to ${decision === "approved" ? "continue" : "stop"} after "${answeredStepName(attempt.stepName)}" answered instead of changing code.`
    : decision === "approved" ? `${by.name} approved "${attempt.stepName}"` : `${by.name} sent "${attempt.stepName}" back`;
  try {
    await transact(deps, [
      gateAttemptUpdate(deps, run, seq, by.approvalId, { status: "succeeded", decision, endedAt: iso(deps) }),
      ...moveRun(deps, run, { status: "running" }, [{ type: "gate_decided", stepSeq: seq, text: words }]),
    ]);
  } catch (error) {
    if (failedIndexes(error) === undefined) throw error;
    const now = await readStepAttempt(deps, orgId, runId, seq);
    if (now !== undefined && now.status === "waiting") throw error;
  }
  await advanceChainRun(deps, orgId, runId);
}

/**
 * A gate's approval expired with no decision: the gate's attempt and the run end `timed_out`, with the words of the plan. Only the approval's own expiry reaches this
 * (`onChainGateDecided` for a record `EXPIRED`), so the ending can't be written for a gate that has a decision.
 */
export async function recordGateExpiry(deps: Deps, orgId: OrgId, runId: ChainRunId, seq: number, approvalId: string): Promise<void> {
  for (let round = 0; round < 3; round += 1) {
    const live = await liveGate(deps, orgId, runId, seq, approvalId);
    if (live === undefined) return;
    const { run, attempt } = live;
    const gate = gateStepOf(await designOf(deps, run), attempt);
    const hours = gate?.timeoutHours ?? GATE_DEFAULT_TIMEOUT_HOURS;
    const said = answeredGateOrigin(attempt.stepId) !== undefined ? `No one continued or stopped "${answeredStepName(attempt.stepName)}"` : `No one approved "${attempt.stepName}"`;
    const ended = await endRun(deps, run, {
      status: "timed_out", failure: { seq, reason: "gate_timeout", message: `${said} within ${String(hours)} hour${hours === 1 ? "" : "s"}, so the chain stopped.` },
      attemptUpdate: gateAttemptUpdate(deps, run, seq, approvalId, { status: "timed_out", endedAt: iso(deps) }),
    });
    if (ended === "done") return;
  }
  throw agentXError("WORKSPACE_BUSY", "the chain run kept changing while its gate was closed; try again");
}

// ---- the end and the pause of a step's task

/** The attempt of a step's task, and its run: found by the task id under the event's own org. */
async function findStepAttempt(deps: Deps, event: { orgId: OrgId; taskId: string; chain?: { chainRunId: string; stepId: string } }): Promise<{ run: ChainRunRecord; attempt: StepAttemptRecord } | undefined> {
  if (event.chain === undefined) return undefined;
  const runId = ChainRunIdSchema.safeParse(event.chain.chainRunId);
  if (!runId.success) return undefined;
  const run = await readChainRun(deps, event.orgId, runId.data);
  if (run === undefined) return undefined;
  const attempts = await readStepAttempts(deps, event.orgId, run.runId);
  const stepId = event.chain.stepId;
  const named = attempts.find((candidate) => candidate.taskId === event.taskId && candidate.stepId === stepId);
  if (named !== undefined) return { run, attempt: named };
  // The task exists from Plan 3's start commit but the attempt learns its id only when `startAgentRun` returns. A task that ends or pauses in between (a crash after the
  // start, then a short run) belongs to the run's current attempt of that step that is still starting with no task: the end or pause handler writes the id with its own move.
  const starting = attempts.find((candidate) => candidate.seq === run.currentSeq && candidate.stepId === stepId && candidate.status === "starting" && candidate.taskId === undefined);
  return starting === undefined ? undefined : { run, attempt: starting };
}

/** An attempt whose task has not ended: still starting (its task id not yet written), running or paused. */
const isLive = (attempt: StepAttemptRecord): boolean => attempt.status === "starting" || attempt.status === "running" || attempt.status === "paused";

/** The task id an end or a pause writes with its own move, for an attempt that was still starting and so had none. */
const taskFields = (attempt: StepAttemptRecord, taskId: string): Record<string, unknown> => (attempt.taskId === undefined ? { taskId } : {});

/** What a task ended with, as the attempt's result, or why it did not succeed. */
async function resultOf(deps: Deps, run: ChainRunRecord, attempt: StepAttemptRecord, event: TaskEndEvent): Promise<{ status: "succeeded"; result: StepResult } | { status: "failed" | "cancelled"; failure: { reason: string; message: string } }> {
  const agentRun = await getItem(deps, taskAgentRunKey(event.taskId));
  const isAgentRun = agentRun !== undefined && agentRun["orgId"] === run.orgId;
  // A Rovara Code step that answered a question needing no code change succeeded: it opened no pull request, and its report is the answer.
  if (event.outcome === "answered") {
    const task = await getItem(deps, { pk: `DEVTASK#${event.taskId}`, sk: "META" });
    const workflow = task === undefined || task["orgId"] !== run.orgId ? undefined : task["workflow"] as WorkflowSnapshot | undefined;
    const answer = workflow === undefined ? undefined : workflowAnswer(workflow);
    const report = answer === undefined ? `${CODING_AGENT_NAME} finished: answered.` : shortenToBytes(redactSecrets(answeredMessage(answer)), AGENT_REPORT_MAX_BYTES);
    return { status: "succeeded", result: StepResultSchema.parse({ report }) };
  }
  if (event.outcome === "succeeded" || event.outcome === "merged") {
    if (isAgentRun) {
      const report = shortenToBytes(event.finalReport ?? "", AGENT_REPORT_MAX_BYTES);
      if (report.trim() === "") return { status: "failed", failure: { reason: "result_invalid", message: `${attempt.agent?.name ?? attempt.stepName} finished without a report.` } };
      const branch = event.branch !== undefined && BranchIdSchema.safeParse(event.branch).success ? event.branch : undefined;
      return { status: "succeeded", result: { report, ...(branch === undefined ? {} : { branch }) } };
    }
    const links = (event.pullRequests ?? []).flatMap((pullRequest) => {
      const link = StepLinkSchema.safeParse({ label: neutralText(`Pull request ${pullRequest.repository}#${String(pullRequest.number)}`, 80), url: pullRequest.url });
      return link.success ? [link.data] : [];
    }).slice(0, STEP_LINKS_MAX);
    const result = StepResultSchema.parse({ report: `${CODING_AGENT_NAME} finished: ${event.outcome}.`, ...(links.length === 0 ? {} : { links }) });
    return { status: "succeeded", result };
  }
  const task = await getItem(deps, { pk: `DEVTASK#${event.taskId}`, sk: "META" });
  const said = [isAgentRun ? agentRun["endReason"] : undefined, task?.["outcomeReason"]].find((candidate): candidate is string => typeof candidate === "string" && candidate !== "");
  const reason = neutralText(redactSecrets(said ?? NO_REASON), REASON_MAX);
  // A report nothing backed (Plan 3 grounding): the run failed, and the chain says it is a person's to look at, not a step that broke.
  if (event.outcome === "failed") return { status: "failed", failure: { reason: isAgentRun && typeof said === "string" && said.startsWith(UNVERIFIED_END_PREFIX) ? "step_unverified" : "step_failed", message: reason } };
  return { status: "cancelled", failure: { reason: event.outcome === "cancelled" ? "step_cancelled" : event.outcome, message: reason } };
}

/**
 * Whether a cancelled task of a flagged attempt was stopped by the cancel the sweep asked for (and Plan 3 took) rather than by a person: a cancel of the task by a person, or
 * a declined write approval, is the person's word and ends the run `cancelled`; only the sweep's own cancel is a timeout. The sweep's cancel is found by its request id
 * (`cancelRequestId`), which Plan 3 keeps beside the task's other requests when it takes the cancel. A person's cancel that lands after the sweep's was taken can't be told apart
 * (the task was being stopped for its time anyway), and counts as the timeout.
 */
async function endedByOwnTimeoutCancel(deps: Deps, run: ChainRunRecord, attempt: StepAttemptRecord, event: TaskEndEvent, said: string): Promise<boolean> {
  if (isDeclinedEndReason(said)) return false;
  const task = await getItem(deps, { pk: `DEVTASK#${event.taskId}`, sk: "META" });
  if (task === undefined || task["orgId"] !== run.orgId || typeof task["ownerKey"] !== "string" || typeof task["workspaceId"] !== "string") return false;
  return await getItem(deps, taskActionRequestKey({ ownerKey: task["ownerKey"], workspaceId: task["workspaceId"] }, cancelRequestId(run.runId, attempt.seq))) !== undefined;
}

/**
 * The end of the task of an attempt that the run's own ending (a cancel, a run timeout) ended first: its spend is added to the run's `spentUsd`, once (the attempt's
 * `spendPending` goes with it, in the same transaction). Anything else about the run and the attempt stays as the ending left it.
 */
async function settleStoppedSpend(deps: Deps, run: ChainRunRecord, attempt: StepAttemptRecord, event: TaskEndEvent): Promise<void> {
  let current: { run: ChainRunRecord; attempt: StepAttemptRecord } | undefined = { run, attempt };
  for (let round = 0; round < 3 && current !== undefined && current.attempt.spendPending === true; round += 1) {
    const settled = settleStepSpend(current.run, { remainingAtStartUsd: current.attempt.remainingAtStartUsd ?? stepRunLimitUsd(current.run) }, event);
    try {
      await transact(deps, [
        update(deps, attemptKey(current.run, current.attempt.seq), { spendPending: false }, (aliases) => `${aliases.name("spendPending")} = ${aliases.value(true)}`),
        ...moveRun(deps, current.run, { spentUsd: settled.run.spentUsd }, []),
      ]);
      return;
    } catch (error) {
      if (failedIndexes(error) === undefined) throw error;
      current = await findStepAttempt(deps, event);
    }
  }
}

/**
 * A step's task has ended (registered with `registerTaskEndHandler`). The attempt takes the task's end and the run settles the step's spend, with the step's
 * event, in one transaction; then the run moves on. Idempotent: an attempt that already ended is not ended again, but the run is moved on, so an end whose first
 * handling stopped half way is finished by the next telling. An event with no chain, for another run or org, or for a run that has ended, does nothing.
 */
export async function onStepTaskEnded(deps: Deps, event: TaskEndEvent): Promise<void> {
  const found = await findStepAttempt(deps, event);
  if (found === undefined) return;
  const { run, attempt } = found;
  if (isTerminalStatus(run.status)) {
    await settleStoppedSpend(deps, run, attempt, event);
    return;
  }
  if (!isLive(attempt)) {
    await advanceChainRun(deps, run.orgId, run.runId);
    return;
  }
  const outcome = await resultOf(deps, run, attempt, event);
  const settled = settleStepSpend(run, { remainingAtStartUsd: attempt.remainingAtStartUsd ?? stepRunLimitUsd(run) }, event);
  // A task that ended in the cancel the sweep asked for (its attempt ran past its time) timed out; one that finished anyway, or failed on its own, is what it did, and a
  // person's cancel or decline that ended it is theirs: it is never retried.
  const timedOut = attempt.timedOutAt !== undefined && outcome.status === "cancelled" && await endedByOwnTimeoutCancel(deps, run, attempt, event, outcome.failure.message);
  const minutes = attempt.timeoutMinutes ?? STEP_DEFAULT_TIMEOUT_MINUTES;
  const fields = outcome.status === "succeeded" ? { status: "succeeded", result: outcome.result, ...(event.outcome === "answered" ? { answered: true } : {}) }
    : timedOut ? { status: "timed_out", failure: { reason: "step_timeout", message: `it ran longer than ${String(minutes)} minutes` } }
    : { status: outcome.status, failure: outcome.failure };
  const events: RunEventInput[] = [];
  if (attempt.status === "paused" && outcome.status === "succeeded") events.push({ type: "resumed", stepSeq: attempt.seq, text: `Step "${attempt.stepName}" is running again.` });
  events.push({
    type: "step_ended", stepSeq: attempt.seq,
    text: outcome.status === "succeeded" ? (event.outcome === "answered" ? `Step "${attempt.stepName}" answered instead of changing code.` : `Step "${attempt.stepName}" finished.`) : timedOut ? `Step "${attempt.stepName}" ran out of time.` : outcome.status === "cancelled" ? `Step "${attempt.stepName}" was cancelled.` : `Step "${attempt.stepName}" failed.`,
  });
  if (settled.raisedUsd > 0) events.push({ type: "step_ended", stepSeq: attempt.seq, text: runRaiseMessage("Someone", settled.raisedUsd) });
  try {
    await transact(deps, [
      moveAttempt(deps, run, attempt.seq, { ...fields, ...taskFields(attempt, event.taskId), endedAt: iso(deps) }, ["starting", "running", "paused"]),
      ...moveRun(deps, run, { status: run.status === "paused" ? "running" : run.status, spentUsd: settled.run.spentUsd, runLimitUsd: settled.run.runLimitUsd }, events),
    ]);
  } catch (error) {
    if (failedIndexes(error) === undefined) throw error;
    // Another telling of the same end got there first (or the run moved): read it again, and go on if the attempt has ended.
    const again = await findStepAttempt(deps, event);
    if (again !== undefined && !isLive(again.attempt)) {
      // A cancel or the run's time got in first: the run is over and the attempt carries `spendPending`, so the task's spend is added here, as for any end told later.
      if (isTerminalStatus(again.run.status)) await settleStoppedSpend(deps, again.run, again.attempt, event);
      await advanceChainRun(deps, run.orgId, run.runId);
      return;
    }
    throw error;
  }
  await advanceChainRun(deps, run.orgId, run.runId);
}

/**
 * A step's task is paused for money (registered with `registerTaskPauseHandler`). A pause is not an end: the attempt and the run become `paused` with an event, and
 * nothing else changes: no second task, no retry, nothing released. The task's end (or `markStepResumed`) moves them back to `running`.
 */
export async function onStepTaskPaused(deps: Deps, event: TaskPauseEvent): Promise<void> {
  const found = await findStepAttempt(deps, event);
  if (found === undefined) return;
  const { run, attempt } = found;
  if (isTerminalStatus(run.status) || (attempt.status !== "running" && attempt.status !== "starting")) return;
  try {
    await transact(deps, [
      moveAttempt(deps, run, attempt.seq, { status: "paused", ...taskFields(attempt, event.taskId) }, ["starting", "running"]),
      ...moveRun(deps, run, { status: "paused" }, [{ type: "paused", stepSeq: attempt.seq, text: `Step "${attempt.stepName}" is paused until its spending limit is raised.` }]),
    ]);
  } catch (error) {
    if (failedIndexes(error) === undefined) throw error;
    const again = await findStepAttempt(deps, event);
    if (again === undefined || (again.attempt.status !== "running" && again.attempt.status !== "starting")) return;
    throw error;
  }
}

/** A paused step went on (its limit was raised): the attempt and the run are `running` again, with an event, once. */
export async function markStepResumed(deps: Deps, orgId: OrgId, runId: ChainRunId, taskId: string): Promise<void> {
  const run = await readChainRun(deps, orgId, runId);
  if (run === undefined || isTerminalStatus(run.status)) return;
  const attempt = (await readStepAttempts(deps, orgId, runId)).find((candidate) => candidate.taskId === taskId);
  if (attempt === undefined || attempt.status !== "paused") return;
  try {
    await transact(deps, [
      moveAttempt(deps, run, attempt.seq, { status: "running" }, ["paused"]),
      ...moveRun(deps, run, { status: "running" }, [{ type: "resumed", stepSeq: attempt.seq, text: `Step "${attempt.stepName}" is running again.` }]),
    ]);
  } catch (error) {
    if (failedIndexes(error) === undefined) throw error;
    const now = (await readStepAttempts(deps, orgId, runId)).find((candidate) => candidate.taskId === taskId);
    if (now !== undefined && now.status === "paused") throw error;
  }
}

/** A step's task went on after a raise (registered with `registerTaskResumeHandler`): the step and the run are `running` again. Ignores a task with no chain. */
export async function onStepTaskResumed(deps: Deps, event: TaskResumeEvent): Promise<void> {
  if (event.chain === undefined) return;
  const runId = ChainRunIdSchema.safeParse(event.chain.chainRunId);
  if (!runId.success) return;
  await markStepResumed(deps, event.orgId, runId.data, event.taskId);
}

// ---- the spend seam

/** What the spend requests ask of a run (`chainRunBudgets`): the chain, and what the run had left of its own limit when the step's latest attempt started. */
export function chainRunSpendReader(deps: Table): ChainRunSpendReader {
  return {
    stepLimits: async (orgId, ref) => {
      const runId = ChainRunIdSchema.safeParse(ref.chainRunId);
      if (!runId.success) return undefined;
      const run = await readChainRun(deps, orgId, runId.data);
      if (run === undefined) return undefined;
      const latest = (await readStepAttempts(deps, orgId, run.runId)).filter((attempt) => attempt.stepId === ref.stepId && attempt.remainingAtStartUsd !== undefined).at(-1);
      return latest === undefined ? undefined : { chainId: run.chainId, remainingAtStartUsd: latest.remainingAtStartUsd! };
    },
  };
}
