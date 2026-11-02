import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import {
 DecisionCardsViewReaderSchema, DecisionDetailGroupsSchema, DecisionDigestSchema, DecisionEvidenceOpenedAnswerSchema, DecisionOutcomeSchema, DecisionTabsSchema,
 type DecisionDetailGroup, type DecisionRejectReason, type DecisionTab, type DecisionTabId,
} from "@agentx/contracts/web";
import { useAppHost, type AppHost } from "../host.js";
import { createApiClient } from "./client.js";
import { ApiError } from "./errors.js";
import { isConfirmUrl } from "../text/links.js";

type View = ReturnType<typeof DecisionCardsViewReaderSchema.parse>;
export type ReadDecisionCard = View["cards"][number];
/** A card with what the server shows beside it: its tabs, its evidence detail and the digest of what is shown (sent back with every open and approve). A card with no valid digest is not shown. */
export interface ReadDecision { card: ReadDecisionCard; tabs: DecisionTab[] | undefined; details: DecisionDetailGroup[]; digest: string }

/** The card's own action of a kind, only when its address is exactly the card route this app knows: a client never follows an address a card made up. */
export function decisionActionPath(card: ReadDecisionCard, kind: "approve" | "reject"): string | undefined {
 const action = card.actions.find(candidate => candidate.kind === kind);
 if (action === undefined || action.method !== "POST" || typeof card.id !== "string") return undefined;
 const expected = "/v1/app/decisions/" + card.id.replace(":", "/") + "/" + kind;
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
 const api = createApiClient(host);
 const done = <T,>(result: { kind: string; value?: T }): T => { if (result.kind !== "done" || result.value === undefined) throw new ApiError(409, "PENDING", "This isn't finished. Open the decision to continue."); return result.value; };
 const resultOf = (value: ReturnType<typeof DecisionOutcomeSchema.parse>): DecisionResult => value.outcome === "needs_confirmation"
  ? { kind: "needs_confirmation", confirmUrl: isConfirmUrl(value.confirmUrl, host.origin) ? value.confirmUrl : undefined, merging: value.merging }
  : { kind: "decided", outcome: value.outcome };
 return {
  async evidenceOpened(decision: ReadDecision, tab?: DecisionTabId) { return done(await api.send("POST", evidencePath(decision.card, tab), { requestId: crypto.randomUUID(), shownDigest: decision.digest }, DecisionEvidenceOpenedAnswerSchema)); },
  async approve(decision: ReadDecision, tab?: DecisionTabId): Promise<DecisionResult> {
   const path = mayApproveHere(decision.card) ? decisionActionPath(decision.card, "approve") : undefined;
   if (path === undefined) throw new ApiError(403, "FORBIDDEN", "This action is unavailable.");
   return resultOf(done(await api.send("POST", path, { requestId: crypto.randomUUID(), shownDigest: decision.digest, ...(tab === undefined ? {} : { tab }) }, DecisionOutcomeSchema, { retry: "never" })));
  },
  async reject(decision: ReadDecision, reason: DecisionRejectReason): Promise<DecisionResult> {
   const path = decision.card.risk === "high" ? undefined : decisionActionPath(decision.card, "reject");
   if (path === undefined) throw new ApiError(403, "FORBIDDEN", "This action is unavailable.");
   return resultOf(done(await api.send("POST", path, { requestId: crypto.randomUUID(), reason }, DecisionOutcomeSchema, { retry: "never" })));
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
