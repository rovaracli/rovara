// Moving a session between a Mac and the cloud (Plan 5 Task 19): `POST /v1/app/sessions/{id}/handoff`. One session and one link run across the moves; each stretch on a place is a leg.
//
// WHO MAY MOVE IT: the session's owner (the effective owner, so the taker after a take-over) and nobody else: a person who can edit it, a project maintainer and an org admin get FORBIDDEN
// "Only <owner> can move this session."; a person who can't see it gets NOT_FOUND. The destination's own rules apply, read now: a move to the cloud is paid work, so the owner needs a
// project role that starts work, the project must not be archived, the repository must be one of the project's, and the owner's budget is checked by the same `admitPayer` a retry and a
// take-over use (it fails closed: without it nothing starts); a move to a Mac needs a Mac that is the owner's own and not removed, the company's rule for the tool and project, and room on
// that Mac. A chain run and an agent-step run stay in the cloud.
//
// LEGS ARE ATOMIC: the session is on exactly one place, and a failure on either side leaves it there.
//   - To the cloud: Plan 6's runtime starts the task first (idempotent by a request id derived from the request), and then ONE transaction ends the Mac leg, adds the cloud leg, moves
//     `subject`, `kind`, `where` and the payer, names the session on the task, takes the Mac's entry away and gives the Mac a `stop` command, moves the tile, and writes the `handoff`
//     event and the request. Everything the transaction rests on was read again just before it; if the session is no longer movable (it ended, moved or changed owner) the task that was
//     started is cancelled and the session is untouched. An outcome the table did not report (a timeout) cancels nothing: the same request id finishes the move with the same task.
//   - To a Mac: the task is cancelled, its branch pushed, and then ONE transaction ends the cloud leg, adds the Mac leg, moves the session, clears the task's `sessionId`, creates the Mac's
//     state and entry, drops the followers who can't see a session on a Mac, and writes the event and the request with its answer. A failure before the transaction leaves the session in the
//     cloud with its task cancelled (nothing is lost: the branch is pushed, and the same request id asks again, which both calls tolerate).
import { createHash } from "node:crypto";
import { TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import {
  HANDOFF_ALREADY_CLOUD_MESSAGE,
  HANDOFF_ALREADY_MAC_MESSAGE,
  HANDOFF_AGENT_RUN_MESSAGE,
  HANDOFF_BAD_ANSWER_MESSAGE,
  HANDOFF_BUDGET_NOT_CHECKED_MESSAGE,
  HANDOFF_BUDGET_UNAVAILABLE_MESSAGE,
  HANDOFF_BUSY_MESSAGE,
  HANDOFF_CHAIN_MESSAGE,
  HANDOFF_NOT_READY_MESSAGE,
  HANDOFF_NO_PROJECT_MESSAGE,
  HANDOFF_SUMMARY_MAX_BYTES,
  HANDOFF_TOO_MANY_LEGS_MESSAGE,
  HandoffBodySchema,
  HandoffShaSchema,
  HandoffToMacAnswerSchema,
  INDEX_EXPIRY_ATTRIBUTE,
  LOCAL_OPEN_MAX_MESSAGE,
  LOCAL_OPEN_PER_DEVICE_MAX,
  SESSION_ENDED_MESSAGE,
  SESSION_LEGS_MAX,
  SESSION_RETENTION_DAYS,
  SESSION_STATUS_WORDS,
  agentSessionKey,
  agentXError,
  canonicalJson,
  deviceSessionKey,
  handoffOwnerOnlyMessage,
  handoffRepositoryMessage,
  handoffRoleLostMessage,
  handoffStartWorkMessage,
  liveSessionKey,
  projectAllows,
  projectArchivedMessage,
  redactText,
  sessionEventId,
  GitBranchNameSchema,
  type AgentSessionRecord,
  type HandoffBody,
  type HandoffToCloudBody,
  type HandoffToMacAnswer,
  type HandoffToMacBody,
  type LocalTool,
  type OrgId,
  type RunInput,
  type SessionView,
} from "@agentx/contracts";
import { projectRepository } from "../agents/comment-trigger-optouts.js";
import { failedIndexes, isTransactionConflict, NOT_EXISTS, type Item, type TransactItem } from "../agents/table-writes.js";
import { readProjectMeta } from "../developer/project-roles.js";
import { taskKey, type DeveloperTaskRecord } from "../developer/task-records.js";
import { commandableDevice, readLocalState } from "../devices/local-facts.js";
import { checkLocalAgentAllowed, readLocalAgentPolicy } from "../devices/policy.js";
import { announceDeviceCommand, deviceCommandItems, deviceStillTheirs, openSessionsOnDevice, ownLiveDevice } from "../devices/local-sessions.js";
import { invalidBody } from "../devices/store.js";
import { followerIds } from "../realtime/sink.js";
import { NO_SLACK_PROJECT_MEMBERS, followerStanding, requireSessionLevel, type SessionAccess } from "./access.js";
import { removeFollower } from "./followers.js";
import type { SessionReadDependencies } from "./read.js";
import {
  NOT_AVAILABLE, afterControl, answerOf, controlRequestItem, getItem, isEnded, isoOf, nameOrSomeone, readControlRequest, repeatOf, taskOfSession, type ControlCaller, type ControlRequest,
} from "./stop.js";
import { AgentSessionStore, legItems, legsAfterMove, sessionEventItem } from "./store.js";

/**
 * Plan 6's seam (H1): moving code. Both calls are made only after this module has checked the owner's authority, the destination's rules and (for a start) the owner's budget.
 * `startOnBranch` starts a cloud task for `owner` (who also pays) on a branch that the Mac pushed, with `input` as the task's request; it must NOT create a session of its own (this module
 * names the session on the task) and must answer the same task for the same `requestId` (a repeat of a move that was cut off finds its task). `pushToBranch` pushes the cancelled
 * task's work to its branch and answers where; it is asked again on a repeat and must tolerate that.
 */
export interface HandoffRuntime {
  startOnBranch(deps: HandoffDependencies, input: {
    orgId: OrgId; project: string; owner: { developerId: string; name: string }; repository: string; branch: string; headSha: string; input: RunInput;
    /** Derived from the org, the session and the move's request id: one task per request. */
    requestId: string;
  }): Promise<{ taskId: string }>;
  pushToBranch(deps: HandoffDependencies, input: { orgId: OrgId; taskId: string }): Promise<{ repository: string; branch: string; headSha: string }>;
}

export interface HandoffDependencies extends SessionReadDependencies {
  /** Plan 6's runtime. Without it every move answers `RUNTIME_UNAVAILABLE` with the exact text of the plan. */
  handoff?: HandoffRuntime | undefined;
  /** The project's repositories (Plan 3's own reader). Without it a move to the cloud is refused: the repository can't be checked. */
  projectRepositories?: ((orgId: OrgId, project: string) => Promise<ReadonlyArray<{ name: string; url: string; installationId?: number | undefined }> | undefined>) | undefined;
}

export type HandoffAnswer = { session: SessionView } | HandoffToMacAnswer;

const ATTEMPTS = 3;
const DAY_SECONDS = 86_400;
const KEEP_SECONDS = SESSION_RETENTION_DAYS * DAY_SECONDS;
const REQUEST_KEEP_SECONDS = 30 * DAY_SECONDS;
/** The most followers one move takes away inside its transaction; the rest are removed right after (the notice sink re-checks every follower anyway). */
const FOLLOWERS_PER_MOVE_MAX = 60;
const JUDGE_CONCURRENCY = 8;
const DEFAULT_MAC_TOOL: LocalTool = "rovara";
const RUN_TEXT_HEADING = "Where the work stands";
const NOT_READABLE = "This session can't be read right now.";

const PushedSchema = z.object({ repository: z.string().min(1).max(200), branch: GitBranchNameSchema, headSha: HandoffShaSchema });
const TaskIdSchema = z.string().uuid();

const sha256 = (value: unknown) => createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");

/** A version-4 shaped id from these parts: the same parts always give the same id. */
function derivedUuid(...parts: string[]): string {
  const bytes = createHash("sha256").update(parts.join("\n"), "utf8").digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** The request id the cloud task is started with: every attempt at the same move names the same task, another request names another. */
export const handoffRunRequestId = (orgId: OrgId, sessionId: string, requestId: string): string => derivedUuid("session-handoff-start", orgId, sessionId, requestId);
const handoffCancelRequestId = (orgId: OrgId, sessionId: string, requestId: string): string => derivedUuid("session-handoff-cancel", orgId, sessionId, requestId);

function parseBody(body: unknown): HandoffBody {
  const parsed = HandoffBodySchema.safeParse(body);
  if (!parsed.success) throw invalidBody(parsed.error.issues[0]);
  return parsed.data;
}

const isAgentXError = (error: unknown): error is Error & { code?: string } => error instanceof Error && error.name === "AgentXError";
const logOf = (deps: Pick<SessionReadDependencies, "log">) => deps.log ?? ((entry: Record<string, unknown>) => console.log(JSON.stringify({ component: "broker", ...entry })));

/** Where the work stands, in words, for the Mac: the title, the status and what the session last showed, cut to `HANDOFF_SUMMARY_MAX_BYTES`. */
function summaryOf(session: AgentSessionRecord): string {
  const lines = [`Session: ${session.title}`, `Status: ${SESSION_STATUS_WORDS[session.summary.status]}`];
  if (session.summary.step !== undefined) lines.push(`Step: ${session.summary.step}`);
  if (session.summary.peek !== undefined) lines.push(`Latest: ${session.summary.peek}`);
  let text = lines.join("\n");
  const bytes = new TextEncoder();
  while (bytes.encode(text).length > HANDOFF_SUMMARY_MAX_BYTES) text = [...text].slice(0, Math.floor([...text].length * 0.9)).join("");
  return text;
}

/** What the Mac said of where the work stands, as the cloud task is told: secrets redacted and control and invisible characters (other than line breaks) turned into spaces. */
function informationFrom(summary: string): string {
  const clean = redactText(summary).replace(/(?![\n\t\r])[\p{Cc}\p{Cf}]/gu, " ").trim();
  return clean === "" ? "(nothing was said about where the work stands)" : clean;
}

/** The tool of the latest Mac leg the session had, else Rovara's own. */
function toolOf(session: AgentSessionRecord): LocalTool {
  for (const leg of [...session.legs].reverse()) if (leg.subject.kind === "local") return leg.subject.tool;
  return session.subject.kind === "local" ? session.subject.tool : DEFAULT_MAC_TOOL;
}

// ---- the route's function

/**
 * `POST /v1/app/sessions/{id}/handoff` with `{ requestId, to: "cloud", repository, branch, headSha, summary }` (from a session on a Mac; answers the session) or
 * `{ requestId, to: "mac", deviceId }` (from a cloud task session; answers where the work was pushed). See the top of this file for the authority and the legs.
 */
export async function handoffSession(deps: HandoffDependencies, caller: ControlCaller, sessionId: string, body: unknown): Promise<HandoffAnswer> {
  const input = parseBody(body);
  const access = await requireSessionLevel(deps, caller, sessionId, "view", "move it");
  const { session } = access;
  if (!access.owner) throw agentXError("FORBIDDEN", handoffOwnerOnlyMessage(access.effectiveOwner.name));
  const { requestId, ...asked } = input;
  const fingerprint = sha256({ route: "session_handoff", ...asked });
  const prior = await readControlRequest(deps, session, requestId);
  if (prior !== undefined) return replayOf(deps, caller, session, input, prior, fingerprint);
  if (session.subject.kind === "chain") throw agentXError("CONFIG_INVALID", HANDOFF_CHAIN_MESSAGE);
  if (deps.handoff === undefined) throw agentXError("RUNTIME_UNAVAILABLE", HANDOFF_NOT_READY_MESSAGE);
  if (isEnded(session)) throw agentXError("SESSION_ENDED", SESSION_ENDED_MESSAGE);
  return input.to === "cloud" ? toCloud(deps, caller, access, input, fingerprint) : toMac(deps, caller, access, input, fingerprint);
}

/** A repeat of a request that was recorded: its stored answer, and nothing is written. The same id for another action or with another body is a mistake. */
async function replayOf(deps: HandoffDependencies, caller: ControlCaller, session: AgentSessionRecord, input: HandoffBody, prior: ControlRequest, fingerprint: string): Promise<HandoffAnswer> {
  repeatOf(prior, "handoff", caller.developerId);
  if (prior.fingerprint !== fingerprint) throw agentXError("CONFIG_INVALID", "requestId: this request ID was already used for a different request");
  if (input.to === "cloud") return answerOf(deps, caller, session.sessionId);
  const answer = HandoffToMacAnswerSchema.safeParse(prior.result);
  if (!answer.success) throw agentXError("RUNTIME_UNAVAILABLE", NOT_READABLE);
  return answer.data;
}

/** The session as it is now, for a move that is under way; a session that ended or isn't there reads as such. */
async function currentSession(deps: HandoffDependencies, session: Pick<AgentSessionRecord, "orgId" | "sessionId">): Promise<AgentSessionRecord> {
  const found = await new AgentSessionStore(deps).get(session.orgId, session.sessionId);
  if (found === undefined) throw agentXError("NOT_FOUND", "session not found");
  return found;
}

// ---- to the cloud

/** The checks a cloud leg's destination makes, all before any work starts: they are the rules of paid work in this project. */
async function checkCloudDestination(deps: HandoffDependencies, caller: ControlCaller, access: SessionAccess, input: HandoffToCloudBody): Promise<{ project: string; repository: string }> {
  const { session } = access;
  if (session.where.kind === "cloud" || session.kind !== "local" || session.subject.kind !== "local") throw agentXError("CONFIG_INVALID", HANDOFF_ALREADY_CLOUD_MESSAGE);
  if (session.legs.length >= SESSION_LEGS_MAX) throw agentXError("CONFIG_INVALID", HANDOFF_TOO_MANY_LEGS_MESSAGE);
  const project = session.project;
  if (project === undefined) throw agentXError("CONFIG_INVALID", HANDOFF_NO_PROJECT_MESSAGE);
  const role = await deps.projectMembers.roleOf(session.orgId, project, { developerId: caller.developerId, orgRole: access.orgRole });
  if (role === undefined || !projectAllows(role, "start_tasks")) throw agentXError("FORBIDDEN", handoffStartWorkMessage(project));
  if ((await readProjectMeta(deps, session.orgId, project))?.status === "archived") throw agentXError("PROJECT_ARCHIVED", projectArchivedMessage(project));
  if (deps.projectRepositories === undefined) throw agentXError("RUNTIME_UNAVAILABLE", HANDOFF_NOT_READY_MESSAGE);
  let repository: string | undefined;
  try {
    repository = await projectRepository({ projectRepositories: deps.projectRepositories }, session.orgId, project, input.repository);
  } catch (error) {
    // A project that can't be read is a retryable fault, never "not part of the project" and never a way through.
    logOf(deps)({ event: "agent_session.handoff_repositories_unreadable", sessionId: session.sessionId });
    throw isAgentXError(error) && error.code === "RUNTIME_UNAVAILABLE" ? error : agentXError("RUNTIME_UNAVAILABLE", HANDOFF_BAD_ANSWER_MESSAGE);
  }
  if (repository === undefined) throw agentXError("CONFIG_INVALID", handoffRepositoryMessage(input.repository, project));
  await admitOwner(deps, session, project, caller.developerId);
  return { project, repository };
}

/** The owner's budget, checked as the payer of a Rovara Code task before a cloud task starts. Fails closed: without the check nothing starts. */
async function admitOwner(deps: HandoffDependencies, session: AgentSessionRecord, project: string, ownerId: string): Promise<void> {
  if (deps.admitPayer === undefined) throw agentXError("RUNTIME_UNAVAILABLE", HANDOFF_BUDGET_NOT_CHECKED_MESSAGE);
  try {
    await deps.admitPayer({ orgId: session.orgId, project, payer: { kind: "member", developerId: ownerId }, agentId: "rovara-code", agentName: "Rovara Code", path: "TASK" });
  } catch (error) {
    if (isAgentXError(error) && error.code === "MODEL_PROXY_UNAVAILABLE") throw agentXError("RUNTIME_UNAVAILABLE", HANDOFF_BUDGET_UNAVAILABLE_MESSAGE);
    throw error;
  }
}

async function toCloud(deps: HandoffDependencies, caller: ControlCaller, access: SessionAccess, input: HandoffToCloudBody, fingerprint: string): Promise<HandoffAnswer> {
  const { session } = access;
  const { project, repository } = await checkCloudDestination(deps, caller, access, input);
  const owner = { developerId: caller.developerId, name: nameOrSomeone(caller.name) };
  const started = await deps.handoff!.startOnBranch(deps, {
    orgId: session.orgId, project, owner, repository, branch: input.branch, headSha: input.headSha,
    input: { text: session.title, context: [{ kind: "text", ref: "handoff", title: RUN_TEXT_HEADING, body: informationFrom(input.summary) }] },
    requestId: handoffRunRequestId(session.orgId, session.sessionId, input.requestId),
  });
  const taskId = TaskIdSchema.safeParse(started?.taskId);
  if (!taskId.success) {
    logOf(deps)({ event: "agent_session.handoff_task_unreadable", sessionId: session.sessionId });
    throw agentXError("RUNTIME_UNAVAILABLE", HANDOFF_BAD_ANSWER_MESSAGE);
  }
  const task = await getItem(deps, taskKey(taskId.data));
  // The task must be the owner's, on this project, of this org, and have no session: anything else is a runtime that answered wrongly, and the move does not use it.
  if (task === undefined || task["orgId"] !== session.orgId || task["developerId"] !== caller.developerId || task["project"] !== project || task["sessionId"] !== undefined) {
    await abandon(deps, session, input.requestId, taskId.data, task);
    throw agentXError("RUNTIME_UNAVAILABLE", HANDOFF_BAD_ANSWER_MESSAGE);
  }
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    const fresh = await currentSession(deps, session);
    const ours = fresh.subject.kind === "task" && fresh.subject.taskId === taskId.data;
    if (ours) return answerOf(deps, caller, session.sessionId);
    try {
      checkStillMovable(fresh, caller.developerId, "local");
    } catch (error) {
      await abandon(deps, session, input.requestId, taskId.data, task);
      throw error;
    }
    const device = await commandableDevice(deps, fresh);
    const nowMs = deps.now();
    const at = isoOf(nowMs);
    const name = owner.name;
    const moved = legsAfterMove(fresh.legs, { subject: { kind: "task", taskId: taskId.data }, where: { kind: "cloud" } }, at);
    const command = device === undefined ? undefined : await deviceCommandItems(deps, { orgId: session.orgId, deviceId: device.deviceId, ownerId: fresh.owner.developerId }, {
      kind: "stop", sessionId: session.sessionId, by: { developerId: caller.developerId, name },
    }, nowMs);
    const tile = await getItem(deps, liveSessionKey(session.orgId, session.sessionId));
    if (fresh.subject.kind !== "local") throw agentXError("CONFIG_INVALID", HANDOFF_ALREADY_CLOUD_MESSAGE);
    const deviceId = fresh.subject.deviceId;
    const items: TransactItem[] = [
      {
        Update: {
          TableName: deps.tableName, Key: agentSessionKey(session.orgId, session.sessionId, "META"),
          UpdateExpression: "SET #kind = :kind, #subject = :subject, #where = :where, #legs = :legs, #payer = :payer, updatedAt = :at ADD #revision :one",
          ConditionExpression: "attribute_exists(pk) AND orgId = :org AND #revision = :revision AND #kind = :local AND #subject.#kind = :local AND #subject.#deviceId = :device AND #owner.#developerId = :owner AND attribute_not_exists(endedAt)",
          ExpressionAttributeNames: {
            "#kind": "kind", "#subject": "subject", "#where": "where", "#legs": "legs", "#payer": "payer", "#revision": "revision", "#deviceId": "deviceId", "#owner": "owner", "#developerId": "developerId",
          },
          ExpressionAttributeValues: {
            ":kind": "task", ":subject": { kind: "task", taskId: taskId.data }, ":where": { kind: "cloud" }, ":legs": moved.legs, ":payer": { kind: "member", developerId: caller.developerId }, ":at": at,
            ":one": 1, ":revision": fresh.revision, ":org": session.orgId, ":local": "local", ":device": deviceId, ":owner": caller.developerId,
          },
        },
      },
      ...legItems(deps, session, [...moved.ended, moved.started]),
      // The task names the session (and is the owner's, in this org, and has no session yet).
      {
        Update: {
          TableName: deps.tableName, Key: taskKey(taskId.data), UpdateExpression: "SET sessionId = :session",
          ConditionExpression: "attribute_exists(pk) AND orgId = :org AND developerId = :owner AND attribute_not_exists(sessionId)",
          ExpressionAttributeValues: { ":session": session.sessionId, ":org": session.orgId, ":owner": caller.developerId },
        },
      },
      // The Mac's entry goes with the leg, and the Mac is told to stop; Mac updates are refused from here on because the session no longer names the device (Task 18).
      { Delete: { TableName: deps.tableName, Key: deviceSessionKey(session.orgId, deviceId, session.sessionId) } },
      ...(command === undefined ? [] : command.items),
      ...(tile === undefined ? [] : [{
        Update: {
          TableName: deps.tableName, Key: liveSessionKey(session.orgId, session.sessionId), UpdateExpression: "SET #kind = :kind, #where = :where, #revision = :revision",
          ConditionExpression: "attribute_exists(pk)", ExpressionAttributeNames: { "#kind": "kind", "#where": "where", "#revision": "revision" },
          ExpressionAttributeValues: { ":kind": "task", ":where": { kind: "cloud" }, ":revision": fresh.revision + 1 },
        },
      } satisfies TransactItem]),
      sessionEventItem(deps, session, {
        eventId: sessionEventId("handoff", input.requestId), at, type: "handoff", actor: { kind: "member", developerId: caller.developerId, name }, text: `${name} moved this session to the cloud.`,
      }),
      controlRequestItem(deps, session, input.requestId, { action: "handoff", by: caller.developerId, at, sessionId: session.sessionId, fingerprint }, Math.floor(nowMs / 1000) + REQUEST_KEEP_SECONDS),
    ];
    try {
      await deps.documentClient.send(new TransactWriteCommand({ TransactItems: items }));
    } catch (error) {
      // A conflict with another transaction on the same items, or a lost condition: read it all again and decide. Anything else is an outcome the table did not report: nothing is cancelled.
      if (!isTransactionConflict(error) && failedIndexes(error) === undefined) throw error;
      if (await recordedOrOurs(deps, caller, session, input.requestId, taskId.data)) return answerOf(deps, caller, session.sessionId);
      continue;
    }
    if (command !== undefined && device !== undefined) await announceDeviceCommand(deps, session.orgId, fresh.owner.developerId, device.deviceId, command.seq);
    await afterControl(deps, fresh, caller.developerId, fresh.owner.developerId);
    return answerOf(deps, caller, session.sessionId);
  }
  throw agentXError("RUNTIME_UNAVAILABLE", HANDOFF_BUSY_MESSAGE);
}

/** Whether this move was recorded by a call that raced this one, or the session already runs this very task. */
async function recordedOrOurs(deps: HandoffDependencies, caller: ControlCaller, session: AgentSessionRecord, requestId: string, taskId: string): Promise<boolean> {
  const recorded = await readControlRequest(deps, session, requestId);
  if (recorded !== undefined) {
    repeatOf(recorded, "handoff", caller.developerId);
    return true;
  }
  const now = await currentSession(deps, session);
  return now.subject.kind === "task" && now.subject.taskId === taskId;
}

/** A session that a move still fits: open, owned by the person moving it, and on the place the move leaves. */
function checkStillMovable(fresh: AgentSessionRecord, ownerId: string, from: "local" | "task"): void {
  if (isEnded(fresh)) throw agentXError("SESSION_ENDED", SESSION_ENDED_MESSAGE);
  if (fresh.owner.developerId !== ownerId) throw agentXError("FORBIDDEN", handoffOwnerOnlyMessage(fresh.owner.name));
  if (fresh.subject.kind !== from) throw agentXError("CONFIG_INVALID", from === "local" ? HANDOFF_ALREADY_CLOUD_MESSAGE : HANDOFF_ALREADY_MAC_MESSAGE);
  if (fresh.legs.length >= SESSION_LEGS_MAX) throw agentXError("CONFIG_INVALID", HANDOFF_TOO_MANY_LEGS_MESSAGE);
}

/**
 * The cloud task a move started cannot be the session's now (the session ended, moved, changed owner, or the runtime answered a task that isn't usable): it is cancelled so that nothing
 * pays for work nobody sees. Best effort and logged, and the move's own answer is the error that brought us here.
 */
async function abandon(deps: HandoffDependencies, session: Pick<AgentSessionRecord, "orgId" | "sessionId">, requestId: string, taskId: string, task: Item | undefined): Promise<void> {
  try {
    if (deps.control === undefined || task === undefined || task["orgId"] !== session.orgId) {
      logOf(deps)({ event: "agent_session.handoff_task_not_cancelled", sessionId: session.sessionId, taskId });
      return;
    }
    await deps.control.cancelTask(task as unknown as DeveloperTaskRecord, handoffCancelRequestId(session.orgId, session.sessionId, requestId));
  } catch (error) {
    logOf(deps)({ event: "agent_session.handoff_cancel_failed", sessionId: session.sessionId, taskId, error: error instanceof Error ? error.name : "unknown" });
  }
}

// ---- to a Mac

async function toMac(deps: HandoffDependencies, caller: ControlCaller, access: SessionAccess, input: HandoffToMacBody, fingerprint: string): Promise<HandoffAnswer> {
  const { session } = access;
  if (session.kind === "local" || session.subject.kind !== "task") throw agentXError("CONFIG_INVALID", HANDOFF_ALREADY_MAC_MESSAGE);
  const task = await taskOfSession(deps, session);
  if (task === undefined) throw agentXError("NOT_FOUND", "session not found");
  if (task.agent !== undefined) throw agentXError("CONFIG_INVALID", HANDOFF_AGENT_RUN_MESSAGE);
  if (session.legs.length >= SESSION_LEGS_MAX) throw agentXError("CONFIG_INVALID", HANDOFF_TOO_MANY_LEGS_MESSAGE);
  // The Mac's rules, all before the task is cancelled: the Mac is the owner's own and live, the owner still has a role, the company's rule allows the tool and the project, and there is room.
  const asker = { orgId: session.orgId, developerId: caller.developerId };
  await ownLiveDevice(deps, asker, input.deviceId);
  if (session.project !== undefined) {
    const role = await deps.projectMembers.roleOf(session.orgId, session.project, { developerId: caller.developerId, orgRole: access.orgRole });
    if (role === undefined) throw agentXError("PROJECT_ACCESS_DENIED", handoffRoleLostMessage(session.project));
  }
  const tool = toolOf(session);
  checkLocalAgentAllowed(await readLocalAgentPolicy(deps, session.orgId), tool, session.project);
  if (await openSessionsOnDevice(deps, session.orgId, input.deviceId, LOCAL_OPEN_PER_DEVICE_MAX) >= LOCAL_OPEN_PER_DEVICE_MAX) throw agentXError("CONFIG_INVALID", LOCAL_OPEN_MAX_MESSAGE);
  if (deps.control === undefined) throw agentXError("RUNTIME_UNAVAILABLE", NOT_AVAILABLE);

  // Cancel, then push: both are tolerant of a repeat, so a move that was cut off is finished by asking again.
  await deps.control.cancelTask(task, input.requestId);
  const pushed = PushedSchema.safeParse(await deps.handoff!.pushToBranch(deps, { orgId: session.orgId, taskId: task.taskId }));
  if (!pushed.success) {
    logOf(deps)({ event: "agent_session.handoff_push_unreadable", sessionId: session.sessionId });
    throw agentXError("RUNTIME_UNAVAILABLE", HANDOFF_BAD_ANSWER_MESSAGE);
  }
  const summary = summaryOf(session);
  const answer: HandoffToMacAnswer = { repository: pushed.data.repository, branch: pushed.data.branch, headSha: pushed.data.headSha, summary };

  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    const fresh = await currentSession(deps, session);
    if (fresh.subject.kind === "local" && await readControlRequest(deps, session, input.requestId) !== undefined) return answer;
    checkStillMovable(fresh, caller.developerId, "task");
    if (fresh.subject.kind !== "task" || fresh.subject.taskId !== task.taskId) throw agentXError("CONFIG_INVALID", HANDOFF_ALREADY_MAC_MESSAGE);
    // The Mac is read again for every attempt: one removed since the check is refused here, not by a condition that would fail the same way each time.
    const device = await ownLiveDevice(deps, asker, input.deviceId);
    const nowMs = deps.now();
    const at = isoOf(nowMs);
    const name = nameOrSomeone(caller.name);
    const label = device.label;
    const moved = legsAfterMove(fresh.legs, { subject: { kind: "local", deviceId: device.deviceId, tool }, where: { kind: "mac", deviceId: device.deviceId, label } }, at);
    const after: AgentSessionRecord = { ...fresh, kind: "local", subject: { kind: "local", deviceId: device.deviceId, tool }, where: { kind: "mac", deviceId: device.deviceId, label }, legs: moved.legs };
    const { dropNow, dropLater } = await followersWhoLose(deps, fresh, after);
    const local = await readLocalState(deps, fresh);
    const rev = typeof local?.["rev"] === "number" ? local["rev"] : undefined;
    const turnCount = typeof local?.["turnCount"] === "number" ? local["turnCount"] : 0;
    const tile = await getItem(deps, liveSessionKey(session.orgId, session.sessionId));
    const expires = Math.floor(nowMs / 1000) + KEEP_SECONDS;
    const items: TransactItem[] = [
      {
        Update: {
          TableName: deps.tableName, Key: agentSessionKey(session.orgId, session.sessionId, "META"),
          UpdateExpression: "SET #kind = :kind, #subject = :subject, #where = :where, #legs = :legs, #followers = :followers, updatedAt = :at REMOVE #payer ADD #revision :one",
          ConditionExpression: "attribute_exists(pk) AND orgId = :org AND #revision = :revision AND #kind = :task AND #subject.#kind = :task AND #subject.#taskId = :taskId AND #owner.#developerId = :owner AND #followers = :seen AND attribute_not_exists(endedAt)",
          ExpressionAttributeNames: {
            "#kind": "kind", "#subject": "subject", "#where": "where", "#legs": "legs", "#payer": "payer", "#revision": "revision", "#taskId": "taskId", "#owner": "owner", "#developerId": "developerId", "#followers": "followerCount",
          },
          ExpressionAttributeValues: {
            ":kind": "local", ":subject": after.subject, ":where": after.where, ":legs": moved.legs, ":followers": Math.max(0, fresh.followerCount - dropNow.length), ":seen": fresh.followerCount, ":at": at,
            ":one": 1, ":revision": fresh.revision, ":org": session.orgId, ":task": "task", ":taskId": task.taskId, ":owner": caller.developerId,
          },
        },
      },
      ...legItems(deps, session, [...moved.ended, moved.started]),
      // The task no longer drives the session: a later continue of it can't change what a Mac is doing (the session names it no more, and it names no session).
      {
        Update: {
          TableName: deps.tableName, Key: taskKey(task.taskId), UpdateExpression: "REMOVE sessionId",
          ConditionExpression: "attribute_exists(pk) AND orgId = :org AND sessionId = :session", ExpressionAttributeValues: { ":org": session.orgId, ":session": session.sessionId },
        },
      },
      // The Mac's state for the session starts again (its turns are kept in count, so numbers never repeat), and its entry lets the Mac's removal find the session.
      {
        Put: {
          TableName: deps.tableName,
          Item: {
            ...agentSessionKey(session.orgId, session.sessionId, "LOCAL"), entityType: "AGENT_SESSION_LOCAL", orgId: session.orgId, sessionId: session.sessionId, deviceId: device.deviceId,
            status: "running", costUsd: 0, turnCount, rev: rev === undefined ? 0 : rev + 1, updatedAt: at, [INDEX_EXPIRY_ATTRIBUTE]: expires,
          },
          ...(rev === undefined ? { ConditionExpression: NOT_EXISTS } : { ConditionExpression: "#rev = :rev", ExpressionAttributeNames: { "#rev": "rev" }, ExpressionAttributeValues: { ":rev": rev } }),
        },
      },
      { Put: { TableName: deps.tableName, Item: { ...deviceSessionKey(session.orgId, device.deviceId, session.sessionId), entityType: "DEVICE_SESSION", orgId: session.orgId, deviceId: device.deviceId, sessionId: session.sessionId, createdAt: at, [INDEX_EXPIRY_ATTRIBUTE]: expires } } },
      // The Mac is still the owner's own and not removed at the moment of the move.
      deviceStillTheirs(deps, session.orgId, device.deviceId, caller.developerId),
      ...(tile === undefined ? [] : [{
        Update: {
          TableName: deps.tableName, Key: liveSessionKey(session.orgId, session.sessionId), UpdateExpression: "SET #kind = :kind, #where = :where, #revision = :revision",
          ConditionExpression: "attribute_exists(pk)", ExpressionAttributeNames: { "#kind": "kind", "#where": "where", "#revision": "revision" },
          ExpressionAttributeValues: { ":kind": "local", ":where": after.where, ":revision": fresh.revision + 1 },
        },
      } satisfies TransactItem]),
      ...dropNow.map((developerId): TransactItem => ({ Delete: { TableName: deps.tableName, Key: agentSessionKey(session.orgId, session.sessionId, `FOLLOWER#${developerId}`), ConditionExpression: "attribute_exists(pk)" } })),
      sessionEventItem(deps, session, {
        eventId: sessionEventId("handoff", input.requestId), at, type: "handoff", actor: { kind: "member", developerId: caller.developerId, name }, text: `${name} moved this session to ${label}.`,
      }),
      controlRequestItem(deps, session, input.requestId, { action: "handoff", by: caller.developerId, at, sessionId: session.sessionId, fingerprint, result: answer }, Math.floor(nowMs / 1000) + REQUEST_KEEP_SECONDS),
    ];
    try {
      await deps.documentClient.send(new TransactWriteCommand({ TransactItems: items }));
    } catch (error) {
      if (!isTransactionConflict(error) && failedIndexes(error) === undefined) throw error;
      const recorded = await readControlRequest(deps, session, input.requestId);
      if (recorded !== undefined) {
        repeatOf(recorded, "handoff", caller.developerId);
        return answer;
      }
      continue;
    }
    for (const developerId of dropLater) {
      try {
        await removeFollower(deps, session, developerId);
      } catch (error) {
        logOf(deps)({ event: "agent_session.handoff_follower_not_removed", sessionId: session.sessionId, error: error instanceof Error ? error.name : "unknown" });
      }
    }
    await afterControl(deps, fresh, caller.developerId, fresh.owner.developerId);
    return answer;
  }
  throw agentXError("RUNTIME_UNAVAILABLE", HANDOFF_BUSY_MESSAGE);
}

/**
 * The followers who can't see the session once it is on a Mac (it is then seen by its owner and the people it was shared with, nobody else), judged now on the read-only path as the notice sink
 * judges them: only a follower the check positively says has no access is dropped (one it can't decide keeps the follow, and is not told). Up to `FOLLOWERS_PER_MOVE_MAX` go in the move's transaction.
 */
async function followersWhoLose(deps: HandoffDependencies, before: AgentSessionRecord, after: AgentSessionRecord): Promise<{ dropNow: string[]; dropLater: string[] }> {
  const ids = (await followerIds({ documentClient: deps.documentClient, tableName: deps.tableName, now: deps.now, log: logOf(deps) }, before)).filter((id) => id !== before.owner.developerId);
  const access = { documentClient: deps.documentClient, tableName: deps.tableName, now: deps.now, projectMembers: NO_SLACK_PROJECT_MEMBERS };
  const lost: string[] = [];
  for (let at = 0; at < ids.length; at += JUDGE_CONCURRENCY) {
    const chunk = ids.slice(at, at + JUDGE_CONCURRENCY);
    const standing = await Promise.all(chunk.map((developerId) => followerStanding(access, { orgId: before.orgId, developerId }, after)));
    chunk.forEach((developerId, index) => { if (standing[index] === "lost") lost.push(developerId); });
  }
  return { dropNow: lost.slice(0, FOLLOWERS_PER_MOVE_MAX), dropLater: lost.slice(FOLLOWERS_PER_MOVE_MAX) };
}
