// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { mount } from './harness.js';
import { denied, failed, reply, scope, report, detail, FEATURE } from './fixtures.js';
import { readFileSync } from 'node:fs';
const held = JSON.parse(readFileSync('tests/web/read-only/company-money-ai-read/held-states.json', 'utf8')) as Array<{ section: number; missing: string; fallback: string }>;
describe('G2 R1/R4/R5 read evidence', () => {
 it.each([401, 403, 404, 200, 202, 503])('wipes access signals at status %s, including body codes, through remount', async status => {
  let bad = false;
  const f = mount('/app/admin/money/report?range=all', async r => bad ? { status, body: [401, 403, 404].includes(status) ? failed.body : denied.body } : reply(r));
  await screen.findByRole('link', { name: 'Refunds' }); bad = true;
  await act(async () => { await f.client.refetchQueries(); });
  await screen.findByRole('alert');
  expect(screen.queryByRole('link', { name: 'Refunds' })).toBeNull();
  expect(screen.queryByText('$61.23 or more')).toBeNull();
  expect(screen.queryByText(/Reconnecting/u)).toBeNull();
  expect(f.client.getQueriesData({ queryKey: ['company-money-ai-read'] }).every(([, data]) => data === undefined)).toBe(true);
  await act(async () => { await f.router.navigate('/app/admin/product-ai'); await f.router.navigate('/app/admin/money/report?range=all'); });
  await screen.findByRole('alert');
  expect(screen.queryByRole('link', { name: 'Refunds' })).toBeNull();
  expect(f.client.getQueriesData({ queryKey: ['company-money-ai-read'] }).every(([, data]) => data === undefined)).toBe(true);
 });
 it.each(['network', 'timeout', '503', '501', '202', 'unreadable', 'aborted'])('keeps last good data and its time on %s without an access signal', async kind => {
  let bad = false;
  const f = mount('/app/admin/money/report?range=all', async r => {
   if (!bad) return reply(r);
   if (kind === 'network' || kind === 'timeout' || kind === 'aborted') throw new Error(kind);
   return { status: kind === 'unreadable' ? 200 : Number(kind), body: kind === 'unreadable' || kind === '202' ? {} : failed.body };
  });
  await screen.findByRole('link', { name: 'Refunds' });
  const query = f.client.getQueryCache().getAll().find(q => q.queryKey[4] === 'report');
  const updatedAt = query?.state.dataUpdatedAt;
  bad = true;
  for (let attempt = 0; attempt < 2; attempt++) {
   await act(async () => { await f.client.refetchQueries(); });
   await waitFor(() => expect(screen.getAllByText(/Reconnecting/u)).toHaveLength(1));
   expect(screen.getByRole('link', { name: 'Refunds' })).toBeTruthy();
   expect(screen.queryByRole('alert')).toBeNull();
   expect(screen.queryByText(/Read from Rovara/u)).toBeNull();
   expect(query?.state.dataUpdatedAt).toBe(updatedAt);
   expect(query?.state.data).toEqual(report);
  }
  bad = false;
  await act(async () => { await f.client.refetchQueries(); });
  await waitFor(() => expect(screen.queryByText(/Reconnecting/u)).toBeNull());
  expect(screen.getByRole('link', { name: 'Refunds' })).toBeTruthy();
 });
 it.each(['/app/admin/money/report?range=all', `/app/admin/money/report/features/${FEATURE}?range=all`, '/app/admin/ai-spending', '/app/admin/ai-spending/order', '/app/admin/product-ai'])('keeps the entire composed page at %s with one stale line', async path => {
  let bad = false;
  const f = mount(path, async r => bad ? failed : reply(r));
  if (path.includes('product-ai')) await screen.findByText('Key connected');
  else if (path.includes('/money/report')) await screen.findByText('Handle duplicate refunds');
  else await screen.findAllByText('Your Anthropic key');
  bad = true;
  await act(async () => { await f.client.refetchQueries(); });
  await waitFor(() => expect(screen.getAllByText(/Reconnecting/u)).toHaveLength(1));
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.queryByText(/Read from Rovara/u)).toBeNull();
  const line = document.querySelector('.g2-reconnecting');
  const above = line?.previousElementSibling;
  expect(above?.matches(path === '/app/admin/money/report?range=all' ? 'nav[aria-label=Money]' : 'header.rv-page-header')).toBe(true);
  if (path.includes('product-ai')) {
   expect(screen.getByText('Key connected')).toBeTruthy();
   expect(screen.getByRole('heading', { level: 1 }).closest('header')?.textContent).toContain('1 project · 1 with a key');
  }
  else if (path.includes('/money/report')) expect(screen.getByText('Handle duplicate refunds')).toBeTruthy();
  else expect(screen.getAllByText('Your Anthropic key').length).toBeGreaterThan(0);
  if (path === '/app/admin/ai-spending') expect(screen.getByRole('table', { name: 'Effective step models' })).toBeTruthy();
 });
 it('has no stale line on a first-read failure', async () => {
  mount('/app/admin/money/report?range=all', async () => failed);
  await screen.findByRole('alert');
  expect(screen.queryByText(/Reconnecting/u)).toBeNull();
 });
 it.each([
  { statuses: [null], summary: '1 project · Unknown' },
  { statuses: [true, null], summary: '2 projects · Unknown' },
  { statuses: [false, null], summary: '2 projects · Unknown' },
  { statuses: [false], summary: '1 project · 0 with a key' },
  { statuses: [true], summary: '1 project · 1 with a key' },
 ])('keeps an honest fresh and retained product-key summary for $statuses', async ({ statuses, summary }) => {
  let bad = false;
  const projects = statuses.map((_, index) => index === 0 ? 'web' : 'api');
  const f = mount('/app/admin/product-ai', async r => {
   if (bad) return failed;
   if (r.path.startsWith('/v1/app/org/report')) return { status: 200, body: { ...report, projects } };
   const index = projects.findIndex(project => r.path === `/v1/app/projects/${project}/product-ai`);
   if (index < 0) throw new Error('Unexpected product read');
   const status = statuses[index];
   return { status: 200, body: { project: projects[index], revision: 3, key: status === null ? {} : { connected: status }, vertex: status === null || status === true ? {} : { connected: false } } };
  });
  await waitFor(() => expect(screen.queryByText('Reading…')).toBeNull());
  // Wait for the lazily loaded page itself: "Reading…" may not have appeared yet, so its absence alone proves nothing (CI run 45092521763).
  const header = (await screen.findByRole('heading', { level: 1 })).closest('header');
  await waitFor(() => expect(header?.textContent).toContain(summary));
  const unknown = statuses.includes(null);
  expect(header?.textContent?.match(/Unknown/gu) ?? []).toHaveLength(unknown ? 1 : 0);
  if (unknown) {
   expect(header?.textContent).not.toMatch(/\d with a key/u);
   expect(within(screen.getByRole('list', { name: 'Projects' })).getAllByRole('img', { name: 'Unknown' })).toHaveLength(1);
   expect(screen.getByText('AI Studio key not read · Vertex AI not read')).toBeTruthy();
  }
  bad = true;
  await act(async () => { await f.client.refetchQueries(); });
  await screen.findByText(/Reconnecting/u);
  expect(header?.textContent).toContain(summary);
  expect(header?.textContent).not.toContain('Read from Rovara');
  expect(header?.textContent?.match(/Unknown/gu) ?? []).toHaveLength(unknown ? 1 : 0);
  if (unknown) expect(header?.textContent).not.toMatch(/\d with a key/u);
 });
 it('hides prior facts while identity is checking and on member downgrade', async () => {
  const f = mount('/app/admin/money/report?range=all'); await screen.findByRole('link', { name: 'Refunds' });
  f.setScope({ ...scope, checking: true }); expect(screen.queryByRole('link', { name: 'Refunds' })).toBeNull();
  f.setScope({ ...scope, role: 'member' }); expect(screen.queryByText('$61.23 or more')).toBeNull();
 });
 it('never reuses another company or person snapshot', async () => {
  let pending = false; const f = mount('/app/admin/money/report?range=all', r => pending ? new Promise(() => undefined) : Promise.resolve(reply(r)));
  await screen.findByRole('link', { name: 'Refunds' }); pending = true;
  f.setScope({ ...scope, orgId: 'other-company', developerId: 'other-person' });
  expect(screen.queryByRole('link', { name: 'Refunds' })).toBeNull();
 });
 it('rejects a product response for a different project', async () => {
  mount('/app/admin/product-ai?project=web', async () => ({ status: 200, body: { project: 'private-project', revision: 3, key: { connected: true } } }));
  expect(await screen.findByText('The last read did not answer. Previous information is hidden.')).toBeTruthy(); expect(screen.queryByText('Connected', { exact: true })).toBeNull();
 });
 it('removes all AI facts when one read loses authority', async () => {
  let bad = false; const f = mount('/app/admin/ai-spending', async r => bad && r.path.includes('model-sources') ? denied : reply(r));
  await screen.findAllByText('fixture-model'); bad = true;
  await act(async () => { await f.client.refetchQueries(); });
  await screen.findByRole('alert');
  expect(screen.queryByText('fixture-model')).toBeNull(); expect(screen.queryByText('Your Anthropic key')).toBeNull();
 });
 it('does not infer last-test success or availability from a connected source', async () => {
  mount('/app/admin/ai-spending'); await screen.findAllByText('fixture-model');
  expect(screen.getAllByRole('img', { name: 'Unknown' }).length).toBeGreaterThan(0);
  expect(screen.queryByText('Working', { exact: true })).toBeNull(); expect(screen.queryByText(/last call succeeded/u)).toBeNull();
 });
 it('shows money floors, coverage, missing time and partial rows as facts', async () => {
  mount(`/app/admin/money/report/features/${FEATURE}?range=all`, async () => ({ status: 200, body: detail }));
  await screen.findByText('Handle duplicate refunds');
  expect(screen.getByText('Cost unavailable')).toBeTruthy(); expect(screen.getAllByRole('img', { name: 'Unknown' }).length).toBeGreaterThan(0);
  expect(screen.getByText(/1 task couldn't be read/u)).toBeTruthy(); expect(screen.getByText(/Showing 1 of 2 tasks/u)).toBeTruthy();
  expect(screen.getByText(/1 of 2 tasks has a full USD price/u)).toBeTruthy();
 });
 it('only calls a successful zero-task read empty', async () => {
  mount('/app/admin/money/report?range=all', async () => ({ status: 200, body: { ...report, byFeature: [], byProject: [], totals: { tasks: 0, prsOpened: 0, prsMerged: 0, costCents: 0, unpricedCalls: 0, costIsFloor: false, pricedTasks: 0, foreignCurrencyTasks: 0 } } }));
  expect(await screen.findByText('No tasks in this range.')).toBeTruthy();
 });
 it('keeps a missing feature-detail state unknown after a successful task read', async () => {
  const { state: omitted, ...feature } = detail.feature;
  expect(omitted).toBe('open');
  mount(`/app/admin/money/report/features/${FEATURE}?range=all`, async () => ({ status: 200, body: { ...detail, feature } }));
  await screen.findByText('Handle duplicate refunds');
  expect(screen.queryByText('State not set')).toBeNull();
  expect(screen.queryByText('No feature set')).toBeNull();
  const listed = screen.getByRole('region', { name: 'Features' }).querySelector('li[aria-current]');
  expect(within(listed as HTMLElement).getByRole('img', { name: 'Unknown' })).toBeTruthy();
 });
 it('keeps a missing report feature state unknown and omits project state', async () => {
  const byFeature = report.byFeature.map(({ state: omitted, ...row }) => { expect(omitted).toBe('open'); return row; });
  mount('/app/admin/money/report?range=all', async () => ({ status: 200, body: { ...report, byFeature } }));
  await screen.findByRole('link', { name: 'Refunds' });
  const row = screen.getByRole('row', { name: /Refunds/u });
  expect(within(row).queryByText('Not set')).toBeNull();
  expect(within(row).getByRole('img', { name: 'Unknown' })).toBeTruthy();
  fireEvent.click(screen.getByRole('tab', { name: 'By project' }));
  expect(screen.queryByRole('columnheader', { name: 'State' })).toBeNull();
  expect(screen.getByRole('row', { name: /^web/u }).children).toHaveLength(4);
 });
 it('does not assign feature state to project rows', async () => {
  mount('/app/admin/money/report?range=all');
  await screen.findByRole('link', { name: 'Refunds' });
  fireEvent.click(screen.getByRole('tab', { name: 'By project' }));
  expect(screen.queryByRole('columnheader', { name: 'State' })).toBeNull();
  expect(screen.getByRole('row', { name: /^web/u }).children).toHaveLength(4);
 });
 it('uses no-feature wording only for a served none flag', async () => {
  mount('/app/admin/money/report/features/none?range=all', async () => ({ status: 200, body: { ...detail, feature: { id: 'none', name: 'No feature', none: true } } }));
  await screen.findByText('Handle duplicate refunds');
  expect(screen.getByText(/Tasks nobody has grouped yet/u)).toBeTruthy();
  expect(screen.queryByText('No feature set')).toBeNull();
 });
 it('documents a fallback for every assigned held section', () => {
  expect(new Set(held.map(row => row.section))).toEqual(new Set([22, 23, 29, 30, 31]));
  for (const row of held) { expect(row.missing.length).toBeGreaterThan(0); expect(row.fallback.length).toBeGreaterThan(0); }
 });
});
