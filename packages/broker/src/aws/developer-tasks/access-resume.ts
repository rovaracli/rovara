import { randomUUID } from "node:crypto";
import { DeleteCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { agentXError, type DeveloperTaskView, WorkflowSnapshotSchema } from "@agentx/contracts";
import { aiToolTurn, taskKey } from "../../developer/task-records.js";
import { WORKFLOW_DISPATCH_PK, hashJson, isConditional, workflowDispatchItem, type WorkflowDispatchRecord } from "../broker-shared.js";
import type { DeveloperCaller } from "../developer-routes.js";
import { resumeTaskDispatch } from "../task-dispatch-access.js";
import type { DeveloperTaskRouteDependencies } from "./types.js";
import { get, iso, partyOfTaskActor, putNew, taskPageUrl, turnTable } from "./common.js";
import { type AuthorizedTask, accessFence, authorizeTaskAction } from "./access.js";
import { taskView } from "./task-view.js";
import { syncIndex } from "./task-index.js";
import { keptProposedIds } from "./workflow-inputs.js";
import { startTaskWorkflowReviewFromSystem } from "./workflow-review.js";
import { startTaskWorkflowPlanFromSystem, startTaskWorkflowUnderstandFromSystem } from "./workflow-starts.js";
import { startTaskWorkflowPublicationFromSystem } from "./publication.js";

export async function resumeParkedTaskDispatch(
  deps: DeveloperTaskRouteDependencies,
  caller: DeveloperCaller,
  access: AuthorizedTask,
  request: { requestId: string; expectedRevision?: number | undefined; candidateDigest?: string | undefined },
): Promise<{ task: DeveloperTaskView } | undefined> {
  // A task with no People sidecar is paused at revision 0 (only a project viewer's creator is, Plan 2, Task 21).
  {
    const resumed = await resumeTaskDispatch(deps, {
      task: access.task, peopleRevision: access.peopleRevision ?? 0, actorId: access.actorId,
      requestId: request.requestId, payloadHash: hashJson(request),
      reauthorize: async () => { await authorizeTaskAction(deps, caller, access.task.taskId, "retry"); },
    });
    if (resumed) return { task: await taskView(deps, access.task, { events: 0, details: false }) };
  }
  return resumeAccessPausedWorkflowDispatch(deps, caller, access, request);
}

interface WorkflowAccessRetryAudit {
  pk: string;
  sk: string;
  entityType: "WORKFLOW_ACCESS_RETRY";
  actorId: string;
  payloadHash: string;
  workflowRevision: number;
  kind: WorkflowDispatchRecord["kind"];
  candidateDigest: string;
  at: string;
}

/** An explicit current-owner action is the only transition out of a workflow dispatch access pause. */
async function resumeAccessPausedWorkflowDispatch(
  deps: DeveloperTaskRouteDependencies,
  caller: DeveloperCaller,
  access: AuthorizedTask,
  request: { requestId: string; expectedRevision?: number | undefined; candidateDigest?: string | undefined },
): Promise<{ task: DeveloperTaskView } | undefined> {
  if (request.expectedRevision === undefined || request.candidateDigest === undefined) return undefined;
  const auditKey = { pk: `DEVTASK#${access.task.taskId}`, sk: `WORKFLOW_ACCESS_RETRY#${request.requestId}` };
  const payloadHash = hashJson(request);
  let audit = await get<WorkflowAccessRetryAudit>(deps, auditKey);
  if (audit !== undefined) {
    if (audit.actorId !== access.actorId || audit.payloadHash !== payloadHash) {
      throw agentXError("IDEMPOTENCY_CONFLICT", "this request ID was already used for another retry");
    }
    await authorizeTaskAction(deps, caller, access.task.taskId, "retry");
    if (audit.kind === "CHECKS" && access.task.workflow?.e2e?.required === true) {
      return { task: await taskView(deps, access.task, { events: 0, details: false }) };
    }
  } else {
    const rowKey = { pk: WORKFLOW_DISPATCH_PK, sk: `${access.task.taskId}#${request.expectedRevision}` };
    const row = await get<WorkflowDispatchRecord & { taskAccessPausedAt?: string }>(deps, rowKey);
    if (row?.taskAccessPausedAt === undefined || row.candidateDigest !== request.candidateDigest) return undefined;
    const at = iso(deps);
    const current = access.task.workflow;
    if (row.kind === "CHECKS" && current?.e2e?.required === true) {
      if (current.stage !== "VERIFY" || current.state !== "WAITING" || current.revision !== row.workflowRevision
        || current.revision !== request.expectedRevision || current.candidate?.digest !== row.candidateDigest || current.checkPolicy === undefined) {
        return undefined;
      }
      const { blockReason: _blockReason, verification: _oldVerification, reviews: _oldReviews, ...workflowBase } = current;
      const { qualifiedRound: _qualifiedRound, failedRound: _failedRound, currentRoundId: _currentRoundId,
        currentGroupRunIds: _currentGroupRunIds, displayRef: _displayRef, ...unqualifiedE2E } = current.e2e;
      void _blockReason;
      void _oldVerification;
      void _oldReviews;
      void _qualifiedRound;
      void _failedRound;
      void _currentRoundId;
      void _currentGroupRunIds;
      void _displayRef;
      const selectedOptionalCheckIds = current.checkPolicy.selectedOptionalIds;
      const selectedProposedCheckIds = keptProposedIds(current.checkPolicy);
      const next = WorkflowSnapshotSchema.parse({
        ...workflowBase,
        revision: current.revision + 1,
        stage: "VERIFY",
        state: "WAITING",
        e2e: { ...unqualifiedE2E, currentGroupRunIds: [] },
        verificationRetries: [...(current.verificationRetries ?? []), {
          requestId: request.requestId, actorId: access.actorId, selectedOptionalCheckIds, selectedProposedCheckIds, at,
        }],
        updatedAt: at,
      });
      const freshAudit: WorkflowAccessRetryAudit = { ...auditKey, entityType: "WORKFLOW_ACCESS_RETRY", actorId: access.actorId,
        payloadHash, workflowRevision: next.revision, kind: "CHECKS", candidateDigest: row.candidateDigest, at };
      try {
        await deps.documentClient.send(new TransactWriteCommand({ TransactItems: [
          { ConditionCheck: {
            TableName: deps.tableName, Key: rowKey,
            ConditionExpression: "workflowRevision = :revision AND #kind = :kind AND candidateDigest = :candidate AND attribute_exists(taskAccessPausedAt)",
            ExpressionAttributeNames: { "#kind": "kind" },
            ExpressionAttributeValues: { ":revision": row.workflowRevision, ":kind": "CHECKS", ":candidate": row.candidateDigest },
          } },
          { Update: {
            TableName: deps.tableName, Key: taskKey(access.task.taskId),
            UpdateExpression: "SET workflow = :workflow, updatedAt = :now",
            ConditionExpression: "workflow.revision = :revision AND workflow.candidate.digest = :candidate AND workflow.#stage = :stage AND workflow.#state = :state AND workflow.e2e.required = :required AND attribute_not_exists(closedAt)",
            ExpressionAttributeNames: { "#stage": "stage", "#state": "state" },
            ExpressionAttributeValues: { ":workflow": next, ":now": at, ":revision": current.revision, ":candidate": row.candidateDigest,
              ":stage": "VERIFY", ":state": "WAITING", ":required": true },
          } },
          putNew(turnTable(deps), aiToolTurn({
            party: partyOfTaskActor(access.task, caller), turnId: randomUUID(), action: "continue", phase: "accepted", outcome: "accepted",
            receivedAt: at, finishedAt: iso(deps), request: "Resume access-paused required verification.",
            response: "The owner authorized a fresh verification admission after project access was restored.",
          })),
          workflowDispatchItem(deps.tableName, access.task.taskId, next.revision, "CHECKS", row.candidateDigest, at),
          accessFence(deps, access),
          { Put: { TableName: deps.tableName, Item: freshAudit, ConditionExpression: "attribute_not_exists(pk)" } },
        ] }));
      } catch (error) {
        if (!isConditional(error)) throw error;
        await authorizeTaskAction(deps, caller, access.task.taskId, "retry");
        const historical = await get<WorkflowAccessRetryAudit>(deps, auditKey);
        if (historical === undefined || historical.actorId !== access.actorId || historical.payloadHash !== payloadHash) {
          throw agentXError("IDEMPOTENCY_CONFLICT", "this retry is out of date; refresh the task and try again");
        }
      }
      const fresh = (await authorizeTaskAction(deps, caller, access.task.taskId, "retry")).task;
      const view = await taskView(deps, fresh, { events: 0, details: false });
      await syncIndex(deps, fresh, view.status, view.updatedAt);
      return { task: view };
    }
    audit = { ...auditKey, entityType: "WORKFLOW_ACCESS_RETRY", actorId: access.actorId, payloadHash,
      workflowRevision: row.workflowRevision, kind: row.kind, candidateDigest: row.candidateDigest, at };
    try {
      await deps.documentClient.send(new TransactWriteCommand({ TransactItems: [
        { Update: {
          TableName: deps.tableName, Key: rowKey,
          UpdateExpression: "SET nextAttemptAt = :now, dispatchDuePk = :duePk, dispatchDueSk = :dueSk REMOVE taskAccessPausedAt",
          ConditionExpression: "workflowRevision = :revision AND #kind = :kind AND candidateDigest = :candidate AND attribute_exists(taskAccessPausedAt)",
          ExpressionAttributeNames: { "#kind": "kind" },
          ExpressionAttributeValues: { ":now": at, ":duePk": WORKFLOW_DISPATCH_PK, ":dueSk": `${at}#${row.sk}`,
            ":revision": row.workflowRevision, ":kind": row.kind, ":candidate": row.candidateDigest },
        } },
        { ConditionCheck: {
          TableName: deps.tableName, Key: taskKey(access.task.taskId),
          ConditionExpression: "workflow.revision = :revision AND workflow.candidate.digest = :candidate AND attribute_not_exists(closedAt)",
          ExpressionAttributeValues: { ":revision": row.workflowRevision, ":candidate": row.candidateDigest },
        } },
        accessFence(deps, access),
        { Put: { TableName: deps.tableName, Item: audit, ConditionExpression: "attribute_not_exists(pk)" } },
      ] }));
    } catch (error) {
      if (!isConditional(error)) throw error;
      await authorizeTaskAction(deps, caller, access.task.taskId, "retry");
      const historical = await get<WorkflowAccessRetryAudit>(deps, auditKey);
      if (historical === undefined || historical.actorId !== access.actorId || historical.payloadHash !== payloadHash) {
        throw agentXError("IDEMPOTENCY_CONFLICT", "this retry is out of date; refresh the task and try again");
      }
      audit = historical;
    }
  }
  const expected = { workflowRevision: audit.workflowRevision, candidateDigest: audit.candidateDigest };
  let outcome: string | undefined;
  if (audit.kind === "REVIEW") {
    outcome = await startTaskWorkflowReviewFromSystem(deps, access.task.taskId, expected, caller);
  } else if (audit.kind === "UNDERSTAND") {
    await startTaskWorkflowUnderstandFromSystem(deps, access.task.taskId, { workflowRevision: expected.workflowRevision }, caller);
  } else if (audit.kind === "PLAN") {
    await startTaskWorkflowPlanFromSystem(deps, access.task.taskId, { workflowRevision: expected.workflowRevision }, caller);
  } else {
    outcome = await startTaskWorkflowPublicationFromSystem(deps, access.task.taskId, expected, {
      ownerRetry: true, ownerAccess: access, ownerActor: caller,
      ...(deps.issuer === undefined ? {} : { taskPageUrl: taskPageUrl(deps.issuer, access.task.taskId) }),
    });
  }
  // Meta repo lane D: a step held for the task's spec keeps its row.
  if (outcome !== "WAITING") try {
    await deps.documentClient.send(new DeleteCommand({ TableName: deps.tableName,
      Key: { pk: WORKFLOW_DISPATCH_PK, sk: `${access.task.taskId}#${audit.workflowRevision}` },
      ConditionExpression: "workflowRevision = :revision AND #kind = :kind AND candidateDigest = :candidate",
      ExpressionAttributeNames: { "#kind": "kind" },
      ExpressionAttributeValues: { ":revision": audit.workflowRevision, ":kind": audit.kind, ":candidate": audit.candidateDigest },
    }));
  } catch (error) {
    if (!isConditional(error)) throw error;
  }
  const fresh = (await authorizeTaskAction(deps, caller, access.task.taskId, "retry")).task;
  return { task: await taskView(deps, fresh, { events: 0, details: false }) };
}
