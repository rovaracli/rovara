// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { mount } from './harness.js';
import { FEATURE, denied, failed, reply, detail } from './fixtures.js';
describe('G2 screens are composed from the shared design system, in the approved boards\' structure', () => {
 it('money report: Money title, the four Money tabs, the feature table with a totals row and the selected-feature card, the live New feature control', async () => {
  const f = mount('/app/admin/money/report?range=all');
  const heading = await screen.findByRole('heading', { level: 1, name: 'Money' });
  const header = heading.closest('header.rv-page-header');
  expect(header).not.toBeNull();
  const crumbs = within(header as HTMLElement).getByRole('navigation', { name: 'Breadcrumb' });
  expect(within(crumbs).getAllByRole('link').map(link => link.textContent)).toEqual(['Company']);
  const money = screen.getByRole('navigation', { name: 'Money' });
  expect(within(money).getAllByRole('link').map(link => link.textContent)).toEqual(['Limits', 'Spending', 'Who pays']);
  expect(within(money).getAllByRole('button').map(button => button.textContent)).toEqual(['Report']);
  const table = await screen.findByRole('table', { name: 'Cost and time by feature' });
  expect(table.classList.contains('rv-table-v2')).toBe(true);
  expect(within(table).getByRole('row', { name: /Task work in this report/u })).toBeTruthy();
  expect(screen.getAllByRole('tab').map(tab => tab.textContent)).toEqual(['By feature', 'By project']);
  const card = await screen.findByRole('region', { name: 'Selected feature' });
  expect(await within(card).findByRole('table', { name: 'Tasks in Refunds' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'New feature' })).toBeTruthy();
  expect(f.requests.every(request => request.method === 'GET')).toBe(true);
 });
 // WIRING-1 restore: who pays and the monthly limit are changed on the AI page, so the Money tab is a link to its Spending section (it used to say it is not read here).
 it('"Who pays" links to the AI page\'s Spending section', async () => {
  mount('/app/admin/money/report?range=all');
  await screen.findByRole('table', { name: 'Cost and time by feature' });
  expect(within(screen.getByRole('navigation', { name: 'Money' })).getByRole('link', { name: 'Who pays' }).getAttribute('href')).toBe('/app/admin/ai-spending#ai-spending');
  expect(screen.queryByText('Who pays is not read on this page.')).toBeNull();
 });
 it('rows carry a phone summary line and a decorative chevron; the filter controls sit behind one disclosure', async () => {
  mount('/app/admin/money/report?range=all');
  await screen.findByRole('table', { name: 'Cost and time by feature' });
  expect(document.querySelectorAll('.g2-summary').length).toBeGreaterThan(0);
  expect(Array.from(document.querySelectorAll('.g2-go')).every(node => node.getAttribute('aria-hidden') === 'true')).toBe(true);
  const filter = document.querySelector('details.g2-filter');
  expect(filter).not.toBeNull();
  expect((filter as HTMLDetailsElement).open).toBe(false);
  expect(filter?.querySelector('summary')?.textContent).toMatch(/^Filter · All time/u);
 });
 it('selected feature card: Merged is the shared chip, an open task is a neutral fact chip, a fact that is never served is plain text, not an Unknown chip', async () => {
  mount('/app/admin/money/report?range=all', async request => ({ status: 200, body: request.path.includes('/features/') ? { ...detail, tasks: [...detail.tasks, { ...detail.tasks[0], taskId: 'task-2', title: 'Ship refund receipt', state: 'merged', costUnavailable: false }] } : reply(request).body }));
  const card = await screen.findByRole('region', { name: 'Selected feature' });
  await within(card).findByText('Ship refund receipt');
  const merged = within(card).getByRole('row', { name: /Ship refund receipt/u });
  expect(merged.querySelector('.rv-status-chip[data-state=merged]')).not.toBeNull();
  const open = within(card).getByRole('row', { name: /Handle duplicate refunds/u });
  expect(open.querySelector('.rv-status-chip.g2-fact')?.textContent).toBe('Open');
  expect(within(card).getByText("Waiting time isn't shown yet.")).toBeTruthy();
  expect(within(card).queryByText('Waiting time')).toBeNull(); // not a row with an Unknown value
 });
 it('manage features: the features list, the selected feature\'s task table and a History card that says version history is not shown yet, with no chip', async () => {
  mount(`/app/admin/money/report/features/${FEATURE}?range=all`, async request => ({ status: 200, body: request.path.includes('/features/') ? { ...detail, features: [{ id: FEATURE, name: 'Refunds', state: 'open' }, { id: 'ft_bbbbbbbbbbbbbbbbbbbb', name: 'Ledger export', state: 'done' }] } : reply(request).body }));
  expect(await screen.findByRole('heading', { level: 1, name: 'Manage features' })).toBeTruthy();
  const list = await screen.findByRole('region', { name: 'Features' });
  expect(within(list).getAllByRole('listitem').map(item => item.querySelector('strong')?.textContent)).toEqual(['Refunds', 'Ledger export']);
  expect(within(list).getByText('Done')).toBeTruthy();
  expect(within(screen.getByRole('region', { name: 'Selected feature' })).getByRole('table', { name: 'Tasks in this feature' })).toBeTruthy();
  const history = screen.getByRole('region', { name: 'History · last 30 days' });
  expect(within(history).getByText("Version history isn't shown yet.")).toBeTruthy();
  expect(within(history).queryByRole('img', { name: 'Unknown' })).toBeNull();
  expect(document.querySelector('form,input,textarea')).toBeNull();
 });
 it('read failure: the shared error block, one GET-only Load again, no stale facts', async () => {
  let bad = true;
  const f = mount('/app/admin/money/report?range=all', async request => bad ? failed : reply(request));
  const alert = await screen.findByRole('alert');
  expect(alert.querySelector('.rv-outcome')).not.toBeNull();
  expect(within(alert).getByText('The last read did not answer. Previous information is hidden.')).toBeTruthy();
  expect(within(alert).getAllByRole('button').map(button => button.textContent)).toEqual(['Load again', 'Copy']);
  expect(screen.queryByRole('table')).toBeNull();
  bad = false;
  fireEvent.click(within(alert).getByRole('button', { name: 'Load again' }));
  await screen.findByRole('link', { name: 'Refunds' });
  expect(f.requests.every(request => request.method === 'GET')).toBe(true);
 });
 it('access lost: no data, the same 4e error block with Ref and Copy', async () => {
  mount('/app/admin/product-ai', async () => denied);
  const alert = await screen.findByRole('alert');
  expect(alert.querySelector('.rv-outcome')).not.toBeNull();
  expect(within(alert).getByText(/You no longer have access to this page/u)).toBeTruthy();
  expect(within(alert).getByText(/ACCESS-LOST/u)).toBeTruthy();
  expect(within(alert).getAllByRole('button').map(button => button.textContent)).toEqual(['Load again', 'Copy']);
  expect(screen.queryByText('web')).toBeNull();
 });
 it('AI page: both reads failing says so once; one failing keeps the other', async () => {
  mount('/app/admin/ai-spending', async () => failed);
  await screen.findByRole('alert');
  expect(document.querySelectorAll('.rv-outcome')).toHaveLength(1);
 });
 it('AI page: numbered sources with a chip each, models in plain names, one section-level error for a failed read', async () => {
  mount('/app/admin/ai-spending', async request => request.path.includes('agent-models') ? failed : reply(request));
  await waitFor(() => expect(Array.from(document.querySelectorAll('ol.g2-rows li strong')).map(node => node.textContent)).toEqual(['Your Anthropic key', 'Your own endpoint']));
  expect(screen.getByRole('heading', { name: 'Sources, in the order Rovara tries them' })).toBeTruthy();
  await waitFor(() => expect(document.querySelectorAll('.rv-outcome')).toHaveLength(1));
  expect(screen.getAllByText("Rovara couldn't read this section").length).toBe(1);
  expect(screen.queryByText(/Connected credentials do not verify/u)).toBeNull();
 });
 it('source order is its own view: saved version, numbered sources, the owners-only line, no AI-and-spending page', async () => {
  mount('/app/admin/ai-spending/order');
  expect(await screen.findByRole('heading', { level: 1, name: 'Order of AI sources' })).toBeTruthy();
  await screen.findByRole('heading', { name: 'Saved now, version 3' });
  const header = screen.getByRole('heading', { level: 1 }).closest('header');
  expect(header?.textContent).toMatch(/Saved order · version 3 · Read from Rovara /u);
  const means = screen.getByRole('heading', { name: 'What this order means now' }).closest('section') as HTMLElement;
  expect(within(means).getByText("Which projects and tasks use this order isn't shown yet.")).toBeTruthy();
  expect(within(means).queryByRole('img', { name: 'Unknown' })).toBeNull();
  expect(screen.getByRole('heading', { name: 'Saved now, version 3' })).toBeTruthy();
  expect(Array.from(document.querySelectorAll('ol li strong')).map(node => node.textContent)).toEqual(['Your Anthropic key', 'Your own endpoint']);
  expect(screen.getByText(/Only your company.s owners and admins can change the order/u)).toBeTruthy();
  expect(screen.queryByRole('table')).toBeNull();
  expect(screen.queryByRole('heading', { name: 'The model each step uses now' })).toBeNull();
 });
 it('product AI: one row per project with a status chip and its own Replace / Remove', async () => {
  mount('/app/admin/product-ai');
  await screen.findByText('Key connected');
  const list = screen.getByRole('list', { name: 'Projects' });
  expect(within(list).getAllByRole('listitem')).toHaveLength(1);
  // Each row carries its own Replace / Remove (here the key is connected); the live page's Project field (open any project by name) is below the rows (WIRING-1 restore).
  expect(screen.getByLabelText('Project')).toBeTruthy(); expect(screen.getByRole('button', { name: 'Open' })).toBeTruthy();
  expect(within(list).getByRole('button', { name: 'Replace the key on web' })).toBeTruthy();
  expect(within(list).getByRole('button', { name: 'Remove key from web' })).toBeTruthy();
 });
});

it('empty source order has no saved version and uses Connected consistently', async () => {
 mount('/app/admin/ai-spending/order', async r => ({ ...reply(r), body: { ...reply(r).body as object, order: [], sources: [] } }));
 await screen.findByText('No saved order yet.'); // sources [] lists nothing to say the default from: the shared Unknown, not a claim
 expect(screen.queryByText(/version 3/u)).toBeNull();
 expect(screen.getByText(/Connected/u)).toBeTruthy();
 expect(screen.queryByText(/was served/u)).toBeNull();
});
it('product status does not claim test outcomes', async () => {
 mount('/app/admin/product-ai');
 await screen.findByText('Key connected');
 expect(screen.getByText('Test results are not shown here.')).toBeTruthy();
 expect(screen.queryByText(/Whether a test passes/u)).toBeNull();
});
