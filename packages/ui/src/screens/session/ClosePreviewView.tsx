import type { TaskClosePreview } from "@agentx/contracts/web";
import { VisibleText } from "../../design/VisibleText.js";
import { CLOSE_PREVIEW_STATUS_WORDS, CLOSE_PREVIEW_WORKSPACE_WORDS, reasonWords } from "./close-preview.js";
import "./close-preview.css";

/**
 * What closing will keep, free and discard, exactly as Code's preview read says it (DEC 254zzz347/367). Facts only: the buttons, the guarded send
 * and the digest binding live in CloseTaskDialog. Findings are listed only from the preview that will be bound.
 */
export function ClosePreviewView({ preview, discard }: { preview: TaskClosePreview; discard: boolean }) {
 return <section className="rv-close-preview" aria-label="Close preview" data-action={preview.action}>
  <dl className="rv-close-facts">
   <div><dt>Task</dt><dd>{CLOSE_PREVIEW_STATUS_WORDS[preview.taskStatus]}</dd></div>
   <div><dt>Workspace</dt><dd>{CLOSE_PREVIEW_WORKSPACE_WORDS[preview.workspace.status]}</dd></div>
  </dl>
  <div className="rv-close-group" data-tone="keep"><h3>Stays</h3><p>Work that was published stays where it is: pull requests and pushed branches.</p></div>
  <div className="rv-close-group" data-tone="free"><h3>Freed</h3><p>The task's workspace and its place in your open-task limit.</p></div>
  {discard
   ? <div className="rv-close-group" data-tone="discard"><h3>Discarded</h3>
    <p>This work was never published. It is deleted when you close the task, and it cannot be recovered.</p>
    <ul aria-label="Unpublished work">{preview.unpublished.map(entry => <li key={entry.repository}><strong><VisibleText text={entry.repository} /></strong>: <VisibleText text={reasonWords(entry.reasons)} /></li>)}</ul></div>
   : <div className="rv-close-group" data-tone="keep"><h3>Discarded</h3><p>Nothing. No unpublished work was found in this workspace.</p></div>}
 </section>;
}
