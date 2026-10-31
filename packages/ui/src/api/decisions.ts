import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { DecisionAnsweredSchema, DecisionCardsViewReaderSchema, DecisionEvidenceOpenedAnswerSchema, DecisionTabsSchema, type DecisionRejectReason, type DecisionTab, type DecisionTabId } from "@agentx/contracts/web";
import { useAppHost, type AppHost } from "../host.js";
import { createApiClient } from "./client.js";
import { ApiError } from "./errors.js";

type View = ReturnType<typeof DecisionCardsViewReaderSchema.parse>;
export type ReadDecisionCard = View["cards"][number];
export interface ReadDecision { card: ReadDecisionCard; tabs: DecisionTab[] | undefined }

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

export function readDecisions(view: View): ReadDecision[] {
 return view.cards.map(card => {
  const tabs = DecisionTabsSchema.safeParse(view.tabs?.[card.id]);
  return { card, tabs: tabs.success ? tabs.data : undefined };
 });
}

export function createDecisionsApi(host: AppHost) {
 const api = createApiClient(host);
 const done = <T,>(result: { kind: string; value?: T }): T => { if (result.kind !== "done" || result.value === undefined) throw new ApiError(409, "PENDING", "This isn't finished. Open the decision to continue."); return result.value; };
 return {
  async evidenceOpened(card: ReadDecisionCard, tab?: DecisionTabId) { return done(await api.send("POST", evidencePath(card, tab), { requestId: crypto.randomUUID() }, DecisionEvidenceOpenedAnswerSchema)); },
  async approve(card: ReadDecisionCard, tab?: DecisionTabId) {
   const path = decisionActionPath(card, "approve");
   if (path === undefined) throw new ApiError(403, "FORBIDDEN", "This action is unavailable.");
   return done(await api.send("POST", path, { requestId: crypto.randomUUID(), ...(tab === undefined ? {} : { tab }) }, DecisionAnsweredSchema, { retry: "never" }));
  },
  async reject(card: ReadDecisionCard, reason: DecisionRejectReason) {
   const path = decisionActionPath(card, "reject");
   if (path === undefined) throw new ApiError(403, "FORBIDDEN", "This action is unavailable.");
   return done(await api.send("POST", path, { requestId: crypto.randomUUID(), reason }, DecisionAnsweredSchema, { retry: "never" }));
  },
 };
}

/** The caller's decision cards. A server without the routes (or a refusal) is "no cards", never an error on Home: the older Home cards still show. */
export function useDecisions() {
 const host = useAppHost(), api = useMemo(() => createApiClient(host), [host]);
 return useQuery({ queryKey: ["decisions"], retry: false, queryFn: async () => readDecisions(await api.get("/v1/app/decisions", DecisionCardsViewReaderSchema)) });
}
