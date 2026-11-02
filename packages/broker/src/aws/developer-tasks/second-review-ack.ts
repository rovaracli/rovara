// Second review (SR-1, switch `cr`): the task owner acknowledges that an `on` second review did not run, so the merge may go ahead. `POST /v1/app/tasks/{id}/second-review-acknowledge { candidateDigest }` (the web app reaches it as `/v1/web/tasks/{id}/second-review-acknowledge`).
// Owner only (the task's effective owner, as every owner decision), from a live browser session only (the entry file refuses a token before this, and so does this), audited in the same transaction as the write.
// The acknowledgement is one key per candidate and reason (`secondReviewAcknowledgement`): a new candidate asks again. Rovara opens pull requests as drafts and never marks them ready, so the gate is the merge
// card (`secondReviewMergeWait` in rovara-code/merge.ts), which refuses a Merge until this is done.
import { randomUUID } from "node:crypto";
import { TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import { agentXError, auditEventId, type AuditEventInput } from "@agentx/contracts";
import { flushAuditEvents } from "../../audit/flush.js";
import { auditPending } from "../../audit/outbox.js";
import { taskKey } from "../../developer/task-records.js";
import { secondReviewAcknowledgement } from "../../rovara-code/second-review.js";
import { secondOpinionOfTask } from "../../rovara-code/second-review-store.js";
import { secondReviewEnabled } from "../../rovara-code/second-review-switch.js";
import type { DeveloperCaller } from "../developer-routes.js";
import { isConditional } from "../broker-shared.js";
import { accessFence, authorizeTaskAction } from "./access.js";
import { iso, parse } from "./common.js";
import { syncIndex } from "./task-index.js";
import { taskView } from "./task-view.js";
import type { DeveloperTaskRouteDependencies } from "./types.js";
import type { DeveloperTaskView } from "@agentx/contracts";

export const SECOND_REVIEW_ACK_BROWSER_MESSAGE = "Use a live browser session to acknowledge that the second review did not run.";
const BodySchema = z.object({ candidateDigest: z.string().regex(/^[a-f0-9]{64}$/u) }).strict();

export async function acknowledgeSecondReview(deps: DeveloperTaskRouteDependencies, caller: DeveloperCaller, taskId: string, value: unknown): Promise<{ task: DeveloperTaskView }> {
  if (!secondReviewEnabled()) throw agentXError("NOT_FOUND", "route not found");
  if (caller.browserSession !== true) throw agentXError("FORBIDDEN", SECOND_REVIEW_ACK_BROWSER_MESSAGE);
  const request = parse(BodySchema, value, deps, "workflow-second-review-acknowledge");
  // Only the task's owner decides; the same authority every owner decision uses.
  const access = await authorizeTaskAction(deps, caller, taskId, "decide");
  const { task } = access;
  const digest = task.workflow?.candidate?.digest;
  if (digest === undefined || digest !== request.candidateDigest) throw agentXError("IDEMPOTENCY_CONFLICT", "this is out of date; refresh the task and try again");
  const opinion = secondOpinionOfTask(task, digest);
  const ack = opinion === undefined ? { required: false as const } : secondReviewAcknowledgement(opinion, digest);
  if (!ack.required) throw agentXError("CONFIG_INVALID", "there is no second review that did not run to acknowledge for this code");
  if ((task.secondReviewAcknowledged ?? []).includes(ack.key)) return { task: await taskView(deps, task, { events: 0, details: false }) };
  const ledger = deps.learningAudit;
  // With no ledger the acknowledgement is refused: a merge gate is never opened without a record.
  if (ledger === undefined) throw agentXError("AUDIT_UNAVAILABLE", "This needs the audit ledger.");
  const now = iso(deps);
  const event: AuditEventInput = {
    eventId: auditEventId("task.second_review_acknowledged", taskId, now, caller.developerId, randomUUID()), orgId: caller.orgId, action: "task.second_review_acknowledged", actor: { kind: "member", id: caller.developerId },
    target: { kind: "task", id: taskId }, occurredAt: now, facts: { cause: opinion?.unavailableReason ?? "no-answer" },
  };
  const put = auditPending({ audit: ledger }, event)[0]?.Put;
  if (put === undefined) throw agentXError("AUDIT_UNAVAILABLE", "This needs the audit ledger.");
  try {
    await deps.documentClient.send(new TransactWriteCommand({ TransactItems: [
      { Update: { TableName: deps.tableName, Key: taskKey(taskId), UpdateExpression: "SET secondReviewAcknowledged = list_append(if_not_exists(secondReviewAcknowledged, :none), :key), updatedAt = :now",
        ConditionExpression: "workflow.candidate.digest = :digest AND secondOpinion.candidateDigest = :digest AND attribute_not_exists(closedAt)",
        ExpressionAttributeValues: { ":none": [], ":key": [ack.key], ":now": now, ":digest": digest } } },
      accessFence(deps, access), { Put: put },
    ] }));
  } catch (error) {
    if (isConditional(error)) throw agentXError("IDEMPOTENCY_CONFLICT", "this is out of date; refresh the task and try again");
    throw error;
  }
  await flushAuditEvents({ audit: ledger }, [event]);
  const fresh = (await authorizeTaskAction(deps, caller, taskId, "decide")).task;
  const view = await taskView(deps, fresh, { events: 0, details: false });
  await syncIndex(deps, fresh, view.status, view.updatedAt);
  return { task: view };
}
