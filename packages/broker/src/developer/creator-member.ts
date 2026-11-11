// Plan 2, Task 4 (ruling R60): a person removed from their org stops their running work. A step already running on a worker finishes;
// the next dispatch or publication for any of their tasks re-reads their live member record and refuses here, before any other access
// check, so the refusal names the removal instead of failing later in the project-grant check with "project not found". The task
// then ends with outcome `creator_removed` and that message as its reason. "Removed" is the member record gone with the removal's
// tombstone present (OrgStore writes it in the same transaction): a person with no member record and no tombstone never joined. Their workspaces are left to the idle reaper.
import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { OrgIdSchema, agentXError, isSystemOwnerId, chainRunKey, type OrgId } from "@rovara-code/contracts";
import { orgMemberKey, orgMetaKey, orgRemovedKey } from "@agentx/cloud-contracts";
import { paymentOfTask } from "../spend/payer.js";
import { systemOwnerStands } from "./system-owner.js";
import { hasTaskEndHandlers, onTaskEnded } from "../agents/task-end.js";
import { leaveTaskEndRow } from "../aws/task-end-row.js";
import { effectiveTaskOwner, ownerFenceOf, taskAgentRunKey, taskKey, taskPointerKey, type DeveloperTaskPointerRecord, type DeveloperTaskRecord } from "./task-records.js";

export interface CreatorCheckDependencies {
  documentClient: { send(command: unknown): Promise<unknown> };
  tableName: string;
  /** The org to read the membership in when the task record names none (the caller's org on a route). */
  orgId?: OrgId | undefined;
  /** The org a task without a stored `orgId` belongs to (the broker's resolver); undefined for a legacy task that has none. */
  orgOf?: (task: DeveloperTaskRecord) => Promise<OrgId | undefined>;
  now?: () => number;
}

/** The text a removed creator's task ends with. */
export const creatorRemovedMessage = (name: string, orgName: string) => `${name} is no longer a member of ${orgName}, so Rovara stopped this task.`;

async function readConsistent<T>(deps: CreatorCheckDependencies, key: { pk: string; sk: string }): Promise<T | undefined> {
  const response = await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: key, ConsistentRead: true })) as { Item?: T };
  return response.Item;
}

/**
 * Refuses (TASK_ACCESS_DENIED) when the task's owner is no longer a member of the task's org, and records `creator_removed` on the
 * task. The owner is the effective one (Plan 5 Task 12a): the person who took the task over, else its creator; the removal message names them, and a task whose owner
 * can't be read refuses too. Does nothing for a legacy task with no org. Call it first: before `acceptTask`, before minting a token, before any access check.
 * The record is written only while that owner still owns the task: a take-over that lands first makes this call check the new owner instead.
 */
export function requireCreatorStillMember(deps: CreatorCheckDependencies, task: DeveloperTaskRecord): Promise<void> {
  return checkOwnerStillMember(deps, task, 0);
}

/**
 * Whether a person has left the org since a piece of work began (ruling R60, and member removal's rejoin rule). The member record is read first, as before:
 * - none: they are gone when the removal's tombstone is there (a Slack user who has not signed in yet has neither and never joined);
 * - one that began (`joinedAt`) no later than the work: their membership has been unbroken since, so they pass without reading the tombstone (a removal deletes the record, and
 *   a rejoin writes a new `joinedAt`);
 * - one that began after the work: they left and came back. They are gone for this work when the tombstone's `removedAt` is later than the work's start. The tombstone has no
 *   expiry, so it outlives any task or chain run.
 * `workStart` is read only when the member record exists, and undefined means "no start time known": today's rule (a member is a member).
 */
export async function memberGoneSince(
  deps: Pick<CreatorCheckDependencies, "documentClient" | "tableName">, orgId: OrgId, developerId: string, workStart: () => Promise<string | undefined> | string | undefined,
  options: { rejoinedOnly?: boolean } = {},
): Promise<boolean> {
  const member = await readConsistent<{ joinedAt?: unknown }>(deps, orgMemberKey(orgId, developerId));
  // `rejoinedOnly`: for a person (a payer) whose plain absence never stopped the work: only a return after a removal does.
  if (member === undefined) return options.rejoinedOnly === true ? false : await readConsistent(deps, orgRemovedKey(orgId, developerId)) !== undefined;
  const started = await workStart();
  if (started === undefined || typeof member.joinedAt !== "string" || member.joinedAt <= started) return false;
  const tombstone = await readConsistent<{ removedAt?: unknown }>(deps, orgRemovedKey(orgId, developerId));
  return typeof tombstone?.removedAt === "string" && tombstone.removedAt > started;
}

/**
 * When a task's work began: for a chain step's task, when the chain run began (a step started after a rejoin still belongs to a run that began before the removal); for any other
 * task, when it was created (a continue-as-task keeps the same record, so its creation applies).
 */
export async function taskWorkStart(deps: Pick<CreatorCheckDependencies, "documentClient" | "tableName">, orgId: OrgId, task: Pick<DeveloperTaskRecord, "createdAt" | "chain">): Promise<string | undefined> {
  if (task.chain !== undefined) {
    const run = await readConsistent<{ createdAt?: unknown }>(deps, chainRunKey(orgId, task.chain.chainRunId, "META"));
    if (typeof run?.createdAt === "string") return run.createdAt;
  }
  return typeof task.createdAt === "string" ? task.createdAt : undefined;
}

/**
 * Task 21, Re-check R-2: no key is minted once the org is closed, or for work whose owner (or whose paying member) has been removed from it. Read live at every mint, so work that
 * is still running when an org closes (a plain task, a task from before sessions, a Slack thread's operation) gets no new key at its next model call. A read that fails is the proxy's
 * retryable answer, and nothing is minted. An org with no record of its own (an install from before orgs) is not closed by this; a person with no member record and no removal tombstone never joined.
 * `workStart` (when the work began, or a way to read it) makes a person who rejoined count as gone for work that began before their removal (see `memberGoneSince`).
 */
export async function requireOrgOpenFor(deps: Pick<CreatorCheckDependencies, "documentClient" | "tableName">, orgId: OrgId, people: ReadonlyArray<string | undefined>, workStart?: string | (() => Promise<string | undefined>)): Promise<void> {
  const denied = agentXError("TASK_ACCESS_DENIED", "This organization is closed, or the person this work is for has left it, so Rovara stopped this work.");
  try {
    const meta = await readConsistent<{ closedAt?: unknown }>(deps, orgMetaKey(orgId));
    if (meta?.closedAt !== undefined) throw denied;
    for (const developerId of new Set(people)) {
      if (developerId === undefined) throw denied;
      if (await memberGoneSince(deps, orgId, developerId, typeof workStart === "function" ? workStart : () => workStart)) throw denied;
    }
  } catch (error) {
    if (error === denied) throw error;
    console.log(JSON.stringify({ component: "broker", event: "model_access.org_state_unreadable", errorName: error instanceof Error ? error.name : "unknown" }));
    throw agentXError("MODEL_PROXY_UNAVAILABLE", "the model proxy could not issue a key");
  }
}

async function checkOwnerStillMember(deps: CreatorCheckDependencies, task: DeveloperTaskRecord, takeOversSeen: number): Promise<void> {
  const owner = effectiveTaskOwner(task);
  const stored = OrgIdSchema.safeParse(task.orgId);
  const orgId = stored.success ? stored.data : deps.orgOf === undefined ? deps.orgId : await deps.orgOf(task);
  if (orgId === undefined) return;
  // A project's system owner is no member to lose: it stands while the company is open and the project is there and active. It is never "removed", so nothing is recorded on the task; the work is refused.
  if (isSystemOwnerId(owner.developerId)) {
    if (!await systemOwnerStands(deps, orgId, task.project)) throw agentXError("TASK_ACCESS_DENIED", "This project's automatic runs can't continue: the project or the company is no longer active.");
    return;
  }
  // The owner, and the member who pays for the task when that is someone else: either gone since the work began stops it (a person who rejoined does not revive their old work).
  let start: Promise<string | undefined> | undefined;
  const workStart = () => (start ??= taskWorkStart(deps, orgId, task));
  const payer = paymentOfTask(task).payer;
  let goneName: string | undefined;
  if (await memberGoneSince(deps, orgId, owner.developerId, workStart)) goneName = owner.name;
  else if (payer.kind === "member" && payer.developerId !== owner.developerId && await memberGoneSince(deps, orgId, payer.developerId, workStart, { rejoinedOnly: true })) goneName = "The person paying for this task";
  // No member record is not enough: a Slack user who has not signed in yet has none and is not removed. Removal leaves a tombstone.
  if (goneName === undefined) return;
  const org = await readConsistent<{ name?: unknown }>(deps, orgMetaKey(orgId));
  const message = creatorRemovedMessage(goneName, typeof org?.name === "string" ? org.name : "the organization");
  const fence = ownerFenceOf(task);
  try {
    // First removal wins: a repeat leaves the reason and time of the first.
    await deps.documentClient.send(new UpdateCommand({
      TableName: deps.tableName, Key: taskKey(task.taskId),
      UpdateExpression: "SET #outcome = :outcome, outcomeReason = :reason, outcomeAt = :at",
      ConditionExpression: `attribute_exists(pk) AND attribute_not_exists(#outcome) AND ${fence.expression}`,
      ExpressionAttributeNames: { "#outcome": "outcome", ...fence.names },
      ExpressionAttributeValues: { ":outcome": "creator_removed", ":reason": message, ":at": new Date((deps.now ?? Date.now)()).toISOString(), ...fence.values },
    }));
    await tellRemoved(deps, task);
  } catch (error) {
    if ((error instanceof Error ? error.name : undefined) !== "ConditionalCheckFailedException") throw error;
    // Either an earlier call recorded the removal, or the task changed hands since it was read: read it again to tell which.
    const fresh = await readConsistent<DeveloperTaskRecord>(deps, taskKey(task.taskId));
    if (fresh !== undefined && fresh.outcome === undefined && takeOversSeen < 3) return checkOwnerStillMember(deps, fresh, takeOversSeen + 1);
    // Already recorded by an earlier call: its telling may not have finished, so this call takes it up (told once: Plan 3's TASK_END record, and no row if it was told).
    await tellRemoved(deps, task);
  }
  throw agentXError("TASK_ACCESS_DENIED", message);
}

/**
 * The task ended because its creator was removed (G7): the end handlers hear it, once. An agent-step run's end is told by its engine, which ends the run
 * right after this check refuses. Never throws: the end is recorded already. An end that is not finished (a handler threw, or another call is telling it) leaves
 * a recovery row (Plan 5 Task 7b, the Task 22 hand-off) that the sweep tells it from, and the next call that reaches the task's end takes it up too.
 */
async function tellRemoved(deps: CreatorCheckDependencies, task: DeveloperTaskRecord): Promise<void> {
  if (!hasTaskEndHandlers()) return;
  let told: "in_progress" | "failed" | undefined;
  try {
    if (task.agent !== undefined && await readConsistent(deps, taskAgentRunKey(task.taskId)) !== undefined) return;
    if (await onTaskEnded({ documentClient: deps.documentClient, tableName: deps.tableName, now: deps.now ?? Date.now }, task, "creator_removed") === "in_progress") told = "in_progress";
  } catch (error) {
    console.log(JSON.stringify({ component: "broker", event: "task_end.not_told", taskId: task.taskId, error: error instanceof Error ? error.name : "unknown" }));
    told = "failed";
  }
  if (told !== undefined) await leaveTaskEndRow(deps, task, "creator_removed", told);
}

/**
 * The same check for a path that holds a workspace rather than a task: the task is found through the workspace's task pointer. A
 * workspace with no task (a plain workspace, not a developer task's) skips the check.
 */
export async function requireWorkspaceCreatorStillMember(deps: CreatorCheckDependencies, workspaceId: string): Promise<void> {
  const pointer = await readConsistent<Pick<DeveloperTaskPointerRecord, "taskId">>(deps, taskPointerKey(workspaceId));
  if (pointer === undefined) return;
  const task = await readConsistent<DeveloperTaskRecord>(deps, taskKey(pointer.taskId));
  if (task === undefined) return;
  await requireCreatorStillMember(deps, task);
}
