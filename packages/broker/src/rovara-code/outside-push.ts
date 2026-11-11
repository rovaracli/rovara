// "Last pushed by" (E-30): what a verified push event says about who pushed which head, kept beside the task as a HINT. A hint never decides whose push it was (merge tracking reads the host
// and decides `headByRovara`; a published working branch is Rovara's only at the commit it was made at): the task view shows the login only when the hint names the very head the host shows now.
// The login is the host's own `sender` of the event, never a commit author (anyone can forge one) and never an email. A pull request is found only through its recorded link, and a working branch only through
// the task's own working-branch rows, so a push to any other branch or pull request never attaches to a task (E-31).
import type { OrgId } from "@rovara-code/contracts";
import { recordOutsidePush, readWorkingBranches } from "../aws/developer-tasks/continue-loop.js";
import { findLinkedChangeRequest } from "./linked-change-requests.js";
import type { BranchPushWebhookEvent, PullRequestWebhookEvent } from "../aws/github-webhooks.js";

export interface OutsidePushDependencies {
  documentClient: { send(command: unknown): Promise<unknown> };
  tableName: string;
  now(): string;
  loadTask(taskId: string): Promise<{ taskId: string; project: string; startingRevision: number; orgId?: OrgId | undefined; closedAt?: string | undefined } | undefined>;
  repositoryUrl(project: string, revision: number, repositoryId: string, orgId: OrgId): Promise<string | undefined>;
  /** The org the host's installation is bound to (the delivery's own binding, never a name in its body). */
  installationOrg(installationId: number): Promise<OrgId | undefined>;
}

const TASK_BRANCH = /^agentx\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/u;
const sameRepository = (url: string, fullName: string): boolean => url.replace(/\.git$/u, "").replace(/\/$/u, "").toLowerCase() === `https://github.com/${fullName.toLowerCase()}`;

/** Records the pusher of a pull request push (synchronize) or of a push to a task's working branch. Returns whether a hint was stored. Never throws for an event nothing follows. */
export async function recordOutsidePushEvent(deps: OutsidePushDependencies, event: PullRequestWebhookEvent | BranchPushWebhookEvent | { kind: "HEAD_STATUS" }): Promise<boolean> {
  if (event.kind === "PULL_REQUEST") {
    if (event.action !== "synchronize" || event.headSha === undefined || event.pushedBy === undefined) return false;
    const linked = await findLinkedChangeRequest(deps, { hostKind: "github", repositoryAddress: `https://github.com/${event.fullName}`, id: String(event.number) });
    if (linked === undefined) return false;
    const task = await deps.loadTask(linked.taskId);
    if (task === undefined || task.closedAt !== undefined || task.orgId === undefined) return false;
    return recordOutsidePush(deps, { taskId: task.taskId, repository: linked.repositoryId, subject: event.number, headSha: event.headSha, login: event.pushedBy, at: deps.now() });
  }
  if (event.kind !== "BRANCH_PUSH" || event.pushedBy === undefined) return false;
  const name = TASK_BRANCH.exec(event.branch);
  if (name === null) return false;
  const task = await deps.loadTask(name[1]!);
  if (task === undefined || task.closedAt !== undefined || task.orgId === undefined) return false;
  // The installation the push came through must be this task's own company's.
  if (await deps.installationOrg(event.installationId) !== task.orgId) return false;
  for (const row of await readWorkingBranches(deps, task.taskId)) {
    if (row.branch !== event.branch) continue;
    const url = await deps.repositoryUrl(task.project, task.startingRevision, row.repository, task.orgId);
    if (url === undefined || !sameRepository(url, event.fullName)) continue;
    return recordOutsidePush(deps, { taskId: task.taskId, repository: row.repository, subject: "branch", headSha: event.headSha, login: event.pushedBy, at: deps.now() });
  }
  return false;
}
