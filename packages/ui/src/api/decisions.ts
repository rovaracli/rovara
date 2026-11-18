import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import {
 DECISION_PLAN_CHOICE_KINDS, DecisionCardsViewReaderSchema, DecisionDetailGroupsSchema, DecisionDigestSchema, DecisionEvidenceOpenedAnswerSchema, DecisionOutcomeReaderSchema, DecisionPlanChoicesSchema,
 DecisionRequestChangesBodySchema, DecisionTabsSchema,
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
export interface ReadDecision { card: ReadDecisionCard; tabs: DecisionTab[] | undefined; details: DecisionDetailGroup[]; choices: DecisionPlanChoices | undefined; /** The server sent an entry of choices for this card that could not be read: the card says so and offers no swipe. */ choicesUnreadable: boolean; digest: string }

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
  return [{ card, tabs: tabs.success ? tabs.data : undefined, details: details.success ? details.data : [], choices: choices?.success === true ? choices.data : undefined, choicesUnreadable: choices?.success === false && view.choices?.[card.id] !== undefined, digest: digest.data }];
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
  async approve(decision: ReadDecision, tab?: DecisionTabId, reason?: string, extras?: ApproveExtras): Promise<DecisionResult> {
   const path = mayApproveHere(decision.card) ? decisionActionPath(decision.card, "approve") : undefined;
   if (path === undefined) throw new ApiError(403, "FORBIDDEN", "This action is unavailable.");
   // A merge asks for the pull requests it names (`merging`), which only a reader that knows the field is sent. Approve, Cancel, Approve of the SAME card as shown (same digest) is one request, not a new pending change each time.
   const sent = extrasAllowedFor(decision.card.kind, extras);
   const key = decision.card.id + "|" + decision.digest + "|" + (tab ?? "") + "|" + (reason ?? "") + "|" + JSON.stringify(sent), requestId = waiting.get(key) ?? crypto.randomUUID();
   waiting.delete(key);
   const result = resultOf(done(await api.send("POST", decision.card.kind === "merge" ? path + "?merging=1" : path, { requestId, shownDigest: decision.digest, ...(tab === undefined ? {} : { tab }), ...(reason === undefined ? {} : { reason }), ...sent }, DecisionOutcomeReaderSchema, { retry: "never" })));
   if (result.kind === "needs_confirmation") waiting.set(key, requestId);
   return result;
  },
  /** Sends the document back with the person's reason (and the open comments sent along). Never approves; the card's own action at its exact route, and not on a high card. */
  async requestChanges(decision: ReadDecision, reason: string, includedCommentIds?: readonly string[]): Promise<DecisionResult> {
   const path = mayRequestChangesHere(decision.card) ? decisionActionPath(decision.card, "request_changes") : undefined;
   if (path === undefined) throw new ApiError(403, "FORBIDDEN", "This action is unavailable.");
   const body = DecisionRequestChangesBodySchema.safeParse({ requestId: crypto.randomUUID(), shownDigest: decision.digest, reason: cleanChangesReason(reason) ?? "", ...(includedCommentIds === undefined ? {} : { includedCommentIds }) });
   if (!body.success) throw new ApiError(400, "INVALID", "Say what should change, in plain text.");
   return resultOf(done(await api.send("POST", path, body.data, DecisionOutcomeReaderSchema, { retry: "never" })));
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
export function useDecisions() {
 const host = useAppHost(), api = useMemo(() => createApiClient(host), [host]);
 return useQuery({
  queryKey: ["decisions"], retry: false,
  queryFn: async () => {
   try { return readDecisions(await api.get("/v1/app/decisions", DecisionCardsViewReaderSchema)); }
   catch (failure) { if (failure instanceof ApiError && failure.status === 404) return []; throw failure; }
  },
 });
}
