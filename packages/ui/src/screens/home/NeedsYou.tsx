import { useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useAppHost } from "../../host.js";
import { createDecisionsApi, decisionAuthorityRefused, issueDecisionRead, readDecisions, recordDecisionRead, recordDecisionReadFailure, recordIdentityReadFailure, rememberDecisionIdentity, useDecisions, type DecisionApprovalIdentity, type ReadDecision } from "../../api/decisions.js";
import { AppMeResponseReaderSchema, DecisionCardsViewReaderSchema } from "@agentx/contracts/web";
import { createApiClient } from "../../api/client.js";
import { DecisionCard, type DecisionCardActions } from "../../design/DecisionCard.js";
import { createDesignReviewApi } from "../../api/design-review.js";
import { isCsrfFailure } from "../../safe-action.js";
import { ApiError } from "../../api/errors.js";
import { Link } from "react-router";
import { Button } from "../../design/Button.js";
import { EmptyState } from "../../design/EmptyState.js";
import { VisibleText } from "../../design/VisibleText.js";
import { useWorkTasks } from "../../api/work.js";
import { tasksAsking } from "./HomeQuestions.js";

/** The decisions could not be read: said plainly, with a way to try again. The older Home cards below still show. */
function DecisionsError({ error, retry, showRetry = true }: { error: unknown; retry: () => void; showRetry?: boolean }) {
 return <div className="rv-home-error" role="alert"><p><VisibleText text={error instanceof ApiError ? error.message : "Couldn't load your decisions. Try again."} /></p>{showRetry && <Button onClick={retry}>Try again</Button>}</div>;
}

/** The actions a decision card calls, each followed by a refresh of the cards and of Home. */
export function useDecisionActions() {
 const host = useAppHost(), query = useQueryClient(), api = useMemo(() => createDecisionsApi(host), [host]), reads = useMemo(() => createApiClient(host), [host]), designApi = useMemo(() => createDesignReviewApi(host), [host]);
 const freshApproval = async (decision: ReadDecision) => {
  let identity: DecisionApprovalIdentity;
  try { const me = await reads.get("/v1/app/me", AppMeResponseReaderSchema);identity = { orgId: me.org.orgId, developerId: me.developer.id };rememberDecisionIdentity(host, identity); }
  catch (failure) { recordIdentityReadFailure(host, failure);throw failure; }
  const sequence = issueDecisionRead();
  try {
   const items = readDecisions(await reads.get("/v1/app/decisions", DecisionCardsViewReaderSchema));
   recordDecisionRead(identity, sequence, items);
   const current = items.find(card => card.card.id === decision.card.id);
   if (current === undefined || current.card.status !== "pending" || current.digest !== decision.digest) throw new ApiError(409, "CHANGE_STALE", "This decision is no longer current. Reload before deciding.");
   return { decision: current, identity, sequence };
  } catch (failure) {
   if (!(failure instanceof ApiError && failure.code === "CHANGE_STALE")) recordDecisionReadFailure(identity, sequence, failure instanceof ApiError && (failure.status === 401 || failure.status === 403));
   throw failure;
  }
 };
 const refresh = () => { void Promise.all([query.invalidateQueries({ queryKey: ["decisions"] }), query.invalidateQueries({ queryKey: ["home"] })]).catch(() => undefined); };
 return (decision: ReadDecision) => ({
  onOpenEvidence: async (tab?: Parameters<typeof api.evidenceOpened>[1]) => { await api.evidenceOpened(decision, tab); },
  onApprove: async (tab?: Parameters<typeof api.approve>[1], reason?: string, extras?: Parameters<typeof api.approve>[3]) => { const latest = await freshApproval(decision);try { const result = await api.approve(decision, tab, reason, extras, latest.identity, latest.sequence);refresh();return result; } catch (failure) { if (isCsrfFailure(failure)) { try { await reads.get("/v1/app/me", AppMeResponseReaderSchema); } catch (identityFailure) { recordIdentityReadFailure(host, identityFailure);throw new ApiError(403, "IDENTITY_UNREAD", "Couldn't confirm your identity. Decision controls are unavailable until it can be read."); } }throw failure; } },
  onAuthorityRefused: () => decisionAuthorityRefused(host, decision),
  onCheckApproval: async () => { const me = await reads.get("/v1/app/me", AppMeResponseReaderSchema);const result = await api.checkApproval(decision, { orgId: me.org.orgId, developerId: me.developer.id });refresh();return result; },
  onHasUnknownApproval: async () => { const me = await reads.get("/v1/app/me", AppMeResponseReaderSchema);return api.hasUnknownApproval(decision, { orgId: me.org.orgId, developerId: me.developer.id }); },
  onApprovalStorageChange: async (key: string) => { const me = await reads.get("/v1/app/me", AppMeResponseReaderSchema), identity = { orgId: me.org.orgId, developerId: me.developer.id };const expected = `rv:decision-approval:${identity.orgId}:${identity.developerId}:${decision.card.id}`;return key === expected ? api.hasUnknownApproval(decision, identity) : undefined; },
  onRequestChanges: async (reason: string, includedCommentIds?: readonly string[]) => { await freshApproval(decision);const result = await api.requestChanges(decision, reason, includedCommentIds);refresh();return result; },
  // A choice on a design review's cost card: the card's own action, through the design review route (the broker re-checks who may choose it).
  onChoose: async (action: ReadDecision["card"]["actions"][number]) => { const latest = await freshApproval(decision);await designApi.chooseSpend(latest.decision, action, crypto.randomUUID());refresh(); },
  onReject: async (reason: Parameters<typeof api.reject>[1]) => { const latest = await freshApproval(decision);const result = await api.reject(latest.decision, reason, latest);refresh();return result; },
  onStale: () => { void query.invalidateQueries({ queryKey: ["decisions"] }); },
 });
}

export function DecisionList({ decisions, label, extras }: { decisions: readonly ReadDecision[]; label: string; /** More actions for a card (the task page adds Design first to its approve_plan card). */ extras?: ((decision: ReadDecision) => Partial<DecisionCardActions>) | undefined }) {
 const actionsFor = useDecisionActions();
 if (decisions.length === 0) return null;
 return <ol className="rv-decision-list" aria-label={label}>{decisions.map(decision => <li key={decision.card.id}><DecisionCard decision={decision} actions={{ ...actionsFor(decision), ...extras?.(decision) }} /></li>)}</ol>;
}

/** Home's "Needs you": the pending decisions as cards. Nothing shows while the server has none (or the cards are not switched on); a failed read is shown as an error. The older Home cards below still show. */
export function NeedsYou({ showRetry = true }: { showRetry?: boolean }) {
 const decisions = useDecisions();
 if (decisions.isError) return <section className="rv-needs-you" aria-label="Needs you"><h2 className="rv-needs-you-title">Needs you</h2><DecisionsError error={decisions.error} retry={() => { void decisions.refetch(); }} showRetry={showRetry} /></section>;
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

/**
 * Home's "nothing needs you" empty state, shown only once the decision cards have been read and none is pending: Home's own cards are empty, but a decision card is something that needs the person.
 * Understand's questions waiting on the person (Home's "Rovara has questions") need them too; a task list that cannot be read says nothing either way.
 */
export function NothingNeedsYou() {
 const decisions = useDecisions(), tasks = useWorkTasks();
 if (decisions.isPending || tasks.isPending || (decisions.data ?? []).some(decision => decision.card.status === "pending") || tasksAsking(tasks.data).length > 0) return null;
 return <EmptyState testId="home-empty" title="Nothing needs you right now" description="Your team's work can keep moving." action={<Link to="/app/live">See work in progress</Link>} />;
}
