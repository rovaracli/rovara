import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import type { LessonRetireReason } from "@agentx/contracts/code-contract-v0";
import { ApiError } from "../../api/errors.js";
import {
 INBOX_KEY, MODES, OFF_TEXT, REJECT_REASONS, RETIRED_STATUS, RETIRE_REASONS, citationWords, expiryWords, fromWords, learnedKey, lessonsOff, modeLabel, notServed, reasonWords, usageWords,
 relationWords, useLearnedApi, useLessonMode, useLessonPages, useRetireRequests, type LessonItem, type LessonList, type LessonMode,
} from "../../api/learned.js";
import { paths } from "../../paths.js";
import { useAnnounce } from "../../design/Announcer.js";
import { Button } from "../../design/Button.js";
import { RelativeTime } from "../../design/RelativeTime.js";
import { Select } from "../../design/Select.js";
import { Skeleton } from "../../design/Skeleton.js";
import { Tabs } from "../../design/Tabs.js";
import { VisibleText } from "../../design/VisibleText.js";
import "../work/lessons.css";

const failureWords = (error: unknown, fallback: string) => (error instanceof ApiError ? error.message : fallback);

/** The learning mode: off, suggest or auto, set by those Code says may; "Company locked" when the company's setting is the one in force. */
function ModeRow({ project }: { project: string }) {
 const read = useLessonMode(project), api = useLearnedApi(), query = useQueryClient(), [busy, setBusy] = useState(false), [error, setError] = useState<string>();
 if (read.isPending) return <Skeleton label="Loading the learning mode" />;
 if (read.isError) return lessonsOff(read.error) || notServed(read.error) ? null : <p role="alert" className="rv-lesson-failed"><VisibleText text={failureWords(read.error, "Couldn't load the learning mode.")} /></p>;
 const mode = read.data;
 async function change(next: LessonMode) {
  if (busy || next === mode.mode) return;
  setBusy(true);setError(undefined);
  try { query.setQueryData([...learnedKey(project), "mode"], await api.setMode(project, next)); }
  catch (failure) { setError(failureWords(failure, "Couldn't change the mode. Nothing was changed.")); }
  finally { setBusy(false); }
 }
 const locked = mode.lockedByCompany && <p data-testid="company-locked"><span className="rv-locked">Company locked</span> The company's setting keeps this project at {modeLabel(mode.effective)}.</p>;
 if (!mode.canChange) return <div className="rv-learned-mode" data-testid="learning-mode"><p><b>Learning: {modeLabel(mode.effective)}.</b> {MODES.find(entry => entry.value === mode.effective)?.hint}</p>{locked}<p className="rv-muted">Only an admin of this project, or an owner or admin of the company, can change it.</p></div>;
 return <fieldset className="rv-learned-mode" data-testid="learning-mode" disabled={busy}>
  <legend>Learning</legend>
  <div className="rv-choices">{MODES.map(entry => <label key={entry.value} className="rv-choice"><input type="radio" name={"learning-mode-" + project} value={entry.value} checked={mode.mode === entry.value} onChange={() => { void change(entry.value); }} /><span>{entry.label}</span></label>)}</div>
  <p className="rv-muted" aria-live="polite">{MODES.find(entry => entry.value === mode.mode)?.hint}</p>
  {locked}
  {error !== undefined && <p role="alert" className="rv-lesson-failed"><VisibleText text={error} /></p>}
 </fieldset>;
}

type Action = { kind: "idle" } | { kind: "retiring"; reason: string } | { kind: "dropping"; reason: string } | { kind: "busy" } | { kind: "done"; text: string } | { kind: "error"; text: string };

/** One lesson in a list: its text, where it came from, Code's counts, and what this person may do with it. */
function LearnedLesson({ project, lesson, list }: { project: string; lesson: LessonItem; list: LessonList }) {
 const api = useLearnedApi(), query = useQueryClient(), announce = useAnnounce(), [action, setAction] = useState<Action>({ kind: "idle" }), [now] = useState(() => Date.now());
 const from = fromWords(lesson), expiry = list === "proposed" ? expiryWords(lesson.expiresAt, now) : undefined;
 /** Sends one write once; what it came to is said in words (`write` answers them). */
 async function run(write: () => Promise<string>) {
  setAction({ kind: "busy" });
  // The lesson leaves its list when the lists are read again, so what happened is also announced.
  try { const text = await write();setAction({ kind: "done", text });announce(`${lesson.title}: ${text}`);void query.invalidateQueries({ queryKey: learnedKey(project) });void query.invalidateQueries({ queryKey: INBOX_KEY }); }
  catch (failure) { setAction({ kind: "error", text: failureWords(failure, "That didn't go through. Nothing was changed.") }); }
 }
 const busy = action.kind === "busy";
 const actions = action.kind === "done" ? <p role="status" className="rv-learned-note">{action.text}</p>
  : action.kind === "retiring" ? <div className="rv-retire-form">
   <Select label={`Why retire "${lesson.title}"`} value={action.reason} placeholder="Choose a reason" options={RETIRE_REASONS} onValueChange={reason => setAction({ kind: "retiring", reason })} />
   <Button variant="danger" disabled={action.reason === ""} onClick={() => { const reason = RETIRE_REASONS.find(entry => entry.value === action.reason)?.value as LessonRetireReason;void run(async () => { await api.retire(project, lesson.id, reason);return "Retired. Rovara no longer gives it to tasks."; }); }}>Retire lesson</Button>
   <Button variant="quiet" onClick={() => setAction({ kind: "idle" })}>Cancel</Button></div>
  : action.kind === "dropping" ? <div className="rv-retire-form">
   <Select label={`Why drop "${lesson.title}"`} value={action.reason} placeholder="Choose a reason" options={REJECT_REASONS} onValueChange={reason => setAction({ kind: "dropping", reason })} />
   <Button variant="danger" disabled={action.reason === ""} onClick={() => { const reason = REJECT_REASONS.find(entry => entry.value === action.reason)!.value;void run(async () => { await api.drop(project, lesson.id, lesson.version, reason);return "Dropped."; }); }}>Drop lesson</Button>
   <Button variant="quiet" onClick={() => setAction({ kind: "idle" })}>Cancel</Button></div>
  : <div className="rv-lesson-actions">
   {list === "proposed" && lesson.canApprove && <Button busy={busy} aria-label={`Keep: ${lesson.title}`} onClick={() => { void run(async () => (await api.keep(project, lesson.id, lesson.version)).status === "pending" ? "Kept. It waits for one more person before Rovara uses it." : "Kept. Rovara uses it in tasks from now on."); }}>Keep</Button>}
   {list === "proposed" && lesson.canReject && <Button variant="quiet" disabled={busy} aria-label={`Drop: ${lesson.title}`} onClick={() => setAction({ kind: "dropping", reason: "" })}>Drop</Button>}
   {list === "approved" && lesson.canRetire && <Button variant="quiet" disabled={busy} aria-label={`Retire: ${lesson.title}`} onClick={() => setAction({ kind: "retiring", reason: "" })}>Retire</Button>}
   {list === "approved" && !lesson.canRetire && <Button variant="quiet" busy={busy} aria-label={`Ask to retire: ${lesson.title}`} onClick={() => { void run(async () => { await api.askRetire(project, lesson.id);return "Asked. The people who decide lessons will see your request."; }); }}>Ask to retire</Button>}
  </div>;
 return <li><article className="rv-lesson" aria-labelledby={"learned-" + lesson.id} data-lesson-id={lesson.id}>
  <header className="rv-lesson-head"><h3 id={"learned-" + lesson.id}><VisibleText text={lesson.title} /></h3>{from !== undefined && <span className={"rv-lesson-from" + (lesson.from.some(person => person.you === true) ? " you" : "")}>{from}</span>}</header>
  {lesson.description !== "" && <p className="rv-lesson-description"><VisibleText text={lesson.description} /></p>}
  {lesson.body !== "" && lesson.body !== lesson.description && <details><summary>The full lesson</summary><p className="rv-lesson-body"><VisibleText text={lesson.body} /></p></details>}
  <ul className="rv-lesson-facts">
   {list === "retired" ? <li>{RETIRED_STATUS[lesson.status] ?? "No longer used"}{reasonWords(lesson.rejectedReason) === undefined ? "" : `: ${reasonWords(lesson.rejectedReason)!.toLowerCase()}`}</li> : <li>{usageWords(lesson)}</li>}
   {lesson.trial === "trial" && <li>On trial</li>}
   {lesson.needs !== undefined && lesson.needs.required === 2 && list === "proposed" && <li>{lesson.needs.have === 1 ? "One person kept it; needs one more" : "Needs two people to keep it"}</li>}
   {lesson.citations.slice(0, 3).map((one, index) => { const words = citationWords(one); return <li key={index}>{words.href === undefined ? <span className="mono"><VisibleText text={words.text} /></span> : <a href={words.href} target="_blank" rel="noreferrer">{words.text}</a>}</li>; })}
  </ul>
  {list === "proposed" && relationWords(lesson, () => undefined).map(words => <p key={words} className="rv-lesson-relation"><VisibleText text={words} /></p>)}
  {expiry !== undefined && <p className={"rv-lesson-expiry" + (expiry.soon ? " soon" : "")}>{expiry.soon && <span className="rv-tone-dot" data-tone="wait" aria-hidden="true" />}{expiry.text}</p>}
  {actions}
  {action.kind === "error" && <p role="alert" className="rv-lesson-failed"><VisibleText text={action.text} /></p>}
 </article></li>;
}

const EMPTY: Record<LessonList, string> = {
 approved: "No approved lessons yet. When people keep a proposed lesson, it shows here and guides future tasks.",
 proposed: "Nothing waits for a decision.",
 retired: "No lessons have been retired, dropped or lapsed.",
};

function LessonsList({ project, list, onOff }: { project: string; list: LessonList; onOff: () => void }) {
 const read = useLessonPages(project, list), off = read.isError && lessonsOff(read.error);
 useEffect(() => { if (off) onOff(); }, [off, onOff]);
 if (read.isPending) return <Skeleton label="Loading lessons" />;
 if (read.isError) {
  if (off) return null;
  if (notServed(read.error)) return <p className="rv-muted" data-testid="lessons-not-served"><VisibleText text={read.error instanceof ApiError ? read.error.message : "Lessons aren't on Rovara Code yet."} /></p>;
  return <div role="alert" className="rv-section-error"><p><VisibleText text={failureWords(read.error, "Couldn't load the lessons. Try again.")} /></p><Button onClick={() => { void read.refetch(); }}>Try again</Button></div>;
 }
 const pages = read.data.pages, lessons = pages.flatMap(one => one.lessons), last = pages[pages.length - 1];
 return <>
  {list === "proposed" && lessons.length > 0 && pages[0]?.canDecide && <p className="rv-learned-note">Decide them all at once from <Link to={paths.live + "?task=" + encodeURIComponent("lessons:" + project)}>your Work inbox</Link>.</p>}
  {lessons.length === 0 ? <p className="rv-muted">{list === "proposed" && pages[0]?.canDecide === false ? "Only a maintainer of this project, or an admin, decides proposed lessons." : EMPTY[list]}</p>
   : <ul className="rv-learned-list" aria-label={list === "approved" ? "Approved lessons" : list === "proposed" ? "Proposed lessons" : "Retired lessons"}>{lessons.map(lesson => <LearnedLesson key={lesson.id} project={project} lesson={lesson} list={list} />)}</ul>}
  {last?.partial && <p className="rv-muted rv-learned-note">Some lessons took too long to read. Load more to see the rest.</p>}
  {read.hasNextPage && <Button busy={read.isFetchingNextPage} onClick={() => { void read.fetchNextPage(); }}>Load more</Button>}
 </>;
}

/** The open retire requests, for the people who decide: each with who asked and a Retire with a reason. */
function RetireRequests({ project }: { project: string }) {
 const approved = useLessonPages(project, "approved"), canDecide = approved.data?.pages[0]?.canDecide === true;
 const read = useRetireRequests(project, canDecide), api = useLearnedApi(), query = useQueryClient(), announce = useAnnounce();
 const [reasons, setReasons] = useState<Record<string, string>>({}), [busy, setBusy] = useState<string>(), [error, setError] = useState<string>();
 if (!canDecide || read.data === undefined || read.data.requests.length === 0) return null;
 async function retire(lessonId: string) {
  const reason = RETIRE_REASONS.find(entry => entry.value === reasons[lessonId])?.value;
  if (reason === undefined) return;
  setBusy(lessonId);setError(undefined);
  try { await api.retire(project, lessonId, reason);announce(`${read.data?.requests.find(entry => entry.lessonId === lessonId)?.title ?? "The lesson"}: retired. Rovara no longer gives it to tasks.`);void query.invalidateQueries({ queryKey: learnedKey(project) }); }
  catch (failure) { setError(failureWords(failure, "Couldn't retire it. Nothing was changed.")); }
  finally { setBusy(undefined); }
 }
 return <section className="rv-learned-requests" aria-label="Asked to retire" data-testid="retire-requests"><h3>Asked to retire</h3>
  <ul className="rv-learned-list">{read.data.requests.map(request => <li key={request.lessonId}><p className="rv-learned-note"><b><VisibleText text={request.title} /></b> <span className="rv-muted">asked by <VisibleText text={request.by} />, <RelativeTime at={new Date(request.at).toISOString()} /></span></p>
   <div className="rv-retire-form"><Select label={`Why retire "${request.title}"`} value={reasons[request.lessonId] ?? ""} placeholder="Choose a reason" options={RETIRE_REASONS} onValueChange={reason => setReasons(old => ({ ...old, [request.lessonId]: reason }))} /><Button variant="danger" busy={busy === request.lessonId} disabled={reasons[request.lessonId] === undefined} onClick={() => { void retire(request.lessonId); }}>Retire lesson</Button></div></li>)}</ul>
  {read.data.more && <p className="rv-muted rv-learned-note">More requests wait than are shown here.</p>}
  {error !== undefined && <p role="alert" className="rv-lesson-failed"><VisibleText text={error} /></p>}
 </section>;
}

/**
 * "Learned" (DEC 231c): the project's lessons inside How we work. The learning mode, the approved, proposed and retired lists (Code's pages), retiring with a reason or
 * asking to retire, and the open retire requests for the people who decide. When Code's lessons are off, the section says so calmly and shows nothing else.
 */
export function LearnedSection({ project }: { project: string }) {
 const [tab, setTab] = useState<LessonList>("approved"), [off, setOff] = useState(false), markOff = useCallback(() => setOff(true), [setOff]);
 const mode = useLessonMode(project), isOff = off || (mode.isError && lessonsOff(mode.error));
 return <section className="rv-learned" aria-labelledby="learned-title" data-testid="learned">
  <header><h2 id="learned-title">Learned</h2><p className="rv-muted">Lessons Rovara learned from this project's corrections. Approved lessons are given to future tasks where they fit.</p></header>
  {isOff ? <p className="rv-learned-off" data-testid="lessons-off">{OFF_TEXT}</p> : <>
   <ModeRow project={project} />
   <RetireRequests project={project} />
   <Tabs label="Lessons" value={tab} onValueChange={value => setTab(value as LessonList)} items={[
    { value: "approved", label: "Approved", content: <LessonsList project={project} list="approved" onOff={markOff} /> },
    { value: "proposed", label: "Proposed", content: <LessonsList project={project} list="proposed" onOff={markOff} /> },
    { value: "retired", label: "Retired", content: <LessonsList project={project} list="retired" onOff={markOff} /> },
   ]} />
  </>}
 </section>;
}
