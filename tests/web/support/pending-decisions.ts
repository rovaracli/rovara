// Decision 125 deleted Home's own list of decision cards: Home now lists each decision as a row that opens its card (HomeV2), and the cards live on the task page and the decision page through the
// same `DecisionList`. The card tests that used to drive that list through Home drive it here, exactly as Home's section did: the person's pending decisions, as cards, in one list.
import { createElement as h } from "react";
import { useDecisions } from "../../../packages/ui/src/api/decisions.js";
import { DecisionList } from "../../../packages/ui/src/screens/home/NeedsYou.js";

export function PendingDecisionCards() {
 const decisions = useDecisions();
 const pending = (decisions.data ?? []).filter(decision => decision.card.status === "pending");
 return h("section", { "aria-label": "Needs you" }, h(DecisionList, { decisions: pending, label: "Decisions waiting for you" }));
}
