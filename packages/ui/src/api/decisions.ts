import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import {
 DecisionCardsViewReaderSchema, DecisionDetailGroupsSchema, DecisionDigestSchema, DecisionEvidenceOpenedAnswerSchema, DecisionOutcomeReaderSchema, DecisionTabsSchema,
 type DecisionDetailGroup, type DecisionRejectReason, type DecisionTab, type DecisionTabId,
} from "@agentx/contracts/web";
import { useAppHost, type AppHost } from "../host.js";
import { createApiClient } from "./client.js";
import { ApiError } from "./errors.js";
import { exactAnswer } from "./without-request-id.js";
import { isConfirmUrl } from "../text/links.js";

type View = ReturnType<typeof DecisionCardsViewReaderSchema.parse>;
export type ReadDecisionCard = View["cards"][number];
/** A card with what the server shows beside it: its tabs, its evidence detail and the digest of what is shown (sent back with every open and approve). A card with no valid digest is not shown. */
export interface ReadDecision { card: ReadDecisionCard; tabs: DecisionTab[] | undefined; details: DecisionDetailGroup[]; digest: string }

/** The card's own action of a kind, only when its address is exactly the card route this app knows: a client never follows an address a card made up. */
export function decisionActionPath(card: ReadDecisionCard, kind: "approve" | "reject" | "request_changes"): string | undefined {
 const action = card.actions.find(candidate => candidate.kind === kind);
 if (action === undefined || action.method !== "POST" || typeof card.id !== "string") return undefined;
 const expected = "/v1/app/decisions/" + card.id.replace(":", "/") + "/" + (kind === "request_changes" ? "request-changes" : kind);
 return action.href === expected ? expected : undefined;
}
/** Slice 2: the kinds whose HIGH card is approved on the card itself, on its task page, with a recent sign-in (the broker's `highOnCard`). Every other high card has no approve here. */
export const HIGH_ON_CARD_KINDS: readonly string[] = ["approve_plan", "approve_requirements", "merge", "approve_request"];
/** A coding plan's card: whether approving raises the run limit, so the card asks for a tick (the broker refuses a raise without it). */
export function runLimitRaise(card: ReadDecisionCard): { currentUsd: number | undefined; proposedUsd: number; raises: boolean } | undefined {
 const limit = card.runLimit;
 if (limit === undefined || typeof limit.proposedUsd !== "number") return undefined;
 const currentUsd = typeof limit.currentUsd === "number" ? limit.currentUsd : undefined;
 return { currentUsd, proposedUsd: limit.proposedUsd, raises: currentUsd === undefined || limit.proposedUsd > currentUsd };
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

export function readDecisions(view: View): ReadDecision[] {
 return view.cards.flatMap(card => {
  const digest = DecisionDigestSchema.safeParse(view.digests?.[card.id]);
  if (!digest.success) return [];
  const tabs = DecisionTabsSchema.safeParse(view.tabs?.[card.id]), details = DecisionDetailGroupsSchema.safeParse(view.details?.[card.id]);
  return [{ card, tabs: tabs.success ? tabs.data : undefined, details: details.success ? details.data : [], digest: digest.data }];
 });
}

/** What an approve or a reject came to: decided, or waiting on the confirmation page (nothing was decided). */
export type DecisionResult = { kind: "decided"; outcome: "approved" | "rejected" } | { kind: "needs_confirmation"; confirmUrl: string | undefined; /** A merge: the pull requests and the branch each goes into, for the "Merge #N into <branch>?" question. */ merging?: ReadonlyArray<{ repositoryId: string; number: number; baseBranch: string }> | undefined };

export function createDecisionsApi(host: AppHost) {
 const api = createApiClient(host), waiting = new Map<string, string>();
 const done = <T,>(result: { kind: string; value?: T }): T => { if (result.kind !== "done" || result.value === undefined) throw new ApiError(409, "PENDING", "This isn't finished. Open the decision to continue."); return result.value; };
 const resultOf = (value: ReturnType<typeof DecisionOutcomeReaderSchema.parse>): DecisionResult => value.outcome === "needs_confirmation"
  ? { kind: "needs_confirmation", confirmUrl: isConfirmUrl(value.confirmUrl, host.origin) ? value.confirmUrl : undefined, merging: value.merging }
  : { kind: "decided", outcome: value.outcome };
 return {
  async evidenceOpened(decision: ReadDecision, tab?: DecisionTabId) { return done(await api.send("POST", evidencePath(decision.card, tab), { requestId: crypto.randomUUID(), shownDigest: decision.digest }, exactAnswer(DecisionEvidenceOpenedAnswerSchema))); },
  async approve(decision: ReadDecision, tab?: DecisionTabId, reason?: string, acknowledgedRunLimitUsd?: number): Promise<DecisionResult> {
   const path = mayApproveHere(decision.card) ? decisionActionPath(decision.card, "approve") : undefined;
   if (path === undefined) throw new ApiError(403, "FORBIDDEN", "This action is unavailable.");
   // A merge asks for the pull requests it names (`merging`), which only a reader that knows the field is sent. Approve, Cancel, Approve of the SAME card as shown (same digest) is one request, not a new pending change each time.
   const key = decision.card.id + "|" + decision.digest + "|" + (tab ?? "") + "|" + (reason ?? ""), requestId = waiting.get(key) ?? crypto.randomUUID();
   waiting.delete(key);
   const result = resultOf(done(await api.send("POST", decision.card.kind === "merge" ? path + "?merging=1" : path, { requestId, shownDigest: decision.digest, ...(tab === undefined ? {} : { tab }), ...(reason === undefined ? {} : { reason }), ...(acknowledgedRunLimitUsd === undefined ? {} : { acknowledgedRunLimitUsd }) }, DecisionOutcomeReaderSchema, { retry: "never" })));
   if (result.kind === "needs_confirmation") waiting.set(key, requestId);
   return result;
  },
  /** Slice 2: a HIGH requirements or coding plan card, approved on its card on the task page. The broker asks for the browser session and the recent sign-in (REAUTH_REQUIRED otherwise). */
  async approveHighOnCard(decision: ReadDecision, shownDigest: string, acknowledgedRunLimitUsd?: number): Promise<DecisionResult> {
   const card = decision.card;
   if (card.risk !== "high" || !HIGH_ON_CARD_KINDS.includes(card.kind) || typeof card.id !== "string") throw new ApiError(403, "FORBIDDEN", "This action is unavailable.");
   // A high merge answers 202: its approval card (decided there with the decide-grade sign-in) is where it goes on.
   return resultOf(done(await api.send("POST", "/v1/app/decisions/" + card.id.replace(":", "/") + "/approve", { requestId: crypto.randomUUID(), shownDigest, ...(acknowledgedRunLimitUsd === undefined ? {} : { acknowledgedRunLimitUsd }) }, DecisionOutcomeReaderSchema, { retry: "never" })));
  },
  /** Slice 3b: Decline an outside approval on its card (its reject route; the broker asks for the browser, the recent sign-in and the decider's authority, as the confirmation page did). */
  async declineOnCard(decision: ReadDecision): Promise<void> {
   const card = decision.card, path = decisionActionPath(card, "reject");
   if (card.kind !== "approve_request" || path === undefined) throw new ApiError(403, "FORBIDDEN", "This action is unavailable.");
   done(await api.send("POST", path, { requestId: crypto.randomUUID(), reason: "other" }, DecisionOutcomeReaderSchema, { retry: "never" }));
  },
  /** Slice 2: send a document back with the person's reason (one line). Only the card's own request-changes route. */
  async requestChanges(decision: ReadDecision, reason: string): Promise<DecisionResult> {
   const path = decisionActionPath(decision.card, "request_changes");
   if (path === undefined) throw new ApiError(403, "FORBIDDEN", "This action is unavailable.");
   return resultOf(done(await api.send("POST", path, { requestId: crypto.randomUUID(), shownDigest: decision.digest, reason }, DecisionOutcomeReaderSchema, { retry: "never" })));
  },
  async reject(decision: ReadDecision, reason: DecisionRejectReason): Promise<DecisionResult> {
   const path = decision.card.risk === "high" ? undefined : decisionActionPath(decision.card, "reject");
   if (path === undefined) throw new ApiError(403, "FORBIDDEN", "This action is unavailable.");
   return resultOf(done(await api.send("POST", path, { requestId: crypto.randomUUID(), reason }, DecisionOutcomeReaderSchema, { retry: "never" })));
  },
 };
}

/**
 * The caller's decision cards. Only a 404 is "no cards": the cards switch is off in this deployment and the route does not exist (the broker's tests pin that the browser boundary lets the route through, so a 404 here is the switch).
 * Any other failure (a refusal, a server error, no connection, an answer that cannot be read) is an error for the screen to show; it is never read as "no cards" (WEB-1: a 404 from the browser boundary was swallowed that way).
 */
export function useDecisions(approval?: string) {
 const host = useAppHost(), api = useMemo(() => createApiClient(host), [host]);
 // Slice 3b: the card page of an outside approval names it, so the server lists it for a person who may decide it even when no list names them (a rule's approver).
 const named = approval !== undefined && /^(?:apr|spr)_[0-9a-z]{20}$/u.test(approval) ? approval : undefined;
 return useQuery({
  queryKey: named === undefined ? ["decisions"] : ["decisions", named], retry: false,
  queryFn: async () => {
   try { return readDecisions(await api.get(named === undefined ? "/v1/app/decisions" : "/v1/app/decisions?approval=" + named, DecisionCardsViewReaderSchema)); }
   catch (failure) { if (failure instanceof ApiError && failure.status === 404) return []; throw failure; }
  },
 });
}
