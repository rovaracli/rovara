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
import {
  AGENT_REPORT_MAX_BYTES, AgentXError, CHAIN_MAX_CONCURRENT_RUNS, CHAIN_MAX_STEP_RUNS, CHAIN_START_INPUT_MAX, ChainRunIdSchema, ChainRunStartedBySchema,
  StepLinkSchema, StepResultSchema, STEP_LINKS_MAX, agentXError, canonicalJson, chainKey, chainRunKey, chainRunsByChainKey, chainRunsByProjectKey, isBuiltinAgentId, newPrefixedId,
  openChainRunKey, projectAllows, shortenToBytes, stepSk,
  type AgentId, type AgentOwner, type ChainId, type ChainRunId, type ChainRunStartedBy, type ChainRunStatus, type Edge,
  type OrgId, type Payer, type PinnedChainDefinition, type ResultContract, type RunInput, type StepAttemptStatus, type StepResult, type WorkOrigin,
} from "@agentx/contracts";
import { requireAgentAccess, type AgentCaller } from "../agents/access.js";
import type { AgentRunRequest, AgentRunResult, AgentRunStarter } from "../agents/runs.js";
import { resolveAgentForAutonomousRun, resolveAgentForTask, roleOnProject, type RosterDependencies } from "../agents/roster.js";
import { startAgentRun } from "../agents/runs.js";
import type { TaskEndEvent, TaskPauseEvent } from "../agents/task-end.js";
import { Aliases, NOT_EXISTS, failedIndexes, strip, type TransactItem } from "../agents/table-writes.js";
import { requireNewWorkAllowed } from "../developer/project-roles.js";
import { taskAgentRunKey } from "../developer/task-records.js";
import type { AdmissionDependencies } from "../org/budget.js";
import { readProjectAiWithRevision } from "../spend/settings.js";
import type { ChainRunSpendReader } from "../spend/chain-run-spend.js";
import { chooseEdge, takeEdge } from "./branches.js";
import { admitChainRun, chainRunLimitUsd, chainRunPayer, runRaiseMessage, settleStepSpend, stepRunLimitUsd, type ChainRunOrigin } from "./budget.js";
import { requireChainAccess, type ChainAccessDeps } from "./access.js";
import { buildHandoff, HandoffTriggerSchema, redactSecrets, type EarlierReport, type HandoffTrigger } from "./handoff.js";
import { neutralText, runEventItems, type RunEventInput } from "./run-events.js";
import type { ChainRouteDependencies } from "./routes.js";
import type { ChainRecord } from "./store.js";

// ---- records

const TERMINAL: ReadonlySet<string> = new Set<ChainRunStatus>(["succeeded", "failed", "cancelled", "timed_out"]);
/** Whether a run (or an attempt) has ended: nothing moves it again. */
export const isTerminalStatus = (status: string): boolean => TERMINAL.has(status);

/** How a run ends: the states nothing moves it out of. */
type EndStatus = "succeeded" | "failed" | "cancelled" | "timed_out";

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

type Deps = ChainRunnerDependencies;
type Table = Pick<Deps, "documentClient" | "tableName" | "now">;

/** How soon the sweep (Task 9) first looks at a new run. */
const FIRST_LOOK_MS = 5 * 60_000;
/** Plan 3 and the model's own words for a step that did nothing to say. */
const DEFAULT_STEP_TEXT = "Do your job for this chain run.";
const CODING_AGENT_NAME = "Rovara Code";
const REASON_MAX = 300;

const iso = (deps: Pick<Table, "now">): string => new Date(deps.now()).toISOString();
const errorName = (error: unknown): string => (error instanceof Error ? error.name : "unknown");

/** The words of an error without the `CODE: ` Plan 3's errors begin with, and without a full stop at the end (the caller adds its own). */
const reasonOf = (error: AgentXError): string => trimStop(error.message.startsWith(`${error.code}: `) ? error.message.slice(error.code.length + 2) : error.message);
const trimStop = (text: string): string => text.replace(/\.+$/u, "");
const textOf = (error: AgentXError): string => (error.message.startsWith(`${error.code}: `) ? error.message.slice(error.code.length + 2) : error.message);

/** A refusal that may pass on its own: the start is left as it is, to be driven again with the same request id. */
function isTransient(error: unknown): boolean {
  if (!(error instanceof AgentXError)) return true;
  return error.statusCode >= 500 || error.code === "WORKSPACE_BUSY" || error.code === "TOO_MANY_REQUESTS";
}

// ---- reading

async function getItem(deps: Table, key: { pk: string; sk: string }): Promise<Record<string, unknown> | undefined> {
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

/** Every attempt of the run, in order. */
export async function readStepAttempts(deps: Table, orgId: OrgId, runId: ChainRunId): Promise<StepAttemptRecord[]> {
  const items = await queryPrefix(deps, chainRunKey(orgId, runId, "META").pk, "STEP#");
  return items.map((item) => strip(item as { pk: string; sk: string; entityType: string }) as unknown as StepAttemptRecord).sort((left, right) => left.seq - right.seq);
}

// ---- writing

const transact = (deps: Table, items: TransactItem[]) => deps.documentClient.send(new TransactWriteCommand({ TransactItems: items }));

/** An update of one item's fields, conditional on a clause built with the same aliases. Fields that are undefined are left out. */
function update(deps: Table, key: { pk: string; sk: string }, fields: Record<string, unknown>, when: (aliases: Aliases) => string): TransactItem {
  const aliases = new Aliases();
  const sets = Object.entries(fields).filter(([, value]) => value !== undefined).map(([name, value]) => `${aliases.name(name)} = ${aliases.value(value)}`);
  const condition = when(aliases);
  return { Update: { TableName: deps.tableName, Key: key, UpdateExpression: `SET ${sets.join(", ")}`, ConditionExpression: condition, ExpressionAttributeNames: aliases.names, ExpressionAttributeValues: aliases.values } };
}

const runKey = (run: Pick<ChainRunRecord, "orgId" | "runId">) => chainRunKey(run.orgId, run.runId, "META");
const attemptKey = (run: Pick<ChainRunRecord, "orgId" | "runId">, seq: number) => chainRunKey(run.orgId, run.runId, stepSk(seq));

/** The run's META moved to `fields` with its events: `eventSeq`, `version` and `updatedAt` move with them, and it applies only while the version is the one that was read. */
function moveRun(deps: Table, run: ChainRunRecord, fields: Record<string, unknown>, events: readonly RunEventInput[]): TransactItem[] {
  const numbered = runEventItems(deps.tableName, run, events, iso(deps));
  const move = update(deps, runKey(run), { ...fields, eventSeq: numbered.eventSeq, version: run.version + 1, updatedAt: iso(deps) }, (aliases) => `${aliases.name("version")} = ${aliases.value(run.version)}`);
  return [move, ...numbered.items];
}

/** An update of an attempt that applies only while it is in one of the statuses given. */
function moveAttempt(deps: Table, run: ChainRunRecord, seq: number, fields: Record<string, unknown>, from: readonly string[]): TransactItem {
  return update(deps, attemptKey(run, seq), fields, (aliases) => `(${from.map((status) => `${aliases.name("status")} = ${aliases.value(status)}`).join(" OR ")})`);
}

/** Whether a failed transaction was a lost race: the run has moved since it was read. Anything else is the caller's to throw. */
async function lostRace(deps: Table, run: ChainRunRecord, error: unknown): Promise<boolean> {
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

type PinnedStep = PinnedChainDefinition["steps"][number];
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
      if (person !== undefined) await resolveAgentForTask(deps as RosterDependencies, person, { project: input.project, agent: { agentId: step.agent.agentId, version: step.agent.version }, role: role! });
      else await resolveAgentForAutonomousRun(deps as RosterDependencies, { orgId: input.orgId, project: input.project, agentId: step.agent.agentId, version: step.agent.version });
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
    await transact(deps, runStartItems(deps, run, chain));
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

/** The items of a run's start transaction (Plan 5's session items join them here). */
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

async function designOf(deps: Deps, run: ChainRunRecord): Promise<PinnedChainDefinition> {
  const version = await deps.chains.getVersion(run.orgId, run.chainId, run.chainVersion);
  if (version === undefined) throw agentXError("RUNTIME_UNAVAILABLE", "a chain run's version is missing");
  return version.definition;
}

const stepOf = (definition: PinnedChainDefinition, stepId: string): PinnedStep | undefined => definition.steps.find((step) => step.id === stepId);

/** The end of a run: its terminal state, its event, and the open item and the chain's open-run count given back, in one transaction (the caller adds an attempt's update). */
function endRunItems(deps: Table, run: ChainRunRecord, ended: { status: EndStatus; failure?: ChainRunFailure; events: RunEventInput[]; fields?: Record<string, unknown> }): TransactItem[] {
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
  const dropOpen: TransactItem = { Delete: { TableName: deps.tableName, Key: openChainRunKey(run.dueAt, run.orgId, run.runId), ConditionExpression: "attribute_exists(pk)" } };
  return [...moveRun(deps, run, { status: ended.status, endedAt: iso(deps), ...(ended.failure === undefined ? {} : { failure: ended.failure }), ...ended.fields }, [...ended.events, closing]), dropOpen, give];
}

/** Ends the run as failed (or `status`) because of the attempt `seq`, with the attempt's own update when it has one. */
async function endRun(deps: Deps, run: ChainRunRecord, ended: { status: EndStatus; failure?: ChainRunFailure; events?: RunEventInput[]; attemptUpdate?: TransactItem; fields?: Record<string, unknown> }): Promise<Progress> {
  try {
    await transact(deps, [...endRunItems(deps, run, { status: ended.status, ...(ended.failure === undefined ? {} : { failure: ended.failure }), events: ended.events ?? [], ...(ended.fields === undefined ? {} : { fields: ended.fields }) }), ...(ended.attemptUpdate === undefined ? [] : [ended.attemptUpdate])]);
    return "done";
  } catch (error) {
    if (await lostRace(deps, run, error)) return "raced";
    throw error;
  }
}

/** What follows an attempt that ended: its edge, or the end of the run. (Task 9 adds retries before a failed attempt fails the run.) */
async function afterAttempt(deps: Deps, run: ChainRunRecord, ended: StepAttemptRecord, attempts: StepAttemptRecord[], definition: PinnedChainDefinition): Promise<Progress> {
  const step = stepOf(definition, ended.stepId);
  if (step === undefined) return endRun(deps, run, { status: "failed", failure: { seq: ended.seq, reason: "design_invalid", message: `Step "${ended.stepName}" is not in this chain's design.` } });
  if (ended.status !== "succeeded") {
    const status = ended.status === "cancelled" ? "cancelled" : ended.status === "timed_out" ? "timed_out" : "failed";
    const reason = ended.failure?.reason ?? (status === "cancelled" ? "step_cancelled" : "step_failed");
    const message = status === "cancelled" ? `Step "${ended.stepName}" was cancelled.` : `Step "${ended.stepName}" ${status === "timed_out" ? "ran out of time" : "failed"}: ${trimStop(ended.failure?.message ?? "it did not finish")}.`;
    return endRun(deps, run, { status, failure: { seq: ended.seq, reason, message } });
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
  const taken = takeEdge(run, step.id, edge);
  if (!taken.ok) return endRun(deps, run, { status: "failed", failure: { seq: ended.seq, reason: "loop_limit", message: taken.message } });
  const branchUpdate = branch === undefined ? undefined : moveAttempt(deps, run, ended.seq, { branch }, ["succeeded"]);
  if (edge.to === "$end") return endRun(deps, run, { status: "succeeded", events, fields: { traversals: taken.traversals }, ...(branchUpdate === undefined ? {} : { attemptUpdate: branchUpdate }) });
  return enterStep(deps, run, attempts, definition, edge.to, { ended, traversals: taken.traversals, events, ...(branchUpdate === undefined ? {} : { branchUpdate }) });
}

interface Entry { ended: StepAttemptRecord; traversals: Record<string, number>; events: RunEventInput[]; branchUpdate?: TransactItem }

/** Writes the next step's attempt (a gate `waiting`, an agent step `starting`) with the run moved on to it and its events, then starts an agent step. */
async function enterStep(deps: Deps, run: ChainRunRecord, attempts: StepAttemptRecord[], definition: PinnedChainDefinition, targetId: string, via: Entry | undefined): Promise<Progress> {
  const target = stepOf(definition, targetId);
  if (target === undefined) return endRun(deps, run, { status: "failed", failure: { ...(via === undefined ? {} : { seq: via.ended.seq }), reason: "design_invalid", message: `This chain has no step "${targetId}".` } });
  if (target.kind === "agent" && run.stepRuns + 1 > CHAIN_MAX_STEP_RUNS) {
    return endRun(deps, run, { status: "failed", failure: { ...(via === undefined ? {} : { seq: via.ended.seq }), reason: "step_limit", message: `This run reached ${String(CHAIN_MAX_STEP_RUNS)} steps, the most a chain run may take.` } });
  }
  const seq = run.currentSeq + 1;
  const attempt = attempts.filter((existing) => existing.stepId === target.id).length + 1;
  const startedAt = iso(deps);
  let record: StepAttemptRecord;
  let events: RunEventInput[];
  if (target.kind === "agent") {
    const agent = { agentId: target.agent.agentId, name: (await agentFacts(deps, run.orgId, target.agent.agentId)).name, version: target.agent.version };
    const input = stepInput(run, target, attempts, seq);
    record = {
      seq, stepId: target.id, stepName: target.name, kind: "agent", attempt, status: "starting", agent, remainingAtStartUsd: stepRunLimitUsd(run),
      inputDigest: digestOf(input), startedAt,
    };
    events = [{ type: "step_started", stepSeq: seq, text: `Step "${target.name}" started with ${agent.name} version ${String(agent.version)}${attempt > 1 ? ` (attempt ${String(attempt)})` : ""}.` }];
  } else {
    record = { seq, stepId: target.id, stepName: target.name, kind: "gate", attempt, status: "waiting", inputDigest: digestOf({ gate: target.id, prompt: target.prompt }), startedAt };
    events = [{ type: "gate_waiting", stepSeq: seq, text: `Waiting for approval of "${target.name}".` }];
  }
  const traversals = via?.traversals ?? run.traversals;
  const items = [
    ...(via?.branchUpdate === undefined ? [] : [via.branchUpdate]),
    { Put: { TableName: deps.tableName, Item: { ...attemptKey(run, seq), entityType: "CHAIN_RUN_STEP", orgId: run.orgId, runId: run.runId, ...record }, ConditionExpression: NOT_EXISTS } },
    ...moveRun(deps, run, {
      currentSeq: seq, stepRuns: run.stepRuns + (target.kind === "agent" ? 1 : 0), traversals, status: target.kind === "agent" ? "running" : "waiting",
    }, [...(via?.events ?? []), ...events]),
  ];
  try {
    await transact(deps, items);
  } catch (error) {
    if (await lostRace(deps, run, error)) return "raced";
    throw error;
  }
  if (target.kind === "gate") return "done";
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
    if (isTransient(error)) throw error;
    const refused = error as AgentXError;
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
    if (current === undefined || isTerminalStatus(current.status)) return "done";
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

// ---- gates (Task 8 opens them with an approval; the decision comes back through here)

/**
 * A gate's decision, once someone eligible has made it (Task 8 checks who): the gate's attempt is passed with it and the run goes on by the gate's `onApprove` or
 * `onReject` edge. Only the run's current, waiting gate takes a decision, and only once.
 */
export async function recordGateDecision(deps: Deps, orgId: OrgId, runId: ChainRunId, seq: number, decision: "approved" | "declined"): Promise<void> {
  const run = await readChainRun(deps, orgId, runId);
  if (run === undefined || isTerminalStatus(run.status) || run.currentSeq !== seq) return;
  const attempt = (await readStepAttempts(deps, orgId, runId)).find((candidate) => candidate.seq === seq);
  if (attempt === undefined || attempt.kind !== "gate" || attempt.status !== "waiting") return;
  try {
    await transact(deps, [
      moveAttempt(deps, run, seq, { status: "succeeded", decision, endedAt: iso(deps) }, ["waiting"]),
      ...moveRun(deps, run, { status: "running" }, [{ type: "gate_decided", stepSeq: seq, text: `Gate "${attempt.stepName}" was ${decision === "approved" ? "approved" : "sent back"}.` }]),
    ]);
  } catch (error) {
    if (failedIndexes(error) === undefined) throw error;
    const now = (await readStepAttempts(deps, orgId, runId)).find((candidate) => candidate.seq === seq);
    if (now !== undefined && now.status === "waiting") throw error;
  }
  await advanceChainRun(deps, orgId, runId);
}

// ---- the end and the pause of a step's task

/** The attempt of a step's task, and its run: found by the task id under the event's own org. */
async function findStepAttempt(deps: Deps, event: { orgId: OrgId; taskId: string; chain?: { chainRunId: string; stepId: string } }): Promise<{ run: ChainRunRecord; attempt: StepAttemptRecord } | undefined> {
  if (event.chain === undefined) return undefined;
  const runId = ChainRunIdSchema.safeParse(event.chain.chainRunId);
  if (!runId.success) return undefined;
  const run = await readChainRun(deps, event.orgId, runId.data);
  if (run === undefined) return undefined;
  const attempt = (await readStepAttempts(deps, event.orgId, run.runId)).find((candidate) => candidate.taskId === event.taskId && candidate.stepId === event.chain!.stepId);
  return attempt === undefined ? undefined : { run, attempt };
}

/** What a task ended with, as the attempt's result, or why it did not succeed. */
async function resultOf(deps: Deps, run: ChainRunRecord, attempt: StepAttemptRecord, event: TaskEndEvent): Promise<{ status: "succeeded"; result: StepResult } | { status: "failed" | "cancelled"; failure: { reason: string; message: string } }> {
  const agentRun = await getItem(deps, taskAgentRunKey(event.taskId));
  const isAgentRun = agentRun !== undefined && agentRun["orgId"] === run.orgId;
  if (event.outcome === "succeeded" || event.outcome === "merged") {
    if (isAgentRun) {
      const report = shortenToBytes(event.finalReport ?? "", AGENT_REPORT_MAX_BYTES);
      if (report.trim() === "") return { status: "failed", failure: { reason: "result_invalid", message: `${attempt.agent?.name ?? attempt.stepName} finished without a report.` } };
      const branch = event.branch !== undefined && /^[a-z][a-z0-9_]{0,23}$/u.test(event.branch) ? event.branch : undefined;
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
  const said = (isAgentRun ? agentRun["endReason"] : undefined) ?? task?.["outcomeReason"];
  const reason = neutralText(redactSecrets(typeof said === "string" && said !== "" ? said : "it did not finish"), REASON_MAX);
  if (event.outcome === "failed") return { status: "failed", failure: { reason: "step_failed", message: reason } };
  return { status: "cancelled", failure: { reason: event.outcome === "cancelled" ? "step_cancelled" : event.outcome, message: reason } };
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
  if (isTerminalStatus(run.status)) return;
  if (attempt.status !== "running" && attempt.status !== "paused") {
    await advanceChainRun(deps, run.orgId, run.runId);
    return;
  }
  const outcome = await resultOf(deps, run, attempt, event);
  const settled = settleStepSpend(run, { remainingAtStartUsd: attempt.remainingAtStartUsd ?? stepRunLimitUsd(run) }, event);
  const events: RunEventInput[] = [];
  if (attempt.status === "paused" && outcome.status === "succeeded") events.push({ type: "resumed", stepSeq: attempt.seq, text: `Step "${attempt.stepName}" is running again.` });
  events.push({
    type: "step_ended", stepSeq: attempt.seq,
    text: outcome.status === "succeeded" ? `Step "${attempt.stepName}" finished.` : outcome.status === "cancelled" ? `Step "${attempt.stepName}" was cancelled.` : `Step "${attempt.stepName}" failed.`,
  });
  if (settled.raisedUsd > 0) events.push({ type: "step_ended", stepSeq: attempt.seq, text: runRaiseMessage("Someone", settled.raisedUsd) });
  const fields = outcome.status === "succeeded" ? { status: "succeeded", result: outcome.result } : { status: outcome.status, failure: outcome.failure };
  try {
    await transact(deps, [
      moveAttempt(deps, run, attempt.seq, { ...fields, endedAt: iso(deps) }, ["running", "paused"]),
      ...moveRun(deps, run, { status: run.status === "paused" ? "running" : run.status, spentUsd: settled.run.spentUsd, runLimitUsd: settled.run.runLimitUsd }, events),
    ]);
  } catch (error) {
    if (failedIndexes(error) === undefined) throw error;
    // Another telling of the same end got there first (or the run moved): read it again, and go on if the attempt has ended.
    const again = await findStepAttempt(deps, event);
    if (again !== undefined && again.attempt.status !== "running" && again.attempt.status !== "paused") {
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
  if (isTerminalStatus(run.status) || attempt.status !== "running") return;
  try {
    await transact(deps, [
      moveAttempt(deps, run, attempt.seq, { status: "paused" }, ["running"]),
      ...moveRun(deps, run, { status: "paused" }, [{ type: "paused", stepSeq: attempt.seq, text: `Step "${attempt.stepName}" is paused until its spending limit is raised.` }]),
    ]);
  } catch (error) {
    if (failedIndexes(error) === undefined) throw error;
    const again = await findStepAttempt(deps, event);
    if (again === undefined || again.attempt.status !== "running") return;
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
