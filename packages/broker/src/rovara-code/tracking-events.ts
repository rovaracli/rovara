// Rovara Code (Plan 6 Task 14): finding the task a check or status delivery is about. Such a delivery names a commit, not a pull request, so Rovara keeps a small index
// from (org, repository, commit) to the task (`prHeadKey`), written wherever it records a pull request's head, and one from the Rovara branch the pull request is on. The
// index is only a lead: the installation's org, the task, the pull request recorded in its workflow, the link of that pull request to the task and the project's pinned
// repository all have to agree before anything is woken.
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { prHeadKey, type OrgId } from "@agentx/contracts";
import { findLinkedGithubWorkflowPullRequest, type HeadWebhookEvent } from "../aws/github-webhooks.js";
import { wakeTrackingRow } from "../aws/workflow-merge-recovery.js";
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

async function indexed(deps: HeadEventDependencies, orgId: OrgId, fullName: string, key: string): Promise<Record<string, unknown> | undefined> {
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
export async function resolveHeadEventTask(deps: HeadEventDependencies, event: Pick<HeadWebhookEvent, "installationId" | "repositoryId" | "fullName" | "headSha" | "branch">): Promise<FollowedHead | undefined> {
  const orgId = await deps.orgOfInstallation(event.installationId);
  if (orgId === undefined) return undefined;
  const fullName = event.fullName.toLowerCase();
  const lead = await indexed(deps, orgId, fullName, event.headSha) ?? (event.branch === undefined ? undefined : await indexed(deps, orgId, fullName, `branch:${event.branch}`));
  if (lead === undefined || lead["orgId"] !== orgId || typeof lead["taskId"] !== "string" || typeof lead["repositoryId"] !== "string" || typeof lead["number"] !== "number") return undefined;
  const task = await deps.loadTask(lead["taskId"]);
  if (task === undefined || task.orgId !== orgId || !tracksMerge(task.workflow) || task.closedAt !== undefined || task.releasedAt !== undefined) return undefined;
  const recorded = task.workflow.pullRequests?.find((pr) => pr.repositoryId === lead["repositoryId"] && pr.number === lead["number"]);
  if (recorded === undefined) return undefined;
  const linked = await findLinkedGithubWorkflowPullRequest({ documentClient: deps.documentClient, tableName: deps.tableName, repositoryFullName: fullName, number: recorded.number });
  if (linked === undefined || linked.taskId !== task.taskId || linked.repositoryId !== recorded.repositoryId || linked.url !== recorded.url) return undefined;
  const url = await deps.repositoryUrl(task.project, task.startingRevision, recorded.repositoryId, orgId);
  if (url === undefined || !await deps.verifyRepository(url, { installationId: event.installationId, repositoryId: event.repositoryId, fullName })) return undefined;
  return { taskId: task.taskId, orgId, repositoryId: recorded.repositoryId, number: recorded.number };
}

/** Wakes the followed task's tracking row for a delivery (the delivery is re-resolved here, under its lease, not trusted from when it was received). */
export async function wakeFromHeadEvent(deps: HeadEventDependencies, event: HeadWebhookEvent): Promise<"woken" | "none" | "unfollowed"> {
  const followed = await resolveHeadEventTask(deps, event);
  if (followed === undefined) return "unfollowed";
  return wakeTrackingRow({ documentClient: deps.documentClient, tableName: deps.tableName, now: deps.now }, followed.taskId);
}
