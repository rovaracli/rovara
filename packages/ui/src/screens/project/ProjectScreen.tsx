import { Suspense, lazy, useEffect, useState } from "react";
import { useAppHost } from "../../host.js";
import { createRealtimeClient } from "../../realtime/client.js";
import { createNoticeInvalidator } from "../../realtime/invalidate.js";
import { LIVE_REFETCH_DEBOUNCE_MS } from "../../constants.js";
import { useParams, useSearchParams, Link } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { AgentIdSchema, ProjectOverviewProjectSchema } from "@agentx/contracts/web";
import { useProject } from "../../api/projects.js";
import { ApiError } from "../../api/errors.js";
import { Button } from "../../design/Button.js";
import { Money } from "../../design/Money.js";
import { PageHeader } from "../../design/PageHeader.js";
import { Skeleton } from "../../design/Skeleton.js";
import { Tabs } from "../../design/Tabs.js";
import { VisibleText } from "../../design/VisibleText.js";
import { NotFound } from "../../shell/NotFound.js";
import { SessionTile } from "../live/SessionTile.js";
import { AllowedWebsites } from "../admin/projects/AllowedWebsites.js";
import { LearningMetric } from "./LearningMetric.js";
import { HowWeWorkTab } from "./HowWeWorkTab.js";
import { NewSessionMenu } from "./NewSessionMenu.js";
import { StartWorkBox } from "./StartWorkBox.js";
import { EnvironmentPanel } from "./EnvironmentPanel.js";
// Lessons and Sources are their own chunk: nothing of them loads until the tab is opened.
const LessonsTab = lazy(async () => ({ default: (await import("./lessons/LessonsTab.js")).LessonsTab }));
const SourcesTab = lazy(async () => ({ default: (await import("./lessons/SourcesTab.js")).SourcesTab }));
// KF-1: the marked tests and Undo. Its own chunk; the page asks for it only when the server says the list exists (the four test results are on, and the reader is a maintainer).
const KnownFailingMarks = lazy(async () => ({ default: (await import("./KnownFailingMarks.js")).KnownFailingMarks }));
// SU-1: the project's setup limits. Its own chunk; a maintainer's, and it shows nothing while the setup agent is off.
const SetupLimitsSection = lazy(async () => ({ default: (await import("../setup/SetupLimitsSection.js")).SetupLimitsSection }));
// Slice 5: tickets from Linear, Jira and GitHub (waiting tickets, watched sources, what Rovara writes back). Its own chunk.
const TicketsSection = lazy(async () => ({ default: (await import("./TicketsSection.js")).TicketsSection }));
import "../live/live.css";
import "./project.css";
const TABS: ReadonlySet<string> = new Set(["how-we-work", "lessons", "sources"]);
export function ProjectScreen() {
 const host = useAppHost(), { name } = useParams(), [params, setParams] = useSearchParams(), parsed = ProjectOverviewProjectSchema.shape.name.safeParse(name), project = parsed.success ? parsed.data : undefined, read = useProject(project), query = useQueryClient();
 const ready = project !== undefined && read.data !== undefined && !read.isError;
 const [connection, setConnection] = useState("connecting");
 useEffect(() => {
  if (!ready) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const invalidator = createNoticeInvalidator(query), realtime = createRealtimeClient(host, { onNotice: notice => {
   invalidator.notice(notice);
   if (notice.type === "session.updated" && timer === undefined) timer = setTimeout(() => { timer = undefined;void query.invalidateQueries({ queryKey: ["project", project, "overview"] }); }, LIVE_REFETCH_DEBOUNCE_MS);
  }, onStatus: setConnection, onReset: () => invalidator.reset() });
  realtime.start();return () => { clearTimeout(timer);realtime.stop();invalidator.stop(); };
 }, [host, project, query, ready]);
 if (project === undefined || read.error instanceof ApiError && read.error.status === 404) return <NotFound />;
 if (read.isPending) return <section><h1 tabIndex={-1}>Project</h1><Skeleton label="Loading the project" /></section>;
 if (read.isError || read.data === undefined) return <section><h1 tabIndex={-1}>Project unavailable</h1><p role="alert"><VisibleText text={read.error instanceof ApiError ? read.error.message : "Couldn't load this project. Try again."} /></p><Button onClick={() => { void read.refetch(); }}>Try again</Button></section>;
 const data = read.data, setupReady = data.project.setup.status === "ready", checking = data.project.setup.status === "checking", budget = data.you.canViewSpend ? data.budget : undefined;
 const month = budget === undefined ? undefined : new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(budget.month + "-01T00:00:00Z"));
 return <section className="rv-project"><PageHeader focusOnMount title={data.project.name} {...(data.project.description === undefined ? {} : { description: data.project.description })} actions={data.you.canStartWork ? <NewSessionMenu project={project} agents={data.agents} /> : undefined} />{data.you.canStartWork && <StartWorkBox project={project} agents={data.agents} />}<div className="rv-project-facts">{data.project.repositories.map(repository => <span key={repository.fullName}><VisibleText text={repository.fullName} /> <span className="rv-muted">(<VisibleText text={repository.defaultBranch} />)</span></span>)}{setupReady ? <span>Setup ready</span> : checking ? <span>Checking setup</span> : data.you.canEditSettings ? <Link to={"/app/onboard?project=" + encodeURIComponent(project) + "&step=setup"}>Setup needs attention</Link> : <span>Setup needs attention</span>}{data.project.channels.map(channel => <span key={channel}><VisibleText text={channel} /></span>)}</div><p className="rv-project-visibility rv-muted">Everyone on this project can see its sessions, including people who reach it through its Slack channel.</p><Tabs label="Project" value={TABS.has(params.get("tab") ?? "") ? params.get("tab")! : "overview"} onValueChange={tab => setParams(tab === "overview" ? {} : { tab }, { replace: true })} items={[{ value: "overview", label: "Overview", content: <><section className="rv-project-section"><h2>Running now</h2>{connection === "reconnecting" && <p className="rv-muted" role="status">Reconnecting</p>}{data.running.length === 0 ? <p className="rv-muted">No sessions are running here right now.</p> : <div className="rv-live-list">{data.running.map(tile => <SessionTile key={tile.sessionId} tile={tile} onChanged={() => query.invalidateQueries({ queryKey: ["project", project, "overview"] })} />)}</div>}</section>{data.orgId !== undefined && <section className="rv-project-section"><h2>Allowed websites</h2><AllowedWebsites orgId={data.orgId} project={project} available={data.project.name === project && data.project.status === "active" && data.you.canEditSettings && !read.isFetching && !read.isError} /></section>}{data.knownFailing !== undefined && data.you.canEditSettings && <section className="rv-project-section"><h2>Environment</h2><Suspense fallback={<Skeleton label="Loading the marked tests" />}><KnownFailingMarks project={project} /></Suspense></section>}{data.you.canEditSettings && <Suspense fallback={null}><SetupLimitsSection project={project} /></Suspense>}{(data.you.canStartWork || data.you.canEditSettings) && <Suspense fallback={<Skeleton label="Loading tickets" />}><TicketsSection project={project} canStart={data.you.canStartWork} canEdit={data.you.canEditSettings} /></Suspense>}<EnvironmentPanel project={project} /><div className="rv-project-columns"><section className="rv-project-section"><h2>Agents on this project</h2><ul className="rv-project-agents">{data.agents.map((agent, index) => <li key={AgentIdSchema.safeParse(agent.agentId).success ? agent.agentId : "unknown:" + index}><div>{AgentIdSchema.safeParse(agent.agentId).success ? <Link to={"/app/agents/" + encodeURIComponent(agent.agentId)}><VisibleText text={agent.name} /></Link> : <span><VisibleText text={agent.name} /></span>}{agent.running > 0 && <span className="rv-muted">{agent.running} running</span>}</div><p className="rv-muted"><VisibleText text={agent.description} /></p></li>)}</ul></section>{data.learning !== undefined && <LearningMetric project={project} learning={data.learning} />}{budget !== undefined && <section className="rv-project-section rv-project-budget"><h2>Budget, {month}</h2><p><Money usd={budget.spentUsd} />{budget.limitUsd === undefined ? " spent" : <> of <Money usd={budget.limitUsd} /></>}</p>{budget.mergedPullRequests === 0 ? <p className="rv-muted">No merged pull requests yet this month</p> : budget.costPerMergedPullRequestUsd === undefined ? <p className="rv-muted">Cost per merged pull request unavailable</p> : <p className="rv-muted"><Money usd={budget.costPerMergedPullRequestUsd} /> per merged pull request</p>}</section>}</div></> }, { value: "how-we-work", label: "How we work", content: <HowWeWorkTab project={project} canEdit={data.you.canEditSettings} /> }, { value: "lessons", label: "Lessons", content: <Suspense fallback={<Skeleton label="Loading lessons" />}><LessonsTab project={project} /></Suspense> }, { value: "sources", label: "Sources", content: <Suspense fallback={<Skeleton label="Loading sources" />}><SourcesTab project={project} /></Suspense> }]} /></section>;
}
