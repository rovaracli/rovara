import { pullRequestWords, unreadableWords, RANGES, RANGE_WORDS, ORIGINS, ORIGIN_WORDS, PATHS, PATH_WORDS, type ReportNumbers } from '../../api/admin-report.js';
import { StatusChip } from '../../design/StatusChip.js';
import { FactChip } from './Parts.js';
import type { useReadReportFilters } from './read-model.js';
/** A task's pull request as the live page drew it: "1 merged of 1", a link to the first pull request when one was served. */
export function PullRequestLink({ task }: { task: { prLinks: readonly string[]; prsMerged: number; prsOpened: number } }) {
 const words = pullRequestWords(task.prsMerged, task.prsOpened);
 return task.prLinks[0] !== undefined ? <a className="g2-pr" href={task.prLinks[0]} target="_blank" rel="noopener noreferrer">{words}</a> : <>{words}</>;
}
/** What the totals cannot say on their own: price coverage, unpriced calls and tasks left out. One quiet block of small lines. */
export function ReportNotes({ totals, unreadable }: { totals: ReportNumbers; unreadable?: number }) {
 const foreign = totals.foreignCurrencyTasks ?? 0, priced = totals.pricedTasks;
 // Only the lines that apply; nothing when every task is priced in USD.
 return <div className="g2-notes">
  {priced !== undefined && priced + foreign < totals.tasks && <p>{`${String(priced)} of ${String(totals.tasks)} ${totals.tasks === 1 ? 'task' : 'tasks'} ${priced === 1 ? 'has' : 'have'} a full USD price.`}</p>}
  {foreign > 0 && <p>{`${String(foreign)} ${foreign === 1 ? 'task is' : 'tasks are'} in another currency and left out of the USD cost.`}</p>}
  {totals.unpricedCalls > 0 && <p role="status">{`${String(totals.unpricedCalls)} ${totals.unpricedCalls === 1 ? 'call has' : 'calls have'} no price yet, so the cost shown is a minimum.`}</p>}
  {unreadable !== undefined && unreadable > 0 && <p role="status">{unreadableWords(unreadable)}</p>}
 </div>;
}
const STATE_WORDS_FILTER = { open: 'Open', merged: 'Merged', closed: 'Closed or failed' } as const;
/**
 * The boards show no filter bar. The read filters stay (same URL words, same reads) behind one quiet "Filter" disclosure,
 * closed by default, whose summary says what is applied.
 */
export function ReportFiltersRead({ state, projects = [] }: { state: ReturnType<typeof useReadReportFilters>; projects?: readonly string[] }) {
 const { filters, select } = state;
 const options = (values: ReadonlyArray<readonly [string, string]>) => values.map(([value, label]) => <option key={value} value={value}>{label}</option>);
 const applied = [RANGE_WORDS[state.range], filters.project, filters.origin === undefined ? undefined : ORIGIN_WORDS[filters.origin], filters.state === undefined ? undefined : STATE_WORDS_FILTER[filters.state], filters.path === undefined ? undefined : PATH_WORDS[filters.path]].filter(Boolean).join(' · ');
 return <details className="g2-filter">
  <summary>Filter<span> · {applied}</span></summary>
  <div className="g2-filters" role="group" aria-label="Report filters">
   <label>Date range<select className="rv-input" value={state.range} onChange={e => select('range', e.target.value)}>{options(RANGES.map(id => [id, RANGE_WORDS[id]] as const))}</select></label>
   <label>Project<select className="rv-input" value={filters.project ?? ''} onChange={e => select('project', e.target.value)}>{options([['', 'All projects'], ...Array.from(new Set([...(filters.project ? [filters.project] : []), ...projects])).map(name => [name, name] as const)])}</select></label>
   <label>Where it started<select className="rv-input" value={filters.origin ?? ''} onChange={e => select('origin', e.target.value)}>{options([['', 'Anywhere'], ...ORIGINS.map(id => [id, ORIGIN_WORDS[id]] as const)])}</select></label>
   <label>State<select className="rv-input" value={filters.state ?? ''} onChange={e => select('state', e.target.value)}>{options([['', 'Any state'], ['open', 'Open'], ['merged', 'Merged'], ['closed', 'Closed or failed']])}</select></label>
   <label>Path<select className="rv-input" value={filters.path ?? ''} onChange={e => select('path', e.target.value)}>{options([['', 'Any path'], ...PATHS.map(id => [id, PATH_WORDS[id]] as const)])}</select></label>
  </div>
 </details>;
}
/** A task's result as a chip: Merged and Failed are the shared chips; an open or closed task is a neutral fact, never "Running" (not served). */
export function TaskResult({ state }: { state: 'open' | 'merged' | 'closed' | 'failed' }) {
 if (state === 'merged') return <StatusChip state="merged" />;
 if (state === 'failed') return <StatusChip state="failed" />;
 return state === 'open' ? <FactChip icon="dash">Open</FactChip> : <FactChip icon="stop">Closed</FactChip>;
}
