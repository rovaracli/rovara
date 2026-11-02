// Plan 3 Task 34: what a run is expected to cost, the limits that follow from it, who may accept a run limit, and the cost a finished run leaves
// for the next estimate.
//
// `estimateRun` reads the newest `ESTIMATE_HISTORY_SIZE` costs of this org's runs of one project, agent and path (`RUN_COST` items, written by
// `recordRunCost` when a run merged or finished). With `ESTIMATE_MIN_SAMPLES` of them the range is their p50 and p80 by nearest rank, each rounded up
// to fifty cents; with fewer it is the default for the path. The run limit is the high end times the org's multiplier, never more than
// `MAX_RUN_LIMIT_USD`. Plan 6 Task 7 builds on `estimateRun` and `RunEstimate`: keep both stable.
import { QueryCommand, TransactWriteCommand, GetCommand } from "@aws-sdk/lib-dynamodb";
import {
  DEFAULT_RUN_ESTIMATE_USD, ESTIMATE_HISTORY_SIZE, ESTIMATE_MIN_SAMPLES, INDEX_EXPIRY_ATTRIBUTE, MAX_RUN_LIMIT_USD, ROVARA_CODE_AGENT_ID, agentRunsKey, runCostKey, runLimitBlockText, runLimitWaitingText,
  memberAcceptRunLimitUsd,
  type AgentId, type OrgId, type OrgRole, type ProjectRole, type RunEstimate,
} from "@agentx/contracts";
import type { DeveloperTaskRecord } from "../developer/task-records.js";
import { taskKey } from "../developer/task-records.js";
import type { ModelAccess } from "../model-proxy/access.js";
import { taskSpendBaseline } from "../org/budget.js";
import { readProjectAi, readSpendPolicy, type SpendSettingsDependencies } from "./settings.js";
import { cleanUsd } from "./top-ups.js";

/** The kinds of run an estimate is kept for: a workflow task by its path, a task with no workflow, and an agent-step run. */
export type EstimatePath = "QUICK" | "FULL" | "TASK" | "AGENT";

type Item = Record<string, unknown>;
type Send = { send(command: unknown): Promise<unknown> };

/** What the estimates need: the State table, and the org's spend policy (the run limit multiplier and the approval thresholds) read through it. */
export interface EstimateDependencies extends SpendSettingsDependencies {
  /** Only `suggestMaxPerRun` reads the clock: it looks at this month and the two before. */
  now?: () => number;
}

const HALF_DOLLAR = 0.5;

/** `value` rounded up to the next fifty cents, and never less than fifty cents (a run is never expected to cost nothing). The sum is cleaned first, so 1.5000000000000002 is 1.5. */
const roundUpToHalf = (value: number): number => Math.max(HALF_DOLLAR, Math.ceil(cleanUsd(value) * 2) / 2);

/** The `percent`th percentile by nearest rank: the `ceil(percent × n / 100)`-th smallest. Whole percents keep the product exact. */
function nearestRank(sorted: readonly number[], percent: number): number {
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil((percent * sorted.length) / 100)));
  return sorted[rank - 1]!;
}

const isCost = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;

/** The `RUN_COST` items of one project, agent and path, newest first, at most `limit` of them. */
async function newestCosts(deps: Send & { tableName: string }, key: { pk: string }, limit: number): Promise<number[]> {
  const response = await deps.send(new QueryCommand({
    TableName: deps.tableName, KeyConditionExpression: "pk = :pk", ExpressionAttributeValues: { ":pk": key.pk },
    ScanIndexForward: false, Limit: limit, ConsistentRead: true,
  })) as { Items?: Item[] };
  return (response.Items ?? []).map((item) => item["costUsd"]).filter(isCost);
}

export interface EstimateRunInput {
  orgId: OrgId;
  project: string;
  agentId: AgentId;
  path: EstimatePath;
  /** The agent's cap on one run (the task's `maxPerRunUsd`); `stopAtUsd` is the smaller of it and the run limit. */
  maxPerRunUsd?: number;
}

/**
 * What a run of this agent on this project is expected to cost, and the limits that follow. The history is read at the time of the call; an
 * unreadable history or policy is an error, never a quieter default.
 */
export async function estimateRun(deps: EstimateDependencies, input: EstimateRunInput): Promise<RunEstimate> {
  const key = runCostKey(input.orgId, input.project, input.agentId, input.path, "2000-01-01T00:00:00.000Z", "-");
  const [costs, policy] = await Promise.all([
    newestCosts({ send: (command) => deps.documentClient.send(command), tableName: deps.tableName }, key, ESTIMATE_HISTORY_SIZE),
    readSpendPolicy(deps, input.orgId),
  ]);
  const history = costs.length >= ESTIMATE_MIN_SAMPLES;
  const sorted = [...costs].sort((a, b) => a - b);
  const lowUsd = history ? roundUpToHalf(nearestRank(sorted, 50)) : DEFAULT_RUN_ESTIMATE_USD[input.path].lowUsd;
  const highUsd = history ? roundUpToHalf(nearestRank(sorted, 80)) : DEFAULT_RUN_ESTIMATE_USD[input.path].highUsd;
  const runLimitUsd = Math.min(MAX_RUN_LIMIT_USD, Math.ceil(cleanUsd(highUsd * policy.runLimitMultiplier)));
  return {
    lowUsd, highUsd, runLimitUsd,
    stopAtUsd: input.maxPerRunUsd === undefined ? runLimitUsd : Math.min(runLimitUsd, input.maxPerRunUsd),
    basis: history ? "history" : "default",
    samples: costs.length,
  };
}

// ---- the max-per-run suggestion

/** How many months back the suggestion looks for the agent's last runs: this one and the two before. */
const SUGGESTION_MONTHS = 3;
/** The most run items read from one month, so an agent with a very long month still answers. */
const RUNS_READ_PER_MONTH = 1_000;
const SUGGESTION_RUNS = 20;

const monthKeyOf = (at: number, back: number): string => {
  const date = new Date(at);
  const shifted = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() - back, 1));
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, "0")}`;
};

/**
 * A figure for the agent's page to suggest as its max per run: twice the p80 of its last twenty runs (the totals the settlement ledger keeps per run,
 * across projects) once there are five of them, else twice the high end of the default for its usual path. A coding agent's usual path is FULL, any other's
 * AGENT; `coding` says which when the caller knows the recipe, and Rovara Code is coding. Display only: nothing is limited by it.
 */
export async function suggestMaxPerRun(deps: EstimateDependencies, input: { orgId: OrgId; agentId: AgentId; coding?: boolean }): Promise<number> {
  const now = (deps.now ?? Date.now)();
  const runs: Array<{ usd: number; lastAt: string }> = [];
  for (let back = 0; back < SUGGESTION_MONTHS; back += 1) {
    const pk = agentRunsKey(input.orgId, monthKeyOf(now, back), input.agentId, "-").pk;
    let start: Record<string, unknown> | undefined;
    let read = 0;
    do {
      const response = await deps.documentClient.send(new QueryCommand({
        TableName: deps.tableName, KeyConditionExpression: "pk = :pk", ExpressionAttributeValues: { ":pk": pk }, ConsistentRead: true,
        ...(start === undefined ? {} : { ExclusiveStartKey: start }),
      })) as { Items?: Item[]; LastEvaluatedKey?: Record<string, unknown> };
      for (const item of response.Items ?? []) {
        read += 1;
        if (isCost(item["usd"]) && typeof item["lastAt"] === "string") runs.push({ usd: item["usd"], lastAt: item["lastAt"] });
      }
      start = read >= RUNS_READ_PER_MONTH ? undefined : response.LastEvaluatedKey;
    } while (start !== undefined);
  }
  const last = runs.sort((a, b) => b.lastAt.localeCompare(a.lastAt)).slice(0, SUGGESTION_RUNS).map((run) => run.usd);
  if (last.length >= ESTIMATE_MIN_SAMPLES) return Math.ceil(cleanUsd(nearestRank(last.sort((a, b) => a - b), 80) * 2));
  const coding = input.coding ?? input.agentId === ROVARA_CODE_AGENT_ID;
  return Math.ceil(DEFAULT_RUN_ESTIMATE_USD[coding ? "FULL" : "AGENT"].highUsd * 2);
}

// ---- accepting a run limit

/**
 * What `acceptRunLimit` asks for when the approver's tier is too low: the fields of Task 32's `SpendRequestRecord` for a `run_limit` request that resumes
 * implementation. `amountUsd` is the raise over the limit the task has now (the planning limit), `newLimitUsd` the run limit asked for.
 */
export interface RunLimitRequest {
  kind: "run_limit";
  resume: "implement";
  orgId: OrgId;
  taskId: string;
  /** The decision's request id: a repeat of the same approval is a repeat of the same request (R18). */
  requestId: string;
  amountUsd: number;
  newLimitUsd: number;
  /** At most 300 characters. */
  reason: string;
  requestedBy: { kind: "member"; developerId: string };
  approverRole: "project_maintainer" | "org_admin" | "agent_owner";
}

/**
 * The seam to Task 32: makes the `run_limit` request (`createSpendRequest`) and answers its id. Injected as `agents.requestRunLimit`; when it is absent
 * (until Task 32 is wired) no request is made and the plan blocks with the same words. A request that can't be made throws, and the approval is refused.
 */
export type RequestRunLimit = (request: RunLimitRequest) => Promise<{ spendRequestId: string } | undefined>;

export type RunLimitDecision =
  | { accepted: true; runLimitUsd: number }
  | { accepted: false; runLimitUsd: number; needs: "maintainer" | "admin" | "agent_owner"; approverRole: RunLimitRequest["approverRole"]; message: string };

export interface AcceptRunLimitDependencies extends EstimateDependencies {
  /** Where the approver's project role is read from. Without it, or when it fails, the approver is a member. */
  projectMembers?: { roleOf(orgId: OrgId, project: string, caller: { developerId: string; orgRole: OrgRole }): Promise<ProjectRole | undefined> };
}

/** The estimate path of a task: its workflow's, else a task with no workflow's. */
export const estimatePathOf = (task: Pick<DeveloperTaskRecord, "workflow">): EstimatePath => task.workflow?.path ?? "TASK";

type Tier = "member" | "maintainer" | "admin";

async function tierOf(deps: AcceptRunLimitDependencies, task: DeveloperTaskRecord, approver: { developerId: string; orgRole: OrgRole }): Promise<Tier> {
  if (approver.orgRole === "owner" || approver.orgRole === "admin") return "admin";
  if (deps.projectMembers === undefined || task.orgId === undefined) return "member";
  try {
    // An owner or admin is an admin above; a maintainer here holds the role by a grant on the project.
    return await deps.projectMembers.roleOf(task.orgId, task.project, approver) === "maintainer" ? "maintainer" : "member";
  } catch {
    // A role that can't be read is the lowest tier: the request goes to someone who can be asked.
    return "member";
  }
}

/** The run limit a task's plan carries: its estimate (`task.runEstimate`, else one worked out now), which a start that asked for a lower limit may only lower (H2). */
export async function planRunLimit(deps: EstimateDependencies, task: DeveloperTaskRecord): Promise<number> {
  if (task.orgId === undefined) throw new Error("a task with no org has no run limit to accept");
  const estimated = task.runEstimate?.runLimitUsd ?? (await estimateRun(deps, {
    orgId: task.orgId, project: task.project, agentId: task.agent?.agentId ?? ROVARA_CODE_AGENT_ID, path: estimatePathOf(task),
    ...(task.maxPerRunUsd === undefined ? {} : { maxPerRunUsd: task.maxPerRunUsd }),
  })).runLimitUsd;
  return task.requestedRunLimitUsd === undefined ? estimated : Math.min(estimated, task.requestedRunLimitUsd);
}

/** Who a run limit above the lead threshold has to go to: a project maintainer up to the admin threshold, an org admin above it. */
const needsOf = (runLimitUsd: number, policy: { adminApprovalThresholdUsd: number }): "maintainer" | "admin" => (runLimitUsd > policy.adminApprovalThresholdUsd ? "admin" : "maintainer");

/**
 * What asking for the run limit of a plan that is blocked on it takes, whoever asks: the limit and who has to approve it. For the owner asking again after
 * a denial or an expiry; it does not say whether anyone may accept the limit (`acceptRunLimit` does that for an approver).
 */
export async function askedRunLimit(deps: EstimateDependencies, task: DeveloperTaskRecord): Promise<{ runLimitUsd: number; needs: "maintainer" | "admin"; approverRole: RunLimitRequest["approverRole"] }> {
  if (task.orgId === undefined) throw new Error("a task with no org has no run limit to ask for");
  const [runLimitUsd, policy] = await Promise.all([planRunLimit(deps, task), readSpendPolicy(deps, task.orgId)]);
  const needs = needsOf(runLimitUsd, policy);
  return { runLimitUsd, needs, approverRole: needs === "admin" ? "org_admin" : "project_maintainer" };
}

/**
 * Whether `approver` may accept the run limit the task's plan carries (`planRunLimit`). A member accepts up to the lead
 * threshold (a project that pays: up to its allowance, held to the admin threshold), a maintainer by grant up to the admin threshold, an org owner or admin any amount. Not accepted: what is needed, and the words to block with.
 * The caller makes the acceptance and its writes (`budgetUsd` and `budgetBaselineUsd`) in the decision's own transaction.
 */
export async function acceptRunLimit(
  deps: AcceptRunLimitDependencies,
  input: { task: DeveloperTaskRecord; approver: { developerId: string; orgRole: OrgRole } },
): Promise<RunLimitDecision> {
  const { task, approver } = input;
  if (task.orgId === undefined) throw new Error("a task with no org has no run limit to accept");
  const orgId = task.orgId;
  const runLimitUsd = await planRunLimit(deps, task);
  const payer = task.payer;
  // Owner decision 3 (option E), an agent's owner pays: a run limit within the agent's max per run is accepted by whoever approves the plan; above it nobody accepts it
  // here, not even an org admin, and the request goes to the agent's owner (who may not decide a request they asked for themselves: Task 32's rule). An agent with no
  // max per run has no allowance to measure by, and keeps the tiers.
  if (payer?.kind === "agent" && task.maxPerRunUsd !== undefined) {
    if (runLimitUsd <= task.maxPerRunUsd) return { accepted: true, runLimitUsd };
    return { accepted: false, runLimitUsd, needs: "agent_owner", approverRole: "agent_owner", message: runLimitWaitingText(runLimitUsd, "agent_owner") };
  }
  const [policy, tier] = await Promise.all([readSpendPolicy(deps, orgId), tierOf(deps, task, approver)]);
  // The project pays: the member who approves accepts up to what the project allows (read now), not the lead threshold, but never more than the admin threshold,
  // which is what a maintainer may accept (fix wave re-check N-1); a project that set nothing follows the org's lead threshold. A maintainer and an admin keep theirs.
  const projectPays = payer?.kind === "project";
  const memberLimitUsd = projectPays ? memberAcceptRunLimitUsd(await readProjectAi(deps, orgId, payer.project), policy) : policy.leadApprovalThresholdUsd;
  const may = tier === "admin" || (tier === "maintainer" ? runLimitUsd <= policy.adminApprovalThresholdUsd : runLimitUsd <= memberLimitUsd);
  if (may) return { accepted: true, runLimitUsd };
  const needs = needsOf(runLimitUsd, policy);
  const message = projectPays && needs === "maintainer" ? runLimitWaitingText(runLimitUsd, "project_maintainer") : runLimitBlockText(runLimitUsd, needs);
  return { accepted: false, runLimitUsd, needs, approverRole: needs === "admin" ? "org_admin" : "project_maintainer", message };
}

// ---- the cost of a finished run

/** How long a run's cost is kept; the newest twenty are read, so older ones only matter for an agent that has rarely run. */
const RUN_COST_KEPT_SECONDS = 365 * 24 * 60 * 60;

export interface RecordRunCostDependencies {
  documentClient: Send;
  tableName: string;
  /** The model proxy, which says what the task's keys spent. */
  modelAccess: ModelAccess;
}

/**
 * Writes what a run that merged or finished cost, for the next estimate: the `RUN_COST` item and the task's `runCostRecordedAt` mark, in one
 * transaction, so a run is counted once however often its end is told. The cost is what the proxy says the task's keys spent. A run that spent
 * nothing (no keys, or a plan with no cost) writes only the mark. A proxy that can't say throws, and nothing is written: the next end tells it again.
 */
export async function recordRunCost(
  deps: RecordRunCostDependencies,
  task: DeveloperTaskRecord,
  input: { path: EstimatePath; endedAt: string },
): Promise<"recorded" | "already_recorded" | "skipped"> {
  if (task.orgId === undefined) return "skipped";
  // A task with a purpose (setup draft, diagnosis, setup run) never feeds the estimates, whoever calls this (SH-2).
  if (task.purpose !== undefined) return "skipped";
  if (task.runCostRecordedAt !== undefined) return "already_recorded";
  const costUsd = await taskSpendBaseline({ documentClient: deps.documentClient, tableName: deps.tableName, access: deps.modelAccess }, task.modelKeyIds ?? []);
  const agentId = task.agent?.agentId ?? ROVARA_CODE_AGENT_ID;
  const mark = { Update: {
    TableName: deps.tableName, Key: taskKey(task.taskId),
    UpdateExpression: "SET runCostRecordedAt = :at", ConditionExpression: "attribute_exists(pk) AND attribute_not_exists(runCostRecordedAt)",
    ExpressionAttributeValues: { ":at": input.endedAt },
  } };
  const item = { Put: {
    TableName: deps.tableName,
    Item: {
      ...runCostKey(task.orgId, task.project, agentId, input.path, input.endedAt, task.taskId), entityType: "RUN_COST",
      orgId: task.orgId, project: task.project, agentId, path: input.path, taskId: task.taskId, endedAt: input.endedAt, costUsd,
      [INDEX_EXPIRY_ATTRIBUTE]: Math.floor(Date.parse(input.endedAt) / 1000) + RUN_COST_KEPT_SECONDS,
    },
    ConditionExpression: "attribute_not_exists(pk)",
  } };
  try {
    await deps.documentClient.send(new TransactWriteCommand({ TransactItems: costUsd > 0 ? [item, mark] : [mark] }));
    return costUsd > 0 ? "recorded" : "skipped";
  } catch (error) {
    // The mark is the claim: another end got there first when it is on the task now. Anything else (a throttle, a lost race on the item) is retried by the next end.
    const fresh = await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: taskKey(task.taskId), ConsistentRead: true })) as { Item?: DeveloperTaskRecord };
    if (fresh.Item?.runCostRecordedAt !== undefined) return "already_recorded";
    throw error;
  }
}
