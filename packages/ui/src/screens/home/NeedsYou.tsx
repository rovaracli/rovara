import { useMemo } from "react";
import { useSearchParams } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { DECISION_FOCUS_PARAM } from "@agentx/contracts/web";
import { useAppHost } from "../../host.js";
import { HIGH_ON_CARD_KINDS, createDecisionsApi, isUnreviewedDesign, useDecisions, type PlanDecisionFields, type ReadDecision } from "../../api/decisions.js";
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
  onApprove: async (tab?: Parameters<typeof api.approve>[1], reason?: string, acknowledgedRunLimitUsd?: number, plan?: PlanDecisionFields) => { const result = await api.approve(decision, tab, reason, acknowledgedRunLimitUsd, plan);await refresh();return result; },
  // Slice 2: Request changes on a document's card; the task is read again too (its step moved). OWNER DECISION 7: with the review comments the person kept ticked.
  onRequestChanges: async (reason: string, includedCommentIds?: string[]) => { const result = await api.requestChanges(decision, reason, includedCommentIds);await Promise.all([refresh(), query.invalidateQueries({ queryKey: ["session"] })]);return result; },
  // A choice on a design review's cost card: the card's own action, through the design review route (the broker re-checks who may choose it).
  onChoose: async (action: ReadDecision["card"]["actions"][number]) => { await designApi.chooseSpend(decision, action, crypto.randomUUID());await refresh(); },
  onReject: async (reason: Parameters<typeof api.reject>[1]) => { const result = await api.reject(decision, reason);await refresh();return result; },
  onStale: () => { void query.invalidateQueries({ queryKey: ["decisions"] }); },
 });
}

/**
 * The inline Approve of a high-risk card on its task page, then the cards, Home and the task read again. Only where the card's task is known. A design: the design review's own routes (`readApproval`,
 * `approveHighRisk`). A requirements or coding plan card (slice 2): the card's approve route, where the broker asks for the recent sign-in; only the owner sees the card, so nothing else is read first.
 */
function useInlineApprove() {
 const host = useAppHost(), query = useQueryClient(), designApi = useMemo(() => createDesignReviewApi(host), [host]), decisionsApi = useMemo(() => createDecisionsApi(host), [host]);
 const reread = () => Promise.all([query.invalidateQueries({ queryKey: ["decisions"] }), query.invalidateQueries({ queryKey: ["home"] }), query.invalidateQueries({ queryKey: ["session"] })]);
 return (decision: ReadDecision): Partial<DecisionCardActions> => {
  const taskId = decision.card.taskId;
  // Slice 3b: an outside approval is decided on its card wherever the decider reaches it (the task page, its own card page): Approve and Decline, each with the recent sign-in the broker asks for.
  if (decision.card.kind === "approve_request") return {
   highRisk: { read: async () => ({ digest: decision.digest, mayApprove: true }), approve: async (shownDigest) => { const result = await decisionsApi.approveHighOnCard(decision, shownDigest);await reread();return result; } },
   decline: async () => { await decisionsApi.declineOnCard(decision);await reread(); },
  };
  if ((HIGH_ON_CARD_KINDS.includes(decision.card.kind) || isUnreviewedDesign(decision)) && taskId !== undefined) return { highRisk: {
   read: async () => ({ digest: decision.digest, mayApprove: true }),
   approve: async (shownDigest, _reason, acknowledgedRunLimitUsd, plan) => { const result = await decisionsApi.approveHighOnCard(decision, shownDigest, acknowledgedRunLimitUsd, plan);await reread();return result; },
  } };
  if (decision.card.kind !== "approve_design" || taskId === undefined) return {};
  return { highRisk: {
   read: () => designApi.readApproval(taskId),
   approve: async (shownDigest, reason) => {
    await designApi.approveHighRisk(taskId, crypto.randomUUID(), shownDigest, reason);
    await Promise.all([query.invalidateQueries({ queryKey: ["decisions"] }), query.invalidateQueries({ queryKey: ["home"] }), query.invalidateQueries({ queryKey: ["session"] })]);
   },
  } };
 };
}

export function DecisionList({ decisions, label, extras, focus }: { decisions: readonly ReadDecision[]; label: string; /** More actions for a card (the task page adds Design first to its approve_plan card). */ extras?: ((decision: ReadDecision) => Partial<DecisionCardActions>) | undefined; /** The id of the card a link named (`?decision=`): it scrolls into view and is marked. */ focus?: string | undefined }) {
 const actionsFor = useDecisionActions();
 if (decisions.length === 0) return null;
 return <ol className="rv-decision-list" aria-label={label}>{decisions.map(decision => <li key={decision.card.id}><DecisionCard decision={decision} focused={focus === decision.card.id} actions={{ ...actionsFor(decision), ...extras?.(decision) }} /></li>)}</ol>;
}

/** Home's "Needs you": the pending decisions as cards. Nothing shows while the server has none (or the cards are not switched on); a failed read is shown as an error. The older Home cards below still show. */
export function NeedsYou() {
 const decisions = useDecisions();
 if (decisions.isError) return <section className="rv-needs-you" aria-label="Needs you"><h2 className="rv-needs-you-title">Needs you</h2><DecisionsError error={decisions.error} retry={() => { void decisions.refetch(); }} /></section>;
 const pending = (decisions.data ?? []).filter(decision => decision.card.status === "pending");
 if (pending.length === 0) return null;
 return <section className="rv-needs-you" aria-label="Needs you"><h2 className="rv-needs-you-title">Needs you</h2><DecisionList decisions={pending} label="Decisions waiting for you" /></section>;
}

/** Slice 3b: one decision on its own page (`/app/decisions/<kind>/<subject>`): the card and its evidence, nothing else, for someone who may decide it but is not on the task. */
export function SingleDecision({ cardId }: { cardId: string }) {
 const decisions = useDecisions(cardId.startsWith("approve_request:") ? cardId.slice("approve_request:".length) : undefined), inlineApprove = useInlineApprove();
 if (decisions.isError) return <section aria-label="Decision"><DecisionsError error={decisions.error} retry={() => { void decisions.refetch(); }} /></section>;
 if (decisions.isPending) return null;
 const mine = (decisions.data ?? []).filter(decision => decision.card.id === cardId && decision.card.status === "pending");
 if (mine.length === 0) return <section aria-label="Decision"><p role="status">This decision is no longer waiting for you.</p></section>;
 return <section aria-label="Decision"><DecisionList decisions={mine} label="Decision" extras={decision => inlineApprove(decision)} /></section>;
}

/** The decisions that are about one task, on its page. */
export function TaskDecisions({ taskId, design, questions }: { taskId: string; /** The Design first action for this task's plan card, when the task view offers it (`designActions.designFirst`), and whether the plan may need design. */ design?: { hint: boolean; onDesignFirst(): Promise<void> } | undefined; /** Slice 2: the design questions this task waits on, answered on their card. */ questions?: DecisionCardActions["questions"] }) {
 const decisions = useDecisions(), [params] = useSearchParams(), inlineApprove = useInlineApprove();
 if (decisions.isError) return <section aria-label="Decision for this task"><DecisionsError error={decisions.error} retry={() => { void decisions.refetch(); }} /></section>;
 const mine = (decisions.data ?? []).filter(decision => decision.card.status === "pending" && decision.card.taskId === taskId);
 if (mine.length === 0) return null;
 return <section aria-label="Decision for this task"><DecisionList decisions={mine} label="Decisions for this task" focus={params.get(DECISION_FOCUS_PARAM) ?? undefined} extras={decision => ({ ...inlineApprove(decision), ...(design === undefined ? {} : { design }), ...(questions === undefined ? {} : { questions }) })} /></section>;
}
