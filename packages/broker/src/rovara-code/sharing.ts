import { createHash } from "node:crypto";
// Legacy Slack shares use the session's live authority and the existing share DELETE route.
import { GetCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { agentSessionKey, agentXError, changesKey, sharedTaskKey, sessionBindingKey, sessionSurfaceKey, sessionEventId, INDEX_EXPIRY_ATTRIBUTE, cleanSessionName, type OrgId } from "@agentx/contracts";
import { sessionEventItem } from "../agent-sessions/store.js";
import { widenedShareMessage } from "../developer/share-messages.js";
import type { TransactItem } from "../agents/table-writes.js";
import { requireSessionLevel, type SessionCaller } from "../agent-sessions/access.js";
import type { SessionShareDependencies } from "../agent-sessions/shares.js";
import { aiToolTurn, effectiveTaskOwner, taskIndexKey, taskKey, type DeveloperTaskRecord, type TaskShare } from "../developer/task-records.js";

export const codeTask = (task: DeveloperTaskRecord): task is DeveloperTaskRecord & { orgId: OrgId; sessionId: string } => task.orgId !== undefined && task.sessionId !== undefined && task.workflow?.definitionId === "agentx-task-to-pr";

/** Ids only in the owner feed; names and the title are resolved by the consuming surface. */
export function codeShareItems(tableName: string, task: DeveloperTaskRecord, share: TaskShare, requestId: string, actorId: string, at: string, actorName = "A member", origin?: string): TransactItem[] {
  if (!codeTask(task) || (task.share !== undefined && (task.share.mode === "continue" || share.mode === "view"))) return [];
  const key = `SLACK#${requestId}`;
  const undoPath = `/v1/app/sessions/${task.sessionId}/shares/${encodeURIComponent(key)}`;
  const undoUrl = origin === undefined ? undoPath : new URL(undoPath, origin).href;
  return [
    sessionEventItem({ tableName }, { orgId: task.orgId, sessionId: task.sessionId }, {
      eventId: sessionEventId("shared", `code-share|${requestId}`), at, type: "shared",
      text: widenedShareMessage({ actor: actorName, title: task.title, who: share.channelName === undefined ? share.channelId : `#${share.channelName}`, undoUrl }),
    }),
    { Put: { TableName: tableName, Item: {
      ...agentSessionKey(task.orgId, task.sessionId, `SHARE#${key}`), entityType: "CODE_SHARE_UNDO", orgId: task.orgId,
      sessionId: task.sessionId, taskId: task.taskId, requestId, previousShare: task.share ?? null,
      expiresAt: Math.floor(Date.parse(at) / 1000) + 7 * 86_400,
      [INDEX_EXPIRY_ATTRIBUTE]: Math.floor(Date.parse(at) / 1000) + 7 * 86_400,
    }, ConditionExpression: "attribute_not_exists(pk)" } },
    ...(actorId === effectiveTaskOwner(task).developerId ? [] : [{ Put: { TableName: tableName, Item: {
      ...changesKey(task.orgId, effectiveTaskOwner(task).developerId, at, Number.parseInt(createHash("sha256").update(`${task.sessionId}|${requestId}`).digest("hex").slice(0, 6), 16) % 1_000_000),
      entityType: "CHANGE_NOTICE", orgId: task.orgId, type: "session_shared", sessionId: task.sessionId,
      revision: task.shareVersion === undefined ? 1 : task.shareVersion + 1, by: actorId, undo: { principalKey: key }, at,
      expiresAt: Math.floor(Date.parse(at) / 1000) + 7 * 86_400,
      [INDEX_EXPIRY_ATTRIBUTE]: Math.floor(Date.parse(at) / 1000) + 7 * 86_400,
    } } }]),
  ];
}

/** DELETE /sessions/{id}/shares/SLACK%23{requestId}; a newer share change invalidates an old undo. */
export async function undoCodeShare(deps: SessionShareDependencies, caller: SessionCaller, sessionId: string, key: string): Promise<{ removed: boolean }> {
  if (!/^SLACK#[0-9a-f-]{36}$/u.test(key)) throw agentXError("CONFIG_INVALID", "share: invalid undo");
  const { session } = await requireSessionLevel(deps, caller, sessionId, "edit", "undo this share");
  const read = async (row: { pk: string; sk: string }) => ((await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: row, ConsistentRead: true }))) as { Item?: Record<string, unknown> }).Item;
  const snapshot = await read(agentSessionKey(caller.orgId, sessionId, `SHARE#${key}`));
  if (snapshot === undefined) return { removed: false };
  if (session.subject.kind !== "task" || snapshot["orgId"] !== caller.orgId || snapshot["taskId"] !== session.subject.taskId
    || typeof snapshot["expiresAt"] !== "number" || snapshot["expiresAt"] <= Math.floor(deps.now() / 1000)) throw agentXError("CONFIG_INVALID", "This share undo expired.");
  const task = await read(taskKey(session.subject.taskId)) as unknown as DeveloperTaskRecord & { codeShareRequestId?: string } | undefined;
  if (task === undefined || task.orgId !== caller.orgId || task.sessionId !== sessionId || !codeTask(task)) throw agentXError("NOT_FOUND", "session not found");
  const requestId = key.slice(6);
  if (task.codeShareRequestId !== requestId || task.closedAt !== undefined) throw agentXError("SESSION_REVISION_CONFLICT", "This share changed. Refresh the session.");
  const previous = snapshot["previousShare"] as TaskShare | null;
  // The record was written internally, but malformed storage must not widen access.
  if (previous !== null && (previous === undefined || previous.mode !== "view" || previous.teamId !== task.share?.teamId || previous.channelId !== task.share.channelId)) throw agentXError("CONFIG_INVALID", "This share undo cannot be read.");
  const restore = previous === null ? undefined : { ...previous, ...(task.share?.threadTs === undefined ? {} : { threadTs: task.share.threadTs }) };
  if (deps.turnRecordsTableName === undefined) throw agentXError("RUNTIME_UNAVAILABLE", "Share undo audit is unavailable.");
  const member = await deps.signInStore.getDeveloper(caller.developerId);
  if (member === undefined || member.revoked) throw agentXError("NOT_FOUND", "session not found");
  const name = cleanSessionName(member.displayName) ?? "A member";
  const at = new Date(deps.now()).toISOString();
  const owner = effectiveTaskOwner(task);
  const items: TransactItem[] = [
    { Update: { TableName: deps.tableName, Key: agentSessionKey(caller.orgId, sessionId, "META"),
      UpdateExpression: "ADD #revision :one", ConditionExpression: "orgId = :org AND #revision = :revision",
      ExpressionAttributeNames: { "#revision": "revision" }, ExpressionAttributeValues: { ":org": caller.orgId, ":revision": session.revision, ":one": 1 },
    } },
    sessionEventItem(deps, { orgId: caller.orgId, sessionId }, {
      eventId: sessionEventId("shared", `undo-code-share|${requestId}`), at, type: "shared",
      actor: { kind: "member", developerId: caller.developerId, name },
      text: `${name} undid sharing with ${cleanSessionName(task.share?.channelName ?? task.share?.channelId ?? "the channel") ?? "the channel"}.`,
    }),
    { Put: { TableName: deps.turnRecordsTableName, ConditionExpression: "attribute_not_exists(pk)", Item: aiToolTurn({
      party: { taskId: task.taskId, developerId: caller.developerId, provider: member.provider, developerName: name, client: task.client,
        workspaceId: task.workspaceId, settingsRevision: task.startingRevision }, turnId: requestId, action: "share", phase: "accepted", outcome: "accepted",
      receivedAt: at, finishedAt: at, request: "Undo Slack sharing", response: "Sharing was narrowed.",
    }) } },
    { Update: { TableName: deps.tableName, Key: taskKey(task.taskId),
      UpdateExpression: restore === undefined ? "SET #shared = :shared, shareVersion = :next REMOVE #share, codeShareRequestId" : "SET #shared = :shared, #share = :share, shareVersion = :next REMOVE codeShareRequestId",
      ConditionExpression: "orgId = :org AND codeShareRequestId = :request AND shareVersion = :version AND attribute_not_exists(closedAt)",
      ExpressionAttributeNames: { "#shared": "shared", "#share": "share" },
      ExpressionAttributeValues: { ":shared": restore !== undefined, ":next": (task.shareVersion ?? 0) + 1, ":org": caller.orgId, ":request": requestId, ":version": task.shareVersion, ...(restore === undefined ? {} : { ":share": restore }) },
    } },
    { Delete: { TableName: deps.tableName, Key: agentSessionKey(caller.orgId, sessionId, `SHARE#${key}`) } },
    ...[taskIndexKey(task.developerId, task.createdAt, task.taskId), ...(owner.developerId === task.developerId ? [] : [taskIndexKey(owner.developerId, task.createdAt, task.taskId)])].map((index) => ({ Update: {
      TableName: deps.tableName, Key: index, ConditionExpression: "attribute_exists(pk)", UpdateExpression: "SET #shared = :shared", ExpressionAttributeNames: { "#shared": "shared" }, ExpressionAttributeValues: { ":shared": restore !== undefined },
    } })),
  ];
  if (task.share?.threadTs !== undefined) items.push(restore === undefined
    ? { Delete: { TableName: deps.tableName, Key: sharedTaskKey({ teamId: task.share.teamId, channelId: task.share.channelId, threadTs: task.share.threadTs }) } }
    : { Update: { TableName: deps.tableName, Key: sharedTaskKey({ teamId: task.share.teamId, channelId: task.share.channelId, threadTs: task.share.threadTs }), UpdateExpression: "SET #mode = :mode", ExpressionAttributeNames: { "#mode": "mode" }, ExpressionAttributeValues: { ":mode": restore.mode } } });
  if (restore === undefined && task.share?.threadTs !== undefined) {
    const binding = { kind: "slack_thread" as const, teamId: task.share.teamId, channelId: task.share.channelId, threadTs: task.share.threadTs };
    items.push(
      { Delete: { TableName: deps.tableName, Key: sessionBindingKey(caller.orgId, sessionId, "slack_thread"),
        ConditionExpression: "attribute_not_exists(pk) OR (orgId = :org AND sessionId = :session AND binding.teamId = :team AND binding.channelId = :channel AND binding.threadTs = :thread)",
        ExpressionAttributeValues: { ":org": caller.orgId, ":session": sessionId, ":team": binding.teamId, ":channel": binding.channelId, ":thread": binding.threadTs },
      } },
      { Delete: { TableName: deps.tableName, Key: sessionSurfaceKey(caller.orgId, binding),
        ConditionExpression: "attribute_not_exists(pk) OR (orgId = :org AND sessionId = :session)", ExpressionAttributeValues: { ":org": caller.orgId, ":session": sessionId },
      } },
    );
  }
  await deps.documentClient.send(new TransactWriteCommand({ TransactItems: items }));
  return { removed: true };
}
