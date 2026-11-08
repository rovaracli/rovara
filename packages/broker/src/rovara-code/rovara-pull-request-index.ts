// The production `RovaraPullRequestIndexPort` of the Team record's code host tap: finds Rovara's own pull requests. Moved out of `team-record/runtime.ts` (SRL-3) so the lookup by merge
// commit sits beside the index it reads (`merge-commit-index.ts`) and outside the Team record's storage modules; the task records and the reverse links are the state table's, not the record's.
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { OrgIdSchema } from "@agentx/contracts";
import type { RovaraPullRequest, RovaraPullRequestIndexPort } from "../team-record/sources/ports.js";
import { taskKey, type DeveloperTaskRecord } from "../developer/task-records.js";
import { findLinkedChangeRequest } from "./linked-change-requests.js";
import { findMergeCommit, githubPullRequestAddress } from "./merge-commit-index.js";

export interface RovaraPullRequestIndexDependencies { documentClient: { send(command: unknown): Promise<unknown> }; tableName: string }

export function createRovaraPullRequestIndex(deps: RovaraPullRequestIndexDependencies): RovaraPullRequestIndexPort {
  async function byNumber({ workspaceId, host, repo, number }: { workspaceId: string; host: string; repo: string; number: number }): Promise<RovaraPullRequest | undefined> {
    if (host !== "github") return undefined;
    const linked = await findLinkedChangeRequest(deps, { hostKind: "github", repositoryAddress: `https://github.com/${repo}`, id: String(number) });
    // The link must belong to THIS workspace: a pull request number is only unique inside a repository, and a repository belongs to one org's installation.
    if (linked === undefined || linked.workspaceId === undefined) return undefined;
    const task = ((await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: taskKey(linked.taskId), ConsistentRead: true }))) as { Item?: DeveloperTaskRecord }).Item;
    if (task === undefined || task.orgId !== workspaceId) return undefined;
    const entry = task.workflow?.pullRequests?.find((pullRequest) => pullRequest.number === number && pullRequest.url === linked.url);
    if (entry?.headSha === undefined) return undefined;
    return { taskId: task.taskId, project: task.project, number, url: linked.url, candidateHeadSha: entry.headSha };
  }

  return {
    byNumber,
    // The pull request merged as this commit: the index row (repository + commit) names a pull request, which must then be that company's Rovara pull request, linked to the task the row
    // names, at the address the row names. Anything that does not agree is a miss: a revert is then not recorded, never recorded against the wrong task.
    async byMergeCommit({ workspaceId, host, repo, sha }) {
      if (host !== "github") return undefined;
      // The key is the company's: a workspace that is not a company id finds nothing.
      const org = OrgIdSchema.safeParse(workspaceId);
      if (!org.success) return undefined;
      const row = await findMergeCommit(deps, { orgId: org.data, repositoryFullName: repo, sha });
      if (row === undefined || row.orgId !== workspaceId) return undefined;
      const address = githubPullRequestAddress(row.url);
      if (address === undefined || address.number !== row.number || address.repositoryFullName.toLowerCase() !== repo.toLowerCase()) return undefined;
      const found = await byNumber({ workspaceId, host, repo, number: row.number });
      if (found === undefined || found.taskId !== row.taskId || found.url !== row.url) return undefined;
      return { ...found, mergeCommitSha: row.mergeCommit };
    },
  };
}
