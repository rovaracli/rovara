import { useState } from "react";
import { useAppHost } from "../../host.js";
import { createSessionApi } from "../../api/sessions.js";
import { useSetupAgentApi } from "../../api/setup-agent.js";
import { ApiError } from "../../api/errors.js";
import { Button } from "../../design/Button.js";
import { TextArea } from "../../design/TextArea.js";
import { TextField } from "../../design/TextField.js";
import { VisibleText } from "../../design/VisibleText.js";

const problem = (error: unknown, fallback: string): { message: string; reauth: boolean } => (error instanceof ApiError ? { message: error.message, reauth: error.code === "REAUTH_REQUIRED" } : { message: fallback, reauth: false });

/** Tells the running agent how to set things up (the Live wall's steer message: it steers the method and never the limits, the websites, the files or the sandbox). Only when the run has a session. */
export function SteerBox({ sessionId }: { sessionId: string }) {
  const host = useAppHost();
  const [text, setText] = useState(""), [busy, setBusy] = useState(false), [sent, setSent] = useState(false), [error, setError] = useState<string>();
  async function send() {
    setBusy(true); setError(undefined); setSent(false);
    try { await createSessionApi(host).sendMessage(sessionId, { kind: "steer", text: text.trim() }); setText(""); setSent(true); } catch (caught) { setError(problem(caught, "Couldn't send that. Try again.").message); } finally { setBusy(false); }
  }
  return <section aria-label="Steer the run">
    <TextArea label="Tell Rovara how to set it up" hint="For example, which command builds the project. It changes how Rovara works, not its limits or the websites it may reach." value={text} onChange={event => { setText(event.target.value); setSent(false); }} maxLength={2000} />
    <Button busy={busy} disabled={text.trim() === ""} onClick={() => { void send(); }}>Send to Rovara</Button>
    {sent && <p role="status">Sent. Rovara reads it before its next step.</p>}
    {error !== undefined && <p role="alert"><VisibleText text={error} /></p>}
  </section>;
}

/** Runs one command of the person's own in the run's sandbox. A command needs a signed-in browser whose sign-in is fresh; the server decides, this page only asks. */
export function CommandBox({ project, onRan }: { project: string; onRan: () => void }) {
  const api = useSetupAgentApi();
  const [command, setCommand] = useState(""), [busy, setBusy] = useState(false), [queued, setQueued] = useState(false), [error, setError] = useState<{ message: string; reauth: boolean }>(), [requestId, setRequestId] = useState(() => crypto.randomUUID());
  async function run() {
    setBusy(true); setError(undefined); setQueued(false);
    try { await api.command(project, requestId, command.trim()); setCommand(""); setRequestId(crypto.randomUUID()); setQueued(true); onRan(); } catch (caught) { setError(problem(caught, "Couldn't run that. Try again.")); } finally { setBusy(false); }
  }
  return <section aria-label="Run a command">
    <TextField label="Run a command in the sandbox" hint="One line, no secrets. It runs in the same throw-away sandbox as Rovara's, and Rovara is told what it printed." value={command} onChange={event => { setCommand(event.target.value); setRequestId(crypto.randomUUID()); }} maxLength={1000} />
    <Button busy={busy} disabled={command.trim() === ""} onClick={() => { void run(); }}>Run</Button>
    {queued && <p role="status">Queued. It appears in the list below when it has run.</p>}
    {error !== undefined && <p role="alert"><VisibleText text={error.message} />{error.reauth && " Sign in again, then press Run."}</p>}
  </section>;
}
