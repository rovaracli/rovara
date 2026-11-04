import { useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useAppHost } from "../../host.js";
import { createDecisionsApi, useDecisions, type ReadDecision } from "../../api/decisions.js";
import { DecisionCard, type DecisionCardActions } from "../../design/DecisionCard.js";
import { createDesignReviewApi } from "../../api/design-review.js";
import { ApiError } from "../../api/errors.js";
import { Button } from "../../design/Button.js";
import { VisibleText } from "../../design/VisibleText.js";

/** The decisions could not be read: said plainly, with a way to try again. The older Home cards below still show. */
function DecisionsError({ error, retry }: { error: unknown; retry: () => void }) {
 return <div className="rv-home-error" role="alert"><p><VisibleText text={error instanceof ApiError ? error.message : "Couldn't load your decisions. Try again."} /></p><Button onClick={retry}>Try again</Button></div>;
}

/** The actions a decision card calls, each followed by a refresh of the cards and of Home. */
export function useDecisionActions() {
 const host = useAppHost(), query = useQueryClient(), api = useMemo(() => createDecisionsApi(host), [host]), designApi = useMemo(() => createDesignReviewApi(host), [host]);
 const refresh = async () => { await Promise.all([query.invalidateQueries({ queryKey: ["decisions"] }), query.invalidateQueries({ queryKey: ["home"] })]); };
 return (decision: ReadDecision) => ({
  onOpenEvidence: async (tab?: Parameters<typeof api.evidenceOpened>[1]) => { await api.evidenceOpened(decision, tab); },
  onApprove: async (tab?: Parameters<typeof api.approve>[1], reason?: string) => { const result = await api.approve(decision, tab, reason);await refresh();return result; },
  // A choice on a design review's cost card: the card's own action, through the design review route (the broker re-checks who may choose it).
  onChoose: async (action: ReadDecision["card"]["actions"][number]) => { await designApi.chooseSpend(decision, action, crypto.randomUUID());await refresh(); },
  onReject: async (reason: Parameters<typeof api.reject>[1]) => { const result = await api.reject(decision, reason);await refresh();return result; },
  onStale: () => { void query.invalidateQueries({ queryKey: ["decisions"] }); },
 });
}

export function DecisionList({ decisions, label, extras }: { decisions: readonly ReadDecision[]; label: string; /** More actions for a card (the task page adds Design first to its approve_plan card). */ extras?: ((decision: ReadDecision) => Partial<DecisionCardActions>) | undefined }) {
 const actionsFor = useDecisionActions();
 if (decisions.length === 0) return null;
 return <ol className="rv-decision-list" aria-label={label}>{decisions.map(decision => <li key={decision.card.id}><DecisionCard decision={decision} actions={{ ...actionsFor(decision), ...extras?.(decision) }} /></li>)}</ol>;
}

/** Home's "Needs you": the pending decisions as cards. Nothing shows while the server has none (or the cards are not switched on); a failed read is shown as an error. The older Home cards below still show. */
export function NeedsYou() {
 const decisions = useDecisions();
 if (decisions.isError) return <section className="rv-needs-you" aria-label="Needs you"><h2 className="rv-needs-you-title">Needs you</h2><DecisionsError error={decisions.error} retry={() => { void decisions.refetch(); }} /></section>;
 const pending = (decisions.data ?? []).filter(decision => decision.card.status === "pending");
 if (pending.length === 0) return null;
 return <section className="rv-needs-you" aria-label="Needs you"><h2 className="rv-needs-you-title">Needs you</h2><DecisionList decisions={pending} label="Decisions waiting for you" /></section>;
}

/** The decisions that are about one task, on its page. */
export function TaskDecisions({ taskId, design }: { taskId: string; /** The Design first action for this task's plan card, when the task view offers it (`designActions.designFirst`), and whether the plan may need design. */ design?: { hint: boolean; onDesignFirst(): Promise<void> } | undefined }) {
 const decisions = useDecisions();
 if (decisions.isError) return <section aria-label="Decision for this task"><DecisionsError error={decisions.error} retry={() => { void decisions.refetch(); }} /></section>;
 const mine = (decisions.data ?? []).filter(decision => decision.card.status === "pending" && decision.card.taskId === taskId);
 if (mine.length === 0) return null;
 return <section aria-label="Decision for this task"><DecisionList decisions={mine} label="Decisions for this task" extras={design === undefined ? undefined : () => ({ design })} /></section>;
}
