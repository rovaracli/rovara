// "Continue in your own tool", the server side (decision 4; E-28..E-31, owner Q13): what the task view says about the working branch and about pushes that did not come from Rovara, and the one write that
// makes a working branch before any pull request exists.
//
//   - A task's working branch is `agentx/<taskId>` in a repository. A pull request's own branch (`agentx/<operationId>`, from its record) is listed too, so a person has one place to read "the branch".
//   - "Changed outside Rovara": for a pull request, what merge tracking already decides from the host's own read (`headByRovara`, the head is neither the workflow's nor the pull request record's: Rovara's own
//     push is never flagged). For a branch published on request, Rovara never pushes to it, so any head other than the one it was made at is outside.
//   - "Last pushed by": the host's push event names who pushed which head (the `sender` of a verified delivery, never a commit author or an email). It is a HINT stored beside the task and shown only when it
//     names the very head the host shows now; it never decides whether the head is Rovara's.
import { createHash, randomUUID } from "node:crypto";
import { GetCommand, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { AgentXError, WorkflowTransitionError, agentXError, codeRepositoriesOf } from "@rovara-code/contracts";
import { CHANGED_OUTSIDE_LABEL, ContinueLoopViewSchema, GITHUB_LOGIN_PATTERN, OUTSIDE_RECHECK_WORKER_FEATURE, OUTSIDE_RECHECK_WORKER_MISSING, OutsidePushHintSchema, PUBLISHED_BRANCH_NOTE, RECHECK_NEEDS_PULL_REQUEST_NOTE, startWorkflowOutsideRecheck, workingBranchName, type ContinueLoopBranch, type ContinueLoopOutside, type ContinueLoopView, type MergeTrackingItem, type OutsidePushHint, type PublishWorkingBranchResult, PublishWorkingBranchRequestSchema, RecheckRequestSchema, type WorkflowSnapshot } from "@agentx/cloud-contracts";
import { can, requireProjectSendBackRole, resolveTaskAccess, type TaskAccess } from "../../developer/task-access.js";
import { auditOccurrence, auditTaskRecheckRequested, auditTaskWorkingBranchPublished } from "../../audit/events.js";
import { flushAuditEvents, recordAuditEventDurably } from "../../audit/flush.js";
import { accessFence, authorizeTaskAction, type AuthorizedTask } from "./access.js";
import { creatorGuard, iso, parse, partyOfTaskActor, putNew, turnTable } from "./common.js";
import { aiToolTurn, developerTaskIdentity, taskKey, type DeveloperTaskRecord } from "../../developer/task-records.js";
import { requireTaskStopWindowContext } from "../../org/task-stop-window.js";
import { requireMayGoOn } from "./task-window.js";
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
  // A task whose changes need browser or API checks is not re-checked from an outside head (its checks need a source export the adoption does not make), as a merge of the base is not.
  if (workflow === undefined || workflow.stage !== "WAIT_FOR_MERGE" || workflow.state !== "WAITING" || workflow.branchSync !== undefined || workflow.fixSource !== undefined || workflow.e2e?.required === true) return false;
  // The owner's feedback card is waiting (or being collected): nothing else starts on the pull request until it is answered.
  if (workflow.feedbackReview?.status === "PENDING" || workflow.feedbackReview?.status === "COLLECTING") return false;
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
  // A re-check runs on a pull request's head (0.5.15): a published branch has none yet, and the row says so in fixed words.
  return { repository: branch.repository, headSha: hint.headSha, lastPushedBy: { login: hint.login, at: hint.at }, canRecheck: false, recheckNote: RECHECK_NEEDS_PULL_REQUEST_NOTE };
}

/** The row of a pull request Rovara is re-checking now (it took the head the person saw as the task's code): no button, "re-checking". */
export function recheckingRow(marker: NonNullable<WorkflowSnapshot["outsideRecheck"]>, hint: OutsidePushHint | undefined): ContinueLoopOutside {
  return { repository: marker.repositoryId, number: marker.number, headSha: marker.headSha, ...(hint !== undefined && hint.headSha === marker.headSha ? { lastPushedBy: { login: hint.login, at: hint.at } } : {}), canRecheck: false, rechecking: true };
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
    const marker = workflow.outsideRecheck;
    // Re-checking this pull request now: the head the person saw is shown as being re-checked until its checks are recorded (the "outside" state clears then).
    if (marker !== undefined && (marker.phase === "adopting" || marker.phase === "checking") && marker.repositoryId === pr.repositoryId && marker.number === pr.number) {
      outside.push(recheckingRow(marker, await readHint(deps, task.taskId, pr.repositoryId, pr.number)));
      continue;
    }
    const item = tracked.find((entry) => entry.repositoryId === pr.repositoryId && entry.number === pr.number);
    if (item === undefined) continue;
    const row = outsideOfPullRequest({ item, hint: await readHint(deps, task.taskId, pr.repositoryId, pr.number), canRecheck: mayWork && offers.recheck && recheckPossible(workflow, { repositoryId: pr.repositoryId, number: pr.number }) });
    if (row !== undefined) outside.push(row);
  }
  const publishedBranches = await readWorkingBranches(deps, task.taskId);
  for (const published of publishedBranches) {
    branches.push({ repository: published.repository, branch: published.branch, source: "published", headSha: published.baseSha });
    const row = outsideOfPublishedBranch({ branch: published, hint: await readHint(deps, task.taskId, published.repository, "branch") });
    if (row !== undefined) outside.push(row);
  }
  const canRecheck = outside.some((row) => row.canRecheck);
  // The repositories a branch can be published in: prepared (a base commit is known) and with no branch listed yet, each at the commit the branch would be made at.
  const publishable = (workflow.reviewBase ?? task.preparedBase ?? []).filter((entry) => /^[a-f0-9]{40}$/u.test(entry.baseCommitSha) && !branches.some((branch) => branch.repository === entry.repositoryId))
    .slice(0, 32).map((entry) => ({ repository: entry.repositoryId, baseSha: entry.baseCommitSha }));
  const canPublishBranch = mayWork && offers.publish && publishable.length > 0;
  if (branches.length === 0 && outside.length === 0 && !canPublishBranch) return undefined;
  const view = { branches, outside, ...(outside.length === 0 ? {} : { label: CHANGED_OUTSIDE_LABEL }), canPublishBranch, ...(canPublishBranch ? { publishable } : {}),
    ...(publishedBranches.length === 0 ? {} : { publishedBranchNote: PUBLISHED_BRANCH_NOTE }), canRecheck: mayWork && canRecheck };
  const parsed = ContinueLoopViewSchema.safeParse(view);
  return parsed.success ? parsed.data : undefined;
}

/** The view for the caller these dependencies were built for: their own access decides what they may press. A reader who cannot be resolved gets none. */
export async function continueLoopViewFor(deps: DeveloperTaskRouteDependencies, caller: DeveloperCaller, task: DeveloperTaskRecord, tracked: readonly MergeTrackingItem[]): Promise<ContinueLoopView | undefined> {
  let access: TaskAccess;
  try { access = await resolveTaskAccess(deps, caller, task.taskId); } catch { return undefined; }
  // Recheck is offered only where it would start: this install can start one, the task is not waiting for more spend, and a worker that is up says it can adopt a head (one that is not up yet is asked at delivery).
  let recheck = deps.startOutsideRecheck !== undefined || deps.outsideRecheckFeatures !== undefined;
  if (task.budgetPause !== undefined) recheck = false;
  if (recheck && deps.startOutsideRecheck === undefined && deps.outsideRecheckFeatures !== undefined) {
    const features = await deps.outsideRecheckFeatures(task).catch(() => undefined);
    if (features !== undefined && !features.includes(OUTSIDE_RECHECK_WORKER_FEATURE)) recheck = false;
  }
  let publish = deps.workingBranchPort !== undefined;
  // Both presses meet the project's own work rule (send-back access, archive): one read, and the buttons are offered only to a reader who would pass it.
  if ((recheck || publish) && mayWorkOn(access, task)) {
    const passes = await requireProjectSendBackRole(deps, task, caller).then(() => true, () => false);
    if (!passes) { recheck = false; publish = false; }
  }
  return continueLoopViewOf(deps, task, access, tracked, { publish, recheck });
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
  const host = { name: repository.name, url: repository.url };
  const present = await port.branchHead(task, host, branch);
  // Made at the base, idempotently: a concurrent press that made it first (the host answers "already exists") is the same branch when the host now shows it at the base.
  const make = async (): Promise<boolean> => {
    try {
      await port.createBranch(task, host, branch, existing?.baseSha ?? base);
      return true;
    } catch (error) {
      if (await port.branchHead(task, host, branch).catch(() => undefined) === (existing?.baseSha ?? base)) return false;
      throw error;
    }
  };
  if (existing !== undefined) {
    // Recorded before: the branch is the person's from then on (their pushes move it). Only a branch the host no longer has is made again, at the same base commit.
    const remade = present === undefined ? await make() : false;
    return { repository: repository.name, branch: existing.branch, commit: existing.baseSha, created: remade };
  }
  let created = false;
  if (present === undefined) {
    created = await make();
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

/** What starts a re-check of a head that changed outside Rovara: this install's own start (`startOutsideRecheckRun`), or a stand-in in tests. "STALE": the host shows another head now. */
export type StartOutsideRecheck = (task: DeveloperTaskRecord, input: { requestId: string; repository: string; number: number; headSha: string; actorId: string }) => Promise<"STARTED" | "STALE">;

const STALE_HEAD = "The pull request changed again since you looked. Reload and check the new code.";
const NOT_NOW = "Rovara can re-check once the task is waiting for the merge and nothing of its own is running on the pull request.";

/** One person's Recheck request, kept so a repeat of the same request starts nothing more (and another request ID is not mistaken for it). */
export const outsideRecheckRequestKey = (taskId: string, requestId: string) => ({ pk: `DEVTASK#${taskId}`, sk: `OUTSIDE_RECHECK#${requestId}` });
interface OutsideRecheckRequestRecord { pk: string; sk: string; entityType: "OUTSIDE_RECHECK_REQUEST"; taskId: string; repository: string; number: number; headSha: string; actorId: string; at: string;
  /** How the request ended when it did not end in recorded checks: the head was not taken (`not_adopted`, with the plain reason), or the checks' result went stale. */
  outcome?: OutsideRecheckOutcome; outcomeReason?: string }
export type OutsideRecheckOutcome = "not_adopted" | "stale";
/** The plain reasons a request was not taken, as a repeat of it answers them. */
export const OUTSIDE_RECHECK_NOT_ADOPTED = { moved: "the pull request changed again", unfinished: "the run that takes the code didn't finish" } as const;

/** Records how a person's Recheck request ended without recorded checks, so a repeat of the same request answers that (an update of the request's own row; nothing if it is gone). */
export function outsideRecheckOutcomeItem(tableName: string, taskId: string, requestId: string, outcome: OutsideRecheckOutcome, reason: string, now: string) {
  return { Update: {
    TableName: tableName, Key: outsideRecheckRequestKey(taskId, requestId),
    UpdateExpression: "SET outcome = :outcome, outcomeReason = :reason, outcomeAt = :now", ConditionExpression: "attribute_exists(pk)",
    ExpressionAttributeValues: { ":outcome": outcome, ":reason": reason.slice(0, 300), ":now": now },
  } };
}

/** The operation request ID of the adoption run: one per task, head and person's request, so a retried start is the same run. */
export function outsideRecheckOperationRequestId(taskId: string, headSha: string, requestId: string): string {
  const hex = createHash("sha256").update(`agentx-outside-recheck\n${taskId}\n${headSha}\n${requestId}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/**
 * This install's start of a re-check: a read-only worker run that checks the head the person saw out of the pull request's branch (a maintain run with `workflowAdopt` and a CLONE grant: it can push
 * nothing), committed in one transaction with the workflow's move to WAIT_FOR_MERGE/RUNNING (`adopting`) and the request's record. The acceptance reads GitHub: the head must be exactly the one the
 * person saw (the fence when the run starts), on a record still at Rovara's last head. The workspace takes one run at a time, so a second press (any request) cannot start a second run. Its result
 * (workflow-items.ts completedOutsideAdoptItems) adopts the head and starts the person's checks.
 */
export async function startOutsideRecheckRun(deps: DeveloperTaskRouteDependencies, access: AuthorizedTask, input: { requestId: string; repository: string; number: number; headSha: string }, caller: DeveloperCaller): Promise<"STARTED" | "STALE"> {
  const { task } = access;
  const workflow = task.workflow;
  if (workflow === undefined || deps.outsideRecheckFeatures === undefined) throw agentXError("RUNTIME_UNAVAILABLE", "Re-checking isn't available on this install yet.");
  // A worker that is up and says what it can: one without the adoption is refused here, in plain words (one that is not up yet is checked again when the run is delivered).
  const features = await deps.outsideRecheckFeatures(task);
  if (features !== undefined && !features.includes(OUTSIDE_RECHECK_WORKER_FEATURE)) throw agentXError("RUNTIME_UNAVAILABLE", OUTSIDE_RECHECK_WORKER_MISSING);
  // MONEY: a task with a company spending stop must have a readable stop window before anything runs (the person's checks are admitted against it when they start).
  if (task.spendingStop !== undefined || task.spendingAdmission !== undefined) await requireTaskStopWindowContext(deps, task);
  const now = iso(deps);
  let next: WorkflowSnapshot;
  try {
    // The marker names the person (their developer ID): their checks start later as their own Retry checks, with their live role read again then.
    next = startWorkflowOutsideRecheck(workflow, { repositoryId: input.repository, number: input.number, headSha: input.headSha, requestId: input.requestId, actorId: caller.developerId, now });
  } catch (error) {
    if (error instanceof WorkflowTransitionError) throw agentXError("CONFIG_INVALID", NOT_NOW);
    throw error;
  }
  const record: OutsideRecheckRequestRecord = { ...outsideRecheckRequestKey(task.taskId, input.requestId), entityType: "OUTSIDE_RECHECK_REQUEST", taskId: task.taskId, repository: input.repository, number: input.number, headSha: input.headSha, actorId: access.actorId, at: now };
  try {
    await deps.actions.acceptPullRequestUpdate(developerTaskIdentity(task, deps.orgId), task.workspaceId, {
      requestId: outsideRecheckOperationRequestId(task.taskId, input.headSha, input.requestId), repository: input.repository, pullRequestNumber: input.number, action: "sync",
    }, (operation) => [
      { Update: {
        TableName: deps.tableName, Key: taskKey(task.taskId), UpdateExpression: "SET workflow = :workflow, updatedAt = :now",
        ConditionExpression: "workflow.revision = :revision AND workflow.#stage = :stage AND workflow.#state = :state AND attribute_not_exists(closedAt)",
        ExpressionAttributeNames: { "#stage": "stage", "#state": "state" },
        ExpressionAttributeValues: { ":workflow": next, ":now": now, ":revision": workflow.revision, ":stage": "WAIT_FOR_MERGE", ":state": "WAITING" },
      } },
      { Put: { TableName: deps.tableName, Item: record, ConditionExpression: "attribute_not_exists(pk)" } },
      putNew(turnTable(deps), aiToolTurn({
        party: partyOfTaskActor(task, caller), turnId: randomUUID(), action: "pull_request", phase: "accepted", outcome: "accepted", receivedAt: now, finishedAt: iso(deps),
        request: "Re-check the code pushed to the pull request outside Rovara",
        response: `Rovara is taking pull request #${String(input.number)} on ${input.repository} at its current head as the task's code (operation ${operation.id}); it pushes nothing, and its checks run next.`, operationId: operation.id,
      })),
      accessFence(deps, access),
    ], { adopt: { headCommit: input.headSha, previousHeadCommit: next.outsideRecheck!.previousHeadSha } });
  } catch (error) {
    // GitHub shows another head (or the pull request is not open): nothing starts.
    if (error instanceof AgentXError && error.code === "STALE_FENCE") return "STALE";
    if (error instanceof AgentXError && (error.code === "WORKSPACE_BUSY" || error.code === "WORKSPACE_NOT_READY" || error.code === "CONFIG_INVALID")) {
      // A concurrent press of the same request won the race: it started the one run.
      const won = (await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: record, ConsistentRead: true })) as { Item?: OutsideRecheckRequestRecord }).Item;
      if (won !== undefined && won.headSha === input.headSha && won.actorId === access.actorId) return "STARTED";
      if (error.code === "WORKSPACE_BUSY") throw agentXError("WORKSPACE_BUSY", "Rovara is busy with this task right now. Try Recheck again in a moment.");
    }
    throw error;
  }
  return "STARTED";
}

/**
 * `POST /v1/app/tasks/{id}/continue/recheck`. Every guard a person's own retry of paid work meets comes first, then the head the person saw must still be the one the host shows and still not Rovara's:
 * the work role, the project's send-back access (which includes the archive check: an archived project takes no new work), the task creator's membership and the money gate (a task waiting for more spend
 * is not re-checked at all: a person who may approve it does that first, and nothing is paid for before). Only then is the re-check started. A repeat of the same request starts nothing more.
 * Autonomy does not stop it (the person asked); the person's checks that follow are their own Retry checks, which meet the spend cap, the company's spending stop and the budget wait again.
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
  await requireMayGoOn(deps, caller, task);
  // The company's Admission (trial, machine time, the budget's minimum): refused, nothing starts and the person reads the admission's own words.
  await deps.admitOutsideRecheck?.(task);
  const start: StartOutsideRecheck | undefined = deps.startOutsideRecheck
    ?? (deps.outsideRecheckFeatures === undefined ? undefined : (_task, input) => startOutsideRecheckRun(deps, access, input, caller));
  if (start === undefined) throw agentXError("RUNTIME_UNAVAILABLE", "Re-checking isn't available on this install yet.");
  const audit = () => auditOnce(deps, auditTaskRecheckRequested({ orgId: String(task.orgId), actor: { kind: "member", id: caller.developerId }, occurredAt: iso(deps), occurrence: auditOccurrence(task.taskId, request.requestId), taskId: task.taskId, outcome: "started" }));
  // Idempotent per (task, request): the same request for the same head by the same person is the run it started; anything else under that request ID is refused.
  const prior = (await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: outsideRecheckRequestKey(task.taskId, request.requestId), ConsistentRead: true })) as { Item?: OutsideRecheckRequestRecord }).Item;
  if (prior !== undefined) {
    if (prior.headSha !== request.headSha || prior.repository !== request.repository || prior.number !== request.number || prior.actorId !== access.actorId) throw agentXError("IDEMPOTENCY_CONFLICT", "This request ID was already used for another re-check.");
    // A repeat of a request that ended without recorded checks answers how it ended, not "started".
    if (prior.outcome === "stale") throw agentXError("STALE_FENCE", "The pull request changed again while Rovara was re-checking it, so that result doesn't count. Reload and press Recheck on the new code.");
    if (prior.outcome === "not_adopted") throw agentXError("STALE_FENCE", `Rovara couldn't take that code: ${prior.outcomeReason ?? OUTSIDE_RECHECK_NOT_ADOPTED.unfinished}. Reload and press Recheck again.`);
    await audit();
    return { status: "started" };
  }
  if (workflow.e2e?.required === true) throw agentXError("CONFIG_INVALID", "Rovara can't re-check outside changes on a task with browser or API checks yet. Send the task back instead.");
  if (!recheckPossible(workflow, { repositoryId: request.repository, number: request.number })) throw agentXError("CONFIG_INVALID", NOT_NOW);
  const tracked = (await readMergeTracking(deps, task.taskId, task.orgId)).find((entry) => entry.repositoryId === request.repository && entry.number === request.number);
  if (tracked === undefined || tracked.state !== "open" || tracked.headByRovara) throw agentXError("CONFIG_INVALID", "Nothing changed outside Rovara on that pull request.");
  if (tracked.headSha !== request.headSha) throw agentXError("STALE_FENCE", STALE_HEAD);
  const outcome = await start(task, { requestId: request.requestId, repository: request.repository, number: request.number, headSha: request.headSha, actorId: access.actorId });
  if (outcome === "STALE") throw agentXError("STALE_FENCE", STALE_HEAD);
  await audit();
  return { status: "started" };
}
