import { useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useAppHost } from "../../host.js";
import { createDecisionsApi, useDecisions, type ReadDecision } from "../../api/decisions.js";
import { DecisionCard } from "../../design/DecisionCard.js";
import { ApiError } from "../../api/errors.js";
import { Button } from "../../design/Button.js";
import { VisibleText } from "../../design/VisibleText.js";

/** The decisions could not be read: said plainly, with a way to try again. The older Home cards below still show. */
function DecisionsError({ error, retry }: { error: unknown; retry: () => void }) {
 return <div className="rv-home-error" role="alert"><p><VisibleText text={error instanceof ApiError ? error.message : "Couldn't load your decisions. Try again."} /></p><Button onClick={retry}>Try again</Button></div>;
}

/** The actions a decision card calls, each followed by a refresh of the cards and of Home. */
export function useDecisionActions() {
 const host = useAppHost(), query = useQueryClient(), api = useMemo(() => createDecisionsApi(host), [host]);
 const refresh = async () => { await Promise.all([query.invalidateQueries({ queryKey: ["decisions"] }), query.invalidateQueries({ queryKey: ["home"] })]); };
 return (decision: ReadDecision) => ({
  onOpenEvidence: async (tab?: Parameters<typeof api.evidenceOpened>[1]) => { await api.evidenceOpened(decision, tab); },
  onApprove: async (tab?: Parameters<typeof api.approve>[1]) => { const result = await api.approve(decision, tab);await refresh();return result; },
  onReject: async (reason: Parameters<typeof api.reject>[1]) => { const result = await api.reject(decision, reason);await refresh();return result; },
  onStale: () => { void query.invalidateQueries({ queryKey: ["decisions"] }); },
 });
}

export function DecisionList({ decisions, label }: { decisions: readonly ReadDecision[]; label: string }) {
 const actionsFor = useDecisionActions();
 if (decisions.length === 0) return null;
 return <ol className="rv-decision-list" aria-label={label}>{decisions.map(decision => <li key={decision.card.id}><DecisionCard decision={decision} actions={actionsFor(decision)} /></li>)}</ol>;
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
export function TaskDecisions({ taskId }: { taskId: string }) {
 const decisions = useDecisions();
 if (decisions.isError) return <section aria-label="Decision for this task"><DecisionsError error={decisions.error} retry={() => { void decisions.refetch(); }} /></section>;
 const mine = (decisions.data ?? []).filter(decision => decision.card.status === "pending" && decision.card.taskId === taskId);
 if (mine.length === 0) return null;
 return <section aria-label="Decision for this task"><DecisionList decisions={mine} label="Decisions for this task" /></section>;
}
