import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import type { LessonRetireReason } from "@agentx/contracts/code-contract-v0";
import { ApiError } from "../../api/errors.js";
import {
 INBOX_KEY, MODES, OFF_TEXT, REJECT_REASONS, RETIRED_STATUS, RETIRE_REASONS, citationWords, expiryWords, fromWords, learnedKey, lessonsOff, modeLabel, notServed, reasonWords, usageWords,
 relationWords, useLearnedApi, useLessonMode, useLessonPages, useRetireRequests, type LessonItem, type LessonList, type LessonMode,
} from "../../api/learned.js";
import { becameWords } from "../../api/graduation.js";
import { paths } from "../../paths.js";
import { useAnnounce } from "../../design/Announcer.js";
import { Button } from "../../design/Button.js";
import { BothPlaces } from "./lessons/BothPlaces.js";
import { TeamRules } from "./lessons/TeamRules.js";
import { ThisWeek } from "./lessons/ThisWeek.js";
import { RelativeTime } from "../../design/RelativeTime.js";
import { Select } from "../../design/Select.js";
import { Skeleton } from "../../design/Skeleton.js";
import { Tabs } from "../../design/Tabs.js";
import { VisibleText } from "../../design/VisibleText.js";
import { areasAbsent, useLessonAreas, type AreaPick, type LessonAreaNode, type LessonAreaRepo } from "../../api/learned-areas.js";
import { LearningSources } from "./lessons/LearningSources.js";
import { TrialOfferCard } from "./lessons/TrialOfferCard.js";
import { WeeklySummaryRow } from "./lessons/WeeklySummaryRow.js";
import { LessonChecks } from "./lessons/LessonChecks.js";
import { RepeatsLine } from "./lessons/RepeatsLine.js";
import "../work/lessons.css";
import "./lessons/areas.css";

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
   {list === "retired" && lesson.became !== undefined ? <li data-testid="lesson-became">{becameWords(lesson.became.kind)}{lesson.became.at > 0 && <> <span className="rv-muted"><RelativeTime at={new Date(lesson.became.at).toISOString()} /></span></>}</li>
    : list === "retired" ? <li>{RETIRED_STATUS[lesson.status] ?? "No longer used"}{reasonWords(lesson.rejectedReason) === undefined ? "" : `: ${reasonWords(lesson.rejectedReason)!.toLowerCase()}`}</li> : <li>{usageWords(lesson)}</li>}
   {list === "proposed" && lesson.supportTasks > 0 && <li className="rv-muted">Rovara was corrected on this {lesson.supportTasks === 1 ? "once" : `${lesson.supportTasks} times`}.</li>}
   {lesson.trial === "trial" && <li>On trial</li>}
   {lesson.needs !== undefined && lesson.needs.required === 2 && list === "proposed" && <li>{lesson.needs.have === 1 ? "One person kept it; needs one more" : "Needs two people to keep it"}</li>}
   {lesson.citations.slice(0, 3).map((one, index) => { const words = citationWords(one); return <li key={index}>{words.href === undefined ? <span className="mono"><VisibleText text={words.text} /></span> : <a href={words.href} target="_blank" rel="noreferrer">{words.text}</a>}</li>; })}
  </ul>
  {list === "proposed" && relationWords(lesson, () => undefined).map(words => <p key={words} className="rv-lesson-relation"><VisibleText text={words} /></p>)}
  {expiry !== undefined && <p className={"rv-lesson-expiry" + (expiry.soon ? " soon" : "")}>{expiry.soon && <span className="rv-tone-dot" data-tone="wait" aria-hidden="true" />}{expiry.text}</p>}
  {actions}
  {list === "proposed" && lesson.canApprove && lesson.contradicts !== undefined && action.kind === "idle" && <BothPlaces project={project} lesson={lesson} />}
  {action.kind === "error" && <p role="alert" className="rv-lesson-failed"><VisibleText text={action.text} /></p>}
 </article></li>;
}

const EMPTY: Record<LessonList, string> = {
 approved: "No approved lessons yet. When people keep a proposed lesson, it shows here and guides future tasks.",
 proposed: "Nothing waits for a decision.",
 retired: "No lessons have been retired, dropped or lapsed.",
};

/** Scrolls to the lesson a "Last suggestion" link named, loading more pages until it is found or the list ends. */
function useFocusLesson(focus: string | undefined, found: boolean, hasNext: boolean, fetching: boolean, fetchNext: () => void) {
 useEffect(() => {
  if (focus === undefined) return;
  if (found) { document.getElementById("learned-" + focus)?.scrollIntoView?.({ block: "center" });return; }
  if (hasNext && !fetching) fetchNext();
 }, [focus, found, hasNext, fetching, fetchNext]);
}

function LessonsList({ project, list, onOff, focus }: { project: string; list: LessonList; onOff: () => void; focus?: string | undefined }) {
 const read = useLessonPages(project, list), off = read.isError && lessonsOff(read.error);
 useEffect(() => { if (off) onOff(); }, [off, onOff]);
 const loaded = read.data?.pages.flatMap(one => one.lessons) ?? [], focusFound = focus !== undefined && loaded.some(lesson => lesson.id === focus);
 const fetchNext = useCallback(() => { void read.fetchNextPage(); }, [read]);
 useFocusLesson(focus, focusFound, read.hasNextPage, read.isFetchingNextPage, fetchNext);
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
  {focus !== undefined && !focusFound && !read.hasNextPage && <p role="status" className="rv-learned-note" data-testid="focus-missing">That lesson isn't in the approved list now. It may be waiting for a decision, or retired or dropped.</p>}
  {last?.partial && <p className="rv-muted rv-learned-note">Some lessons took too long to read. Load more to see the rest.</p>}
  {read.hasNextPage && <Button busy={read.isFetchingNextPage} onClick={() => { void read.fetchNextPage(); }}>Load more</Button>}
 </>;
}

/** One folder of the tree: its name and count, and the folders below it (open down to the second level, and along the picked path). The fold is its own button beside the one that picks the folder. */
function AreaFolder({ node, repo, pick, onPick, depth }: { node: LessonAreaNode; repo: string | null; pick: AreaPick | undefined; onPick: (next: AreaPick) => void; depth: number }) {
 const picked = pick?.kind === "folder" && pick.repo === repo && pick.folder === node.path.slice(0, -1);
 const onPath = pick?.kind === "folder" && pick.repo === repo && (pick.folder + "/").startsWith(node.path);
 const [open, setOpen] = useState(depth < 2 || onPath), shown = open || onPath;
 const folds = node.children.length > 0;
 return <li><div className="rv-area-row">
  {folds ? <button type="button" className="rv-area-fold" aria-expanded={shown} aria-label={(shown ? "Hide" : "Show") + " the folders in " + node.name} onClick={() => setOpen(!shown)}>{shown ? "\u25BE" : "\u25B8"}</button> : <span className="rv-area-fold" aria-hidden="true" />}
  <button type="button" aria-current={picked ? "true" : undefined} onClick={() => onPick({ kind: "folder", repo, folder: node.path.slice(0, -1) })}><span><VisibleText text={node.name + "/"} /></span><span className="rv-area-count">{node.lessons}</span></button>
 </div>
  {folds && shown && <ul>{node.children.map(child => <AreaFolder key={child.path} node={child} repo={repo} pick={pick} onPick={onPick} depth={depth + 1} />)}</ul>}
  {folds && shown && node.moreChildren !== undefined && <p className="rv-muted rv-learned-note">{node.moreChildren} more folders</p>}</li>;
}

function AreaRepo({ one, pick, onPick }: { one: LessonAreaRepo; pick: AreaPick | undefined; onPick: (next: AreaPick) => void }) {
 const picked = pick?.kind === "folder" && pick.repo === one.repo && pick.folder === "";
 return <li className="rv-area-repo"><button type="button" aria-current={picked ? "true" : undefined} onClick={() => onPick({ kind: "folder", repo: one.repo, folder: "" })}><span><VisibleText text={one.repo ?? "Any repository"} /></span><span className="rv-area-count">{one.lessons}</span></button>
  {one.children.length > 0 && <ul>{one.children.map(child => <AreaFolder key={child.path} node={child} repo={one.repo} pick={pick} onPick={onPick} depth={1} />)}</ul>}
  {one.moreChildren !== undefined && <p className="rv-muted rv-learned-note">{one.moreChildren} more folders</p>}</li>;
}

export const areaTitle = (pick: AreaPick) => (pick.kind === "whole" ? "Whole project" : `${pick.repo ?? "Any repository"}${pick.folder === "" ? "" : "/" + pick.folder + "/"}`);

/** The approved lessons by code area: a tree of repositories and folders (the customer's own layout), and the lessons of the one picked. "Whole project" holds those that name no area. */
function AreaBrowser({ project, tree }: { project: string; tree: ReturnType<typeof useLessonAreas> }) {
 const [pick, setPick] = useState<AreaPick>(), chosen = useLessonAreas(project, pick, pick !== undefined);
 if (tree.isPending) return <Skeleton label="Loading lessons by code area" />;
 if (tree.isError) return <div role="alert" className="rv-section-error"><p><VisibleText text={failureWords(tree.error, "Couldn't load the lessons by code area. Try again.")} /></p><Button onClick={() => { void tree.refetch(); }}>Try again</Button></div>;
 const data = tree.data, selection = chosen.data?.selection;
 if (data.total === 0) return <p className="rv-muted">{EMPTY.approved}</p>;
 return <div className="rv-areas" data-testid="areas">
  <nav className="rv-areas-nav" aria-label="Code areas">
   <ul>
    {data.repos.map(one => <AreaRepo key={one.repo ?? "*"} one={one} pick={pick} onPick={setPick} />)}
    {data.wholeProject > 0 && <li className="rv-area-repo"><button type="button" aria-current={pick?.kind === "whole" ? "true" : undefined} onClick={() => setPick({ kind: "whole" })}><span>Whole project</span><span className="rv-area-count">{data.wholeProject}</span></button></li>}
   </ul>
  </nav>
  <div className="rv-areas-main" aria-live="polite">
   {pick === undefined ? <p className="rv-areas-pick">Pick a repository or folder to see what Rovara was taught about it. {data.total} approved {data.total === 1 ? "lesson" : "lessons"} in all.</p>
    : chosen.isPending ? <Skeleton label="Loading lessons" />
    : chosen.isError ? <p role="alert" className="rv-lesson-failed"><VisibleText text={failureWords(chosen.error, "Couldn't load that area.")} /></p>
    : <>
     <h3 className="rv-areas-pick" data-testid="area-title"><VisibleText text={areaTitle(pick)} /> <span className="rv-muted">({selection?.lessons.length ?? 0}{selection?.moreLessons === undefined ? "" : " of " + String((selection?.lessons.length ?? 0) + selection.moreLessons)})</span></h3>
     {selection === undefined || selection.lessons.length === 0 ? <p className="rv-muted">No approved lessons here.</p>
      : <ul className="rv-learned-list" aria-label={"Lessons for " + areaTitle(pick)}>{selection.lessons.map(lesson => <LearnedLesson key={lesson.id} project={project} lesson={lesson} list="approved" />)}</ul>}
     {selection?.moreLessons !== undefined && <p className="rv-muted rv-learned-note">{selection.moreLessons} more are not listed here. Use the full list.</p>}
    </>}
   {data.partial === true && <p className="rv-muted rv-learned-note">This project has more lessons than are counted here. Use the full list for all of them.</p>}
  </div>
 </div>;
}

/** The Approved tab: by code area (the default) or the flat list. A "Last suggestion" link opens the flat list at that lesson. */
function ApprovedView({ project, onOff, view, setView, focus }: { project: string; onOff: () => void; view: "area" | "all"; setView: (view: "area" | "all") => void; focus: string | undefined }) {
 const tree = useLessonAreas(project, undefined), off = tree.isError && lessonsOff(tree.error);
 useEffect(() => { if (off) onOff(); }, [off, onOff]);
 // An older Code (or one with lessons off for the company) has no area browse: the Approved tab is the full list, exactly as before.
 if (off) return null;
 if (tree.isError && areasAbsent(tree.error)) return <LessonsList project={project} list="approved" onOff={onOff} focus={focus} />;
 return <>
  <div className="rv-areas-view" role="group" aria-label="How to browse approved lessons">
   <Button variant={view === "area" ? "primary" : "quiet"} aria-pressed={view === "area"} onClick={() => setView("area")}>By code area</Button>
   <Button variant={view === "all" ? "primary" : "quiet"} aria-pressed={view === "all"} onClick={() => setView("all")}>All lessons</Button>
  </div>
  {view === "area" ? <AreaBrowser project={project} tree={tree} /> : <LessonsList project={project} list="approved" onOff={onOff} focus={focus} />}
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
 const [view, setView] = useState<"area" | "all">("area"), [focus, setFocus] = useState<string>();
 const showExample = useCallback((lessonId: string) => { setTab("approved");setView("all");setFocus(lessonId); }, [setTab, setView, setFocus]);
 const mode = useLessonMode(project), isOff = off || (mode.isError && lessonsOff(mode.error));
 return <section className="rv-learned" aria-labelledby="learned-title" data-testid="learned">
  <header><h2 id="learned-title">Learned</h2><p className="rv-muted">Lessons Rovara learned from this project's corrections. Approved lessons are given to future tasks where they fit.</p><RepeatsLine project={project} /></header>
  {isOff ? <p className="rv-learned-off" data-testid="lessons-off">{OFF_TEXT}</p> : <>
   <ThisWeek project={project} />
   <TeamRules project={project} />
   <ModeRow project={project} />
   <TrialOfferCard project={project} />
   <WeeklySummaryRow project={project} mode={mode.data?.effective ?? "off"} />
   <RetireRequests project={project} />
   <Tabs label="Lessons" value={tab} onValueChange={value => setTab(value as LessonList)} items={[
    { value: "approved", label: "Approved", content: <ApprovedView project={project} onOff={markOff} view={view} setView={next => { setView(next);setFocus(undefined); }} focus={focus} /> },
    { value: "proposed", label: "Proposed", content: <LessonsList project={project} list="proposed" onOff={markOff} /> },
    { value: "retired", label: "Retired", content: <LessonsList project={project} list="retired" onOff={markOff} /> },
   ]} />
   <LearningSources project={project} onExample={showExample} />
   <LessonChecks project={project} />
  </>}
 </section>;
}
