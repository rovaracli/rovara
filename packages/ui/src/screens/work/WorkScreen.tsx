import { useEffect, useMemo, useRef } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { useDecisions } from "../../api/decisions.js";
import { ApiError } from "../../api/errors.js";
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
 const own = useMemo(() => (tasks.data === undefined || decisions.isPending ? [] : workRows(tasks.data, decisions.data ?? [], new Date())), [tasks.data, decisions.data, decisions.isPending]);
 // The tasks the person was added to (web task channel K4): their own group at the end. They never wait the page: the person's own work shows first, and a task already in the person's own list is not shown twice.
 const added = useMemo(() => { const mine = new Set((tasks.data ?? []).map(task => task.taskId));return involved.data === undefined || tasks.data === undefined ? [] : involvedRows(involved.data.filter(task => !mine.has(task.taskId)), new Date()); }, [involved.data, tasks.data]);
 const rows = useMemo(() => [...own, ...added], [own, added]);
 // The lesson batches (DEC 231b): one row per project under "Needs you". Lessons that are off, or a Code without the lessons API, add no row; any other failure says so quietly.
 const batches = useMemo(() => (inbox.data?.state === "on" ? inbox.data.batches : []), [inbox.data]);
 const wanted = params.get("task"), selectedBatch = batches.find(batch => batchId(batch.project) === wanted);
 const selected = selectedBatch !== undefined ? undefined : rows.find(row => row.id === wanted) ?? (wanted !== null && involved.isPending ? undefined : rows[0]);
 const shownBatch = selectedBatch ?? (selected === undefined && !tasks.isPending ? batches[0] : undefined);
 const inboxFailed = inbox.isError && !lessonsOff(inbox.error) && !notServed(inbox.error);
 const rowsRef = useRef(rows), heading = useRef<HTMLHeadingElement>(null);
 // The page is a lazy chunk: its heading takes focus when it arrives, so a keyboard or screen-reader user starts at the top of the page.
 useEffect(() => { heading.current?.focus(); }, []);
 useEffect(() => { rowsRef.current = rows; }, [rows]);
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
 const listBody = tasks.isPending || (decisions.isPending && !tasks.isError) ? <Skeleton label="Loading your work" />
  : error !== undefined ? <div className="rv-work-error" role="alert" data-testid="load-error"><div className="rv-banner rv-banner-danger"><span><b>{error instanceof ApiError && error.status === 501 ? "Work isn't available yet." : "Couldn't load your work."}</b> <VisibleText text={error instanceof ApiError ? error.message : "Nothing is lost. Running tasks keep going, and chat messages still arrive."} /></span><Button onClick={() => { void tasks.refetch(); }}>Try again</Button></div></div>
  : rows.length === 0 && batches.length === 0 ? <EmptyState testId="work-empty" title="No work yet" description="Start a task from a project. It appears here, and a card appears when it needs a decision." />
  : <WorkList rows={rows} selectedId={shownBatch !== undefined ? batchId(shownBatch.project) : selected?.id} onSelect={select} onOpen={id => { const row = rows.find(entry => entry.id === id), page = row === undefined ? undefined : fullPage(row);if (page !== undefined) void navigate(page); }} decisionsFailed={decisions.isError} lessonBatches={batches} />;
 return <section className="rv-work" data-testid="work">
  <section className="rv-work-list" aria-label="Work list">
   <div className="rv-work-head"><h1 ref={heading} tabIndex={-1} data-testid="work-title">Work</h1><span className="rv-muted rv-work-hint">With the list focused: <kbd>J</kbd> <kbd>K</kbd> move, <kbd>O</kbd> opens</span></div>
   {spend.data !== undefined && <div className="rv-work-banner"><BudgetBanner remainingUsd={spend.data} canRaise={isAdmin} /></div>}
   <AgentsRow />
   {decisions.isError && !tasks.isPending && <p className="rv-muted rv-work-note" role="status" data-testid="decisions-unavailable"><VisibleText text={decisions.error instanceof ApiError ? decisions.error.message : "Decisions couldn't be loaded."} /></p>}
   {involved.isError && !tasks.isPending && <p className="rv-muted rv-work-note" role="status" data-testid="involved-unavailable">Tasks you're involved in couldn't be loaded.</p>}
   {inboxFailed && !tasks.isPending && <p className="rv-muted rv-work-note" role="status" data-testid="lessons-unavailable">Lessons to review couldn't be loaded.</p>}
   {!inboxFailed && inbox.data !== undefined && inbox.data.unavailable.length > 0 && <p className="rv-muted rv-work-note" role="status" data-testid="lessons-unavailable">Lessons to review couldn't be loaded for <VisibleText text={inbox.data.unavailable.join(", ")} />.</p>}
   {listBody}
  </section>
  <section className="rv-work-pane" aria-label="Selected task">
   {shownBatch !== undefined ? <LessonBatchCard key={"lessons:" + shownBatch.project} batch={shownBatch} onDone={() => { const next = new URLSearchParams(params);next.delete("task");setParams(next, { replace: true });void query.invalidateQueries({ queryKey: ["learned", "inbox"] }); }} />
    : selected !== undefined ? <TaskPane key={selected.id} row={selected} fullPage={fullPage(selected)} decisionsError={decisions.isError ? decisions.error : undefined} onDecided={onDecided} />
    : <div className="rv-empty">{tasks.isPending || decisions.isPending ? "Loading…" : "Select a task once your work has loaded."}</div>}
  </section>
 </section>;
}
