// OWNER DECISION 18: where the plan panel and the feedback view open on the task page. `?doc=<requirements|design|plan>` opens a document's panel (a fixed list; anything else opens nothing),
// `?view=feedback` the PR feedback view; closing removes the parameter. Both are lazy chunks, so the task page's first load does not carry them.
import { lazy, Suspense, useCallback, useContext, useSyncExternalStore, type ReactNode } from "react";
import { useSearchParams } from "react-router";
import { QueryClientContext } from "@tanstack/react-query";
import type { ReadAppNav } from "@agentx/cloud-contracts/web";
import { useDecisions } from "../../api/decisions.js";
import { FEEDBACK_VIEW, isPanelDocument, panelDocumentOfCard, type PanelDocument } from "./panel-docs.js";

const PlanPanel = lazy(() => import("./PlanPanel.js"));
const FeedbackView = lazy(() => import("./FeedbackView.js"));

/** OWNER DECISION 18(d): the panel and the feedback view exist only while the decision cards are on (the app nav says so); with them off the task page is as it was. */
export function usePlanPanelOn(): boolean {
 // Read from the app's own nav query (never fetched here); a page drawn without a query client (a test, the desktop host's pieces) has no panel.
 const client = useContext(QueryClientContext);
 const subscribe = useCallback((changed: () => void) => (client === undefined ? () => undefined : client.getQueryCache().subscribe(changed)), [client]);
 return useSyncExternalStore(subscribe, () => client?.getQueryData<ReadAppNav>(["nav"])?.features.decisionCards === true);
}

/** The document open in the panel (validated against the fixed list), and how to open or close it, keeping the page's other parameters. */
export function usePanelDocument(): { on: boolean; open: PanelDocument | undefined; feedback: boolean; show: (document: PanelDocument) => void; showFeedback: () => void; close: () => void } {
 const [params, setParams] = useSearchParams(), on = usePlanPanelOn();
 const raw = params.get("doc"), open = on && isPanelDocument(raw) ? raw : undefined;
 const change = useCallback((edit: (next: URLSearchParams) => void) => setParams(current => { const next = new URLSearchParams(current);edit(next);return next; }, { replace: true, preventScrollReset: true }), [setParams]);
 return {
  on, open, feedback: on && params.get(FEEDBACK_VIEW.param) === FEEDBACK_VIEW.value,
  show: document => change(next => { next.set("doc", document);next.delete(FEEDBACK_VIEW.param); }),
  showFeedback: () => change(next => { next.set(FEEDBACK_VIEW.param, FEEDBACK_VIEW.value);next.delete("doc"); }),
  close: () => change(next => { next.delete("doc");next.delete(FEEDBACK_VIEW.param); }),
 };
}

/** The panel for one document; `footer` is a decision card's own Approve and Request changes. */
export function PlanPanelSlot({ taskId, document, footer, onClose, onLoaded }: { taskId: string; document: PanelDocument; footer?: ReactNode; onClose: () => void; onLoaded?: () => void }) {
 return <Suspense fallback={null}><PlanPanel taskId={taskId} document={document} footer={footer} onClose={onClose} {...(onLoaded === undefined ? {} : { onLoaded })} /></Suspense>;
}

/**
 * The panel when no decision card on this page decides the open document (the card opens it itself, with its own Approve pinned at the bottom), and the feedback view. A document nobody waits on
 * here reads and discusses only.
 */
export function PlanPanelHost({ taskId }: { taskId: string }) {
 const panel = usePanelDocument(), decisions = useDecisions();
 if (!panel.on) return null;
 const claimed = panel.open !== undefined && (decisions.data ?? []).some(decision => decision.card.status === "pending" && decision.card.taskId === taskId
  && (panelDocumentOfCard(decision.card.kind) === panel.open || (decision.tabs !== undefined && panelDocumentOfCard(decision.card.kind, "design") === panel.open)));
 return <>
  {panel.open !== undefined && !decisions.isPending && !claimed && <PlanPanelSlot taskId={taskId} document={panel.open} onClose={panel.close} />}
  {panel.feedback && <Suspense fallback={null}><FeedbackView taskId={taskId} onClose={panel.close} /></Suspense>}
 </>;
}
