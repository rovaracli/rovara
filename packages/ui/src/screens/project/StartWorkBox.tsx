import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import { useQuery, skipToken } from "@tanstack/react-query";
import { START_SMALL_TALK_WORDS, formatUsdMicrodollars, SessionIdSchema, type HowWeWorkViewReaderSchema } from "@agentx/contracts/web";
import { useAppHost } from "../../host.js";
import { createCodeApi, CODE_TEXT_MAX } from "../../api/code.js";
import { howWeWorkKey } from "../../api/how-we-work.js";
import { ApiError } from "../../api/errors.js";
import { fixedAnswerWords, useAnswersApi, useAnswersEnabled, type AnswerResponse, type StartSuggestPick } from "../../api/answers.js";
import { useProject } from "../../api/projects.js";
import { AnswerView } from "../answers/AnswerView.js";
import { StartedNotes, useStartFromAnswer } from "../answers/AnswerBox.js";
import { A, taskTextFromAnswer } from "../answers/answer-text.js";
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
 // Lead 4 J3 (DEC 173): with answers on, the first press asks what the text needs; with them off the box starts Quick, exactly as it always did.
 const answersOn = useAnswersEnabled(), answers = useAnswersApi(), overview = useProject(project), fromAnswer = useStartFromAnswer(project);
 const [offer, setOffer] = useState<{ text: string; pick: StartSuggestPick; why: "large" | "failed" }>(), [said, setSaid] = useState<string>(), [answer, setAnswer] = useState<{ question: string; value: AnswerResponse }>();
 const [text, setText] = useState(""), [busy, setBusy] = useState(false), [accepted, setAccepted] = useState(false), [error, setError] = useState<string>(), [full, setFull] = useState(false), [pending, setPending] = useState<Exclude<SendResult<unknown>, { kind: "done" }>>();
 const [preview, setPreview] = useState<{ project: string; api: typeof api; stop: number }>();
 useEffect(() => {
  const abort = new AbortController();let live = true;
  void api.previewStart(project, abort.signal).then(value => { if (live) setPreview(value === undefined ? undefined : { project, api, stop: value.effectiveStopMicrousd }); });
  return () => { live = false;abort.abort(); };
 }, [api, project]);
 const sending = useRef(false), intent = useRef<{ text: string; requestId: string } | undefined>(undefined);
 const tooLong = text.length > CODE_TEXT_MAX, locked = busy || accepted || pending !== undefined, blocked = locked || !text.trim() || tooLong;
 async function start(path?: "quick" | "full") {
  if (sending.current || blocked) return;
  sending.current = true;setBusy(true);setError(undefined);setFull(false);
  // A retry of the same text reuses its request id, so a lost answer never starts the work twice.
  if (intent.current?.text !== text) intent.current = { text, requestId: crypto.randomUUID() };
  try {
   const result = await api.startCode(project, text, intent.current.requestId, path);
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

 /** Answers the question in place (answer first, nothing started); an unclear text ends in the one "Start a Quick task" button. */
 async function ask(question: string) {
  sending.current = true;setBusy(true);setError(undefined);
  try { setAnswer({ question, value: await answers.ask(project, { requestId: crypto.randomUUID(), question: question.slice(0, 1_000) }) }); }
  catch (failure) { setError(fixedAnswerWords(failure, A.FAILED)); }
  finally { sending.current = false;setBusy(false); }
 }
 /** The first press with answers on: ask what the text needs, then do the one obvious thing (small change: Quick, as Slack does; question or unclear: answer first) or show the card. */
 async function press() {
  if (blocked || sending.current) return;
  if (!answersOn) { void start();return; }
  sending.current = true;setBusy(true);setError(undefined);setSaid(undefined);setOffer(undefined);setAnswer(undefined);
  let next: "legacy" | "start-quick" | "answer" | undefined;
  try {
   const suggestion = await answers.suggest(project, { requestId: crypto.randomUUID(), text: text.trim() });
   if (suggestion.kind === "small_talk") setSaid(START_SMALL_TALK_WORDS[suggestion.smallTalk === "greeting" || suggestion.smallTalk === "thanks" || suggestion.smallTalk === "help" || suggestion.smallTalk === "ack" ? suggestion.smallTalk : "help"]);
   // No classifier is set up here: the box does what it always did.
   else if (suggestion.classifier === "unavailable") next = "legacy";
   else if (suggestion.classifier === "failed") setOffer({ text: text.trim(), pick: "answer", why: "failed" });
   else if (suggestion.pick === "quick") next = "start-quick";
   else if (suggestion.pick === "full") setOffer({ text: text.trim(), pick: "full", why: "large" });
   else next = "answer";
  } catch (failure) {
   // A suggestion that cannot be had never blocks the work or guesses a path: the person chooses. Its own rate words are shown as they are.
   if (failure instanceof ApiError && failure.status === 429) setError(fixedAnswerWords(failure, A.FAILED));
   else setOffer({ text: text.trim(), pick: "answer", why: "failed" });
  } finally { sending.current = false;setBusy(false); }
  if (next === "legacy") void start();
  else if (next === "start-quick") void start("quick");
  else if (next === "answer") void ask(text.trim());
 }
 const choose = (pick: StartSuggestPick) => { setOffer(undefined);if (pick === "answer") void ask(text.trim());else void start(pick); };
 const canStart = overview.data?.you.canStartWork === true, repositories = overview.data?.project.repositories ?? [];
 const choices: StartSuggestPick[] = ["answer", "quick", "full"], choiceWords = { answer: A.CHOICE_ANSWER, quick: A.CHOICE_QUICK, full: A.CHOICE_FULL } as const;
 return <section className="rv-project-start" aria-label="Start work"><form onSubmit={event => { event.preventDefault();void press(); }}><div className="rv-field"><label htmlFor={field}>What do you need?</label><textarea id={field} data-testid="start-work-text" className="rv-input rv-project-start-text" value={text} disabled={locked} aria-invalid={tooLong || undefined} aria-describedby={field + "-count " + field + "-runs"} onChange={event => setText(event.target.value)} onKeyDown={event => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault();void press(); } }} /></div><div className="rv-project-start-bar"><p id={field + "-count"} className={tooLong ? "rv-error" : "rv-muted"}>{text.length} / {CODE_TEXT_MAX}</p><Button type="submit" variant="primary" data-testid="start-work-submit" busy={busy} disabled={blocked}>Start</Button></div><p id={field + "-runs"} className="rv-muted"><VisibleText text={runs} /></p>{preview?.project === project && preview.api === api && <p className="rv-muted">Effective spending stop: {formatUsdMicrodollars(preview.stop)}. Checked again when work starts.</p>}{error && <p role="alert" data-testid="start-work-error"><VisibleText text={error} /></p>}{full && <OpenTasksToClose onClosed={() => { setFull(false);setError(undefined); }} />}{busy && answersOn && <p className="rv-muted" role="status">{A.SUGGESTING}</p>}{said && <p role="status" data-testid="start-small-talk"><VisibleText text={said} /></p>}{offer && <div className="rv-start-card" role="group" aria-label="Choose how to handle this" data-testid="start-choice-card"><p><VisibleText text={offer.why === "large" ? A.CARD_LARGE : A.CARD_FAILED} /></p><div className="rv-start-card-choices">{choices.map(pick => <Button key={pick} variant={pick === offer.pick ? "primary" : "secondary"} data-testid={"start-choice-" + pick} disabled={pick !== "answer" && !canStart} onClick={() => choose(pick)}>{choiceWords[pick]}{pick === offer.pick ? " (" + A.RECOMMENDED + ")" : ""}</Button>)}</div></div>}{answer && <AnswerView project={project} answer={answer.value} repositories={repositories} {...(canStart && answer.value.action !== undefined ? { onStart: () => { void fromAnswer.start(taskTextFromAnswer(answer.question, answer.value)); }, starting: fromAnswer.busy } : {})} />}<StartedNotes started={fromAnswer} />{accepted && <p role="status">Work was accepted. <Link to="/app/live">Open Live</Link> to find its session.</p>}{pending && <ConfirmInBrowser result={pending} subjectKey={["project", project, "overview"]} isApplied={() => false} />}</form></section>;
}
