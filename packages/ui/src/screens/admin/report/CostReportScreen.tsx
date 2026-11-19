// Cost and time (Feature A, slice A3): what the company spent and how long work took, by feature and by project. Real numbers only: money is whole cents from Rovara Code's ledger, a missing number is
// not drawn as zero, and nobody is ranked (no person appears here). The wait split and send-backs are not drawn until Rovara Code sends them.
import "./report.css";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router";
import { REPORT_PATH, readCostReport, reportCsv, type ReportGroup } from "../../../api/admin-report.js";
import { useAppHost } from "../../../host.js";
import { Button } from "../../../design/Button.js";
import { DataTable, type Column } from "../../../design/DataTable.js";
import { EmptyState } from "../../../design/EmptyState.js";
import { PageHeader } from "../../../design/PageHeader.js";
import { VisibleText } from "../../../design/VisibleText.js";
import { Select } from "../../../design/Select.js";
import { AdminSection } from "../parts.js";
import { useAdminContext } from "../AdminLayout.js";
import { CostCell, EndCell, FilterRow, PullRequestCell, RANGE_NOTE, REPORT_HOME, ReadState, TopNumbers, UnreadableNote, useReportFilters } from "./ReportParts.js";
import { NewFeatureButton } from "./ReportActions.js";
import { useReportRead } from "./useReportRead.js";

const PAGE_ROWS = 25;
type Tab = "feature" | "project";
type SortId = "cost" | "tasks" | "end" | "name";
const SORTS: ReadonlyArray<{ value: SortId; label: string }> = [{ value: "cost", label: "Cost, highest first" }, { value: "tasks", label: "Tasks, most first" }, { value: "end", label: "End to end, longest first" }, { value: "name", label: "Name, A to Z" }];

/** The table's order. No feature is always the last row, whatever the sort. */
export function sortGroups(groups: readonly ReportGroup[], sort: SortId): ReportGroup[] {
 const rank = (g: ReportGroup) => (sort === "cost" ? g.costCents : sort === "tasks" ? g.tasks : g.endToEndMs ?? -1);
 const sorted = [...groups].sort((a, b) => (sort === "name" ? a.name.localeCompare(b.name, "en") : rank(b) - rank(a) || a.name.localeCompare(b.name, "en")) || a.key.localeCompare(b.key));
 const none = sorted.filter(g => g.key === "none");
 return [...sorted.filter(g => g.key !== "none"), ...none];
}

export function CostReportScreen() {
 const { orgId, developerId, role } = useAdminContext();
 if (role !== "owner" && role !== "admin") return <section><PageHeader focusOnMount title="Cost and time" /><p role="alert">Only company owners and admins can view the cost report. No amounts are shown.</p></section>;
 return <ReportView key={`${orgId}:${developerId}:${role}`} />;
}

function ReportView() {
 const host = useAppHost(), navigate = useNavigate(), state = useReportFilters(), [tab, setTab] = useState<Tab>("feature"), [sort, setSort] = useState<SortId>("cost"), [page, setPage] = useState(0);
 const read = useReportRead("cost", REPORT_PATH + state.query, readCostReport);
 const data = read.data;
 // A project filter narrows the report to that project, so the menu keeps every project this page has seen (the Cloud answer lists only the projects in the filtered range).
 const seen = useRef(new Set<string>()), [projects, setProjects] = useState<string[]>([]);
 useEffect(() => { if (data === undefined) return; const before = seen.current.size; for (const name of data.projects) seen.current.add(name); if (seen.current.size !== before) setProjects([...seen.current].sort((a, b) => a.localeCompare(b, "en"))); }, [data]);
 const groups = useMemo(() => (data === undefined ? [] : sortGroups(tab === "feature" ? data.byFeature : data.byProject, sort)), [data, tab, sort]);
 const pages = Math.max(1, Math.ceil(groups.length / PAGE_ROWS)), at = Math.min(page, pages - 1), shown = groups.slice(at * PAGE_ROWS, (at + 1) * PAGE_ROWS);
 const featureColumns: readonly Column<ReportGroup>[] = [
  { key: "name", title: "Feature", render: g => <Link to={`${REPORT_HOME}/features/${encodeURIComponent(g.key)}${state.carry}`}><b><VisibleText text={g.name} /></b></Link> },
  { key: "tasks", title: "Tasks", render: g => <span className="rv-num">{g.tasks}</span> },
  { key: "prs", title: "Pull requests", render: g => <PullRequestCell merged={g.prsMerged} opened={g.prsOpened} /> },
  { key: "cost", title: "Cost", render: g => <CostCell cents={g.costCents} floor={g.costIsFloor} unpriced={g.unpricedCalls} /> },
  { key: "end", title: "End to end", render: g => <EndCell ms={g.endToEndMs} soFar={g.endToEndSoFar} /> },
  { key: "state", title: "State", render: g => (g.state === undefined ? <span className="rv-muted">Not set</span> : <span className="rv-report-state" data-state={g.state}>{g.state === "done" ? "Done" : "Open"}</span>) },
 ];
 const projectColumns: readonly Column<ReportGroup>[] = [
  { key: "name", title: "Project", render: g => <b><VisibleText text={g.name} /></b> }, ...featureColumns.slice(1, 5),
 ];
 const download = () => { if (data !== undefined) host.saveFile(tab === "feature" ? "cost-and-time-by-feature.csv" : "cost-and-time-by-project.csv", new Blob([reportCsv(groups, tab, data.unreadableTasks)], { type: "text/csv" })); };
 return <section className="rv-report-surface" aria-busy={read.isFetching}>
  <PageHeader focusOnMount title="Cost and time" description="What work cost and how long it took, by feature and by project." actions={<>{data?.canChange === true && <NewFeatureButton onCreated={id => { void navigate(`${REPORT_HOME}/features/${encodeURIComponent(id)}${state.carry}`); }} />}<Button disabled={data === undefined || groups.length === 0} onClick={download}>Download CSV</Button></>} />
  <FilterRow projects={projects} state={state} />
  <ReadState read={read} what="the cost report" title="Cost and time" />
  {data !== undefined && <>
   <UnreadableNote tasks={data.unreadableTasks} />
   <TopNumbers totals={data.totals} label="Cost and time in this range" />
   <p className="rv-report-help">{RANGE_NOTE}</p>
   {data.totals.tasks === 0 ? <EmptyState testId="report-empty" title="No tasks in this range" description="Nothing started in this range matches these filters. Try a longer date range or clear a filter." /> : <AdminSection title={tab === "feature" ? "By feature" : "By project"}>
    <div className="rv-report-tabs" role="tablist" aria-label="Group by">
     <button type="button" role="tab" aria-selected={tab === "feature"} onClick={() => { setTab("feature"); setPage(0); }}>By feature</button>
     <button type="button" role="tab" aria-selected={tab === "project"} onClick={() => { setTab("project"); setPage(0); }}>By project</button>
    </div>
    <div className="rv-report-tools"><Select label="Sort by" value={sort} onValueChange={value => { setSort(value as SortId); setPage(0); }} options={SORTS} /></div>
    <DataTable caption={tab === "feature" ? "Cost and time by feature" : "Cost and time by project"} columns={tab === "feature" ? featureColumns : projectColumns} rows={shown} rowKey={g => g.key} />
    <div className="rv-report-pages"><span role="status">Showing {at * PAGE_ROWS + 1} to {at * PAGE_ROWS + shown.length} of {groups.length}</span>
     {pages > 1 && <><Button disabled={at === 0} onClick={() => setPage(at - 1)}>Previous page</Button><Button disabled={at >= pages - 1} onClick={() => setPage(at + 1)}>Next page</Button></>}</div>
    <p className="rv-report-help">{tab === "feature" ? "Tasks with no feature are in the last row, so the rows always add up to the total." : "Each task belongs to one project, so the rows add up to the total."} The CSV holds what these filters show.</p>
   </AdminSection>}
  </>}
 </section>;
}
