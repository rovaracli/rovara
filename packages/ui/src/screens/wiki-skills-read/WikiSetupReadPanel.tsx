import { Link } from "react-router";
import { WikiSetupMapViewSchema, WikiSetupBuildSchema } from "@agentx/contracts/web";
import { useRead, useScope } from "./read-model.js";
import { ReadState } from "./ReadState.js";
import { Card, Chip, Fact, Facts, Header, Notice, Row, Rows, dayTime } from "./parts.js";

const ENDED: Record<string, string> = { built: "Built", budget_used: "The budget was used", pages_used: "The page limit was reached", time_used: "The time limit was reached", stopped_by_person: "Stopped by a person", needs_ai_key: "Needs a connected AI key", repo_unreadable: "A repository could not be read", access_lost: "Access to a repository was lost", infrastructure: "Stopped on Rovara's side", code_moved: "The code changed while it started", upkeep_paused: "Upkeep is paused" };
/** The viewer's own local date and time (no fixed zone). */
const when = dayTime;
export function WikiSetupReadPanel() {
 const { project } = useScope();
 const map = useRead("map", "wiki-map", WikiSetupMapViewSchema), build = useRead("build", "wiki-build", WikiSetupBuildSchema);
 // One state for the page: if either read is not confirmed, neither card shows earlier details.
 const both = { isPending: map.isPending || build.isPending, isFetching: map.isFetching || build.isFetching, isError: map.isError || build.isError, failureCount: Math.max(map.failureCount, build.failureCount), error: map.error ?? build.error, data: map.data !== undefined && build.data !== undefined ? true : undefined, dataUpdatedAt: Math.min(map.dataUpdatedAt, build.dataUpdatedAt), refetch: () => Promise.all([map.refetch(), build.refetch()]) };
 return <ReadState read={both} label="the wiki scope and build" code="WIKI-SETUP-READ-FAILED" header={(confirmed, readAt) => <Header project={project} trail={["Wiki", "Scope and build"]} {...(confirmed ? { meta: "Wiki · scope and build", readAt } : {})} />}>{map.data !== undefined && build.data !== undefined && (() => {
  const b = build.data;
  return <div className="rv-wsr-page">
  <Card title="What the wiki is built from" level={3}>{map.data.status === "none" ? <Notice>No saved scope was returned.</Notice> : <>
   {!map.data.map.complete && <Notice>Scope is partial. Can&apos;t tell the full scope yet.</Notice>}
   {map.data.map.repositories.length > 0 && <Rows label="Repositories in the saved scope">{map.data.map.repositories.map(repo => <Row key={repo.name} title={"The repo " + repo.name} detail={repo.partial ?? repo.unavailable} side={<><Chip {...(repo.status === "ok" ? { tone: "ok" as const } : repo.status === "partial" ? { icon: "clock" as const } : { icon: "dash" as const, dashed: true })}>{repo.status === "ok" ? "Read" : repo.status === "partial" ? "Partly read" : "Unavailable"}</Chip><span className="rv-wsr-quiet">{String(repo.files) + (repo.files === 1 ? " file" : " files")}</span></>} />)}</Rows>}
   {map.data.map.repositoriesOmitted > 0 && <Notice>{String(map.data.map.repositoriesOmitted)} more {map.data.map.repositoriesOmitted === 1 ? "repository is" : "repositories are"} not listed.</Notice>}
   <Facts><Fact label="Scope read">{when(map.data.map.computedAt)}</Fact><Fact label="Forecast">{`${String(map.data.map.forecast.pages)} pages forecast${map.data.map.forecast.complete ? "" : " · Forecast is partial"}`}</Fact></Facts>
   <p className="rv-wsr-note">Finished tasks and lessons in use: Can&apos;t tell yet.</p></>}
  </Card>
  <Card title="Build" level={3} chip={b.status === "running" ? <Chip tone="running">Running</Chip> : b.status === "built" ? <Chip tone="ok">Built</Chip> : b.status === "stopped" ? <Chip icon="stop">Stopped</Chip> : <Chip icon="dash" dashed>No build yet</Chip>}>
   <Facts>
    {b.summary !== undefined && <Fact label="Pages">{`${String(b.summary.pagesWritten)} of ${String(b.summary.pagesPlanned)} planned pages written`}</Fact>}
    {b.stop !== undefined && <Fact label="How it ended">{b.message ?? ENDED[b.stop] ?? b.stop}</Fact>}
    {b.startedAt !== undefined && <Fact label="Started">{when(b.startedAt)}</Fact>}
    <Fact label="Pages in the wiki">{String(b.wiki.pages)}</Fact>
    <Fact label="Tasks read the wiki">{b.agents.on ? "On" : "Off"}</Fact>
    <Fact label="Cost">Can&apos;t tell yet.</Fact>
   </Facts>
   <p className="rv-wsr-note">To map the files, build, stop, continue, refresh or delete the wiki, give it to tasks, or change nightly upkeep, use the Wiki row in this project's <Link to={"/app/projects/" + encodeURIComponent(project)}>setup checklist</Link>.</p>
  </Card>
  </div>; })()}</ReadState>;
}
