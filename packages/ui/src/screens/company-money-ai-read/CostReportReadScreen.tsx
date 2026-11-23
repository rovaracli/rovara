import { servedReadState } from '../../api/served-read.js';
import { useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router';
import { PageHeader } from '../../design/PageHeader.js';
import { DataTable } from '../../design/DataTable.js';
import { Button } from '../../design/Button.js';
import { useAppHost } from '../../host.js';
import { ORIGIN_WORDS, RANGE_WORDS, reportCsv } from '../../api/admin-report.js';
import { ReadState } from './ReadState.js';
import { Facts, Section, TitleCell, Unknown, dollarsShort, durationHm, readTime } from './Parts.js';
import { PullRequestLink, ReportFiltersRead, ReportNotes, TaskResult } from './ReportParts.js';
import { REPORT_HOME, REPORT_PATH, featurePath, featureReader, freshFacts, reportReader, useMoneyAiRead, useReadReportFilters } from './read-model.js';
import { NewFeatureButton } from '../admin/report/ReportActions.js';
type Data = ReturnType<typeof reportReader.parse>;
type Group = Data['byFeature'][number];
type Row = { kind: 'group'; group: Group } | { kind: 'total'; totals: Data['totals'] };
type Filters = ReturnType<typeof useReadReportFilters>;
const plural = (n: number, one: string) => `${String(n)} ${one}${n === 1 ? '' : 's'}`;
const timeText = (ms: number | undefined, soFar: boolean | undefined) => ms === undefined ? undefined : durationHm(ms) + (soFar ? ' so far' : '');
const stateText = (group: Group) => group.key === 'none' ? 'None' : group.state === 'done' ? 'Done' : group.state === 'open' ? 'Open' : undefined;
// Who pays and the monthly limit are changed on the AI page's Spending section.
const PAGE_ROWS = 25;
const MONEY_TABS = [['Limits', '/app/admin/money/limits'], ['Spending', '/app/admin/money/budgets'], ['Who pays', '/app/admin/ai-spending#ai-spending']] as const;

/** The board's selected-feature card: the feature's own facts and task table, from its own served read. */
function SelectedFeature({ id, name, filters }: { id: string; name: string; filters: Filters }) {
 const read = useMoneyAiRead('feature', featurePath(id) + filters.query, featureReader(id));
 const data = freshFacts(read);
 if (data === undefined) return <section className="g2-card g2-feature" aria-label="Selected feature"><span className="g2-eyebrow">Feature</span><h2>{name}</h2>
  <ReadState read={read} label="Feature tasks" scope="section">{() => null}</ReadState>
 </section>;
 const projects = new Set(data.tasks.map(task => task.project)).size;
 const state = data.feature.none ? undefined : data.feature.state === 'done' ? 'Done' : data.feature.state === 'open' ? 'Open' : undefined;
 const open = data.tasks.some(task => task.state === 'open');
 return <section className="g2-card g2-feature" aria-label="Selected feature"><ReadState read={read} label="Feature tasks" scope="section">{() => <>
  <span className="g2-eyebrow">Feature</span>
  <h2>{data.feature.name}</h2>
  <p className="g2-sub">{[state, `${plural(data.totals.tasks, 'task')}${projects > 0 ? ` in ${plural(projects, 'project')}` : ''}`].filter(Boolean).join(' · ')}</p>
  <Facts rows={[
   ['AI cost', dollarsShort(data.totals.costCents, data.totals.costIsFloor)],
   ['End to end', timeText(data.totals.endToEndMs, data.totals.endToEndSoFar) ?? <Unknown />],
   ['Waiting time', <Unknown />],
  ]} />
  {data.tasks.length > 0 && <DataTable caption={`Tasks in ${data.feature.name}`} rows={data.tasks} rowKey={task => task.taskId} columns={[
   { key: 'task', title: 'Task', render: task => <TitleCell title={task.title} sub={`${task.project} · started from ${ORIGIN_WORDS[task.origin]}`} summary={<><TaskResult state={task.state} />{[task.costUnavailable ? 'cost unavailable' : dollarsShort(task.costCents, task.unpricedCalls > 0), timeText(task.wallMs, task.wallSoFar)].filter(Boolean).map(part => ` · ${String(part)}`).join('')} · <PullRequestLink task={task} /></>} /> },
   { key: 'result', title: 'Result', render: task => <TaskResult state={task.state} /> },
   { key: 'pr', title: 'Pull request', render: task => <PullRequestLink task={task} /> },
   { key: 'cost', title: 'Cost', render: task => task.costUnavailable ? 'Cost unavailable' : dollarsShort(task.costCents, task.unpricedCalls > 0) },
   { key: 'time', title: 'Time', render: task => timeText(task.wallMs, task.wallSoFar) ?? <Unknown /> },
  ]} />}
  {data.tasks.length === 0 && <p className="g2-note">No tasks in this range.</p>}
  {data.tasksTotal > data.tasks.length && <p className="g2-note" role="status">Showing {data.tasks.length} of {data.tasksTotal} tasks. Totals count all served tasks.</p>}
  {open && <p className="g2-note">An open task&apos;s cost and time are &ldquo;so far&rdquo; and change.</p>}
 </>}</ReadState></section>;
}

export function CostReportReadScreen() {
 const navigate = useNavigate(), host = useAppHost();
 const filters = useReadReportFilters(), read = useMoneyAiRead('report', REPORT_PATH + filters.query, reportReader);
 const [by, setBy] = useState<'feature' | 'project'>('feature');
 const [picked, setPicked] = useState<string>(), [page, setPage] = useState(0);
 const tab = (label: string, active: boolean, onClick: () => void): ReactNode => <button type="button" className="g2-ctab" aria-pressed={active} onClick={onClick}>{label}</button>;
 return <>
  <PageHeader title="Money" breadcrumbs={[{ label: 'Company', href: '/app/admin' }]} focusOnMount />
  <nav className="g2-context-tabs" aria-label="Money">
   {MONEY_TABS.map(([label, href]) => <Link key={label} className="g2-ctab" to={href}>{label}</Link>)}
   {tab('Report', true, () => undefined)}
  </nav>
  <ReadState read={read} label="Cost report">{data => {
   const groups = [...(by === 'feature' ? data.byFeature : data.byProject)].sort((a, b) => Number(a.key === 'none') - Number(b.key === 'none'));
   // 25 rows a page, as the live page had: data beyond the first page stays reachable. The totals row (all groups) is always last.
   const pages = Math.max(1, Math.ceil(groups.length / PAGE_ROWS)), at = Math.min(page, pages - 1), shown = groups.slice(at * PAGE_ROWS, (at + 1) * PAGE_ROWS);
   const rows: Row[] = [...shown.map(group => ({ kind: 'group', group }) as const), { kind: 'total', totals: data.totals }];
   const selectable = by === 'feature' ? groups.filter(group => group.key !== 'none' || data.byFeature.length === 1) : [];
   const selected = by === 'feature' ? (groups.find(group => group.key === picked) ?? selectable[0]) : undefined;
   const summary = (parts: Array<string | undefined>) => parts.filter(Boolean).join(' · ');
   const first = (row: Row) => {
    if (row.kind === 'total') return <TitleCell plain title={<span className="g2-total">Task work in this report</span>} summary={summary([plural(row.totals.tasks, 'task'), dollarsShort(row.totals.costCents, row.totals.costIsFloor), timeText(row.totals.endToEndMs, row.totals.endToEndSoFar)])} />;
    const g = row.group, cost = dollarsShort(g.costCents, g.costIsFloor);
    const title = by === 'feature' ? <Link to={`${REPORT_HOME}/features/${encodeURIComponent(g.key)}${filters.carry}`}><strong>{g.name}</strong></Link> : g.name;
    return <TitleCell plain={by === 'feature'} title={title} {...(by === 'feature' && g.key === 'none' ? { sub: 'Tasks nobody has grouped yet' } : {})} summary={summary([plural(g.tasks, 'task'), cost, timeText(g.endToEndMs, g.endToEndSoFar), by === 'feature' ? stateText(g) : undefined])} />;
   };
   return <>
    <Section title={`${RANGE_WORDS[filters.range]} by ${by}`} right={<ReportFiltersRead state={filters} projects={data.projects} />}
     actions={<>{/* Stays mounted while the page reads again: a refusal re-reads the report, and unmounting would close the open confirm and lose Cloud's sentence. The action host still fences every send on the latest read. */}{!read.isError && freshFacts(read)?.canChange === true && <NewFeatureButton onCreated={id => { void navigate(`${REPORT_HOME}/features/${encodeURIComponent(id)}${filters.carry}`); }} />}
      {/* The live page's Download CSV (WIRING-1B): a read-only export of the table on screen, same file names and the same cell safety (reportCsv). */}
      <Button disabled={groups.length === 0} onClick={() => { host.saveFile(by === 'feature' ? 'cost-and-time-by-feature.csv' : 'cost-and-time-by-project.csv', new Blob([reportCsv(groups, by, data.unreadableTasks)], { type: 'text/csv' })); }}>Download CSV</Button></>}>
     <p className="g2-sub g2-sub-flush">{servedReadState(read).staleSince === undefined && <>Read from Rovara {readTime(data.asOf)} · </>}a task counts in the range it started in, with all of its cost</p>
     <div role="tablist" aria-label="Group report" className="g2-pills">
      <button type="button" role="tab" aria-selected={by === 'feature'} onClick={() => { setBy('feature'); setPage(0); }}>By feature</button>
      <button type="button" role="tab" aria-selected={by === 'project'} onClick={() => { setBy('project'); setPage(0); }}>By project</button>
     </div>
     {data.totals.tasks === 0 ? <p className="g2-card">No tasks in this range.</p> : <DataTable caption={`Cost and time by ${by}`} rows={rows} rowKey={row => row.kind === 'total' ? '__total' : row.group.key} {...(selected === undefined ? {} : { selection: { selectedKey: selected.key, onSelect: setPicked, onOpen: setPicked } })} columns={[
      { key: 'name', title: by === 'feature' ? 'Feature' : 'Project', render: first },
      { key: 'tasks', title: 'Tasks', render: row => row.kind === 'total' ? row.totals.tasks : row.group.tasks },
      { key: 'cost', title: 'AI cost', render: row => row.kind === 'total' ? dollarsShort(row.totals.costCents, row.totals.costIsFloor) : <>{dollarsShort(row.group.costCents, row.group.costIsFloor)}{row.group.unpricedCalls > 0 && <small>{row.group.unpricedCalls} calls not priced</small>}</> },
      { key: 'time', title: 'End to end', render: row => (row.kind === 'total' ? timeText(row.totals.endToEndMs, row.totals.endToEndSoFar) : timeText(row.group.endToEndMs, row.group.endToEndSoFar)) ?? <Unknown /> },
      ...(by === 'feature' ? [{ key: 'state', title: 'State', render: (row: Row) => row.kind === 'total' ? null : stateText(row.group) ?? <Unknown /> }] : []),
     ]} />}
     {pages > 1 && <div className="g2-pager"><span role="status">Showing {at * PAGE_ROWS + 1} to {at * PAGE_ROWS + shown.length} of {groups.length}</span>
      <span className="g2-pager-buttons"><Button disabled={at === 0} onClick={() => setPage(at - 1)}>Previous page</Button><Button disabled={at >= pages - 1} onClick={() => setPage(at + 1)}>Next page</Button></span></div>}
     <ReportNotes totals={data.totals} {...(data.unreadableTasks === undefined ? {} : { unreadable: data.unreadableTasks })} />
    </Section>
    {data.totals.tasks > 0 && <aside className="g2-info"><Unknown /><p><strong>Spending can show a different total.</strong> This report counts AI use inside tasks only. Setup runs and answers that belong to no task are counted in Spending, not here. Neither number is wrong. <Link to="/app/admin/money/budgets">Open Limits and Spending</Link></p></aside>}
    {selected !== undefined && data.totals.tasks > 0 && <SelectedFeature key={selected.key} id={selected.key} name={selected.name} filters={filters} />}
   </>;
  }}</ReadState>
 </>;
}
