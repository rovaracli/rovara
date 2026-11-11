// Security review follow-up (2026-11-06): the decide-grade sign-in for a HIGH card that has no approval of its own: a high design (the task page's inline approve) and a high requirements or coding
// plan card. This replaces the web session's freshness for these kinds (a recent sign-in of any method, GitHub included): they now need exactly what an outside approval's card needs.
//   the vehicle  a `card_decision` pending change (approvals-store.ts), made when the person presses Approve without a decide session, for the person and the card version shown. The decide sign-in
//                (`/v1/auth/decide/identify` -> start -> email code from a clean sign-in, prompt=login, as the member's own pool user -> callback) is minted for it, and its return
//                (`/v1/app/approve/<apr_>`) sends the browser back to the card on its task page (`returnPath`, decide-web.ts).
//   the press    with that decide session (this person, org and record, email code, unused, within DECIDE_SECONDS) the card's own handler applies the decision, every check of its own included; then the
//                record is approved by the approval decide kind with the session's proof (`decideProofOf`, the real method), which its audit event carries. The session is spent by an applied
//                decision and given back when the decision was refused.
//   not changed  who may decide anything: the card's handler decides that, as before. The record's own rule only lets the person who pressed decide it.
import { createHash } from "node:crypto";
import { agentXError, decisionFocusPath, decisionTaskSessionOf } from "@rovara-code/contracts";
import { type AuditProof } from "@agentx/cloud-contracts";
import { approvalDecideKind } from "../../agents/approval-decide-kind.js";
import { createPendingChange, getAnyApproval, registerApprovalSubjectHandler, registerApproverRule, type ApprovalDependencies } from "../../agents/approvals.js";
import { DECIDE_SECONDS, DecideStore, decideProofOf } from "../../developer/decide-session.js";
import { DECIDE_SIGN_IN_REASON } from "./outside-cards.js";
import type { DeveloperCaller, DeveloperRouteDependencies } from "./types.js";

export const CARD_DECISION_RULE = "card_decision";
export const CARD_DECIDE_REAUTH_MESSAGE = "Sign in again to decide this. A high-risk decision needs a sign-in with the email code within the last 10 minutes.";
const RECORD_MINUTES = 30;
const RECORD_ATTEMPTS = 20;
/** Records are named per quarter hour: a record made in a window lives 30 minutes, so it still has 15 when the window ends. */
const RECORD_WINDOW_MS = 15 * 60_000;
/** A reused record keeps at least this long, so the decide sign-in (10 minutes) can finish inside it. */
const RECORD_MIN_LEFT_MS = (DECIDE_SECONDS + 60) * 1000;

/** The request id of a card's record: the same person, card and version (and attempt) always name the same record. */
function requestIdOf(developerId: string, card: CardDecideTarget, attempt: string): string {
  const hex = createHash("sha256").update(`rovara-card-decision|${developerId}|${card.cardId}|${card.contentVersion}|${attempt}`).digest("hex").slice(0, 32).split("");
  hex[12] = "4";
  hex[16] = "89ab"[Number.parseInt(hex[16]!, 16) % 4]!;
  const joined = hex.join("");
  return `${joined.slice(0, 8)}-${joined.slice(8, 12)}-${joined.slice(12, 16)}-${joined.slice(16, 20)}-${joined.slice(20)}`;
}

/** The card being decided: its id and the version of it that was shown, the task, and its page (where the decide sign-in comes back to). */
export interface CardDecideTarget { cardId: string; taskId: string; contentVersion: string; openPath: string }

/** REAUTH_REQUIRED with the reason `decide_sign_in` and, when one was made, the decide sign-in that comes back to this card. */
export function decideSignInRequired(signInUrl?: string): Error {
  return Object.assign(agentXError("REAUTH_REQUIRED", CARD_DECIDE_REAUTH_MESSAGE), { reason: DECIDE_SIGN_IN_REASON, ...(signInUrl === undefined ? {} : { signInUrl }) });
}

/** Registers the record's rule (the person who pressed, in their org) and its handler (approving it changes nothing). Safe to call more than once. */
export function registerCardDecisionApprovals(): void {
  registerApproverRule(CARD_DECISION_RULE, async (_deps, record, caller) => record.kind === "change" && record.subject.kind === "card_decision" && caller.orgId === record.orgId && caller.developerId === record.requestedBy);
  registerApprovalSubjectHandler(CARD_DECISION_RULE, async (_deps, record) => {
    if (record.kind !== "change" || record.subject.kind !== "card_decision") return;
    if (record.decidedBy === undefined) throw agentXError("CONFIG_INVALID", "this decision was not confirmed by anyone");
  });
}
registerCardDecisionApprovals();

const agentsOf = (deps: DeveloperRouteDependencies): ApprovalDependencies => {
  const agents = deps.agents as ApprovalDependencies | undefined;
  if (agents === undefined) throw agentXError("FORBIDDEN", "Decide this in the Rovara app.");
  return agents;
};

/**
 * Runs `apply` (the card's own decision) only under the decide-grade sign-in for this card. Without it: a `card_decision` record for this person and card version, and REAUTH_REQUIRED with the reason
 * `decide_sign_in` and the sign-in for that record. `apply` says whether the decision was applied (a refusal gives the session back). Never for a token.
 */
export async function withCardDecideGrade<T>(deps: DeveloperRouteDependencies, who: DeveloperCaller, cookie: string | undefined, card: CardDecideTarget, apply: (proof: AuditProof) => Promise<{ applied: boolean; result: T }>): Promise<T> {
  if (who.browserSession !== true) throw agentXError("FORBIDDEN", "Decide this in the Rovara app.");
  const agents = agentsOf(deps);
  const store = new DecideStore({ documentClient: deps.documentClient, tableName: deps.developer.signInTableName, now: () => deps.now() });
  const nowSeconds = Math.floor(deps.now() / 1000);
  const session = cookie === undefined || cookie.length < 32 || cookie.length > 128 ? undefined : await store.getSession(cookie);
  const fresh = session !== undefined && session.orgId === who.orgId && session.developerId === who.developerId && session.method === "email_code" && session.usedAt === undefined
    && session.expiresAt > nowSeconds && nowSeconds - session.signedInAt <= DECIDE_SECONDS;
  const record = fresh && /^apr_[0-9a-z]{20}$/u.test(session.approvalId) ? await getAnyApproval(agents, who.orgId, session.approvalId) : undefined;
  const bound = record?.kind === "change" && record.status === "PENDING" && Date.parse(record.expiresAt) > deps.now() && record.requestedBy === who.developerId && record.subject.kind === "card_decision"
    && record.subject.cardId === card.cardId && record.subject.contentVersion === card.contentVersion && record.subject.taskId === card.taskId;
  if (!fresh || !bound || cookie === undefined) {
    const returnPath = decisionFocusPath(card.openPath, card.cardId);
    if (decisionTaskSessionOf(returnPath) === undefined) throw decideSignInRequired();
    // Repeated presses of the same card version reuse its open record (the request id is derived from the person, the card, the version and the quarter hour); a record that ended makes the next one.
    let made: Awaited<ReturnType<typeof createPendingChange>> | undefined;
    for (let attempt = 0; attempt < RECORD_ATTEMPTS && made === undefined; attempt += 1) {
      const record = await createPendingChange(agents, {
        orgId: who.orgId, requestId: requestIdOf(who.developerId, card, `${String(Math.floor(deps.now() / RECORD_WINDOW_MS))}:${String(attempt)}`), requestedBy: who.developerId,
        subject: { kind: "card_decision", taskId: card.taskId, cardId: card.cardId, contentVersion: card.contentVersion, returnPath },
        changes: ["Confirm the high-risk decision you pressed on its card, with a sign-in by email code. You decide it on its card, back on the task page."],
        approvers: { kind: "rule", rule: CARD_DECISION_RULE, candidates: [] }, expiresAt: new Date(deps.now() + RECORD_MINUTES * 60_000).toISOString(),
      });
      if (record.status === "PENDING" && Date.parse(record.expiresAt) - deps.now() > RECORD_MIN_LEFT_MS) made = record;
    }
    if (made === undefined) throw agentXError("TOO_MANY_REQUESTS", "Too many attempts at this decision. Reload the page and try again later.");
    throw decideSignInRequired(`/v1/auth/decide/identify?return=${encodeURIComponent(`/v1/app/approve/${made.approvalId}`)}`);
  }
  // One decision per decide session: claimed now, spent by an applied decision, given back when the decision was refused.
  if (!await store.claimSession(cookie, session.approvalId)) throw decideSignInRequired();
  let outcome: { applied: boolean; result: T };
  try {
    outcome = await apply(decideProofOf(cookie, session));
  } catch (error) {
    await store.releaseSession(cookie).catch(() => undefined);
    throw error;
  }
  if (!outcome.applied) {
    await store.releaseSession(cookie).catch(() => undefined);
    return outcome.result;
  }
  try {
    // The record of the sign-in the decision was made with: approved by the approval decide kind with the session's proof, which its audit event carries.
    await approvalDecideKind(agents).decide({ orgId: who.orgId, developerId: who.developerId, approvalId: session.approvalId }, "approve", decideProofOf(cookie, session));
  } catch (error) {
    // The decision is applied: it is not undone, and the person is not told it failed. The missing record is logged (the sweep expires the record).
    console.log(JSON.stringify({ component: "broker", event: "card_decision.record_failed", approvalId: session.approvalId, error: error instanceof Error ? error.name : "unknown" }));
  } finally {
    await store.deleteSession(cookie).catch(() => undefined);
  }
  return outcome.result;
}
