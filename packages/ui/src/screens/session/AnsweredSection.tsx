import { paths } from "../../paths.js";
import { useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import { ANSWER_SOURCES_MAX, SessionIdSchema, answerSourceLine, plainAnswerText } from "@agentx/cloud-contracts/web";
import { useAppHost } from "../../host.js";
import { createSessionActions } from "../../api/session-actions.js";
import { ApiError } from "../../api/errors.js";
import { Button } from "../../design/Button.js";
import { VisibleText } from "../../design/VisibleText.js";
import type { ReadSession } from "./SessionHeader.js";
import type { ReadTask } from "./workspace-types.js";

export const ANSWERED_HEADING = "Rovara answered this. No code was changed.";
const MORE_WORDS = "If you want the change made anyway, Rovara starts a new task with this answer as background.";
/** Plain words for the codes "Make a change anyway" can be refused with. Anything else gets the general sentence, never the server's own words. */
const REFUSALS: Readonly<Record<string, string>> = {
 SESSION_LEVEL_REQUIRED: "You can read this session but not ask for a change from it. Ask its owner for \"can use\" access.",
 PROJECT_ACCESS_DENIED: "You don't have permission to start work on this project.",
 SESSION_ON_MAC: "This session runs on a Mac now, so a change can't be started from here.",
 CONFIG_INVALID: "This task didn't end with an answer, so there is nothing to change after. Reload this page.",
 RUNTIME_UNAVAILABLE: "Rovara can't start work right now. Try again shortly.",
 NOT_FOUND: "This session wasn't found, or you no longer have access.",
 IDEMPOTENCY_CONFLICT: "That request was already sent. Reload this page.",
};
const GENERAL_REFUSAL = "Couldn't start the change. Try again.";

/** The answer Understand gave, for a task that ended Answered (a model's words: shown only as plain text). Undefined for any other task. */
export function answeredOf(task: ReadTask | undefined) {
 const workflow = task?.workflow, assessment = workflow?.intent?.assessment;
 return workflow?.outcome === "ANSWERED" && assessment?.kind === "answer" ? assessment : undefined;
}

/**
 * A task Understand answered without changing code (playbook R1b): what Rovara said and where in the code it read it, and for a person who can use the session, "Make a change anyway".
 * The button posts once with one request id (kept for a retry, so a lost answer never starts the work twice) and opens the session it started. The server decides who may; the page only
 * hides the button from people who can only read, and from a session that runs on a Mac now.
 */
export function AnsweredSection({ session, task }: { session: ReadSession; task: ReadTask }) {
 const host = useAppHost(), api = useMemo(() => createSessionActions(host), [host]);
 const [busy, setBusy] = useState(false), [accepted, setAccepted] = useState(false), [noSession, setNoSession] = useState(false), [error, setError] = useState<string>();
 const sending = useRef(false), requestId = useRef<string>(undefined);
 const answer = answeredOf(task);
 if (answer === undefined) return null;
 const mayAsk = (session.you.level === "use" || session.you.level === "edit") && session.where.kind === "cloud";
 async function start() {
  if (sending.current || accepted) return;
  sending.current = true;setBusy(true);setError(undefined);
  requestId.current ??= crypto.randomUUID();
  try {
   const result = await api.changeAnyway(session.sessionId, requestId.current);
   if (result.kind !== "done") { setError("Your change is waiting for confirmation. Reload this page to check its status.");return; }
   setAccepted(true);
   // A legacy answer can lack its session id: never guess one, and never send the work a second time.
   const next = SessionIdSchema.safeParse(result.value.sessionId);
   if (next.success) host.navigate("/app/sessions/" + next.data); else setNoSession(true);
  } catch (failure) { setError(failure instanceof ApiError ? REFUSALS[failure.code] ?? (failure.code === "NETWORK_ERROR" ? failure.message : GENERAL_REFUSAL) : GENERAL_REFUSAL); }
  finally { sending.current = false;setBusy(false); }
 }
 return <section aria-label="Rovara's answer" className="rv-answered">
  <h3>{ANSWERED_HEADING}</h3>
  <p className="rv-evidence-text"><VisibleText text={plainAnswerText(answer.answer)} /></p>
  {answer.sources.length > 0 && <><h4>Where it was read</h4><ul className="rv-answered-sources">{answer.sources.slice(0, ANSWER_SOURCES_MAX).map((source, index) => <li key={String(index)}><code><VisibleText text={answerSourceLine(source)} /></code></li>)}</ul></>}
  {mayAsk && <>
   <p className="rv-muted">{MORE_WORDS}</p>
   {error && <p role="alert"><VisibleText text={error} /></p>}
   {noSession && <p role="status">The change was accepted. <Link to={paths.work}>Open Work</Link> to find its session.</p>}
   <div className="rv-actions"><Button variant="primary" busy={busy} disabled={accepted} onClick={() => { void start(); }}>Make a change anyway</Button></div>
  </>}
 </section>;
}
