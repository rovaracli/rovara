import { Button } from "../../design/Button.js";
import { VisibleText } from "../../design/VisibleText.js";

export interface TalkCommentEditRecoveryViewProps {
  state: "conflict" | "missing" | "reload-failed";
  messageId: string;
  draft: string;
  onReload: () => void;
  onCopyDraft: (draft: string) => void;
}

const states = {
  conflict: {
    description: "The comment could not be changed. Your edit is still on this page. Load the current comment before saving again.",
    action: "Load current comment",
    actionKind: "reload",
  },
  missing: {
    description: "This comment is no longer available to edit. Your draft is still on this page. Copy your draft.",
    action: "Copy your draft",
    actionKind: "copy",
  },
  "reload-failed": {
    description: "The current comment could not be loaded. Your draft is still on this page. Reload the comment.",
    action: "Reload the comment",
    actionKind: "reload",
  },
} as const;

/** Presentation for parent-owned, already-verified comment recovery state. */
export function TalkCommentEditRecoveryView({ state, messageId, draft, onReload, onCopyDraft }: TalkCommentEditRecoveryViewProps) {
  const current = states[state];
  return <section className="rv-early-signal" data-message-id={messageId} aria-label="Comment edit recovery" role="alert">
    <p>{current.description}</p>
    <p className="rv-muted">Your draft</p>
    <p><VisibleText text={draft} /></p>
    <div className="rv-task-controls">
      {current.actionKind === "reload"
        ? <Button variant="quiet" onClick={onReload}>{current.action}</Button>
        : <Button variant="quiet" onClick={() => onCopyDraft(draft)}>{current.action}</Button>}
    </div>
  </section>;
}
