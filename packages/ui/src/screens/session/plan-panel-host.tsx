// OWNER DECISION 18: where the plan panel and the feedback view open on the task page. `?doc=<requirements|design|plan>` opens a document's panel (a fixed list; anything else opens nothing),
// `?view=feedback` the PR feedback view; closing removes the parameter. Both are lazy chunks, so the task page's first load does not carry them.
import { lazy, Suspense, useCallback, type ReactNode } from "react";
import { useSearchParams } from "react-router";
import { useDecisions } from "../../api/decisions.js";
import { FEEDBACK_VIEW, isPanelDocument, panelDocumentOfCard, type PanelDocument } from "./panel-docs.js";

const PlanPanel = lazy(() => import("./PlanPanel.js"));
const FeedbackView = lazy(() => import("./FeedbackView.js"));

/** The document open in the panel (validated against the fixed list), and how to open or close it, keeping the page's other parameters. */
export function usePanelDocument(): { open: PanelDocument | undefined; feedback: boolean; show(document: PanelDocument): void; showFeedback(): void; close(): void } {
 const [params, setParams] = useSearchParams();
 const raw = params.get("doc"), open = isPanelDocument(raw) ? raw : undefined;
 const change = useCallback((edit: (next: URLSearchParams) => void) => setParams(current => { const next = new URLSearchParams(current);edit(next);return next; }, { replace: true, preventScrollReset: true }), [setParams]);
 return {
  open, feedback: params.get(FEEDBACK_VIEW.param) === FEEDBACK_VIEW.value,
  show: document => change(next => { next.set("doc", document);next.delete(FEEDBACK_VIEW.param); }),
  showFeedback: () => change(next => { next.set(FEEDBACK_VIEW.param, FEEDBACK_VIEW.value);next.delete("doc"); }),
  close: () => change(next => { next.delete("doc");next.delete(FEEDBACK_VIEW.param); }),
 };
}

/** The panel for one document; `footer` is a decision card's own Approve and Request changes. */
export function PlanPanelSlot({ taskId, document, footer, onClose }: { taskId: string; document: PanelDocument; footer?: ReactNode; onClose(): void }) {
 return <Suspense fallback={null}><PlanPanel taskId={taskId} document={document} footer={footer} onClose={onClose} /></Suspense>;
}

/**
 * The panel when no decision card on this page decides the open document (the card opens it itself, with its own Approve pinned at the bottom), and the feedback view. A document nobody waits on
 * here reads and discusses only.
 */
export function PlanPanelHost({ taskId }: { taskId: string }) {
 const panel = usePanelDocument(), decisions = useDecisions();
 const claimed = panel.open !== undefined && (decisions.data ?? []).some(decision => decision.card.status === "pending" && decision.card.taskId === taskId
  && (panelDocumentOfCard(decision.card.kind) === panel.open || (decision.tabs !== undefined && panelDocumentOfCard(decision.card.kind, "design") === panel.open)));
 return <>
  {panel.open !== undefined && !decisions.isPending && !claimed && <PlanPanelSlot taskId={taskId} document={panel.open} onClose={panel.close} />}
  {panel.feedback && <Suspense fallback={null}><FeedbackView taskId={taskId} onClose={panel.close} /></Suspense>}
 </>;
}
