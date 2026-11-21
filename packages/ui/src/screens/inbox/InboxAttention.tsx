import { useEffect, useMemo, useRef } from "react";
import { Link, useSearchParams } from "react-router";
import { useQueries, useQuery } from "@tanstack/react-query";
import { AppNavReaderSchema } from "@agentx/contracts/web";
import { createApiClient } from "../../api/client.js";
import { useDecisions } from "../../api/decisions.js";
import { lessonsOff, notServed, useLessonInbox } from "../../api/learned.js";
import { setupChecklistKey, useSetupChecklistApi } from "../../api/setup-checklist.js";
import { useWorkTasks, workRows } from "../../api/work.js";
import { useAppHost } from "../../host.js";
import { paths } from "../../paths.js";
import { Button } from "../../design/Button.js";
import { RelativeTime } from "../../design/RelativeTime.js";
import { VisibleText } from "../../design/VisibleText.js";

/** Attention is a bounded projection of current personal reads, never a company-wide queue or an all-clear. New previews only navigate. */
export function InboxAttention() {
 const tasks = useWorkTasks(), decisions = useDecisions(), lessons = useLessonInbox(), host = useAppHost();
 const api = useMemo(() => createApiClient(host), [host]), setup = useSetupChecklistApi();
 const nav = useQuery({ queryKey: ["nav"], retry: false, queryFn: () => api.get("/v1/app/nav", AppNavReaderSchema) });
 const navFresh = nav.isSuccess && nav.failureCount === 0;
 const projects = navFresh ? nav.data.projects.slice(0, 3) : [];
 const checks = useQueries({ queries: projects.map(project => ({ queryKey: setupChecklistKey(project.name), retry: false, queryFn: () => setup.status(project.name) })) });
 const [params, setParams] = useSearchParams(), tab = params.get("tab") === "waiting" ? "waiting" : params.get("tab") === "setup" ? "setup" : "needs";
 const selectedId = params.get("item"), restore = useRef<string | null>(null), detailTitle = useRef<HTMLHeadingElement>(null);
 const currentTasks = tasks.isSuccess && tasks.failureCount === 0, currentDecisions = decisions.isSuccess && decisions.failureCount === 0;
 const rows = useMemo(() => currentTasks ? workRows(tasks.data, currentDecisions ? decisions.data : [], new Date()) : [], [currentTasks, currentDecisions, tasks.data, decisions.data]);
 const needs = currentDecisions ? rows.filter(row => row.group === "you") : [];
 const waiting = currentDecisions ? rows.filter(row => row.group === "others") : [];
 const batches = lessons.isSuccess && lessons.failureCount === 0 && lessons.data.state === "on" ? lessons.data.batches : [];
 const unfinished = checks.flatMap((read, index) => read.isSuccess && read.failureCount === 0 && read.data.progress.percent < 100 ? [{ project: projects[index]!.name, data: read.data }] : []);
 const attention = (tab === "waiting" ? waiting : needs).map(row => ({ id: row.id, title: row.title, project: row.project, status: row.need ?? row.line, summary: row.decision?.card.question ?? row.task.workflow?.blockReason ?? row.line, at: row.updatedAt, href: paths.session(row.task.sessionId ?? row.id) }));
 if (tab === "needs") for (const batch of batches) attention.push({ id: "lessons:" + batch.project, title: "Review lessons", project: batch.project, status: `${String(batch.lessons.length)} lessons shown`, summary: "Open the existing lesson review in Work.", at: "", href: paths.live + "?task=" + encodeURIComponent("lessons:" + batch.project) });
 const selected = attention.find(row => row.id === selectedId);
 const pending = tasks.isPending || decisions.isPending || lessons.isPending;
 function update(key: string, value: string | null) { const next = new URLSearchParams(params);if (value === null) next.delete(key);else next.set(key, value);setParams(next, { replace: true }); }
 function back() { restore.current = selectedId;update("item", null); }
 useEffect(() => {
  if (selected !== undefined) detailTitle.current?.focus();
  else if (restore.current !== null) { const opener = [...document.querySelectorAll<HTMLButtonElement>("button[data-attention-id]")].find(button => button.dataset.attentionId === restore.current);opener?.focus();restore.current = null; }
 }, [selected]);
 return <section aria-label="Inbox attention" className="rv-attention" data-testid="inbox-attention">
  <div className="rv-attention-tabs" role="group" aria-label="Show inbox">
   {([["needs", "Needs you"], ["waiting", "Waiting on others"], ["setup", "Finish setting up"]] as const).map(([key, label]) => <button key={key} type="button" aria-pressed={tab === key} onClick={() => { const next = new URLSearchParams(params);next.set("tab", key);next.delete("item");setParams(next, { replace: true }); }}>{label}</button>)}
  </div>
  <p className="rv-muted rv-attention-scope">Mine · Items shown from your available reads. Rovara can't tell yet whether this is everything that needs you.</p>
  {tab !== "setup" && <>
   {tasks.isError && <p role="status">The task list could not be read. Rovara can't tell yet what needs you. <Button onClick={() => { void tasks.refetch(); }}>Reload work</Button></p>}
   {decisions.isError && <p role="status">Decisions could not be loaded, so this is not a confirmed empty queue. <Button onClick={() => { void decisions.refetch(); }}>Reload decisions</Button></p>}
   {lessons.isError && !lessonsOff(lessons.error) && !notServed(lessons.error) && <p role="status">Lessons needing your review could not be loaded. This does not mean there are none. <Button onClick={() => { void lessons.refetch(); }}>Reload lessons</Button></p>}
   {lessons.isSuccess && lessons.data.unavailable.length > 0 && <p role="status">Some projects' lessons could not be read. Rovara can't tell yet whether more lessons need review.</p>}
   {pending && <p role="status">Reading your attention items…</p>}
   {!pending && attention.length === 0 && <div className="rv-attention-empty"><h2>No {tab === "waiting" ? "waiting tasks" : "attention items"} shown</h2><p>Rovara can't tell yet whether anything else needs you. You can check your projects or the Work list.</p><Link to={paths.live}>See Work</Link></div>}
   <div className="rv-attention-layout" data-detail-open={selected !== undefined}>
    <section aria-label="Attention list" className="rv-attention-rows"><ol>{attention.map(row => <li key={row.id}><button type="button" data-attention-id={row.id} aria-current={selected?.id === row.id ? "true" : undefined} onClick={() => update("item", row.id)}><span><b><VisibleText text={row.title} /></b><small><VisibleText text={row.status} /> · <VisibleText text={row.project} /></small></span>{row.at !== "" && <RelativeTime at={row.at} />}</button></li>)}</ol></section>
    {selected !== undefined && <section className="rv-attention-preview" aria-label="Inbox preview"><Button variant="quiet" onClick={back}>Back to Inbox</Button><p className="rv-muted"><VisibleText text={selected.project} />{selected.at !== "" && <> · Updated <RelativeTime at={selected.at} /></>}</p><h2 ref={detailTitle} tabIndex={-1}><VisibleText text={selected.title} /></h2><p className="rv-attention-status"><VisibleText text={selected.status} /></p><p><VisibleText text={selected.summary} /></p><p className="rv-muted">Open the task to read its latest details and available actions.</p><Link className="rv-button rv-button-primary" to={selected.href}>Open task</Link></section>}
    {selectedId !== null && selected === undefined && !pending && <p role="status">Rovara can't tell yet which item this link refers to. Choose an item from the current list.</p>}
   </div>
  </>}
  {tab === "setup" && <section aria-label="Project setup" className="rv-attention-setup">
   {!navFresh && <p role="status">Rovara can't tell yet which project setup you can see. <Button onClick={() => { void nav.refetch(); }}>Check projects</Button></p>}
   {navFresh && projects.length === 0 && <><h2>You're not in a project yet</h2><p>Ask your company's admins to add you to a project.</p>{(nav.data.me.orgRole === "owner" || nav.data.me.orgRole === "admin") && <Link className="rv-button" to="/app/onboard?step=repositories">Pick repos</Link>}</>}
   {projects.length > 0 && <p className="rv-muted">Setup for up to three projects shown. Rovara can't tell yet whether all company setup is complete.</p>}
   {checks.some(read => read.isPending) && <p role="status">Reading project setup…</p>}
   {checks.some(read => read.isError) && <p role="status">Some setup could not be read. Rovara can't tell yet what remains. <Button onClick={() => { for (const read of checks) if (read.isError) void read.refetch(); }}>Reload setup</Button></p>}
   <ol>{unfinished.map(({ project, data }) => <li key={project}><Link to={paths.project(project)}><VisibleText text={project} /></Link><p>{data.progress.percent}% done{data.progress.nextRequired === null ? "." : " · Next: " + (NEXT[data.progress.nextRequired] ?? "open the checklist")}</p></li>)}</ol>
   {navFresh && projects.length > 0 && checks.every(read => read.isSuccess) && unfinished.length === 0 && <p>No unfinished setup shown in these project reads.</p>}
  </section>}
 </section>;
}
const NEXT: Readonly<Record<string, string>> = { repos: "add a repo", setupRun: "review setup", evalConfirm: "review AI evals", aiAndSpend: "set up AI and spending", firstTask: "start a task" };
