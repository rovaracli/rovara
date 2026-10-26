// Rovara Code (Plan 6 Task 20, owner decision 2026-10-26): linking a session to a Linear issue by hand, until Plan 9's Linear intake binds sessions itself.
//   POST   /v1/app/sessions/{id}/bindings        { linear: "<KEY or a linear.app issue link>", replace?: true }
//   DELETE /v1/app/sessions/{id}/bindings/linear
// Authority: a live "can edit" on the session in the caller's own org (the owner has it), read on every request; a session of another org, or one the caller cannot see, is `NOT_FOUND`. The key is
// checked to be an issue key. A session follows one Linear issue and an issue follows one session in the org (`bindSessionSurface` refuses the second); changing the issue is explicit (`replace`).
// The binding, its timeline line and its audit record are one transaction. A binding is a routing hint only: it names no person and gives nobody a level on the session.
import { agentXError, sessionEventId, sessionSurfaceKey, type OrgId, type SessionBinding, type SessionId, type SessionView } from "@agentx/contracts";
import { z } from "zod";
import type { TransactItem } from "../agents/table-writes.js";
import { bindSessionSurface, unbindSessionSurface } from "../agent-sessions/bindings.js";
import { requireSessionLevel } from "../agent-sessions/access.js";
import { sessionEventItem } from "../agent-sessions/store.js";
import { answerOf, getItem, isEnded, isoOf, nameOrSomeone, type ControlCaller } from "../agent-sessions/stop.js";
import type { SessionReadDependencies } from "../agent-sessions/read.js";
import { flushAuditEvents } from "../audit/flush.js";
import { auditSessionLinked, auditSessionUnlinked, auditOccurrence } from "../audit/events.js";
import { auditPending, tryAuditEvents } from "../audit/outbox.js";
import { auditActorOf } from "../audit/plan3-hooks.js";
import { linearIssueKeyOf, parseLinearIssue } from "./linear-close.js";
import { sessionBindingsOf } from "./session-bindings.js";

const BodySchema = z.object({ linear: z.string().max(2048), replace: z.literal(true).optional() }).strict();

export const LINK_NOT_A_TASK = "Only a Rovara Code task can be linked to a Linear issue.";
export const ISSUE_TAKEN = "This issue already follows another session.";
const BAD_ISSUE = "linear: give the issue's key (like TEAM-123) or its Linear link";

function parseBody(body: unknown): { issue: { issueId: string; url: string }; replace: boolean } {
  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    // Field names only: never the value.
    const issue = parsed.error.issues[0];
    if (issue === undefined || issue.code === "unrecognized_keys") throw agentXError("CONFIG_INVALID", "body: has a field this route does not take");
    throw agentXError("CONFIG_INVALID", issue.path[0] === "linear" ? BAD_ISSUE : "replace: is true or left out");
  }
  const issue = parseLinearIssue(parsed.data.linear);
  if (issue === undefined) throw agentXError("CONFIG_INVALID", BAD_ISSUE);
  return { issue, replace: parsed.data.replace === true };
}

/** The timeline line and the audit record of a link or an unlink, for the transaction that makes it. The audit events are kept for flushing after the commit. */
async function lineItems(
  deps: SessionReadDependencies, caller: ControlCaller, session: { orgId: OrgId; sessionId: SessionId; subject: { kind: string; taskId?: string } }, change: { kind: "linked" | "unlinked"; key: string; at: string }, kept: { events: Awaited<ReturnType<typeof tryAuditEvents>> },
): Promise<TransactItem[]> {
  const name = nameOrSomeone(caller.name);
  const occurrence = auditOccurrence(session.sessionId, change.key, change.at);
  const build = change.kind === "linked" ? auditSessionLinked : auditSessionUnlinked;
  const events = await tryAuditEvents(deps, () => [build({
    orgId: session.orgId, actor: auditActorOf(caller.developerId), occurredAt: change.at, occurrence, ...(session.subject.taskId === undefined ? {} : { related: [session.subject.taskId] }), sessionId: session.sessionId, issueKey: change.key,
  })]);
  kept.events = events;
  return [
    sessionEventItem(deps, { orgId: session.orgId, sessionId: session.sessionId }, {
      eventId: sessionEventId(`linear_${change.kind}`, `${session.sessionId}\n${change.key}\n${change.at}`), at: change.at, type: "status", actor: { kind: "member", developerId: caller.developerId, name },
      text: change.kind === "linked" ? `${name} linked this session to Linear issue ${change.key}.` : `${name} unlinked Linear issue ${change.key} from this session.`,
    }),
    ...events.flatMap((event) => auditPending(deps, event)),
  ];
}

const linearOf = async (deps: SessionReadDependencies, orgId: OrgId, sessionId: string): Promise<SessionBinding | undefined> =>
  (await sessionBindingsOf(deps, orgId, sessionId)).find((binding) => binding.kind === "linear_issue");

/**
 * `POST /v1/app/sessions/{id}/bindings`. Needs "can edit". Links the session to the issue; the same issue again changes nothing; another issue is refused unless `replace` is sent, which lets the
 * old one go first (its own timeline line and audit record). An issue that follows another session in the org is refused before anything is changed. Answers the session.
 */
export async function linkLinearOnSession(deps: SessionReadDependencies, caller: ControlCaller, sessionId: string, body: unknown): Promise<{ session: SessionView }> {
  const input = parseBody(body);
  const access = await requireSessionLevel(deps, caller, sessionId, "edit", "link it to a Linear issue");
  const { session } = access;
  if (session.subject.kind !== "task") throw agentXError("CONFIG_INVALID", LINK_NOT_A_TASK);
  if (isEnded(session)) throw agentXError("SESSION_ENDED", "This session has ended.");
  const binding: SessionBinding = { kind: "linear_issue", issueId: input.issue.issueId, url: input.issue.url };
  const current = await linearOf(deps, session.orgId, session.sessionId);
  const currentKey = current === undefined ? undefined : linearIssueKeyOf(current);
  if (current !== undefined && currentKey === input.issue.issueId) return answerOf(deps, caller, session.sessionId);
  if (current !== undefined && !input.replace) {
    throw agentXError("CONFIG_INVALID", `This session already follows ${currentKey === undefined ? "another Linear issue" : `Linear issue ${currentKey}`}. Unlink it first, or ask to replace it.`);
  }
  const table = { documentClient: deps.documentClient, tableName: deps.tableName, now: deps.now };
  const task = { orgId: session.orgId, sessionId: session.sessionId, subject: session.subject };
  const letGo = { events: [] as Awaited<ReturnType<typeof tryAuditEvents>> };
  const kept = { events: [] as Awaited<ReturnType<typeof tryAuditEvents>> };
  if (current !== undefined) {
    // The new issue must be free before the old one is let go, so a refusal leaves the session as it was.
    const owner = await getItem(deps, sessionSurfaceKey(session.orgId, binding));
    if (owner !== undefined && owner["orgId"] === session.orgId && owner["sessionId"] !== session.sessionId) throw agentXError("CONFIG_INVALID", ISSUE_TAKEN);
    const oldKey = currentKey ?? "the issue";
    await unbindSessionSurface(table, { orgId: session.orgId, sessionId: session.sessionId, kind: "linear_issue", extraItems: () => lineItems(deps, caller, task, { kind: "unlinked", key: oldKey, at: isoOf(deps.now()) }, letGo) });
    // The old issue is let go for good, so its audit record is sent now, whatever happens to the new link.
    await flushAuditEvents(deps, letGo.events);
  }
  const at = isoOf(deps.now());
  const extraItems = await lineItems(deps, caller, task, { kind: "linked", key: input.issue.issueId, at }, kept);
  // A refusal here is the library's own: "This issue already follows another session." or "This session already follows another issue."
  const outcome = await bindSessionSurface(table, { orgId: session.orgId, sessionId: session.sessionId, binding, extraItems });
  if (outcome === "bound") await flushAuditEvents(deps, kept.events);
  return answerOf(deps, caller, session.sessionId);
}

/**
 * `DELETE /v1/app/sessions/{id}/bindings/linear`. Needs "can edit". Lets go of the session's Linear issue (and frees the issue for another session) with its timeline line and audit record; a session that
 * follows none changes nothing. Works on a session that has ended. Its Slack thread is not touched. Answers the session.
 */
export async function unlinkLinearOnSession(deps: SessionReadDependencies, caller: ControlCaller, sessionId: string): Promise<{ session: SessionView }> {
  const access = await requireSessionLevel(deps, caller, sessionId, "edit", "unlink its Linear issue");
  const { session } = access;
  const table = { documentClient: deps.documentClient, tableName: deps.tableName, now: deps.now };
  const task = { orgId: session.orgId, sessionId: session.sessionId, subject: session.subject };
  const kept = { events: [] as Awaited<ReturnType<typeof tryAuditEvents>> };
  const outcome = await unbindSessionSurface(table, {
    orgId: session.orgId, sessionId: session.sessionId, kind: "linear_issue",
    extraItems: (binding) => lineItems(deps, caller, task, { kind: "unlinked", key: linearIssueKeyOf(binding) ?? "the issue", at: isoOf(deps.now()) }, kept),
  });
  if (outcome.result === "unbound") await flushAuditEvents(deps, kept.events);
  return answerOf(deps, caller, session.sessionId);
}
