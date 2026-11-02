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

/** The failing tests of the last nightly when it is usable (recent, the task's base branch, whole), else undefined. */
export async function usableNightlyFailing(deps: TestEnvDeps, orgId: OrgId, project: string): Promise<string[] | undefined> {
  const baseline = await readNightlyBaseline(deps, orgId, project).catch(() => undefined);
  if (baseline === undefined || baseline.tests.failed > NIGHTLY_FAILED_MAX || baseline.failed.length !== baseline.tests.failed) return undefined;
  const finished = Date.parse(baseline.finishedAt), now = deps.now();
  if (!Number.isFinite(finished) || finished < now - NIGHTLY_BASELINE_MAX_AGE_MS || finished > now + FUTURE_SKEW_MS) return undefined;
  const base = await projectBaseBranch(deps, orgId, project);
  if (base === undefined || baseline.branch !== base) return undefined;
  return [...baseline.failed];
}
