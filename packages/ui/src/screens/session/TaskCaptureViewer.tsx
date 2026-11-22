import { EvidenceArtifactExpiryView, type EvidenceArtifactLink } from "./EvidenceArtifactExpiryView.js";
import { visibleText } from "../../design/VisibleText.js";
import { HeldState } from "../../design/HeldState.js";
import { Button } from "../../design/Button.js";
import "./task-capture-view.css";

export interface TaskCaptureViewItem {
 captureId: string;
 side: "before" | "after";
 pageLabel: string;
 viewportLabel: string;
 href?: string | undefined;
 alt: string;
 artifact?: EvidenceArtifactLink;
}

/** The task page supplies authorized links and owns selection, navigation, and return state. */
export interface TaskCaptureViewerProps {
 captures: readonly TaskCaptureViewItem[];
 selectedCaptureId: string;
 evidenceHead?: string | undefined;
 onSelectCapture: (captureId: string) => void;
 onClose: () => void;
}

export function TaskCaptureViewer({ captures, selectedCaptureId, evidenceHead, onSelectCapture, onClose }: TaskCaptureViewerProps) {
 const selected = captures.find(capture => capture.captureId === selectedCaptureId);
 const sides = [...new Set(captures.map(capture => capture.side))];
 const viewports = [...new Set(captures.map(capture => capture.viewportLabel))];

 return <section className="rv-task-capture-viewer" aria-label="Screenshot viewer">
  <header className="rv-task-capture-header">
   <button type="button" className="rv-button rv-button-quiet" onClick={onClose}><svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"><path d="m15 5-7 7 7 7" /></svg><span>Back to the screenshots</span></button>
   {selected && <h2 className="rv-visually-hidden">{visibleText(selected.pageLabel)} · {selected.side} · {visibleText(selected.viewportLabel)}</h2>}
  </header>
  {selected && <div className="rv-task-capture-progress"><span>Read by you</span><HeldState /></div>}
  {selected && <div className="rv-task-capture-lead"><h3>{visibleText(selected.pageLabel)} · {selected.side === "before" ? "before" : "after"}</h3><p className="rv-muted">A screenshot Rovara recorded of this page{evidenceHead ? " for the version it checked" : ""}. It shows how the page looked; it does not by itself show that the page works.</p></div>}
  {evidenceHead && <p className="rv-muted rv-task-capture-context">Evidence candidate {visibleText(evidenceHead)}</p>}
  {selected ? <>
   <div className="rv-task-capture-controls">
    {sides.length > 1 && <div className="rv-task-capture-options" role="group" aria-label="Which capture">
     {sides.map(side => {
      const choice = captures.find(capture => capture.side === side && capture.viewportLabel === selected.viewportLabel) ?? captures.find(capture => capture.side === side);
      return choice && <button key={side} type="button" className="rv-button rv-task-capture-option" aria-pressed={selected.side === side} onClick={() => onSelectCapture(choice.captureId)}>{side === "before" ? "Before" : "After"}</button>;
     })}
    </div>}
    {viewports.length > 1 && <div className="rv-task-capture-options" role="group" aria-label="Viewport">
     {viewports.map(viewport => {
      const choice = captures.find(capture => capture.side === selected.side && capture.viewportLabel === viewport) ?? captures.find(capture => capture.viewportLabel === viewport);
      return choice && <button key={viewport} type="button" className="rv-button rv-task-capture-option" aria-pressed={selected.viewportLabel === viewport} onClick={() => onSelectCapture(choice.captureId)}>{visibleText(viewport)}</button>;
     })}
    </div>}
    <p className="rv-muted rv-task-capture-position">{visibleText(selected.viewportLabel)}</p>
   </div>
   {selected.href ? <figure className="rv-task-capture-image">
    <img src={selected.href} alt={selected.alt} />
   </figure> : <section className="rv-task-capture-missing" aria-label="Capture unavailable">
    <p>Capture unavailable · advisory</p>
    <EvidenceArtifactExpiryView link={selected.artifact?.state === "available" ? undefined : selected.artifact} prefix={selected.pageLabel + " · " + selected.side} />
    <p className="rv-muted">This does not show that the page failed.</p>
   </section>}
  </> : <section className="rv-task-capture-missing" aria-label="Capture unavailable"><p>Capture unavailable · advisory</p></section>}
  {selected && <p className="rv-muted rv-task-capture-source">Source: recorded capture of <strong>{visibleText(selected.pageLabel)}</strong>{evidenceHead ? <> at version <code>{visibleText(evidenceHead).slice(0, 7)}</code></> : null}.</p>}
  {selected && <div className="rv-task-capture-bar"><Button variant="primary" disabled>Mark as read</Button><p className="rv-muted">Marking items as read is not available yet. It would approve nothing.</p></div>}
 </section>;
}
