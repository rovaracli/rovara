// Rovara Code v2 (Plan 6 Task 11): how many independent parts of an approved plan may be built at once, and when ordered work is allowed to start.
//
// Parts run on the task's one machine, inside the one operation the broker admits (`admitWork`, the step budget, the payer, the planning and run limits), on that
// operation's one model key. They have no spending limit of their own, so what they spend together can never pass the task's limits. What is bounded here is the number of
// parts: the plan's cap (PARALLEL_PARTS_MAX), and the room the person and the org have in their workspace slots. The task holds one slot already, so it may run its own
// part plus one more for each free slot; an org at its limit builds serially.
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { PARALLEL_PARTS_MAX, parallelPartsFor, taskGraphOrder, type OrgId, type TaskGraphV1, type WorkItemProgressV1, type WorkflowParallel } from "@rovara-code/contracts";
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

/** The parts setting, and the line for the timeline when it holds the plan's parts back (see `parallelPartsDecision`). */
export interface PartsDecision { parallel: WorkflowParallel | undefined; note?: string }

/** The most parts of this plan that could ever run together: the widest step of its order, where a part's step is one past the latest of the parts it depends on. */
function widestStep(graph: TaskGraphV1): number {
  const byId = new Map(graph.items.map((item) => [item.id, item] as const));
  const steps = new Map<string, number>();
  const stepOf = (id: string, seen: ReadonlySet<string>): number => {
    const known = steps.get(id);
    if (known !== undefined) return known;
    const item = byId.get(id);
    // A graph with a cycle or an unknown part is not run at all; here it only counts as one part.
    if (item === undefined || seen.has(id)) return 1;
    const step = 1 + Math.max(0, ...item.dependsOn.map((dependency) => stepOf(dependency, new Set([...seen, id]))));
    steps.set(id, step);
    return step;
  };
  const widths = new Map<number, number>();
  for (const item of graph.items) {
    const step = stepOf(item.id, new Set());
    widths.set(step, (widths.get(step) ?? 0) + 1);
  }
  return Math.max(1, ...widths.values());
}

/**
 * The parts setting for a task's ordered-plan operation: `parallel` is `undefined` for version 1 (it keeps running one item at a time), else `{ max }` from 1 to the plan's cap.
 * Anything that cannot be read leaves one part: more machine work is never started on a guess.
 *
 * With the plan's graph, a version 2 task whose room is less than the plan could use also gets `note`, one line for the operation's timeline that says why: how many of the
 * person's (or the organization's) workspace slots are in use. Without it, parts that ran one after another looked like a fault (Bug N).
 */
export async function parallelPartsDecision(
  deps: ParallelPartsDependencies,
  task: { developerId: string; slackUserId?: string | undefined; /** What the task's slot was really charged to; the creator's keys only when none is stored (as the start's retry does). */ charge?: WorkspaceCharge | undefined; workflow?: { definitionVersion?: string } | undefined },
  graph?: TaskGraphV1,
): Promise<PartsDecision> {
  if (!isParallelPartsWorkflow(task.workflow)) return { parallel: undefined };
  const wanted = graph === undefined ? 1 : Math.min(PARALLEL_PARTS_MAX, widestStep(graph));
  try {
    const limits = await readWorkspaceLimits(deps.documentClient, deps.tableName, deps.orgId, deps.limitDefaults, () => undefined);
    const charge = task.charge ?? developerCharge({ orgId: deps.orgId, teamId: deps.slackTeamId, slackUserId: task.slackUserId, developerId: task.developerId });
    const count = async (key: { pk: string; sk: string }): Promise<number> => {
      const response = await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: key, ConsistentRead: true })) as { Item?: { count?: unknown } };
      return typeof response.Item?.count === "number" ? response.Item.count : 0;
    };
    const personUsed = await count(charge.member);
    const orgUsed = await count(charge.organization);
    const freeForPerson = limits.member - personUsed;
    const freeForOrg = limits.organization - orgUsed;
    // A count above a limit (a limit lowered after tasks started) is negative room: `parallelPartsFor` leaves one part for it.
    const max = parallelPartsFor(1 + Math.min(freeForPerson, freeForOrg));
    if (max >= wanted) return { parallel: { max } };
    const clause = max === 1 ? "Running parts one at a time" : `Running up to ${String(max)} parts at a time`;
    const person = freeForPerson <= freeForOrg;
    return { parallel: { max }, note: `${clause}: ${String(person ? personUsed : orgUsed)} of ${String(person ? limits.member : limits.organization)} of your ${person ? "workspaces are" : "organization's workspaces are"} in use.` };
  } catch {
    return { parallel: { max: 1 }, ...(wanted > 1 ? { note: "Running parts one at a time: AgentX could not read your workspace limits." } : {}) };
  }
}

/** The parts setting alone (see `parallelPartsDecision`). */
export async function parallelPartsForTask(deps: ParallelPartsDependencies, task: Parameters<typeof parallelPartsDecision>[1]): Promise<WorkflowParallel | undefined> {
  return (await parallelPartsDecision(deps, task)).parallel;
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
