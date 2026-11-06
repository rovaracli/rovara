// One card per decision on Home (decision journey slice 1): an older Home card about a session is left out while a pending decision card already holds that decision for the same task, so
// "Needs you" is the one place it is decided. Only the kinds a decision card replaces today are left out: a plan to review (the design or requirements card), the owner's own pull request
// (the merge card) and the questions (the design questions card). Every other older card stays until slice 2 makes it a decision card. When the decision cards cannot be read, nothing is left out.
import { decisionTaskSessionOf } from "@agentx/contracts/web";
import type { ReadDecision } from "../../api/decisions.js";
import type { ReadHomeCard } from "../../api/home.js";

/** The decision card kinds that hold the decision each older Home card kind asks for. */
const REPLACED_BY: Readonly<Record<string, readonly string[]>> = {
 plan: ["approve_plan", "approve_requirements", "approve_design"],
 pull_request: ["merge"],
 question: ["answer_question"],
};

/** The sessions each decision card kind is pending on (from the card's own "Open" link, which names its task page). */
function pendingSessions(decisions: readonly ReadDecision[]): Map<string, Set<string>> {
 const found = new Map<string, Set<string>>();
 for (const { card } of decisions) {
  if (card.status !== "pending") continue;
  const open = card.actions.find(action => action.kind === "open" && action.method === "GET");
  const session = open === undefined ? undefined : decisionTaskSessionOf(open.href);
  if (session === undefined) continue;
  const kinds = found.get(session) ?? new Set<string>();
  kinds.add(card.kind);found.set(session, kinds);
 }
 return found;
}

/** The older Home cards to show: those whose decision no pending decision card holds. The owner's own pull request card is `pull_request:<sessionId>`; a reviewer's (`pull_request:rv_...`) is another decision and stays. */
export function withoutDecided(cards: readonly ReadHomeCard[], decisions: readonly ReadDecision[] | undefined): ReadHomeCard[] {
 if (decisions === undefined || decisions.length === 0) return [...cards];
 const sessions = pendingSessions(decisions);
 return cards.filter(card => {
  const replacing = REPLACED_BY[card.kind], session = card.sessionId;
  if (replacing === undefined || typeof session !== "string") return true;
  if (card.kind === "pull_request" && card.cardId !== "pull_request:" + session) return true;
  const pending = sessions.get(session);
  return pending === undefined || !replacing.some(kind => pending.has(kind));
 });
}
