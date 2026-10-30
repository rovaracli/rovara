import { randomUUID } from "node:crypto";
import {
  AdminShareModeRequestSchema,
  ShareDeveloperTaskRequestSchema,
  agentXError,
  agentSessionKey,
  developerTaskPolicy,
  sharedTaskKey,
  type DeveloperTaskShare,
  type DeveloperTaskView,
} from "@agentx/contracts";
import { channelLabel, decideMode } from "../../developer/share.js";
import {
  aiToolTurn,
  partyOfTask,
  shareView,
  taskIndexKey,
  taskKey,
  taskOwnerKey,
  taskShare,
  ownerFenceOf,
  type DeveloperTaskRecord,
  type TaskShare,
} from "../../developer/task-records.js";
import { hashJson, isConditional } from "../broker-shared.js";
import type { TransactItems } from "../developer-task-actions.js";
import type { DeveloperCaller } from "../developer-routes.js";
import { requireProjectWorkRole } from "../../developer/task-access.js";
import { loadTaskPeople } from "../../developer/task-people.js";
import { requireSessionLevel } from "../../agent-sessions/access.js";
import { codeTask, codeShareItems } from "../../rovara-code/sharing.js";
import type { DeveloperTaskRouteDependencies } from "./types.js";
import { CLOSED_TASK, get, iso, parse, partyOfTaskActor, putNew, turnTable } from "./common.js";
import { accessFence, type AuthorizedTask, authorizeLegacyTaskAction } from "./access.js";
import { taskView } from "./task-view.js";
import { shareFor } from "./start.js";
import { ownerIndexRowOf, syncIndex } from "./task-index.js";

/** A path segment, decoded; a malformed escape is kept as is and then fails the task ID check. */
export function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

const SHARE_ATTEMPTS = 3;

/** A share's channel as a message names it: `#name` when its name was stored (public only), else its ID (R10). */
const shareLabel = (share: TaskShare) => channelLabel({ channelId: share.channelId, ...(share.channelName === undefined ? {} : { name: share.channelName, isPrivate: false }) });

/** C5: the share the request asks for, from the task's current one, or "unchanged". */
async function nextShare(
  deps: DeveloperTaskRouteDependencies,
  caller: DeveloperCaller,
  task: DeveloperTaskRecord,
  request: { shareMode?: "view" | "continue" | undefined; channel?: string | undefined },
  now: string,
): Promise<TaskShare | "unchanged"> {
  const project = await deps.actions.latestProject(deps.orgId, task.project);
  if (project === undefined) throw agentXError("CONFIG_INVALID", "this task's project is no longer registered; ask an admin");
  const policy = developerTaskPolicy(project.definition);
  if (task.share === undefined) {
    // R11: sharing an existing task does not recheck project access; it uses the latest policy.
    const decision = await shareFor(deps, caller, task.project, { revision: project.definition.revision, policy, access: "granted", channelIds: await deps.projectChannelIds(task.project) }, { shareToChannel: true, shareMode: request.shareMode, channel: request.channel });
    if (decision === undefined || deps.slackTeamId === undefined) throw agentXError("CHANNEL_REQUIRED", "this AgentX has no Slack workspace set, so tasks cannot be shared");
    return taskShare(decision, deps.slackTeamId, now);
  }
  const current = task.share;
  if (request.channel !== undefined) {
    const named = request.channel.replace(/^#/, "").toLowerCase();
    if (request.channel !== current.channelId && current.channelName?.toLowerCase() !== named) {
      throw agentXError("CONFIG_INVALID", `this task is already shared in ${shareLabel(current)}; its channel cannot change`);
    }
  }
  return withMode(current, decideMode(policy, request.shareMode ?? current.mode));
}

/** The share with a new mode, or "unchanged". Built field by field, so a stale modeReason is dropped. */
function withMode(current: TaskShare, mode: { mode: "view" | "continue"; modeReason?: "continue_not_allowed" }): TaskShare | "unchanged" {
  if (mode.mode === current.mode && mode.modeReason === current.modeReason) return "unchanged";
  return {
    teamId: current.teamId, channelId: current.channelId,
    ...(current.channelName === undefined ? {} : { channelName: current.channelName }),
    sharedReason: current.sharedReason, sharedAt: current.sharedAt,
    ...(current.threadTs === undefined ? {} : { threadTs: current.threadTs }),
    ...(current.postFailedAt === undefined ? {} : { postFailedAt: current.postFailedAt }),
    mode: mode.mode,
    ...(mode.modeReason === undefined ? {} : { modeReason: mode.modeReason }),
  };
}

/** An AgentX admin who changed a task's share mode (C25), named on the audit record. */
export interface ShareAdmin { issuer: string; subject: string; displayName?: string }
export type ShareModeDependencies = Pick<DeveloperTaskRouteDependencies, "documentClient" | "tableName" | "actions" | "orgId" | "now" | "log" | "issuer">;

/**
 * C1, C5, C25: one share change's items: the task's whole share map under shareVersion, the index
 * row, the thread record's mode, the idempotency item and the `share` audit record (Q9), which
 * names the admin when an admin made the change.
 */
function shareItems(
  deps: ShareModeDependencies,
  turns: string,
  task: DeveloperTaskRecord,
  share: TaskShare,
  audit: { idempotencyKey: { pk: string; sk: string }; payloadHash: string; receivedAt: string; request: string; admin?: ShareAdmin; actor?: DeveloperCaller },
): TransactItems {
  const version = task.shareVersion ?? 0;
  const ownerFence = codeTask(task) ? ownerFenceOf(task) : undefined;
  return [
    { Update: {
      TableName: deps.tableName, Key: taskKey(task.taskId),
      UpdateExpression: `SET #share = :share, #shared = :true, shareVersion = :next, updatedAt = :now${codeTask(task) ? ", codeShareRequestId = :shareRequest" : ""}`,
      ConditionExpression: (version === 0
        ? "attribute_exists(pk) AND attribute_not_exists(shareVersion) AND attribute_not_exists(closedAt)"
        : "shareVersion = :current AND attribute_not_exists(closedAt)") + (ownerFence === undefined ? "" : ` AND orgId = :shareOrg AND ${ownerFence.expression}`),
      ExpressionAttributeNames: { "#share": "share", "#shared": "shared", ...ownerFence?.names },
      ExpressionAttributeValues: { ":share": share, ":true": true, ":next": version + 1, ":now": audit.receivedAt, ...(ownerFence === undefined ? {} : { ":shareOrg": task.orgId, ...ownerFence.values }), ...(codeTask(task) ? { ":shareRequest": audit.idempotencyKey.sk.slice(8) } : {}), ...(version === 0 ? {} : { ":current": version }) },
    } },
    // Unconditional, as the close's: the start wrote this row with the task.
    { Update: {
      TableName: deps.tableName, Key: taskIndexKey(task.developerId, task.createdAt, task.taskId),
      UpdateExpression: "SET #shared = :true", ExpressionAttributeNames: { "#shared": "shared" }, ExpressionAttributeValues: { ":true": true },
    } },
    // The row of the person who took the task over, too (Plan 5 Task 12a).
    ...(ownerIndexRowOf(task) === undefined ? [] : [{ Update: {
      TableName: deps.tableName, Key: ownerIndexRowOf(task)!,
      UpdateExpression: "SET #shared = :true", ExpressionAttributeNames: { "#shared": "shared" }, ExpressionAttributeValues: { ":true": true },
    } }]),
    ...(share.threadTs === undefined ? [] : [{ Update: {
      TableName: deps.tableName, Key: sharedTaskKey({ teamId: share.teamId, channelId: share.channelId, threadTs: share.threadTs }),
      UpdateExpression: "SET #mode = :mode", ConditionExpression: "attribute_exists(pk)",
      ExpressionAttributeNames: { "#mode": "mode" }, ExpressionAttributeValues: { ":mode": share.mode },
    } }]),
    putNew(deps.tableName, { ...audit.idempotencyKey, entityType: "IDEMPOTENCY", action: "share", payloadHash: audit.payloadHash }),
    ...codeShareItems(deps.tableName, task, share, audit.idempotencyKey.sk.slice(8), audit.actor?.developerId ?? hashJson({ issuer: audit.admin?.issuer, subject: audit.admin?.subject }), audit.receivedAt, audit.actor?.name ?? audit.admin?.displayName ?? "An administrator", deps.issuer),
    // Q9: a share or mode change is audited like the task's other actions.
    putNew(turns, aiToolTurn({
      party: audit.actor === undefined ? partyOfTask(task) : partyOfTaskActor(task, audit.actor), turnId: randomUUID(), action: "share", phase: "accepted", outcome: "accepted", receivedAt: audit.receivedAt, finishedAt: iso(deps),
      request: audit.request, response: `Shared in ${shareLabel(share)}, ${share.mode === "view" ? "view only" : "open to the channel"}.`,
      ...(audit.admin === undefined ? {} : { admin: audit.admin }),
    })),
  ];
}

async function authorizeShare(deps: DeveloperTaskRouteDependencies, caller: DeveloperCaller, taskId: string): Promise<AuthorizedTask> {
  const task = await get<DeveloperTaskRecord>(deps, taskKey(taskId));
  if (task === undefined || task.orgId !== caller.orgId) throw agentXError("TASK_NOT_FOUND", "no task here that you can see");
  if (!codeTask(task)) return authorizeLegacyTaskAction(deps, caller, taskId, "work");
  if (deps.agentSessions === undefined) throw agentXError("RUNTIME_UNAVAILABLE", "Session access cannot be checked right now.");
  const access = await requireSessionLevel(deps.agentSessions, caller, task.sessionId, "edit", "share it");
  if (task.closedAt !== undefined || task.workflow?.stage === "CLOSED" || task.workflow?.stage === "MERGED") throw agentXError("CONFIG_INVALID", CLOSED_TASK);
  await requireProjectWorkRole(deps, task, caller);
  const people = await loadTaskPeople(deps, taskId);
  const actorId = taskOwnerKey(caller.developerId, taskId);
  const ownerIds = [taskOwnerKey(access.effectiveOwner.developerId, taskId)];
  return { task, role: "owner", actorId, ownerActorIds: ownerIds, authority: { actorId, ownerIds }, shareSession: { sessionId: access.session.sessionId, revision: access.session.revision }, ...(people === undefined ? {} : { peopleRevision: people.revision }) };
}

const shareIdempotencyKey = (task: DeveloperTaskRecord, requestId: string) => ({ pk: `IDEMPOTENCY#${task.ownerKey}#${task.workspaceId}`, sk: `REQUEST#${requestId}` });
const REUSED_REQUEST = "this request_id was already used for another action on this task; use a new request_id";

/**
 * C5. Answers at once; the notifier posts the start message or the mode change (C6). Only the
 * task's developer may call this route; an AgentX admin switches the mode through adminShareMode
 * (C25). Every write of `share` replaces the map, conditioned on shareVersion, so a notifier write
 * between this read and this write is read again, never lost (C1).
 */
export async function shareTask(deps: DeveloperTaskRouteDependencies, caller: DeveloperCaller, taskId: string, value: unknown): Promise<{ task: DeveloperTaskView }> {
  const request = parse(ShareDeveloperTaskRequestSchema, value, deps, "share");
  let access = await authorizeShare(deps, caller, taskId);
  let task = access.task;
  const turns = turnTable(deps);
  const idempotencyKey = shareIdempotencyKey(task, request.requestId);
  const payloadHash = hashJson({ action: "share", shareMode: request.shareMode ?? null, channel: request.channel ?? null });
  const answer = async () => {
    const view = await taskView(deps, task, { events: 0, details: false });
    await syncIndex(deps, task, view.status, view.updatedAt);
    return { task: view };
  };
  const previous = await get<{ payloadHash: string }>(deps, idempotencyKey);
  if (previous !== undefined) {
    if (previous.payloadHash !== payloadHash) throw agentXError("IDEMPOTENCY_CONFLICT", REUSED_REQUEST);
    return answer();
  }
  for (let attempt = 0; attempt < SHARE_ATTEMPTS; attempt += 1) {
    if (task.closedAt !== undefined) throw agentXError("CONFIG_INVALID", CLOSED_TASK);
    const receivedAt = iso(deps);
    const share = await nextShare(deps, caller, task, request, receivedAt);
    if (share === "unchanged") return answer();
    const items = [...shareItems(deps, turns, task, share, {
      idempotencyKey, payloadHash, receivedAt,
      request: `share ${request.shareMode ?? "default mode"}${request.channel === undefined ? "" : ` in ${request.channel}`}`,
      actor: caller,
    }), accessFence(deps, access), ...(access.shareSession === undefined ? [] : [{ ConditionCheck: {
      TableName: deps.tableName, Key: agentSessionKey(caller.orgId, access.shareSession.sessionId, "META"),
      ConditionExpression: "orgId = :org AND #revision = :revision", ExpressionAttributeNames: { "#revision": "revision" },
      ExpressionAttributeValues: { ":org": caller.orgId, ":revision": access.shareSession.revision },
    } }])];
    try {
      await deps.actions.transact(items);
      access = await authorizeShare(deps, caller, taskId);
      task = access.task;
      return answer();
    } catch (error) {
      if (!isConditional(error)) throw error;
      // The same share, sent again, committed first.
      const concurrent = await get<{ payloadHash: string }>(deps, idempotencyKey);
      if (concurrent !== undefined) return shareTask(deps, caller, taskId, value);
      // The notifier (or a close) changed the task meanwhile: decide again from a fresh read.
      access = await authorizeShare(deps, caller, taskId);
      task = access.task;
    }
  }
  throw agentXError("WORKSPACE_BUSY", "the task changed while sharing; try agentx_share_task again");
}

/**
 * C25 (owner answer to Q2, 2026-09-29): an AgentX admin switches a shared task between view only and
 * continue, within the latest revision's policy. The broker's admin route has already checked the
 * admin claim and the project's administrator membership (FR-015). An admin cannot share a private
 * task (sharing stays the developer's choice), move it to another channel, or change a closed task.
 * Ruling F5 (D22): the answer is the task's ID and share only, never its title or results.
 */
export async function adminShareMode(deps: ShareModeDependencies, admin: ShareAdmin, task: DeveloperTaskRecord, value: unknown): Promise<{ task: { taskId: string; share?: DeveloperTaskShare } }> {
  if (task.orgId !== deps.orgId) throw agentXError("TASK_NOT_FOUND", "no task here that you can see");
  const request = parse(AdminShareModeRequestSchema, value, deps, "admin-share-mode");
  const turns = turnTable(deps);
  const idempotencyKey = shareIdempotencyKey(task, request.requestId);
  const payloadHash = hashJson({ action: "share", shareMode: request.shareMode, channel: null, admin: `${admin.issuer}#${admin.subject}` });
  let current = task;
  const answer = () => ({ task: { taskId: current.taskId, ...(current.share === undefined ? {} : { share: shareView(current.share) }) } });
  const reload = async () => {
    const fresh = await get<DeveloperTaskRecord>(deps, taskKey(task.taskId));
    if (fresh === undefined || fresh.orgId !== deps.orgId) throw agentXError("TASK_NOT_FOUND", "no task here that you can see");
    current = fresh;
  };
  const previous = await get<{ payloadHash: string }>(deps, idempotencyKey);
  if (previous !== undefined) {
    if (previous.payloadHash !== payloadHash) throw agentXError("IDEMPOTENCY_CONFLICT", REUSED_REQUEST);
    return answer();
  }
  for (let attempt = 0; attempt < SHARE_ATTEMPTS; attempt += 1) {
    if (current.closedAt !== undefined) throw agentXError("CONFIG_INVALID", "this task is closed, so its share mode can no longer change");
    if (current.share === undefined) throw agentXError("CONFIG_INVALID", "this task is private; only its developer can share it");
    const project = await deps.actions.latestProject(deps.orgId, current.project);
    if (project === undefined) throw agentXError("CONFIG_INVALID", "this task's project is no longer registered; register it again first");
    const share = withMode(current.share, decideMode(developerTaskPolicy(project.definition), request.shareMode));
    if (share === "unchanged") return answer();
    const receivedAt = iso(deps);
    try {
      await deps.actions.transact(shareItems(deps, turns, current, share, { idempotencyKey, payloadHash, receivedAt, request: `admin share mode ${request.shareMode}`, admin }));
      await reload();
      return answer();
    } catch (error) {
      if (!isConditional(error)) throw error;
      // The same request committed first, or the notifier (or a close) changed the task: read it again.
      const committed = await get(deps, idempotencyKey) !== undefined;
      await reload();
      if (committed) return answer();
    }
  }
  throw agentXError("WORKSPACE_BUSY", "the task changed while switching its mode; try again");
}
