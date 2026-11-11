// Rovara Code (Plan 6 Task 14): finding the task a check or status delivery is about. Such a delivery names a commit, not a pull request, so Rovara keeps a small index
// from (org, repository, commit) to the task (`prHeadKey`), written wherever it records a pull request's head, and one from the Rovara branch the pull request is on. The
// index is only a lead: the installation's org, the task, the pull request recorded in its workflow, the link of that pull request to the task and the project's pinned
// repository all have to agree before anything is woken.
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { OrgIdSchema, TRACKING_REVIEW_COALESCE_SECONDS, prHeadKey, type CodeHostEvent, type OrgId, type PluginKind } from "@rovara-code/contracts";
import { githubInstallationKey } from "@agentx/cloud-contracts";
import type { HeadWebhookEvent, PullRequestWebhookEvent } from "../aws/github-webhooks.js";
import { wakeTrackingRow } from "../aws/workflow-merge-recovery.js";
import { codeHostRepositoryKey } from "../plugins/events/repository-key.js";
import { findLinkedChangeRequest } from "./linked-change-requests.js";
import { tracksMerge, type TrackedTask } from "./merge-tracking.js";
export { prHeadItems } from "./head-index.js";

export interface HeadEventDependencies {
  documentClient: { send(command: unknown): Promise<unknown> };
  tableName: string;
  /** The org the installation is bound to and active in (a cloud install), or the install's single org; undefined when there is none. */
  orgOfInstallation(installationId: number): Promise<OrgId | undefined>;
  loadTask(taskId: string): Promise<TrackedTask | undefined>;
  repositoryUrl(project: string, revision: number, repositoryId: string, orgId: OrgId): Promise<string | undefined>;
  /** The App's own check that the installation, the repository id and the name agree for this repository. */
  verifyRepository(repositoryUrl: string, scope: { installationId: number; repositoryId: number; fullName: string }): Promise<boolean>;
  now: () => number;
}

export interface FollowedHead {
  taskId: string;
  orgId: OrgId;
  repositoryId: string;
  number: number;
}

async function indexed(deps: Pick<HeadEventDependencies, "documentClient" | "tableName">, orgId: OrgId, fullName: string, key: string): Promise<Record<string, unknown> | undefined> {
  // A key the index cannot hold (a "#" or a control character in a branch name) is no lead.
  if (key.includes("#") || /[\p{Cc}\p{Cf}]/u.test(key)) return undefined;
  const found = await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: prHeadKey(orgId, fullName, key), ConsistentRead: true })) as { Item?: Record<string, unknown> };
  return found.Item;
}

/**
 * The task a check or status event is about, or undefined. The lead is the index item of the commit, else of the branch; the installation must be bound to the org the lead
 * names; the task must be that org's, be a tracked task whose workflow holds that pull request, the pull request's link must name the task, and the project's pinned
 * repository must be the one GitHub's delivery came for. Any disagreement is "no task": a delivery never reaches across orgs.
 */
export async function resolveHeadEventTask(
  deps: HeadEventDependencies,
  event: Pick<HeadWebhookEvent, "installationId" | "repositoryId" | "fullName" | "headSha" | "branch">,
  /** `verifyRepository: false` skips the App's own check (one GitHub read) for a delivery that was verified moments ago, at receive; the project's pinned repository is still compared by name. */
  options: { verifyRepository?: boolean } = {},
): Promise<FollowedHead | undefined> {
  const orgId = await deps.orgOfInstallation(event.installationId);
  if (orgId === undefined) return undefined;
  const fullName = event.fullName.toLowerCase();
  const lead = await indexed(deps, orgId, fullName, event.headSha) ?? (event.branch === undefined ? undefined : await indexed(deps, orgId, fullName, `branch:${event.branch}`));
  if (lead === undefined || lead["orgId"] !== orgId || typeof lead["taskId"] !== "string" || typeof lead["repositoryId"] !== "string" || typeof lead["number"] !== "number") return undefined;
  const followed = await followedPullRequest(deps, orgId, fullName, { taskId: lead["taskId"], repositoryId: lead["repositoryId"], number: lead["number"] });
  if (followed === undefined) return undefined;
  if (options.verifyRepository !== false && !await deps.verifyRepository(followed.repositoryUrl, { installationId: event.installationId, repositoryId: event.repositoryId, fullName })) return undefined;
  return { taskId: followed.taskId, orgId, repositoryId: followed.repositoryId, number: followed.number };
}

/**
 * The agreement every wake needs, whatever named the pull request (a commit's index lead or the pull request itself): the task is the org's, tracks its merge and is not finished,
 * its workflow holds the pull request, the pull request's link names the task, and the project's pinned repository is the one the delivery came for.
 */
async function followedPullRequest(
  deps: HeadEventDependencies, orgId: OrgId, fullName: string, lead: { taskId: string; repositoryId: string; number: number },
): Promise<{ taskId: string; repositoryId: string; number: number; repositoryUrl: string } | undefined> {
  return followedChangeRequest(deps, orgId, { hostKind: "github", repositoryAddress: `https://github.com/${fullName}` }, lead);
}

/** What a wake needs, whichever code host the event came from: no installation, no GitHub read. */
export type FollowedDependencies = Pick<HeadEventDependencies, "documentClient" | "tableName" | "loadTask" | "repositoryUrl">;

/**
 * The agreement every wake needs, for any code host (P6; `followedPullRequest` is this for GitHub): the task is the org's, tracks its merge and is not finished, its workflow holds the change
 * request, the change request's link names the task (the neutral row, else for GitHub the old one), and the project's pinned repository is the one the event came for. The repository
 * is compared by its neutral key, so a spelling of the same address (case, `.git`) still matches and another repository never does.
 */
export async function followedChangeRequest(
  deps: FollowedDependencies, orgId: OrgId, repository: { hostKind: PluginKind; repositoryAddress: string }, lead: { taskId: string; repositoryId: string; number: number },
): Promise<{ taskId: string; repositoryId: string; number: number; repositoryUrl: string } | undefined> {
  const task = await deps.loadTask(lead.taskId);
  if (task === undefined || task.orgId !== orgId || !tracksMerge(task.workflow) || task.closedAt !== undefined || task.releasedAt !== undefined) return undefined;
  const recorded = task.workflow.pullRequests?.find((pr) => pr.repositoryId === lead.repositoryId && pr.number === lead.number);
  if (recorded === undefined) return undefined;
  const linked = await findLinkedChangeRequest({ documentClient: deps.documentClient, tableName: deps.tableName }, { ...repository, id: String(recorded.number) });
  if (linked === undefined || linked.taskId !== task.taskId || linked.repositoryId !== recorded.repositoryId || linked.url !== recorded.url) return undefined;
  const url = await deps.repositoryUrl(task.project, task.startingRevision, recorded.repositoryId, orgId);
  if (url === undefined) return undefined;
  const pinned = codeHostRepositoryKey(repository.hostKind, url);
  if (pinned === undefined || pinned !== codeHostRepositoryKey(repository.hostKind, repository.repositoryAddress)) return undefined;
  return { taskId: task.taskId, repositoryId: recorded.repositoryId, number: recorded.number, repositoryUrl: url };
}

/**
 * Wakes the followed task's tracking row for a delivery. The delivery is re-resolved here, under its lease, not trusted from when it was received: the org's binding, the task,
 * the link and the pinned repository's name are read again. The App's own repository check (a GitHub read) was made when the delivery was received, and is made again by the
 * recovery sweep before it retries a delivery, so it is not repeated for every delivery of a CI run's many jobs.
 */
export async function wakeFromHeadEvent(deps: HeadEventDependencies, event: HeadWebhookEvent): Promise<"woken" | "none" | "unfollowed"> {
  const followed = await resolveHeadEventTask(deps, event, { verifyRepository: false });
  if (followed === undefined) return "unfollowed";
  return wakeTrackingRow({ documentClient: deps.documentClient, tableName: deps.tableName, now: deps.now }, followed.taskId);
}

/** The pull request actions that change what a tracking pass reads: a review is given, edited or dismissed; a draft is made ready; a push; a reopening. */
const PULL_REQUEST_WAKE_ACTIONS: ReadonlySet<string> = new Set(["ready_for_review", "synchronize", "reopened"]);

/**
 * Whether a pull request delivery should wake the tracking row. A `pull_request_review` delivery (submitted, edited or dismissed) arrives as a PR_COMMENT whose comment is the review;
 * the three pull request actions are the ones a check or status event does not already announce (a draft made ready, a push with no CI, a reopening).
 */
export function wakesTrackingRow(event: PullRequestWebhookEvent): boolean {
  if (event.installationId <= 0) return false;
  if (event.kind === "PR_COMMENT") return event.comment?.source === "review";
  return PULL_REQUEST_WAKE_ACTIONS.has(event.action);
}

/**
 * Wakes the tracking row of the task a pull request delivery is about, so the pass that follows reads the reviews (and the rest) from GitHub within seconds, not at the heartbeat.
 * Nothing in the body is believed: the task is found by the pull request's own link, the installation's org, the task's workflow and the project's pinned repository, read again
 * here, and the pass reads the reviews and the reviewers' permissions itself. A redelivery wakes again, which `wakeTrackingRow` coalesces into one pass.
 */
export async function wakeFromPullRequestEvent(deps: HeadEventDependencies, event: PullRequestWebhookEvent): Promise<"woken" | "none" | "unfollowed"> {
  if (!wakesTrackingRow(event)) return "unfollowed";
  const orgId = await deps.orgOfInstallation(event.installationId);
  if (orgId === undefined) return "unfollowed";
  const fullName = event.fullName.toLowerCase();
  const linked = await findLinkedChangeRequest(deps, { hostKind: "github", repositoryAddress: `https://github.com/${fullName}`, id: String(event.number) });
  if (linked === undefined) return "unfollowed";
  const followed = await followedPullRequest(deps, orgId, fullName, { taskId: linked.taskId, repositoryId: linked.repositoryId, number: linked.number });
  if (followed === undefined) return "unfollowed";
  // A person's review is waited for: its wake is due in `TRACKING_REVIEW_COALESCE_SECONDS`. The other actions keep the longer coalesce (a push's events, a draft made ready).
  return wakeTrackingRow({ documentClient: deps.documentClient, tableName: deps.tableName, now: deps.now }, followed.taskId,
    event.kind === "PR_COMMENT" ? { coalesceSeconds: TRACKING_REVIEW_COALESCE_SECONDS } : {});
}

/** The org a GitHub App installation is bound to, when the binding is there and active; read fresh each time (a disconnect, an uninstall or a suspension stops the next delivery's match). */
export async function boundInstallationOrg(deps: Pick<HeadEventDependencies, "documentClient" | "tableName">, installationId: number): Promise<OrgId | undefined> {
  const found = await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: githubInstallationKey(installationId), ConsistentRead: true })) as { Item?: { orgId?: unknown; status?: unknown } };
  const org = OrgIdSchema.safeParse(found.Item?.orgId);
  return org.success && found.Item?.status === "active" ? org.data : undefined;
}

// ---- P6: the same wake, from a neutral code host event

/** What the neutral wake reads: the same task and link reads, and the clock. The org the event belongs to is the caller's (the host's own binding), never taken from the event. */
export type CodeHostWakeDependencies = FollowedDependencies & Pick<HeadEventDependencies, "now">;

const CHANGE_REQUEST_ID = /^[1-9][0-9]{0,9}$/;

/**
 * Wakes the tracking row of the task a neutral event is about, so the pass that follows reads the change request from its host within seconds. Nothing in the event is believed beyond which
 * change request or commit to look at: the task is found by the change request's own link (or, for a check or a push, by the head index), and the org, the task, its workflow and the project's pinned
 * repository are read again here. `orgId` is the org the host's binding names for this delivery; an event is "unfollowed" unless every one of those agrees.
 *  - opened: nothing to wake (the row is made when the change request is published). updated, merged, closed, a comment: a pass is due. A review: due sooner, as a person's review is waited for.
 *  - a check or a push names a commit (and a push a branch): the head index says which change request, as for GitHub's check and status events.
 */
export async function wakeFromCodeHostEvent(deps: CodeHostWakeDependencies, event: CodeHostEvent, orgId: OrgId): Promise<"woken" | "none" | "unfollowed"> {
  const wake = (taskId: string, options: { coalesceSeconds?: number } = {}) => wakeTrackingRow({ documentClient: deps.documentClient, tableName: deps.tableName, now: deps.now }, taskId, options);
  if (event.type === "change_request.opened") return "none";
  if (event.type === "check.completed" || event.type === "revision.pushed") {
    const repositoryKey = codeHostRepositoryKey(event.host, event.repository.url);
    if (repositoryKey === undefined) return "unfollowed";
    const lead = await indexed(deps, orgId, repositoryKey, event.revision)
      ?? (event.type === "revision.pushed" ? await indexed(deps, orgId, repositoryKey, `branch:${event.branch}`) : undefined);
    if (lead === undefined || lead["orgId"] !== orgId || typeof lead["taskId"] !== "string" || typeof lead["repositoryId"] !== "string" || typeof lead["number"] !== "number") return "unfollowed";
    const followed = await followedChangeRequest(deps, orgId, { hostKind: event.host, repositoryAddress: event.repository.url }, { taskId: lead["taskId"], repositoryId: lead["repositoryId"], number: lead["number"] });
    return followed === undefined ? "unfollowed" : wake(followed.taskId);
  }
  if (!CHANGE_REQUEST_ID.test(event.ref.id)) return "unfollowed";
  const linked = await findLinkedChangeRequest(deps, { hostKind: event.host, repositoryAddress: event.ref.repository.url, id: event.ref.id });
  if (linked === undefined) return "unfollowed";
  const followed = await followedChangeRequest(deps, orgId, { hostKind: event.host, repositoryAddress: event.ref.repository.url }, { taskId: linked.taskId, repositoryId: linked.repositoryId, number: linked.number });
  if (followed === undefined) return "unfollowed";
  return wake(followed.taskId, event.type === "review.submitted" ? { coalesceSeconds: TRACKING_REVIEW_COALESCE_SECONDS } : {});
}
