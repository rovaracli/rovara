// Decision journey slice 3b: outside approvers decide on the card. An agent approval (`apr_`) or a spend request (`spr_`, a run_limit raise that needs someone else among them) is a decision card
// (`approve_request`) for exactly the people the confirmation page (`decide-web.ts`) lets decide it today: each card is listed only when the kind's own live evaluation (`DecideKind.inspect`, which runs
// `mayDecideApproval` / `mayDecideSpendRequest`) says "open" for this person, and every press inspects again before it decides.
//   where    the person's Home "Needs you"; the task page shows it to the people on the task who may decide it; anyone else who may decide it opens the card-only page `/app/decisions/approve_request/<id>`
//            (the card and its evidence: the confirmation page's own facts, nothing else of the task).
//   checks   the confirmation page's own: a signed-in browser, the decide-grade sign-in (an email-code decide session for this approval, `outsideCardHandler`), a writer's live role, the kind's live
//            eligibility, the card's evidence opened for the digest shown (it records the kind's `opened`); the decision is the kind's own `decide` with the decide session's proof.
// DEFERRED-CHECKS (security review 2026-11-06, no change now): listing inspects up to 200 candidates per read of the cards (100 approvals, 100 spend requests) and requests past the first 100 open ones
// are not listed (the confirmation page link still reaches them).
//   NOT changed: who may decide anything. decide-web stays one release as a redirect to the card (old links in Slack and email); its removal is for later.
import { createHash } from "node:crypto";
import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import { agentXError } from "@rovara-code/contracts";
import { openSpendRequestsKey } from "@agentx/cloud-contracts";
import type { DecideKind, DecideKinds, DecideTarget, ConfirmView } from "../../developer/decide-kinds.js";
import { kindPrefixOf } from "../../developer/decide-kinds.js";
import { getAnyApproval, listApprovalsFor, type AnyApprovalRecord, type ApprovalDependencies } from "../../agents/approvals.js";
import type { DecisionItem } from "../../decisions/project.js";
import { perform, type KindHandler } from "../../decisions/performer.js";
import type { PerformInput, PerformOutcome } from "../../decisions/routes.js";
import { DECIDE_SECONDS, decideProofOf, type DecideStore } from "../../developer/decide-session.js";
import { liveWriterRole } from "../../org/live-role.js";
import { getSpendRequest } from "../../spend/requests.js";
import type { DeveloperCaller, DeveloperRouteDependencies } from "./types.js";

const APPROVALS_MAX = 100;
const SPEND_MAX = 100;
const PROBE_AT = "2000-01-01T00:00:00.000Z";
const LINE_MAX = 300;

/** The card-only page of an outside approval: the card and its evidence, nothing else of the task. */
export const outsideCardPath = (approvalId: string): string => `/app/decisions/approve_request/${approvalId}`;
/** What a press says when the person has not signed in recently. */
export const OUTSIDE_REAUTH_MESSAGE = "Sign in again to decide this. Decisions like this need a sign-in within the last 10 minutes.";

const cut = (value: string): string => (value.length > LINE_MAX ? `${value.slice(0, LINE_MAX - 1)}…` : value);
const textOf = (value: unknown): string | undefined => (typeof value === "string" && value.trim() !== "" ? value : undefined);

/** The evidence of the card, from the confirmation page's own view: its facts, its paragraphs and, for a write, the exact call. */
function detailsOf(view: ConfirmView): Array<{ title: string; lines: string[] }> {
  const groups: Array<{ title: string; lines: string[] }> = [{ title: "What is being decided", lines: view.facts.map((fact) => cut(`${fact.label}: ${fact.value}`)) }];
  if ((view.paragraphs ?? []).length > 0) groups.push({ title: "What it says", lines: (view.paragraphs ?? []).map(cut) });
  if (view.call !== undefined) groups.push({ title: "The call it makes", lines: [cut(`${view.call.connector} ${view.call.tool}${view.call.scope === undefined ? "" : ` (${view.call.scope})`}`), cut(JSON.stringify(view.call.arguments))] });
  return groups.filter((group) => group.lines.length > 0);
}

/** The card item of an open approval: the page's own view, the task it belongs to (when it has one) and a version of what is shown. */
function itemOf(approvalId: string, view: ConfirmView, meta: { createdAt: string; expiresAt?: string | undefined; taskId?: string | undefined; project?: string | undefined }): DecisionItem {
  return {
    kind: "approve_request", subjectId: approvalId, prefix: kindPrefixOf(approvalId) ?? "apr", project: meta.project ?? "Company", title: view.title, createdAt: meta.createdAt,
    ...(meta.expiresAt === undefined ? {} : { expiresAt: meta.expiresAt }), ...(meta.taskId === undefined ? {} : { taskId: meta.taskId }),
    openPath: outsideCardPath(approvalId), contentVersion: createHash("sha256").update(JSON.stringify(view)).digest("hex").slice(0, 40), details: detailsOf(view),
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const taskOfApproval = (record: AnyApprovalRecord): string | undefined => (record.kind !== "change" && record.subject.kind === "agent_run" && UUID.test(record.subject.taskId) ? record.subject.taskId : undefined);

/** The outside approvals this person may decide now, as cards. Each candidate is inspected by its kind (live); a candidate that cannot be read is left out. */
export async function outsideItemsFor(deps: DeveloperRouteDependencies, caller: DeveloperCaller, kinds: DecideKinds, focus?: string): Promise<DecisionItem[]> {
  const agents = deps.agents as ApprovalDependencies | undefined;
  if (agents === undefined) return [];
  const found: DecisionItem[] = [];
  const target = (approvalId: string): DecideTarget => ({ orgId: caller.orgId, developerId: caller.developerId, approvalId });
  const now = deps.now();
  if (kinds.apr !== undefined) {
    // The list is read with the route's own reads (`deps.documentClient`): on the navigation that is the per-request read cache (`app-nav/read-cache.ts`), so it is the same read Home's approval
    // cards make, not a second one. The list only reads (a Query and Gets), so the cache never refuses it; inspecting and deciding keep the agents' own client. A list that cannot be read fails
    // the cards (the caller says so: Home logs `home.decisions_unreadable`), never a shorter list that looks complete.
    const open = (await listApprovalsFor({ ...agents, documentClient: deps.documentClient, tableName: deps.tableName }, { orgId: caller.orgId, developerId: caller.developerId, orgRole: caller.orgRole }, "PENDING"))
      .filter((record) => Date.parse(record.expiresAt) > now && !(record.kind === "change" && record.subject.kind === "card_decision")).slice(0, APPROVALS_MAX);
    for (const record of open) {
      try {
        const inspection = await kinds.apr.inspect(target(record.approvalId));
        if (inspection.status !== "open") continue;
        found.push(itemOf(record.approvalId, inspection.view, { createdAt: record.createdAt, expiresAt: record.expiresAt, taskId: taskOfApproval(record), project: textOf((record as unknown as Record<string, unknown>)["project"]) }));
      } catch { /* an approval that cannot be read is not a card */ }
    }
  }
  if (kinds.spr !== undefined) {
    const rows = await deps.documentClient.send(new QueryCommand({
      TableName: deps.tableName, KeyConditionExpression: "pk = :pk", ExpressionAttributeValues: { ":pk": openSpendRequestsKey(caller.orgId, PROBE_AT, "spr_0").pk }, ConsistentRead: true, Limit: SPEND_MAX,
    })).catch(() => ({ Items: [] })) as { Items?: Array<Record<string, unknown>> };
    for (const row of (rows.Items ?? []).slice(0, SPEND_MAX)) {
      const id = textOf(row["spendRequestId"]);
      if (id === undefined || row["orgId"] !== caller.orgId || kindPrefixOf(id) !== "spr") continue;
      try {
        const inspection = await kinds.spr.inspect(target(id));
        if (inspection.status !== "open") continue;
        // The request's own record says which task it belongs to (the open index row does not), so the task page shows the card to the deciders on the task.
        const record = await getSpendRequest(agents, caller.orgId, id) as unknown as Record<string, unknown> | undefined;
        const taskId = textOf(record?.["taskId"]);
        found.push(itemOf(id, inspection.view, { createdAt: textOf(record?.["createdAt"]) ?? textOf(row["createdAt"]) ?? new Date(now).toISOString(), expiresAt: textOf(record?.["expiresAt"]), taskId: taskId !== undefined && UUID.test(taskId) ? taskId : undefined, project: textOf(record?.["project"]) }));
      } catch { /* a request that cannot be read is not a card */ }
    }
  }
  // The approval a link named (the card page, the old confirmation link's redirect, a press on its card): listed for this person when its kind says they may decide it now, even when no list names
  // them (a rule's approver, evaluated when the decision is made, as the confirmation page evaluates it).
  if (focus !== undefined && !found.some((item) => item.subjectId === focus)) {
    const prefix = kindPrefixOf(focus);
    const kind = prefix === undefined ? undefined : kinds[prefix];
    try {
      const inspection = kind === undefined ? undefined : await kind.inspect(target(focus));
      if (inspection?.status === "open") {
        const record = prefix === "spr"
          ? await getSpendRequest(agents, caller.orgId, focus) as unknown as Record<string, unknown> | undefined
          : await getAnyApproval(agents, caller.orgId, focus) as unknown as Record<string, unknown> | undefined;
        const subject = record?.["subject"] as { kind?: unknown; taskId?: unknown } | undefined;
        const taskId = textOf(prefix === "spr" ? record?.["taskId"] : subject?.kind === "agent_run" ? subject.taskId : undefined);
        // A high card's decide-grade sign-in record (`card_decision`) is decided on that card, on its task page: it is never a card of its own.
        if (subject?.kind !== "card_decision") found.push(itemOf(focus, inspection.view, { createdAt: textOf(record?.["createdAt"]) ?? new Date(now).toISOString(), expiresAt: textOf(record?.["expiresAt"]), taskId: taskId !== undefined && UUID.test(taskId) ? taskId : undefined, project: textOf(record?.["project"]) }));
      }
    } catch { /* an approval that cannot be read is not a card */ }
  }
  return found;
}

/** What the card's handler needs of the decide-grade sign-in: the browser's decide session cookie (`__Host-rovara_decide`, SameSite Strict) and the store that holds the sessions. */
export interface DecideGrade { cookie: string | undefined; store: Pick<DecideStore, "getSession" | "claimSession" | "releaseSession" | "deleteSession">; now(): number }

/** Why a press needs the decide-grade sign-in: the code the UI acts on (it starts the decide sign-in for this approval and comes back to the card). */
export const DECIDE_SIGN_IN_REASON = "decide_sign_in";

/**
 * Approve and Decline of an outside approval's card: EXACTLY the confirmation page's checks, then the kind's own decision.
 *   - a signed-in browser (the web boundary's cookie, Origin and CSRF), never a token;
 *   - the decide-grade sign-in: an unused decide session for THIS approval, this member and org, signed in with the email code from a clean sign-in (`prompt=login`) as the member's own pool user
 *     (decide-signin.ts writes it only then), within the last 10 minutes; spent by the decision (given back when the decision was refused), as decide-web spends it. Anything else is REAUTH_REQUIRED with
 *     the reason `decide_sign_in`: the card starts that sign-in and returns to the card;
 *   - a writer's live role (an Auditor decides nothing), and the kind's live evaluation;
 *   - the decision is the kind's own, with the decide session's proof (its real method).
 * DEFERRED-CHECKS (security review 2026-11-06, no change now): Decline carries no digest pin (as decide-web's Decline); decide-web also rate-limits tickets per member and approval, which the identify step
 * here still applies, since the decide session is minted through it.
 */
export function outsideCardHandler(deps: DeveloperRouteDependencies, kinds: DecideKinds, grade: DecideGrade): KindHandler<DeveloperCaller> {
  const decide = (decision: "approve" | "decline") => (who: DeveloperCaller, input: PerformInput): Promise<PerformOutcome> => perform(async () => {
    const approvalId = input.item.subjectId;
    const prefix = kindPrefixOf(approvalId);
    const kind: DecideKind | undefined = prefix === undefined ? undefined : kinds[prefix];
    if (kind === undefined || input.item.kind !== "approve_request") return { kind: "refused", reason: "unsupported" };
    if (who.browserSession !== true) throw agentXError("FORBIDDEN", "Decide this in the Rovara app.");
    const cookie = grade.cookie;
    const session = cookie === undefined || cookie.length < 32 || cookie.length > 128 ? undefined : await grade.store.getSession(cookie);
    const nowSeconds = Math.floor(grade.now() / 1000);
    if (cookie === undefined || session === undefined || session.orgId !== who.orgId || session.developerId !== who.developerId || session.approvalId !== approvalId || session.method !== "email_code"
      || session.usedAt !== undefined || session.expiresAt <= nowSeconds || nowSeconds - session.signedInAt > DECIDE_SECONDS) {
      throw Object.assign(agentXError("REAUTH_REQUIRED", OUTSIDE_REAUTH_MESSAGE), { reason: DECIDE_SIGN_IN_REASON });
    }
    await liveWriterRole({ documentClient: deps.documentClient, tableName: deps.tableName, signInTableName: deps.developer.signInTableName }, who.orgId, who.developerId);
    // Eligibility again, now (R68), never trusted from the list.
    const target: DecideTarget = { orgId: who.orgId, developerId: who.developerId, approvalId };
    const inspection = await kind.inspect(target);
    if (inspection.status === "forbidden") return { kind: "refused", reason: "forbidden" };
    if (inspection.status !== "open") return { kind: "refused", reason: "stale" };
    // One decision per decide session, as on the confirmation page: claimed now, spent by a decision, given back when the decision was refused.
    if (!await grade.store.claimSession(cookie, approvalId)) throw Object.assign(agentXError("REAUTH_REQUIRED", OUTSIDE_REAUTH_MESSAGE), { reason: DECIDE_SIGN_IN_REASON });
    let decided = false;
    try {
      await kind.decide(target, decision, decideProofOf(cookie, session));
      decided = true;
    } finally {
      await (decided ? grade.store.deleteSession(cookie) : grade.store.releaseSession(cookie)).catch(() => undefined);
    }
    return { kind: "done" };
  });
  return { approve: decide("approve"), reject: decide("decline") };
}

/** Called when the person opened the card's evidence (the card route records it for the digest shown): what a kind that needs its page to have been read records (`opened`, known_failing). Only for an approval this person may still decide. */
export async function outsideEvidenceOpened(kinds: DecideKinds, who: DeveloperCaller, approvalId: string): Promise<void> {
  const prefix = kindPrefixOf(approvalId);
  const kind = prefix === undefined ? undefined : kinds[prefix];
  if (kind?.opened === undefined) return;
  const target: DecideTarget = { orgId: who.orgId, developerId: who.developerId, approvalId };
  if ((await kind.inspect(target)).status === "open") await kind.opened(target);
}
