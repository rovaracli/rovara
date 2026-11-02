// Setup and test health SH17 (Opus re-check M4): which nightly baseline may be trusted as "what already fails". Only the last nightly that is RECENT (finished within 7 days) and ran on the SAME branch the tasks
// are based on (the project's default branch; a project whose repositories do not agree has none). A stale baseline, one from another branch, one that did not fit (truncated) or one that cannot be read is not
// used at all: its failures excuse nothing and no mark is offered from it. The same rule will serve the later automatic removal of marks.
import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import { NIGHTLY_FAILED_MAX, PROJECT_REVISION_SK_PREFIX, projectPk, type OrgId } from "@agentx/contracts";
import type { TestEnvDeps } from "../org/test-environment.js";
import { readNightlyBaseline } from "./nightly.js";

/** A baseline older than this is not used. */
export const NIGHTLY_BASELINE_MAX_AGE_MS = 7 * 86_400_000;
/** A clock skew allowance: a baseline that claims to have finished later than this ahead of now is not believed. */
const FUTURE_SKEW_MS = 3_600_000;

/** The branch the project's tasks are based on: the default branch every repository of its latest revision names. Undefined when it cannot be read or the repositories disagree. */
export async function projectBaseBranch(deps: Pick<TestEnvDeps, "documentClient" | "tableName">, orgId: OrgId, project: string): Promise<string | undefined> {
  try {
    const response = await deps.documentClient.send(new QueryCommand({
      TableName: deps.tableName, KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)", ExpressionAttributeValues: { ":pk": projectPk(orgId, project), ":prefix": PROJECT_REVISION_SK_PREFIX },
      ScanIndexForward: false, Limit: 1, ConsistentRead: true,
    })) as { Items?: Array<{ definition?: { repositories?: Array<{ defaultBranch?: unknown }> } }> };
    const branches = (response.Items?.[0]?.definition?.repositories ?? []).map((repository) => repository.defaultBranch);
    const first = branches[0];
    return typeof first === "string" && first !== "" && branches.every((branch) => branch === first) ? first : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The branches the task's open pull requests target (distinct), read from its merge-tracking items. Empty when it has no open pull request yet (it is then based on the project's default branch) or the items cannot be read.
 */
export async function taskBaseBranches(deps: Pick<TestEnvDeps, "documentClient" | "tableName">, taskId: string): Promise<string[]> {
  try {
    const response = await deps.documentClient.send(new QueryCommand({
      TableName: deps.tableName, KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)", ExpressionAttributeValues: { ":pk": `DEVTASK#${taskId}`, ":prefix": "MERGE_TRACKING#" }, ConsistentRead: true,
    })) as { Items?: Array<{ state?: unknown; baseBranch?: unknown }> };
    return [...new Set((response.Items ?? []).filter((item) => item.state === "open" && typeof item.baseBranch === "string" && item.baseBranch !== "").map((item) => item.baseBranch as string))];
  } catch {
    return [];
  }
}

/** Reads a project's default-branch head from its code host: for a project, a function from a branch to its head now (undefined when it cannot be read). */
export type NightlyHeadReader = (orgId: OrgId, project: string) => (branch: string) => Promise<string | undefined>;

/** The options a caller gives `usableNightlyFailing` for a task: the branches of its open pull requests and, where the host can be asked, the branch's head now. */
export async function nightlyOptionsFor(deps: Pick<TestEnvDeps, "documentClient" | "tableName">, task: { taskId: string; orgId: OrgId; project: string }, reader: NightlyHeadReader | undefined): Promise<UsableNightlyOptions> {
  return { taskBranches: await taskBaseBranches(deps, task.taskId), currentHead: reader?.(task.orgId, task.project) };
}

export interface UsableNightlyOptions {
  /** The branches the task itself is based on (`taskBaseBranches`). When given and not empty, the nightly's branch must be each of them: a task on another branch gets no excuse from a nightly of this one. Otherwise the project's default branch is used. */
  taskBranches?: readonly string[] | undefined;
  /** The branch's head commit now, or undefined when it cannot be read. With it, a baseline older than 7 days is still used when it was run on exactly this head (a quiet repository has had nothing to change since). */
  currentHead?: ((branch: string) => Promise<string | undefined>) | undefined;
}

/** The failing tests of the last nightly when it is usable (recent or on the branch's unchanged head, the task's base branch, whole), else undefined. */
export async function usableNightlyFailing(deps: TestEnvDeps, orgId: OrgId, project: string, options: UsableNightlyOptions = {}): Promise<string[] | undefined> {
  const baseline = await readNightlyBaseline(deps, orgId, project).catch(() => undefined);
  if (baseline === undefined || baseline.tests.failed > NIGHTLY_FAILED_MAX || baseline.failed.length !== baseline.tests.failed) return undefined;
  const finished = Date.parse(baseline.finishedAt), now = deps.now();
  if (!Number.isFinite(finished) || finished > now + FUTURE_SKEW_MS) return undefined;
  const own = options.taskBranches ?? [];
  if (own.length > 0) {
    if (!own.every((branch) => branch === baseline.branch)) return undefined;
  } else {
    const base = await projectBaseBranch(deps, orgId, project);
    if (base === undefined || baseline.branch !== base) return undefined;
  }
  if (finished < now - NIGHTLY_BASELINE_MAX_AGE_MS) {
    // Older than a week: still what already fails if the branch has not moved since it ran.
    const head = options.currentHead === undefined ? undefined : await options.currentHead(baseline.branch).catch(() => undefined);
    if (head === undefined || head !== baseline.headSha) return undefined;
  }
  return [...baseline.failed];
}
