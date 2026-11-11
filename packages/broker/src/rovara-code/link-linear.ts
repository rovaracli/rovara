// Rovara Code (Plan 6 Task 20, owner decision 2026-10-26): linking a session to a Linear issue by hand, until Plan 9's Linear intake binds sessions itself.
//   POST   /v1/app/sessions/{id}/bindings        { linear: "<KEY or a linear.app issue link>", replace?: true }
//   DELETE /v1/app/sessions/{id}/bindings/linear
// Authority: a live "can edit" on the session in the caller's own org (the owner has it), read on every request; a session of another org, or one the caller cannot see, is `NOT_FOUND`. The key is
// checked to be an issue key. A session follows one Linear issue and an issue follows one session in the org (`bindSessionSurface` refuses the second); changing the issue is explicit (`replace`).
// The binding, its timeline line and its audit record are one transaction. A binding is a routing hint only: it names no person and gives nobody a level on the session.
import { agentXError, sessionEventId, type OrgId, type SessionBinding, type SessionId } from "@rovara-code/contracts";
import { type SessionView } from "@agentx/cloud-contracts";
import { z } from "zod";
import type { TransactItem } from "../agents/table-writes.js";
import { bindSessionSurface, replaceSessionSurface, unbindSessionSurface } from "../agent-sessions/bindings.js";
import { requireSessionLevel } from "../agent-sessions/access.js";
import { sessionEventItem } from "../agent-sessions/store.js";
import type { DeveloperTaskRecord } from "../developer/task-records.js";
import { answerOf, isEnded, isoOf, nameOrSomeone, taskOfSession, type ControlCaller } from "../agent-sessions/stop.js";
import type { SessionReadDependencies } from "../agent-sessions/read.js";
import { flushAuditEvents } from "../audit/flush.js";
import { auditSessionLinked, auditSessionUnlinked, auditOccurrence } from "../audit/events.js";
import { auditPending, tryAuditEvents } from "../audit/outbox.js";
import { auditActorOf } from "../audit/plan3-hooks.js";
import { linearIssueKeyOf, linearWorkspaceOfLink, parseLinearIssue } from "./linear-close.js";
import { sessionBindingsOf } from "./session-bindings.js";

const BodySchema = z.object({ linear: z.string().max(2048), replace: z.literal(true).optional() }).strict();

export const LINK_NOT_A_TASK = "Only a Rovara Code task can be linked to a Linear issue.";
export const ISSUE_TAKEN = "This issue already follows another session.";
const BAD_ISSUE = "linear: give the issue's key (like TEAM-123) or its Linear link";

function parseBody(body: unknown): { issue: { issueId: string; url: string; workspace?: string }; replace: boolean } {
  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    // Field names only: never the value.
    const issue = parsed.error.issues[0];
    if (issue === undefined || issue.code === "unrecognized_keys") throw agentXError("CONFIG_INVALID", "body: has a field this route does not take");
    throw agentXError("CONFIG_INVALID", issue.path[0] === "linear" ? BAD_ISSUE : "replace: is true or left out");
  }
  const issue = parseLinearIssue(parsed.data.linear);
  if (issue === undefined) throw agentXError("CONFIG_INVALID", BAD_ISSUE);
  // A typed link into a workspace names it on the binding (M8): an issue key such as ENG-142 exists in every Linear workspace. A bare key names none, and the workspace is then read from the org's Linear connection.
  const workspace = linearWorkspaceOfLink(parsed.data.linear.trim());
  return { issue: { ...issue, ...(workspace === undefined ? {} : { workspace }) }, replace: parsed.data.replace === true };
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

/** What happened to the open pull request's description, for the person who linked or unlinked (`GET`-free: it is part of the answer). */
export interface PullRequestDescriptionResult {
  /** `updated`: the open description was rewritten now. `next_update`: no pull request is open yet, so the first description (or the next rewrite) carries the line. `failed`: it could not be rewritten; `note` says what to do. `not_for_version`: an older Rovara Code task never writes the line. `none`: nothing to say. */
  description: "updated" | "next_update" | "failed" | "not_for_version" | "none";
  note?: string;
}

const OPEN_STATES = new Set(["OPEN", "UNKNOWN"]);

/**
 * Brings the open pull request's description in line with the binding at once (never throws; the binding is already committed). `key` is the issue the session follows now, or undefined when it follows
 * none; `stale` is the issue it followed before, whose line may still stand if the rewrite fails.
 */
async function descriptionAfter(deps: SessionReadDependencies, task: DeveloperTaskRecord | undefined, key: string | undefined, stale: string | undefined): Promise<PullRequestDescriptionResult> {
  const workflow = task?.workflow;
  if (task === undefined || workflow === undefined) return key === undefined ? { description: "none" } : { description: "not_for_version", note: `This is an older Rovara Code task, so its pull request description won't say Fixes ${key}; write it there yourself if you want Linear to close the issue.` };
  if (workflow.definitionVersion !== "1.1.0") {
    return key === undefined ? { description: "none" } : { description: "not_for_version", note: `This is an older Rovara Code task, so its pull request description won't say Fixes ${key}; write it there yourself if you want Linear to close the issue.` };
  }
  const open = (workflow.pullRequests ?? []).filter((pullRequest) => OPEN_STATES.has(pullRequest.state));
  if (open.length === 0) return key === undefined ? { description: "none" } : { description: "next_update" };
  const failed = (): PullRequestDescriptionResult => ({
    description: "failed",
    note: `Rovara couldn't update the open pull request's description${stale !== undefined ? `, which may still say Fixes ${stale}` : key !== undefined ? `, which may not say Fixes ${key}` : ""}: edit it on GitHub.`,
  });
  try {
    const outcome = await deps.control?.rewritePullRequestLinearLine?.(task, key);
    return outcome === undefined || outcome.failed > 0 ? failed() : { description: "updated" };
  } catch (error) {
    (deps.log ?? ((entry: Record<string, unknown>) => console.log(JSON.stringify({ component: "broker", ...entry }))))({ event: "linear_close.description_not_updated", taskId: task.taskId, error: error instanceof Error ? error.name : "unknown" });
    return failed();
  }
}

/**
 * `POST /v1/app/sessions/{id}/bindings`. Needs "can edit". Links the session to the issue; the same issue again changes nothing; another issue is refused unless `replace` is sent, which changes
 * the issue in one transaction (the old issue's timeline line and audit record with the new issue's). An issue that follows another session in the org is refused and nothing changes. The open pull
 * request's description is brought in line at once. Answers the session and what happened to the description.
 */
export async function linkLinearOnSession(deps: SessionReadDependencies, caller: ControlCaller, sessionId: string, body: unknown): Promise<{ session: SessionView; pullRequest: PullRequestDescriptionResult }> {
  const input = parseBody(body);
  const access = await requireSessionLevel(deps, caller, sessionId, "edit", "link it to a Linear issue");
  const { session } = access;
  if (session.subject.kind !== "task") throw agentXError("CONFIG_INVALID", LINK_NOT_A_TASK);
  if (isEnded(session)) throw agentXError("SESSION_ENDED", "This session has ended.");
  const binding: SessionBinding = { kind: "linear_issue", issueId: input.issue.issueId, url: input.issue.url, ...(input.issue.workspace === undefined ? {} : { workspace: input.issue.workspace }) };
  const current = await linearOf(deps, session.orgId, session.sessionId);
  const currentKey = current === undefined ? undefined : linearIssueKeyOf(current);
  const task = await taskOfSession(deps, session);
  if (current !== undefined && currentKey === input.issue.issueId) return { ...await answerOf(deps, caller, session.sessionId), pullRequest: { description: "none" } };
  if (current !== undefined && !input.replace) {
    throw agentXError("CONFIG_INVALID", `This session already follows ${currentKey === undefined ? "another Linear issue" : `Linear issue ${currentKey}`}. Unlink it first, or ask to replace it.`);
  }
  const table = { documentClient: deps.documentClient, tableName: deps.tableName, now: deps.now };
  const ref = { orgId: session.orgId, sessionId: session.sessionId, subject: session.subject };
  const kept = { events: [] as Awaited<ReturnType<typeof tryAuditEvents>> };
  const key = input.issue.issueId;
  let stale: string | undefined;
  if (current !== undefined) {
    // One transaction: the old issue is let go and the new one bound together, or nothing changes.
    const replaced = await replaceSessionSurface(table, {
      orgId: session.orgId, sessionId: session.sessionId, binding,
      extraItems: async (previous) => {
        const at = isoOf(deps.now());
        const oldKey = linearIssueKeyOf(previous) ?? "the issue";
        const gone = await lineItems(deps, caller, ref, { kind: "unlinked", key: oldKey, at }, kept);
        const goneEvents = kept.events;
        const added = await lineItems(deps, caller, ref, { kind: "linked", key, at }, kept);
        kept.events = [...goneEvents, ...kept.events];
        return [...gone, ...added];
      },
    });
    if (replaced.result === "not_bound") throw agentXError("CONFIG_INVALID", "This session's link changed just now. Check it and try again.");
    stale = linearIssueKeyOf(replaced.previous);
    await flushAuditEvents(deps, kept.events);
  } else {
    const extraItems = await lineItems(deps, caller, ref, { kind: "linked", key, at: isoOf(deps.now()) }, kept);
    // A refusal here is the library's own: "This issue already follows another session." or "This session already follows another issue."
    const outcome = await bindSessionSurface(table, { orgId: session.orgId, sessionId: session.sessionId, binding, extraItems });
    if (outcome === "bound") await flushAuditEvents(deps, kept.events);
  }
  const pullRequest = await descriptionAfter(deps, task, key, stale);
  return { ...await answerOf(deps, caller, session.sessionId), pullRequest };
}

/**
 * `DELETE /v1/app/sessions/{id}/bindings/linear`. Needs "can edit". Lets go of the session's Linear issue (and frees the issue for another session) with its timeline line and audit record; a session that
 * follows none changes nothing. Works on a session that has ended. Its Slack thread is not touched. The open pull request's description loses its Fixes line at once. Answers the session and what happened
 * to the description.
 */
export async function unlinkLinearOnSession(deps: SessionReadDependencies, caller: ControlCaller, sessionId: string): Promise<{ session: SessionView; pullRequest: PullRequestDescriptionResult }> {
  const access = await requireSessionLevel(deps, caller, sessionId, "edit", "unlink its Linear issue");
  const { session } = access;
  const table = { documentClient: deps.documentClient, tableName: deps.tableName, now: deps.now };
  const ref = { orgId: session.orgId, sessionId: session.sessionId, subject: session.subject };
  const kept = { events: [] as Awaited<ReturnType<typeof tryAuditEvents>> };
  const outcome = await unbindSessionSurface(table, {
    orgId: session.orgId, sessionId: session.sessionId, kind: "linear_issue",
    extraItems: (binding) => lineItems(deps, caller, ref, { kind: "unlinked", key: linearIssueKeyOf(binding) ?? "the issue", at: isoOf(deps.now()) }, kept),
  });
  if (outcome.result !== "unbound") return { ...await answerOf(deps, caller, session.sessionId), pullRequest: { description: "none" } };
  await flushAuditEvents(deps, kept.events);
  const task = session.subject.kind === "task" ? await taskOfSession(deps, session) : undefined;
  const pullRequest = await descriptionAfter(deps, task, undefined, linearIssueKeyOf(outcome.binding));
  return { ...await answerOf(deps, caller, session.sessionId), pullRequest };
}
