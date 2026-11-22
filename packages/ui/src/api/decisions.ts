import { runTaskAction, isFinalTaskActionRefusal } from "./task-action.js";
import { isCsrfFailure } from "../safe-action.js";
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import {
 DECISION_PLAN_CHOICE_KINDS, DecisionCardsViewReaderSchema, DecisionDetailGroupsSchema, DecisionDigestSchema, DecisionEvidenceOpenedAnswerSchema, DecisionOutcomeReaderSchema, DecisionPlanChoicesSchema,
 AppMeResponseReaderSchema, DecisionRequestChangesBodySchema, DecisionTabsSchema,
 type DecisionDetailGroup, type DecisionPlanChoices, type DecisionRejectReason, type DecisionTab, type DecisionTabId,
} from "@agentx/contracts/web";
import { useAppHost, type AppHost } from "../host.js";
import { createApiClient } from "./client.js";
import { ApiError } from "./errors.js";
import { exactAnswer } from "./without-request-id.js";
import { isConfirmUrl } from "../text/links.js";
import { cleanChangesReason, extrasAllowedFor, type ApproveExtras } from "./plan-pick.js";

type View = ReturnType<typeof DecisionCardsViewReaderSchema.parse>;
export type ReadDecisionCard = View["cards"][number];
/**
 * A card with what the server shows beside it: its tabs, its evidence detail, its plan choices (the questions, optional checks and open comments of a plan, requirements or design card) and the digest of what is
 * shown (sent back with every open and approve). A card with no valid digest is not shown. `choices` is undefined for a card without any, and for one whose choices do not read (the person can still approve with
 * Rovara's own answers).
 */
export interface ReadDecision { card: ReadDecisionCard; tabs: DecisionTab[] | undefined; details: DecisionDetailGroup[]; /** Required mark evidence could not be read; approval is removed. */ detailsUnreadable?: boolean; choices: DecisionPlanChoices | undefined; /** The server sent an entry of choices for this card that could not be read: the card says so and offers no swipe. */ choicesUnreadable: boolean; digest: string }

/** The card's own action of a kind, only when its address is exactly the card route this app knows: a client never follows an address a card made up. */
export function decisionActionPath(card: ReadDecisionCard, kind: "approve" | "reject" | "request_changes"): string | undefined {
 const action = card.actions.find(candidate => candidate.kind === kind);
 if (action === undefined || action.method !== "POST" || typeof card.id !== "string") return undefined;
 const expected = "/v1/app/decisions/" + card.id.replace(":", "/") + "/" + (kind === "request_changes" ? "request-changes" : kind);
 return action.href === expected ? expected : undefined;
}
const evidencePath = (card: ReadDecisionCard, tab?: DecisionTabId): string => "/v1/app/decisions/" + card.id.replace(":", "/") + "/evidence-opened" + (tab === undefined ? "" : "?tab=" + tab);

/** The open action's address as an app path (a page of this app) or a confirmation page of this origin; anything else is no link. */
export function decisionOpenTarget(card: ReadDecisionCard, origin: string): { kind: "internal"; to: string } | { kind: "external"; href: string } | undefined {
 const action = card.actions.find(candidate => candidate.kind === "open");
 if (action === undefined || action.method !== "GET" || !/^\/(?:v1\/)?app\/[A-Za-z0-9/_.~-]+(?:\?[A-Za-z0-9=&_.~%-]*)?$/u.test(action.href) || action.href.split(/[/?#]/).includes("..")) return undefined;
 if (action.href.startsWith("/app/")) return { kind: "internal", to: action.href };
 return action.href.startsWith("/v1/app/approve/") ? { kind: "external", href: origin + action.href } : undefined;
}

/**
 * The client's own guard, because the reader drops the card schema's refinements: a card whose risk is high never gets an approve control here, whatever its actions say. The server also refuses
 * (404); this is so the screen cannot even offer it.
 */
export function mayApproveHere(card: ReadDecisionCard): boolean {
 return card.risk !== "high" && card.actions.some(action => action.kind === "approve");
}

/** Whether the card offers Request changes here: its own action at the exact route this app knows, never on a high card (the server decides those on their own page). */
export function mayRequestChangesHere(card: ReadDecisionCard): boolean {
 return card.risk !== "high" && decisionActionPath(card, "request_changes") !== undefined;
}

export function readDecisions(view: View): ReadDecision[] {
 return view.cards.flatMap(card => {
  const digest = DecisionDigestSchema.safeParse(view.digests?.[card.id]);
  if (!digest.success) return [];
  const tabs = DecisionTabsSchema.safeParse(view.tabs?.[card.id]), details = DecisionDetailGroupsSchema.safeParse(view.details?.[card.id]);
  // Plan choices are read one card at a time, and only for the kinds that carry them: a bad entry hides this card's choices and nothing else.
  const choices = DECISION_PLAN_CHOICE_KINDS.includes(card.kind) ? DecisionPlanChoicesSchema.safeParse(view.choices?.[card.id]) : undefined;
  const detailsUnreadable = card.kind === "fix_setup" && (!details.success || details.data.length === 0);
  const readableCard = detailsUnreadable ? { ...card, actions: card.actions.filter(action => action.kind !== "approve") } : card;
  return [{ card: readableCard, detailsUnreadable, tabs: tabs.success ? tabs.data : undefined, details: details.success ? details.data : [], choices: choices?.success === true ? choices.data : undefined, choicesUnreadable: choices?.success === false && view.choices?.[card.id] !== undefined, digest: digest.data }];
 });
}

/** What an approve or a reject came to: decided, or waiting on the confirmation page (nothing was decided). */
export type DecisionResult = { kind: "decided"; outcome: "approved" | "rejected" } | { kind: "needs_confirmation"; confirmUrl: string | undefined; /** A merge: the pull requests and the branch each goes into, for the "Merge #N into <branch>?" question. */ merging?: ReadonlyArray<{ repositoryId: string; number: number; baseBranch: string }> | undefined };
export interface DecisionApprovalIdentity { orgId: string; developerId: string }
type DecisionBasis = { identity: DecisionApprovalIdentity; sequence: number };
const approvalLockKey = (decision: ReadDecision, identity: DecisionApprovalIdentity) => `rv:decision-approval:${identity.orgId}:${identity.developerId}:${decision.card.id}`;

// Preserve the existing approval record/key while the shared runner owns writes.
const actionHosts = new WeakMap<AppHost, AppHost>();
function actionHost(host: AppHost): AppHost {
 let adapter = actionHosts.get(host);if (adapter) return adapter;
 adapter = { ...host, storage: {
  get(key) {
   if (!key.endsWith(":request")) return host.storage.get(key);
   const raw = host.storage.get(key.slice(0, -8));if (!raw) return undefined;
   const p = JSON.parse(raw) as { requestId: string; body: Record<string, unknown>; startedAt: number };
   return JSON.stringify({ requestId: p.requestId, action: "decision", body: p.body, startedAt: p.startedAt, fence: 0 });
  },
  set(key, raw) {
   if (!key.endsWith(":request")) { host.storage.set(key, raw);return; }
   const p = JSON.parse(raw) as { requestId: string; body: Record<string, unknown>; startedAt: number } | null;
   host.storage.set(key.slice(0, -8), p === null ? "" : JSON.stringify({ requestId: p.requestId, body: p.body, startedAt: p.startedAt }));
  },
 } };
 actionHosts.set(host, adapter);return adapter;
}
/** The task's remaining decision writes use the same subject/claim as approval. */
export async function runDecisionAction<T>(host: AppHost, decision: ReadDecision, body: Record<string, unknown> & { requestId: string }, send: (body: Record<string, unknown> & { requestId: string }) => Promise<T>, basis?: DecisionBasis): Promise<T> {
 const me = await createApiClient(host).get("/v1/app/me", AppMeResponseReaderSchema, undefined, { retry: "never" });
 const identity = { orgId: me.org.orgId, developerId: me.developer.id };
 rememberDecisionIdentity(host, identity);
 const key = approvalLockKey(decision, identity);
 let waiting: { value: T } | undefined;
 try { return await runTaskAction(actionHost(host), key, "decision", body, async request => {
  const value = await send(request.body as typeof body);
  if (typeof value === "object" && value !== null && "kind" in value && ["needs_confirmation", "needs_admin_approval"].includes(String(value.kind))) { waiting = { value };throw new ApiError(202, "PENDING", "This decision is waiting for confirmation."); }
  return value;
 }, null, () => decisionAuthorityRefused(host, decision) || basis !== undefined && (fenceScope(identity) !== fenceScope(basis.identity) || !approvalReadIsCurrent(decision, basis.identity, basis.sequence)) ? "This decision is no longer available. Read it again before deciding." : undefined); }
 catch (failure) {
  if (waiting !== undefined) return waiting.value;
  if (isCsrfFailure(failure) || isFinalTaskActionRefusal(failure)) throw failure;
  if (failure instanceof ApiError && ["ACTION_CLAIM_UNAVAILABLE", "PERSISTENCE_UNAVAILABLE"].includes(failure.code)) {
   let pending = false;
   try { pending = Boolean(host.storage.get(key)); } catch { /* Unreadable storage cannot authorize a send. */ }
   if (failure.code === "ACTION_CLAIM_UNAVAILABLE" || !pending) throw failure;
  }
  throw new ApiError(409, "APPROVAL_UNKNOWN", "Rovara didn't confirm this yet. Check this decision before trying again.");
 }
}
type DecisionFence = { sequence: number; state: "ready" | "refused" | "failed"; digest?: string; status?: string };
let decisionReadSequence = 0;
const decisionFences = new Map<string, DecisionFence>();
const knownDecisionIds = new Map<string, Set<string>>();
const lastDecisionIdentity = new WeakMap<AppHost, DecisionApprovalIdentity>();
const fenceScope = (identity: DecisionApprovalIdentity) => `${identity.orgId}:${identity.developerId}`;
const fenceKey = (identity: DecisionApprovalIdentity, id: string) => `${fenceScope(identity)}:${id}`;
/** Issue order is shared by the mounted query, action verification and unmounted responses. */
export function issueDecisionRead(): number { return ++decisionReadSequence; }
export function rememberDecisionIdentity(host: AppHost, identity: DecisionApprovalIdentity): void { lastDecisionIdentity.set(host, identity); }
export function recordIdentityReadFailure(host: AppHost, failure: unknown, sequence = issueDecisionRead()): void {
 const identity = lastDecisionIdentity.get(host);
 if (identity !== undefined) {
  const refused = failure instanceof ApiError && (failure.status === 401 || failure.status === 403);
  recordDecisionReadFailure(identity, sequence, refused);
  if (refused && typeof window !== "undefined") window.dispatchEvent(new Event("rovara:decision-authority-refused"));
 }
}
export function decisionAuthorityRefused(host: AppHost, decision: ReadDecision): boolean {
 const identity = lastDecisionIdentity.get(host);
 return identity !== undefined && decisionFences.get(fenceKey(identity, decision.card.id))?.state === "refused";
}
export function recordDecisionRead(identity: DecisionApprovalIdentity, sequence: number, decisions: readonly ReadDecision[]): void {
 const scope = fenceScope(identity), known = knownDecisionIds.get(scope) ?? new Set<string>();
 const seen = new Set(decisions.map(decision => decision.card.id));
 // A newer successful feed is authoritative for omissions too. Remember the absence in this
 // identity's scope so an older action read cannot restore authority after the feed moved on.
 for (const id of known) if (!seen.has(id)) {
  const key = fenceKey(identity, id), prior = decisionFences.get(key);
  if (prior === undefined || sequence >= prior.sequence) decisionFences.set(key, { sequence, state: "failed" });
 }
 for (const decision of decisions) {
  known.add(decision.card.id);
  const key = fenceKey(identity, decision.card.id), prior = decisionFences.get(key);
  if (prior === undefined || sequence >= prior.sequence) decisionFences.set(key, { sequence, state: "ready", digest: decision.digest, status: decision.card.status });
 }
 knownDecisionIds.set(scope, known);
}
export function recordDecisionReadFailure(identity: DecisionApprovalIdentity, sequence: number, refused: boolean): void {
 const state = refused ? "refused" : "failed";
 for (const id of knownDecisionIds.get(fenceScope(identity)) ?? []) {
  const key = fenceKey(identity, id), prior = decisionFences.get(key);
  if (prior === undefined || sequence >= prior.sequence) decisionFences.set(key, { sequence, state });
 }
}
function approvalReadIsCurrent(decision: ReadDecision, identity: DecisionApprovalIdentity, sequence: number): boolean {
 const fence = decisionFences.get(fenceKey(identity, decision.card.id));
 return fence?.sequence === sequence && fence.state === "ready" && fence.status === "pending" && fence.digest === decision.digest;
}

export function createDecisionsApi(host: AppHost) {
 const api = createApiClient(host);
 const done = <T,>(result: { kind: string; value?: T }): T => { if (result.kind !== "done" || result.value === undefined) throw new ApiError(409, "PENDING", "This isn't finished. Open the decision to continue."); return result.value; };
 // A confirmation request for another card is not this decision's confirmation: it stays unknown (the caller turns the throw into APPROVAL_UNKNOWN with the lock kept).
 const resultOf = (value: ReturnType<typeof DecisionOutcomeReaderSchema.parse>, decision: ReadDecision): DecisionResult => value.outcome === "needs_confirmation"
  ? value.cardId !== decision.card.id ? (() => { throw new ApiError(409, "APPROVAL_UNKNOWN", "Rovara didn't confirm this yet. Check this decision before trying again."); })() : { kind: "needs_confirmation", confirmUrl: isConfirmUrl(value.confirmUrl, host.origin) ? value.confirmUrl : undefined, merging: value.merging }
  : { kind: "decided", outcome: value.outcome };
 return {
  async evidenceOpened(decision: ReadDecision, tab?: DecisionTabId) { return runDecisionAction(host, decision, { requestId: crypto.randomUUID(), shownDigest: decision.digest }, async body => done(await api.send("POST", evidencePath(decision.card, tab), body, exactAnswer(DecisionEvidenceOpenedAnswerSchema), { retry: "never" }))); },
  async approve(decision: ReadDecision, tab?: DecisionTabId, reason?: string, extras?: ApproveExtras, identity?: DecisionApprovalIdentity, expectedReadSequence?: number): Promise<DecisionResult> {
   const path = mayApproveHere(decision.card) ? decisionActionPath(decision.card, "approve") : undefined;
   if (path === undefined) throw new ApiError(403, "FORBIDDEN", "This action is unavailable.");
   if (identity === undefined) throw new ApiError(409, "IDENTITY_UNREAD", "Reload your identity before approving this decision.");
   if (expectedReadSequence !== undefined && !approvalReadIsCurrent(decision, identity, expectedReadSequence)) throw new ApiError(409, "CHANGE_STALE", "This decision's latest read no longer permits approval. Reload before deciding.");
   // A merge asks for the pull requests it names (`merging`), which only a reader that knows the field is sent. Approve, Cancel, Approve of the SAME card as shown (same digest) is one request, not a new pending change each time.
   const sent = extrasAllowedFor(decision.card.kind, extras), lockKey = approvalLockKey(decision, identity);
   if (host.storage.get(lockKey)) throw new ApiError(409, "APPROVAL_UNKNOWN", "Rovara didn't confirm this yet. Check this decision before trying again.");
   const body = { requestId: crypto.randomUUID(), shownDigest: decision.digest, ...(tab === undefined ? {} : { tab }), ...(reason === undefined ? {} : { reason }), ...sent };
   let confirmation: DecisionResult | undefined;
   try {
    return await runTaskAction(actionHost(host), lockKey, "decision", body, async () => {
     const result = resultOf(done(await api.send("POST", decision.card.kind === "merge" ? path + "?merging=1" : path, body, DecisionOutcomeReaderSchema, { retry: "never", pendingIsUnknown: true, confirmationIsPending: true })), decision);
     if (result.kind !== "decided") { confirmation = result;throw new ApiError(202, "PENDING", "This decision is waiting for confirmation."); }
     return result;
    }, null, () => expectedReadSequence !== undefined && !approvalReadIsCurrent(decision, identity, expectedReadSequence) ? "This decision changed. Reload before deciding." : undefined);
   } catch (failure) {
    if (confirmation !== undefined) return confirmation;
    if (isFinalTaskActionRefusal(failure)) throw failure;
    if (isCsrfFailure(failure)) throw new ApiError(403, failure instanceof ApiError ? failure.code : "CSRF_INVALID", "Couldn't change that. Reload your identity before trying again.");
    if (failure instanceof ApiError && failure.code === "PERSISTENCE_UNAVAILABLE" && !host.storage.get(lockKey)) throw new ApiError(409, "APPROVAL_NOT_PERSISTED", "This approval can't be made safely in this browser. Nothing was sent.");
    throw new ApiError(409, "APPROVAL_UNKNOWN", "Rovara didn't confirm this yet. Check this decision before trying again.");
   }
  },
  async checkApproval(decision: ReadDecision, identity: DecisionApprovalIdentity): Promise<"resolved" | "same_pending" | "changed_pending" | "unknown"> {
   const lockKey = approvalLockKey(decision, identity), raw = host.storage.get(lockKey);
   let sequence: number | undefined;
   try {
    const pending = raw ? JSON.parse(raw) as { body?: { shownDigest?: unknown }; startedAt?: unknown } : undefined;
    if (pending !== undefined && typeof pending.startedAt !== "number") return "unknown";
    sequence = issueDecisionRead();
    const currentItems = readDecisions(await api.get("/v1/app/decisions", DecisionCardsViewReaderSchema));
    recordDecisionRead(identity, sequence, currentItems);
    const fence = decisionFences.get(fenceKey(identity, decision.card.id));
    if (fence?.sequence !== sequence || fence.state !== "ready") return "unknown";
    const current = currentItems.find(item => item.card.id === decision.card.id);
    if (current === undefined) return "unknown";
    if (current.card.status === "pending") return pending === undefined || current.digest === pending.body?.shownDigest ? "same_pending" : "changed_pending";
    if (host.storage.get(lockKey) !== raw) return "unknown";
    host.storage.set(lockKey, "");
    return "resolved";
   } catch (failure) {
    if (sequence !== undefined) recordDecisionReadFailure(identity, sequence, failure instanceof ApiError && (failure.status === 401 || failure.status === 403));
    return "unknown";
   }
  },
  async hasUnknownApproval(decision: ReadDecision, identity: DecisionApprovalIdentity): Promise<boolean> {
   const stored = host.storage.get(approvalLockKey(decision, identity));
   return stored !== undefined && stored !== "";
  },
  /** Sends the document back with the person's reason (and the open comments sent along). Never approves; the card's own action at its exact route, and not on a high card. */
  async requestChanges(decision: ReadDecision, reason: string, includedCommentIds?: readonly string[]): Promise<DecisionResult> {
   const path = mayRequestChangesHere(decision.card) ? decisionActionPath(decision.card, "request_changes") : undefined;
   if (path === undefined) throw new ApiError(403, "FORBIDDEN", "This action is unavailable.");
   const body = DecisionRequestChangesBodySchema.safeParse({ requestId: crypto.randomUUID(), shownDigest: decision.digest, reason: cleanChangesReason(reason) ?? "", ...(includedCommentIds === undefined ? {} : { includedCommentIds }) });
   if (!body.success) throw new ApiError(400, "INVALID", "Say what should change, in plain text.");
   return runDecisionAction(host, decision, body.data, async frozen => resultOf(done(await api.send("POST", path, frozen, DecisionOutcomeReaderSchema, { retry: "never", pendingIsUnknown: true, confirmationIsPending: true })), decision));
  },
  async reject(decision: ReadDecision, reason: DecisionRejectReason, basis?: DecisionBasis): Promise<DecisionResult> {
   const path = decision.card.risk === "high" ? undefined : decisionActionPath(decision.card, "reject");
   if (path === undefined) throw new ApiError(403, "FORBIDDEN", "This action is unavailable.");
   return runDecisionAction(host, decision, { requestId: crypto.randomUUID(), reason }, async frozen => resultOf(done(await api.send("POST", path, frozen, DecisionOutcomeReaderSchema, { retry: "never", pendingIsUnknown: true, confirmationIsPending: true })), decision), basis);
  },
 };
}

/**
 * The caller's decision cards. Only a plain NOT_FOUND 404 is an unsupported route with no cards. An explicit access-ended signal remains an error.
 * Any other failure (a refusal, a server error, no connection, an answer that cannot be read) is an error for the screen to show; it is never read as "no cards" (WEB-1: a 404 from the browser boundary was swallowed that way).
 */
export function useDecisions() {
 const host = useAppHost(), api = useMemo(() => createApiClient(host), [host]);
 return useQuery({
  queryKey: ["decisions"], retry: false,
  queryFn: async () => {
   const sequence = issueDecisionRead();
   let view: View;
   try {
    view = await api.get("/v1/app/decisions", DecisionCardsViewReaderSchema);
   } catch (failure) {
    const identity = lastDecisionIdentity.get(host);
    if (failure instanceof ApiError && failure.status === 404 && failure.code === "NOT_FOUND") {
     if (identity !== undefined) recordDecisionReadFailure(identity, sequence, false);
     return [];
    }
    if (identity !== undefined) recordDecisionReadFailure(identity, sequence, failure instanceof ApiError && (failure.status === 401 || failure.status === 403));
    throw failure;
   }
   const decisions = readDecisions(view);
   const identitySequence = issueDecisionRead();
   try {
    const me = await api.get("/v1/app/me", AppMeResponseReaderSchema), identity = { orgId: me.org.orgId, developerId: me.developer.id };
    rememberDecisionIdentity(host, identity);
    recordDecisionRead(identity, sequence, decisions);
    return decisions;
   } catch (failure) {
    recordIdentityReadFailure(host, failure, identitySequence);
    throw failure;
   }
  },
 });
}
