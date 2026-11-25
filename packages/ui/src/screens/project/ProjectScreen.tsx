import { Suspense, lazy, useEffect, useState } from "react";
import { useAppHost } from "../../host.js";
import { createRealtimeClient } from "../../realtime/client.js";
import { createNoticeInvalidator } from "../../realtime/invalidate.js";
import { LIVE_REFETCH_DEBOUNCE_MS } from "../../constants.js";
import { useParams, useSearchParams, Link } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { AgentIdSchema, ProjectOverviewProjectSchema } from "@agentx/contracts/web";
import { useProject } from "../../api/projects.js";
import { useWikiIndex, wikiOffered } from "../../api/wiki.js";
import { SKILLS_TAB, skillsOffered, useSkills } from "../../api/skills.js";
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
import { ALLOWED_LIST_NAME } from "../admin/projects/allowed-list-name.js";
import { ProjectRepeatsMetric } from "./lessons/RepeatsLine.js";
import { NewSessionMenu } from "./NewSessionMenu.js";
import { StartWorkBox } from "./StartWorkBox.js";
import { EnvironmentPanel } from "./EnvironmentPanel.js";
import { ProjectChannels } from "./ProjectChannels.js";
import { MachineSizeCard } from "./MachineSizeCard.js";
import { SOURCES_TAB_OFFERED } from "./sources-tab-gate.js";
import { stateTime, useSetupTab } from "../setup-tab/use-setup-tab.js";
import { RelativeTime } from "../../design/RelativeTime.js";
// Sources is its own chunk: nothing of it loads until the tab is opened. Lessons live inside How we work as its "Learned" section (DEC 231c), so the old Lessons tab is gone
// and its address (`?tab=lessons`) opens How we work.
// G4: the rebuilt How we work views (Rules, Learned, Models by stage, History), its own chunk. They hold the live lesson and suggested-rule tools.
const HowWeWorkViews = lazy(async () => ({ default: (await import("../rules-lessons-read/LazyPages.js")).default }));
const SourcesTab = lazy(async () => ({ default: (await import("./lessons/SourcesTab.js")).SourcesTab }));
// KF-1: the marked tests and Undo. Its own chunk; the page asks for it only when the server says the list exists (the four test results are on, and the reader is a maintainer).
const KnownFailingMarks = lazy(async () => ({ default: (await import("./KnownFailingMarks.js")).KnownFailingMarks }));
// The project's Setup tab (FABLE-REVIEW 2026-11-23): status card, addresses to decide, this run, extras and the limits for a setup run. Its own chunk; the page makes the one read of everything setup (it also draws the header chip).
const SetupTab = lazy(async () => ({ default: (await import("../setup-tab/SetupTab.js")).SetupTab }));
// Guided onboarding PR 9: the setup checklist (shown until the project is set up) and Project settings, each its own chunk.
const SetupRepairCard = lazy(async () => ({ default: (await import("../setup/SetupRepairCard.js")).SetupRepairCard }));
const ProjectChecklist = lazy(async () => ({ default: (await import("../setup/ProjectChecklist.js")).ProjectChecklist }));
const ProjectSettingsTab = lazy(async () => ({ default: (await import("./ProjectSettingsTab.js")).ProjectSettingsTab }));
// The project's Wiki and Skills (leads 4 W5 and L4-JA), rebuilt on the design system: their own chunk. A tab is offered only when Code serves the list (the index / skills list reads once and is kept for a minute); the pages
// load when the tab is opened. They draw their own project frame (header, project tabs, How we work pills), so the host shows nothing else of the project page while one is open.
const WikiSkillsPages = lazy(async () => ({ default: (await import("../wiki-skills-read/ReadEntry.js")).WikiSkillsReadEntry }));
import "../live/live.css";
import "./project.css";
const tabsFor = (sources: boolean, wiki: boolean, skills: boolean): ReadonlySet<string> => new Set(["setup", "how-we-work", ...(sources ? ["sources"] : []), "settings", ...(wiki ? ["wiki"] : []), ...(skills ? ["skills"] : [])]);
export function ProjectScreen({ sourcesTabOffered = SOURCES_TAB_OFFERED }: { sourcesTabOffered?: boolean }) {
 const host = useAppHost(), { name } = useParams(), [params, setParams] = useSearchParams(), parsed = ProjectOverviewProjectSchema.shape.name.safeParse(name), project = parsed.success ? parsed.data : undefined, read = useProject(project), query = useQueryClient();
 const ready = project !== undefined && read.data !== undefined && !read.isError;
 const [connection, setConnection] = useState("connecting");
 const wiki = useWikiIndex(project ?? "", ready), wikiTab = ready && wikiOffered(wiki), wikiPending = ready && wiki.isPending && params.get("tab") === "wiki";
 const skills = useSkills(project ?? "", ready), skillsTab = ready && skillsOffered(skills), skillsPending = ready && skills.isPending && params.get("tab") === "skills";
 // Everything setup, read once for the header chip and the Setup tab (the journal and the limits only while the tab is open).
 const setup = useSetupTab(project ?? "", { enabled: ready, onTab: params.get("tab") === "setup", canStartWork: read.data?.you.canStartWork === true });
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
 const newAppAvailable = read.error instanceof ApiError && read.error.code === "INVALID_RESPONSE" && read.error.message === "Rovara Cloud was updated. Reload this page to continue.";
 if (read.isError || read.data === undefined) return <section><h1 tabIndex={-1}>Project unavailable</h1><p role="alert"><VisibleText text={read.error instanceof ApiError ? read.error.message : "Couldn't load this project. Try again."} /></p><Button onClick={() => { if (newAppAvailable) host.navigate(host.currentPath());else void read.refetch(); }}>{newAppAvailable ? "Reload Rovara" : "Try again"}</Button></section>;
 // Wiki and Skills are whole pages with their own frame (the address stays ?tab=wiki / ?tab=skills, with &page= / &view= kept).
 const tab = params.get("tab");
 if (tab === "wiki" && (wikiTab || wikiPending)) return <Suspense fallback={<Skeleton label="Loading the wiki" />}><WikiSkillsPages project={project} /></Suspense>;
 if (tab === "skills" && (skillsTab || skillsPending)) return <Suspense fallback={<Skeleton label="Loading the skills" />}><WikiSkillsPages project={project} /></Suspense>;
 const onSetupTab = params.get("tab") === "setup";
 const data = read.data, setupReady = data.project.setup.status === "ready", checking = data.project.setup.status === "checking", budget = data.you.canViewSpend ? data.budget : undefined;
 const month = budget === undefined ? undefined : new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(budget.month + "-01T00:00:00Z"));
 return <section className="rv-project"><PageHeader focusOnMount title={data.project.name} {...(data.project.description === undefined ? {} : { description: data.project.description })} {...(setup.model === undefined ? {} : { status: setup.model.chip, meta: <>{onSetupTab ? setup.model.headline : <Link to={"/app/projects/" + encodeURIComponent(project) + "?tab=setup"} data-testid="setup-attention-link">{setup.model.headline}</Link>}{stateTime(setup) !== undefined && <> · <RelativeTime at={stateTime(setup)!} /></>}</> })} actions={data.you.canStartWork ? <NewSessionMenu project={project} agents={data.agents} /> : undefined} /><Suspense fallback={null}>{params.get("tab") !== "setup" && <SetupRepairCard project={project} />}</Suspense>{!onSetupTab && <Suspense fallback={null}><ProjectChecklist project={project} /></Suspense>}{!onSetupTab && data.you.canStartWork && <div id="start-work"><StartWorkBox project={project} agents={data.agents} /></div>}<div className="rv-project-facts">{data.project.repositories.map(repository => <span key={repository.fullName}><VisibleText text={repository.fullName} /> <span className="rv-muted">(<VisibleText text={repository.defaultBranch} />)</span></span>)}{setup.model !== undefined ? null : setupReady ? <span>Setup checked</span> : checking ? <span>Checking setup</span> : data.project.setup.status === "unknown" ? <span data-testid="setup-unknown">Setup status unknown. Couldn't read it just now.</span> : data.you.canEditSettings ? <Link to={"/app/projects/" + encodeURIComponent(project) + "?tab=setup"} data-testid="setup-attention-link">Setup needs attention</Link> : <span>Setup needs attention</span>}<ProjectChannels project={project} canEdit={data.you.canEditSettings} /></div><Tabs label="Project" value={params.get("tab") === "lessons" ? "how-we-work" : tabsFor(sourcesTabOffered, wikiTab || wikiPending, skillsTab || skillsPending).has(params.get("tab") ?? "") ? params.get("tab")! : "overview"} onValueChange={tab => setParams(tab === "overview" ? {} : { tab }, { replace: true })} items={[{ value: "overview", label: "Overview", content: <><section className="rv-project-section"><h2>Your running tasks</h2>{connection === "reconnecting" && <p className="rv-muted" role="status">Reconnecting</p>}{data.running.length === 0 ? <p className="rv-muted">None of your tasks in this project are running right now.</p> : <div className="rv-live-list">{data.running.map(tile => <SessionTile key={tile.sessionId} tile={tile} onChanged={() => query.invalidateQueries({ queryKey: ["project", project, "overview"] })} />)}</div>}</section>{data.orgId !== undefined && <section className="rv-project-section"><h2>{ALLOWED_LIST_NAME}</h2><AllowedWebsites orgId={data.orgId} project={project} available={data.project.name === project && data.project.status === "active" && data.you.canEditSettings && !read.isFetching && !read.isError} /></section>}{data.knownFailing !== undefined && data.you.canEditSettings && <section className="rv-project-section"><h2>Environment</h2><Suspense fallback={<Skeleton label="Loading the marked tests" />}><KnownFailingMarks project={project} /></Suspense></section>}<MachineSizeCard project={project} canEdit={data.you.canEditSettings} /><div className="rv-project-columns"><section className="rv-project-section"><h2>Agents on this project</h2><ul className="rv-project-agents">{data.agents.map((agent, index) => <li key={AgentIdSchema.safeParse(agent.agentId).success ? agent.agentId : "unknown:" + index}><div>{AgentIdSchema.safeParse(agent.agentId).success ? <Link to={"/app/agents/" + encodeURIComponent(agent.agentId)}><VisibleText text={agent.name} /></Link> : <span><VisibleText text={agent.name} /></span>}{agent.running > 0 && <span className="rv-muted">{agent.running} running</span>}</div><p className="rv-muted"><VisibleText text={agent.description} /></p></li>)}</ul></section>{data.learning !== undefined && <ProjectRepeatsMetric project={project} learning={data.learning} />}{budget !== undefined && <section className="rv-project-section rv-project-budget"><h2 title="UTC billing month">Budget, {month}</h2><p><Money usd={budget.spentUsd} />{budget.limitUsd === undefined ? " spent" : <> of <Money usd={budget.limitUsd} /></>}</p>{budget.mergedPullRequests === 0 ? <p className="rv-muted">No merged pull requests yet this month</p> : budget.costPerMergedPullRequestUsd === undefined ? <p className="rv-muted">Cost per merged pull request unavailable</p> : <p className="rv-muted"><Money usd={budget.costPerMergedPullRequestUsd} /> per merged pull request</p>}</section>}</div></> }, { value: "how-we-work", label: "How we work", content: <Suspense fallback={<Skeleton label="Loading how this project works" />}><HowWeWorkViews project={project} repository={data.project.repositories[0]} /></Suspense> }, // Wiki and Skills are listed here to open them; their pages are drawn above (their own frame), so these two have no body of their own.
...(wikiTab || wikiPending ? [{ value: "wiki", label: "Wiki", content: null }] : []), ...(skillsTab || skillsPending ? [{ value: "skills", label: SKILLS_TAB, content: null }] : []), ...(sourcesTabOffered ? [{ value: "sources", label: "Sources", content: <Suspense fallback={<Skeleton label="Loading sources" />}><SourcesTab project={project} /></Suspense> }] : []), { value: "setup", label: "Setup", content: <><Suspense fallback={<Skeleton label="Reading setup" />}><SetupTab project={project} data={setup} canChange={data.you.canEditSettings} connection={connection} /></Suspense><EnvironmentPanel project={project} /></> }, { value: "settings", label: "Settings", content: <Suspense fallback={<Skeleton label="Loading Project settings" />}><ProjectSettingsTab project={project} canEdit={data.you.canEditSettings} /></Suspense> }]} /></section>;
}
