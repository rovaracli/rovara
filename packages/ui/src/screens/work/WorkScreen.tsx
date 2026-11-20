import { useEffect, useMemo, useRef } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { useDecisions } from "../../api/decisions.js";
import { ApiError, NOT_AVAILABLE_YET } from "../../api/errors.js";
import { involvedRows, nextNeedsYou, useInvolvedTasks, useOrgSpend, useWorkTasks, workRows } from "../../api/work.js";
import { useAppHost } from "../../host.js";
import { paths } from "../../paths.js";
import { useAnnounce } from "../../design/Announcer.js";
import { BudgetBanner } from "../../design/BudgetBanner.js";
import { Button } from "../../design/Button.js";
import { EmptyState } from "../../design/EmptyState.js";
import { Skeleton } from "../../design/Skeleton.js";
import { VisibleText } from "../../design/VisibleText.js";
import { lessonsOff, notServed, useLessonInbox } from "../../api/learned.js";
import { AgentsRow } from "./AgentsRow.js";
import { LessonBatchCard } from "./LessonBatchCard.js";
import { TaskPane } from "./TaskPane.js";
import { WorkList, batchId } from "./WorkList.js";
import "./work.css";

/**
 * Work (Hybrid 1, the split inbox, DEC 223): the dense list of every task stays on the left, the selected task opens on the right, and after a decision the list
 * moves to the next task that needs you. The selection is in the address (`?task=`), so a link opens the same task. Loading, could-not-load and empty are
 * said in the list; a route Code does not serve yet says "isn't connected to Rovara Code yet" there, never a spinner.
 */
export function WorkScreen() {
 const host = useAppHost(), navigate = useNavigate(), [params, setParams] = useSearchParams(), tasks = useWorkTasks(), involved = useInvolvedTasks(), decisions = useDecisions(), inbox = useLessonInbox(), spend = useOrgSpend(), announce = useAnnounce(), query = useQueryClient();
 // The ages and the "waiting over a day" rule are worked out against the clock each time the list or the cards are read again.
 const tasksFresh = tasks.isSuccess && tasks.failureCount === 0, decisionsFresh = decisions.isSuccess && decisions.failureCount === 0;
 const own = useMemo(() => (!tasksFresh || decisions.isPending ? [] : workRows(tasks.data, decisionsFresh ? decisions.data : [], new Date())), [tasksFresh, tasks.data, decisions.data, decisionsFresh, decisions.isPending]);
 // The tasks the person was added to (web task channel K4): their own group at the end. They never wait the page: the person's own work shows first, and a task already in the person's own list is not shown twice.
 const added = useMemo(() => { const mine = new Set((tasks.data ?? []).map(task => task.taskId));return !involved.isSuccess || involved.failureCount > 0 || !tasksFresh ? [] : involvedRows(involved.data.filter(task => !mine.has(task.taskId)), new Date()); }, [involved.data, involved.isSuccess, involved.failureCount, tasks.data, tasksFresh]);
 const rows = useMemo(() => [...own, ...added], [own, added]);
 // The lesson batches (DEC 231b): one row per project under "Needs you". Lessons that are off, or a Code without the lessons API, add no row; any other failure says so quietly.
 const batches = useMemo(() => (inbox.isSuccess && inbox.failureCount === 0 && inbox.data.state === "on" ? inbox.data.batches : []), [inbox.data, inbox.isSuccess, inbox.failureCount]);
 const wanted = params.get("task"), selectedBatch = batches.find(batch => batchId(batch.project) === wanted);
 const filter = params.get("filter") ?? "all", search = params.get("q") ?? "";
 const matches = (title: string, project: string) => (title + " " + project).toLocaleLowerCase().includes(search.trim().toLocaleLowerCase());
 const visible = rows.filter(row => (filter === "running" ? row.group === "run" : filter === "needs-someone" ? row.group === "you" || row.group === "others" : filter === "finished" ? row.group === "done" : true) && matches(row.title, row.project));
 const visibleBatches = filter === "running" || filter === "finished" ? [] : batches.filter(batch => matches("Review lessons", batch.project));
 const selected = selectedBatch !== undefined ? undefined : wanted === null ? visible[0] : rows.find(row => row.id === wanted);
 const shownBatch = selectedBatch ?? (selected === undefined && !tasks.isPending && wanted === null ? visibleBatches[0] : undefined);
 const inboxFailed = inbox.isError && !lessonsOff(inbox.error) && !notServed(inbox.error);
 const restore = useRef<string | null>(null);
 const rowsRef = useRef(rows), heading = useRef<HTMLHeadingElement>(null);
 // The page is a lazy chunk: its heading takes focus when it arrives, so a keyboard or screen-reader user starts at the top of the page.
 useEffect(() => { heading.current?.focus(); }, []);
 useEffect(() => { rowsRef.current = rows; }, [rows]);
 useEffect(() => { if (wanted === null && restore.current !== null) { const button = [...document.querySelectorAll<HTMLButtonElement>("button[data-task-id], button[data-batch]")].find(element => element.dataset.taskId === restore.current || "lessons:" + element.dataset.batch === restore.current);(button ?? heading.current)?.focus();restore.current = null; } }, [wanted]);
 function back() { restore.current = wanted;const next = new URLSearchParams(params);next.delete("task");setParams(next, { replace: true }); }
 function updateFilter(key: string, value: string) { const next = new URLSearchParams(params);if (value === "") next.delete(key);else next.set(key, value);setParams(next, { replace: true }); }
 // A task started in Cloud opens by its session's address (the one people share); any other by its task id.
 // A task the person was only added to has no full page yet: the task page finds a task only in the person's own list until Cloud opens a task by its id (K2), so no link is drawn for it.
 const fullPage = (row: { id: string; group: string; task: { sessionId: string | undefined } }) => (row.group === "involved" ? undefined : paths.session(row.task.sessionId ?? row.id));
 const select = (id: string) => { const next = new URLSearchParams(params);next.set("task", id);setParams(next, { replace: true }); };
 function onDecided(taskId: string) {
  const next = nextNeedsYou(rowsRef.current, taskId), row = rowsRef.current.find(entry => entry.id === next);
  void query.invalidateQueries({ queryKey: ["work"] });
  if (next !== undefined && row !== undefined) { select(next);announce("Moved to " + row.title); }
 }
 const error = tasks.isError ? tasks.error : undefined, isAdmin = host.kind === "web" && host.features.admin;
 const routeUnavailable = error instanceof ApiError && error.status === 501 && error.code === "NOT_ON_CODE_YET" && error.message === NOT_AVAILABLE_YET;
 const listBody = tasks.isPending || (decisions.isPending && !tasks.isError) ? <Skeleton label="Loading your work" />
  : error !== undefined ? <div className="rv-work-error" role="alert" data-testid="load-error"><div className="rv-banner rv-banner-danger"><span><b>{error instanceof ApiError && error.status === 501 ? "Work isn't available yet." : "Couldn't load your work."}</b> <VisibleText text={error instanceof ApiError ? (routeUnavailable ? "The Work page is not available on this installation. This does not stop existing tasks. Contact your Rovara administrator." : error.message) : "The work list could not be refreshed. This read failure does not stop the tasks."} /></span><Button onClick={() => { void tasks.refetch(); }}>Try again</Button></div></div>
  : rows.length === 0 && batches.length === 0 ? <EmptyState testId="work-empty" title="No work yet" description="No tasks are shown in the available reads. Rovara can't tell yet whether this is your complete work history." />
  : visible.length === 0 && visibleBatches.length === 0 ? <div className="rv-empty" role="status">No tasks match this filter. <Button onClick={() => { const next = new URLSearchParams(params);next.delete("filter");next.delete("q");setParams(next, { replace: true }); }}>Clear filters</Button></div>
  : <WorkList rows={visible} selectedId={tasksFresh && shownBatch !== undefined ? batchId(shownBatch.project) : selected?.id} onSelect={select} onOpen={id => { const row = rows.find(entry => entry.id === id), page = row === undefined ? undefined : fullPage(row);if (page !== undefined) void navigate(page); }} decisionsFailed={decisions.isError} lessonBatches={visibleBatches} />;
 return <section className="rv-work" data-testid="work" data-detail-open={wanted !== null && !tasks.isError}>
  {(decisions.isError || involved.isError || inboxFailed || (inbox.isSuccess && inbox.data.unavailable.length > 0)) && !tasks.isPending && <div className="rv-work-read-notes">
   {decisions.isError && !tasks.isPending && <p className="rv-muted rv-work-note" role="status" data-testid="decisions-unavailable"><VisibleText text={decisions.error instanceof ApiError ? decisions.error.message : "Decisions couldn't be loaded."} /> This is not a confirmed empty queue. <Button onClick={() => { void decisions.refetch(); }}>Reload decisions</Button></p>}
   {involved.isError && !tasks.isPending && <p className="rv-muted rv-work-note" role="status" data-testid="involved-unavailable">Tasks you're involved in couldn't be loaded. The rest of the list is incomplete. <Button onClick={() => { void involved.refetch(); }}>Load shared tasks again</Button></p>}
   {inboxFailed && !tasks.isPending && <p className="rv-muted rv-work-note" role="status" data-testid="lessons-unavailable">Lessons needing your review could not be loaded. This does not mean there are none. <Button onClick={() => { void inbox.refetch(); }}>Reload lessons</Button></p>}
   {!inboxFailed && inbox.isSuccess && inbox.data.unavailable.length > 0 && <p className="rv-muted rv-work-note" role="status" data-testid="lessons-unavailable">Lessons to review couldn't be loaded for <VisibleText text={inbox.data.unavailable.join(", ")} />.</p>}
  </div>}
  <section className="rv-work-list" aria-label="Work list">
   <div className="rv-work-head"><h1 ref={heading} tabIndex={-1} data-testid="work-title">Work</h1><span className="rv-muted rv-work-hint">With the list focused: <kbd>J</kbd> <kbd>K</kbd> move, <kbd>O</kbd> opens</span></div>
   <p className="rv-work-note rv-muted">Tasks shown from your available reads. Rovara can't tell yet whether this is your complete work history.</p>
   <div className="rv-work-filters" role="group" aria-label="Filter work">{([["all", "All"], ["running", "Running"], ["needs-someone", "Needs someone"], ["finished", "Finished"]] as const).map(([id, label]) => <button key={id} type="button" aria-pressed={filter === id} onClick={() => updateFilter("filter", id)}>{label}</button>)}</div>
   <label className="rv-work-search">Search work<input type="search" value={search} onChange={event => updateFilter("q", event.currentTarget.value)} /></label>
   {spend.isSuccess && spend.failureCount === 0 && spend.data !== undefined && <div className="rv-work-banner"><BudgetBanner remainingUsd={spend.data} canRaise={isAdmin} /></div>}
   <AgentsRow />
   {listBody}
  </section>
  <section className="rv-work-pane" aria-label="Selected task">
   {wanted !== null && <Button variant="quiet" onClick={back}>Back to Work</Button>}
   {tasksFresh && shownBatch !== undefined ? <LessonBatchCard key={"lessons:" + shownBatch.project} batch={shownBatch} onDone={() => { const next = new URLSearchParams(params);next.delete("task");setParams(next, { replace: true });void query.invalidateQueries({ queryKey: ["learned", "inbox"] }); }} />
    : tasksFresh && selected !== undefined ? <TaskPane key={selected.id} row={selected} fullPage={fullPage(selected)} decisionsError={decisions.isError ? decisions.error : undefined} onDecided={onDecided} />
    : wanted !== null && tasksFresh && !involved.isPending ? <p role="status" className="rv-empty" data-testid="work-selection-unavailable">Rovara can't tell yet which task this link refers to. Choose a task from the current list.</p> : <div className="rv-empty">{tasks.isPending || decisions.isPending ? "Loading…" : "Select a task once your work has loaded."}</div>}
  </section>
 </section>;
}
