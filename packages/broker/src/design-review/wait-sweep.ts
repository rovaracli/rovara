// Design review stage, DR10 (design-review-stage.md 3.7, owner Q5): the sweep for design reviews that wait on people. The wait rows (`wait-rows.ts`, armed from the table's stream) say which tasks have something due; for each,
// the sweep reads the TASK again (never trusting the row), works out what is due from the workflow alone (`wait-clock.ts`), and does exactly one of:
//   - a reminder at 24 h and at 72 h: a NOTIFY row (once; `attribute_not_exists`) that the notifier turns into a notice (`design_wait`);
//   - at 7 days: `parkDesignReview`, with the model keys of the task's design-review rounds blocked and finalized first (what they held is dropped) and a "parked" notice, in one commit;
//   - at 30 days parked: `closeParkedDesignReview`, the task's release mark and a "closed" notice, in one commit.
// NOTHING HERE APPROVES, ANSWERS OR SKIPS. The moves it makes record no decision. With the `dr` switch off, the company not allowing design review, or the project Off, it does nothing new for the task: no reminder, no park, no close (the row is looked at
// again in an hour). The one exception is the cost hold, parked or not, which is ended the way every other step of a switched-off review is (B2-m3): not run, `switched_off`, and the design goes to the person's card. A wait for answers cannot be
// ended by anyone but the person (`closeDesignReview` refuses it); their answer reaches the planner's step, which ends the review as `switched_off` itself. A design card already waits for the person.
import { QueryCommand, TransactWriteCommand, UpdateCommand, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { WORKFLOW_DISPATCH_DUE_INDEX, WorkflowSnapshotSchema, closeDesignReview, closeParkedDesignReview, parkDesignReview, type EditionPolicy, type OrgId, type WorkflowSnapshot } from "@agentx/contracts";
import { finishedReleaseMarkItem } from "../aws/developer-tasks/release.js";
import { effectiveTaskOwner, taskKey, type DeveloperTaskRecord } from "../developer/task-records.js";
import type { DesignApproverDirectory } from "./approval.js";
import { DESIGN_REVIEW_FAIL_CLOSED_SETTING, markEffective, type EffectiveDesignReviewSetting } from "./effective-setting.js";
import { designWaitStep, nextDesignWaitDueAt, noticeStepOf, type DesignWaitNoticeStep } from "./wait-clock.js";
import { waitAudienceOf, waitRecipients } from "./wait-audience.js";
import { DESIGN_WAIT_DUE_PK, designWaitNotifyPut, designWaitReschedule, type DesignWaitNotify, type WaitPerson } from "./wait-rows.js";

type Client = { send(command: unknown): Promise<unknown> };

export interface DesignWaitSweepDeps {
  documentClient: Client;
  tableName: string;
  now(): number;
  /** The switch: `dr` on, the company allows it and the project is not Off (a review the person asked for needs only the first two). Off: nothing new is done for the task. With `dr` off it reads nothing. */
  enabledFor(orgId: OrgId, project: string, decidedBy: string | undefined): Promise<boolean>;
  /** The project's setting held to the company's lock. A read that fails is answered with the strictest posture here, never a guess. */
  setting(orgId: OrgId, project: string): Promise<EffectiveDesignReviewSetting>;
  /** Who is a member, a maintainer or an owner now; undefined when it cannot be read (the requester alone is told). */
  directory(input: { orgId: OrgId; project: string; requesterId: string }): Promise<DesignApproverDirectory | undefined>;
  edition: EditionPolicy | undefined;
  /** Display names and Slack ids of people, by developer id. A person who cannot be found is left out. */
  people(orgId: OrgId, ids: readonly string[]): Promise<ReadonlyMap<string, WaitPerson>>;
  /**
   * Blocks and finalizes the model keys of the task's design-review rounds up to round `throughRound` (the rounds recorded when the task was read) and drops what they held. A round numbered above that began after the read
   * (a spend choice landed and the next round started): its keys are not this sweep's to close (ON-8). Idempotent; never throws.
   */
  releaseKeys(task: DeveloperTaskRecord, throughRound: number): Promise<void>;
  log(entry: Record<string, unknown>): void;
}

export type DesignWaitSweepOutcome = "off" | "none" | "reminded" | "already_sent" | "parked" | "closed" | "stale" | "gone";

export const DESIGN_WAIT_SWEEP_LIMIT = 25;
/** A switched-off task's row is looked at again after this long, so turning the switch on picks it up without another event. */
const OFF_RECHECK_MS = 60 * 60 * 1000;
const TASK_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const isConditional = (error: unknown): boolean => error instanceof Error && (error.name === "ConditionalCheckFailedException" || error.name === "TransactionCanceledException");

/** Up to 25 due waits, oldest due first, each settled once. Never throws for one task: a task that fails is logged by code and looked at again next time. */
export async function sweepDesignWaits(deps: DesignWaitSweepDeps): Promise<{ attempted: number; reminded: number; parked: number; closed: number }> {
  const page = await deps.documentClient.send(new QueryCommand({
    TableName: deps.tableName, IndexName: WORKFLOW_DISPATCH_DUE_INDEX.name,
    KeyConditionExpression: `${WORKFLOW_DISPATCH_DUE_INDEX.partitionKey} = :pk AND ${WORKFLOW_DISPATCH_DUE_INDEX.sortKey} BETWEEN :from AND :due`,
    // ":" sorts after the "#" that follows each due time, so `${now}:` includes every row due at or before now.
    ExpressionAttributeValues: { ":pk": DESIGN_WAIT_DUE_PK, ":from": "0", ":due": `${new Date(deps.now()).toISOString()}:` }, Limit: DESIGN_WAIT_SWEEP_LIMIT,
  })) as { Items?: Array<Record<string, unknown>> };
  const rows = page.Items ?? [];
  const counts = { attempted: rows.length, reminded: 0, parked: 0, closed: 0 };
  for (const row of rows) {
    const taskId = typeof row["taskId"] === "string" && TASK_ID.test(row["taskId"]) ? row["taskId"] : undefined;
    if (taskId === undefined) continue;
    try {
      const outcome = await settleDesignWait(deps, taskId, typeof row["workflowRevision"] === "number" ? row["workflowRevision"] : 0);
      if (outcome === "reminded") counts.reminded += 1;
      else if (outcome === "parked") counts.parked += 1;
      else if (outcome === "closed") counts.closed += 1;
    } catch (error) {
      deps.log({ event: "design_review.wait_sweep_failed", taskId, error: error instanceof Error ? error.name : "unknown" });
    }
  }
  return counts;
}

async function reschedule(deps: DesignWaitSweepDeps, taskId: string, revision: number, dueAtMs: number | undefined): Promise<void> {
  try {
    await deps.documentClient.send(new UpdateCommand(designWaitReschedule(deps.tableName, taskId, revision, dueAtMs) as ConstructorParameters<typeof UpdateCommand>[0]));
  } catch (error) {
    // A newer arm (the workflow moved meanwhile) has set the row; it is not ours to overwrite.
    if (!isConditional(error)) throw error;
  }
}

/** One due wait: what the task is doing now decides everything; the row only said it was time to look. */
export async function settleDesignWait(deps: DesignWaitSweepDeps, taskId: string, rowRevision: number): Promise<DesignWaitSweepOutcome> {
  const nowMs = deps.now();
  const nowIso = new Date(nowMs).toISOString();
  const task = (await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: taskKey(taskId), ConsistentRead: true })) as { Item?: DeveloperTaskRecord }).Item;
  const parsed = task?.workflow === undefined ? undefined : WorkflowSnapshotSchema.safeParse(task.workflow);
  if (task === undefined || task.orgId === undefined || task.closedAt !== undefined || parsed === undefined || !parsed.success) {
    await reschedule(deps, taskId, rowRevision, undefined);
    return "gone";
  }
  const workflow: WorkflowSnapshot = parsed.data;
  const due = designWaitStep(workflow, nowMs);
  if (due === undefined) {
    await reschedule(deps, taskId, Math.max(rowRevision, workflow.revision), undefined);
    return "gone";
  }
  const { wait, step } = due;
  if (!(await deps.enabledFor(task.orgId, task.project, workflow.designReview?.decidedBy))) {
    // The cost hold only waits for a spending choice for a review that is no longer to run: end it as every step does when the switch is off. A PARKED hold too (ON-7): it would otherwise be looked at every hour for ever.
    if (wait.kind === "cost") {
      const ended = closeDesignReview(workflow, { expectedRevision: workflow.revision, outcome: "not_run", notRunReason: "switched_off", now: nowIso });
      try {
        await deps.documentClient.send(new UpdateCommand({
          TableName: deps.tableName, Key: taskKey(taskId), UpdateExpression: "SET workflow = :workflow, updatedAt = :now",
          ConditionExpression: "workflow.revision = :revision AND attribute_not_exists(closedAt)",
          ExpressionAttributeValues: { ":workflow": ended, ":now": nowIso, ":revision": workflow.revision },
        }));
      } catch (error) {
        if (!isConditional(error)) throw error;
        return "stale";
      }
      await reschedule(deps, taskId, ended.revision, nowMs + OFF_RECHECK_MS);
      deps.log({ event: "design_review.wait_switched_off", taskId });
      return "off";
    }
    await reschedule(deps, taskId, Math.max(rowRevision, workflow.revision), nowMs + OFF_RECHECK_MS);
    return "off";
  }
  if (step.kind === "none") {
    await reschedule(deps, taskId, workflow.revision, nextDesignWaitDueAt(wait, nowMs));
    return "none";
  }
  const noticeStep = noticeStepOf(step);
  if (step.kind === "remind") {
    const notify = await notifyOf(deps, task, workflow, wait.kind, noticeStep, workflow.revision, nowIso);
    try {
      await deps.documentClient.send(new PutCommand(designWaitNotifyPut(deps.tableName, notify).Put));
    } catch (error) {
      if (!isConditional(error)) throw error;
      // Sent on an earlier sweep: once only.
      await reschedule(deps, taskId, workflow.revision, nextDesignWaitDueAt(wait, nowMs));
      return "already_sent";
    }
    await reschedule(deps, taskId, workflow.revision, nextDesignWaitDueAt(wait, nowMs));
    deps.log({ event: "design_review.wait_reminded", taskId, step: noticeStep, wait: wait.kind });
    return "reminded";
  }
  // Park and close both end the task's use of its model keys for good: they are released first (idempotent), so a commit that loses a race has still left nothing live.
  await deps.releaseKeys(task, workflow.designReview?.rounds.length ?? 0);
  const next = step.kind === "park"
    ? parkDesignReview(workflow, { expectedRevision: workflow.revision, now: nowIso })
    : closeParkedDesignReview(workflow, { expectedRevision: workflow.revision, now: nowIso });
  const notify = await notifyOf(deps, task, workflow, wait.kind, noticeStep, next.revision, nowIso);
  try {
    await deps.documentClient.send(new TransactWriteCommand({ TransactItems: [
      { Update: {
        TableName: deps.tableName, Key: taskKey(taskId), UpdateExpression: "SET workflow = :workflow, updatedAt = :now",
        ConditionExpression: "workflow.revision = :revision AND attribute_not_exists(closedAt)",
        ExpressionAttributeValues: { ":workflow": next, ":now": nowIso, ":revision": workflow.revision },
      } },
      designWaitNotifyPut(deps.tableName, notify),
      ...(step.kind === "close" ? [finishedReleaseMarkItem(deps.tableName, taskId, nowIso)] : []),
    ] as ConstructorParameters<typeof TransactWriteCommand>[0]["TransactItems"] }));
  } catch (error) {
    // The task moved (a person answered or decided meanwhile): theirs is the newer word, and the stream has re-armed the row.
    if (!isConditional(error)) throw error;
    return "stale";
  }
  const after = designWaitStep(next, nowMs);
  await reschedule(deps, taskId, next.revision, after === undefined ? undefined : nextDesignWaitDueAt(after.wait, nowMs));
  deps.log({ event: step.kind === "park" ? "design_review.wait_parked" : "design_review.wait_closed", taskId, wait: wait.kind });
  return step.kind === "park" ? "parked" : "closed";
}

/** The NOTIFY row's content for a step: whom the wait is on and whom to tell, read fresh. A directory or a setting that cannot be read tells the requester alone. */
async function notifyOf(deps: DesignWaitSweepDeps, task: DeveloperTaskRecord, workflow: WorkflowSnapshot, kind: "answers" | "cost" | "decision", step: DesignWaitNoticeStep, revision: number, at: string): Promise<DesignWaitNotify> {
  const orgId = task.orgId as OrgId;
  const owner = effectiveTaskOwner(task);
  const [setting, directory] = await Promise.all([
    deps.setting(orgId, task.project).catch(() => markEffective(DESIGN_REVIEW_FAIL_CLOSED_SETTING)),
    deps.directory({ orgId, project: task.project, requesterId: owner.developerId }).catch(() => undefined),
  ]);
  const audience = waitAudienceOf({ kind, requesterId: owner.developerId, reasons: workflow.designReview?.reasons ?? [], setting, directory, edition: deps.edition });
  const recipients = waitRecipients(audience, step, owner.developerId);
  const known = await deps.people(orgId, [...new Set([...recipients, ...audience.asked])]).catch(() => new Map<string, WaitPerson>());
  const personOf = (id: string): WaitPerson => id === owner.developerId
    ? { name: owner.name, slackUserId: owner.slackUserId ?? known.get(id)?.slackUserId }
    : known.get(id) ?? { name: "A teammate" };
  const dm = [...new Set(recipients.map((id) => personOf(id).slackUserId).filter((id): id is string => typeof id === "string" && id !== ""))];
  return { taskId: task.taskId, workflowRevision: revision, step, waitKind: kind, audience: audience.code, asked: audience.asked.map(personOf), dm, at };
}
