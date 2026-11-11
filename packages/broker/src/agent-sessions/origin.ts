// An agent remembers the task it was made from (Plan 5 Task 10c): how a stored origin is shown to a person. The draft and each version hold `{ kind: "session", sessionId, taskId?, createdBy, createdAt }`; what a reader
// gets is worked out for them on every read:
//   - a person who may read the session now (`view` or more, live) gets the origin with the session's title and link;
//   - everyone else gets `{ kind: "session", visible: false }`: no id, no title, no person, no time;
//   - the same when the session is deleted, when it is past its retention (its record may outlive it by the table's TTL lag), when it is another org's, when it can't be read right now (fail closed), and when the
//     stored origin does not parse.
// The session is read through `resolveSessionAccess`, so the access rules are exactly the session's own (shares, the task's people, project roles, org admins).
import { AgentOriginSchema, SESSION_RETENTION_DAYS, hideEmailAddresses, sessionLink, type AgentOrigin, type AgentOriginView, type OrgId } from "@rovara-code/contracts";
import { resolveSessionAccess, type SessionAccessDependencies } from "./access.js";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface OriginDependencies extends Pick<SessionAccessDependencies, "documentClient" | "tableName" | "now" | "projectMembers"> {
  /** The cell's origin, where `/s/<sessionId>` is served. */
  confirmOrigin: string;
  /** Where a failure is reported: the error's name and the ids, never text. */
  log?: ((event: string, fields: Record<string, unknown>) => void) | undefined;
}

/** Whether a session is past its retention: it ended more than `SESSION_RETENTION_DAYS` days ago, though its record may outlive that by the table's TTL lag. One rule for showing an origin and for making an agent from a session. */
export const pastRetention = (nowMs: number, session: { endedAt?: string | undefined }): boolean =>
  session.endedAt !== undefined && nowMs > Date.parse(session.endedAt) + SESSION_RETENTION_DAYS * DAY_MS;

export const HIDDEN_ORIGIN: AgentOriginView = { kind: "session", visible: false };

/** What of a session a reader may be shown (its title and link), or undefined when they may not read it. */
type Shown = { title: string; link: string } | undefined;

/** One request's answers by session, so a list of versions made from one session reads that session once. */
export type OriginMemo = Map<string, Promise<Shown>>;
export const newOriginMemo = (): OriginMemo => new Map();

async function shownOf(deps: OriginDependencies, caller: { orgId: OrgId; developerId: string }, sessionId: string): Promise<Shown> {
  try {
    const { session } = await resolveSessionAccess(deps, caller, sessionId);
    if (pastRetention(deps.now(), session)) return undefined;
    return { title: hideEmailAddresses(session.title), link: sessionLink(deps.confirmOrigin, session.sessionId) };
  } catch (error) {
    // A session the person can't read, or that is gone, is NOT_FOUND: hidden, and nothing to report. Anything else is reported by name and hidden too.
    if (!(error instanceof Error && error.name === "AgentXError" && (error as { code?: string }).code === "NOT_FOUND")) {
      deps.log?.("agent.origin_unreadable", { orgId: caller.orgId, sessionId, error: error instanceof Error ? error.name : "unknown" });
    }
    return undefined;
  }
}

/** The origin as `caller` reads it, or undefined for a draft or version that has none. A stored origin that does not parse is hidden, never shown. */
export async function originView(deps: OriginDependencies, caller: { orgId: OrgId; developerId: string }, stored: unknown, memo: OriginMemo = newOriginMemo()): Promise<AgentOriginView | undefined> {
  if (stored === undefined) return undefined;
  const parsed = AgentOriginSchema.safeParse(stored);
  if (!parsed.success) return HIDDEN_ORIGIN;
  const origin: AgentOrigin = parsed.data;
  let pending = memo.get(origin.sessionId);
  if (pending === undefined) {
    pending = shownOf(deps, caller, origin.sessionId);
    memo.set(origin.sessionId, pending);
  }
  const shown = await pending;
  if (shown === undefined) return HIDDEN_ORIGIN;
  return { kind: "session", visible: true, sessionId: origin.sessionId, ...(origin.taskId === undefined ? {} : { taskId: origin.taskId }), title: shown.title, link: shown.link, createdBy: origin.createdBy, createdAt: origin.createdAt };
}

/** A draft or version with its stored origin replaced by what `caller` may read of it (left out when there is none). */
export async function withOriginView<T extends { origin?: unknown }>(deps: OriginDependencies, caller: { orgId: OrgId; developerId: string }, record: T, memo?: OriginMemo): Promise<Omit<T, "origin"> & { origin?: AgentOriginView }> {
  const { origin, ...rest } = record;
  const shown = await originView(deps, caller, origin, memo);
  return shown === undefined ? rest : { ...rest, origin: shown };
}
