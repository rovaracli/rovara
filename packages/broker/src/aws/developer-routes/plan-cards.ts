// Decision journey slice 2: the requirements and the coding plan as decision cards, decided on the card (Approve, Request changes) through the ONE workflow decision Slack, MCP and the task page use
// (`decideTaskWorkflow`), so the authority, the replay rule, the work breakdown binding and the run limit are its own. Nothing here decides who may act.
//   source   the caller's own tasks waiting on their requirements or their coding plan (PLAN_REVIEW/WAITING), one card each. A design waits on the design review's card (`design-review.ts`); a plan
//            held for an E2E correction has no card (its Approve is refused until the plan is corrected; the task page says why).
//   approve  low and medium through the card route; HIGH on the card on the task page, where the handler asks for a browser session and a recent sign-in itself (REAUTH_REQUIRED otherwise).
//            The coding plan's card carries the run limit approving sets: a raise is ticked on the card and sent as `acknowledgedRunLimitUsd` (the workflow decision refuses a raise without it).
//   request changes   the workflow decision's REQUEST_CHANGES with the person's reason, for requirements, a coding plan and a design alike (a design's Approve stays the design review's).
// The requirements and design pair card (project.ts `pairCards`) forms only when both documents wait at once; today's Full flow asks for them one after the other, so this source never yields both.
import { GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { agentXError, planClaimCount, taskGraphDigest, type WorkflowArtifact, type WorkflowSnapshot } from "@agentx/contracts";
import { isE2EPlanCorrectionBlockReason, taskKey, type DeveloperTaskRecord } from "../../developer/task-records.js";
import { AgentSessionStore } from "../../agent-sessions/store.js";
import { taskOpenPath } from "../../decisions/open-path.js";
import type { DecisionItem } from "../../decisions/project.js";
import { perform, type KindHandler } from "../../decisions/performer.js";
import type { PerformInput } from "../../decisions/routes.js";
import { freshSignInOf } from "../../design-review/route-facts.js";
import { loadWorkflowDocument } from "../../developer/plan-artifacts.js";
import { planRunLimit } from "../../spend/estimate.js";
import { estimateDependencies } from "../developer-tasks/common.js";
import { decideTaskWorkflow } from "../developer-tasks/decide.js";
import { developerTaskRouteDependencies } from "./dependencies.js";
import type { DeveloperCaller, DeveloperRouteDependencies } from "./types.js";

const OWN_TASKS_MAX = 50;
type DocumentType = "requirements" | "plan" | "design";

/** What a Request changes or an Approve of a design is refused with when the card's sign-in is not recent (high only). */
export const PLAN_CARD_REAUTH_MESSAGE = "Sign in again to approve this. A high-risk decision needs a sign-in within the last 10 minutes.";
/** Said on the card about what an Approve here takes (as Slack's Approve does): the plan's recommended answers and the open comments. */
const TAKES = "Approving here takes Rovara's recommended answer to each decision in the plan and the open comments (up to 25). To answer them yourself, use the plan review page.";

/** The document a task waits on, by the workflow's own fields. */
export function waitingDocument(workflow: Pick<WorkflowSnapshot, "stage" | "state" | "path" | "reviewPhase">): DocumentType | undefined {
  if (workflow.stage !== "PLAN_REVIEW" || workflow.state !== "WAITING") return undefined;
  if (workflow.path !== "FULL") return "plan";
  return workflow.reviewPhase === "REQUIREMENTS" ? "requirements" : workflow.reviewPhase === "DESIGN" ? "design" : "plan";
}

const latestOf = (workflow: WorkflowSnapshot, type: DocumentType): WorkflowArtifact | undefined => workflow.artifacts.filter((artifact) => artifact.type === type).at(-1);

async function ownTaskIds(deps: DeveloperRouteDependencies, caller: DeveloperCaller): Promise<string[]> {
  const response = await deps.documentClient.send(new QueryCommand({
    TableName: deps.tableName, KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)", ExpressionAttributeValues: { ":pk": `DEVELOPER#${caller.developerId}`, ":prefix": "TASK#" }, ScanIndexForward: false, Limit: OWN_TASKS_MAX, ConsistentRead: true,
  })) as { Items?: Array<{ taskId?: string; orgId?: string; status?: string }> };
  return (response.Items ?? []).filter((row) => row.orgId === caller.orgId && row.status !== "CLOSED" && typeof row.taskId === "string").map((row) => row.taskId!);
}

async function loadTask(deps: DeveloperRouteDependencies, taskId: string): Promise<DeveloperTaskRecord | undefined> {
  return ((await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: taskKey(taskId), ConsistentRead: true }))) as { Item?: DeveloperTaskRecord }).Item;
}

/** The task's page: its own session when the record has it, a chain step's through the store, else its project. */
export async function taskPagePathOf(deps: DeveloperRouteDependencies, orgId: string, task: DeveloperTaskRecord): Promise<string> {
  if (task.sessionId !== undefined || deps.agentSessions === undefined) return taskOpenPath(task);
  try {
    const session = await new AgentSessionStore({ documentClient: deps.documentClient, tableName: deps.tableName } as never).getForTask(orgId, task);
    return taskOpenPath({ project: task.project, ...(session === undefined ? {} : { sessionId: session.sessionId }) });
  } catch { return taskOpenPath(task); }
}

const reader = (deps: DeveloperRouteDependencies, caller: DeveloperCaller) => {
  const actions = developerTaskRouteDependencies(deps, caller).actions;
  return (objectKey: string, maxBytes: number) => actions.readArtifact(objectKey, maxBytes).catch(() => undefined);
};

/** The card item for one task, or undefined when it waits on nothing a card here decides. */
async function itemOf(deps: DeveloperRouteDependencies, caller: DeveloperCaller, task: DeveloperTaskRecord): Promise<DecisionItem | undefined> {
  const workflow = task.workflow;
  if (workflow === undefined || task.orgId !== caller.orgId || task.closedAt !== undefined) return undefined;
  const type = waitingDocument(workflow);
  if (type === undefined || type === "design" || isE2EPlanCorrectionBlockReason(workflow.blockReason)) return undefined;
  const artifact = latestOf(workflow, type);
  if (artifact === undefined) return undefined;
  const loaded = await loadWorkflowDocument(reader(deps, caller), artifact, {}).catch(() => undefined);
  const claims = loaded?.format === "structured" ? planClaimCount(loaded.plan) : 0;
  const base = {
    subjectId: task.taskId, taskId: task.taskId, project: task.project, title: task.title, createdAt: workflow.updatedAt ?? new Date(deps.now()).toISOString(),
    openPath: await taskPagePathOf(deps, caller.orgId, task), contentVersion: artifact.sha256,
  };
  if (type === "requirements") return { ...base, kind: "approve_requirements", claims };
  const estimate = task.runEstimate;
  let proposedUsd: number | undefined;
  try { proposedUsd = await planRunLimit(estimateDependencies(developerTaskRouteDependencies(deps, caller)), task); } catch { proposedUsd = estimate?.runLimitUsd; }
  return {
    ...base, kind: "approve_plan", path: workflow.path === "FULL" ? "full" : "quick", files: [], claims, untestedClaims: 0,
    ...(estimate === undefined ? {} : { cost: { lowUsd: estimate.lowUsd, highUsd: estimate.highUsd, ...(estimate.minutes === undefined ? {} : { minutes: estimate.minutes }) } }),
    ...(proposedUsd === undefined ? {} : { runLimit: { proposedUsd, ...(task.budgetUsd === undefined ? {} : { currentUsd: task.budgetUsd }) } }),
    details: [{ title: "What Approve takes", lines: [TAKES] }],
  };
}

/** The requirements and coding plan cards of the caller's own tasks. A task that cannot be read is left out. */
export async function planCardItemsFor(deps: DeveloperRouteDependencies, caller: DeveloperCaller): Promise<DecisionItem[]> {
  const found: DecisionItem[] = [];
  for (const taskId of await ownTaskIds(deps, caller)) {
    try {
      const task = await loadTask(deps, taskId);
      const item = task === undefined ? undefined : await itemOf(deps, caller, task);
      if (item !== undefined) found.push(item);
    } catch { /* a task that cannot be read is not a card */ }
  }
  return found;
}

const TYPE_OF: Partial<Record<DecisionItem["kind"], DocumentType>> = { approve_requirements: "requirements", approve_plan: "plan", approve_design: "design" };

/** The task and the document the card was drawn from, as they are now; "stale" when the document moved on (a new version, a decision made elsewhere). */
async function current(deps: DeveloperRouteDependencies, caller: DeveloperCaller, input: PerformInput): Promise<{ task: DeveloperTaskRecord; workflow: WorkflowSnapshot; artifact: WorkflowArtifact } | "stale"> {
  const type = TYPE_OF[input.item.kind];
  const taskId = input.item.taskId;
  if (type === undefined || taskId === undefined) return "stale";
  const task = await loadTask(deps, taskId);
  const workflow = task?.workflow;
  if (task === undefined || workflow === undefined || task.orgId !== caller.orgId || waitingDocument(workflow) !== type) return "stale";
  const artifact = latestOf(workflow, type);
  // The card's content version starts with the document's digest (a design's adds what its review found, after a colon).
  if (artifact === undefined || !(input.item.contentVersion === artifact.sha256 || input.item.contentVersion.startsWith(`${artifact.sha256}:`))) return "stale";
  return { task, workflow, artifact };
}

/** Approve and Request changes of a requirements or coding plan card. */
export function planCardHandler(deps: DeveloperRouteDependencies, caller: DeveloperCaller): KindHandler<DeveloperCaller> {
  return {
    approve: (who, input) => perform(async () => {
      const now = await current(deps, who, input);
      if (now === "stale") return { kind: "refused", reason: "stale" };
      // High: decided on the card on the task page with a recent sign-in, never by a token or a click from elsewhere.
      if (input.card.risk === "high") {
        if (who.browserSession !== true) throw agentXError("FORBIDDEN", "Decide this in the Rovara app.");
        const fresh = await freshSignInOf({ documentClient: deps.documentClient, tableName: deps.tableName, signInTableName: deps.developer.signInTableName, now: deps.now }, who);
        if (!fresh) throw agentXError("REAUTH_REQUIRED", PLAN_CARD_REAUTH_MESSAGE);
      }
      // The work breakdown the approval binds to is the one in the document the card was drawn from (the workflow decision checks it again).
      const loaded = now.artifact.type === "plan" ? await loadWorkflowDocument(reader(deps, caller), now.artifact, {}).catch(() => undefined) : undefined;
      const breakdown = loaded?.format === "structured" && loaded.plan.workBreakdown !== undefined ? taskGraphDigest(loaded.plan.workBreakdown) : undefined;
      await decideTaskWorkflow(developerTaskRouteDependencies(deps, who), who, now.task.taskId, {
        requestId: input.requestId, expectedRevision: now.workflow.revision, decision: "APPROVE", artifactDigest: now.artifact.sha256, reason: "Approved on its card in Rovara.",
        ...(breakdown === undefined ? {} : { workBreakdownDigest: breakdown }),
        ...(input.acknowledgedRunLimitUsd === undefined ? {} : { acknowledgedRunLimitUsd: input.acknowledgedRunLimitUsd }),
      });
      return { kind: "done" };
    }),
    requestChanges: (who, input) => requestChanges(deps, who, input),
  };
}

/** Request changes for any document card (requirements, coding plan, design): the workflow decision's REQUEST_CHANGES with the person's reason, as Slack and the task page send it. */
export function requestChanges(deps: DeveloperRouteDependencies, who: DeveloperCaller, input: PerformInput & { reason: string }) {
  return perform(async () => {
    const now = await current(deps, who, input);
    if (now === "stale") return { kind: "refused", reason: "stale" };
    await decideTaskWorkflow(developerTaskRouteDependencies(deps, who), who, now.task.taskId, {
      requestId: input.requestId, expectedRevision: now.workflow.revision, decision: "REQUEST_CHANGES", artifactDigest: now.artifact.sha256, reason: input.reason,
    });
    return { kind: "done" };
  });
}
