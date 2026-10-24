// Taking a session over (Plan 5 Task 12b). A take-over moves authority (who decides, who may steer, and, for a member-paid run, who pays), so it is a pending change that
// the person who asks confirms in a browser signed in within ten minutes, like every approval (R66): `POST /v1/app/sessions/{id}/take-over` answers `202 NEEDS_CONFIRMATION`
// with Plan 3's ticketed link, and confirming runs `onSessionOwnerConfirmed`. That moves, in ONE transaction conditional on the session's revision and on the task's owner,
// the session's owner, the task's current owner and payer, the taker's task-list row and the task's People owners; the previous owner keeps "can edit"; and the take-over is
// audited. Everything the approval rests on is read live each time it is looked at: the asker's access, their role on the project and their room to pay.
import { GetCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import {
  SESSION_ENDED_MESSAGE,
  SlackUserIdSchema,
  agentSessionKey,
  agentXError,
  cleanSessionName,
  liveSessionKey,
  mySessionsKey,
  projectAllows,
  principalKey,
  sessionChannel,
  sessionEventId,
  sessionOnMacMessage,
  sharedSessionsKey,
  userChannel,
  type AgentSessionRecord,
  type NeedsConfirmation,
  type OrgId,
  type Payer,
} from "@agentx/contracts";
import {
  createPendingChange,
  registerApprovalSubjectHandler,
  registerApproverRule,
  type AnyApprovalRecord,
  type ApprovalDependencies,
} from "../agents/approvals.js";
import { resolveMember, sameMember } from "../agents/lifecycle.js";
import { failedIndexes, isTransactionConflict, withoutUndefined, type Item, type TransactItem } from "../agents/table-writes.js";
import { flushAuditEvents } from "../audit/flush.js";
import { auditSessionOwnerChanged } from "../audit/events.js";
import { auditPending, tryAuditEvents } from "../audit/outbox.js";
import { auditActorOf } from "../audit/plan3-hooks.js";
import { loadTaskPeople, takeOverTaskPeopleItems } from "../developer/task-people.js";
import { effectiveTaskOwner, ownerFenceOf, taskIndexKey, taskKey, type DeveloperTaskRecord } from "../developer/task-records.js";
import { followerIds } from "../realtime/sink.js";
import { writeChanges } from "../realtime/changes.js";
import { publishNotices, type RealtimeConfig } from "../realtime/publish.js";
import { requireSessionLevel, type SessionAccess } from "./access.js";
import { confirmationReply, type SessionShareDependencies, type ShareCaller } from "./shares.js";
import { AgentSessionStore, sessionEventItem } from "./store.js";

/**
 * Plan 4's chain run, behind a seam until Plan 4 merges (`setChainRunOwnerItems`): what a take-over needs of a chain run. `read` answers who pays for the run now and the task
 * of its running step, if one is running; `ownerItems` are the transaction items, conditional on the run as `read` saw it, that set the run's owner to `to` and, when `payer` is a
 * member, the run's payer to `to` too, so every later step starts with the taker as payer. Without it a chain session can't be taken over.
 */
export interface ChainOwnerMover {
  read(orgId: OrgId, chainRunId: string): Promise<{ payer: Payer; runningStepTaskId?: string } | undefined>;
  ownerItems(input: { orgId: OrgId; chainRunId: string; to: { developerId: string; name: string }; payer: Payer }): TransactItem[];
}

/** What a take-over needs beyond a share: the payer's admission (Plan 3's budget check, supplied by the broker), the realtime events API, and Plan 4's chain mover. */
export interface SessionTakeOverDependencies extends SessionShareDependencies {
  /** Plan 3's `admitWork` for `payer`, run for the person who would pay from now on: throws that budget's own refusal when they have no room. Without it nobody is checked. */
  admitPayer?: ((input: { orgId: OrgId; project: string; payer: Payer; agentId: string; agentName: string; path: "TASK" | "AGENT" }) => Promise<void>) | undefined;
  /** The events API the notices are posted to; without it only the feed is written. */
  realtimePublish?: RealtimeConfig | undefined;
  chainOwner?: ChainOwnerMover | undefined;
  log?: ((entry: Record<string, unknown>) => void) | undefined;
}

export const TAKE_OVER_RULE = "session_take_over";
const NOT_SET_UP = "Take-overs aren't set up in this deployment.";
const CHANGED = "This session changed since you asked. Ask again.";
const ALREADY_OWNER = "You already own this session.";
const CHAIN_NOT_AVAILABLE = "Taking over a chain run isn't available right now.";

const BodySchema = z.object({ requestId: z.string().uuid() }).strict();

const getItem = async (deps: Pick<SessionTakeOverDependencies, "documentClient" | "tableName">, key: { pk: string; sk: string }): Promise<Item | undefined> =>
  ((await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: key, ConsistentRead: true }))) as { Item?: Item }).Item;
const isoOf = (ms: number) => new Date(ms).toISOString();
const isAgentXError = (error: unknown): boolean => error instanceof Error && error.name === "AgentXError";
const nameOrSomeone = (name: string | undefined) => (name === undefined ? undefined : cleanSessionName(name)) ?? "Someone";

function parseBody(body: unknown): z.infer<typeof BodySchema> {
  const parsed = BodySchema.safeParse(body);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  const path = issue === undefined || issue.path.length === 0 ? "body" : issue.path.join(".");
  throw agentXError("CONFIG_INVALID", `${path}: ${issue === undefined || issue.code === "unrecognized_keys" ? "has a field this route does not take" : issue.message}`);
}

// ---- what a take-over rests on, read live

/**
 * Whether `caller` may take the session over now: they hold "can edit" (an org-role maintainer has only `view`, I5), the session is open and in the cloud, they don't own it
 * already, and they hold a project role that can start work (a Slack link or channel membership is not needed). Refuses with the words each case has. Asked when the take-over is
 * asked for, when it is decided and when it is applied.
 */
export async function requireTakeOver(deps: SessionTakeOverDependencies, caller: { orgId: OrgId; developerId: string }, sessionId: string): Promise<SessionAccess> {
  const access = await requireSessionLevel(deps, caller, sessionId, "edit", "take it over");
  const { session } = access;
  if (session.where.kind !== "cloud") throw agentXError("SESSION_ON_MAC", sessionOnMacMessage(access.effectiveOwner.name));
  if (session.endedAt !== undefined) throw agentXError("SESSION_ENDED", SESSION_ENDED_MESSAGE);
  if (access.owner) throw agentXError("CONFIG_INVALID", ALREADY_OWNER);
  if (session.project !== undefined) {
    const role = await deps.projectMembers.roleOf(caller.orgId, session.project, { developerId: caller.developerId, orgRole: access.orgRole });
    if (role === undefined || !projectAllows(role, "start_tasks")) {
      throw agentXError("FORBIDDEN", `You need a role on ${session.project} that can start work to take this over.`);
    }
  }
  return access;
}

/** The task of a task session (a task of another org is no task), or undefined for any other session. */
async function taskOfSession(deps: SessionTakeOverDependencies, session: AgentSessionRecord): Promise<(DeveloperTaskRecord & Item) | undefined> {
  if (session.subject.kind !== "task") return undefined;
  const found = await getItem(deps, taskKey(session.subject.taskId));
  if (found === undefined || found["orgId"] !== session.orgId) throw agentXError("NOT_FOUND", "session not found");
  return found as unknown as DeveloperTaskRecord & Item;
}

interface PayerFacts { payer: Payer; chainStepTaskId?: string | undefined }

/** Who pays for the session now: a task's payer (its creator when none was recorded), or a chain run's. */
async function payerOfSession(deps: SessionTakeOverDependencies, session: AgentSessionRecord, task: DeveloperTaskRecord | undefined): Promise<PayerFacts> {
  if (task !== undefined) return { payer: task.payer ?? { kind: "member", developerId: task.developerId } };
  if (session.subject.kind === "chain") {
    if (deps.chainOwner === undefined) throw agentXError("RUNTIME_UNAVAILABLE", CHAIN_NOT_AVAILABLE);
    const run = await deps.chainOwner.read(session.orgId, session.subject.chainRunId);
    if (run === undefined) throw agentXError("NOT_FOUND", "session not found");
    return { payer: run.payer, chainStepTaskId: run.runningStepTaskId };
  }
  return { payer: session.payer ?? { kind: "member", developerId: session.owner.developerId } };
}

/** Runs the budget check for the person who would pay from now on, when the payer is a member. A proxy outage is a retryable fault, never a refusal of the person. */
async function admitTaker(deps: SessionTakeOverDependencies, session: AgentSessionRecord, task: DeveloperTaskRecord | undefined, payer: Payer, taker: string): Promise<void> {
  if (payer.kind !== "member" || deps.admitPayer === undefined || session.project === undefined) return;
  const agent = task?.agent ?? (session.agent === undefined ? undefined : { agentId: session.agent.agentId, name: session.agent.name });
  try {
    await deps.admitPayer({
      orgId: session.orgId, project: session.project, payer: { kind: "member", developerId: taker },
      agentId: agent?.agentId ?? "rovara-code", agentName: agent?.name ?? "Rovara Code", path: agent === undefined || agent.agentId === "rovara-code" ? "TASK" : "AGENT",
    });
  } catch (error) {
    if (error instanceof Error && (error as { code?: string }).code === "MODEL_PROXY_UNAVAILABLE") throw agentXError("RUNTIME_UNAVAILABLE", "Rovara couldn't check the budget just now. Try again in a moment.");
    throw error;
  }
}

/** Who pays from now on, in words: the taker's own budget when a member pays, else whoever pays now. */
function payerWords(payer: Payer, taker: string, session: AgentSessionRecord): string {
  if (payer.kind === "member") return `${taker}'s budget`;
  if (payer.kind === "project") return `the ${payer.project} project's budget`;
  return session.agent === undefined ? "the agent's budget" : `${session.agent.name}'s budget`;
}

async function nameOf(deps: SessionTakeOverDependencies, developerId: string): Promise<string | undefined> {
  try {
    const record = await deps.signInStore.getDeveloper(developerId);
    return record === undefined ? undefined : cleanSessionName(record.displayName);
  } catch {
    return undefined;
  }
}

// ---- POST /v1/app/sessions/{id}/take-over

/**
 * Asks to take the session over. The caller needs "can edit", an open cloud session they don't own, and a project role that can start work; a member payer's budget must have room
 * for them (Plan 3's refusal, and nothing is written). It makes a pending change for the caller alone to decide and answers `202` with the ticketed link; nothing changes before it
 * is confirmed. The same `requestId` answers the same approval.
 */
export async function askTakeOver(deps: SessionTakeOverDependencies, caller: ShareCaller, sessionId: string, body: unknown, approvals?: ApprovalDependencies): Promise<{ status: 202; body: NeedsConfirmation }> {
  const input = parseBody(body);
  const access = await requireTakeOver(deps, caller, sessionId);
  if (approvals === undefined) throw agentXError("RUNTIME_UNAVAILABLE", "Taking a session over isn't available right now.");
  const { session } = access;
  const task = await taskOfSession(deps, session);
  const { payer } = await payerOfSession(deps, session, task);
  await admitTaker(deps, session, task, payer, caller.developerId);
  const taker = nameOrSomeone(caller.name);
  const record = await createPendingChange(approvals, {
    orgId: caller.orgId, requestId: input.requestId, requestedBy: caller.developerId,
    subject: { kind: "session_owner", sessionId: session.sessionId, to: caller.developerId, sessionRevision: session.revision },
    changes: [`${taker} becomes the owner of "${session.title}".`, `New AI spend counts against ${payerWords(payer, taker, session)}.`, `${nameOrSomeone(access.effectiveOwner.name)} keeps "can edit".`],
    approvers: { kind: "rule", rule: TAKE_OVER_RULE, candidates: [caller.developerId] },
  });
  // A replay of a request that was decided since is not waiting any more.
  if (record.status !== "PENDING") throw agentXError("APPROVAL_CLOSED", "this request was already decided");
  return confirmationReply(approvals, caller, record);
}

// ---- the page's facts

/** The facts the confirmation page shows for a take-over, read now: the session, the project, who owns it now, the new owner, who pays from now and (the page adds) when it expires. */
export async function takeOverFacts(deps: SessionTakeOverDependencies | undefined, record: Extract<AnyApprovalRecord, { kind: "change" }>): Promise<Array<{ label: string; value: string }>> {
  const subject = record.subject as { sessionId: string; to: string };
  const fact = (label: string, value: string) => ({ label, value });
  if (deps === undefined) return [fact("Session", subject.sessionId)];
  try {
    const session = await new AgentSessionStore(deps).get(record.orgId, subject.sessionId);
    if (session === undefined) return [fact("Session", subject.sessionId)];
    const task = await taskOfSession(deps, session);
    const now = task === undefined ? session.owner : effectiveTaskOwnerNamed(task, session);
    const taker = nameOrSomeone(await nameOf(deps, subject.to));
    const { payer } = await payerOfSession(deps, session, task);
    return [
      fact("Session", session.title), ...(session.project === undefined ? [] : [fact("Project", session.project)]),
      fact("Owner now", nameOrSomeone(now.name)), fact("New owner", taker), fact("Who pays from now", payerWords(payer, taker, session)),
    ];
  } catch {
    return [fact("Session", subject.sessionId)];
  }
}

function effectiveTaskOwnerNamed(task: DeveloperTaskRecord, session: AgentSessionRecord): { developerId: string; name: string } {
  try {
    const owner = effectiveTaskOwner(task);
    return owner.developerId === session.owner.developerId ? session.owner : { developerId: owner.developerId, name: owner.name };
  } catch {
    return session.owner;
  }
}

// ---- what confirming does

const isChange = (record: AnyApprovalRecord): record is Extract<AnyApprovalRecord, { kind: "change" }> => record.kind === "change";

/**
 * The transaction items that move one task to the taker: its current owner and an explicit payer (the taker when a member pays, else unchanged), conditional on the task still being
 * owned by the owner it was read with; the taker's task-list row (copied from the creator's, which keeps its own); and the People list's owners lowered when the task has one.
 */
async function taskItems(deps: SessionTakeOverDependencies, task: DeveloperTaskRecord & Item, taker: { developerId: string; name?: string; provider: string; slackUserId?: string }, payer: Payer, at: string): Promise<TransactItem[]> {
  const fence = ownerFenceOf(task);
  const currentOwner = withoutUndefined({ developerId: taker.developerId, name: taker.name, provider: taker.provider, slackUserId: taker.slackUserId, since: at });
  const items: TransactItem[] = [{
    Update: {
      TableName: deps.tableName, Key: taskKey(task.taskId), UpdateExpression: "SET currentOwner = :currentOwner, payer = :payer, updatedAt = :at",
      ConditionExpression: `attribute_exists(pk) AND orgId = :orgId AND ${fence.expression}`,
      ExpressionAttributeNames: fence.names,
      ExpressionAttributeValues: { ...fence.values, ":currentOwner": currentOwner, ":payer": payer, ":at": at, ":orgId": task.orgId },
    },
  }];
  const creatorRow = await getItem(deps, taskIndexKey(task.developerId, task.createdAt, task.taskId));
  const key = taskIndexKey(taker.developerId, task.createdAt, task.taskId);
  items.push({
    Put: {
      TableName: deps.tableName,
      Item: creatorRow !== undefined ? { ...creatorRow, ...key, orgId: task.orgId } : withoutUndefined({
        ...key, entityType: "DEVELOPER_TASK_INDEX", taskId: task.taskId, orgId: task.orgId, project: task.project, title: task.title, client: task.client ?? "app", status: "RUNNING",
        shared: task.shared ?? false, startingRevision: task.startingRevision, workspaceId: task.workspaceId, createdAt: task.createdAt, updatedAt: at,
      }),
    },
  });
  const people = await loadTaskPeople(deps, task.taskId);
  if (people !== undefined) items.push(...takeOverTaskPeopleItems(deps, task, people, taker.developerId));
  return items;
}

/** Registers the rule and the handler behind `session_owner`. Safe to call more than once. */
export function registerSessionTakeOverApprovals(): void {
  // The asker and nobody else, while they can still take the session over: read now, never from what they could do when they asked.
  registerApproverRule(TAKE_OVER_RULE, async (deps, record, caller) => {
    if (!isChange(record) || record.subject.kind !== "session_owner" || caller.orgId !== record.orgId || deps.agentSessions === undefined) return false;
    // The person it names is the person who asked, or the member they were merged into since.
    if (!await sameMember(deps, record.orgId, record.subject.to, record.requestedBy) || !await sameMember(deps, record.orgId, record.requestedBy, caller.developerId)) return false;
    try {
      await requireTakeOver(deps.agentSessions, caller, record.subject.sessionId);
      return true;
    } catch (error) {
      if (isAgentXError(error)) return false;
      throw error;
    }
  });
  registerApprovalSubjectHandler("session_owner", async (deps, record, decision) => {
    if (!isChange(record) || record.subject.kind !== "session_owner") return;
    const sessions = deps.agentSessions;
    // `CONFIG_INVALID`, not `RUNTIME_UNAVAILABLE`: nothing here will start working by trying again, so the approval ends with these words.
    if (sessions === undefined) throw agentXError("CONFIG_INVALID", NOT_SET_UP);
    // A record nobody decided is never applied: the take-over would be credited to the person who asked.
    if (record.decidedBy === undefined) throw agentXError("CONFIG_INVALID", "this change has not been decided by anyone, so it can't be applied");
    const subject = record.subject;
    // The taker is the member the named person is now: a person merged into another since asking is the survivor, and a merged-away id never becomes an owner.
    const takerId = await resolveMember(deps, record.orgId, subject.to);
    if (!await sameMember(deps, record.orgId, takerId, record.decidedBy)) throw agentXError("CONFIG_INVALID", "this change was decided by someone other than the person it names, so it can't be applied");
    const stored = await new AgentSessionStore(sessions).get(record.orgId, subject.sessionId);
    if (stored === undefined) throw agentXError("NOT_FOUND", "session not found");
    // A handler called again for the take-over that already applied (a lost answer) finds it done.
    if (stored.lastTakeOverApprovalId === record.approvalId) return;
    const access = await requireTakeOver(sessions, { orgId: record.orgId, developerId: takerId }, subject.sessionId);
    const { session } = access;
    if (session.revision !== subject.sessionRevision) throw agentXError("SESSION_REVISION_CONFLICT", CHANGED);

    const task = await taskOfSession(sessions, session);
    const { payer, chainStepTaskId } = await payerOfSession(sessions, session, task);
    await admitTaker(sessions, session, task, payer, takerId);
    const takerRecord = await sessions.signInStore.getDeveloper(takerId);
    if (takerRecord === undefined) throw agentXError("NOT_FOUND", "the person taking this over could not be found");
    const takerName = nameOrSomeone(takerRecord.displayName);
    const taker = {
      developerId: takerId, provider: takerRecord.provider,
      ...(cleanSessionName(takerRecord.displayName) === undefined ? {} : { name: cleanSessionName(takerRecord.displayName)! }),
      ...(takerRecord.slackUserId !== undefined && SlackUserIdSchema.safeParse(takerRecord.slackUserId).success ? { slackUserId: takerRecord.slackUserId } : {}),
    };
    const previous = { developerId: access.effectiveOwner.developerId, name: nameOrSomeone(access.effectiveOwner.name) };
    const nowMs = deps.now();
    const at = isoOf(nowMs);
    const newPayer: Payer = payer.kind === "member" ? { kind: "member", developerId: takerId } : payer;
    const payerMoved = payer.kind === "member";
    const orgId = record.orgId;
    const { sessionId } = session;

    const items: TransactItem[] = [{
      Update: {
        TableName: sessions.tableName, Key: agentSessionKey(orgId, sessionId, "META"),
        UpdateExpression: `SET #owner = :owner, lastTakeOverApprovalId = :approval, updatedAt = :at${payerMoved ? ", payer = :payer" : ""} ADD #revision :one`,
        ConditionExpression: "attribute_exists(pk) AND #revision = :revision AND attribute_not_exists(endedAt)",
        ExpressionAttributeNames: { "#owner": "owner", "#revision": "revision" },
        ExpressionAttributeValues: { ":owner": { developerId: takerId, name: takerName }, ":approval": record.approvalId, ":at": at, ":one": 1, ":revision": session.revision, ...(payerMoved ? { ":payer": newPayer } : {}) },
      },
    }];
    if (task !== undefined) items.push(...await taskItems(sessions, task, taker, newPayer, at));
    if (session.subject.kind === "chain") {
      items.push(...sessions.chainOwner!.ownerItems({ orgId, chainRunId: session.subject.chainRunId, to: { developerId: takerId, name: takerName }, payer }));
      if (chainStepTaskId !== undefined) {
        const step = await getItem(sessions, taskKey(chainStepTaskId));
        if (step !== undefined && step["orgId"] === orgId) {
          const stepTask = step as unknown as DeveloperTaskRecord & Item;
          const stepPayer: Payer = stepTask.payer ?? { kind: "member", developerId: stepTask.developerId };
          items.push(...await taskItems(sessions, stepTask, taker, stepPayer.kind === "member" ? { kind: "member", developerId: takerId } : stepPayer, at));
        }
      }
    }
    // The previous owner keeps "can edit": a share and its index item.
    const principal = { kind: "member" as const, developerId: previous.developerId };
    items.push(
      { Put: { TableName: sessions.tableName, Item: { ...agentSessionKey(orgId, sessionId, `SHARE#${principalKey(principal)}`), entityType: "AGENT_SESSION_SHARE", orgId, sessionId, principal, level: "edit", sharedBy: { developerId: takerId, name: takerName }, sharedAt: at } } },
      { Put: { TableName: sessions.tableName, Item: { ...sharedSessionsKey(orgId, principal, sessionId), entityType: "SHARED_SESSION", orgId, sessionId, principal, level: "edit", sharedAt: at } } },
      { Put: { TableName: sessions.tableName, Item: { ...mySessionsKey(orgId, takerId, session.createdAt, sessionId), entityType: "MY_SESSION", orgId, sessionId, developerId: takerId, createdAt: session.createdAt } } },
    );
    // The live tile, when there is one (a session from before tiles has none).
    if (await getItem(sessions, liveSessionKey(orgId, sessionId)) !== undefined) {
      items.push({
        Update: {
          TableName: sessions.tableName, Key: liveSessionKey(orgId, sessionId), UpdateExpression: "SET ownerId = :owner", ConditionExpression: "attribute_exists(pk)", ExpressionAttributeValues: { ":owner": takerId },
        },
      });
    }
    items.push(sessionEventItem(sessions, { orgId, sessionId }, {
      eventId: sessionEventId("take_over", record.approvalId), at, type: "take_over", actor: { kind: "member", developerId: takerId, name: takerName },
      text: `${takerName} took over from ${previous.name}.`,
    }));
    const events = await tryAuditEvents(deps, () => [auditSessionOwnerChanged({
      orgId, actor: auditActorOf(takerId), occurredAt: at, occurrence: record.approvalId, ...(decision?.proof === undefined ? {} : { proof: decision.proof }),
      related: [previous.developerId, session.subject.kind === "task" ? session.subject.taskId : session.subject.kind === "chain" ? session.subject.chainRunId : sessionId],
      sessionId, sessionKind: session.kind, payerMoved,
    })]);
    items.push(...events.flatMap((event) => auditPending(deps, event)));

    try {
      await sessions.documentClient.send(new TransactWriteCommand({ TransactItems: items }));
    } catch (error) {
      const failed = failedIndexes(error);
      // A condition failed: the session, the task's owner or its People list moved since this was read. Nothing was written; the person asks again.
      if (failed !== undefined && failed.size > 0) throw agentXError("SESSION_REVISION_CONFLICT", CHANGED);
      // Only another transaction on the same items at the same moment: the same write is tried again.
      if (isTransactionConflict(error)) throw agentXError("RUNTIME_UNAVAILABLE", "This session is busy just now. Try again in a moment.");
      throw error;
    }
    await flushAuditEvents(deps, events);
    await tell(sessions, session, previous.developerId, takerId, at);
  });
}

/** After the commit: the previous owner (feed and channel), the followers and the session's own channel hear that it changed, ids and a revision only. Never throws. */
async function tell(deps: SessionTakeOverDependencies, session: AgentSessionRecord, previous: string, taker: string, at: string): Promise<void> {
  try {
    const log = deps.log ?? ((entry: Record<string, unknown>) => console.log(JSON.stringify({ component: "broker", ...entry })));
    const followers = (await followerIds({ documentClient: deps.documentClient, tableName: deps.tableName, now: deps.now, log }, session)).filter((id) => id !== taker);
    const hear = [...new Set([previous, ...followers])];
    const notice = { type: "session.updated" as const, sessionId: session.sessionId, revision: session.summaryRevision };
    await writeChanges({ documentClient: deps.documentClient, tableName: deps.tableName, now: deps.now, log }, session.orgId, hear.map((developerId) => ({ developerId, notice, at })));
    await publishNotices({ realtime: deps.realtimePublish, now: deps.now, log }, [
      { channel: sessionChannel(session.orgId, session.sessionId), notice },
      ...[...hear, taker].map((developerId) => ({ channel: userChannel(session.orgId, developerId), notice })),
    ]);
  } catch (error) {
    (deps.log ?? ((entry: Record<string, unknown>) => console.log(JSON.stringify({ component: "broker", ...entry }))))({ event: "agent_session.take_over_notice_failed", sessionId: session.sessionId, error: error instanceof Error ? error.name : "unknown" });
  }
}
