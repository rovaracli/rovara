// Review groups (owner decision 9, A-22, DN-5, S-23): who has claimed a task's waiting review. One item per task, under its project's partition (`reviewClaimKey`), with a revision.
//
//   GET  /v1/app/tasks/{t}/review                 anyone who can read the task.
//   POST /v1/app/tasks/{t}/review/claim           an eligible member of one of the project's groups: they hold the review and become its requested reviewer on the code host.
//   POST /v1/app/tasks/{t}/review/release         the holder only: the review goes back to the group.
//   POST /v1/app/tasks/{t}/review/reassign        a maintainer (or an org owner or admin): the review goes to another eligible member of the group.
//
// Rules, each checked on every request from live data:
//   - the task is in the caller's company and they can read it (`TASK_NOT_FOUND` otherwise, the same as a missing task);
//   - a claim or reassign needs a pull request that waits for review (open, out of draft, not approved, no changes asked, the task waiting for its merge) and names the review's key
//     (a digest of those pull requests and their heads) and the claim's revision: anything that moved under the caller is `CHANGE_STALE`;
//   - group membership is the stored group AND a live contributor or maintainer role in the project; a holder who lost either has given the review back (read as unclaimed,
//     `returned`), and anyone in the group may claim it;
//   - the task's own owner does not review it unless the project allows self-approval;
//   - the holder needs a linked GitHub account: the claim asks the code host, through the project's own code host port (`CodeHost.requestReviewers`, the call merge tracking makes
//     when a pull request becomes ready), to list them as a requested reviewer.
//
// A CLAIM NEVER GRANTS APPROVAL. Nothing in the merge (`rovara-code/merge.ts`, `approval.ts`, `code-owners.ts`) reads this item: an approval still has to come from the code host, from
// someone it allows, and a CODEOWNERS file still needs a code owner.
//
// The write and its audit event are one transaction, conditioned on the revision read. The code host is asked AFTER the write (so a lost race never leaves a stray request on the host);
// the item says `hostSync: pending` until then, and a repeat of the same request (same request id) asks the host again while it is `pending` or `unavailable`. Releasing does not take
// the request off the host: the code host port has no call for that yet (owed upstream), so the person stays listed there until someone else is asked or they review.
import { createHash } from "node:crypto";
import { GetCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { agentXError, projectAllows, type OrgId, type ProjectRole } from "@rovara-code/contracts";
import {
  REVIEW_AGE_NUDGE_HOURS, REVIEW_CLAIM_APPROVAL_NOTE, REVIEW_GROUP_MESSAGES as W, ReviewClaimBodySchema, ReviewReassignBodySchema, ReviewReleaseBodySchema, reviewClaimKey,
  type MergeTrackingItem, type ReviewClaimAction, type ReviewHostSync, type TaskReviewView,
} from "@agentx/cloud-contracts";
import type { z } from "zod";
import { auditOccurrence, auditReviewClaimChanged } from "../audit/events.js";
import { flushAuditEvents } from "../audit/flush.js";
import { auditPending, tryAuditEvents } from "../audit/outbox.js";
import { auditActorOf } from "../audit/plan3-hooks.js";
import { UNREADABLE_GROUPS, mayReview, readReviewGroups, type ReviewCaller, type ReviewGroupsDeps, type StoredGroup } from "./groups.js";

const HOUR_MS = 3_600_000;

/** What the claim routes need of a task: only these fields. */
export interface ReviewTask {
  taskId: string;
  orgId: OrgId;
  project: string;
  /** The project revision the task pinned: the repositories (and their code host) are read as of it. */
  startingRevision?: number | undefined;
  closedAt?: string | undefined;
  workflow?: { stage: string; state: string } | undefined;
}

export interface ReviewClaimDeps extends ReviewGroupsDeps {
  /** The task, when the caller can read it, with the ids of its owner (as the task access rule gives them); `TASK_NOT_FOUND` otherwise (also for another company's task). */
  taskFor(caller: ReviewCaller, taskId: string): Promise<{ task: ReviewTask; ownerIds: readonly string[] }>;
  /** The task's merge tracking items (what the code host last said about each pull request). */
  readTracking(taskId: string, orgId: OrgId): Promise<MergeTrackingItem[]>;
  /** Whether the project lets a person approve their own task's pull request (code settings). */
  allowSelfApproval(orgId: OrgId, project: string): Promise<boolean>;
  /** The login of the GitHub account the member linked, or undefined. */
  githubLoginOf(orgId: OrgId, developerId: string): Promise<string | undefined>;
  /** Asks the code host to list `login` as a requested reviewer of one pull request, through the project's code host port. */
  requestReviewer(task: ReviewTask, pullRequest: { repositoryId: string; number: number }, login: string): Promise<"requested" | "refused" | "unavailable">;
  log?(event: string, fields: Record<string, unknown>): void;
}

interface StoredClaim {
  exists: boolean;
  revision: number;
  holder?: string;
  groupId?: string;
  claimedAt?: string;
  hostSync?: ReviewHostSync;
  lastRequestId?: string;
  lastRequestDigest?: string;
}

const isPerson = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
const HOST_SYNC = new Set<string>(["requested", "refused", "pending", "unavailable"]);

async function readClaim(deps: Pick<ReviewClaimDeps, "documentClient" | "tableName">, orgId: OrgId, project: string, taskId: string): Promise<StoredClaim> {
  const found = await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: reviewClaimKey(orgId, project, taskId), ConsistentRead: true })) as { Item?: Record<string, unknown> };
  const item = found.Item;
  if (item === undefined) return { exists: false, revision: 0 };
  const revision = item["revision"];
  // An item of another company or task, or one whose revision does not read, fails closed: nobody can change it here.
  if (item["orgId"] !== orgId || item["taskId"] !== taskId || typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 1) throw agentXError("CONFIG_INVALID", "The stored review claim could not be read.");
  const holder = isPerson(item["holder"]) && typeof item["groupId"] === "string" && typeof item["claimedAt"] === "string" ? item["holder"] : undefined;
  return {
    exists: true, revision,
    ...(holder === undefined ? {} : { holder, groupId: item["groupId"] as string, claimedAt: item["claimedAt"] as string, hostSync: (HOST_SYNC.has(String(item["hostSync"])) ? item["hostSync"] : "pending") as ReviewHostSync }),
    ...(typeof item["lastRequestId"] === "string" ? { lastRequestId: item["lastRequestId"] } : {}),
    ...(typeof item["lastRequestDigest"] === "string" ? { lastRequestDigest: item["lastRequestDigest"] } : {}),
  };
}

/** The pull requests of the task that wait for review now. A task that is closed or not waiting for its merge has none. */
export function waitingPullRequests(task: ReviewTask, items: readonly MergeTrackingItem[]): MergeTrackingItem[] {
  if (task.closedAt !== undefined || task.workflow?.stage !== "WAIT_FOR_MERGE") return [];
  return items.filter((item) => item.orgId === task.orgId && item.taskId === task.taskId && item.state === "open" && !item.draft && (item.review === "requested" || item.review === "not_requested"))
    .sort((a, b) => a.repositoryId.localeCompare(b.repositoryId) || a.number - b.number);
}

/** The review's key: the waiting pull requests and their heads. A push, a new pull request or one that stops waiting changes it. */
export function reviewKeyOf(waiting: readonly MergeTrackingItem[]): string {
  return createHash("sha256").update(JSON.stringify(waiting.map((item) => [item.repositoryId, item.number, item.headSha])), "utf8").digest("hex");
}

const waitingSinceOf = (item: MergeTrackingItem): number | undefined => {
  const stamp = item.reviewersRequestedAt ?? item.readyAt;
  const at = stamp === undefined ? Number.NaN : Date.parse(stamp);
  return Number.isFinite(at) ? at : undefined;
};

/** The holder, if they still hold it: in the stored group, and a live contributor or maintainer of the project. */
function liveHolder(claim: StoredClaim, groups: readonly StoredGroup[], roles: ReadonlyMap<string, ProjectRole | undefined>): { holder: string; group: StoredGroup } | undefined {
  if (claim.holder === undefined) return undefined;
  const group = groups.find((entry) => entry.groupId === claim.groupId);
  if (group === undefined || !group.members.includes(claim.holder) || !mayReview(roles.get(claim.holder))) return undefined;
  return { holder: claim.holder, group };
}

interface Situation {
  task: ReviewTask;
  ownerIds: readonly string[];
  groups: StoredGroup[];
  claim: StoredClaim;
  waiting: MergeTrackingItem[];
  callerRole: ProjectRole | undefined;
  held: { holder: string; group: StoredGroup } | undefined;
  roles: Map<string, ProjectRole | undefined>;
}

async function situation(deps: ReviewClaimDeps, caller: ReviewCaller, taskId: string): Promise<Situation> {
  const { task, ownerIds } = await deps.taskFor(caller, taskId);
  if (task.orgId !== caller.orgId) throw agentXError("TASK_NOT_FOUND", "no task here that you can see");
  const stored = await readReviewGroups(deps, caller.orgId, task.project);
  if (stored === "unreadable") throw agentXError("CONFIG_INVALID", UNREADABLE_GROUPS);
  const [claim, items, callerRole] = await Promise.all([readClaim(deps, caller.orgId, task.project, task.taskId), deps.readTracking(task.taskId, caller.orgId), deps.liveProjectRole(caller.orgId, task.project, caller.developerId)]);
  const roles = new Map<string, ProjectRole | undefined>([[caller.developerId, callerRole]]);
  if (claim.holder !== undefined && !roles.has(claim.holder)) roles.set(claim.holder, await deps.liveProjectRole(caller.orgId, task.project, claim.holder));
  return { task, ownerIds, groups: stored.groups, claim, waiting: waitingPullRequests(task, items), callerRole, roles, held: liveHolder(claim, stored.groups, roles) };
}

async function viewOf(deps: ReviewClaimDeps, caller: ReviewCaller, s: Situation): Promise<TaskReviewView> {
  const now = deps.now();
  const sinces = s.waiting.map(waitingSinceOf).filter((at): at is number => at !== undefined);
  const since = sinces.length === 0 ? undefined : Math.min(...sinces);
  const ageHours = since === undefined ? undefined : Math.max(0, Math.floor((now - since) / HOUR_MS));
  const callerEligible = mayReview(s.callerRole);
  const claimable = callerEligible ? s.groups.filter((group) => group.members.includes(caller.developerId)) : [];
  const ownTaskBlocked = s.ownerIds.includes(caller.developerId) && !await deps.allowSelfApproval(caller.orgId, s.task.project);
  const waiting = s.waiting.length > 0;
  return {
    waiting,
    ...(waiting ? { reviewKey: reviewKeyOf(s.waiting) } : {}),
    pullRequests: s.waiting.slice(0, 20).map((item) => {
      const at = waitingSinceOf(item);
      return { repositoryId: item.repositoryId, number: item.number, ...(at === undefined ? {} : { waitingSince: new Date(at).toISOString() }) };
    }),
    ...(since === undefined ? {} : { waitingSince: new Date(since).toISOString() }),
    aged: ageHours !== undefined && ageHours >= REVIEW_AGE_NUDGE_HOURS,
    ...(ageHours === undefined ? {} : { ageHours }),
    revision: s.claim.revision,
    ...(s.held === undefined ? {} : {
      claim: {
        developerId: s.held.holder, name: await deps.nameOf(caller.orgId, s.held.holder), groupId: s.held.group.groupId, groupName: s.held.group.name,
        claimedAt: s.claim.claimedAt!, hostSync: s.claim.hostSync ?? "pending",
      },
    }),
    ...(s.claim.holder !== undefined && s.held === undefined ? { returned: true as const } : {}),
    claimableGroups: claimable.map((group) => ({ groupId: group.groupId, name: group.name })),
    canClaim: waiting && claimable.length > 0 && s.held === undefined && !ownTaskBlocked,
    canRelease: s.held?.holder === caller.developerId,
    canReassign: waiting && s.callerRole !== undefined && projectAllows(s.callerRole, "manage_members") && s.groups.length > 0,
    approvalNote: REVIEW_CLAIM_APPROVAL_NOTE,
  };
}

/** `GET /v1/app/tasks/{t}/review`: anyone who can read the task. */
export async function getTaskReview(deps: ReviewClaimDeps, caller: ReviewCaller, taskId: string): Promise<TaskReviewView> {
  return viewOf(deps, caller, await situation(deps, caller, taskId));
}

function parse<T>(schema: z.ZodType<T>, raw: unknown): T {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue === undefined || issue.path.length === 0 ? "body" : issue.path.join(".");
    throw agentXError("CONFIG_INVALID", `${path}: ${issue === undefined || issue.code === "unrecognized_keys" ? "has a field this route does not take" : issue.message}`);
  }
  return parsed.data;
}

const digestOf = (action: ReviewClaimAction, body: Record<string, unknown>): string => {
  const { requestId: _requestId, ...rest } = body; // eslint-disable-line @typescript-eslint/no-unused-vars -- the id is the key, not part of the request's digest
  return createHash("sha256").update(JSON.stringify([action, Object.keys(rest).sort().map((key) => [key, rest[key]])]), "utf8").digest("hex");
};

const isConditional = (error: unknown): boolean => error instanceof Error && (error.name === "ConditionalCheckFailedException" || error.name === "TransactionCanceledException");

/** Asks the code host to list the holder on every waiting pull request. All asked: `requested`; any refused: `refused`; otherwise `unavailable`. Never throws. */
async function askHost(deps: ReviewClaimDeps, task: ReviewTask, waiting: readonly MergeTrackingItem[], login: string): Promise<ReviewHostSync> {
  let outcome: ReviewHostSync = "requested";
  for (const item of waiting) {
    const answer = await deps.requestReviewer(task, { repositoryId: item.repositoryId, number: item.number }, login).catch((error: unknown) => {
      deps.log?.("review_claim.host_failed", { taskId: task.taskId, error: error instanceof Error ? error.name : "unknown" });
      return "unavailable" as const;
    });
    if (answer === "refused") outcome = "refused";
    else if (answer === "unavailable" && outcome === "requested") outcome = "unavailable";
  }
  return outcome;
}

/** Records what the code host said, only while the claim is still the one just written. */
async function noteHostSync(deps: ReviewClaimDeps, orgId: OrgId, project: string, taskId: string, revision: number, holder: string, hostSync: ReviewHostSync): Promise<void> {
  await deps.documentClient.send(new UpdateCommand({
    TableName: deps.tableName, Key: reviewClaimKey(orgId, project, taskId), UpdateExpression: "SET hostSync = :sync",
    ConditionExpression: "#revision = :revision AND holder = :holder", ExpressionAttributeNames: { "#revision": "revision" },
    ExpressionAttributeValues: { ":sync": hostSync, ":revision": revision, ":holder": holder },
  })).catch((error: unknown) => { if (!isConditional(error)) throw error; });
}

interface Change { change: "claimed" | "released" | "reassigned"; holder?: string; groupId: string; requestId: string; digest: string }

/** One transaction: the claim item at the next revision (conditioned on the one read) and its audit event. */
async function writeClaim(deps: ReviewClaimDeps, caller: ReviewCaller, s: Situation, change: Change): Promise<number> {
  const revision = s.claim.revision + 1;
  const at = new Date(deps.now()).toISOString();
  const events = await tryAuditEvents(deps, () => [auditReviewClaimChanged({
    orgId: caller.orgId, actor: auditActorOf(caller.developerId), occurredAt: at, occurrence: auditOccurrence(s.task.taskId, String(revision)),
    taskId: s.task.taskId, change: change.change, revision, groupId: change.groupId, pullRequests: s.waiting.length, hostSync: change.holder === undefined ? "none" : "pending", holder: change.holder,
  })]);
  const item = {
    ...reviewClaimKey(caller.orgId, s.task.project, s.task.taskId), entityType: "REVIEW_CLAIM", orgId: caller.orgId, taskId: s.task.taskId, project: s.task.project, revision,
    ...(change.holder === undefined ? {} : { holder: change.holder, groupId: change.groupId, claimedAt: at, hostSync: "pending", reviewKey: reviewKeyOf(s.waiting) }),
    lastAction: change.change, lastRequestId: change.requestId, lastRequestDigest: change.digest, updatedAt: at, updatedBy: caller.developerId,
  };
  try {
    await deps.documentClient.send(new TransactWriteCommand({ TransactItems: [
      { Put: {
        TableName: deps.tableName, Item: item,
        ...(s.claim.exists
          ? { ConditionExpression: "#revision = :expected", ExpressionAttributeNames: { "#revision": "revision" }, ExpressionAttributeValues: { ":expected": s.claim.revision } }
          : { ConditionExpression: "attribute_not_exists(pk)" }),
      } },
      ...events.flatMap((event) => auditPending(deps, event)),
    ] }));
  } catch (error) {
    if (isConditional(error)) throw agentXError("CHANGE_STALE", W.stale);
    throw error;
  }
  await flushAuditEvents(deps, events);
  return revision;
}

/** A repeat of the last request: the same answer, and (for a claim or reassign whose host request did not go through) the host is asked again. Another body under the same id is refused. */
async function replay(deps: ReviewClaimDeps, caller: ReviewCaller, s: Situation, digest: string): Promise<TaskReviewView> {
  if (s.claim.lastRequestDigest !== digest) throw agentXError("CONFIG_INVALID", W.requestReused);
  if (s.held !== undefined && (s.claim.hostSync === "pending" || s.claim.hostSync === "unavailable") && s.waiting.length > 0) {
    const login = await deps.githubLoginOf(caller.orgId, s.held.holder);
    if (login !== undefined) {
      const sync = await askHost(deps, s.task, s.waiting, login);
      await noteHostSync(deps, caller.orgId, s.task.project, s.task.taskId, s.claim.revision, s.held.holder, sync);
    }
  }
  return getTaskReview(deps, caller, s.task.taskId);
}

/** The checks shared by claim and reassign: something waits, under the key named; the revision named is the one stored. */
function requireFresh(s: Situation, body: { expectedRevision: number; reviewKey: string }): void {
  if (body.expectedRevision !== s.claim.revision) throw agentXError("CHANGE_STALE", W.stale);
  if (s.waiting.length === 0) throw agentXError("CONFIG_INVALID", W.notWaiting);
  if (body.reviewKey !== reviewKeyOf(s.waiting)) throw agentXError("CHANGE_STALE", W.stale);
}

/** `POST .../review/claim`. */
export async function claimReview(deps: ReviewClaimDeps, caller: ReviewCaller, taskId: string, raw: unknown): Promise<TaskReviewView> {
  const s = await situation(deps, caller, taskId);
  const body = parse(ReviewClaimBodySchema, raw);
  const digest = digestOf("claim", body);
  if (s.claim.lastRequestId === body.requestId) return replay(deps, caller, s, digest);
  if (!mayReview(s.callerRole)) throw agentXError("FORBIDDEN", W.notInGroup);
  const group = s.groups.find((entry) => entry.groupId === body.groupId);
  if (group === undefined) throw agentXError("CONFIG_INVALID", W.noGroup);
  if (!group.members.includes(caller.developerId)) throw agentXError("FORBIDDEN", W.notInGroup);
  requireFresh(s, body);
  if (s.ownerIds.includes(caller.developerId) && !await deps.allowSelfApproval(caller.orgId, s.task.project)) throw agentXError("FORBIDDEN", W.ownTask);
  if (s.held !== undefined) {
    if (s.held.holder === caller.developerId && s.held.group.groupId === group.groupId) return viewOf(deps, caller, s);
    throw agentXError("CHANGE_STALE", s.held.holder === caller.developerId ? W.stale : W.alreadyClaimed);
  }
  const login = await deps.githubLoginOf(caller.orgId, caller.developerId);
  if (login === undefined) throw agentXError("CONFIG_INVALID", W.linkGithub);
  const revision = await writeClaim(deps, caller, s, { change: "claimed", holder: caller.developerId, groupId: group.groupId, requestId: body.requestId, digest });
  await noteHostSync(deps, caller.orgId, s.task.project, s.task.taskId, revision, caller.developerId, await askHost(deps, s.task, s.waiting, login));
  return getTaskReview(deps, caller, taskId);
}

/** `POST .../review/release`: the holder gives the review back to the group. */
export async function releaseReview(deps: ReviewClaimDeps, caller: ReviewCaller, taskId: string, raw: unknown): Promise<TaskReviewView> {
  const s = await situation(deps, caller, taskId);
  const body = parse(ReviewReleaseBodySchema, raw);
  const digest = digestOf("release", body);
  if (s.claim.lastRequestId === body.requestId) return replay(deps, caller, s, digest);
  if (body.expectedRevision !== s.claim.revision) throw agentXError("CHANGE_STALE", W.stale);
  if (s.held === undefined) throw agentXError("CONFIG_INVALID", W.nothingToRelease);
  if (s.held.holder !== caller.developerId) throw agentXError("FORBIDDEN", W.notHolder);
  await writeClaim(deps, caller, s, { change: "released", groupId: s.held.group.groupId, requestId: body.requestId, digest });
  return getTaskReview(deps, caller, taskId);
}

/** `POST .../review/reassign`: a maintainer gives the review to another eligible member of the group (the claim's group, when it is held). */
export async function reassignReview(deps: ReviewClaimDeps, caller: ReviewCaller, taskId: string, raw: unknown): Promise<TaskReviewView> {
  const s = await situation(deps, caller, taskId);
  const body = parse(ReviewReassignBodySchema, raw);
  const digest = digestOf("reassign", body);
  if (s.claim.lastRequestId === body.requestId) return replay(deps, caller, s, digest);
  if (s.callerRole === undefined || !projectAllows(s.callerRole, "manage_members")) throw agentXError("FORBIDDEN", W.reassignMaintainers);
  const group = s.groups.find((entry) => entry.groupId === body.groupId);
  if (group === undefined) throw agentXError("CONFIG_INVALID", W.noGroup);
  requireFresh(s, body);
  if (s.held !== undefined && s.held.group.groupId !== group.groupId) throw agentXError("CHANGE_STALE", W.stale);
  if (!group.members.includes(body.to) || !mayReview(await deps.liveProjectRole(caller.orgId, s.task.project, body.to))) throw agentXError("CONFIG_INVALID", W.targetNotInGroup);
  if (s.ownerIds.includes(body.to) && !await deps.allowSelfApproval(caller.orgId, s.task.project)) throw agentXError("CONFIG_INVALID", W.targetOwnTask);
  if (s.held?.holder === body.to) return viewOf(deps, caller, s);
  const login = await deps.githubLoginOf(caller.orgId, body.to);
  if (login === undefined) throw agentXError("CONFIG_INVALID", W.targetNoGithub);
  const revision = await writeClaim(deps, caller, s, { change: "reassigned", holder: body.to, groupId: group.groupId, requestId: body.requestId, digest });
  await noteHostSync(deps, caller.orgId, s.task.project, s.task.taskId, revision, body.to, await askHost(deps, s.task, s.waiting, login));
  return getTaskReview(deps, caller, taskId);
}
