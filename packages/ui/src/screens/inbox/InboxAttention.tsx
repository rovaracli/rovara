import { useEffect, useMemo, useRef } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { useQueries, useQuery } from "@tanstack/react-query";
import { AppNavReaderSchema } from "@agentx/contracts/web";
import { createReadClient } from "../../api/read-client.js";
import { useDecisions } from "../../api/decisions-read.js";
import { lessonsOff, notServed, useLessonInbox } from "../../api/learned-read.js";
import { setupChecklistKey, useSetupChecklistReads } from "../../api/setup-checklist-read.js";
import { useWorkTasks, workRows, type WorkRow } from "../../api/work-read.js";
import { servedReadState } from "../../api/served-read.js";
import { useAppHost } from "../../host.js";
import { paths } from "../../paths.js";
import { DataTable, type Column } from "../../design/DataTable.js";
import { StatusChip } from "../../design/StatusChip.js";
import { VisibleText } from "../../design/VisibleText.js";
import { WorkRowStatus } from "../work/WorkRowStatus.js";
import { rowDetail } from "../work/WorkPreviewList.js";
import { ErrorBlock, QueueEmpty, readFailureTodo, readFailureWords, QuietNote, QueuePeek, QueueTabs, shortAge, updatedWords, useNow, type QueueTab } from "../work/queue-preview.js";

type Tab = "needs" | "waiting" | "setup";
export interface AttentionItem { detail: string; next: string | undefined; id: string; title: string; project: string; status: string; summary: string; at: string; work: WorkRow | undefined; href: string }
const NEXT: Readonly<Record<string, string>> = { repos: "add a repo", setupRun: "review setup", evalConfirm: "review AI evals", aiAndSpend: "set up AI and spending", firstTask: "start a task" };

/** Attention is a bounded projection of current personal reads, never a company-wide queue or an all-clear. The preview only navigates. */
export function useInboxAttention(noticesFailed: boolean) {
 const tasks = useWorkTasks(), decisions = useDecisions(), lessons = useLessonInbox(), host = useAppHost(), now = useNow();
 const api = useMemo(() => createReadClient(host), [host]), setup = useSetupChecklistReads();
 const nav = useQuery({ queryKey: ["nav"], retry: false, queryFn: () => api.get("/v1/app/nav", AppNavReaderSchema) });
 const keptTasks = servedReadState(tasks), keptDecisions = servedReadState(decisions), keptLessons = servedReadState(lessons), keptNav = servedReadState(nav);
 const navFresh = nav.isSuccess && nav.failureCount === 0;
 const projects = keptNav.data !== undefined ? keptNav.data.projects.slice(0, 3) : [];
 const checks = useQueries({ queries: projects.map(project => ({ queryKey: setupChecklistKey(project.name), retry: false, queryFn: () => setup.status(project.name) })) });
 const [params, setParams] = useSearchParams(), tab: Tab = params.get("tab") === "waiting" ? "waiting" : params.get("tab") === "setup" ? "setup" : "needs";
 const selectedId = params.get("item");
 const currentTasks = tasks.isSuccess && tasks.failureCount === 0, currentDecisions = decisions.isSuccess && decisions.failureCount === 0;
 const rows = useMemo(() => keptTasks.data !== undefined ? workRows(keptTasks.data, keptDecisions.data ?? [], new Date()) : [], [keptTasks.data, keptDecisions.data]);
 const needs = keptDecisions.data !== undefined ? rows.filter(row => row.group === "you") : [];
 const waiting = keptDecisions.data !== undefined ? rows.filter(row => row.group === "others") : [];
 const batches = keptLessons.data?.state === "on" ? keptLessons.data.batches : [];
 const unfinished = checks.flatMap((read, index) => servedReadState(read).data !== undefined && servedReadState(read).data!.progress.percent < 100 ? [{ project: projects[index]!.name, data: servedReadState(read).data! }] : []);
 const toItem = (row: WorkRow): AttentionItem => ({ detail: rowDetail(row, many), next: row.decision?.card.next.text, id: row.id, title: row.title, project: row.project, status: row.need ?? row.line, summary: row.decision?.card.question ?? row.task.workflow?.blockReason ?? row.line, at: row.updatedAt, work: row, href: paths.session(row.task.sessionId ?? row.id) });

 const many = new Set(rows.map(row => row.project)).size > 1;
 const attention: AttentionItem[] = (tab === "waiting" ? waiting : needs).map(toItem);
 if (tab === "needs") for (const batch of batches) attention.push({ detail: `${String(batch.lessons.length)} lessons shown · Read the proposed lessons in Work`, next: undefined, id: "lessons:" + batch.project, title: "Review lessons", project: batch.project, status: `${String(batch.lessons.length)} lessons shown`, summary: "Read the proposed lessons in Work.", at: "", work: undefined, href: paths.live + "?task=" + encodeURIComponent("lessons:" + batch.project) });
 const selected = attention.find(row => row.id === selectedId);
 const pending = tasks.isPending || decisions.isPending || lessons.isPending;
 // A count is shown only when the reads behind it are current; otherwise the tab says it was not fully checked, never "0".
 const checked = currentTasks && currentDecisions && lessons.isSuccess && lessons.failureCount === 0 && !noticesFailed;
 const needsCount = checked ? needs.length + batches.length : undefined, waitingCount = currentTasks && currentDecisions ? waiting.length : undefined;
 const setupCount = navFresh && projects.length > 0 && checks.every(read => read.isSuccess && read.failureCount === 0) ? unfinished.length : undefined;
 const tabs: QueueTab[] = [
  { key: "needs", label: "Needs you", count: needsCount !== undefined ? String(needsCount) : pending || tasks.isError || decisions.isError ? undefined : "not fully checked" },
  { key: "waiting", label: "Waiting on others", count: waitingCount !== undefined ? String(waitingCount) : undefined },
  { key: "setup", label: "Finish setting up", count: setupCount !== undefined ? String(setupCount) : undefined },
 ];
 function update(key: string, value: string | null) { const next = new URLSearchParams(params);if (value === null) next.delete(key);else next.set(key, value);setParams(next, { replace: true }); }
 function setTab(key: string) { const next = new URLSearchParams(params);next.set("tab", key);next.delete("item");setParams(next, { replace: true }); }
 return { retainedReads: [keptTasks, keptDecisions, keptLessons, keptNav, ...checks.map(read => servedReadState(read))], tasks, decisions, lessons, nav, checks, navFresh, projects, tab, tabs, setTab, selected, selectedId, attention, pending, unfinished, update, now, needsCount, params, setParams };
}
export type InboxAttentionState = ReturnType<typeof useInboxAttention>;

/** Tabs, then the table of items (or the one block that says why there are none). The project-notices failure joins the empty block, so one block speaks. */
export function InboxAttentionSection({ state, noticesFailed, retryNotices }: { state: InboxAttentionState; noticesFailed: boolean; retryNotices: () => void }) {
 const { tasks, decisions, lessons, nav, checks, navFresh, projects, tab, tabs, setTab, selected, attention, pending, unfinished, update, now } = state;
 const navigate = useNavigate(), restore = useRef<string | null>(null);
 const status = (row: AttentionItem) => row.work === undefined ? <StatusChip state="needs_you" /> : <WorkRowStatus row={row.work} />;
 // Back (phone) puts focus on the row that was open.
 useEffect(() => {
  if (selected === undefined && restore.current !== null) { const opener = [...document.querySelectorAll<HTMLButtonElement>("button[data-attention-id]")].find(button => button.dataset.attentionId === restore.current);(opener?.closest("tr") ?? opener)?.focus();restore.current = null; }
 }, [selected]);
 useEffect(() => { if (selected !== undefined) restore.current = selected.id; }, [selected]);
 const columns: readonly Column<AttentionItem>[] = [
  { key: "task", title: "Task", render: row => <button type="button" className="rv-qp-row" data-attention-id={row.id} tabIndex={-1} aria-current={selected?.id === row.id ? "true" : undefined} onClick={event => { event.currentTarget.closest("tr")?.focus();update("item", row.id); }}><strong><VisibleText text={row.title} /></strong><small><span className="rv-qp-proj"><VisibleText text={row.project} /></span><span className="rv-qp-detail"><VisibleText text={row.detail} /></span>{row.at !== "" && <span className="rv-qp-time-inline"> · {shortAge(row.at, now)}</span>}</small></button> },
  { key: "status", title: "Status", render: status },
  { key: "updated", title: "Updated", render: row => row.at !== "" ? <time dateTime={row.at}>{shortAge(row.at, now)}</time> : null },
 ];
 const empty = !pending && attention.length === 0 && !(tab === "needs" && noticesFailed);
 return <section aria-label="Inbox attention" className="rv-qp-attention" data-testid="inbox-attention">
  <QueueTabs label="Show inbox" value={tab} items={tabs} onSelect={setTab} />
  {tab !== "setup" && <>
   {tasks.isError && <ErrorBlock title="Rovara couldn't load your tasks." onRetry={() => { void tasks.refetch(); }} refCode="INBOX-TASKS-UNREAD" todo={readFailureTodo(tasks.error)} live="alert">The task list could not be read. {readFailureWords(tasks.error, "")} Rovara can't tell yet what needs you.</ErrorBlock>}
   {decisions.isError && <ErrorBlock title="Rovara couldn't read your decisions." retryLabel="Reload decisions" onRetry={() => { void decisions.refetch(); }} refCode="INBOX-DECISIONS-UNREAD" todo={readFailureTodo(decisions.error)}>Decisions could not be loaded, so this is not a confirmed empty queue. {readFailureWords(decisions.error, "")} Rovara can't tell yet what needs you.</ErrorBlock>}
   {lessons.isError && !lessonsOff(lessons.error) && !notServed(lessons.error) && <QuietNote actionLabel="Reload lessons" onAction={() => { void lessons.refetch(); }}>Lessons needing your review could not be loaded. This does not mean there are none.</QuietNote>}
   {lessons.isSuccess && lessons.data.unavailable.length > 0 && <QuietNote>Some projects' lessons could not be read. Rovara can't tell yet whether more lessons need review.</QuietNote>}
   {pending && <p className="rv-qp-note" role="status">Reading your attention items…</p>}
   {tab === "needs" && noticesFailed && !pending && attention.length === 0 && !tasks.isError && !decisions.isError && <ErrorBlock title="No task decisions shown. Couldn't check project notices." retryLabel="Check project notices again" onRetry={retryNotices} refCode="INBOX-NOTICES-UNREAD" testId="project-notices-error">Project notices could not be loaded. The inbox may be incomplete, so this is not an all-clear. Rovara can't tell yet whether anything else needs you.</ErrorBlock>}
   {empty && !tasks.isError && !decisions.isError && <QueueEmpty title={navFresh && projects.length === 0 ? "You're not in a project yet" : tab === "waiting" ? "No waiting tasks shown" : "Nothing shown needs you"} link={{ to: paths.live, label: "See Work" }}>{navFresh && projects.length === 0 ? "Work and decisions come from projects. Until an admin adds you to one, nothing can reach this page. " : ""}Rovara can't tell yet whether anything else needs you.</QueueEmpty>}
   {attention.length > 0 && <section aria-label="Attention list" className="rv-qp-table"><DataTable caption="Attention items" columns={columns} rows={attention} rowKey={row => row.id} selection={{ ...(selected === undefined ? {} : { selectedKey: selected.id }), onSelect: id => update("item", id), onOpen: id => { const row = attention.find(item => item.id === id);if (row) void navigate(row.href); } }} /></section>}
   {attention.length > 0 && <p className="rv-qp-hint"><kbd>J</kbd> <kbd>K</kbd> move · <kbd>Enter</kbd> open</p>}
   {state.selectedId !== null && selected === undefined && !pending && <QuietNote>Rovara can't tell yet which item this link refers to. Choose an item from the current list.</QuietNote>}
  </>}
  {tab === "setup" && <section aria-label="Project setup" className="rv-qp-setup">
   {!navFresh && <ErrorBlock title="Rovara couldn't read your projects." retryLabel="Check projects" onRetry={() => { void nav.refetch(); }} refCode="INBOX-PROJECTS-UNREAD" todo={readFailureTodo(nav.error)}>Rovara can't tell yet which project setup you can see. {readFailureWords(nav.error, "")}</ErrorBlock>}
   {navFresh && projects.length === 0 && <><h2>You're not in a project yet</h2><p>Ask your company's admins to add you to a project.</p>{(nav.data?.me.orgRole === "owner" || nav.data?.me.orgRole === "admin") && <Link className="rv-button" to="/app/onboard?step=repositories">Pick repos</Link>}</>}
   {projects.length > 0 && <p className="rv-muted">Setup for up to three projects shown. Rovara can't tell yet whether all company setup is complete.</p>}
   {checks.some(read => read.isPending) && <p role="status">Reading project setup…</p>}
   {checks.some(read => read.isError) && <ErrorBlock title="Rovara couldn't read some project setup." retryLabel="Reload setup" onRetry={() => { for (const read of checks) if (read.isError) void read.refetch(); }} refCode="INBOX-SETUP-UNREAD" todo={readFailureTodo(checks.find(read => read.isError)?.error)}>Some setup could not be read. Rovara can't tell yet what remains.</ErrorBlock>}
   <ol>{unfinished.map(({ project, data }) => <li key={project}><Link to={paths.project(project)}><VisibleText text={project} /></Link><p>{data.progress.percent}% done{data.progress.nextRequired === null ? "." : " · Next: " + (NEXT[data.progress.nextRequired] ?? "open the checklist")}</p></li>)}</ol>
   {navFresh && projects.length > 0 && checks.every(read => read.isSuccess) && unfinished.length === 0 && <p>No unfinished setup shown in these project reads.</p>}
  </section>}
 </section>;
}

/** The short peek of board 2a, and the full-width view with Back of board 2e on a phone. */
export function InboxPeek({ state }: { state: InboxAttentionState }) {
 const { selected, update, now } = state, title = useRef<HTMLHeadingElement | null>(null);
 useEffect(() => { if (selected !== undefined && window.innerWidth < 1024) title.current?.focus(); }, [selected?.id]); // eslint-disable-line react-hooks/exhaustive-deps
 if (selected === undefined) return null;
 const isLesson = selected.id.startsWith("lessons:");
 return <QueuePeek label="Inbox preview" backLabel="Back to Inbox" onBack={() => update("item", null)} project={selected.project} updated={selected.at !== "" ? updatedWords(selected.at, now) : ""} title={selected.title} titleRef={element => { title.current = element; }}
  status={selected.work === undefined ? <StatusChip state="needs_you" /> : <WorkRowStatus row={selected.work} />} openTo={selected.href} openLabel={isLesson ? "Open lessons" : "Open task"} footnote="Back returns you to this row in Inbox.">
  <section className="rv-qp-step"><h3><VisibleText text={selected.status} /></h3><p><VisibleText text={selected.summary} /></p></section>
  {selected.next !== undefined && selected.next !== selected.summary && <p className="rv-qp-step-next"><VisibleText text={selected.next} /></p>}
 </QueuePeek>;
}
