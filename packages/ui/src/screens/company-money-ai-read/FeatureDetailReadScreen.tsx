import { servedReadState } from '../../api/served-read.js';
import { Link, useNavigate, useParams } from 'react-router';
import { PageHeader } from '../../design/PageHeader.js';
import { DataTable } from '../../design/DataTable.js';
import { Button } from '../../design/Button.js';
import { useAppHost } from '../../host.js';
import { featureCsv } from '../../api/admin-report.js';
import { ReadState } from './ReadState.js';
import { Card, HeldLine, Row, RowList, TitleCell, Unknown, dollarsShort, durationHm, readTime } from './Parts.js';
import { PullRequestLink, ReportFiltersRead, ReportNotes } from './ReportParts.js';
import { REPORT_HOME, featurePath, featureReader, freshFacts, useMoneyAiRead, useReadReportFilters } from './read-model.js';
import { RenameButton, MergeButton, StateButton, MoveButton } from '../admin/report/ReportActions.js';
const plural = (n: number, one: string) => `${String(n)} ${one}${n === 1 ? '' : 's'}`;
const stateText = (state: 'open' | 'done' | undefined) => state === 'done' ? 'Done' : state === 'open' ? 'Open' : undefined;
/** The board's "Manage features", read-only: the features list, the selected feature's tasks, and the grouping history (not served: one plain line, no chip). */
export function FeatureDetailReadScreen() {
 const navigate = useNavigate(), host = useAppHost();
 const id = useParams()['id'] ?? 'none', filters = useReadReportFilters();
 const read = useMoneyAiRead('feature', featurePath(id) + filters.query, featureReader(id));
 const loaded = freshFacts(read);
 // Not gated on isFetching: a refused change re-reads the page, and unmounting the buttons would close the open confirm and lose Cloud's sentence (the action host fences every send on the latest read).
 const canChange = !read.isError && loaded?.canChange === true;
 const crumbs = [{ label: 'Company', href: '/app/admin' }, { label: 'Money', href: '/app/admin/money/budgets' }, { label: 'Report', href: REPORT_HOME + filters.carry }];
 return <>
  <PageHeader title="Manage features" breadcrumbs={crumbs} actions={<Link className="rv-button rv-button-secondary" to={REPORT_HOME + filters.carry}>Back to Cost and time</Link>} {...(loaded === undefined ? {} : { description: `Which tasks the report groups into each feature.${servedReadState(read).staleSince === undefined ? ` · Read from Rovara ${readTime(loaded.asOf)}` : ''}` })} focusOnMount />
  <ReadState read={read} label="Features">{data => {
   const projects = Array.from(new Set(data.tasks.map(task => task.project)));
   const listed = data.features.some(feature => feature.id === data.feature.id) || data.feature.none ? data.features : [{ id: data.feature.id, name: data.feature.name, ...(data.feature.state === undefined ? {} : { state: data.feature.state }) }, ...data.features];
   const features = data.feature.none ? [{ id: 'none', name: 'Not in a feature' } as { id: string; name: string; state?: 'open' | 'done' }, ...listed] : listed;
   const selectedId = data.feature.none ? 'none' : data.feature.id;
   const own = `${plural(data.totals.tasks, 'task')}${projects.length > 0 ? ` in ${plural(projects.length, 'project')}` : ''}`;
   const time = data.totals.endToEndMs === undefined ? undefined : `${durationHm(data.totals.endToEndMs)}${data.totals.endToEndSoFar ? ' so far' : ''}`;
   return <>
    <ReportFiltersRead state={filters} />
    <Card title="Features">
     <RowList>{features.map(feature => {
      const selected = feature.id === selectedId, state = feature.id === 'none' ? 'None' : stateText(feature.state);
      return <Row key={feature.id} selected={selected}
       title={selected ? feature.name : <Link to={`${REPORT_HOME}/features/${encodeURIComponent(feature.id)}${filters.carry}`}>{feature.name}</Link>}
       {...(feature.id === 'none' ? { meta: 'Tasks nobody has grouped yet' } : {})}
       end={state ?? <Unknown />} />;
     })}</RowList>
    </Card>
    <Card title={data.feature.name} label="Selected feature" sub={[own, dollarsShort(data.totals.costCents, data.totals.costIsFloor), time].filter(Boolean).join(' · ')}
     actions={<>{canChange && !data.feature.none && <>
      <RenameButton key={data.feature.name} feature={data.feature} />
      <MergeButton feature={data.feature} others={data.features.filter(other => other.id !== data.feature.id)} onMerged={into => { void navigate(`${REPORT_HOME}/features/${encodeURIComponent(into)}${filters.carry}`); }} />
      <StateButton feature={data.feature} />
     </>}
      {/* The live page's Download CSV (WIRING-1B): a read-only export of the tasks on screen (featureCsv). */}
      <Button disabled={data.tasks.length === 0} onClick={() => { host.saveFile('feature-tasks.csv', new Blob([featureCsv(data.tasks, data)], { type: 'text/csv' })); }}>Download CSV</Button></>}>
     {data.tasks.length > 0 && <DataTable caption="Tasks in this feature" rows={data.tasks} rowKey={task => task.taskId} columns={[
      { key: 'task', title: 'Task', render: task => <TitleCell title={task.taskPage === undefined ? task.title : <a href={task.taskPage}>{task.title}</a>} summary={<>{`${task.project} · ${task.costUnavailable ? 'cost unavailable' : dollarsShort(task.costCents, task.unpricedCalls > 0)}`} · <PullRequestLink task={task} /></>} /> },
      { key: 'project', title: 'Project', render: task => task.project },
      { key: 'pr', title: 'Pull request', render: task => <PullRequestLink task={task} /> },
      { key: 'cost', title: 'AI cost', render: task => task.costUnavailable ? 'Cost unavailable' : dollarsShort(task.costCents, task.unpricedCalls > 0) },
      ...(canChange ? [{ key: 'move', title: 'Move', render: (task: typeof data.tasks[number]) => <span className="g2-move"><MoveButton task={task} current={data.feature.none ? undefined : data.feature.id} features={data.features} /></span> }] : []),
     ]} />}
     {data.tasks.length === 0 && <p className="g2-note">No tasks in this range.</p>}
     {data.tasksTotal > data.tasks.length && <p className="g2-note" role="status">Showing {data.tasks.length} of {data.tasksTotal} tasks. Totals count all served tasks.</p>}
     <ReportNotes totals={data.totals} {...(data.unreadableTasks === undefined ? {} : { unreadable: data.unreadableTasks })} />
    </Card>
    <Card title="History · last 30 days">
     <HeldLine role="status">Version history isn&apos;t shown yet.</HeldLine>
    </Card>
   </>;
  }}</ReadState>
 </>;
}
