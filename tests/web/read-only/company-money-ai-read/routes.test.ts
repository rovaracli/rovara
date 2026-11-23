// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { mount } from './harness.js';
import { FEATURE, scope, report, reply } from './fixtures.js';
describe('G2 canonical read leaves', () => {
 it.each([
  ['/app/admin/money/report?range=all', 'Money', 'Refunds'],
  [`/app/admin/money/report/features/${FEATURE}?range=all`, 'Manage features', 'Handle duplicate refunds'],
  ['/app/admin/ai-spending', 'AI and spending', 'fixture-model'],
  ['/app/admin/ai-spending/order', 'Order of AI sources', 'Your Anthropic key'],
  ['/app/admin/product-ai', 'Product AI keys', 'Key connected'],
 ])('mounts %s through its own admin-relative module', async (path, heading, fact) => {
  mount(path); expect(await screen.findByRole('heading', { name: heading, level: 1 })).toBeTruthy(); expect((await screen.findAllByText(fact, { exact: true })).length).toBeGreaterThan(0);
 });
 it('keeps source order in the existing AI connections anchor', async () => {
  const f = mount('/app/admin/ai-spending#ai-connections');
  expect(await screen.findByRole('heading', { name: 'Sources, in the order Rovara tries them' })).toBeTruthy();
  await waitFor(() => expect(Array.from(document.querySelectorAll('ol.g2-rows li strong')).map(node => node.textContent)).toEqual(['Your Anthropic key', 'Your own endpoint']));
  expect(f.router.state.location.hash).toBe('#ai-connections');
 });
 it('carries report filters to the feature and back without sending', async () => {
  const f = mount('/app/admin/money/report?range=all&project=web&origin=web&state=open&path=quick');
  const link = await screen.findByRole('link', { name: 'Refunds' }); fireEvent.click(link);
  await screen.findByText('Handle duplicate refunds');
  expect(f.router.state.location.search).toContain('project=web');
  expect(f.requests.some(r => r.path.endsWith('?project=web&origin=web&state=open&path=quick'))).toBe(true);
  expect(screen.getByRole('link', { name: 'Report' }).getAttribute('href')).toBe('/app/admin/money/report?range=all&project=web&origin=web&state=open&path=quick');
 });
 it.each([
  ['/app/admin/money/report?range=last-90', 'Refunds'],
  [`/app/admin/money/report/features/${FEATURE}?range=last-90`, 'Handle duplicate refunds'],
 ])('settles last-90 at %s without re-keying on unrelated rerenders', async (path, fact) => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-21T15:20:00Z'));
  try {
   const f = mount(path);
   await screen.findAllByText(fact, { exact: true });
   // The report also reads its selected feature; this test is about the page's own read.
   const reads = () => f.requests.filter(request => path.includes('/features/') || !request.path.includes('/features/'));
   await waitFor(() => expect(reads()).toHaveLength(1));
   const firstPath = reads()[0]?.path;
   vi.setSystemTime(new Date('2026-11-21T16:20:00Z'));
   f.setScope({ ...scope, company: 'Renamed company' });
   if (!path.includes('/features/')) fireEvent.click(screen.getByRole('tab', { name: 'By project' }));
   await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)); });
   expect(reads()).toHaveLength(1);
   expect(new URL(firstPath ?? '', 'https://fixture.invalid').searchParams.get('from')).toBe('2026-08-23T00:00:00.000Z');
   expect(f.client.getQueryCache().getAll()).toHaveLength(1);
   expect(screen.queryByText(/Reading/u)).toBeNull();
   if (!path.includes('/features/')) fireEvent.click(screen.getByRole('tab', { name: 'By feature' }));
   expect(screen.getAllByText(fact, { exact: true }).length).toBeGreaterThan(0);
   fireEvent.change(screen.getByLabelText('Where it started'), { target: { value: 'web' } });
   await waitFor(() => expect(reads()).toHaveLength(2));
   await screen.findAllByText(fact, { exact: true });
   expect(new URL(reads()[1]?.path ?? '', 'https://fixture.invalid').searchParams.get('origin')).toBe('web');
   await act(async () => { await f.client.refetchQueries(); });
   expect(reads()).toHaveLength(3);
   expect(reads()[2]?.path).toBe(reads()[1]?.path);
   expect(reads()[0]?.path).toBe(firstPath);
  } finally { vi.useRealTimers(); }
 });
 it('does not read a project whose name is not a valid project name', async () => {
  const f = mount('/app/admin/product-ai', async request => request.path === '/v1/app/org/report' ? { status: 200, body: { ...report, projects: ['web', '../private', 'Private'] } } : reply(request));
  await screen.findByText('Key connected');
  expect(f.requests.filter(request => request.path.includes('product-ai'))).toHaveLength(1);
  expect(f.requests.some(request => /private/iu.test(request.path))).toBe(false);
 });
});
