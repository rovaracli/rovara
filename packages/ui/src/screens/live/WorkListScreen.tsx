import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AppNavReaderSchema, ProjectOverviewProjectSchema } from "@agentx/contracts/web";
import { useAppHost } from "../../host.js";
import { createApiClient } from "../../api/client.js";
import { ApiError } from "../../api/errors.js";
import { useWorkList } from "../../api/work-list.js";
import { useAnnounce } from "../../design/Announcer.js";
import { Button } from "../../design/Button.js";
import { EmptyState } from "../../design/EmptyState.js";
import { PageHeader } from "../../design/PageHeader.js";
import { Select } from "../../design/Select.js";
import { Skeleton } from "../../design/Skeleton.js";
import { Tabs } from "../../design/Tabs.js";
import { VisibleText } from "../../design/VisibleText.js";
import { WorkRowItem } from "./WorkRowItem.js";
import { useLiveUpdates } from "./use-live-updates.js";
import { WORK_VIEWS, WORK_VIEW_LABELS, liveFiltersFor, rowFromFinished, rowFromLive, sortFinished, sortRows, workViewFor, type WorkRow } from "./work-list.js";
import "./live.css";

const EMPTY: Record<(typeof WORK_VIEWS)[number], { title: string; description: string }> = {
 mine: { title: "No work of yours right now", description: "Work you start, or that is handed to you, will appear here." },
 team: { title: "No team work right now", description: "Work shared with you, or on projects you're part of, will appear here." },
 attention: { title: "Nothing needs attention", description: "Work that waits on you, or has failed, will appear here." },
 finished: { title: "No finished work yet", description: "Work that has finished will appear here." },
};

/** The Work list (switch `rovara.work` = "v2"): today's Live data read as Mine, Team, Needs attention and Finished, with plain states, age and next actor. See work-list.ts for what each row says and when it says nothing. */
export function WorkListScreen() {
 const host = useAppHost(), query = useQueryClient(), api = useMemo(() => createApiClient(host), [host]), [params, setParams] = useSearchParams(), announce = useAnnounce();
 const view = workViewFor(params.get("view"), params.get("filter")), parsedProject = ProjectOverviewProjectSchema.shape.name.safeParse(params.get("project")), project = parsedProject.success ? parsedProject.data : undefined;
 const work = useWorkList(liveFiltersFor(view), view === "finished", project), nav = useQuery({ queryKey: ["nav"], queryFn: () => api.get("/v1/app/nav", AppNavReaderSchema) });
 const connection = useLiveUpdates(work.ready);
 const [now, setNow] = useState(() => Date.now());
 useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 60_000);return () => clearInterval(timer); }, []);
 const rows = useMemo<WorkRow[] | undefined>(() => work.live !== undefined ? sortRows(work.live.map(tile => rowFromLive(tile, now))) : work.finished !== undefined ? sortFinished(work.finished.map(tile => rowFromFinished(tile, now))) : undefined, [work.live, work.finished, now]);
 const previous = useRef<{ key: string; rows: WorkRow[] } | undefined>(undefined), selection = view + ":" + (project ?? "");
 useEffect(() => { if (rows === undefined) return;if (previous.current?.key === selection) for (const row of previous.current.rows) if (!rows.some(next => next.sessionId === row.sessionId)) announce(row.title + " left this list");previous.current = { key: selection, rows }; }, [rows, selection, announce]);
 function choose(key: string, value: string | undefined) { const next = new URLSearchParams(params);next.delete("filter");if (value === undefined) next.delete(key);else next.set(key, value);setParams(next); }
 const projects = nav.data?.projects.map(item => item.name) ?? [];if (project !== undefined && !projects.includes(project)) projects.push(project);
 const note = view === "team" ? "Work on projects you're part of" : view === "finished" ? (project === undefined ? "Your finished work. Choose a project to see everyone's finished work in it." : "Finished work in " + project) : undefined;
 const content = <>
  {note !== undefined && <p className="rv-muted rv-work-note"><VisibleText text={note} /></p>}
  {work.isPending && <Skeleton label="Loading work" />}
  {work.partial && <div role="alert" className="rv-work-note"><p>Some work couldn't be loaded, so this list may be incomplete.</p><Button onClick={() => { void work.refetch(); }}>Try again</Button></div>}
  {work.isError && <div role="alert"><p><VisibleText text={work.error instanceof ApiError ? work.error.message : "Couldn't load work. Try again."} /></p><Button onClick={() => { void work.refetch(); }}>Try again</Button></div>}
  {rows !== undefined && rows.length === 0 && <EmptyState title={EMPTY[view].title} description={EMPTY[view].description} />}
  {rows !== undefined && rows.length > 0 && <ul className="rv-work-list" aria-label={WORK_VIEW_LABELS[view]}>{rows.map(row => <WorkRowItem key={row.sessionId} row={row} onChanged={() => query.invalidateQueries({ queryKey: ["live"] })} />)}</ul>}
  {work.hasNextPage && <Button busy={work.isFetchingNextPage} onClick={() => { void work.fetchNextPage(); }}>Load more work</Button>}
 </>;
 return <section className="rv-live rv-work"><PageHeader title="Work" />
  <div className="rv-live-toolbar"><Select label="Project" value={project ?? "__all"} onValueChange={value => choose("project", value === "__all" ? undefined : value)} options={[{ value: "__all", label: "All projects" }, ...projects.map(name => ({ value: name, label: name }))]} />{work.ready && <span className="rv-muted" role="status">{connection === "reconnecting" ? "Reconnecting" : connection === "online" ? "Live updates connected" : "Connecting live updates"}</span>}</div>
  <div className="rv-work-views"><Tabs label="Work views" value={view} onValueChange={value => choose("view", value)} items={WORK_VIEWS.map(value => ({ value, label: WORK_VIEW_LABELS[value], content: value === view ? content : null }))} /></div>
 </section>;
}
