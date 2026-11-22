import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { DECISION_PLAN_CHOICE_KINDS, DecisionCardsViewReaderSchema, DecisionDetailGroupsSchema, DecisionDigestSchema, DecisionPlanChoicesSchema, DecisionTabsSchema, type DecisionDetailGroup, type DecisionPlanChoices, type DecisionTab } from "@agentx/contracts/web";
import { useAppHost } from "../host.js";
import { createReadClient } from "./read-client.js";
import { ApiError } from "./errors.js";
type View = ReturnType<typeof DecisionCardsViewReaderSchema.parse>;
export type ReadDecisionCard = View["cards"][number];
/**
 * A card with what the server shows beside it: its tabs, its evidence detail, its plan choices (the questions, optional checks and open comments of a plan, requirements or design card) and the digest of what is
 * shown (sent back with every open and approve). A card with no valid digest is not shown. `choices` is undefined for a card without any, and for one whose choices do not read (the person can still approve with
 * Rovara's own answers).
 */
export interface ReadDecision { card: ReadDecisionCard; tabs: DecisionTab[] | undefined; details: DecisionDetailGroup[]; /** Required mark evidence could not be read; approval is removed. */ detailsUnreadable?: boolean; choices: DecisionPlanChoices | undefined; /** The server sent an entry of choices for this card that could not be read: the card says so and offers no swipe. */ choicesUnreadable: boolean; digest: string }

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

/**
 * The caller's decision cards. Only a plain NOT_FOUND 404 is an unsupported route with no cards. An explicit access-ended signal remains an error.
 * Any other failure (a refusal, a server error, no connection, an answer that cannot be read) is an error for the screen to show; it is never read as "no cards" (WEB-1: a 404 from the browser boundary was swallowed that way).
 */
export function useDecisions() {
 const host = useAppHost(), api = useMemo(() => createReadClient(host), [host]);
 return useQuery({
  queryKey: ["decisions"], retry: false,
  queryFn: async () => {
   try { return readDecisions(await api.get("/v1/app/decisions", DecisionCardsViewReaderSchema)); }
   catch (failure) { if (failure instanceof ApiError && failure.status === 404 && failure.code === "NOT_FOUND") return []; throw failure; }
  },
 });
}
