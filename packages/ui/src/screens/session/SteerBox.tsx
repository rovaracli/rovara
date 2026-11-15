import { useRef, useState } from "react";
import { ApiError } from "../../api/errors.js";
import { Button } from "../../design/Button.js";
import { VisibleText } from "../../design/VisibleText.js";

/** What the build step needs to steer the running task: how to send, or why it cannot. */
export type Steer = { kind: "send"; send: (text: string) => Promise<void> } | { kind: "unavailable"; why: string };

/**
 * The steer box under the task that is running (Hybrid 1): one line to the agent, sent as a steering message on the task's session. A route Cloud or Code does not
 * serve says so in its own words, with the draft kept; nothing is retried. A task that has no Cloud session says steering is not connected to it yet.
 */
export function SteerBox({ steer, label }: { steer: Steer; label: string }) {
 const [text, setText] = useState(""), [busy, setBusy] = useState(false), [error, setError] = useState<string>(), [sent, setSent] = useState(false), pending = useRef(false);
 if (steer.kind === "unavailable") return <p className="rv-muted rv-steer-note" data-testid="steer-unavailable"><VisibleText text={steer.why} /></p>;
 const valid = text.trim().length > 0 && text.length <= 2000, deliver = steer.send;
 async function submit() {
  if (!valid || pending.current) return;
  pending.current = true;setBusy(true);setError(undefined);setSent(false);
  try { await deliver(text.trim());setText("");setSent(true); }
  catch (failure) { setError(failure instanceof ApiError ? failure.message : "Couldn't send this. Your note is still here. Try again."); }
  finally { pending.current = false;setBusy(false); }
 }
 return <form className="rv-steer" aria-label={"Steer " + label} onSubmit={event => { event.preventDefault();void submit(); }}>
  <div className="rv-steer-row"><label className="rv-visually-hidden" htmlFor={"steer-" + label}>Steer this task</label>
   <input id={"steer-" + label} className="rv-input" type="text" value={text} maxLength={2000} placeholder="Steer this task, e.g. 'use the existing ApiError helper'" onChange={event => { setText(event.target.value);setSent(false); }} />
   <Button type="submit" busy={busy} disabled={!valid}>Send</Button></div>
  {error !== undefined && <p role="alert" className="rv-error rv-steer-note" data-testid="steer-error"><VisibleText text={error} /></p>}
  {sent && <p role="status" className="rv-muted rv-steer-note">Sent.</p>}
 </form>;
}
