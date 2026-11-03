import { usdToWholeMicrodollars } from "../org/budget-amount.js";
import { nativeSnapshotConditions } from "../org/native-snapshot-conditions.js";
import { checkedTaskStopSnapshot } from "../org/task-stop-window.js";
import { auditTaskStopDecision, auditOccurrence } from "../audit/events.js";
import { auditPendingItem } from "../audit/outbox.js";
// Plan 3 Task 31: admission and key caps at every budget level. A run is admitted (`admitWork`) only when each budget it counts against has room, and every
// model key it is given is capped (`mintOperationKey`) at the smallest room anywhere: the run's own limits, the step's, the proxy's figure for the member and
// the org, and every limited scope's limit less what is already counted or held there. A key's cap is held on those scopes (reserved, Task 30's ledger) before
// the key is handed out, so concurrent work cannot spend the same dollars twice; released money (a finalized key's unspent cap) is reusable at once.
//
// The levels are the scopes of `budgetScopesFor` (the org and the project always; the member who pays, or the starter's testing allowance for a test run, or the
// agent that pays). An org or a member is also held to the proxy's own figure, which stays authoritative (R22, R23); every other level is counted by the ledger.
import {
  AuditEventInputSchema, PER_TASK_BUDGET_USD, TASK_BUDGET_EXCEEDED_PREFIX, agentXError, chainBudgetExceededMessage, chainBudgetRequiredMessage, scopeKey,
  type AgentId, type AgentXError, type AgentXErrorCode, type BudgetScope, type OrgId, type Payer, type PauseScope,
} from "@agentx/contracts";
import { GetCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { type TransactItem, failedIndexes } from "../agents/table-writes.js";
import type { MintTags, MintedKey } from "../model-proxy/access.js";
import {
  MINIMUM_REMAINING_USD, budgetExceeded, clean, dollars, ensureSynced, figuresFor, keyIdOf, mintKeyHealing, orgBudgetExceeded, recordMintedKey, remaining, viaProxy,
  type AdmissionDependencies, type BudgetDependencies, type SpendPath,
} from "../org/budget.js";
import { admitMachineTime, admitTrial, monthOf } from "../org/trial.js";
import { ScopeFullError, abandonKey, finalizeKey, readScopeCounters, reserve, supersedeKeys, type KeyScope, type LedgerDependencies, type ScopeCounter } from "./ledger.js";
import { budgetScopesFor } from "./payer.js";
import { effectiveLimits } from "./settings.js";

/**
 * The error each kind of scope is refused with. `exceeded` is the code of a scope that has too little left; `required` is the code of a scope that must have a
 * limit and has none (an agent or a chain that pays has to have a budget).
 */
export const SCOPE_ERRORS: Record<BudgetScope["kind"], { required?: AgentXErrorCode; exceeded: AgentXErrorCode }> = {
  org: { exceeded: "ORG_BUDGET_EXCEEDED" },
  member: { exceeded: "BUDGET_EXCEEDED" },
  project: { exceeded: "PROJECT_BUDGET_EXCEEDED" },
  agent: { required: "AGENT_BUDGET_REQUIRED", exceeded: "AGENT_BUDGET_EXCEEDED" },
  chain: { required: "CHAIN_BUDGET_REQUIRED", exceeded: "CHAIN_BUDGET_EXCEEDED" },
  testing: { exceeded: "TEST_ALLOWANCE_USED" },
};

/** One budget a piece of work counts against, as it stands now. */
export interface Level {
  scope: BudgetScope;
  /** The scope's limit for the month (base plus top-up), or undefined when it has none (R47). */
  limitUsd: number | undefined;
  /** What the scope's message says is used: the proxy's figure for a member or org, what the ledger holds for any other. */
  usedUsd: number;
  /** What is left, clamped at 0; undefined when the scope has no limit. */
  leftUsd: number | undefined;
  /** The proxy's own figures, for the member's message. */
  proxy?: { spentUsd: number; limitUsd: number };
  /** For an org or a member: true when what open keys hold, not what the proxy says is spent, is what limits the room; `heldUsd` is what the ledger counts (settled spend and holds together). */
  held?: { heldUsd: number };
}

/** The names a refusal uses: the agent that runs, and the chain whose budget it is when a chain pays. */
export interface RefusalNames { agentName: string; chainName?: string | undefined }

/** The words each scope's refusal is made of. `agentName` names the agent whose budget it is; `chainName` the chain's. */
function refusalFor(level: Level, names: RefusalNames): AgentXError {
  const { scope } = level;
  const figures = `$${dollars(level.usedUsd)} of $${dollars(level.limitUsd ?? 0)}`;
  switch (scope.kind) {
    // Money held by running work is not money spent: say so, and do not show the proxy's figure of what is spent as if it were the reason.
    case "org": return level.held === undefined ? orgBudgetExceeded()
      : agentXError("ORG_BUDGET_EXCEEDED", "Your company's monthly AI budget is committed to work that is running. Try again when it finishes, or ask an admin to raise it.");
    case "member": return level.held === undefined ? budgetExceeded(level.proxy?.spentUsd ?? level.usedUsd, level.proxy?.limitUsd ?? level.limitUsd ?? 0)
      : agentXError("BUDGET_EXCEEDED", `Your monthly AI budget is used or held for work that is running ($${dollars(level.held.heldUsd)} of $${dollars(level.limitUsd ?? 0)}). Try again when it finishes, or ask an admin to raise it.`);
    case "project": return agentXError(SCOPE_ERRORS.project.exceeded, `The ${scope.project} project's monthly AI budget is used up (${figures}). Ask for more from the project's page.`);
    case "agent": return agentXError(SCOPE_ERRORS.agent.exceeded, `${names.agentName}'s monthly AI budget is used up (${figures}). Ask its owner for more.`);
    case "chain": return agentXError(SCOPE_ERRORS.chain.exceeded, chainBudgetExceededMessage(names.chainName ?? "This chain", level.usedUsd, level.limitUsd ?? 0));
    case "testing": return agentXError(SCOPE_ERRORS.testing.exceeded, `Your testing allowance for this month is used up (${figures}). Run the agent as a normal task instead.`);
  }
}

const agentRequired = (agentName: string): AgentXError =>
  agentXError("AGENT_BUDGET_REQUIRED", `${agentName} has no monthly budget, so it can't run work that no person started. Ask its owner to set one.`);

const chainRequired = (chainName: string): AgentXError => agentXError(SCOPE_ERRORS.chain.required ?? "CHAIN_BUDGET_REQUIRED", chainBudgetRequiredMessage(chainName));

/** The order refusals are told in: the member's own budget first, then the org's, then the rest in the order work counts against them. */
const REFUSAL_ORDER: Record<BudgetScope["kind"], number> = { member: 0, org: 1, project: 2, testing: 3, agent: 4, chain: 4 };
const inRefusalOrder = (levels: readonly Level[]): Level[] => [...levels].sort((a, b) => REFUSAL_ORDER[a.scope.kind] - REFUSAL_ORDER[b.scope.kind]);

interface LevelDependencies extends BudgetDependencies { cloud?: boolean }

/** Every level of a set of scopes, or the agent scope that must have a limit and has none (in which case nothing was asked of the proxy). */
interface LevelRead {
  levels: Level[];
  missing?: BudgetScope;
}

/**
 * Reads every level of `scopes` for the month. Limits and counters are read first (nothing is asked of the proxy yet), so an agent that pays with no budget is
 * refused before the proxy is told anything; then the proxy is synced and asked for the member's and the org's figures.
 */
async function readLevels(deps: LevelDependencies, input: { orgId: OrgId; scopes: readonly BudgetScope[]; developerId?: string | undefined; month: string }): Promise<LevelRead> {
  const [limits, counters] = await Promise.all([
    effectiveLimits(deps, { orgId: input.orgId, month: input.month, scopes: input.scopes }),
    readScopeCounters({ documentClient: deps.documentClient, tableName: deps.tableName, access: deps.access, now: deps.now ?? Date.now }, input.orgId, input.month, input.scopes),
  ]);
  const missing = input.scopes.find((scope) => (scope.kind === "agent" || scope.kind === "chain") && limits.get(scopeKey(scope)) === undefined);
  if (missing !== undefined) return { levels: [], missing };
  await ensureSynced(deps, input.orgId, input.developerId);
  const { member, org } = await figuresFor(deps, input.orgId, input.developerId);
  const levels = input.scopes.map((scope): Level => {
    const key = scopeKey(scope);
    const limitUsd = limits.get(key);
    const counter: ScopeCounter = counters.get(key) ?? { spentUsd: 0, committedUsd: 0 };
    // What the ledger holds is room taken, whether spent or reserved.
    const ledgerLeft = limitUsd === undefined ? undefined : clean(Math.max(0, limitUsd - counter.committedUsd));
    const figures = scope.kind === "org" ? org : scope.kind === "member" ? member : undefined;
    if (figures === undefined) return { scope, limitUsd, usedUsd: counter.committedUsd, leftUsd: ledgerLeft };
    // The proxy's figure is the truth for an org and a member (R22), further held to what open keys have reserved.
    const leftUsd = limitUsd === undefined ? undefined : Math.min(remaining(figures), ledgerLeft ?? Infinity);
    // The ledger limits the room (and not the proxy) when it leaves less than the proxy does.
    const held = ledgerLeft !== undefined && ledgerLeft < remaining(figures) ? { heldUsd: counter.committedUsd } : undefined;
    return { scope, limitUsd, usedUsd: figures.spentUsd, proxy: figures, leftUsd, ...(held === undefined ? {} : { held }) };
  });
  return { levels };
}

/** Why a read of the levels refuses the work, if it does: the scope and its error. `isShort` says when a level's room is too little. */
function refusalOf(read: LevelRead, names: RefusalNames, isShort: (leftUsd: number) => boolean): { scope: BudgetScope; error: AgentXError } | undefined {
  if (read.missing !== undefined) return { scope: read.missing, error: read.missing.kind === "chain" ? chainRequired(names.chainName ?? "This chain") : agentRequired(names.agentName) };
  const short = firstShort(read.levels, isShort);
  return short === undefined ? undefined : { scope: short.scope, error: refusalFor(short, names) };
}

/** The first level, in the order refusals are told, whose room `isShort` calls too little. */
const firstShort = (levels: readonly Level[], isShort: (leftUsd: number) => boolean): Level | undefined =>
  inRefusalOrder(levels).find((level) => level.leftUsd !== undefined && isShort(level.leftUsd));

/** The smallest room at any limited level, or Infinity when none has a limit. */
const smallestRoom = (levels: readonly Level[]): number => Math.min(Infinity, ...levels.flatMap((level) => (level.leftUsd === undefined ? [] : [level.leftUsd])));

export interface AdmitWorkInput {
  orgId: OrgId;
  /** Whose budget the work is charged to. */
  payer: Payer;
  /** The project the work is in. */
  project: string;
  /** The agent that runs, and the name its refusals use. */
  agentId: AgentId;
  agentName: string;
  /** The chain that pays, for the words of its refusals (Plan 4). */
  chainName?: string | undefined;
  path: SpendPath;
  /** The person whose testing allowance a draft agent's test run is counted on. */
  testRunBy?: string | undefined;
}

/**
 * Whether work may start. On a cloud install, first the org's trial must be unlocked and its month's machine time not used up (both answered from the org's own
 * records, before the proxy is asked anything; a private install has neither limit, R42). An agent that pays with no effective budget is refused
 * (AGENT_BUDGET_REQUIRED). Then every budget the work counts against (`budgetScopesFor`) that has a limit must have at least the path's minimum left, or the work is
 * refused with that level's own error (ruling R23: soft caps, remainders clamped at 0). Answers the most a key for this work may spend: the smallest room at any
 * level, never more than one task's budget. The proxy's own failures propagate, MODEL_PROXY_UNAVAILABLE among them, and nothing is written but the proxy's limits.
 */
export async function admitWork(deps: AdmissionDependencies, input: AdmitWorkInput): Promise<{ maxBudgetUsd: number }> {
  if (deps.cloud) {
    await admitTrial(deps, input.orgId);
    await admitMachineTime(deps, input.orgId);
  }
  const scopes = budgetScopesFor(input.payer, { project: input.project }, { agentId: input.agentId, testRunBy: input.testRunBy });
  const developerId = input.payer.kind === "member" && input.testRunBy === undefined ? input.payer.developerId : undefined;
  const read = await readLevels(deps, { orgId: input.orgId, scopes, developerId, month: monthOf((deps.now ?? Date.now)()) });
  const needed = MINIMUM_REMAINING_USD[input.path];
  const refusal = refusalOf(read, { agentName: input.agentName, chainName: input.chainName }, (left) => left < needed);
  if (refusal !== undefined) throw refusal.error;
  return { maxBudgetUsd: clean(Math.min(smallestRoom(read.levels), PER_TASK_BUDGET_USD)) };
}


// ---- the key's cap ----

export interface MintOperationDependencies extends BudgetDependencies {
  cloud?: boolean;
  /** The spend ledger. A key reserves its cap there only when this is given with the input's `scopes` and `tags`; an install without agents keeps none. */
  ledger?: LedgerDependencies | undefined;
}

export interface MintOperationKeyInput {
  /** Set only after native actual own-source funding validation in the broker. */
  taskStopExempt?: boolean;
  orgId: OrgId;
  /** The member the key is minted in the name of (`keyMember(payer)`); absent when the payer is not a member. */
  developerId?: string | undefined;
  /** The task, or for work with no task the operation, the key is minted for. */
  refId: string;
  ttlSeconds: number;
  /** The agent whose name the budget errors use (default Rovara Code). */
  agentName?: string | undefined;
  /** The chain that pays, for the words of its refusals (Plan 4). */
  chainName?: string | undefined;
  /** The budgets the work counts against (`budgetScopesFor`); by default the org's and, for a member, theirs. */
  scopes?: readonly BudgetScope[] | undefined;
  /** What the key says about who pays and what ran; the key is reserved in the ledger when these and `scopes` are given. */
  tags?: MintTags | undefined;
  /** The model the key may call. Its alias scopes the key (`models`) and the model counter, and its source id is the tags' source. */
  route?: { alias: string; sourceId?: string | undefined; /** SR-1: the other aliases a second reviewer inside this operation may call (the key is scoped to the aliases the broker chose, no others). */ extraAliases?: readonly string[] | undefined } | undefined;
  /** The task's run limit, and where the run stops: the lower of the run limit and the agent's max per run. */
  runLimitUsd: number;
  stopAtUsd: number;
  /** A test run's own cap. */
  testCapUsd?: number | undefined;
  /** The step's budget, held against what the operation's own keys have spent. */
  stepBudgetUsd?: number | undefined;
  /** True while a workflow task is planning: its run limit is then the planning limit. */
  planning?: boolean | undefined;
  /**
   * True on the second try after a lost race: the task's earlier keys were already given back by the first, and the key that won the race is live, so none is
   * touched and this key competes with the winner's hold.
   */
  keepEarlierKeys?: boolean | undefined;
  /** DR7: a ceiling on this key's cap, for work whose share of the money is fixed before it starts (a design-review reviewer's key). The cap is the least of this and every room above; it never raises it. */
  budgetCeilingUsd?: number | undefined;
  /** The keys the task has minted so far (their spend is the run's), and those of this operation (the step's). */
  taskKeyIds: readonly string[];
  operationKeyIds?: readonly string[] | undefined;
  /** Ruling R38: what the task's keys had spent when its present cap window began. */
  budgetBaselineUsd?: number | undefined;
  /** The task a refusal pauses (the `budgetPause` is written on `key`); none for work with no task. */
  pause?: { taskId: string; key: { pk: string; sk: string }; operationId?: string | undefined } | undefined;
  /**
   * Where the minted key is recorded, in one write: the task (with how many keys it held when the caller read it, so two mints that raced cannot both be given
   * the whole remainder) and the operation. Nothing is recorded when absent.
   */
  recordOn?: ReadonlyArray<{ key: { pk: string; sk: string }; knownCount?: number | undefined }> | undefined;
  /** Internal native source conditions, merged into the same key-record transaction. */
  guardRecord?: ((items: readonly TransactItem[]) => TransactItem[]) | undefined;
}

export type MintedOperationKey =
  | { outcome: "minted"; key: string; keyId: string; expiresAt: number; maxBudgetUsd: number }
  /** Another mint recorded its key on the task first; the key was given back and the caller reads the task again. */
  | { outcome: "raced" };

const logLine = (entry: Record<string, unknown>): void => console.log(JSON.stringify({ component: "broker", ...entry }));
const errorName = (error: unknown): string => (error instanceof Error ? error.name : "unknown");
const now = (deps: BudgetDependencies): number => (deps.now ?? Date.now)();

/** Notes on the task what it is waiting on for money. The first pause stands; one that cannot be written is logged, and the refusal goes on without it. */
async function writePause(deps: BudgetDependencies, pause: MintOperationKeyInput["pause"], scope: PauseScope): Promise<void> {
  if (pause === undefined) return;
  if (["task", "max_per_run", "planning"].includes(scope.kind)) {
    const response = await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: pause.key, ConsistentRead: true })) as { Item?: Record<string, unknown> };
    const task = response.Item;
    if (task?.spendingStop !== undefined) {
      const snapshot = checkedTaskStopSnapshot(task.spendingStop);
      const agent = task.agent as { agentId?: unknown } | undefined;
      if (snapshot.orgId !== task.orgId || snapshot.project !== task.project || snapshot.agentId !== agent?.agentId || usdToWholeMicrodollars(task.budgetUsd) !== snapshot.effectiveStopMicrousd) throw agentXError("BUDGET_EXCEEDED", "The spending stop changed while this turn was being refused. Reload the task.");
      if (task.budgetPause !== undefined) return;
      const reference = task.spendingAdmission as { requestId?: unknown } | undefined;
      if (typeof reference?.requestId !== "string" || task.taskId !== pause.taskId) throw agentXError("TASK_STOP_CONFIG_INVALID", "The spending window is missing its admission.");
      const at = new Date(now(deps)).toISOString(), guard = nativeSnapshotConditions(deps.tableName, [pause.key], [task], ["budgetPause"])[0]?.ConditionCheck;
      if (guard === undefined) throw agentXError("TASK_STOP_CONFIG_INVALID", "The spending pause source is missing.");
      const event = AuditEventInputSchema.parse(auditTaskStopDecision({ action: "spending.stop_reached", orgId: snapshot.orgId, actor: { kind: "system", id: "rovara" },
        taskId: pause.taskId, admissionId: reference.requestId, occurrence: auditOccurrence(pause.taskId, reference.requestId), occurredAt: at,
        effectiveStopMicrousd: snapshot.effectiveStopMicrousd, approvalCapMicrousd: snapshot.approvalCapMicrousd, policyDigest: snapshot.policyDigest }));
      try { await deps.documentClient.send(new TransactWriteCommand({ TransactItems: [{ Update: { ...guard,
        UpdateExpression: pause.operationId === undefined ? "SET #pause = :pause" : "SET #pause = :pause, budgetStopOf = :operation",
        ExpressionAttributeNames: { ...guard.ExpressionAttributeNames, "#pause": "budgetPause" },
        ExpressionAttributeValues: { ...guard.ExpressionAttributeValues, ":pause": { scope, at }, ...(pause.operationId === undefined ? {} : { ":operation": pause.operationId }) },
      } }, { Put: { TableName: deps.tableName, Item: auditPendingItem(event, Date.parse(at)), ConditionExpression: "attribute_not_exists(pk)" } }] })); }
      catch (error) {
        // A competing pause or task-window change cannot turn a refusal into a
        // proxy failure. No key was minted; retain the caller's financial refusal.
        if (failedIndexes(error)?.size) return;
        throw error;
      }
      return;
    }
  }
  try {
    await deps.documentClient.send(new UpdateCommand({
      // Plan 3, M-6 (I-1): the operation this refusal stopped is kept on the task (`budgetStopOf`) and stays when an approval removes the pause, so the stop is still known as a pause.
      TableName: deps.tableName, Key: pause.key, UpdateExpression: pause.operationId === undefined ? "SET #pause = :pause" : "SET #pause = :pause, budgetStopOf = :operation",
      ConditionExpression: "attribute_exists(pk) AND attribute_not_exists(#pause)", ExpressionAttributeNames: { "#pause": "budgetPause" },
      ExpressionAttributeValues: { ":pause": { scope, at: new Date(now(deps)).toISOString() }, ...(pause.operationId === undefined ? {} : { ":operation": pause.operationId }) },
    }));
  } catch (error) {
    if (errorName(error) !== "ConditionalCheckFailedException") logLine({ event: "budget.pause_not_written", taskId: pause.taskId, errorName: errorName(error) });
  }
}

/** A run limit that is used up: the task's, the agent's max per run, a test run's, or the planning limit. The way on is the owner's Continue (R38). */
const runLimitReached = (spentUsd: number, limitUsd: number): AgentXError =>
  agentXError("BUDGET_EXCEEDED", `${TASK_BUDGET_EXCEEDED_PREFIX} ($${dollars(spentUsd)} of $${dollars(limitUsd)}). Choose Continue to resume this task with a fresh budget.`);

interface CapPlan {
  capUsd: number;
  levels: Level[];
}

/** Works out the most the next key may spend, or writes the pause and throws the error of whatever has nothing left. */
async function planCap(deps: MintOperationDependencies, input: MintOperationKeyInput, scopes: readonly BudgetScope[], names: RefusalNames, month: string): Promise<CapPlan> {
  const read = await readLevels(deps, { orgId: input.orgId, scopes, developerId: input.developerId, month });
  const full = refusalOf(read, names, (left) => left <= 0);
  if (full !== undefined) {
    await writePause(deps, input.pause, full.scope);
    throw full.error;
  }
  const [taskSpent, stepSpent] = await Promise.all([
    viaProxy(() => deps.access.keySpend(input.taskKeyIds)),
    input.stepBudgetUsd === undefined ? 0 : viaProxy(() => deps.access.keySpend(input.operationKeyIds ?? [])),
  ]);
  // Ruling R38: a human Continue starts a new window, so what the task's keys had spent by then no longer counts against its limits.
  const windowSpent = clean(Math.max(0, taskSpent - (input.budgetBaselineUsd ?? 0)));
  const stopAtUsd = Math.min(input.stopAtUsd, input.runLimitUsd);
  const left = (limitUsd: number, spentUsd: number) => clean(Math.max(0, limitUsd - spentUsd));
  const taskId = input.pause?.taskId;
  const pauseAt = async (scope: PauseScope | undefined): Promise<void> => { if (scope !== undefined) await writePause(deps, input.pause, scope); };
  // A test run's cap is for the whole run: a Continue (a new window) does not give it another.
  if (input.testCapUsd !== undefined && left(input.testCapUsd, taskSpent) <= 0) {
    await pauseAt(taskId === undefined ? undefined : { kind: "test", taskId });
    throw runLimitReached(taskSpent, input.testCapUsd);
  }
  if (left(stopAtUsd, windowSpent) <= 0) {
    // The agent's max per run is what stopped it when that is lower than the run limit; during planning the run limit is the planning limit.
    const kind = stopAtUsd < input.runLimitUsd ? "max_per_run" : input.planning === true ? "planning" : "task";
    await pauseAt(taskId === undefined ? undefined : { kind, taskId });
    throw runLimitReached(windowSpent, stopAtUsd);
  }
  if (input.stepBudgetUsd !== undefined && left(input.stepBudgetUsd, stepSpent) <= 0) throw runLimitReached(stepSpent, input.stepBudgetUsd);
  const capUsd = clean(Math.min(
    left(stopAtUsd, windowSpent), smallestRoom(read.levels),
    input.testCapUsd === undefined ? Infinity : left(input.testCapUsd, taskSpent),
    input.stepBudgetUsd === undefined ? Infinity : left(input.stepBudgetUsd, stepSpent),
    input.budgetCeilingUsd === undefined ? Infinity : clean(Math.max(0, input.budgetCeilingUsd)),
  ));
  return { capUsd, levels: read.levels };
}

/**
 * DR7: what is left of a task's run limit for model spend, the figure a design-review round's slot ceilings are held under (`allocateSlotBudgets`). It is the same arithmetic as `planCap`'s run limits: the stop-at limit
 * (the lower of the run limit and the agent's max per run) less what the task's keys have spent in this window, and a test run's cap less what the task's keys have spent. It counts SPENT, as the cap of any key does.
 */
export async function taskRunRoomUsd(deps: Pick<MintOperationDependencies, "access">, input: Pick<MintOperationKeyInput, "taskKeyIds" | "runLimitUsd" | "stopAtUsd" | "testCapUsd" | "budgetBaselineUsd">): Promise<number> {
  const spent = await viaProxy(() => deps.access.keySpend(input.taskKeyIds));
  const left = (limitUsd: number, spentUsd: number) => clean(Math.max(0, limitUsd - spentUsd));
  return clean(Math.min(left(Math.min(input.stopAtUsd, input.runLimitUsd), clean(Math.max(0, spent - (input.budgetBaselineUsd ?? 0)))), input.testCapUsd === undefined ? Infinity : left(input.testCapUsd, spent)));
}

/** A key that was minted but could not be reserved: revoked at the proxy, and whatever of its reservation was written is taken back. */
async function giveBack(deps: MintOperationDependencies, minted: MintedKey, keyId: string, orgId: OrgId): Promise<void> {
  await deps.access.revokeKey(minted.key).catch(() => undefined);
  if (deps.ledger !== undefined) await abandonKey(deps.ledger, orgId, keyId).catch((error: unknown) => logLine({ event: "budget.reservation_not_released", keyId, errorName: errorName(error) }));
}

/** A key that was reserved but could not be recorded: blocked (revoked if the proxy cannot block it), then finalized, which releases its whole cap. */
async function closeUnrecorded(deps: MintOperationDependencies, minted: MintedKey, keyId: string, orgId: OrgId): Promise<void> {
  if (deps.ledger === undefined) {
    await deps.access.revokeKey(minted.key).catch(() => undefined);
    return;
  }
  await deps.access.blockKey(keyId).catch(() => deps.access.revokeKey(minted.key).catch(() => undefined));
  await finalizeKey(deps.ledger, orgId, keyId).catch((error: unknown) => logLine({ event: "budget.reservation_not_released", keyId, errorName: errorName(error) }));
}

/**
 * Notes the key on every record that owns it, in one write. False when a record no longer holds the count the caller read (another mint recorded first). A
 * single record is written as `recordMintedKey` always did.
 */
async function recordKey(deps: BudgetDependencies, recordOn: NonNullable<MintOperationKeyInput["recordOn"]>, keyId: string, guardRecord?: MintOperationKeyInput["guardRecord"]): Promise<boolean> {
  const [only] = recordOn;
  if (only === undefined) return true;
  if (guardRecord === undefined && recordOn.length === 1 && only.knownCount !== undefined) return recordMintedKey(deps, only.key, keyId, only.knownCount);
  const items: TransactItem[] = recordOn.map(({ key, knownCount }) => ({
    Update: {
      TableName: deps.tableName, Key: key,
      UpdateExpression: "SET #ids = list_append(if_not_exists(#ids, :none), :id)",
      ConditionExpression: knownCount === undefined ? "attribute_exists(pk)" : knownCount === 0 ? "attribute_exists(pk) AND attribute_not_exists(#ids)" : "size(#ids) = :count",
      ExpressionAttributeNames: { "#ids": "modelKeyIds" },
      ExpressionAttributeValues: { ":none": [], ":id": [keyId], ...(knownCount === undefined || knownCount === 0 ? {} : { ":count": knownCount }) },
    },
  }));
  try {
    await deps.documentClient.send(new TransactWriteCommand({ TransactItems: guardRecord === undefined ? items : guardRecord(items) }));
    return true;
  } catch (error) {
    if (failedIndexes(error) !== undefined) return false;
    throw error;
  }
}

/**
 * Mints the key a running operation calls models with, capped at the most it may spend and reserved before it is handed out. The cap is the least of: the run's
 * limits (the stop-at limit less what the task's keys spent in this window, R30 and R38; a test run's cap; the step's budget), the proxy's room for the member and
 * the org, and every limited scope's limit less what the ledger counts or holds there. When a limit has nothing left the task is paused with its scope
 * (`budgetPause`) and the error of that limit is thrown (the run limits' is BUDGET_EXCEEDED with the task prefix, R35).
 *
 * The order is mint, then reserve, then record. The key is not handed to anyone until it is reserved and recorded, so the window between the mint and the
 * reservation can spend nothing, and a process that dies in it leaves a key that expires on its own and holds no money (the reverse order would leave money
 * held for a key that does not exist). A reservation the scope has no room for (another mint took the room first) gives the key back, reads the levels again
 * once and mints again; a second miss is that scope's error. A key that is reserved and cannot be recorded is blocked and finalized.
 */
export async function mintOperationKey(deps: MintOperationDependencies, input: MintOperationKeyInput): Promise<MintedOperationKey> {
  if (input.taskStopExempt === true && (deps.ledger === undefined || input.scopes === undefined || input.tags === undefined || input.guardRecord === undefined || !/^src_[a-z0-9]{20}$/.test(input.route?.sourceId ?? ""))) throw agentXError("TASK_STOP_CONFIG_INVALID", "Own-source funding requires scoped native admission.");
  const names = { agentName: input.agentName ?? "Rovara Code", chainName: input.chainName };
  const scopes = input.scopes ?? [{ kind: "org" } as const, ...(input.developerId === undefined ? [] : [{ kind: "member", developerId: input.developerId } as const])];
  const ledger = input.scopes !== undefined && input.tags !== undefined ? deps.ledger : undefined;
  const tags = input.tags === undefined ? undefined : input.route?.sourceId === undefined ? input.tags : { ...input.tags, source: input.route.sourceId };
  // The task's earlier keys hold their caps until they are finalized, which can be minutes after their operation ended (or an hour when nobody blocked them): the
  // next key would compete with its own task's holds for room. They are blocked, counted and released first, so their caps are not counted beside the new
  // key's. A blocked key can still answer for a few seconds on other proxy replicas, and a stream it admitted keeps going: that spend is settled later as late
  // spend (see `supersedeKeys`). A proxy that cannot block one refuses the mint (retryable); nothing is lost, the steps repeat.
  if (ledger !== undefined && input.keepEarlierKeys !== true) await supersedeKeys(ledger, input.orgId, input.taskKeyIds);
  for (let attempt = 0; ; attempt += 1) {
    const month = monthOf(now(deps));
    const { capUsd, levels } = await planCap(deps, input, scopes, names, month);
    const minted = await mintKeyHealing(deps, {
      orgId: input.orgId, ...(input.developerId === undefined ? {} : { developerId: input.developerId }), purpose: "task", refId: input.refId,
      maxBudgetUsd: capUsd, ttlSeconds: input.ttlSeconds, ...(input.route === undefined ? {} : { models: [input.route.alias, ...(input.route.extraAliases ?? [])] }), ...(tags === undefined ? {} : { tags }),
    });
    const keyId = keyIdOf(minted.key);
    if (ledger !== undefined && tags !== undefined) {
      try {
        const keyScopes: KeyScope[] = levels.map((level) => ({ key: level.scope, limitUsd: level.limitUsd }));
        await reserve(ledger, { orgId: input.orgId, month, keyId, capUsd, scopes: keyScopes, tags, ...(input.route === undefined ? {} : { model: input.route.alias }), expiresAt: minted.expiresAt });
      } catch (error) {
        await giveBack({ ...deps, ledger }, minted, keyId, input.orgId);
        if (!(error instanceof ScopeFullError)) throw error;
        if (attempt === 0) continue;
        // Out of room twice: this scope's error, with the figures as they are now.
        const fresh = await readLevels(deps, { orgId: input.orgId, scopes, developerId: input.developerId, month });
        const level = fresh.levels.find((candidate) => scopeKey(candidate.scope) === error.scope);
        if (level === undefined) throw error;
        await writePause(deps, input.pause, level.scope);
        throw refusalFor(level, names);
      }
    }
    try {
      if (await recordKey(deps, input.recordOn ?? [], keyId, input.guardRecord)) return { outcome: "minted", key: minted.key, keyId, expiresAt: minted.expiresAt, maxBudgetUsd: capUsd };
    } catch (error) {
      await closeUnrecorded({ ...deps, ledger }, minted, keyId, input.orgId);
      throw error;
    }
    await closeUnrecorded({ ...deps, ledger }, minted, keyId, input.orgId);
    return { outcome: "raced" };
  }
}
