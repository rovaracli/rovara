import { useState } from "react";
import { useAppHost } from "../../host.js";
import { createSessionApi } from "../../api/sessions.js";
import { ApiError } from "../../api/errors.js";
import { Button } from "../../design/Button.js";
import { TextArea } from "../../design/TextArea.js";
import { VisibleText } from "../../design/VisibleText.js";
import { RUN } from "../setup-tab/setup-tab-text.js";

const problem = (error: unknown, fallback: string): { message: string } => (error instanceof ApiError ? { message: error.message } : { message: fallback });

/** Tells the running agent how to set things up (the Live wall's steer message: it steers the method and never the limits, the websites, the files or the sandbox). Only when the run has a session. */
export function SteerBox({ sessionId }: { sessionId: string }) {
  const host = useAppHost();
  const [text, setText] = useState(""), [busy, setBusy] = useState(false), [sent, setSent] = useState(false), [error, setError] = useState<string>();
  async function send() {
    setBusy(true); setError(undefined); setSent(false);
    try { await createSessionApi(host).sendMessage(sessionId, { kind: "steer", text: text.trim() }); setText(""); setSent(true); } catch (caught) { setError(problem(caught, "Couldn't send that. Try again.").message); } finally { setBusy(false); }
  }
  return <section aria-label="Steer the run">
    <TextArea label={RUN.steerLabel} hint={RUN.steerHint} value={text} onChange={event => { setText(event.target.value); setSent(false); }} maxLength={2000} />
    <Button busy={busy} disabled={text.trim() === ""} onClick={() => { void send(); }}>{RUN.steerSend}</Button>
    {sent && <p role="status">{RUN.steerSent}</p>}
    {error !== undefined && <p role="alert"><VisibleText text={error} /></p>}
  </section>;
}
