// @vitest-environment jsdom
import { beforeEach, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { mount } from './harness.js';
import { FEATURE, reply, scope } from './fixtures.js';
import type { ApiRequest } from '../../../../packages/ui/src/host.js';
const identity = { developer: { id: scope.developerId, name: 'Priya', orgRole: 'admin' }, org: { orgId: scope.orgId, name: 'Acme', plan: 'team' }, identities: [] };
const transport = async (r: Parameters<typeof reply>[0]) => r.path === '/v1/app/me' ? { status: 200, body: identity } : reply(r);
beforeEach(() => localStorage.clear());
// The restored actions sit INSIDE the section or card the boards show them in (mocks 24a / 24f / 24g), not loose between components.
it('money report: New feature is in the report section header, not the page header', async () => {
 mount('/app/admin/money/report', transport);
 const add = await screen.findByRole('button', { name: 'New feature' });
 expect(add.closest('.g2-sec-head')).not.toBeNull();
 expect(add.closest('.rv-page-header')).toBeNull();
});
it('feature page: Rename, Merge into and Mark done are in the selected feature card header; Move has a visible label', async () => {
 const other = { id: 'ft_bbbbbbbbbbbbbbbbbbbb', name: 'Other feature', state: 'open' };
 mount(`/app/admin/money/report/features/${FEATURE}`, async r => r.path.includes('/report/features/') ? { status: 200, body: { ...(reply(r).body as object), features: [other] } } : transport(r));
 const card = await screen.findByRole('region', { name: 'Selected feature' });
 const head = card.querySelector('.g2-card-head')!;
 for (const name of ['Rename', 'Merge into', 'Mark done']) expect(within(head as HTMLElement).getByRole('button', { name })).toBeTruthy();
 // No loose action row between the cards.
 expect(document.querySelector('.g2-feature-actions')).toBeNull();
 expect(within(card).getAllByRole('button', { name: /^Move / })[0]!.textContent).toBe('Move');
});
it('AI: Change order and Change a model are in their section headers; no second settings stack, no zone-named time', async () => {
 mount('/app/admin/ai-spending', transport);
 const order = await screen.findByRole('button', { name: 'Change order' });
 expect(order.closest('.g2-sec-head')?.querySelector('h2')?.textContent).toBe('Sources, in the order Rovara tries them');
 const change = await screen.findByRole('button', { name: 'Change a model' });
 expect(change.closest('.g2-sec-head')?.querySelector('h2')?.textContent).toBe('The model each step uses now');
 expect(screen.queryByText('Company AI connections')).toBeNull();
 expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
 expect(document.body.textContent).not.toMatch(/Read at|UTC|stored snapshot/u);
 // One labelled Save for the company model.
 fireEvent.click(change);
 await screen.findByRole('combobox', { name: 'Company model' });
 expect(screen.getAllByRole('button', { name: /^Save/ }).map(button => button.textContent).filter(text => text === 'Save company model')).toHaveLength(1);
});
it('product AI: each key row has its own actions; the eval budget is a section of the key editor; no loose Project form; the approved eval spend is a section of the same card', async () => {
 mount('/app/admin/product-ai?project=web', transport);
 await screen.findByText('Key connected');
 const row = screen.getByRole('list', { name: 'Projects' });
 expect(within(row).getByRole('button', { name: 'Replace the key on web' }).textContent).toBe('Replace');
 expect(within(row).getByRole('button', { name: 'Remove key from web' }).textContent).toBe('Remove');
 // The live page's Project field is restored below the rows (WIRING-1): not a loose form above them.
 expect(screen.getByLabelText('Project')).toBeTruthy();
 const editor = await screen.findByRole('region', { name: /product AI key/u });
 expect(within(editor).getByRole('region', { name: 'Eval budget' })).toBeTruthy();
 expect(within(editor).getByLabelText('Calls per stage')).toBeTruthy();
 expect(within(editor).getByRole('region', { name: 'Approved eval spend' })).toBeTruthy();
 expect(editor.textContent).not.toMatch(/UTC/u);
 // The typed key is write-only: never filled in, never echoed.
 const key = within(editor).getByLabelText<HTMLInputElement>('Replace the key');
 expect(key.type).toBe('password'); expect(key.value).toBe(''); expect(key.autocomplete).toBe('new-password');
});
it('a project with no key shows Add a key on its row', async () => {
 mount('/app/admin/product-ai', async r => r.path === '/v1/app/projects/web/product-ai' ? { status: 200, body: { ...(reply(r).body as object), key: { connected: false } } } : transport(r));
 const add = await screen.findByRole('button', { name: 'Add a key to web' });
 expect(screen.queryByRole('button', { name: 'Remove key from web' })).toBeNull();
 fireEvent.click(add);
 await waitFor(() => expect(screen.getByRole('region', { name: 'Add a product AI key to web' })).toBeTruthy());
});
it('a legacy address hash focuses its section on the rebuilt AI page', async () => {
 mount('/app/admin/ai-spending#ai-connections', transport);
 await screen.findByRole('button', { name: 'Change order' });
 await waitFor(() => expect(document.activeElement).toBe(document.getElementById('ai-connections')));
});
it('AI: Change a model is not drawn when the models read does not say the person may change them', async () => {
 mount('/app/admin/ai-spending', async r => r.path.endsWith('/agent-models') ? { status: 200, body: { ...(reply(r).body as object), canChange: false } } : transport(r));
 await screen.findByRole('button', { name: 'Change order' });
 expect(screen.queryByRole('button', { name: 'Change a model' })).toBeNull();
});
it('product AI: a row whose key state is not read draws no Replace, Remove or Add a key', async () => {
 mount('/app/admin/product-ai', async r => r.path === '/v1/app/projects/web/product-ai' ? { status: 200, body: { ...(reply(r).body as object), key: {}, vertex: {} } } : transport(r));
 const list = await screen.findByRole('list', { name: 'Projects' });
 await waitFor(() => expect(within(list).queryByText('Reading…')).toBeNull());
 expect(within(list).queryAllByRole('button')).toHaveLength(0);
});
it('company model: Save company model waits for a chosen model and writes the model only (no limit, no source)', async () => {
 const writes: string[] = [];
 // No saved monthly limit and no saved source: the live setup Save would write both; the company page's Save must not.
 mount('/app/admin/ai-spending', async r => {
  if (r.method !== 'GET') { writes.push(`${r.method} ${r.path}`); return { status: 200, body: { model: 'other-model', source: 'company', canChange: true, offered: ['fixture-model', 'other-model'], preselect: 'fixture-model' } }; }
  if (r.path.endsWith('/org/settings')) return { status: 200, body: { version: 1, settings: {} } };
  if (r.path.endsWith('/org/agent-ai')) return { status: 200, body: { version: 0, source: null, choices: [{ source: 'rovara', available: true }] } };
  if (r.path.endsWith('/engine-model')) return { status: 200, body: { model: 'fixture-model', source: 'company', canChange: true, offered: ['fixture-model', 'other-model'], preselect: 'fixture-model' } };
  return transport(r);
 });
 fireEvent.click(await screen.findByRole('button', { name: 'Change a model' }));
 const save = await screen.findByRole('button', { name: 'Save company model' });
 expect(save).toHaveProperty('disabled', true);
 fireEvent.change(await screen.findByLabelText('Company model'), { target: { value: 'other-model' } });
 expect(save).toHaveProperty('disabled', false);
 fireEvent.click(save);
 await waitFor(() => expect(writes).toEqual(['PUT /v1/app/org/engine-model']));
});
it('AI: Change order stays disabled while no source can be used', async () => {
 mount('/app/admin/ai-spending', async r => r.path.endsWith('/model-sources') ? { status: 200, body: { ...(reply(r).body as { sources: Array<object> }), sources: (reply(r).body as { sources: Array<object> }).sources.map(item => ({ ...item, available: false })) } } : transport(r));
 expect(await screen.findByRole('button', { name: 'Change order' })).toHaveProperty('disabled', true);
});

// Approved eval spend: the live Product AI page's Approve / Withdraw, restored on the rebuilt page through the same section and the same send.
const DIGEST = 'b'.repeat(64);
const approved = { selection: 'all-questions', inputsDigest: DIGEST, maxCalls: 5, maxCostMicros: 1000000, approvedAt: Date.UTC(2026, 10, 15), approvedByYou: true, state: 'current' };
const writes = (requests: ApiRequest[]) => requests.filter(r => r.method !== 'GET');
function fillApproval() {
 fireEvent.change(screen.getByLabelText('Question selection'), { target: { value: ' all-questions ' } });
 fireEvent.change(screen.getByLabelText("Inputs digest (SHA-256, from the eval's confirmation)"), { target: { value: DIGEST } });
 fireEvent.change(screen.getByLabelText('Most calls'), { target: { value: '5' } });
 fireEvent.change(screen.getByLabelText('Most spend (USD)'), { target: { value: '1' } });
}
it('product AI: Approve eval spend sends exactly one change with the ids and body of the live page', async () => {
 let saved = false;
 const f = mount('/app/admin/product-ai?project=web', async r => {
  if (r.method !== 'GET') { saved = true; return { status: 200, body: { ...(reply({ ...r, method: 'GET', path: '/v1/app/projects/web/product-ai' }).body as object), revision: 4, evalApproval: approved } }; }
  return r.path === '/v1/app/projects/web/product-ai' && saved ? { status: 200, body: { ...(reply(r).body as object), revision: 4, evalApproval: approved } } : transport(r);
 });
 await screen.findByLabelText('Question selection'); fillApproval();
 const approve = screen.getByRole('button', { name: 'Approve eval spend' }); fireEvent.click(approve); fireEvent.click(approve);
 await waitFor(() => expect(writes(f.requests)).toHaveLength(1));
 const sent = writes(f.requests)[0]!;
 expect(sent).toMatchObject({ method: 'PUT', path: '/v1/app/projects/web/product-ai/eval-approval' });
 const { requestId, ...body } = sent.body as Record<string, unknown>;
 expect(requestId).toMatch(/^[a-f0-9-]{36}$/u);
 expect(body).toEqual({ expectedRevision: 3, approval: { selection: 'all-questions', inputsDigest: DIGEST, maxCalls: 5, maxCostMicros: 1000000 } });
 await screen.findByText('Eval spend approved.');
});
it('product AI: Withdraw approval sends exactly one null approval', async () => {
 let saved = false;
 const f = mount('/app/admin/product-ai?project=web', async r => {
  if (r.method !== 'GET') { saved = true; return { status: 200, body: { ...(reply({ ...r, method: 'GET', path: '/v1/app/projects/web/product-ai' }).body as object), revision: 4 } }; }
  return r.path === '/v1/app/projects/web/product-ai' ? { status: 200, body: { ...(reply(r).body as object), revision: saved ? 4 : 3, ...(saved ? {} : { evalApproval: approved }) } } : transport(r);
 });
 const withdraw = await screen.findByRole('button', { name: 'Withdraw approval' }); fireEvent.click(withdraw); fireEvent.click(withdraw);
 await waitFor(() => expect(writes(f.requests)).toHaveLength(1));
 expect(writes(f.requests)[0]).toMatchObject({ method: 'PUT', path: '/v1/app/projects/web/product-ai/eval-approval', body: { expectedRevision: 3, approval: null } });
 await screen.findByText('Approval withdrawn.');
});
it.each(['refused', 'stale', 'no-permission', 'identity'] as const)('product AI: Approve eval spend %s at send means zero changes', async kind => {
 let changed = false;
 const f = mount('/app/admin/product-ai?project=web', async r => {
  if (changed && r.path === '/v1/app/me' && kind === 'identity') return { status: 200, body: { ...identity, developer: { ...identity.developer, orgRole: 'member' } } };
  if (changed && r.path === '/v1/app/projects/web/product-ai') return kind === 'refused' ? { status: 403, body: { error: { code: 'FORBIDDEN', message: 'Refused' } } } : kind === 'stale' ? { status: 200, body: { ...(reply(r).body as object), revision: 9, canChange: true } } : kind === 'no-permission' ? { status: 200, body: { ...(reply(r).body as object), canChange: false } } : transport(r);
  return transport(r);
 });
 await screen.findByLabelText('Question selection'); fillApproval(); changed = true;
 fireEvent.click(screen.getByRole('button', { name: 'Approve eval spend' }));
 await screen.findByRole('alert'); expect(writes(f.requests)).toHaveLength(0);
});
it('product AI: a clear refusal of Approve shows the server words and the next press sends again', async () => {
 let refuse = true;
 const f = mount('/app/admin/product-ai?project=web', async r => {
  if (r.method === 'PUT') return refuse ? { status: 403, body: { error: { code: 'FORBIDDEN', message: 'Only the project administrator can approve eval spend.' } } } : { status: 200, body: { ...(reply({ ...r, method: 'GET', path: '/v1/app/projects/web/product-ai' }).body as object), revision: 4, evalApproval: approved } };
  return transport(r);
 });
 await screen.findByLabelText('Question selection'); fillApproval();
 fireEvent.click(screen.getByRole('button', { name: 'Approve eval spend' }));
 await screen.findByText('Only the project administrator can approve eval spend.');
 refuse = false; await waitFor(() => expect(screen.getByRole('button', { name: 'Approve eval spend' })).toHaveProperty('disabled', false));
 fireEvent.click(screen.getByRole('button', { name: 'Approve eval spend' }));
 await waitFor(() => expect(writes(f.requests)).toHaveLength(2));
});
it('live parity: every control of the live page\'s Approved eval spend section is on the rebuilt page', async () => {
 const live = await import('../../../../packages/ui/src/screens/admin/product-ai/ProductAiScreen.js');
 const { render } = await import('@testing-library/react');
 const { createElement: h } = await import('react');
 const { QueryClientProvider } = await import('@tanstack/react-query');
 const { createQueryClient } = await import('../../../../packages/ui/src/api/query.js');
 const { AppHostProvider } = await import('../../../../packages/ui/src/host.js');
 const { ProjectScopeContext } = await import('../../../../packages/ui/src/screens/admin/admin-context.js');
 const { fixtureHost } = await import('./fixtures.js');
 const body = { ...(reply({ method: 'GET', path: '/v1/app/projects/web/product-ai' }).body as object), evalApproval: approved };
 const host = fixtureHost(async () => ({ status: 200, body }));
 const view = render(h(AppHostProvider, { host, children: h(QueryClientProvider, { client: createQueryClient() }, h(ProjectScopeContext.Provider, { value: scope }, h(live.ProductAiProject, { project: 'web' }))) }));
 await screen.findByRole('button', { name: 'Approve eval spend' });
 const names = (root: ParentNode) => [...root.querySelectorAll('label')].map(l => l.textContent).concat([...root.querySelectorAll('button')].map(b => b.textContent ?? '')).filter(text => /Question selection|Inputs digest|Most calls|Most spend|Model \(optional\)|Approve eval spend|Withdraw approval/u.test(text ?? ''));
 const liveNames = names(document.body).sort(); view.unmount();
 expect(liveNames).toHaveLength(7);
 mount('/app/admin/product-ai?project=web', async r => r.path === '/v1/app/projects/web/product-ai' ? { status: 200, body } : transport(r));
 await screen.findByRole('button', { name: 'Approve eval spend' });
 expect(names(document.body).sort()).toEqual(liveNames);
});
it('product AI: Approve waits for a valid selection, digest, calls and spend; Withdraw exists only while an approval does', async () => {
 mount('/app/admin/product-ai?project=web', transport);
 await screen.findByLabelText('Question selection');
 const approve = screen.getByRole('button', { name: 'Approve eval spend' });
 expect(approve).toHaveProperty('disabled', true);
 expect(screen.queryByRole('button', { name: 'Withdraw approval' })).toBeNull();
 fillApproval(); expect(approve).toHaveProperty('disabled', false);
 fireEvent.change(screen.getByLabelText("Inputs digest (SHA-256, from the eval's confirmation)"), { target: { value: 'b'.repeat(63) } });
 expect(approve).toHaveProperty('disabled', true);
 fireEvent.change(screen.getByLabelText("Inputs digest (SHA-256, from the eval's confirmation)"), { target: { value: DIGEST } });
 fireEvent.change(screen.getByLabelText('Most calls'), { target: { value: '0' } });
 expect(approve).toHaveProperty('disabled', true);
 fireEvent.change(screen.getByLabelText('Most calls'), { target: { value: '5' } });
 fireEvent.change(screen.getByLabelText('Most spend (USD)'), { target: { value: '0' } });
 expect(approve).toHaveProperty('disabled', true);
});
