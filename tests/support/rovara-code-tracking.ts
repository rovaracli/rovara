// Rovara Code (Plan 6 Task 14): a harness for merge tracking: a fake DynamoDB with one task, its linked pull requests and a fake GitHub that answers
// `PullRequestStatus` and counts every request it is asked for against the pass's budget.
import type { MergeTrackingDependencies, TrackedTask } from "../../packages/broker/src/rovara-code/merge-tracking.js";
import { githubRepositoryOver } from "../../packages/broker/src/aws/broker/consumer-hosts.js";
import type { PullRequestStatus } from "../../packages/broker/src/github-pull-status.js";
import type { GithubMergeReadBudget } from "../../packages/broker/src/aws/workflow-merge-recovery.js";
import { githubWorkflowPullRequestKey } from "../../packages/broker/src/developer/task-records.js";
import { FakeDynamoDb } from "./fake-dynamodb.js";
import { TEST_ORG } from "./orgs.js";

export const TASK_ID = "00000000-0000-4000-8000-0000000000a1";
export const SESSION_ID = "ses_aaaaaaaaaaaaaaaaaaaa";
export const HEAD_A = "a".repeat(40);
export const HEAD_B = "b".repeat(40);
export const NOW = Date.parse("2026-10-25T12:00:00.000Z");
export const TABLE = "state";

export const sha = (character: string): string => character.repeat(40);

export function status(overrides: Partial<PullRequestStatus> = {}): PullRequestStatus {
  return {
    number: 7, state: "open", draft: true, headSha: HEAD_A, baseBranch: "main", mergeableState: "clean", mergeable: true, behindBy: 0,
    checks: [{ name: "test", status: "completed", conclusion: "success", required: false, url: "https://example.test/1" }],
    requiredChecks: [], baseHasRequiredChecks: false, headHasWorkflowFiles: true, requestedReviewers: 0, reviews: [], ...overrides,
  };
}

/**
 * A GitHub that answers what a tracking pass reads and does (every call is kept). The pass reaches it through the GitHub CodeHost adapter, as the broker wires it: the world's
 * `repository` resolver reads `deps.github` each time, so a test may replace it.
 */
export class FakeGithub {
  readonly statuses = new Map<number, PullRequestStatus>();
  readonly permissions = new Map<string, "admin" | "write" | "read" | "none">();
  readonly calls: string[] = [];
  /** How many requests a status read costs against the budget. */
  statusCost = 5;
  failWith: Error | undefined;
  private spend(budget: GithubMergeReadBudget | undefined, count: number): void {
    for (let index = 0; index < count; index += 1) budget?.beforeRequest();
  }
  async getPullRequestStatus(_url: string, number: number, _scope: unknown, budget?: GithubMergeReadBudget): Promise<PullRequestStatus> {
    this.calls.push(`status:${String(number)}`);
    this.spend(budget, this.statusCost);
    if (this.failWith !== undefined) throw this.failWith;
    const found = this.statuses.get(number);
    if (found === undefined) throw new Error("no such pull request");
    return structuredClone(found);
  }
  async getRepositoryPermission(_url: string, login: string, _scope: unknown, budget?: GithubMergeReadBudget): Promise<"admin" | "write" | "read" | "none"> {
    this.calls.push(`permission:${login}`);
    this.spend(budget, 1);
    return this.permissions.get(login) ?? "none";
  }
  async markPullRequestReady(_url: string, number: number, _scope: unknown, budget?: GithubMergeReadBudget): Promise<"ready" | "already_ready"> {
    this.calls.push(`ready:${String(number)}`);
    this.spend(budget, 2);
    const current = this.statuses.get(number);
    if (current === undefined) throw new Error("no such pull request");
    const was = current.draft;
    this.statuses.set(number, { ...current, draft: false });
    return was ? "ready" : "already_ready";
  }
  async requestReviewers(_url: string, number: number, reviewers: readonly string[], _scope: unknown, budget?: GithubMergeReadBudget): Promise<"requested" | "refused"> {
    this.calls.push(`reviewers:${String(number)}:${reviewers.join(",")}`);
    this.spend(budget, 1);
    return "requested";
  }
}

export interface TrackingWorld {
  db: FakeDynamoDb;
  github: FakeGithub;
  deps: MergeTrackingDependencies & { github: unknown };
  setNow(value: number): void;
  now(): number;
  task(): Record<string, unknown>;
  setTask(change: Partial<Record<string, unknown>>): void;
  setWorkflow(change: Record<string, unknown>): void;
}

export function workflowOf(pullRequests: Array<{ repositoryId: string; number: number; headSha: string }>, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1, definitionId: "agentx-task-to-pr", definitionVersion: "1.1.0", taskId: TASK_ID, revision: 9, stage: "WAIT_FOR_MERGE", state: "WAITING", path: "QUICK",
    pullRequests: pullRequests.map((pr) => ({ ...pr, url: `https://github.com/acme/${pr.repositoryId}/pull/${String(pr.number)}`, candidateDigest: "c".repeat(64), required: true, state: "OPEN" })),
    updatedAt: "2026-10-25T11:00:00.000Z", ...extra,
  };
}

export function world(options: { pullRequests?: Array<{ repositoryId: string; number: number; headSha?: string }>; sessionId?: string | null; definitionVersion?: string; deps?: Partial<MergeTrackingDependencies> & { github?: unknown } } = {}): TrackingWorld {
  const db = new FakeDynamoDb();
  const github = new FakeGithub();
  let now = NOW;
  const pullRequests = (options.pullRequests ?? [{ repositoryId: "payments", number: 7 }]).map((pr) => ({ ...pr, headSha: pr.headSha ?? HEAD_A }));
  for (const pr of pullRequests) {
    github.statuses.set(pr.number, status({ number: pr.number, headSha: pr.headSha }));
    db.set({
      ...githubWorkflowPullRequestKey(`acme/${pr.repositoryId}`, pr.number), entityType: "GITHUB_WORKFLOW_PR", repositoryFullName: `acme/${pr.repositoryId}`, repositoryId: pr.repositoryId,
      number: pr.number, url: `https://github.com/acme/${pr.repositoryId}/pull/${String(pr.number)}`, taskId: TASK_ID, workspaceId: "ws-1", candidateDigest: "c".repeat(64), createdAt: "2026-10-25T11:00:00.000Z",
    });
  }
  db.set({
    pk: `DEVTASK#${TASK_ID}`, sk: "META", entityType: "DEVELOPER_TASK", taskId: TASK_ID, orgId: TEST_ORG, project: "web", startingRevision: 1, workspaceId: "ws-1",
    ...(options.sessionId === null ? {} : { sessionId: options.sessionId ?? SESSION_ID }),
    workflow: { ...workflowOf(pullRequests), ...(options.definitionVersion === undefined ? {} : { definitionVersion: options.definitionVersion }) },
  });
  db.set({ pk: "WORKFLOW_MERGE_RECOVERY", sk: `TASK#${TASK_ID}`, entityType: "WORKFLOW_MERGE_RECOVERY", taskId: TASK_ID, kind: "tracking", attempts: 0 });
  const loadTask = async (taskId: string): Promise<TrackedTask | undefined> => taskId === TASK_ID ? db.get(`DEVTASK#${TASK_ID}`, "META") as unknown as TrackedTask : undefined;
  const deps: MergeTrackingDependencies & { github: unknown } = {
    documentClient: db, tableName: TABLE, now: () => now, github, scope: (orgId) => ({ orgId }), loadTask,
    repositoryUrl: async (_project, _revision, repositoryId) => `https://github.com/acme/${repositoryId}`,
    // The code host is the GitHub adapter over whatever `deps.github` is now (a test replaces it to change what GitHub says).
    repository: async (_project, _revision, repositoryId) => githubRepositoryOver(deps.github as never, `https://github.com/acme/${repositoryId}`),
    recordedHead: async () => undefined, ...options.deps,
  };
  return {
    db, github, deps, setNow: (value) => { now = value; }, now: () => now,
    task: () => db.get(`DEVTASK#${TASK_ID}`, "META")!,
    setTask: (change) => db.set({ ...db.get(`DEVTASK#${TASK_ID}`, "META")!, ...change }),
    setWorkflow: (change) => { const task = db.get(`DEVTASK#${TASK_ID}`, "META")!; db.set({ ...task, workflow: { ...(task.workflow as object), ...change } }); },
  };
}
