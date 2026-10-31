// The digest of what a person saw on a card. The "evidence opened" record is bound to it, so a card whose evidence, risk or wording changed after the person looked must be opened again before
// a medium-risk approve is accepted.
import { createHash } from "node:crypto";
import { canonicalJson, type DecisionCard, type DecisionTab } from "@agentx/contracts";

export function cardDigest(card: DecisionCard, tabs?: readonly DecisionTab[]): string {
  const seen = { id: card.id, kind: card.kind, title: card.title, question: card.question, next: card.next, evidence: card.evidence, risk: card.risk, riskReasons: card.riskReasons, tabs: tabs === undefined ? null : tabs.map((tab) => ({ id: tab.id, summary: tab.summary, evidence: tab.evidence })) };
  return createHash("sha256").update(canonicalJson(seen)).digest("hex");
}
