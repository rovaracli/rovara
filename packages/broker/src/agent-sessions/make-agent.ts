// Make this an agent (Plan 5 Task 10c): `POST /v1/app/sessions/{id}/agent` makes an agent, with its first draft, from a task session, and the draft remembers the session it came from.
//   - It needs `view` on the session AND the right to create agents in the session's project, each read live on every request. The right is Plan 3's own: a maintainer of the project, or an org owner or admin, who
//     becomes the agent's accountable maintainer (`mayCreateAgentIn`, which the session view also uses to say whether the person gets the `make_agent` action).
//   - The agent is owned by the project. It gets only what the session may give: the agent the session ran as its base (when the person may use that agent), the project, and the goal text as its instructions,
//     redacted and cut to the limit. Never a secret, a token, the plan or anything of the workspace.
//   - The origin is filled in here and nowhere else: the client sends only a request id and, optionally, a name. The request is repeatable (R18) like every Plan 3 write.
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { INSTRUCTIONS_MAX_BYTES, SessionMakeAgentBodySchema, agentXError, isBuiltinAgentId, redactText, AGENT_NAME_MAX, MAKE_AGENT_NOT_COPIED_REASON, type AgentId, type AgentOrigin, type AgentOwner, type AgentSessionRecord, type RecipeOverlay, type SessionId } from "@rovara-code/contracts";
import { requireAccountable, requireAgentAccess, requireOwnerAllowed, type AgentCaller } from "../agents/access.js";
import type { ApprovalDependencies } from "../agents/approvals.js";
import { requireBaseEnabled } from "../agents/guardrails.js";
import { markRequest, view } from "../agents/routes.js";
import type { AgentRecord } from "../agents/store.js";
import { StatusReply } from "../aws/status-reply.js";
import { taskKey } from "../developer/task-records.js";
import { requireSessionLevel, type SessionAccessDependencies, type SessionCaller } from "./access.js";
import { plainMentions, withoutInvisible } from "./messages.js";
import { pastRetention, withOriginView } from "./origin.js";

const isAgentXError = (error: unknown): boolean => error instanceof Error && error.name === "AgentXError";

/** Who makes the agent: `DeveloperCaller` fits; the org role is read from the member record by the session access, never taken from here. */
type MakeAgentCaller = SessionCaller;

/**
 * Plan 3's right to create an agent that a project owns, as the create route would check it, and the owner and accountable maintainer the agent would have: a maintainer of the project, or an org owner or admin
 * (a maintainer of every project). `undefined` when the person lacks it or the project can't take an agent. A failure that is not a refusal is thrown.
 */
async function createRightIn(agents: ApprovalDependencies, caller: AgentCaller, project: string): Promise<{ owner: AgentOwner; accountable: { developerId: string } } | undefined> {
  try {
    const owner = await requireOwnerAllowed(agents, caller, { kind: "project", project });
    const accountable = await requireAccountable(agents, caller.orgId, project, caller.developerId);
    return { owner, accountable };
  } catch (error) {
    if (isAgentXError(error)) return undefined;
    throw error;
  }
}

/** Whether `caller` may create an agent in `project` now. Read live; any failure to find out is "no", so a flag in a view never shows a right that could not be confirmed. */
export async function mayCreateAgentIn(agents: ApprovalDependencies, caller: AgentCaller, project: string): Promise<boolean> {
  try {
    return await createRightIn(agents, caller, project) !== undefined;
  } catch {
    return false;
  }
}

/** What the answer says about the session's agent: `copied: true` (it is the base, or the session ran none), or `copied: false` with a fixed reason code (the person can't use it, so the draft is built from nothing). */
export type CopiedReport = { copied: true } | { copied: false; reason: typeof MAKE_AGENT_NOT_COPIED_REASON };
const COPIED: CopiedReport = { copied: true };
const NOT_COPIED: CopiedReport = { copied: false, reason: MAKE_AGENT_NOT_COPIED_REASON };

/** Where the report is kept in the request's stored answer (beside the agent record). */
const REPORT_FIELD = "copiedReport";

/** The report stored with a request, or `undefined` when the request was stored without one or the field is not a report this code wrote. */
function storedReport(result: unknown): CopiedReport | undefined {
  const report = (result as { [REPORT_FIELD]?: { copied?: unknown; reason?: unknown } } | null)?.[REPORT_FIELD];
  if (report?.copied === true && report.reason === undefined) return COPIED;
  if (report?.copied === false && report.reason === MAKE_AGENT_NOT_COPIED_REASON) return NOT_COPIED;
  return undefined;
}

/**
 * The session's agent as the new agent's base, when the person may use it now; otherwise the agent is built from nothing (no refusal, and nothing said about the agent they can't see: only the fixed reason
 * code `AGENT_NOT_USABLE`, never its id or name).
 */
async function baseOf(agents: ApprovalDependencies, caller: AgentCaller, session: AgentSessionRecord): Promise<{ base?: AgentId; report: CopiedReport }> {
  const baseId = session.agent?.agentId;
  if (baseId === undefined) return { report: COPIED };
  try {
    await requireAgentAccess(agents, caller, baseId, "use");
    await requireBaseEnabled(agents, caller.orgId, baseId);
    if (!isBuiltinAgentId(baseId)) {
      const base = await agents.store.get(caller.orgId, baseId);
      if (base === undefined || base.status !== "active" || base.currentVersion === undefined) return { report: NOT_COPIED };
    }
    return { base: baseId, report: COPIED };
  } catch (error) {
    if (isAgentXError(error)) return { report: NOT_COPIED };
    throw error;
  }
}

/** The text cut to at most `INSTRUCTIONS_MAX_BYTES` bytes of UTF-8, at a whole character. */
function cutToBytes(text: string): string {
  const encoder = new TextEncoder();
  let bytes = 0;
  let cut = "";
  for (const character of text) {
    bytes += encoder.encode(character).length;
    if (bytes > INSTRUCTIONS_MAX_BYTES) break;
    cut += character;
  }
  return cut;
}

/** The goal as instructions: the task's own request (already redacted when stored), else the session's title; cleaned of invisible characters and mentions, redacted again, and only then cut. */
async function goalOf(deps: Pick<SessionAccessDependencies, "documentClient" | "tableName">, session: AgentSessionRecord): Promise<string> {
  let raw = session.title;
  if (session.subject.kind === "task") {
    const task = ((await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: taskKey(session.subject.taskId), ConsistentRead: true }))) as { Item?: { orgId?: unknown; requestText?: unknown } }).Item;
    if (task !== undefined && task.orgId === session.orgId && typeof task.requestText === "string" && task.requestText.trim() !== "") raw = task.requestText;
  }
  return cutToBytes(plainMentions(redactText(withoutInvisible(raw).replace(/\r\n?/gu, "\n"))).trim());
}

/** What the agent is called when its name is not given and nothing of the title is left after cleaning. */
const FALLBACK_NAME = "Agent from a session";

/** A name that fits: the session's title, cleaned and redacted as the goal text is (invisible characters, mentions, secrets) and only then cut to the limit by characters (never in the middle of one). */
function defaultName(title: string): string {
  const cleaned = plainMentions(redactText(withoutInvisible(title))).trim();
  let name = "";
  for (const character of cleaned) {
    if (name.length + character.length > AGENT_NAME_MAX) break;
    name += character;
  }
  return name.trim() === "" ? FALLBACK_NAME : name;
}

export interface MakeAgentDependencies extends SessionAccessDependencies {
  /** Plan 3's agent store, access and guardrails; without them the route answers NOT_FOUND. */
  approvals?: ApprovalDependencies | undefined;
}

/**
 * `POST /v1/app/sessions/{id}/agent` [view, and the right to create agents in the project]: `201 { agent, draft, copied, reason? }`: `copied` says whether the session's agent became the base, and `reason` (`AGENT_NOT_USABLE`) why not. The agent is the one `POST /v1/app/agents` would make, with the draft's `origin` shown as the
 * caller may read it. A repeat of the same request answers the same agent and writes nothing.
 */
export async function makeAgentFromSession(deps: MakeAgentDependencies, caller: MakeAgentCaller, sessionId: SessionId, body: unknown): Promise<StatusReply> {
  const agents = deps.approvals;
  if (agents === undefined) throw agentXError("NOT_FOUND", "making an agent is not set up in this deployment");
  const parsed = SessionMakeAgentBodySchema.safeParse(body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw agentXError("CONFIG_INVALID", `${issue === undefined || issue.path.length === 0 ? "body" : issue.path.join(".")}: ${issue === undefined || issue.code === "unrecognized_keys" ? "has a field this route does not take" : issue.message}`);
  }
  const input = parsed.data;
  // Nothing is told to a person who can't view the session: it is not found, however the rest of the request looks.
  const access = await requireSessionLevel(deps, caller, sessionId, "view", "make an agent from it");
  const { session } = access;
  // A session past its retention is gone for everyone (as its origin is hidden), though its record may linger: it is not a source for an agent.
  if (pastRetention(deps.now(), session)) throw agentXError("NOT_FOUND", "session not found");
  if (session.subject.kind !== "task" || session.project === undefined) throw agentXError("CONFIG_INVALID", "This session has no project to make an agent in.");
  const agentCaller: AgentCaller = { orgId: caller.orgId, developerId: caller.developerId, orgRole: access.orgRole };
  const { mark, replay } = await markRequest(agents, agentCaller, "create-from-session", session.sessionId, input);
  if (replay !== undefined) {
    // The agent as it is now, if the caller can still see it: a repeat is not a way to read what they no longer have.
    const earlier = replay.result as AgentRecord;
    const { agent } = await requireAgentAccess(agents, agentCaller, earlier.agentId, "view");
    const draft = await agents.store.getDraft(agentCaller.orgId, earlier.agentId);
    // The report the first answer gave, stored with the request: a change of the session's agent or of the draft's base since never changes it. A request stored before the report was kept
    // has none; it is worked out from the draft as it was then.
    const report = storedReport(replay.result) ?? (session.agent === undefined || draft?.extends?.agentId === session.agent.agentId ? COPIED : NOT_COPIED);
    return new StatusReply(201, { agent: await view(agents, agentCaller, agent), ...(draft === undefined ? {} : { draft: await withOriginView(agents, agentCaller, draft) }), ...report });
  }
  const right = await createRightIn(agents, agentCaller, session.project);
  if (right === undefined) throw agentXError("FORBIDDEN", `Only a maintainer of ${session.project} can make an agent in it.`);
  const { base, report } = await baseOf(agents, agentCaller, session);
  const goal = await goalOf(deps, session);
  const overlay: RecipeOverlay = goal === "" ? {} : { instructions: goal };
  const origin: AgentOrigin = { kind: "session", sessionId: session.sessionId, taskId: session.subject.taskId, createdBy: caller.developerId, createdAt: new Date(deps.now()).toISOString() };
  const agent = await agents.store.create({
    orgId: agentCaller.orgId, name: input.name ?? defaultName(session.title), owner: right.owner, accountable: right.accountable, overlay, origin, createdBy: caller.developerId, request: mark,
    answer: { [REPORT_FIELD]: report },
    ...(base === undefined ? {} : { extends: base }),
  });
  const draft = await agents.store.getDraft(agentCaller.orgId, agent.agentId);
  return new StatusReply(201, { agent: await view(agents, agentCaller, agent), ...(draft === undefined ? {} : { draft: await withOriginView(agents, agentCaller, draft) }), ...report });
}
