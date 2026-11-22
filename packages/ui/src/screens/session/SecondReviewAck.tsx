import { useTaskPagePolicy } from "./task-page-policy.js";
import { useAppHost } from "../../host.js";
import { useTaskAction } from "../../api/task-action.js";
import { createSecondReviewApi } from "../../api/second-review.js";
import { sessionWriteHost } from "../../api/session-safety.js";
import { createTaskSessionApi } from "../../api/sessions.js";
import { TaskActionNotice } from "./TaskActionNotice.js";
import { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ApiError } from "../../api/errors.js";
import { Button } from "../../design/Button.js";
import { VisibleText } from "../../design/VisibleText.js";

const WORDS = { ASK: "The task owner is asked to acknowledge this before the pull request is merged.", BUTTON: "I've seen it", DONE: "Noted. The pull request can be merged.", FAILED: "That didn't work. Try again.", STALE: "The code changed. The page now shows the current state." } as const;

/**
 * The task owner's "I've seen it" for "Second review did not run" (the merge gate; lane cr-settings). The server decides who may (the task's owner, from a browser session) and what a refusal says; the button is
 * offered only when the view says the viewer can acknowledge, sends once, and reads the task again.
 */
export function SecondReviewAck({ taskId, candidateDigest, sessionId, canAcknowledge }: { taskId: string; candidateDigest: string; sessionId: string; canAcknowledge: boolean }) {
 const page = useTaskPagePolicy();
 const host = useAppHost(), api = createSecondReviewApi(sessionWriteHost(host)), action = useTaskAction(host, "second-review:" + taskId, canAcknowledge), query = useQueryClient(), sending = useRef(false);
 const [busy, setBusy] = useState(false), [message, setMessage] = useState<{ kind: "status" | "alert"; text: string }>();
 if (page !== undefined || !canAcknowledge) return <p className="rv-muted">{WORDS.ASK}</p>;
 async function acknowledge() {
  if (action.locked || sending.current) return;
  sending.current = true;setBusy(true);setMessage(undefined);
  try {
   await action.run("acknowledge", { requestId: crypto.randomUUID(), taskId, candidateDigest }, body => api.acknowledge(String(body["taskId"]), String(body["candidateDigest"])));
   setMessage({ kind: "status", text: WORDS.DONE });
   await query.invalidateQueries({ queryKey: ["session", sessionId] });
  } catch (error) {
   if (error instanceof ApiError && error.code === "IDEMPOTENCY_CONFLICT") { await query.invalidateQueries({ queryKey: ["session", sessionId] });setMessage({ kind: "alert", text: WORDS.STALE }); }
   else setMessage({ kind: "alert", text: error instanceof ApiError ? error.message : WORDS.FAILED });
  } finally { sending.current = false;setBusy(false); }
 }
 return <div className="rv-second-review-ack"><p className="rv-muted">{WORDS.ASK}</p><Button variant="primary" busy={busy} disabled={action.locked} onClick={() => { void acknowledge(); }}>{WORDS.BUTTON}</Button>
  <TaskActionNotice key={action.pendingKey} pending={action.pending} recovery={action.recovery} taskHref={"/app/sessions/" + encodeURIComponent(sessionId)} check={() => createTaskSessionApi(host).read(sessionId)} />
  <p role="status">{message?.kind === "status" ? message.text : ""}</p>{message?.kind === "alert" && <p role="alert"><VisibleText text={message.text} /></p>}</div>;
}
