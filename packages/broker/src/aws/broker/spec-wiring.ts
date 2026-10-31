// Meta repo lane D (K1): what the broker's operation end needs to settle a spec write or a spec publication. The pure parts are in ../../spec/; this module reads the broker's own records for them.
import { taskKey, type DeveloperTaskRecord } from "../../developer/task-records.js";
import { workflowDispatchItem } from "../broker-shared.js";
import { PutCommand } from "@aws-sdk/lib-dynamodb";
import { approvedPlanDigestOf } from "../../spec/plan.js";
import { refreshSpecState, type SpecPullRequestFacts } from "../../spec/refresh.js";
import { specPullRequestKey } from "../../spec/state.js";
import { dynamoSpecStore } from "../../spec/store.js";
import type { SpecEndEnvironment, SpecOperationFacts } from "../../spec/end-items.js";
import { getItem } from "../cancellation.js";
import { githubRepositoryFullName, pullRequestKey } from "./admin-and-helpers.js";
import { githubScopeOf } from "./scope-helpers.js";
import type { AwsBrokerDependencies, PullRequestRecord } from "./definitions.js";

export function specEndEnvironmentOf(dependencies: AwsBrokerDependencies, workspaceId: string, now: () => string = () => new Date().toISOString()): SpecEndEnvironment {
  return {
    tableName: dependencies.tableName,
    store: dynamoSpecStore(dependencies),
    now,
    approvedPlanDigest: async (taskId) => approvedPlanDigestOf(await getItem<DeveloperTaskRecord>(dependencies, taskKey(taskId))),
    taskKey: (taskId) => taskId.slice(0, 8),
    // The team's template folder is read at the task's `knowledgeCommit` through the verified meta checkout; that reader is not wired yet, so a `team_template` target stops with "template_missing" and the owner can continue.
    template: async () => undefined,
    pullRequestRecord: async (operation: SpecOperationFacts, number) => {
      if (operation.publication === undefined) return undefined;
      const record = await getItem<PullRequestRecord>(dependencies, pullRequestKey(workspaceId, operation.publication.repository, number));
      return record === undefined ? undefined : { url: record.url, expectedHeadCommit: record.expectedHeadCommit, createdByOperationId: record.createdByOperationId ?? "" };
    },
    republishItem: async (taskId) => {
      const task = await getItem<DeveloperTaskRecord>(dependencies, taskKey(taskId));
      const workflow = task?.workflow;
      if (task === undefined || task.closedAt !== undefined || workflow === undefined || workflow.candidate === undefined) return undefined;
      // The step that waited for the spec: the code review (before it) or the code pull request (after it).
      const kind = workflow.stage === "REVIEW" && workflow.state === "WAITING" ? "REVIEW" as const : workflow.stage === "PULL_REQUEST" && workflow.state === "READY" ? "PUBLISH" as const : undefined;
      if (kind === undefined) return undefined;
      const row = workflowDispatchItem(dependencies.tableName, taskId, workflow.revision, kind, workflow.candidate.digest, new Date().toISOString());
      // Overwrites a row that is still waiting: the publication is due again now.
      return row.Put === undefined ? undefined : { Put: { TableName: row.Put.TableName, Item: row.Put.Item } };
    },
    specPullRequestIndexItem: (taskId, pullRequest) => {
      try {
        const full = githubRepositoryFullName(pullRequest.repositoryUrl);
        return { Put: { TableName: dependencies.tableName, Item: { ...specPullRequestKey(full, pullRequest.number), entityType: "SPEC_PULL_REQUEST", taskId, number: pullRequest.number, url: pullRequest.url, repositoryUrl: pullRequest.repositoryUrl } } };
      } catch {
        return undefined;
      }
    },
  };
}


/** One file of a repository at a commit, through the task's own GitHub connection, bounded. Undefined when GitHub cannot say or the file is not there or is too large. */
export function readMetaFileOf(dependencies: AwsBrokerDependencies): (task: DeveloperTaskRecord, repositoryUrl: string, path: string, commit: string, maxBytes: number) => Promise<string | undefined> {
  return async (task, repositoryUrl, path, commit, maxBytes) => {
    const read = dependencies.githubPullRequests.getFileAtCommit;
    if (read === undefined) return undefined;
    try {
      return (await read.call(dependencies.githubPullRequests, repositoryUrl, path, commit, await githubScopeOf(dependencies, task), { maxBytes })) ?? undefined;
    } catch {
      return undefined;
    }
  };
}

/** GitHub's view of a spec pull request: its head, state and reviews, through the task's own connection. Undefined when GitHub cannot say. */
export function readSpecPullRequestOf(dependencies: AwsBrokerDependencies): (task: DeveloperTaskRecord, repositoryUrl: string, number: number) => Promise<SpecPullRequestFacts | undefined> {
  return async (task, repositoryUrl, number) => {
    const read = dependencies.githubPullRequests.getPullRequestStatus;
    if (read === undefined) return undefined;
    try {
      const status = await read.call(dependencies.githubPullRequests, repositoryUrl, number, await githubScopeOf(dependencies, task));
      return { state: status.state, headSha: status.headSha, reviews: status.reviews.map((review) => ({ state: review.state, commitId: review.commitId, login: review.login })), ...(status.reviewsIncomplete === true ? { reviewsIncomplete: true } : {}) };
    } catch {
      return undefined;
    }
  };
}

/**
 * A GitHub delivery about a pull request: when it is a task's spec pull request (an index row says so), GitHub is read and the spec's state follows what people did (an edit asks the owner "re-plan or keep?",
 * an approval releases a `spec_first` hold), and the held code publication is made due again. Anything else costs one read. Never throws: a failure here only means the next look at the held step does it.
 */
export async function handleSpecPullRequestEvent(dependencies: AwsBrokerDependencies, event: { kind: string; fullName: string; number: number }): Promise<void> {
  if (event.kind !== "PULL_REQUEST" && event.kind !== "PR_COMMENT") return;
  try {
    const index = await getItem<{ taskId?: string }>(dependencies, specPullRequestKey(event.fullName, event.number));
    if (index?.taskId === undefined) return;
    const task = await getItem<DeveloperTaskRecord>(dependencies, taskKey(index.taskId));
    if (task === undefined || task.closedAt !== undefined) return;
    const read = readSpecPullRequestOf(dependencies);
    const environment = specEndEnvironmentOf(dependencies, task.workspaceId);
    const refreshed = await refreshSpecState({
      store: environment.store, now: () => environment.now(),
      read: async (state) => state.specPullRequest === undefined ? undefined : read(task, state.specPullRequest.repositoryUrl, state.specPullRequest.number),
    }, task.taskId);
    if (!refreshed.changed) return;
    const again = await environment.republishItem(task.taskId);
    if (again?.Put !== undefined) await dependencies.documentClient.send(new PutCommand({ TableName: again.Put.TableName, Item: again.Put.Item }));
  } catch (error) {
    console.log(JSON.stringify({ component: "broker", event: "spec.pull_request_event_failed", error: error instanceof Error ? error.name : "unknown" }));
  }
}
