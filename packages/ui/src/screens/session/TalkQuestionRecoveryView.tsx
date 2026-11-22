import type { AskStatusReaderSchema } from "@agentx/contracts/web";
import { Button } from "../../design/Button.js";
import { VisibleText } from "../../design/VisibleText.js";
import { useTaskPagePolicy } from "./task-page-policy.js";
import { TalkCard, TalkLadder } from "./TalkParts.js";

type AskRead = "current" | "unavailable" | "authority-lost";
type AskStatusRead = ReturnType<typeof AskStatusReaderSchema.parse>;

/** Recovery detail for the embedded question in Task Talk. The parent owns the read and supplies a question only while it is still readable. */
export function TalkQuestionRecoveryView({ status, read, question, onCheck, asker }: {
  /** The task page shows the question as its own message card; who asked and when (from the saved request). */
  asker?: { name: string; at: string };
  status?: AskStatusRead;
  read: AskRead;
  question?: string;
  onCheck?: () => void;
}) {
  const page = useTaskPagePolicy() !== undefined;
  if (read === "authority-lost") {
    return <div className="rv-ask-recovery" role="alert"><p className="rv-message-kind">This question is no longer available in this session.</p></div>;
  }

  if ((read === "unavailable" || status === undefined) && page && asker !== undefined) {
    return <div className="rv-ask-recovery" role="alert"><TalkCard name={asker.name} at={asker.at} kind="question" tone="bad">
      {question !== undefined && <p className="rv-message-text"><VisibleText text={question} /></p>}
      <TalkLadder steps={[{ state: "ok", label: "Saved here", detail: "your question is kept" }, { state: "pending", label: "Answered", unknown: true }]} />
      <p className="rv-talk-lead"><strong>Couldn&apos;t check whether Rovara answered this.</strong></p>
      <p className="rv-muted"><strong>What is safe:</strong> your question is kept here. A question never changes the build.</p>
      {onCheck && <div className="rv-talk-refusal"><Button variant="primary" onClick={onCheck}>Check</Button></div>}
    </TalkCard></div>;
  }

  if (read === "unavailable" || status === undefined) {
    return <div className="rv-ask-recovery" role="alert">
      <p className="rv-message-kind">Couldn't check whether Rovara answered this.</p>
      {onCheck && <Button variant="quiet" onClick={onCheck}>Check</Button>}
    </div>;
  }

  if (status.state === "failed") {
    return <div className="rv-ask-recovery" role="status">
      <p className="rv-message-kind">Rovara couldn't answer this just now.</p>
      {question !== undefined && <p className="rv-message-text"><VisibleText text={question} /></p>}
      <p className="rv-muted">A question doesn't change the work.</p>
    </div>;
  }

  if (status.state === "queued") {
    return <div className="rv-ask-recovery" role="status">
      <p className="rv-message-kind">Rovara hasn't answered this yet.</p>
      {question !== undefined && <p className="rv-message-text"><VisibleText text={question} /></p>}
      <p className="rv-muted">A question doesn't change the work.</p>
      {onCheck && <Button variant="quiet" onClick={onCheck}>Check</Button>}
    </div>;
  }

  if (status.state === "answered") {
    // Successful answers belong to the answer receipt, not this recovery notice.
    return null;
  }

  return <div className="rv-ask-recovery" role="alert">
    <p className="rv-message-kind">Couldn't check whether Rovara answered this.</p>
    {onCheck && <Button variant="quiet" onClick={onCheck}>Check</Button>}
  </div>;
}
