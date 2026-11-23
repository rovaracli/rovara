import { QueueActions } from "./QueueActions.js";
import { useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useWorkAdvance } from "./useWorkAdvance.js";
import { useNavigate, useSearchParams } from "react-router";
import { useDecisions } from "../../api/decisions-read.js";
import { ApiError, NOT_AVAILABLE_YET } from "../../api/errors.js";
import { involvedRows, useInvolvedTasks, useOrgSpend, useWorkTasks, workRows, type WorkRow } from "../../api/work-read.js";
import { useAppHost } from "../../host.js";
import { paths } from "../../paths.js";
import { BudgetBanner } from "../../design/BudgetBanner.js";
import { Button } from "../../design/Button.js";
import { PageHeader } from "../../design/PageHeader.js";
import { HeldState } from "../../design/HeldState.js";
import { Skeleton } from "../../design/Skeleton.js";
import { VisibleText } from "../../design/VisibleText.js";
import { lessonsOff, notServed, useLessonInbox } from "../../api/learned-read.js";
import { servedReadState } from "../../api/served-read.js";
import { StaleReads } from "./StaleReads.js";
import { AgentsRow } from "./AgentsRow.js";
import { LessonBatchCard } from "./LessonBatchCard.js";
import { QueuePeek } from "./queue-preview.js";
import { WorkPeek } from "./WorkPeek.js";
import { WorkPreviewList, batchId } from "./WorkPreviewList.js";
import { BackButton, ErrorBlock, readFailureTodo, readFailureWords, QueueEmpty, QueueTabs, QuietNote, updatedWords, useNow } from "./queue-preview.js";
import "./work.css";
import "./work-preview.css";

const FILTERS = [["all", "All"], ["running", "Running"], ["needs-someone", "Needs someone"], ["finished", "Finished"]] as const;
const isRunning = (row: WorkRow) => row.group === "run" && row.task.detailUnread !== true && row.task.status !== "STARTING" && (row.task.workflow?.state === "RUNNING" || row.task.status === "RUNNING");
const inFilter = (filter: string, row: WorkRow) => (filter === "running" ? isRunning(row) : filter === "needs-someone" ? row.group === "you" || row.group === "others" : filter === "finished" ? row.group === "done" : true);

/**
 * Work (boards 2c and 2f): every task in one table, the selected task as a short peek beside it, and on a phone the full-width view with Back. After the list loads the
 * first task is selected. The selection is in the address (`?task=`), so a link opens the same task. Loading, could-not-load and empty are said in the list; a route Code
 * does not serve yet says so there, never a spinner. The peek and inline questions reuse the live handlers; retained facts never grant write authority.
 */
export function WorkPreviewScreen() { return <QueueActions><WorkPreviewContent /></QueueActions>; }
function WorkPreviewContent() {
 const host = useAppHost(), navigate = useNavigate(), [params, setParams] = useSearchParams(), tasks = useWorkTasks(), involved = useInvolvedTasks(), decisions = useDecisions(), inbox = useLessonInbox(), spend = useOrgSpend(), now = useNow();
 const keptTasks = servedReadState(tasks), keptDecisions = servedReadState(decisions), keptInvolved = servedReadState(involved), keptLessons = servedReadState(inbox), keptSpend = servedReadState(spend);
 const query = useQueryClient();
 const [searching, setSearching] = useState(false);
 // The ages and the "waiting over a day" rule are worked out against the clock each time the list or the cards are read again.
 const tasksFresh = tasks.isSuccess && tasks.failureCount === 0, decisionsFresh = decisions.isSuccess && decisions.failureCount === 0;
 const own = useMemo(() => (keptTasks.data === undefined || decisions.isPending ? [] : workRows(keptTasks.data, keptDecisions.data ?? [], new Date())), [keptTasks.data, keptDecisions.data, decisions.isPending]);
 // The tasks the person was added to (web task channel K4): they never wait the page, and a task already in the person's own list is not shown twice.
 const added = useMemo(() => { const mine = new Set((tasks.data ?? []).map(task => task.taskId));return keptInvolved.data === undefined || keptTasks.data === undefined ? [] : involvedRows(keptInvolved.data.filter(task => !mine.has(task.taskId)), new Date()); }, [keptInvolved.data, keptTasks.data, tasks.data]);
 const rows = useMemo(() => [...own, ...added], [own, added]);
 // The lesson batches (DEC 231b): one row per project. Lessons that are off, or a Code without the lessons API, add no row; any other failure says so quietly.
 const batches = useMemo(() => (keptLessons.data?.state === "on" ? keptLessons.data.batches : []), [keptLessons.data]);
 const wanted = params.get("task"), selectedBatch = batches.find(batch => batchId(batch.project) === wanted);
 const filter = params.get("filter") ?? "all", search = params.get("q") ?? "";
 const matches = (title: string, project: string) => (title + " " + project).toLocaleLowerCase().includes(search.trim().toLocaleLowerCase());
 const visible = rows.filter(row => inFilter(filter, row) && matches(row.title, row.project));
 const visibleBatches = filter === "running" || filter === "finished" ? [] : batches.filter(batch => matches("Review lessons", batch.project));
 const selected = selectedBatch !== undefined ? undefined : wanted === null ? visible[0] : rows.find(row => row.id === wanted);
 const shownBatch = selectedBatch ?? (selected === undefined && !tasks.isPending && wanted === null ? visibleBatches[0] : undefined);
 const inboxFailed = inbox.isError && !lessonsOff(inbox.error) && !notServed(inbox.error);
 const restore = useRef<string | null>(null), heading = useRef<HTMLDivElement>(null);
 // The page is a lazy chunk: its heading takes focus when it arrives (unless a task is already open), so a keyboard or screen-reader user starts at the top of the page.
 useEffect(() => { if (wanted === null) heading.current?.focus(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
 useEffect(() => { if (wanted === null && restore.current !== null) { const button = [...document.querySelectorAll<HTMLButtonElement>("button[data-task-id], button[data-batch]")].find(element => element.dataset.taskId === restore.current || "lessons:" + element.dataset.batch === restore.current);(button?.closest("tr") ?? button ?? heading.current)?.focus();restore.current = null; } }, [wanted]);
 function back() { restore.current = wanted;const next = new URLSearchParams(params);next.delete("task");setParams(next, { replace: true }); }
 function updateFilter(key: string, value: string) { const next = new URLSearchParams(params);if (value === "") next.delete(key);else next.set(key, value);setParams(next, { replace: true }); }
 // A task started in Cloud opens by its session's address (the one people share); any other by its task id.
 const fullPage = (row: { id: string; task: { sessionId: string | undefined } }) => paths.session(row.task.sessionId ?? row.id);
 const select = (id: string) => { const next = new URLSearchParams(params);next.set("task", id);setParams(next, { replace: true }); };
 const onDecided = useWorkAdvance(rows, select);
 const error = tasks.isError ? tasks.error : undefined, isAdmin = host.kind === "web" && host.features.admin;
 const routeUnavailable = error instanceof ApiError && error.status === 501 && error.code === "NOT_ON_CODE_YET" && error.message === NOT_AVAILABLE_YET;
 // A count is shown only from a current read; a failed or loading list has none.
 const counted = tasksFresh && decisionsFresh && inbox.isSuccess && inbox.failureCount === 0;
 const tabs = FILTERS.map(([key, label]) => ({ key, label, count: counted ? String(rows.filter(row => inFilter(key, row)).length + (key === "all" || key === "needs-someone" ? batches.length : 0)) : undefined }));
 const updated = tasksFresh && tasks.dataUpdatedAt > 0 ? updatedWords(new Date(tasks.dataUpdatedAt).toISOString(), now) : "";
 const shown = visible.length + visibleBatches.length, all = rows.length + batches.length;
 const summary = [counted ? (shown === all ? `${String(all)} ${all === 1 ? "task" : "tasks"} shown` : `${String(shown)} of ${String(all)} tasks shown`) : "", updated].filter(part => part !== "").join(" · ");
 const listBody = tasks.isPending || (decisions.isPending && !tasks.isError) ? <Skeleton label="Loading your work" />
  : error !== undefined && keptTasks.data === undefined ? <ErrorBlock live="alert" testId="load-error" title={error instanceof ApiError && error.status === 501 ? "Work isn't available yet." : "Rovara couldn't load your tasks."} onRetry={() => { void tasks.refetch(); }} refCode="WORK-LIST-UNREAD" todo={readFailureTodo(error)}><VisibleText text={routeUnavailable ? "The Work page is not available on this installation. This does not stop existing tasks. Contact your Rovara administrator." : readFailureWords(error, "The work list could not be refreshed. This read failure does not stop the tasks.")} /></ErrorBlock>
  : rows.length === 0 && batches.length === 0 ? <QueueEmpty testId="work-empty" title="No work yet">No tasks are shown. Rovara can't tell yet whether this is your complete work history.</QueueEmpty>
  : visible.length === 0 && visibleBatches.length === 0 ? <section className="rv-qp-empty" role="status"><h2>No tasks match this filter</h2><p>Clear the filter to see every task shown.</p><Button onClick={() => { const next = new URLSearchParams(params);next.delete("filter");next.delete("q");setParams(next, { replace: true }); }}>Clear filters</Button></section>
  : <WorkPreviewList rows={visible} now={now} selectedId={tasksFresh && shownBatch !== undefined ? batchId(shownBatch.project) : selected?.id} onSelect={select} onOpen={id => { const row = rows.find(entry => entry.id === id), page = row === undefined ? undefined : fullPage(row);if (page !== undefined) void navigate(page); }} lessonBatches={visibleBatches} current={tasksFresh} />;
 const peek = keptTasks.data !== undefined && shownBatch !== undefined ? <QueuePeek key={"lessons:" + shownBatch.project} label="Selected lessons" backLabel="Back to Work" onBack={back} project={shownBatch.project} updated="" title="Review lessons" status={null}><fieldset disabled={!inbox.isSuccess || inbox.failureCount > 0} className="rv-qp-action-fields"><LessonBatchCard batch={shownBatch} frozen={!inbox.isSuccess || inbox.failureCount > 0} onDone={() => { back();void query.invalidateQueries({ queryKey: ["learned", "inbox"] }); }} /></fieldset></QueuePeek>
  : keptTasks.data !== undefined && selected !== undefined ? <WorkPeek key={selected.id} row={selected} now={now} back={back} current={tasksFresh && decisionsFresh} onDecided={onDecided} decisionsError={decisions.isError ? decisions.error : undefined} />
  : wanted !== null && tasksFresh && !involved.isPending ? <section className="rv-qp-peek rv-qp-peek-plain" aria-label="Selected task"><BackButton label="Back to Work" onClick={back} /><p role="status" data-testid="work-selection-unavailable">Rovara can't tell yet which task this link refers to. Choose a task from the current list.</p></section> : null;
 return <section className="rv-qp rv-work-preview" data-testid="work" data-peek={peek !== null} data-peek-wide={shownBatch !== undefined} data-detail-open={wanted !== null && !tasks.isError}>
  <section className="rv-qp-main" aria-label="Work list">
   <div ref={heading} tabIndex={-1} className="rv-qp-heading"><PageHeader title="Work" {...(summary !== "" ? { description: summary + "." } : {})} actions={<div className="rv-qp-search"><button type="button" className="rv-qp-search-toggle" aria-label="Show search" aria-expanded={searching || search !== ""} onClick={() => setSearching(open => !open)}><svg aria-hidden="true" focusable="false" viewBox="0 0 16 16" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="6.5" cy="6.5" r="4.5" /><path d="m10 10 4 4" /></svg></button><label className="rv-qp-search-field" data-open={searching || search !== ""}><span className="rv-qp-search-label">Search work</span><input type="search" placeholder="Search work" value={search} onChange={event => updateFilter("q", event.currentTarget.value)} /></label></div>} /></div>
   {visible.length + visibleBatches.length > 0 && tasksFresh && <p className="rv-qp-scope"><HeldState /> <span>Rovara can't tell yet whether this is your complete work history.</span></p>}
   {(decisions.isError || involved.isError || inboxFailed || (inbox.isSuccess && inbox.data.unavailable.length > 0)) && !tasks.isPending && <div className="rv-qp-notes">
    {decisions.isError && !tasks.isError && <ErrorBlock testId="decisions-unavailable" title="Rovara couldn't read your decisions." retryLabel="Reload decisions" onRetry={() => { void decisions.refetch(); }} refCode="WORK-DECISIONS-UNREAD" todo={readFailureTodo(decisions.error)}><VisibleText text={readFailureWords(decisions.error, "Decisions couldn't be loaded.")} /> This is not a confirmed empty queue.</ErrorBlock>}
    {involved.isError && <QuietNote testId="involved-unavailable" actionLabel="Load shared tasks again" onAction={() => { void involved.refetch(); }}>Tasks you're involved in couldn't be loaded. The rest of the list is incomplete.</QuietNote>}
    {inboxFailed && <QuietNote testId="lessons-unavailable" actionLabel="Reload lessons" onAction={() => { void inbox.refetch(); }}>Lessons needing your review could not be loaded. This does not mean there are none.</QuietNote>}
    {!inboxFailed && inbox.isSuccess && inbox.data.unavailable.length > 0 && <QuietNote testId="lessons-unavailable">Lessons to review couldn't be loaded for <VisibleText text={inbox.data.unavailable.join(", ")} />.</QuietNote>}
   </div>}
   {keptSpend.data !== undefined && <div className="rv-qp-banner"><BudgetBanner remainingUsd={keptSpend.data} canRaise={isAdmin} /></div>}
   <QueueTabs label="Filter work" value={FILTERS.some(([key]) => key === filter) ? filter : "all"} items={tabs} onSelect={key => updateFilter("filter", key)} />
   <AgentsRow />
   <StaleReads reads={[keptTasks, keptDecisions, keptInvolved, keptLessons, keptSpend]} />
   {listBody}
   {tasksFresh && visible.length > 0 && <p className="rv-qp-hint"><kbd>J</kbd> <kbd>K</kbd> move · <kbd>Enter</kbd> / <kbd>O</kbd> open</p>}
  </section>
  {peek}
 </section>;
}
