// A new org starts on a trial that is locked until a GitHub account is connected (one trial per GitHub account), and
// every org has a monthly allowance of EC2 machine time. Both are checked at admission (`admitWork` calls
// `admitTrial` then `admitMachineTime`, before the proxy is asked anything and before anything is charged); machine
// time is recorded when compute stops (`recordMachineTime`, called by the session manager at every stop).
import { DeleteCommand, GetCommand, PutCommand, QueryCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import {
  SESSION_MAX_LIFETIME_MS, agentXError, machineTimeMonthKey, machineTimeOnceKey, openComputeKey, openComputePk, orgMetaKey, trialGithubKey, workspaceSessionKey,
  type OrgId,
} from "@agentx/contracts";

/** Placeholder allowances, in hours of compute per UTC month, until orgs can buy more. */
export const TRIAL_MACHINE_HOURS_PER_MONTH = 20;
export const TEAM_MACHINE_HOURS_PER_MONTH = 400;

const SECONDS_PER_HOUR = 3600;

export interface TrialDependencies {
  documentClient: { send(command: unknown): Promise<unknown> };
  tableName: string;
  /** Epoch milliseconds; the clock the month of an admission is read from. Defaults to the system clock. */
  now?: () => number;
}

type Item = Record<string, unknown>;

export const trialLocked = () => agentXError("TRIAL_LOCKED", "Connect GitHub to start your free trial.");
export const trialGithubUsed = () => agentXError("TRIAL_GITHUB_USED", "That GitHub account has already started a free trial for another organization.");
export const machineTimeExceeded = () => agentXError("MACHINE_TIME_EXCEEDED", "Your free machine time for this month is used up.");

/** The UTC month (`YYYY-MM`) a moment falls in. */
export const monthOf = (epochMs: number): string => new Date(epochMs).toISOString().slice(0, 7);

async function get(deps: TrialDependencies, key: { pk: string; sk: string }): Promise<Item | undefined> {
  const response = await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: key, ConsistentRead: true })) as { Item?: Item };
  return response.Item;
}

/** The org's record, or undefined for an org with none (a single-org install's org is only created lazily). */
const orgOf = async (deps: TrialDependencies, orgId: OrgId): Promise<Item | undefined> => get(deps, orgMetaKey(orgId));

/**
 * Whether an org record is subject to the trial and the allowance (ruling R42). An org the system created for a private
 * install (`createdBy: "system"`, as `ensureOrg` does) never is, whatever its plan says.
 */
const limited = (org: Item | undefined): org is Item => org !== undefined && org.createdBy !== "system";

const errorName = (error: unknown) => (error instanceof Error ? error.name : undefined);

function cancelledConditions(error: unknown): Set<number> | undefined {
  if (errorName(error) !== "TransactionCanceledException") return undefined;
  const reasons = (error as { CancellationReasons?: unknown }).CancellationReasons;
  if (!Array.isArray(reasons)) return undefined;
  const failed = new Set<number>();
  reasons.forEach((reason: { Code?: string } | undefined, index) => {
    if (reason?.Code === "ConditionalCheckFailed") failed.add(index);
  });
  return failed;
}

/**
 * Unlocks an org's trial because `githubUserId` connected GitHub to it, and claims that GitHub account for this org in
 * the same transaction. A GitHub account that already unlocked another org is refused with TRIAL_GITHUB_USED, and the
 * org stays locked. An org that is already unlocked is left as it is (a replay changes nothing and claims nothing more).
 */
export async function unlockTrial(deps: TrialDependencies, input: { orgId: OrgId; githubUserId: string }): Promise<void> {
  if (input.githubUserId.trim() === "") throw agentXError("CONFIG_INVALID", "a GitHub user id is required to unlock a trial");
  const org = await orgOf(deps, input.orgId);
  if (org === undefined) throw agentXError("NOT_FOUND", "organization not found");
  // Only a trial org has anything to unlock: another plan claims no GitHub account.
  if (org.plan !== "trial" || org.trialUnlockedAt !== undefined) return;
  const now = (deps.now ?? Date.now)();
  try {
    await deps.documentClient.send(new TransactWriteCommand({
      TransactItems: [
        { Put: {
          TableName: deps.tableName,
          Item: { ...trialGithubKey(input.githubUserId), entityType: "TRIAL_GITHUB", orgId: input.orgId, claimedAt: now },
          // The same org claiming the same account again (a retried callback) is not a second claim.
          ConditionExpression: "attribute_not_exists(pk) OR orgId = :orgId",
          ExpressionAttributeValues: { ":orgId": input.orgId },
        } },
        { Update: {
          TableName: deps.tableName,
          Key: orgMetaKey(input.orgId),
          UpdateExpression: "SET trialUnlockedAt = :now, trialGithubUserId = :github",
          ConditionExpression: "attribute_exists(pk) AND attribute_not_exists(trialUnlockedAt)",
          ExpressionAttributeValues: { ":now": now, ":github": input.githubUserId },
        } },
      ],
    }));
  } catch (error) {
    const failed = cancelledConditions(error);
    if (failed?.has(0)) throw trialGithubUsed();
    // Another callback unlocked the org first: the transaction rolled back, and the org is open, which is what was asked.
    if (failed?.has(1)) return;
    throw error;
  }
}

/** A trial org with no GitHub connected may not start work (403 TRIAL_LOCKED). Any other plan, and an org with no record, passes. */
export async function admitTrial(deps: TrialDependencies, orgId: OrgId): Promise<void> {
  const org = await orgOf(deps, orgId);
  if (limited(org) && org.plan === "trial" && org.trialUnlockedAt === undefined) throw trialLocked();
}

/** The hours of machine time a plan allows per month; undefined for an org with no plan on record, which is not limited. */
function allowanceHours(plan: unknown): number | undefined {
  if (plan === "trial") return TRIAL_MACHINE_HOURS_PER_MONTH;
  if (plan === "team") return TEAM_MACHINE_HOURS_PER_MONTH;
  return undefined;
}

/**
 * Adds one compute stop's seconds to its org's month. The month is the UTC month of `stoppedAt`: a run that spans a
 * month boundary is counted whole in the month it stopped. A workspace's stop is counted once however often it is
 * recorded (a once-key per workspace and stop time), and the seconds are added atomically in the same transaction.
 * The per-instance-type attribute lets a later plan weight types differently without re-deriving the total.
 */
export async function recordMachineTime(
  deps: TrialDependencies,
  input: { orgId: OrgId; workspaceId: string; instanceType: string; startedAt: number; stoppedAt: number },
): Promise<void> {
  const seconds = Math.max(0, Math.round((input.stoppedAt - input.startedAt) / 1000));
  if (seconds === 0) {
    await closeOpenCompute(deps, input.orgId, input.workspaceId);
    return;
  }
  const typed = `seconds_${input.instanceType.replace(/[^A-Za-z0-9]/g, "_")}`;
  try {
    await deps.documentClient.send(new TransactWriteCommand({
      TransactItems: [
        { Put: {
          TableName: deps.tableName,
          Item: { ...machineTimeOnceKey(input.orgId, input.workspaceId, input.stoppedAt), entityType: "MACHINE_TIME_ONCE", instanceType: input.instanceType, seconds },
          ConditionExpression: "attribute_not_exists(pk)",
        } },
        { Update: {
          TableName: deps.tableName,
          Key: machineTimeMonthKey(input.orgId, monthOf(input.stoppedAt)),
          UpdateExpression: "SET entityType = if_not_exists(entityType, :type) ADD #seconds :seconds, #typed :seconds",
          ExpressionAttributeNames: { "#seconds": "seconds", "#typed": typed },
          ExpressionAttributeValues: { ":type": "MACHINE_TIME", ":seconds": seconds },
        } },
        // The seconds now count as recorded, so the workspace is no longer counted as running (deleting an absent marker is fine).
        { Delete: { TableName: deps.tableName, Key: openComputeKey(input.orgId, input.workspaceId) } },
      ],
    }));
  } catch (error) {
    // The once-key held: this stop was recorded already.
    if (cancelledConditions(error)?.has(0)) return;
    throw error;
  }
}

/**
 * Marks a workspace's instance as running since `startedAt` (epoch milliseconds), so `admitMachineTime` counts the time it
 * has run so far, not only what a stop will one day record. Put again by a later launch of the same workspace.
 */
export async function openCompute(deps: TrialDependencies, input: { orgId: OrgId; workspaceId: string; startedAt: number }): Promise<void> {
  await deps.documentClient.send(new PutCommand({
    TableName: deps.tableName,
    Item: { ...openComputeKey(input.orgId, input.workspaceId), entityType: "OPEN_COMPUTE", workspaceId: input.workspaceId, startedAt: input.startedAt },
  }));
}

/** Removes a workspace's running marker without recording anything (a run of no length). */
async function closeOpenCompute(deps: TrialDependencies, orgId: OrgId, workspaceId: string): Promise<void> {
  await deps.documentClient.send(new DeleteCommand({ TableName: deps.tableName, Key: openComputeKey(orgId, workspaceId) }));
}

/**
 * Whether a running marker still describes a live instance: its workspace's session (a consistent read) holds an instance
 * that launched exactly when the marker says. Anything else (the session is gone, stopped, failed, or on a later launch)
 * means the stop that should have removed the marker did not.
 */
async function markerIsLive(deps: TrialDependencies, workspaceId: string, startedAt: number): Promise<boolean> {
  const session = await get(deps, workspaceSessionKey(workspaceId));
  return typeof session?.instanceId === "string" && typeof session.launchedAt === "string" && Date.parse(session.launchedAt) === startedAt;
}

/**
 * Seconds the org's workspaces have been running, from their launch to `now`: compute that no stop has recorded yet.
 * A marker counts only while its session still holds that launch (a stale one counts nothing and is removed, best effort,
 * so a stop that failed to record cannot lock the org out), and counts for at most a session's lifetime, the backstop.
 */
async function runningSeconds(deps: TrialDependencies, orgId: OrgId, now: number): Promise<number> {
  let total = 0;
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const page = await deps.documentClient.send(new QueryCommand({
      TableName: deps.tableName,
      KeyConditionExpression: "pk = :pk",
      ExpressionAttributeValues: { ":pk": openComputePk(orgId) },
      ConsistentRead: true,
      ...(exclusiveStartKey === undefined ? {} : { ExclusiveStartKey: exclusiveStartKey }),
    })) as { Items?: Item[]; LastEvaluatedKey?: Record<string, unknown> };
    for (const item of page.Items ?? []) {
      if (typeof item.startedAt !== "number" || typeof item.workspaceId !== "string") continue;
      if (!await markerIsLive(deps, item.workspaceId, item.startedAt)) {
        await closeOpenCompute(deps, orgId, item.workspaceId).catch(() => undefined);
        continue;
      }
      total += Math.min(Math.max(0, now - item.startedAt), SESSION_MAX_LIFETIME_MS) / 1000;
    }
    exclusiveStartKey = page.LastEvaluatedKey;
  } while (exclusiveStartKey !== undefined);
  return total;
}

/** Seconds of machine time an org has used in the UTC month `month` (`YYYY-MM`). */
export async function machineSecondsUsed(deps: TrialDependencies, orgId: OrgId, month: string): Promise<number> {
  const item = await get(deps, machineTimeMonthKey(orgId, month));
  return typeof item?.seconds === "number" ? item.seconds : 0;
}

/**
 * An org at or over its month's allowance may not start work (402 MACHINE_TIME_EXCEEDED). Compute already running is not
 * stopped, but the time it has run so far counts.
 */
export async function admitMachineTime(deps: TrialDependencies, orgId: OrgId): Promise<void> {
  const org = await orgOf(deps, orgId);
  const limit = limited(org) ? allowanceHours(org.plan) : undefined;
  if (limit === undefined) return;
  const now = (deps.now ?? Date.now)();
  // What stops recorded this month, plus what the org's running instances have run so far (whole, wherever they launched):
  // otherwise one workspace could run its 14-day lifetime before any of it counted.
  const used = await machineSecondsUsed(deps, orgId, monthOf(now)) + await runningSeconds(deps, orgId, now);
  if (used >= limit * SECONDS_PER_HOUR) throw machineTimeExceeded();
}

/**
 * What the trial view shows of machine time: the plan's hours for the UTC month `now` falls in and the seconds used so far (recorded stops plus what the org's running instances have run), the
 * same two figures `admitMachineTime` refuses on. Undefined for an org with no plan on record or one the system created (`limited`), which has no allowance. A read: the only write is the best-effort
 * removal of a stale running marker that `runningSeconds` already makes at every admission.
 */
export async function readMachineAllowance(deps: TrialDependencies, orgId: OrgId): Promise<{ month: string; grantedHours: number; usedSeconds: number } | undefined> {
  const org = await orgOf(deps, orgId);
  const grantedHours = limited(org) ? allowanceHours(org.plan) : undefined;
  if (grantedHours === undefined) return undefined;
  const now = (deps.now ?? Date.now)();
  const month = monthOf(now);
  return { month, grantedHours, usedSeconds: await machineSecondsUsed(deps, orgId, month) + await runningSeconds(deps, orgId, now) };
}
