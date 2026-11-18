// A feature's page: its numbers and the tasks in it (cost, end to end, pull request). No person column: who asked for a task is on the task's own page. Rename, merge, mark done and move arrive
// with Rovara Code's feature routes, and are not drawn until then.
import "./report.css";
import { Link, useNavigate, useParams } from "react-router";
import { NO_FEATURE_ID, ORIGIN_WORDS, SOURCE_WORDS, STATE_WORDS, featureCsv, featurePath, readFeatureDetail, type FeatureTask } from "../../../api/admin-report.js";
import { useAppHost } from "../../../host.js";
import { Button } from "../../../design/Button.js";
import { DataTable, type Column } from "../../../design/DataTable.js";
import { PageHeader } from "../../../design/PageHeader.js";
import { VisibleText } from "../../../design/VisibleText.js";
import { ApiError } from "../../../api/errors.js";
import { AdminSection } from "../parts.js";
import { useAdminContext } from "../AdminLayout.js";
import { CostCell, EndCell, FilterRow, PullRequestCell, RANGE_NOTE, REPORT_HOME, ReadState, TopNumbers, UnreadableNote, useReportFilters } from "./ReportParts.js";
import { MergeButton, MoveButton, RenameButton, StateButton } from "./ReportActions.js";
import { useReportRead } from "./useReportRead.js";

const columns: readonly Column<FeatureTask>[] = [
 { key: "title", title: "Task", render: t => <span>{t.taskPage === undefined ? <b><VisibleText text={t.title} /></b> : <a href={t.taskPage}><b><VisibleText text={t.title} /></b></a>}<span className="rv-report-note"><VisibleText text={t.project} /></span></span> },
 { key: "origin", title: "Started from", render: t => ORIGIN_WORDS[t.origin] },
 { key: "state", title: "State", render: t => <span className="rv-report-state" data-state={t.state}>{STATE_WORDS[t.state]}</span> },
 { key: "pr", title: "Pull request", render: t => (t.prLinks[0] !== undefined ? <a href={t.prLinks[0]} target="_blank" rel="noopener noreferrer">{t.prsMerged} merged of {t.prsOpened}</a> : <PullRequestCell merged={t.prsMerged} opened={t.prsOpened} />) },
 { key: "cost", title: "Cost", render: t => <CostCell cents={t.costCents} floor={t.unpricedCalls > 0} unpriced={t.unpricedCalls} /> },
 { key: "end", title: "End to end", render: t => <EndCell ms={t.wallMs} soFar={t.wallSoFar} /> },
];

export function FeatureDetailScreen() {
 const { orgId, developerId, role } = useAdminContext();
 if (role !== "owner" && role !== "admin") return <section><PageHeader focusOnMount title="Feature" /><p role="alert">Only company owners and admins can view the cost report. No amounts are shown.</p></section>;
 return <DetailView key={`${orgId}:${developerId}:${role}`} />;
}

function DetailView() {
 const host = useAppHost(), navigate = useNavigate(), state = useReportFilters(), id = useParams()["id"] ?? NO_FEATURE_ID;
 const read = useReportRead("feature", featurePath(id) + state.query, readFeatureDetail);
 const data = read.data, missing = read.error instanceof ApiError && read.error.status === 404 && read.error.code === "NOT_FOUND";
 const back = <Link className="rv-report-back" to={REPORT_HOME + state.carry}>Back to Cost and time</Link>;
 if (missing) return <section className="rv-report-surface">{back}<PageHeader focusOnMount title="Feature not found" description="That feature doesn't exist, or you can't see it." /></section>;
 const sources = data?.sources.map(entry => `${entry.count} ${SOURCE_WORDS[entry.source]}`).join(", ");
 return <section className="rv-report-surface" aria-busy={read.isFetching}>
  {back}
  <PageHeader focusOnMount title={data === undefined ? "Feature" : data.feature.name} {...(data === undefined ? {} : { description: data.feature.none ? "Tasks that no feature was set for." : sources === "" ? "No tasks in this range." : `How tasks got here: ${sources}.` })}
   actions={<>{data?.canChange === true && !data.feature.none && <>
    <RenameButton key={data.feature.name} feature={{ id: data.feature.id, name: data.feature.name }} />
    <MergeButton feature={{ id: data.feature.id, name: data.feature.name }} others={data.features.filter(other => other.id !== data.feature.id)} onMerged={into => { void navigate(`${REPORT_HOME}/features/${encodeURIComponent(into)}${state.carry}`); }} />
    <StateButton feature={{ id: data.feature.id, name: data.feature.name, ...(data.feature.state === undefined ? {} : { state: data.feature.state }) }} />
   </>}<Button disabled={data === undefined || data.tasks.length === 0} onClick={() => { if (data !== undefined) host.saveFile("feature-tasks.csv", new Blob([featureCsv(data.tasks)], { type: "text/csv" })); }}>Download CSV</Button></>} />
  <FilterRow projects={[]} state={state} hideProject />
  <ReadState read={read} what="this feature" title="Feature" />
  {data !== undefined && <>
   {(data.feature.state !== undefined || data.feature.trackerLink?.url !== undefined) && <p className="rv-report-help">
    {data.feature.state !== undefined && <span className="rv-report-state" data-state={data.feature.state}>{data.feature.state === "done" ? "Done" : "Open"}</span>}
    {data.feature.trackerLink?.url !== undefined && <> <a href={data.feature.trackerLink.url} target="_blank" rel="noopener noreferrer">Open in <VisibleText text={data.feature.trackerLink.tracker} /> (<VisibleText text={data.feature.trackerLink.id} />)</a></>}
   </p>}
   <UnreadableNote tasks={data.unreadableTasks} />
   <TopNumbers totals={data.totals} label="This feature's numbers" />
   <p className="rv-report-help">{RANGE_NOTE}</p>
   <AdminSection title="Tasks">
    {data.tasks.length === 0 ? <p className="rv-muted" data-testid="report-empty">No tasks in this range.</p> : <DataTable caption="Tasks in this feature" columns={data.canChange ? [...columns, { key: "move", title: "Move", render: t => <MoveButton task={t} current={data.feature.none ? undefined : data.feature.id} features={data.features} /> }] : columns} rows={data.tasks} rowKey={t => t.taskId} />}
    {data.tasksTotal > data.tasks.length && <p className="rv-report-help" role="status">Showing the newest {data.tasks.length} of {data.tasksTotal} tasks. The numbers above count all of them.</p>}
   </AdminSection>
  </>}
 </section>;
}
