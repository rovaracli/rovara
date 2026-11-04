import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import { useQuery, skipToken } from "@tanstack/react-query";
import { formatUsdMicrodollars, SessionIdSchema, type HowWeWorkViewReaderSchema } from "@agentx/contracts/web";
import { useAppHost } from "../../host.js";
import { createCodeApi, CODE_TEXT_MAX } from "../../api/code.js";
import { howWeWorkKey } from "../../api/how-we-work.js";
import { ApiError } from "../../api/errors.js";
import type { SendResult } from "../../api/client.js";
import { ConfirmInBrowser } from "../../confirm/ConfirmInBrowser.js";
import { Button } from "../../design/Button.js";
import { VisibleText } from "../../design/VisibleText.js";
import { OpenTasksToClose } from "./OpenTasksToClose.js";

/**
 * Which process runs the work, read only from "How we work" data the page already has (it never asks for it): the project's own process by the name its roster gives it, the
 * built-in one, or just "this project's process" when the page can't say more.
 */
function useRunsLine(project: string, agents: readonly { agentId: string; name: string }[]): string {
 const loaded = useQuery<ReturnType<typeof HowWeWorkViewReaderSchema.parse>>({ queryKey: [...howWeWorkKey(project), "view"], queryFn: skipToken }).data;
 if (loaded === undefined) return "Runs: this project's process";
 if (loaded.process.kind === "builtin") return "Runs: the built-in process (Rovara Code)";
 const name = agents.find(agent => agent.agentId === loaded.process.agentId)?.name;
 return name === undefined ? "Runs: this project's process" : "Runs: " + name + " (Rovara Code)";
}

/** "What do you need?": describe the work and the project's process runs it. Only shown to people who can start work. */
export function StartWorkBox({ project, agents }: { project: string; agents: readonly { agentId: string; name: string }[] }) {
 const host = useAppHost(), api = useMemo(() => createCodeApi(host), [host]), field = useId(), runs = useRunsLine(project, agents);
 const [text, setText] = useState(""), [busy, setBusy] = useState(false), [accepted, setAccepted] = useState(false), [error, setError] = useState<string>(), [full, setFull] = useState(false), [pending, setPending] = useState<Exclude<SendResult<unknown>, { kind: "done" }>>();
 const [preview, setPreview] = useState<{ project: string; api: typeof api; stop: number }>();
 useEffect(() => {
  const abort = new AbortController();let live = true;
  void api.previewStart(project, abort.signal).then(value => { if (live) setPreview(value === undefined ? undefined : { project, api, stop: value.effectiveStopMicrousd }); });
  return () => { live = false;abort.abort(); };
 }, [api, project]);
 const sending = useRef(false), intent = useRef<{ text: string; requestId: string } | undefined>(undefined);
 const tooLong = text.length > CODE_TEXT_MAX, locked = busy || accepted || pending !== undefined, blocked = locked || !text.trim() || tooLong;
 async function start() {
  if (sending.current || blocked) return;
  sending.current = true;setBusy(true);setError(undefined);setFull(false);
  // A retry of the same text reuses its request id, so a lost answer never starts the work twice.
  if (intent.current?.text !== text) intent.current = { text, requestId: crypto.randomUUID() };
  try {
   const result = await api.startCode(project, text, intent.current.requestId);
   if (result.kind !== "done") { setPending(result);return; }
   setAccepted(true);
   // A legacy answer can lack its session id: never guess one, and never send the work a second time.
   const session = SessionIdSchema.safeParse(result.value.sessionId);
   if (session.success) host.navigate("/s/" + session.data);
  } catch (failure) {
   // Too many open tasks: the broker's words name an AI-tool command, so the page says it in its own and offers the tasks to close.
   if (failure instanceof ApiError && failure.code === "WORKSPACE_LIMIT") { setFull(true);setError("You have too many open tasks to start more work. Close one of these, then start again.");}
   else setError(failure instanceof ApiError ? failure.message : "Couldn't start this work. Try again.");
  }
  finally { sending.current = false;setBusy(false); }
 }
 return <section className="rv-project-start" aria-label="Start work"><form onSubmit={event => { event.preventDefault();void start(); }}><div className="rv-field"><label htmlFor={field}>What do you need?</label><textarea id={field} className="rv-input rv-project-start-text" value={text} disabled={locked} aria-invalid={tooLong || undefined} aria-describedby={field + "-count " + field + "-runs"} onChange={event => setText(event.target.value)} onKeyDown={event => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault();void start(); } }} /></div><div className="rv-project-start-bar"><p id={field + "-count"} className={tooLong ? "rv-error" : "rv-muted"}>{text.length} / {CODE_TEXT_MAX}</p><Button type="submit" variant="primary" busy={busy} disabled={blocked}>Start</Button></div><p id={field + "-runs"} className="rv-muted"><VisibleText text={runs} /></p>{preview?.project === project && preview.api === api && <p className="rv-muted">Effective spending stop: {formatUsdMicrodollars(preview.stop)}. Checked again when work starts.</p>}{error && <p role="alert"><VisibleText text={error} /></p>}{full && <OpenTasksToClose onClosed={() => { setFull(false);setError(undefined); }} />}{accepted && <p role="status">Work was accepted. <Link to="/app/live">Open Live</Link> to find its session.</p>}{pending && <ConfirmInBrowser result={pending} subjectKey={["project", project, "overview"]} isApplied={() => false} />}</form></section>;
}
