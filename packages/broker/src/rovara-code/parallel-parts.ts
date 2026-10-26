// Rovara Code v2 (Plan 6 Task 11): how many independent parts of an approved plan may be built at once, and when ordered work is allowed to start.
//
// Parts run on the task's one machine, inside the one operation the broker admits (`admitWork`, the step budget, the payer, the planning and run limits), on that
// operation's one model key. They have no spending limit of their own, so what they spend together can never pass the task's limits. What is bounded here is the number of
// parts: the plan's cap (PARALLEL_PARTS_MAX), and the room the person and the org have in their workspace slots. The task holds one slot already, so it may run its own
// part plus one more for each free slot; an org at its limit builds serially.
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { parallelPartsFor, taskGraphOrder, type OrgId, type TaskGraphV1, type WorkItemProgressV1, type WorkflowParallel } from "@agentx/contracts";
import { developerCharge, readWorkspaceLimits } from "../developer/limits.js";
import type { WorkspaceCharge } from "../developer/task-records.js";

type Client = { send(command: unknown): Promise<unknown> };

export interface ParallelPartsDependencies {
  documentClient: Client;
  tableName: string;
  orgId: OrgId;
  slackTeamId?: string | undefined;
  /** The install's limits when the org set none. */
  limitDefaults: { member: number; organization: number };
}

/** Rovara Code v2 is the one definition version that builds parts in parallel (decided 2026-10-22, question 14). */
export const isParallelPartsWorkflow = (workflow: { definitionVersion?: string } | undefined): boolean => workflow?.definitionVersion === "1.1.0";

/**
 * Whether a task's approved ordered plan may start. Version 1 keeps today's switch (`AGENTX_WORKFLOW_DEPENDENCIES_ENABLED`, off by default); a version 2 task does not need
 * it, since a version 2 task exists only where an admin adopted version 2.
 */
export function workflowDependenciesAllowed(deps: { workflowDependenciesEnabled?: boolean | undefined }, workflow: { definitionVersion?: string } | undefined): boolean {
  return deps.workflowDependenciesEnabled === true || isParallelPartsWorkflow(workflow);
}

/**
 * The parts setting for a task's ordered-plan operation: `undefined` for version 1 (it keeps running one item at a time), else `{ max }` from 1 to the plan's cap. Anything
 * that cannot be read leaves one part: more machine work is never started on a guess.
 */
export async function parallelPartsForTask(
  deps: ParallelPartsDependencies,
  task: { developerId: string; slackUserId?: string | undefined; /** What the task's slot was really charged to; the creator's keys only when none is stored (as the start's retry does). */ charge?: WorkspaceCharge | undefined; workflow?: { definitionVersion?: string } | undefined },
): Promise<WorkflowParallel | undefined> {
  if (!isParallelPartsWorkflow(task.workflow)) return undefined;
  try {
    const limits = await readWorkspaceLimits(deps.documentClient, deps.tableName, deps.orgId, deps.limitDefaults, () => undefined);
    const charge = task.charge ?? developerCharge({ orgId: deps.orgId, teamId: deps.slackTeamId, slackUserId: task.slackUserId, developerId: task.developerId });
    const count = async (key: { pk: string; sk: string }): Promise<number> => {
      const response = await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: key, ConsistentRead: true })) as { Item?: { count?: unknown } };
      return typeof response.Item?.count === "number" ? response.Item.count : 0;
    };
    const freeForPerson = limits.member - await count(charge.member);
    const freeForOrg = limits.organization - await count(charge.organization);
    // A count above a limit (a limit lowered after tasks started) is negative room: `parallelPartsFor` leaves one part for it.
    return { max: parallelPartsFor(1 + Math.min(freeForPerson, freeForOrg)) };
  } catch {
    return { max: 1 };
  }
}

/**
 * The trees a part of a parallel run may start from: the tree the run began at, and every tree a finished part was merged into. A part that was built one after another (a
 * worker that was not sent the parts setting) ends on its own tree, which counts as the tree it was merged into.
 */
export function parallelStartTrees(
  history: ReadonlyArray<{ state: string; integratedTreeSha?: string | undefined; candidateTreeSha?: string | undefined }>,
  firstBaseTree: string | undefined,
): Set<string> {
  const trees = new Set<string>(firstBaseTree === undefined ? [] : [firstBaseTree]);
  for (const entry of history) {
    const tree = entry.state === "IMPLEMENTED" ? entry.integratedTreeSha ?? entry.candidateTreeSha : undefined;
    if (tree !== undefined) trees.add(tree);
  }
  return trees;
}

/**
 * Whether a worker that builds the plan's items one at a time (an older one, without "task.workflowParallelParts") can take over this plan's retained progress. Its executor
 * resumes only from a completed prefix of the plan's order whose last item ended on the tree the workspace holds; progress that parallel parts left (item B done, item A not) is
 * not that, and sending it would fail the run at its start on every retry. Such a plan is refused for an older worker instead of being sent to it.
 */
export function serialWorkerCanResume(input: { graph: TaskGraphV1; resumeProgress?: readonly WorkItemProgressV1[] | undefined; resumeTreeSha?: string | undefined }): boolean {
  const order = taskGraphOrder(input.graph);
  const implemented = new Map((input.resumeProgress ?? []).filter((entry) => entry.state === "IMPLEMENTED").map((entry) => [entry.itemId, entry] as const));
  let prefix = 0;
  while (prefix < order.length && implemented.has(order[prefix]!)) prefix += 1;
  if (implemented.size !== prefix) return false;
  if (prefix === 0) return true;
  const last = implemented.get(order[prefix - 1]!)!;
  return input.resumeTreeSha !== undefined && last.candidateTreeSha === input.resumeTreeSha;
}
