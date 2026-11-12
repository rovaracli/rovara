import { paths } from "../../paths.js";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import { SessionIdSchema } from "@agentx/cloud-contracts/web";
import { useAppHost } from "../../host.js";
import { createRunApi } from "../../api/runs.js";
import { ApiError } from "../../api/errors.js";
import type { SendResult } from "../../api/client.js";
import { ConfirmInBrowser } from "../../confirm/ConfirmInBrowser.js";
import { Button } from "../../design/Button.js";
import { VisibleText } from "../../design/VisibleText.js";
export function StartSessionDialog({ project, agent, onBack, onBusyChange, backLabel = "Choose another agent" }: { project: string; agent: { agentId: string; name: string; description: string }; onBack: () => void; onBusyChange: (busy: boolean) => void; backLabel?: string }) {
 const host = useAppHost(), api = useMemo(() => createRunApi(host), [host]), field = useId(), textarea = useRef<HTMLTextAreaElement>(null);
 const [text, setText] = useState(""), [busy, setBusy] = useState(false), [accepted, setAccepted] = useState(false), [error, setError] = useState<string>(), [pending, setPending] = useState<Exclude<SendResult<unknown>, { kind: "done" }>>();
 const sending = useRef(false), intent = useRef<{ text: string; requestId: string } | undefined>(undefined);
 useEffect(() => { textarea.current?.focus(); }, []);
 async function start() {
  if (sending.current || accepted || pending !== undefined || !text.trim() || text.length > 4000) return;
  sending.current = true;setBusy(true);onBusyChange(true);setError(undefined);
  if (intent.current?.text !== text) intent.current = { text, requestId: crypto.randomUUID() };
  try {
   const result = await api.startWork(agent.agentId, { project, text, requestId: intent.current.requestId });
   if (result.kind !== "done") { setPending(result);return; }
   setAccepted(true);
   // RULING Q40: a legacy accepted task can lack its session id. Never guess or submit it a second time.
   const session = SessionIdSchema.safeParse((result.value as { sessionId?: string }).sessionId ?? result.value.task.sessionId);
   if (session.success) host.navigate("/app/sessions/" + session.data);
  } catch (failure) { setError(failure instanceof ApiError ? failure.message : "Couldn't start this session. Try again."); }
  finally { sending.current = false;setBusy(false);onBusyChange(false); }
 }
 return <form onSubmit={event => { event.preventDefault();void start(); }}><p className="rv-muted"><VisibleText text={agent.description} /></p><div className="rv-field"><label htmlFor={field}>What should <VisibleText text={agent.name} /> do?</label><textarea ref={textarea} id={field} className="rv-input rv-project-problem" required maxLength={4000} value={text} onChange={event => setText(event.target.value)} disabled={busy || accepted || pending !== undefined} aria-describedby={field + "-count"} /><p id={field + "-count"} className="rv-muted">{text.length} / 4000</p></div><div className="rv-actions"><Button disabled={busy || accepted || pending !== undefined} onClick={onBack}>{backLabel}</Button><Button type="submit" variant="primary" busy={busy} disabled={accepted || pending !== undefined || !text.trim() || text.length > 4000}>Start session</Button></div>{error && <p role="alert"><VisibleText text={error} /></p>}{accepted && <p role="status">Work was accepted. <Link to={paths.work}>Open Work</Link> to find its session.</p>}{pending && <ConfirmInBrowser result={pending} subjectKey={["project", project, "overview"]} isApplied={() => false} />}</form>;
}
