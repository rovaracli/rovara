// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { mount } from './harness.js';
import { FEATURE, detail, product, reply, scope, denied, failed } from './fixtures.js';
import type { ApiRequest, ApiResponse } from '../../../../packages/ui/src/host.js';
const identity = { developer: { id: scope.developerId, name: 'Priya', orgRole: 'admin' }, org: { orgId: scope.orgId, name: 'Acme', plan: 'team' }, identities: [] };
const sends = (requests: ApiRequest[]) => requests.filter(r => r.method !== 'GET');
const rename = async () => { fireEvent.click(await screen.findByRole('button', { name: 'Rename' })); fireEvent.change(within(screen.getByRole('dialog')).getByLabelText('Feature name'), { target: { value: 'Refund receipts' } }); };
const confirm = () => fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Rename' }));
function transport(change?: (r: ApiRequest) => ApiResponse | undefined) {
 return async (r: ApiRequest) => change?.(r) ?? (r.path === '/v1/app/me' ? { status: 200, body: identity } : r.method !== 'GET' ? { status: 200, body: { feature: { id: FEATURE, name: 'Refund receipts', state: 'open' } } } : reply(r));
}
beforeEach(() => localStorage.clear());
describe('G2 action authority and delivery', () => {
 it('allowed rename sends exactly once with the exact feature id/body', async () => {
  const f = mount(`/app/admin/money/report/features/${FEATURE}`, transport()); await rename(); confirm(); confirm();
  await waitFor(() => expect(sends(f.requests)).toHaveLength(1));
  expect(sends(f.requests)[0]).toMatchObject({ method: 'POST', path: `/v1/app/org/report/features/${FEATURE}/rename`, body: { name: 'Refund receipts' } });
 });
 it.each(['refused', 'stale', 'no-permission', 'identity'] as const)('%s at send means zero mutation requests', async failure => {
  let changed = false;
  const f = mount(`/app/admin/money/report/features/${FEATURE}`, transport(r => {
   if (!changed) return undefined;
   if (r.path === '/v1/app/me' && failure === 'identity') return { status: 200, body: { ...identity, developer: { ...identity.developer, orgRole: 'member' } } };
   if (r.path.includes('/report/features/')) return failure === 'refused' ? denied : failure === 'stale' ? { status: 200, body: { ...detail, feature: { ...detail.feature, name: 'Changed elsewhere' } } } : failure === 'no-permission' ? { status: 200, body: { ...detail, canChange: false } } : undefined;
   return undefined;
  }));
  await rename(); changed = true; confirm();
  await screen.findByTestId('report-action-error'); expect(sends(f.requests)).toHaveLength(0);
 });
 it('a failed refresh removes open authority and cannot send from the old confirm', async () => {
  let bad = false;
  const f = mount(`/app/admin/money/report/features/${FEATURE}`, transport(r => bad && r.path.includes('/report/features/') ? failed : undefined));
  await rename(); const old = within(screen.getByRole('dialog')).getByRole('button', { name: 'Rename' }); bad = true;
  await act(async () => { await f.client.refetchQueries(); }); fireEvent.click(old);
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull()); expect(sends(f.requests)).toHaveLength(0);
 });
 it('an unknown rename stays locked after close/remount; Check only reads', async () => {
  const tx = transport(r => r.method !== 'GET' ? failed : undefined);
  const f = mount(`/app/admin/money/report/features/${FEATURE}`, tx); await rename(); confirm(); await screen.findByTestId('report-action-error');
  f.view.unmount(); f.router.dispose();
  const g = mount(`/app/admin/money/report/features/${FEATURE}`, tx); await rename(); confirm();
  await screen.findByTestId('report-action-error'); expect(sends(g.requests)).toHaveLength(0);
  fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  fireEvent.click(screen.getByRole('button', { name: 'Check action outcome' }));
  await waitFor(() => expect(g.requests.filter(r => r.method === 'GET').length).toBeGreaterThan(1)); expect(sends(g.requests)).toHaveLength(0);
 });
 it('a browser that cannot persist a lock sends nothing', async () => {
  const f = mount(`/app/admin/money/report/features/${FEATURE}`, transport()); await rename();
  const original = Object.getOwnPropertyDescriptor(Storage.prototype, 'setItem')!;
  Storage.prototype.setItem = () => { throw new Error('blocked'); };
  try { confirm(); await screen.findByTestId('report-action-error'); expect(sends(f.requests)).toHaveLength(0); } finally { Object.defineProperty(Storage.prototype, 'setItem', original); }
 });
 it('product keys are write-only even when an answer includes extra secret fields', async () => {
  const marker = 'fixture-private-marker';
  const f = mount('/app/admin/product-ai?project=web', transport(r => r.path.includes('product-ai') ? { status: 200, body: { ...product, secret: marker, key: { ...product.key, value: marker } } } : undefined));
  await screen.findByRole('button', { name: 'Remove key from web' }); // LAYOUT-COUPLED: Remove is on the project's row
  expect(document.body.innerHTML).not.toContain(marker); expect(JSON.stringify(f.client.getQueryCache().getAll().map(q => q.state.data))).not.toContain(marker);
 });
});
