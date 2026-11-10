import { GetCommand, QueryCommand, TransactWriteCommand, type TransactWriteCommandInput } from "@aws-sdk/lib-dynamodb";
import { OrgIdSchema, OrgRoleSchema, agentXError, isSystemOwnerId, orgMemberKey, orgOfProjectPk, projectMemberKey, projectRevisionKey, slackBindingPk, SLACK_BINDING_SK_PREFIX, type OrgId, isWriterOrgRole } from "@agentx/contracts";
import type { DurableOutboxRecord } from "./lambda.js";
import { REMOVE_STORED_LESSONS } from "./outbox-lessons.js";
import { taskOpen } from "../developer/task-access.js";
import { effectiveProjectRole } from "../developer/project-roles.js";
import { systemOwnerStands } from "../developer/system-owner.js";
import { markAutomaticTaskEnded } from "../automatic-runs/end.js";
import { failOutboxOperation } from "./outbox-failure.js";
import { resolveTaskDispatchPeople, type CheckTaskPerson } from "../developer/task-people.js";
import { effectiveTaskOwner, isTaskTakenOver, ownerActorIdOf, ownerFenceOf, taskKey, taskOwnerKey, taskPointerKey, tryEffectiveTaskOwner, type DeveloperTaskPointerRecord, type DeveloperTaskRecord } from "../developer/task-records.js";
import type { ProjectAuthorityWitness } from "../developer/task-project-access.js";
import type { TaskAuthorityAdmission } from "./task-authority-admission.js";

type TransactItem = NonNullable<TransactWriteCommandInput["TransactItems"]>[number];

export interface TaskDispatchAccessDependencies {
  documentClient: { send(command: unknown, options?: { abortSignal?: AbortSignal }): Promise<unknown> };
  tableName: string;
  checkTaskPerson?: CheckTaskPerson;
  /** The install's single org: the org of a task that names none of its own. A State authority witness naming another org is refused. */
  orgId?: OrgId;
  /** One admission shared by every read, owner, and optimistic retry for this guard. */
  admission?: TaskAuthorityAdmission;
  /** Lambda context time remaining; pause writes must retain their independent reserve. */
  remainingTimeMs?: () => number;
  /** Production People composition requires one fresh State authority witness in the final fence. */
  stateAuthorityWitnessForOwnerActor?: (task: DeveloperTaskRecord, ownerActorId: string) => Promise<(ProjectAuthorityWitness & { taskId: string; developerId: string; project: string }) | undefined>;
}

/**
 * ALLOWED: go on. PARKED: durably paused, acknowledge. CLOSED: the task (or this operation) is definitively over, so the message is acknowledged as done: nothing is
 * launched, nothing is retried, and nothing waits for access. A closed task is not an error; retrying it only fills the Dispatch DLQ.
 */
export type TaskDispatchOutcome = "ALLOWED" | "PARKED" | "CLOSED";

export type TaskDispatchGuard = (record: DurableOutboxRecord) => Promise<TaskDispatchOutcome>;

class TaskDispatchGuardRetryError extends Error {
  readonly code?: string;

  constructor(cause: unknown) {
    const message = cause instanceof Error ? cause.message : String(cause);
    super(message, { cause });
    this.name = "TaskDispatchGuardRetryError";
    const code = cause !== null && typeof cause === "object" ? (cause as Record<string, unknown>).code : undefined;
    if (typeof code === "string") this.code = code;
  }
}

export function isTaskDispatchGuardRetryError(error: unknown): boolean {
  return error instanceof TaskDispatchGuardRetryError;
}

type PauseReason = "OWNERLESS" | "PROOF_UNAVAILABLE" | "PROJECT_VIEWER";

const outboxKey = (outboxId: string) => ({ pk: `OUTBOX#${outboxId}`, sk: "OUTBOX" });
const pauseKey = (outboxId: string) => ({ pk: `OUTBOX#${outboxId}`, sk: "TASK_ACCESS_PAUSE" });
const taskPauseKey = (taskId: string, outboxId: string) => ({ pk: `DEVTASK#${taskId}`, sk: `TASK_ACCESS_PAUSE#${outboxId}` });

async function get<T>(deps: TaskDispatchAccessDependencies, key: { pk: string; sk: string }): Promise<T | undefined> {
  const response = await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: key, ConsistentRead: true })) as { Item?: T };
  return response.Item;
}

function conditional(error: unknown): boolean {
  return error instanceof Error && (error.name === "ConditionalCheckFailedException" || error.name === "TransactionCanceledException");
}

/**
 * The task row's condition for a pause: still this workspace's and open, and owned by the owner the pause was decided for (Plan 5 Task 12a). A task whose owner cannot be
 * read has no owner to fence on: it is paused on the workspace and open alone, since that unreadable owner is the very reason for the pause.
 */
function parkTaskCondition(task: DeveloperTaskRecord, workspaceId: string): { ConditionExpression: string; ExpressionAttributeNames?: Record<string, string>; ExpressionAttributeValues: Record<string, unknown> } {
  const fence = tryEffectiveTaskOwner(task) === undefined ? undefined : ownerFenceOf(task);
  return {
    ConditionExpression: `workspaceId = :workspaceId AND attribute_not_exists(closedAt)${fence === undefined ? "" : ` AND ${fence.expression}`}`,
    ...(fence === undefined ? {} : { ExpressionAttributeNames: fence.names }),
    ExpressionAttributeValues: { ":workspaceId": workspaceId, ...(fence?.values ?? {}) },
  };
}

async function park(
  deps: TaskDispatchAccessDependencies,
  record: DurableOutboxRecord,
  pointer: DeveloperTaskPointerRecord,
  task: DeveloperTaskRecord,
  /** The People sidecar's revision, or undefined for a task that has none (stored as 0; the sidecar must still be absent at the pause and at the resume). */
  peopleRevision: number | undefined,
  reason: PauseReason,
): Promise<void> {
  const createdAt = new Date().toISOString();
  const pause = {
    entityType: "TASK_ACCESS_PAUSE", schemaVersion: 1, taskId: task.taskId, outboxId: record.id,
    operationId: record.operationId, workspaceId: record.workspaceId, peopleRevision: peopleRevision ?? 0, reason, createdAt,
    workflowRevision: task.workflow?.revision, workflowStage: task.workflow?.stage, workflowState: task.workflow?.state,
  } as const;
  const items: TransactItem[] = [
    { Update: {
      TableName: deps.tableName, Key: outboxKey(record.id), // A parked stage keeps no lessons: the copy waits an unknown time (an author may be erased, a lesson retired, access lost), so the stage is released without them (outbox-lessons.ts).
      UpdateExpression: `SET #status = :waiting, taskAccessPausedAt = :now ${REMOVE_STORED_LESSONS}`,
      ConditionExpression: "operationId = :operationId AND workspaceId = :workspaceId AND (#status = :queued OR #status = :pending)",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: { ":waiting": "WAITING_FOR_TASK_ACCESS", ":queued": "QUEUED", ":pending": "PENDING", ":operationId": record.operationId, ":workspaceId": record.workspaceId, ":now": createdAt },
    } },
    { ConditionCheck: {
      TableName: deps.tableName, Key: taskPointerKey(record.workspaceId),
      ConditionExpression: "taskId = :taskId", ExpressionAttributeValues: { ":taskId": task.taskId },
    } },
    { ConditionCheck: {
      TableName: deps.tableName, Key: taskKey(task.taskId),
      ...parkTaskCondition(task, record.workspaceId),
    } },
    { ConditionCheck: {
      TableName: deps.tableName, Key: { pk: `DEVTASK#${task.taskId}`, sk: "PEOPLE" },
      ...(peopleRevision === undefined ? { ConditionExpression: "attribute_not_exists(pk)" }
        : { ConditionExpression: "#revision = :revision", ExpressionAttributeNames: { "#revision": "revision" }, ExpressionAttributeValues: { ":revision": peopleRevision } }),
    } },
    { ConditionCheck: {
      TableName: deps.tableName, Key: { pk: `WORKSPACE#${record.workspaceId}`, sk: `OPERATION#${record.operationId}` },
      ConditionExpression: "fence = :fence AND (#status = :accepted OR #status = :dispatching)", ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: { ":fence": record.invocation.fence, ":accepted": "ACCEPTED", ":dispatching": "DISPATCHING" },
    } },
    { ConditionCheck: {
      TableName: deps.tableName, Key: { pk: `WORKSPACE#${record.workspaceId}`, sk: "META" },
      ConditionExpression: "fence = :fence AND activeOperationId = :operationId",
      ExpressionAttributeValues: { ":fence": record.invocation.fence, ":operationId": record.operationId },
    } },
    { Put: { TableName: deps.tableName, Item: { ...pauseKey(record.id), ...pause }, ConditionExpression: "attribute_not_exists(pk)" } },
    { Put: { TableName: deps.tableName, Item: { ...taskPauseKey(task.taskId, record.id), ...pause }, ConditionExpression: "attribute_not_exists(pk)" } },
  ];
  try {
    await deps.documentClient.send(new TransactWriteCommand({ TransactItems: items }));
  } catch (error) {
    if (!conditional(error)) throw error;
    const stored = await get<{ status?: string; operationId?: string }>(deps, outboxKey(record.id));
    const prior = await get<{ operationId?: string }>(deps, pauseKey(record.id));
    if (stored?.status === "WAITING_FOR_TASK_ACCESS" && stored.operationId === record.operationId && prior?.operationId === record.operationId) return;
    throw error;
  }
  void pointer;
}

async function allowedStillCurrent(
  deps: TaskDispatchAccessDependencies,
  record: DurableOutboxRecord,
  pointer: DeveloperTaskPointerRecord,
  task: DeveloperTaskRecord,
  peopleRevision: number | undefined,
  authorityWitness?: ProjectAuthorityWitness & { taskId: string; developerId: string; project: string },
): Promise<boolean> {
  const workflow = task.workflow;
  // The final fence also holds the task to the owner it was judged for: a take-over between the read and this write fails the fence (Plan 5 Task 12a).
  const fence = ownerFenceOf(task);
  const taskCondition = workflow === undefined
    ? { ConditionExpression: `workspaceId = :workspaceId AND attribute_not_exists(closedAt) AND attribute_not_exists(workflow) AND ${fence.expression}`,
      ExpressionAttributeNames: fence.names,
      ExpressionAttributeValues: { ":workspaceId": record.workspaceId, ...fence.values } }
    : { ConditionExpression: `workspaceId = :workspaceId AND attribute_not_exists(closedAt) AND workflow.#revision = :revision AND workflow.#stage = :stage AND workflow.#state = :state AND workflow.#stage <> :closed AND workflow.#stage <> :merged AND workflow.#state <> :complete AND ${fence.expression}`,
      ExpressionAttributeNames: { "#revision": "revision", "#stage": "stage", "#state": "state", ...fence.names },
      ExpressionAttributeValues: { ":workspaceId": record.workspaceId, ":revision": workflow.revision, ":stage": workflow.stage, ":state": workflow.state,
        ":closed": "CLOSED", ":merged": "MERGED", ":complete": "COMPLETE", ...fence.values } };
  const peopleCondition = peopleRevision === undefined
    ? { ConditionExpression: "attribute_not_exists(pk)" }
    : { ConditionExpression: "#revision = :revision", ExpressionAttributeNames: { "#revision": "revision" }, ExpressionAttributeValues: { ":revision": peopleRevision } };
  const checks: TransactItem[] = [
      { ConditionCheck: { TableName: deps.tableName, Key: taskPointerKey(record.workspaceId), ConditionExpression: "taskId = :taskId", ExpressionAttributeValues: { ":taskId": pointer.taskId } } },
      { ConditionCheck: { TableName: deps.tableName, Key: taskKey(task.taskId), ...taskCondition } },
      { ConditionCheck: { TableName: deps.tableName, Key: { pk: `DEVTASK#${task.taskId}`, sk: "PEOPLE" }, ...peopleCondition } },
      { ConditionCheck: { TableName: deps.tableName, Key: { pk: `WORKSPACE#${record.workspaceId}`, sk: `OPERATION#${record.operationId}` },
        ConditionExpression: "fence = :fence AND (#status = :accepted OR #status = :dispatching)", ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: { ":fence": record.invocation.fence, ":accepted": "ACCEPTED", ":dispatching": "DISPATCHING" } } },
      { ConditionCheck: { TableName: deps.tableName, Key: { pk: `WORKSPACE#${record.workspaceId}`, sk: "META" },
        ConditionExpression: "fence = :fence AND activeOperationId = :operationId", ExpressionAttributeValues: { ":fence": record.invocation.fence, ":operationId": record.operationId } } },
  ];
  if (authorityWitness !== undefined) {
    const witness = authorityWitness;
    // The witness's org is the one its revision key names; every other key it carries must name the same one.
    const witnessOrg = orgOfProjectPk(witness.projectRevision.pk);
    // The org the task names, else the one the guard was given; the witness must be in it.
    const named = OrgIdSchema.safeParse((task as unknown as Record<string, unknown>).orgId);
    const expectedOrg = named.success ? named.data : deps.orgId;
    if (witnessOrg === undefined || (expectedOrg !== undefined && expectedOrg !== witnessOrg)) return false;
    const expectedRevision = projectRevisionKey(witnessOrg, task.project, witness.projectRevision.revision);
    if (witness.taskId !== task.taskId || witness.project !== task.project || witness.projectRevision.pk !== expectedRevision.pk
      || witness.projectRevision.sk !== expectedRevision.sk || !Number.isSafeInteger(witness.projectRevision.revision)
      || witness.projectRevision.revision < 0 || (witness.access !== "granted" && witness.access !== "channel")) return false;
    const definitionNames = { "#definition": "definition", "#revision": "revision", "#developerTasks": "developerTasks" };
    const definitionValues = { ":revision": witness.projectRevision.revision } as Record<string, unknown>;
    const definitionPolicy = witness.projectRevision.developerTasksPresent
      ? "#definition.#revision = :revision AND #definition.#developerTasks = :developerTasks"
      : "#definition.#revision = :revision AND attribute_not_exists(#definition.#developerTasks)";
    if (witness.projectRevision.developerTasksPresent) definitionValues[":developerTasks"] = witness.projectRevision.developerTasks;
    checks.push({ ConditionCheck: { TableName: deps.tableName, Key: { pk: witness.projectRevision.pk, sk: witness.projectRevision.sk },
      ConditionExpression: definitionPolicy, ExpressionAttributeNames: definitionNames, ExpressionAttributeValues: definitionValues } });
    if (witness.access === "granted") {
      const membership = witness.membership;
      const orgMember = witness.orgMember;
      if (membership === undefined && orgMember !== undefined) {
        // An org owner or admin with no grant: the org member row, still an owner or admin, is the row the fence rests on (final review I1).
        const expectedOrgMember = orgMemberKey(witnessOrg, witness.developerId);
        if (orgMember.pk !== expectedOrgMember.pk || orgMember.sk !== expectedOrgMember.sk || (orgMember.role !== "owner" && orgMember.role !== "admin")) return false;
        checks.push({ ConditionCheck: { TableName: deps.tableName, Key: { pk: orgMember.pk, sk: orgMember.sk },
          ConditionExpression: "developerId = :developer AND (#role = :owner OR #role = :admin)", ExpressionAttributeNames: { "#role": "role" },
          ExpressionAttributeValues: { ":developer": witness.developerId, ":owner": "owner", ":admin": "admin" } } });
      } else {
        const expectedMembership = projectMemberKey(witnessOrg, witness.developerId, task.project);
        if (membership === undefined || membership.pk !== expectedMembership.pk || membership.sk !== expectedMembership.sk
          || membership.projectName !== task.project || membership.role !== "developer") return false;
        checks.push({ ConditionCheck: { TableName: deps.tableName, Key: { pk: membership.pk, sk: membership.sk },
          ConditionExpression: "projectName = :project AND #role = :developer", ExpressionAttributeNames: { "#role": "role" },
          ExpressionAttributeValues: { ":project": task.project, ":developer": "developer" } } });
      }
    } else {
      const binding = witness.binding;
      if (binding === undefined || binding.pk !== slackBindingPk(witnessOrg, binding.teamId) || binding.sk !== `${SLACK_BINDING_SK_PREFIX}${binding.channelId}`
        || binding.projectName !== task.project || typeof binding.updatedAt !== "string" || binding.updatedAt.length === 0) return false;
      checks.push({ ConditionCheck: { TableName: deps.tableName, Key: { pk: binding.pk, sk: binding.sk },
        ConditionExpression: "teamId = :teamId AND channelId = :channelId AND projectName = :projectName AND updatedAt = :updatedAt",
        ExpressionAttributeValues: { ":teamId": binding.teamId, ":channelId": binding.channelId, ":projectName": task.project, ":updatedAt": binding.updatedAt } } });
    }
  }
  const unique = new Map<string, TransactItem>();
  for (const check of checks) {
    const condition = Object.values(check)[0] as { Key?: { pk?: unknown; sk?: unknown } } | undefined;
    if (condition?.Key === undefined) return false;
    const key = `${String(condition.Key.pk)}\0${String(condition.Key.sk)}`;
    const prior = unique.get(key);
    if (prior !== undefined && JSON.stringify(prior) !== JSON.stringify(check)) return false;
    unique.set(key, check);
  }
  if (unique.size >= 100) return false;
  try {
    await deps.documentClient.send(new TransactWriteCommand({ TransactItems: [...unique.values()] }));
    return true;
  } catch (error) {
    if (conditional(error)) return false;
    throw error;
  }
}

/**
 * Strongly resolves workspace→task→PEOPLE. Legacy work with no pointer or PEOPLE remains allowed.
 * PEOPLE work is allowed only with a freshly qualified effective owner; every other result is
 * durably parked while preserving the original operation, invocation and charge.
 */
async function guardTaskDispatchCore(deps: TaskDispatchAccessDependencies, record: DurableOutboxRecord): Promise<TaskDispatchOutcome> {
  // Terminal cleanup is independent of owner availability. It must be able to release compute,
  // workspace slots and charge after the last owner departs.
  if (record.invocation.kind === "close" || record.invocation.kind === "cancel") return "ALLOWED";
  const guardDeps: TaskDispatchAccessDependencies = deps.admission === undefined ? deps : {
    ...deps,
    documentClient: {
      async send(command: unknown): Promise<unknown> {
        if (command instanceof GetCommand || command instanceof QueryCommand) {
          const abortSignal = deps.admission!.admitStateRead();
          const response = await deps.documentClient.send(command, { abortSignal });
          deps.admission!.assertOpen();
          return response;
        }
        if (command instanceof TransactWriteCommand && deps.remainingTimeMs !== undefined) {
          const remaining = deps.remainingTimeMs();
          if (remaining <= TASK_PAUSE_RESERVE_MS) throw agentXError("RUNTIME_UNAVAILABLE", "task access pause reserve is unavailable");
          return deps.documentClient.send(command, { abortSignal: AbortSignal.timeout(remaining) });
        }
        return deps.documentClient.send(command);
      },
    },
  };
  deps.admission?.assertOpen();
  const stored = await get<{ status?: string }>(guardDeps, outboxKey(record.id));
  if (stored?.status === "WAITING_FOR_TASK_ACCESS") return "PARKED";
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const pointer = await get<DeveloperTaskPointerRecord>(guardDeps, taskPointerKey(record.workspaceId));
    if (pointer === undefined) {
      deps.admission?.assertOpen();
      return "ALLOWED";
    }
    const task = await get<DeveloperTaskRecord>(guardDeps, taskKey(pointer.taskId));
    // A PARKED answer acknowledges the SQS message, so it is returned only after a durable pause
    // exists. Broken task state is retried instead of silently dropping the invocation.
    if (task === undefined || task.workspaceId !== record.workspaceId) {
      throw agentXError("RUNTIME_UNAVAILABLE", "task dispatch state could not be verified");
    }
    // A task closed (or finished) since the message was queued is over: acknowledge it as done. Throwing here retried it until the Dispatch DLQ. No machine is launched either way.
    if (!taskOpen(task) || task.workflow?.state === "COMPLETE") {
      deps.admission?.assertOpen();
      return "CLOSED";
    }
    // Plan 5 Task 12a: a task whose owner can't be read has no one to judge by: it pauses, never falls back to its creator.
    if (tryEffectiveTaskOwner(task) === undefined) {
      if (deps.remainingTimeMs !== undefined && deps.remainingTimeMs() <= TASK_PAUSE_RESERVE_MS) {
        throw agentXError("RUNTIME_UNAVAILABLE", "task access pause reserve is unavailable");
      }
      const sidecar = await get<{ revision?: unknown }>(guardDeps, { pk: `DEVTASK#${task.taskId}`, sk: "PEOPLE" });
      await park(guardDeps, record, pointer, task, sidecar === undefined ? undefined : Number(sidecar.revision), "OWNERLESS");
      return "PARKED";
    }
    // A project's system owner (automatic runs) is judged by its standing, not by a person's membership: the company is open and the project is active. It has no People sidecar (a task with no share has none, and no
    // person is added to it), so a sidecar that is there is a fault and the fence below, which needs none, refuses. A system owner that does not stand pauses the operation, as an ownerless task does.
    const ownerId = tryEffectiveTaskOwner(task)!.developerId;
    if (isSystemOwnerId(ownerId)) {
      const orgId = OrgIdSchema.safeParse((task as unknown as Record<string, unknown>).orgId);
      const stands = await systemOwnerStands(guardDeps, orgId.success ? orgId.data : deps.orgId!, task.project).catch(() => undefined);
      if (stands === undefined) throw agentXError("RUNTIME_UNAVAILABLE", "the standing of the project's automatic runs could not be verified");
      if (!stands) {
        if (deps.remainingTimeMs !== undefined && deps.remainingTimeMs() <= TASK_PAUSE_RESERVE_MS) throw agentXError("RUNTIME_UNAVAILABLE", "task access pause reserve is unavailable");
        // Nobody can resume an automatic run's operation (it has no owner to press Retry), and a parked one would hold the project's one automatic slot for ever. So the operation is failed for good (it was never
        // delivered), the task is ended, and its workspace and slot go back through the release mark (`automatic-runs/end.ts`).
        try {
          await failOutboxOperation(guardDeps.documentClient as Parameters<typeof failOutboxOperation>[0], deps.tableName, record, "TASK_ACCESS_DENIED: this project's automatic runs can't go on: the project is archived or the company is closed");
        } catch (error) {
          // The operation moved on while it was judged (it was delivered, or ended): judge it again from the start.
          if (conditional(error)) continue;
          throw error;
        }
        // The operation is failed already; if the end cannot be written once, it is tried again (a second miss is left to the session sweep, which ends it, later, as a run past its time).
        const ended = () => markAutomaticTaskEnded(guardDeps.documentClient, deps.tableName, task, "project_stopped", new Date().toISOString());
        await ended().catch(() => ended());
        return "PARKED";
      }
      if (await allowedStillCurrent(guardDeps, record, pointer, task, undefined, undefined)) {
        deps.admission?.assertOpen();
        return "ALLOWED";
      }
      if (await operationEnded(guardDeps, record)) return closedOutcome(deps);
      continue;
    }
    const access = await resolveTaskDispatchPeople(guardDeps, task);
    // Plan 2, Task 21: a task with no People sidecar is its owner's alone, and an owner who holds the viewer role in its project starts no work on it. A task with a
    // sidecar is judged by its owners above (an owner who is a project viewer is no authority), except that the person who took a task over is its owner whatever the
    // sidecar says, so theirs is read here (Plan 5 Task 12a).
    if ((access === undefined || (isTaskTakenOver(task) && access.status === "ALLOWED")) && await creatorIsProjectViewer(guardDeps, task)) {
      if (deps.remainingTimeMs !== undefined && deps.remainingTimeMs() <= TASK_PAUSE_RESERVE_MS) {
        throw agentXError("RUNTIME_UNAVAILABLE", "task access pause reserve is unavailable");
      }
      await park(guardDeps, record, pointer, task, access?.peopleRevision, "PROJECT_VIEWER");
      return "PARKED";
    }
    if (access === undefined || access.status === "ALLOWED") {
      let witness: (ProjectAuthorityWitness & { taskId: string; developerId: string; project: string }) | undefined;
      if (access?.status === "ALLOWED" && deps.stateAuthorityWitnessForOwnerActor !== undefined) {
        const ownerActorId = access.ownerActorIds[0];
        if (ownerActorId === undefined || (isTaskTakenOver(task) && ownerActorId !== ownerActorIdOf(task))) throw agentXError("RUNTIME_UNAVAILABLE", "task dispatch authority witness is unavailable");
        try {
          witness = await deps.stateAuthorityWitnessForOwnerActor(task, ownerActorId);
        } catch {
          if (deps.remainingTimeMs !== undefined && deps.remainingTimeMs() <= TASK_PAUSE_RESERVE_MS) {
            throw agentXError("RUNTIME_UNAVAILABLE", "task access pause reserve is unavailable");
          }
          await park(guardDeps, record, pointer, task, access.peopleRevision, "PROOF_UNAVAILABLE");
          return "PARKED";
        }
        if (witness === undefined) continue;
        if (taskOwnerKey(witness.developerId, task.taskId) !== ownerActorId) throw agentXError("RUNTIME_UNAVAILABLE", "task dispatch authority witness is unavailable");
      }
      if (await allowedStillCurrent(guardDeps, record, pointer, task, access?.peopleRevision, witness)) {
        deps.admission?.assertOpen();
        return "ALLOWED";
      }
      if (await operationEnded(guardDeps, record)) return closedOutcome(deps);
      continue;
    }
    if (deps.remainingTimeMs !== undefined && deps.remainingTimeMs() <= TASK_PAUSE_RESERVE_MS) {
      throw agentXError("RUNTIME_UNAVAILABLE", "task access pause reserve is unavailable");
    }
    await park(guardDeps, record, pointer, task, access.peopleRevision, access.status === "OWNERLESS" ? "OWNERLESS" : "PROOF_UNAVAILABLE");
    return "PARKED";
  }
  // Every pass saw the task move under it. Read once more and decide: if it closed (or its operation ended) meanwhile, that is the answer; if it is still open and nothing ended,
  // the race is genuinely transient and the message is retried.
  const finalPointer = await get<DeveloperTaskPointerRecord>(guardDeps, taskPointerKey(record.workspaceId));
  const finalTask = finalPointer === undefined ? undefined : await get<DeveloperTaskRecord>(guardDeps, taskKey(finalPointer.taskId));
  if ((finalTask !== undefined && finalTask.workspaceId === record.workspaceId && (!taskOpen(finalTask) || finalTask.workflow?.state === "COMPLETE"))
    || await operationEnded(guardDeps, record)) return closedOutcome(deps);
  throw agentXError("RUNTIME_UNAVAILABLE", "task dispatch access changed while it was being verified");
}

function closedOutcome(deps: TaskDispatchAccessDependencies): "CLOSED" {
  deps.admission?.assertOpen();
  return "CLOSED";
}

/** Whether this dispatch's operation is over (cancelled, ended, failed) or its row is gone: a dispatch for it can never be delivered, so it is done rather than retried. */
async function operationEnded(deps: TaskDispatchAccessDependencies, record: DurableOutboxRecord): Promise<boolean> {
  const operation = await get<{ status?: string }>(deps, { pk: `WORKSPACE#${record.workspaceId}`, sk: `OPERATION#${record.operationId}` });
  return operation === undefined || (operation.status !== "ACCEPTED" && operation.status !== "DISPATCHING");
}

/**
 * Whether the task's owner (the effective one: the person who took it over, else its creator) is, now, a project viewer: the effective project role (their org role first,
 * so an owner or admin who still holds an old viewer row maintains every project, then their grant), read live in the task's own org. Same rule as `checkProjectAccess`.
 */
export async function creatorIsProjectViewer(deps: TaskDispatchAccessDependencies, task: DeveloperTaskRecord): Promise<boolean> {
  const named = OrgIdSchema.safeParse((task as unknown as Record<string, unknown>).orgId);
  const orgId = named.success ? named.data : deps.orgId;
  if (orgId === undefined) return false;
  const { developerId } = effectiveTaskOwner(task);
  const [grant, member] = await Promise.all([
    get<{ role?: unknown; projectRole?: unknown }>(deps, projectMemberKey(orgId, developerId, task.project)),
    get<{ role?: unknown }>(deps, orgMemberKey(orgId, developerId)),
  ]);
  const orgRole = OrgRoleSchema.safeParse(member?.role);
  // I2: an Auditor (or a role that is not a writer's) is held like a viewer: the task of a person who can no longer write is parked, not dispatched.
  if (member !== undefined && !isWriterOrgRole(member.role)) return true;
  return effectiveProjectRole({ developerId, orgRole: orgRole.success ? orgRole.data : "member" }, grant, false) === "viewer";
}

/** Marks only an incomplete core authority decision so the dispatcher retries the same durable operation. */
export async function guardTaskDispatch(deps: TaskDispatchAccessDependencies, record: DurableOutboxRecord): Promise<TaskDispatchOutcome> {
  try {
    return await guardTaskDispatchCore(deps, record);
  } catch (error) {
    if (record.invocation.kind === "close" || record.invocation.kind === "cancel" || isTaskDispatchGuardRetryError(error)) throw error;
    throw new TaskDispatchGuardRetryError(error);
  }
}

const TASK_PAUSE_RESERVE_MS = 2_000;

interface PausedTaskDispatch {
  taskId: string;
  outboxId: string;
  operationId: string;
  workspaceId: string;
  peopleRevision: number;
  workflowRevision?: number;
  workflowStage?: string;
  workflowState?: string;
}

/**
 * Explicit current-owner redrive for the one parked operation. It changes only the original
 * outbox back to PENDING, so the publisher requeues the exact invocation without a new charge.
 * Merely taking ownership, session readiness, and recovery sweeps never call this function.
 */
export async function resumeTaskDispatch(
  deps: TaskDispatchAccessDependencies & { now(): number },
  input: { task: DeveloperTaskRecord; peopleRevision: number; actorId: string; requestId: string; payloadHash: string; reauthorize?(): Promise<void> },
): Promise<boolean> {
  const auditKey = { pk: `DEVTASK#${input.task.taskId}`, sk: `TASK_ACCESS_RETRY#${input.requestId}` };
  const priorAudit = await get<{ actorId?: string; operationId?: string; payloadHash?: string }>(deps, auditKey);
  if (priorAudit !== undefined) {
    if (priorAudit.actorId !== input.actorId || priorAudit.payloadHash !== input.payloadHash) {
      throw agentXError("IDEMPOTENCY_CONFLICT", "this retry request ID was already used");
    }
    await input.reauthorize?.();
    return true;
  }
  const response = await deps.documentClient.send(new QueryCommand({
    TableName: deps.tableName, KeyConditionExpression: "pk = :pk AND begins_with(sk, :pause)",
    ExpressionAttributeValues: { ":pk": `DEVTASK#${input.task.taskId}`, ":pause": "TASK_ACCESS_PAUSE#" }, ConsistentRead: true,
  })) as { Items?: PausedTaskDispatch[] };
  const workspace = await get<{ activeOperationId?: string }>(deps, { pk: `WORKSPACE#${input.task.workspaceId}`, sk: "META" });
  const pauses = (response.Items ?? []).filter((pause) => pause.taskId === input.task.taskId && pause.workspaceId === input.task.workspaceId
    && pause.operationId === workspace?.activeOperationId);
  if (pauses.length === 0) return false;
  const pause = pauses.length === 1 ? pauses[0]! : undefined;
  const workflow = input.task.workflow;
  // A plain task (no workflow) is paused with no workflow fields (a project viewer's legacy task, Plan 2, Task 21), and resumes with none.
  if (pause === undefined || pause.peopleRevision > input.peopleRevision
    || pause.workflowRevision !== workflow?.revision || pause.workflowStage !== workflow?.stage || pause.workflowState !== workflow?.state) return false;
  const outbox = await get<DurableOutboxRecord>(deps, outboxKey(pause.outboxId));
  if (outbox?.status !== "WAITING_FOR_TASK_ACCESS" || outbox.operationId !== pause.operationId || outbox.workspaceId !== pause.workspaceId) return false;
  const at = new Date(deps.now()).toISOString();
  const items: TransactItem[] = [
    { Update: {
      TableName: deps.tableName, Key: outboxKey(pause.outboxId), UpdateExpression: "SET #status = :pending REMOVE taskAccessPausedAt",
      ConditionExpression: "#status = :waiting AND operationId = :operationId AND workspaceId = :workspaceId",
      ExpressionAttributeNames: { "#status": "status" }, ExpressionAttributeValues: {
        ":pending": "PENDING", ":waiting": "WAITING_FOR_TASK_ACCESS", ":operationId": pause.operationId, ":workspaceId": pause.workspaceId,
      },
    } },
    { ConditionCheck: {
      TableName: deps.tableName, Key: taskKey(input.task.taskId),
      ...(workflow === undefined
        ? { ConditionExpression: "attribute_not_exists(workflow) AND attribute_not_exists(closedAt)" }
        : {
          ConditionExpression: "workflow.#revision = :workflowRevision AND workflow.#stage = :workflowStage AND workflow.#state = :workflowState AND attribute_not_exists(closedAt)",
          ExpressionAttributeNames: { "#revision": "revision", "#stage": "stage", "#state": "state" }, ExpressionAttributeValues: {
            ":workflowRevision": pause.workflowRevision, ":workflowStage": pause.workflowStage, ":workflowState": pause.workflowState,
          },
        }),
    } },
    { ConditionCheck: {
      TableName: deps.tableName, Key: { pk: `DEVTASK#${input.task.taskId}`, sk: "PEOPLE" },
      // Revision 0 is a task with no People sidecar: it must still have none.
      ...(input.peopleRevision === 0 ? { ConditionExpression: "attribute_not_exists(pk)" }
        : { ConditionExpression: "#revision = :revision", ExpressionAttributeNames: { "#revision": "revision" }, ExpressionAttributeValues: { ":revision": input.peopleRevision } }),
    } },
    { ConditionCheck: {
      TableName: deps.tableName, Key: { pk: `WORKSPACE#${pause.workspaceId}`, sk: `OPERATION#${pause.operationId}` },
      ConditionExpression: "fence = :fence AND (#status = :accepted OR #status = :dispatching)", ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: { ":fence": outbox.invocation.fence, ":accepted": "ACCEPTED", ":dispatching": "DISPATCHING" },
    } },
    { ConditionCheck: {
      TableName: deps.tableName, Key: { pk: `WORKSPACE#${pause.workspaceId}`, sk: "META" },
      ConditionExpression: "fence = :fence AND activeOperationId = :operationId",
      ExpressionAttributeValues: { ":fence": outbox.invocation.fence, ":operationId": pause.operationId },
    } },
    { Delete: { TableName: deps.tableName, Key: pauseKey(pause.outboxId), ConditionExpression: "operationId = :operationId", ExpressionAttributeValues: { ":operationId": pause.operationId } } },
    { Delete: { TableName: deps.tableName, Key: taskPauseKey(input.task.taskId, pause.outboxId), ConditionExpression: "operationId = :operationId", ExpressionAttributeValues: { ":operationId": pause.operationId } } },
    { Put: { TableName: deps.tableName, Item: { ...auditKey, entityType: "TASK_ACCESS_RETRY", schemaVersion: 1, taskId: input.task.taskId,
      requestId: input.requestId, actorId: input.actorId, payloadHash: input.payloadHash, outboxId: pause.outboxId, operationId: pause.operationId, at }, ConditionExpression: "attribute_not_exists(pk)" } },
  ];
  try {
    await deps.documentClient.send(new TransactWriteCommand({ TransactItems: items }));
    return true;
  } catch (error) {
    if (!conditional(error)) throw error;
    const audit = await get<{ actorId?: string; operationId?: string; payloadHash?: string }>(deps, auditKey);
    const current = await get<{ status?: string; operationId?: string }>(deps, outboxKey(pause.outboxId));
    if (audit?.actorId === input.actorId && audit.operationId === pause.operationId && audit.payloadHash === input.payloadHash && current?.status === "PENDING") {
      await input.reauthorize?.();
      return true;
    }
    throw error;
  }
}
