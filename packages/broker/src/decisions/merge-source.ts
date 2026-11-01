// Decision cards (wire-proof): the merge cards of a person's own tasks. A task's pull requests wait for its owner at WAIT_FOR_MERGE; each such task whose pull requests are all tracked, open and out of draft is
// one `merge` item, built from what tracking stored (the same heads, risk and checks the Merge button's own readiness reads), never from model text. Only a task the person OWNS now (the effective owner) gets
// a card; the press goes through `pressMerge`, which checks the person's authority and the readiness again and refuses a head that moved since the card. A task with anything unknown about it is left out: a card
// that cannot say what it is merging is not shown (it fails closed).
import { createHash } from "node:crypto";
import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import { workflowFindingAccepted, type MergeTrackingItem, type WorkflowSnapshot } from "@agentx/contracts";
import { tryEffectiveTaskOwner, type DeveloperTaskRecord } from "../developer/task-records.js";
import { riskOfTask } from "../rovara-code/merge.js";
import { proofCheckResults } from "../rovara-code/proof-section.js";
import type { DecisionItem } from "./project.js";

/** The most of a person's task-list rows read, so one listing is bounded. */
export const MERGE_SOURCE_ROWS_MAX = 50;

export interface MergeSourcePorts {
  documentClient: { send(command: unknown): Promise<unknown> };
  tableName: string;
  /** The id of the task's session, or undefined when it has none the caller's org can read. */
  sessionIdOf(task: DeveloperTaskRecord): Promise<string | undefined>;
  task(taskId: string): Promise<DeveloperTaskRecord | undefined>;
  tracking(taskId: string, orgId: string): Promise<readonly MergeTrackingItem[]>;
  now(): number;
}

const sha = (text: string): string => createHash("sha256").update(text).digest("hex").slice(0, 24);

/** The reviews of the current code in one word: every review passed, or one has findings nobody accepted, or there are none. */
export function reviewVerdictOf(workflow: WorkflowSnapshot): "approved" | "concerns" | "none" {
  const digest = workflow.candidate?.digest;
  const current = (workflow.reviews ?? []).filter((review) => review.candidateDigest === digest);
  if (current.length === 0) return "none";
  const open = current.some((review) => review.status !== "PASS" && !(review.status === "FINDINGS" && review.findings.every((finding) => workflowFindingAccepted(workflow, review.role, finding))));
  return open ? "concerns" : "approved";
}

/** The merge item for one task, or undefined when it cannot be said what merging it would do. Pure over what the ports read. */
export function mergeItemOf(task: DeveloperTaskRecord, workflow: WorkflowSnapshot, items: readonly MergeTrackingItem[], sessionId: string | undefined, nowIso: string): DecisionItem | undefined {
  if (sessionId === undefined || task.closedAt !== undefined || task.releasedAt !== undefined || workflow.definitionVersion !== "1.1.0") return undefined;
  if (workflow.stage !== "WAIT_FOR_MERGE" || workflow.state !== "WAITING") return undefined;
  const required = (workflow.pullRequests ?? []).filter((entry) => entry.required && entry.state !== "MERGED");
  if (required.length === 0) return undefined;
  const tracked = required.map((entry) => items.find((item) => item.repositoryId === entry.repositoryId && item.number === entry.number));
  // Every required pull request must be read, open and out of draft; otherwise the card would describe something other than what a press merges.
  if (tracked.some((item) => item === undefined || item.state !== "open" || item.draft)) return undefined;
  const unmerged = tracked as MergeTrackingItem[];
  const risk = riskOfTask(workflow, unmerged);
  const results = proofCheckResults(workflow);
  const passed = results.filter((result) => result.status === "PASS").length;
  const failed = results.filter((result) => result.status === "FAILED").length;
  const unknown = results.length - passed - failed;
  const ci = unmerged.some((item) => item.ci === "failing") ? "failing" as const : unmerged.some((item) => item.ci === "pending") ? "pending" as const : "passing" as const;
  const unaccepted = (workflow.reviews ?? []).filter((review) => review.candidateDigest === workflow.candidate?.digest && review.role === "SECURITY")
    .reduce((sum, review) => sum + review.findings.filter((finding) => !workflowFindingAccepted(workflow, review.role, finding)).length, 0);
  const heads = unmerged.map((item) => ({ repositoryId: item.repositoryId, number: item.number, headSha: item.headSha }));
  return {
    kind: "merge", subjectId: task.taskId, taskId: task.taskId, project: task.project, title: task.title, createdAt: workflow.updatedAt ?? nowIso,
    openPath: `/app/sessions/${sessionId}`,
    // What version of the thing decided on this is: the heads, the risk and the recorded checks. Any change makes an earlier "evidence opened" worthless.
    contentVersion: sha(JSON.stringify({ heads, risk, rev: workflow.revision, digest: workflow.candidate?.digest, ci })),
    sessionId, heads, prRisk: risk.level, prReasons: risk.reasons,
    proof: { proven: 0, passed, failed, notTested: unknown },
    reviewVerdict: reviewVerdictOf(workflow), ci, securityFindingsHigh: unaccepted, fullSuitePending: false,
  };
}

/** The merge items for the person's own tasks. Reads at most `MERGE_SOURCE_ROWS_MAX` rows; a task or a session that cannot be read is left out. */
export async function mergeItemsFor(ports: MergeSourcePorts, caller: { orgId: string; developerId: string }): Promise<DecisionItem[]> {
  const response = await ports.documentClient.send(new QueryCommand({
    TableName: ports.tableName, KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)", ExpressionAttributeValues: { ":pk": `DEVELOPER#${caller.developerId}`, ":prefix": "TASK#" },
    ScanIndexForward: false, Limit: MERGE_SOURCE_ROWS_MAX, ConsistentRead: true,
  })) as { Items?: Array<{ taskId?: string; orgId?: string; status?: string }> };
  const nowIso = new Date(ports.now()).toISOString();
  const found: DecisionItem[] = [];
  for (const row of response.Items ?? []) {
    if (row.orgId !== caller.orgId || row.status === "CLOSED" || typeof row.taskId !== "string") continue;
    try {
      const task = await ports.task(row.taskId);
      if (task === undefined || task.orgId !== caller.orgId || task.workflow === undefined || tryEffectiveTaskOwner(task)?.developerId !== caller.developerId) continue;
      const waiting = task.workflow.stage === "WAIT_FOR_MERGE" && task.workflow.state === "WAITING";
      if (!waiting) continue;
      const item = mergeItemOf(task, task.workflow, await ports.tracking(task.taskId, caller.orgId), await ports.sessionIdOf(task), nowIso);
      if (item !== undefined) found.push(item);
    } catch {
      // A task that cannot be read is not a card.
    }
  }
  return found;
}

