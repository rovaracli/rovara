// "Continue in your own tool", the server side (decision 4; E-28..E-31, owner Q13): what the task view says about the working branch and about pushes that did not come from Rovara, and the one write that
// makes a working branch before any pull request exists.
//
//   - A task's working branch is `agentx/<taskId>` in a repository. A pull request's own branch (`agentx/<operationId>`, from its record) is listed too, so a person has one place to read "the branch".
//   - "Changed outside Rovara": for a pull request, what merge tracking already decides from the host's own read (`headByRovara`, the head is neither the workflow's nor the pull request record's: Rovara's own
//     push is never flagged). For a branch published on request, Rovara never pushes to it, so any head other than the one it was made at is outside.
//   - "Last pushed by": the host's push event names who pushed which head (the `sender` of a verified delivery, never a commit author or an email). It is a HINT stored beside the task and shown only when it
//     names the very head the host shows now; it never decides whether the head is Rovara's.
import { GetCommand, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { agentXError, codeRepositoriesOf } from "@rovara-code/contracts";
import { CHANGED_OUTSIDE_LABEL, ContinueLoopViewSchema, GITHUB_LOGIN_PATTERN, OutsidePushHintSchema, workingBranchName, type ContinueLoopBranch, type ContinueLoopOutside, type ContinueLoopView, type MergeTrackingItem, type OutsidePushHint, type PublishWorkingBranchResult, PublishWorkingBranchRequestSchema, RecheckRequestSchema, type WorkflowSnapshot } from "@agentx/cloud-contracts";
import { can, requireProjectSendBackRole, resolveTaskAccess, type TaskAccess } from "../../developer/task-access.js";
import { auditOccurrence, auditTaskRecheckRequested, auditTaskWorkingBranchPublished } from "../../audit/events.js";
import { flushAuditEvents, recordAuditEventDurably } from "../../audit/flush.js";
import { authorizeTaskAction } from "./access.js";
import { creatorGuard, iso, parse } from "./common.js";
import { type DeveloperTaskRecord } from "../../developer/task-records.js";
import { readMergeTracking } from "../../rovara-code/merge-tracking.js";
import { pullRequestKey } from "../broker/admin-and-helpers.js";
import type { PullRequestRecord } from "../broker/definitions.js";
import type { DeveloperCaller } from "../developer-routes.js";
import type { DeveloperTaskRouteDependencies } from "./types.js";

type Table = Pick<DeveloperTaskRouteDependencies, "documentClient" | "tableName">;

/** The host operations on a task repository's working branch. Wired at the broker with the repository's own push grant; a fake in tests. */
export interface WorkingBranchPort {
  /** The commit of `branch` in the repository, or undefined when there is no such branch. */
  branchHead(task: DeveloperTaskRecord, repository: { name: string; url: string }, branch: string): Promise<string | undefined>;
  /** Creates `branch` at `commit` (a commit the repository already holds). Never moves an existing branch: an existing one is an error. */
  createBranch(task: DeveloperTaskRecord, repository: { name: string; url: string }, branch: string, commit: string): Promise<void>;
}

// ---- stored rows

export interface WorkingBranchRecord {
  pk: string; sk: string; entityType: "WORKING_BRANCH"; taskId: string; orgId: string;
  repository: string; branch: string; baseSha: string; createdAt: string; createdBy: string;
}
export const workingBranchKey = (taskId: string, repository: string) => ({ pk: `DEVTASK#${taskId}`, sk: `WORKING_BRANCH#${repository}` });
/** `subject` is a pull request's number, or "branch" for the published working branch of the repository. */
export const outsidePushKey = (taskId: string, repository: string, subject: number | "branch") => ({ pk: `DEVTASK#${taskId}`, sk: `OUTSIDE_PUSH#${repository}#${String(subject)}` });

const SHA = /^[a-f0-9]{40}$/u;

/**
 * Stores who pushed which head, from a verified push event. The newest event wins (a late delivery of an older push never overwrites a newer one). A login the host would not spell that way, or a head that is
 * not a commit, is not stored. Never throws for a lost race.
 */
export async function recordOutsidePush(deps: Table, input: { taskId: string; repository: string; subject: number | "branch"; headSha: string; login: string; at: string }): Promise<boolean> {
  if (!SHA.test(input.headSha) || !GITHUB_LOGIN_PATTERN.test(input.login)) return false;
  try {
    await deps.documentClient.send(new PutCommand({
      TableName: deps.tableName,
      Item: { ...outsidePushKey(input.taskId, input.repository, input.subject), entityType: "OUTSIDE_PUSH", taskId: input.taskId, headSha: input.headSha, login: input.login, at: input.at },
      ConditionExpression: "attribute_not_exists(pk) OR #at <= :at",
      ExpressionAttributeNames: { "#at": "at" }, ExpressionAttributeValues: { ":at": input.at },
    }));
    return true;
  } catch (error) {
    if ((error as { name?: string }).name === "ConditionalCheckFailedException") return false;
    throw error;
  }
}

async function readHint(deps: Table, taskId: string, repository: string, subject: number | "branch"): Promise<OutsidePushHint | undefined> {
  const found = await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: outsidePushKey(taskId, repository, subject), ConsistentRead: true })) as { Item?: Record<string, unknown> };
  const parsed = OutsidePushHintSchema.safeParse(found.Item === undefined ? undefined : { headSha: found.Item["headSha"], login: found.Item["login"], at: found.Item["at"] });
  return parsed.success ? parsed.data : undefined;
}

export async function readWorkingBranches(deps: Table, taskId: string): Promise<WorkingBranchRecord[]> {
  const rows: WorkingBranchRecord[] = [];
  let start: Record<string, unknown> | undefined;
  do {
    const page = await deps.documentClient.send(new QueryCommand({
      TableName: deps.tableName, ConsistentRead: true, KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
      ExpressionAttributeValues: { ":pk": `DEVTASK#${taskId}`, ":prefix": "WORKING_BRANCH#" }, ...(start === undefined ? {} : { ExclusiveStartKey: start }),
    })) as { Items?: Array<Record<string, unknown>>; LastEvaluatedKey?: Record<string, unknown> };
    for (const item of page.Items ?? []) {
      if (item["entityType"] === "WORKING_BRANCH" && item["taskId"] === taskId && typeof item["repository"] === "string" && typeof item["branch"] === "string" && typeof item["baseSha"] === "string") rows.push(item as unknown as WorkingBranchRecord);
    }
    start = page.LastEvaluatedKey;
  } while (start !== undefined);
  return rows.slice(0, 32);
}

// ---- the decision, as plain functions

/** Whether Rovara can re-check the pull request's head now: the task waits for the merge, nothing of Rovara's is in flight on it, and the pull request is open and recorded. */
export function recheckPossible(workflow: WorkflowSnapshot | undefined, pullRequest: { repositoryId: string; number: number }): boolean {
  if (workflow === undefined || workflow.stage !== "WAIT_FOR_MERGE" || workflow.state !== "WAITING" || workflow.branchSync !== undefined) return false;
  return (workflow.pullRequests ?? []).some((entry) => entry.repositoryId === pullRequest.repositoryId && entry.number === pullRequest.number && entry.state === "OPEN" && entry.headSha !== undefined);
}

/** What a pull request head that Rovara did not make looks like: only an OPEN pull request whose head merge tracking read as not Rovara's. A head Rovara pushed, or put back by force, is not outside. */
export function outsideOfPullRequest(input: { item: Pick<MergeTrackingItem, "repositoryId" | "number" | "state" | "headSha" | "headByRovara">; hint: OutsidePushHint | undefined; canRecheck: boolean }): ContinueLoopOutside | undefined {
  const { item, hint } = input;
  if (item.state !== "open" || item.headByRovara) return undefined;
  return {
    repository: item.repositoryId, number: item.number, headSha: item.headSha,
    // Only a hint about THIS head counts: a hint about an earlier head says nothing about who made the one the host shows now.
    ...(hint !== undefined && hint.headSha === item.headSha ? { lastPushedBy: { login: hint.login, at: hint.at } } : {}),
    canRecheck: input.canRecheck,
  };
}

/** A branch published on request: Rovara never pushes to it, so a head that is not the one it was made at is outside. The host's event gives the head; with no event the state is unknown, not outside. */
export function outsideOfPublishedBranch(input: { branch: Pick<WorkingBranchRecord, "repository" | "baseSha">; hint: OutsidePushHint | undefined }): ContinueLoopOutside | undefined {
  const { branch, hint } = input;
  if (hint === undefined || hint.headSha === branch.baseSha) return undefined;
  return { repository: branch.repository, headSha: hint.headSha, lastPushedBy: { login: hint.login, at: hint.at }, canRecheck: false };
}

// ---- the view

/** Who may publish a branch or ask for a re-check: the task's owner or a co-owner (the `work` action), on a task that is open. The routes check again, with the project's own work rule. */
export function mayWorkOn(access: Pick<TaskAccess, "role" | "source">, task: Pick<DeveloperTaskRecord, "closedAt">): boolean {
  return task.closedAt === undefined && can(access.role, "work", access.source);
}

/**
 * The continue-loop part of the task view (version 2 tasks, full reads). Informational: any fault in a read leaves it out and never fails the view. Returns undefined when there is nothing to say and
 * nothing to offer.
 */
export async function continueLoopViewOf(deps: Table, task: DeveloperTaskRecord, access: Pick<TaskAccess, "role" | "source">, tracked: readonly MergeTrackingItem[], offers: { publish: boolean; recheck: boolean } = { publish: true, recheck: true }): Promise<ContinueLoopView | undefined> {
  const workflow = task.workflow;
  if (workflow === undefined || workflow.definitionVersion !== "1.1.0" || task.orgId === undefined) return undefined;
  const mayWork = mayWorkOn(access, task);
  const branches: ContinueLoopBranch[] = [];
  const outside: ContinueLoopOutside[] = [];
  for (const pr of (workflow.pullRequests ?? []).slice(0, 32)) {
    const record = (await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: pullRequestKey(task.workspaceId, pr.repositoryId, pr.number), ConsistentRead: true })) as { Item?: PullRequestRecord }).Item;
    if (record !== undefined && /^agentx\/[0-9a-f-]{36}$/iu.test(record.headBranch)) {
      branches.push({ repository: pr.repositoryId, branch: record.headBranch, source: "pull_request", ...(pr.headSha === undefined ? {} : { headSha: pr.headSha }), pullRequest: { number: pr.number, url: pr.url } });
    }
    const item = tracked.find((entry) => entry.repositoryId === pr.repositoryId && entry.number === pr.number);
    if (item === undefined) continue;
    const row = outsideOfPullRequest({ item, hint: await readHint(deps, task.taskId, pr.repositoryId, pr.number), canRecheck: mayWork && offers.recheck && recheckPossible(workflow, { repositoryId: pr.repositoryId, number: pr.number }) });
    if (row !== undefined) outside.push(row);
  }
  for (const published of await readWorkingBranches(deps, task.taskId)) {
    branches.push({ repository: published.repository, branch: published.branch, source: "published", headSha: published.baseSha });
    const row = outsideOfPublishedBranch({ branch: published, hint: await readHint(deps, task.taskId, published.repository, "branch") });
    if (row !== undefined) outside.push(row);
  }
  const canRecheck = outside.some((row) => row.canRecheck);
  const preparedRepositories = (workflow.reviewBase ?? task.preparedBase ?? []).length;
  const canPublishBranch = mayWork && offers.publish && preparedRepositories > 0;
  if (branches.length === 0 && outside.length === 0 && !canPublishBranch) return undefined;
  const view = { branches, outside, ...(outside.length === 0 ? {} : { label: CHANGED_OUTSIDE_LABEL }), canPublishBranch, canRecheck: mayWork && canRecheck };
  const parsed = ContinueLoopViewSchema.safeParse(view);
  return parsed.success ? parsed.data : undefined;
}

/** The view for the caller these dependencies were built for: their own access decides what they may press. A reader who cannot be resolved gets none. */
export async function continueLoopViewFor(deps: DeveloperTaskRouteDependencies, caller: DeveloperCaller, task: DeveloperTaskRecord, tracked: readonly MergeTrackingItem[]): Promise<ContinueLoopView | undefined> {
  let access: TaskAccess;
  try { access = await resolveTaskAccess(deps, caller, task.taskId); } catch { return undefined; }
  return continueLoopViewOf(deps, task, access, tracked, { publish: deps.workingBranchPort !== undefined, recheck: deps.startOutsideRecheck !== undefined });
}

// ---- publish the working branch

/**
 * Makes the task's working branch (`agentx/<taskId>`) in one repository, at the commit Rovara prepared the task on: no code of Rovara's is published, so nothing unchecked leaves the task, and nothing
 * is ever moved or overwritten (an existing branch is only reported). The caller has already checked who may and that the task is open. A repeat (the branch exists and a row says so, or the host already
 * has it at the base commit) answers `created: false` and changes nothing.
 */
export async function publishWorkingBranch(
  deps: Table & Pick<DeveloperTaskRouteDependencies, "actions" | "orgId" | "now" | "workingBranchPort">,
  task: DeveloperTaskRecord,
  input: { repository: string; actorId: string },
): Promise<PublishWorkingBranchResult> {
  const port = deps.workingBranchPort;
  if (port === undefined) throw agentXError("RUNTIME_UNAVAILABLE", "Publishing a working branch is not available here.");
  const workflow = task.workflow;
  if (task.closedAt !== undefined || workflow === undefined || task.orgId === undefined || task.startingRevision === undefined) throw agentXError("CONFIG_INVALID", "This task has no working branch to publish.");
  const base = (workflow.reviewBase ?? task.preparedBase)?.find((entry) => entry.repositoryId === input.repository)?.baseCommitSha;
  if (base === undefined || !SHA.test(base)) throw agentXError("WORKSPACE_NOT_READY", "Rovara hasn't finished preparing this repository, so there is no branch to make yet.");
  const project = await deps.actions.projectRevision(deps.orgId, task.project, task.startingRevision);
  const repository = project === undefined ? undefined : codeRepositoriesOf(project.definition).find((entry) => entry.name === input.repository);
  if (repository === undefined) throw agentXError("CONFIG_INVALID", "That repository is not part of this task's project.");
  const branch = workingBranchName(task.taskId);
  const key = workingBranchKey(task.taskId, repository.name);
  const existing = (await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: key, ConsistentRead: true })) as { Item?: WorkingBranchRecord }).Item;
  if (existing !== undefined) return { repository: repository.name, branch: existing.branch, commit: existing.baseSha, created: false };
  const present = await port.branchHead(task, { name: repository.name, url: repository.url }, branch);
  let created = false;
  if (present === undefined) {
    await port.createBranch(task, { name: repository.name, url: repository.url }, branch, base);
    created = true;
  } else if (present !== base) {
    // Somebody made this branch name before Rovara did: it is theirs, never claimed or moved.
    throw agentXError("CONFIG_INVALID", "A branch with that name already exists in the repository and is not at the task's base commit. Rovara won't change it.");
  }
  const at = new Date(deps.now()).toISOString();
  const record: WorkingBranchRecord = { ...key, entityType: "WORKING_BRANCH", taskId: task.taskId, orgId: task.orgId, repository: repository.name, branch, baseSha: base, createdAt: at, createdBy: input.actorId };
  try {
    await deps.documentClient.send(new PutCommand({ TableName: deps.tableName, Item: record, ConditionExpression: "attribute_not_exists(pk)" }));
  } catch (error) {
    if ((error as { name?: string }).name !== "ConditionalCheckFailedException") throw error;
  }
  return { repository: repository.name, branch, commit: base, created };
}

// ---- the two actions (owner or co-owner, browser session; the route file checks the session)

async function auditOnce(deps: DeveloperTaskRouteDependencies, event: ReturnType<typeof auditTaskWorkingBranchPublished>): Promise<void> {
  if (deps.learningAudit === undefined) return;
  await recordAuditEventDurably({ audit: deps.learningAudit }, event);
  await flushAuditEvents({ audit: deps.learningAudit }, [event]).catch(() => undefined);
}

/** `POST /v1/app/tasks/{id}/continue/publish-branch`. The `work` action: the task's owner (or a co-owner) with the project's own work rule, on an open task. A repeat changes nothing. */
export async function publishWorkingBranchAction(deps: DeveloperTaskRouteDependencies, caller: DeveloperCaller, taskId: string, value: unknown): Promise<PublishWorkingBranchResult> {
  const request = parse(PublishWorkingBranchRequestSchema, value, deps, "continue-publish-branch");
  const access = await authorizeTaskAction(deps, caller, taskId, "work");
  const { task } = access;
  if (task.closedAt !== undefined) throw agentXError("CONFIG_INVALID", "This task is closed.");
  await creatorGuard(deps, task);
  await requireProjectSendBackRole(deps, task, caller);
  const result = await publishWorkingBranch(deps, task, { repository: request.repository, actorId: access.actorId });
  if (result.created) {
    await auditOnce(deps, auditTaskWorkingBranchPublished({ orgId: String(task.orgId), actor: { kind: "member", id: caller.developerId }, occurredAt: iso(deps), occurrence: auditOccurrence(task.taskId, request.repository, "working-branch"), taskId: task.taskId, created: true }));
  }
  return result;
}

/** What starts a re-check of a head that changed outside Rovara: the broker's worker-side adoption of the head and a normal checks run on it. Absent on an install that lacks it; the action then says so and starts nothing. */
export type StartOutsideRecheck = (task: DeveloperTaskRecord, input: { requestId: string; repository: string; number: number; headSha: string; actorId: string }) => Promise<"STARTED" | "STALE">;

/**
 * `POST /v1/app/tasks/{id}/continue/recheck`. Every guard a person's own retry of paid work meets comes first, then the head the person saw must still be the one the host shows and still not Rovara's:
 * the work role, the project's send-back access (which includes the archive check: an archived project takes no new work), the task creator's membership and the money gate (a task waiting for more spend
 * is not re-checked at all: a person who may approve it does that first, and nothing is paid for before). Only then is the checks run started, by the port.
 */
export async function recheckAction(deps: DeveloperTaskRouteDependencies, caller: DeveloperCaller, taskId: string, value: unknown): Promise<{ status: "started" }> {
  const request = parse(RecheckRequestSchema, value, deps, "continue-recheck");
  const access = await authorizeTaskAction(deps, caller, taskId, "work");
  const { task } = access;
  const workflow = task.workflow;
  if (task.closedAt !== undefined || workflow === undefined || task.orgId === undefined) throw agentXError("CONFIG_INVALID", "This task is closed.");
  await creatorGuard(deps, task);
  await requireProjectSendBackRole(deps, task, caller);
  // The money gate: any pause at all stops a paid re-check (the approver lifts it first; a re-check never skips an approval).
  if (task.budgetPause !== undefined) throw agentXError("WORKSPACE_BUSY", "This task is waiting for more spend to be approved, so Rovara can't re-check it yet.");
  const start = deps.startOutsideRecheck;
  if (start === undefined) throw agentXError("RUNTIME_UNAVAILABLE", "Re-checking isn't available on this install yet.");
  if (!recheckPossible(workflow, { repositoryId: request.repository, number: request.number })) throw agentXError("CONFIG_INVALID", "Rovara can re-check once the task is waiting for the merge and nothing of its own is running on the pull request.");
  const tracked = (await readMergeTracking(deps, task.taskId, task.orgId)).find((entry) => entry.repositoryId === request.repository && entry.number === request.number);
  if (tracked === undefined || tracked.state !== "open" || tracked.headByRovara) throw agentXError("CONFIG_INVALID", "Nothing changed outside Rovara on that pull request.");
  if (tracked.headSha !== request.headSha) throw agentXError("STALE_FENCE", "The pull request changed again since you looked. Reload and check the new code.");
  const outcome = await start(task, { requestId: request.requestId, repository: request.repository, number: request.number, headSha: request.headSha, actorId: access.actorId });
  if (outcome === "STALE") throw agentXError("STALE_FENCE", "The pull request changed again since you looked. Reload and check the new code.");
  await auditOnce(deps, auditTaskRecheckRequested({ orgId: String(task.orgId), actor: { kind: "member", id: caller.developerId }, occurredAt: iso(deps), occurrence: auditOccurrence(task.taskId, request.requestId), taskId: task.taskId, outcome: "started" }));
  return { status: "started" };
}
