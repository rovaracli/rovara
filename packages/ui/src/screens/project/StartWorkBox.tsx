import { paths } from "../../paths.js";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { codeSuggestionReason, type CodeSuggestion, formatUsdMicrodollars, SessionIdSchema, type HowWeWorkViewReaderSchema } from "@agentx/cloud-contracts/web";
import { useAppHost } from "../../host.js";
import { createCodeApi, CODE_TEXT_MAX, DESIGN_FIRST_REFUSED } from "../../api/code.js";
import { designReviewKey, useDesignReviewApi } from "../../api/design-review.js";
import { howWeWorkKey } from "../../api/how-we-work.js";
import { ApiError } from "../../api/errors.js";
import type { SendResult } from "../../api/client.js";
import { ConfirmInBrowser } from "../../confirm/ConfirmInBrowser.js";
import { Button } from "../../design/Button.js";
import { Checkbox } from "../../design/Checkbox.js";
import { VisibleText } from "../../design/VisibleText.js";
import { OpenTasksToClose } from "./OpenTasksToClose.js";

/**
 * Which process runs the work, read only from "How we work" data the page already has (it never asks for it): the project's own process by the name its roster gives it, the
 * built-in one, or just "this project's process" when the page can't say more.
 */
function useRunsLine(project: string, agents: readonly { agentId: string; name: string }[]): string {
 // Read-only observer: no queryFn (not skipToken, which a refetch would run if this observer set the query's options last).
 const loaded = useQuery<ReturnType<typeof HowWeWorkViewReaderSchema.parse>>({ queryKey: [...howWeWorkKey(project), "view"], enabled: false }).data;
 if (loaded === undefined) return "Runs: this project's process";
 if (loaded.process.kind === "builtin") return "Runs: the built-in process (Rovara Code)";
 const name = agents.find(agent => agent.agentId === loaded.process.agentId)?.name;
 return name === undefined ? "Runs: this project's process" : "Runs: " + name + " (Rovara Code)";
}

/** "What do you need?": describe the work and the project's process runs it. Only shown to people who can start work. */
export function StartWorkBox({ project, agents }: { project: string; agents: readonly { agentId: string; name: string }[] }) {
 const host = useAppHost(), api = useMemo(() => createCodeApi(host), [host]), field = useId(), runs = useRunsLine(project, agents);
 // "Design first" is offered only where the broker says design review exists for the company (`designReviewAllowed`: the stage is on and the company allows it). The project's own mode does not matter: a project set to Off can still ask for one task.
 const designApi = useDesignReviewApi(), playbook = useQuery({ queryKey: designReviewKey(project), queryFn: () => designApi.playbook(project) });
 const offered = playbook.data?.designReviewAllowed === true, [designFirst, setDesignFirst] = useState(false), asked = offered && designFirst;
 const [text, setText] = useState(""), [busy, setBusy] = useState(false), [accepted, setAccepted] = useState(false), [error, setError] = useState<string>(), [full, setFull] = useState(false), [pending, setPending] = useState<Exclude<SendResult<unknown>, { kind: "done" }>>();
 const [preview, setPreview] = useState<{ project: string; api: typeof api; stop: number }>();
 useEffect(() => {
  const abort = new AbortController();let live = true;
  void api.previewStart(project, abort.signal).then(value => { if (live) setPreview(value === undefined ? undefined : { project, api, stop: value.effectiveStopMicrousd }); });
  return () => { live = false;abort.abort(); };
 }, [api, project]);
 const [suggestion, setSuggestion] = useState<{ project: string; api: typeof api; text: string; result?: CodeSuggestion; path?: "QUICK" | "FULL"; manual: boolean }>();
 const current = suggestion?.project === project && suggestion.api === api && suggestion.text === text ? suggestion : undefined;
 useEffect(() => {
  if (!text.trim() || text.length > CODE_TEXT_MAX) return;
  const abort = new AbortController();let live = true;
  const timer = setTimeout(() => {
   void api.suggestCode(project, text, crypto.randomUUID(), abort.signal).then(result => {
    if (!live) return;
    setSuggestion(previous => {
     const manual = previous?.project === project && previous.api === api && previous.text === text && previous.manual;
     const path = manual ? previous.path : result.path === "quick" ? "QUICK" : result.path === "full" ? "FULL" : undefined;
     return { project, api, text, result, manual, ...(path === undefined ? {} : { path }) };
    });
   });
  }, 250);
  return () => { live = false;clearTimeout(timer);abort.abort(); };
 }, [api, project, text]);
 const choosePath = (path: "QUICK" | "FULL") => setSuggestion({ ...current, project, api, text, path, manual: true });
 const sending = useRef(false), intent = useRef<{ project: string; text: string; path: "QUICK" | "FULL"; asked: boolean; requestId: string } | undefined>(undefined);
 const tooLong = text.length > CODE_TEXT_MAX, locked = busy || accepted || pending !== undefined, blocked = locked || !text.trim() || tooLong || current?.result === undefined || current.path === undefined;
 async function start() {
  if (sending.current || blocked || current?.path === undefined) return;
  sending.current = true;setBusy(true);setError(undefined);setFull(false);
  // A retry of the same text (and the same path and Design first choice) reuses its request id, so a lost answer never starts the work twice.
  if (intent.current?.project !== project || intent.current.text !== text || intent.current.path !== current.path || intent.current.asked !== asked) intent.current = { project, text, path: current.path, asked, requestId: crypto.randomUUID() };
  try {
   const result = await api.startCode(project, text, intent.current.requestId, asked, current.path);
   if (result.kind !== "done") { setPending(result);return; }
   setAccepted(true);
   // A legacy answer can lack its session id: never guess one, and never send the work a second time.
   const session = SessionIdSchema.safeParse(result.value.sessionId);
   if (session.success) host.navigate("/app/sessions/" + session.data);
  } catch (failure) {
   // Too many open tasks: the broker's words name an AI-tool command, so the page says it in its own and offers the tasks to close.
   if (failure instanceof ApiError && failure.code === "WORKSPACE_LIMIT") { setFull(true);setError("You have too many open tasks to start more work. Close one of these, then start again.");}
   // Design first was refused: read the setting again, so the option goes if it is no longer offered.
   else if (asked && failure instanceof ApiError && failure.message === DESIGN_FIRST_REFUSED) { void playbook.refetch();setError(failure.message); }
   else setError(failure instanceof ApiError ? failure.message : "Couldn't start this work. Try again.");
  }
  finally { sending.current = false;setBusy(false); }
 }
 return <section className="rv-project-start" aria-label="Start work"><form onSubmit={event => { event.preventDefault();void start(); }}><div className="rv-field"><label htmlFor={field}>What do you need?</label><textarea id={field} className="rv-input rv-project-start-text" value={text} disabled={locked} aria-invalid={tooLong || undefined} aria-describedby={field + "-count " + field + "-runs"} onChange={event => { setSuggestion(undefined);setText(event.target.value); }} onKeyDown={event => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault();void start(); } }} /></div>{text.trim() && !tooLong && <fieldset aria-describedby={field + "-suggestion"} disabled={locked}><legend>How should Rovara handle this?</legend>{(["QUICK", "FULL"] as const).map(path => <div className="rv-check-row" key={path}><input type="radio" id={field + "-" + path} name={field + "-path"} checked={current?.path === path} onChange={() => choosePath(path)} /><label htmlFor={field + "-" + path}>{path === "QUICK" ? "Quick" : "Full"}</label></div>)}<p id={field + "-suggestion"} className="rv-muted" role="status">{current?.result === undefined ? "Checking the wording…" : (current.result.path !== "answer" ? "Suggested from the wording. " : "") + codeSuggestionReason(current.result.reason)}</p>{current?.result?.reason === "unavailable" && <p className="rv-muted">Just answer isn't available here yet. Choose Quick or Full to request a code change.</p>}</fieldset>}{offered && <Checkbox label="Review the design before building (Design first)" checked={designFirst} onCheckedChange={value => setDesignFirst(value === true)} disabled={locked} />}<div className="rv-project-start-bar"><p id={field + "-count"} className={tooLong ? "rv-error" : "rv-muted"}>{text.length} / {CODE_TEXT_MAX}</p><Button type="submit" variant="primary" busy={busy} disabled={blocked}>Start</Button></div><p id={field + "-runs"} className="rv-muted"><VisibleText text={runs} /></p>{preview?.project === project && preview.api === api && <p className="rv-muted">Effective spending stop: {formatUsdMicrodollars(preview.stop)}. Checked again when work starts.</p>}{error && <p role="alert"><VisibleText text={error} /></p>}{full && <OpenTasksToClose onClosed={() => { setFull(false);setError(undefined); }} />}{accepted && <p role="status">Work was accepted. <Link to={paths.work}>Open Work</Link> to find its session.</p>}{pending && <ConfirmInBrowser result={pending} subjectKey={["project", project, "overview"]} isApplied={() => false} />}</form></section>;
}
