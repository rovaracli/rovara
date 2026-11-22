import { useState } from "react";
import { Button } from "../../design/Button.js";
import { Dialog } from "../../design/Dialog.js";
import { VisibleText } from "../../design/VisibleText.js";
import { EvidenceArtifactExpiryView, type EvidenceArtifactLink } from "./EvidenceArtifactExpiryView.js";
import { TaskCaptureViewer, type TaskCaptureViewItem } from "./TaskCaptureViewer.js";
export type { TaskCaptureViewItem } from "./TaskCaptureViewer.js";

/** Retain the exact served artifact, including expiry/withholding, independently of its usable URL. */
export function taskCaptureViewItems<T extends EvidenceArtifactLink>(scenarios: readonly { scenarioId: string; strip: { before: readonly T[]; after: readonly T[] } }[], hrefFor: (link: T) => string | undefined): TaskCaptureViewItem[] {
 return scenarios.flatMap(scenario => (["before", "after"] as const).flatMap(side => scenario.strip[side].map((link, index) => {
  const href = hrefFor(link);
  return {
   captureId: `${scenario.scenarioId}:${side}:${link.sha256}:${index}`,
   side,
   pageLabel: scenario.strip[side].length > 1 ? `${scenario.scenarioId}, screenshot ${index + 1}` : scenario.scenarioId,
   viewportLabel: "Recorded capture",
   artifact: link,
   ...(href === undefined ? {} : { href }),
   alt: `${scenario.scenarioId}, ${side} screenshot${scenario.strip[side].length > 1 ? ` ${index + 1}` : ""}`,
  };
 })));
}

/** The page retains only the selected identity; authorized media URLs always come from the current read. */
export function EvidenceCaptureSelection({ captures, initialSelectionId, evidenceHead, onSelectionChange }: {
 captures: readonly TaskCaptureViewItem[];
 initialSelectionId?: string | undefined;
 evidenceHead?: string | undefined;
 onSelectionChange?: (captureId: string) => void;
}) {
 const [selectedId, setSelectedId] = useState(initialSelectionId), [open, setOpen] = useState(false);
 const selected = captures.find(capture => capture.captureId === selectedId) ?? captures.find(capture => capture.side === "after") ?? captures[0];
 function select(captureId: string) { setSelectedId(captureId);onSelectionChange?.(captureId); }
 if (captures.length === 0) return <p>No screenshot capture was returned. This does not show that the page failed.</p>;
 return <section aria-label="Screenshot captures" className="rv-evidence-captures">
  <h4>Screenshots</h4>
  <div role="group" aria-label="Choose a screenshot">
   {captures.map(capture => <Button key={capture.captureId} variant="quiet" aria-pressed={selected?.captureId === capture.captureId} onClick={() => select(capture.captureId)}>
    <VisibleText text={capture.pageLabel + " · " + capture.side + (capture.href === undefined ? " · unavailable" : "")} />
   </Button>)}
  </div>
  {selected && <>
   <figure aria-label="Selected screenshot">
    {selected.href ? <img src={selected.href} alt={selected.alt} /> : <EvidenceArtifactExpiryView link={selected.artifact?.state === "available" ? undefined : selected.artifact} prefix={selected.pageLabel + " · " + selected.side} />}
    {selected.href && <figcaption><VisibleText text={selected.pageLabel + " · " + selected.side} /></figcaption>}
   </figure>
   <Dialog title={"Evidence " + String(captures.findIndex(capture => capture.captureId === selected.captureId) + 1) + " of " + String(captures.length) + ": " + selected.pageLabel + " · " + selected.side} description={evidenceHead === undefined ? "Recorded capture" : "Version " + evidenceHead.slice(0, 7)} className="rv-task-capture-dialog" open={open} onOpenChange={setOpen} trigger={<Button>Open selected screenshot</Button>}>
    <TaskCaptureViewer captures={captures} selectedCaptureId={selected.captureId} evidenceHead={evidenceHead} onSelectCapture={select} onClose={() => setOpen(false)} />
   </Dialog>
  </>}
 </section>;
}
