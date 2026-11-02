import { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ApiError } from "../../api/errors.js";
import { useSecondReviewApi } from "../../api/second-review.js";
import { Button } from "../../design/Button.js";
import { VisibleText } from "../../design/VisibleText.js";

const WORDS = { ASK: "The task owner is asked to acknowledge this before the pull request is merged.", BUTTON: "I've seen it", DONE: "Noted. The pull request can be merged.", FAILED: "That didn't work. Try again.", STALE: "The code changed. The page now shows the current state." } as const;

/**
 * The task owner's "I've seen it" for "Second review did not run" (the merge gate; lane cr-settings). The server decides who may (the task's owner, from a browser session) and what a refusal says; the button is
 * offered only when the view says the viewer can acknowledge, sends once, and reads the task again.
 */
export function SecondReviewAck({ taskId, candidateDigest, sessionId, canAcknowledge }: { taskId: string; candidateDigest: string; sessionId: string; canAcknowledge: boolean }) {
 const api = useSecondReviewApi(), query = useQueryClient(), sending = useRef(false);
 const [busy, setBusy] = useState(false), [message, setMessage] = useState<{ kind: "status" | "alert"; text: string }>();
 if (!canAcknowledge) return <p className="rv-muted">{WORDS.ASK}</p>;
 async function acknowledge() {
  if (sending.current) return;
  sending.current = true;setBusy(true);setMessage(undefined);
  try {
   await api.acknowledge(taskId, candidateDigest);
   setMessage({ kind: "status", text: WORDS.DONE });
   await query.invalidateQueries({ queryKey: ["session", sessionId] });
  } catch (error) {
   if (error instanceof ApiError && error.code === "IDEMPOTENCY_CONFLICT") { await query.invalidateQueries({ queryKey: ["session", sessionId] });setMessage({ kind: "alert", text: WORDS.STALE }); }
   else setMessage({ kind: "alert", text: error instanceof ApiError ? error.message : WORDS.FAILED });
  } finally { sending.current = false;setBusy(false); }
 }
 return <div className="rv-second-review-ack"><p className="rv-muted">{WORDS.ASK}</p><Button variant="primary" busy={busy} onClick={() => { void acknowledge(); }}>{WORDS.BUTTON}</Button>
  <p role="status">{message?.kind === "status" ? message.text : ""}</p>{message?.kind === "alert" && <p role="alert"><VisibleText text={message.text} /></p>}</div>;
}
