import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import { SessionIdSchema, type AppProjectDetail } from "@agentx/contracts/web";
import { useAppHost } from "../../../host.js";
import { createCodeApi } from "../../../api/code.js";
import { useProject } from "../../../api/projects.js";
import type { SendResult } from "../../../api/client.js";
import { ConfirmInBrowser } from "../../../confirm/ConfirmInBrowser.js";
import { Button } from "../../../design/Button.js";
import { VisibleText } from "../../../design/VisibleText.js";
import { OpenTasksToClose } from "../../project/OpenTasksToClose.js";
import { FIRST_TASK_MAX, firstTaskGate, refusalOf, suggestFirstOutcomes, type Refusal } from "./first-task.js";

/**
 * Setup ends here: pick one of the suggested first outcomes (or write your own) and start it. It goes through the existing start route (the one Home's and the project page's start box use); on success the page
 * opens the new task. A refusal shows the server's reason and what to do about it. The step says first when the environment isn't ready, with the way back, instead of letting the press fail.
 */
export function FirstTaskStep({ project, metaRepository, onBack }: { project: AppProjectDetail; metaRepository?: string | undefined; onBack: () => void }) {
 const host = useAppHost(), api = useMemo(() => createCodeApi(host), [host]), field = useId(), overview = useProject(project.name);
 const suggestions = useMemo(() => suggestFirstOutcomes(project.repositories.map(repository => repository.fullName), metaRepository), [project.repositories, metaRepository]);
 const [text, setText] = useState(""), [busy, setBusy] = useState(false), [started, setStarted] = useState<{ session?: string }>(), [refusal, setRefusal] = useState<Refusal>(), [pending, setPending] = useState<Exclude<SendResult<unknown>, { kind: "done" }>>(), [closed, setClosed] = useState(0);
 const sending = useRef(false), intent = useRef<{ text: string; requestId: string } | undefined>(undefined), alive = useRef(true);
 useEffect(() => { alive.current = true;return () => { alive.current = false; }; }, []);
 const gate = firstTaskGate(project.setup.status), tooLong = text.length > FIRST_TASK_MAX, cannot = overview.data !== undefined && overview.data.you.canStartWork !== true;
 const locked = busy || started !== undefined || pending !== undefined, blocked = locked || !gate.ok || cannot || !text.trim() || tooLong;
 async function start() {
  if (sending.current || blocked) return;
  sending.current = true;setBusy(true);setRefusal(undefined);
  // A retry of the same text reuses its request id, so a lost answer never starts the task twice.
  if (intent.current?.text !== text) intent.current = { text, requestId: crypto.randomUUID() };
  try {
   const result = await api.startCode(project.name, text, intent.current.requestId);
   if (!alive.current) return;
   if (result.kind !== "done") { setPending(result);return; }
   const session = SessionIdSchema.safeParse(result.value.sessionId);
   setStarted(session.success ? { session: session.data } : {});
   if (session.success) host.navigate("/app/sessions/" + session.data);
  } catch (failure) { if (alive.current) setRefusal(refusalOf(failure)); }
  finally { sending.current = false;if (alive.current) setBusy(false); }
 }
 return <>
  <h2>Start the first task</h2>
  <p>Pick a first outcome, or describe your own. Starting it ends setup, and you land on the task page.</p>
  {!gate.ok && <div role="note" className="rv-psv2-gate"><p><strong>Not ready to start.</strong> <VisibleText text={gate.reason} /></p><Button onClick={onBack}>Go to the environment check</Button></div>}
  {cannot && <p role="note">You can't start work in this project. Ask one of its maintainers.</p>}
  {suggestions.length > 0 && <fieldset className="rv-psv2-suggest" disabled={locked}><legend>Suggested first outcomes</legend><ul>{suggestions.map(suggestion => <li key={suggestion}><button type="button" className="rv-button rv-psv2-suggestion" aria-pressed={text === suggestion} onClick={() => { setText(suggestion);setRefusal(undefined); }}><VisibleText text={suggestion} /></button></li>)}</ul></fieldset>}
  <form onSubmit={event => { event.preventDefault();void start(); }}>
   <div className="rv-field"><label htmlFor={field}>What do you need?</label><textarea id={field} className="rv-input rv-psv2-text" value={text} disabled={locked} aria-invalid={tooLong || undefined} aria-describedby={field + "-count"} onChange={event => { setText(event.target.value);setRefusal(undefined); }} /></div>
   <p id={field + "-count"} className={tooLong ? "rv-error" : "rv-muted"}>{text.length} / {FIRST_TASK_MAX}</p>
   <Button type="submit" variant="primary" busy={busy} disabled={blocked}>Start the first task</Button>
  </form>
  {refusal !== undefined && <div role="alert" className="rv-psv2-refusal"><p><strong>Rovara didn't start this task.</strong></p><dl><dt>Why</dt><dd><VisibleText text={refusal.reason} /></dd><dt>What to do</dt><dd>{refusal.fix}</dd></dl>
   {refusal.action === "environment" && <Button onClick={onBack}>Go to the environment check</Button>}
   {refusal.action === "close_tasks" && <OpenTasksToClose key={closed} onClosed={() => { setRefusal(undefined);setClosed(value => value + 1); }} />}
   {refusal.action === "project" && <Link className="rv-button" to={"/app/projects/" + encodeURIComponent(project.name)}>Open the project</Link>}
  </div>}
  {pending !== undefined && <ConfirmInBrowser result={pending} subjectKey={["project", project.name, "overview"]} isApplied={() => false} />}
  {started !== undefined && <p role="status">The first task was started. {started.session !== undefined ? "Opening it now." : <>Find it on the <Link to={"/app/projects/" + encodeURIComponent(project.name)}>project page</Link>.</>}</p>}
  <p className="rv-muted"><Link to={"/app/projects/" + encodeURIComponent(project.name)}>Finish later and open the project</Link></p>
 </>;
}
