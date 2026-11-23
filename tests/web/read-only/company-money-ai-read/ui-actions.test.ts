// @vitest-environment jsdom
import { beforeEach, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { mount } from './harness.js';
import { product, reply, scope } from './fixtures.js';
import type { ApiRequest } from '../../../../packages/ui/src/host.js';
const identity = { developer: { id: scope.developerId, name: 'Priya', orgRole: 'admin' }, org: { orgId: scope.orgId, name: 'Acme', plan: 'team' }, identities: [] };
const marker = 'fixture-private-marker';
const writes = (requests: ApiRequest[]) => requests.filter(r => r.method !== 'GET');
beforeEach(() => localStorage.clear());
it.each(['connect', 'replace', 'remove', 'vertex-connect', 'vertex-remove', 'budget'] as const)('product %s calls the exact live handler once and never echoes a key', async action => {
 let saved = false;
 const initial = { ...product, key: { connected: action !== 'connect' }, vertex: { connected: action === 'vertex-remove' } };
 const f = mount('/app/admin/product-ai?project=web', async r => {
  if (r.path === '/v1/app/me') return { status: 200, body: identity };
  if (r.path.includes('product-ai')) {
   if (r.method !== 'GET') saved = true;
   return { status: 200, body: { ...initial, revision: saved ? 4 : 3, ...(saved ? { key: { connected: action !== 'remove' }, vertex: { connected: action === 'vertex-connect' }, evalBudget: { calls: 12, costMicros: 2000000 } } : {}), secret: marker } };
  }
  return reply(r);
 });
 let button: HTMLElement;
 if (action === 'connect' || action === 'replace') {
  fireEvent.change(await screen.findByLabelText(action === 'connect' ? 'Paste the AI Studio key' : 'Replace the key'), { target: { value: marker } });
  button = screen.getByRole('button', { name: action === 'connect' ? 'Connect key' : 'Replace key' });
 } // LAYOUT-COUPLED: Remove / Remove Vertex AI are on the project's row (the same send as before), not in the editor.
 else if (action === 'remove') button = await screen.findByRole('button', { name: 'Remove key from web' });
 else if (action === 'budget') {
  fireEvent.change(await screen.findByLabelText('Calls per stage'), { target: { value: '12' } });
  fireEvent.change(screen.getByLabelText('Spend per stage (USD)'), { target: { value: '2' } }); button = screen.getByRole('button', { name: 'Save eval budget' });
 } else {
  if (action === 'vertex-remove') button = await screen.findByRole('button', { name: 'Remove Vertex AI from web' });
  else {
   fireEvent.change(await screen.findByLabelText('AI provider'), { target: { value: 'vertex' } });
   fireEvent.change(screen.getByLabelText('Google Cloud project ID'), { target: { value: 'acme-evals' } });
   fireEvent.change(screen.getByLabelText('Workload identity provider'), { target: { value: '//iam.googleapis.com/projects/123456789/locations/global/workloadIdentityPools/rovara-pool/providers/rovara-aws' } });
   button = screen.getByRole('button', { name: 'Test and save' });
  }
 }
 fireEvent.click(button); fireEvent.click(button);
 await waitFor(() => expect(writes(f.requests)).toHaveLength(1));
 const sent = writes(f.requests)[0]!;
 expect(sent.path).toBe(`/v1/app/projects/web/product-ai/${action.startsWith('vertex') ? 'vertex' : action === 'budget' ? 'eval-budget' : 'key'}`);
 expect(sent.method).toBe(action === 'remove' || action === 'vertex-remove' ? 'DELETE' : 'PUT');
 const { requestId, ...body } = sent.body as Record<string, unknown>;
 expect(requestId).toMatch(/^[a-f0-9-]{36}$/u);
 expect(body).toEqual({ expectedRevision: 3, ...(action === 'connect' || action === 'replace' ? { key: marker } : action === 'budget' ? { calls: 12, costMicros: 2000000 } : action === 'vertex-connect' ? { projectId: 'acme-evals', location: 'us-central1', audience: '//iam.googleapis.com/projects/123456789/locations/global/workloadIdentityPools/rovara-pool/providers/rovara-aws', serviceAccount: null } : {}) });
 await waitFor(() => expect(document.body.innerHTML).not.toContain(marker));
 if (action === 'connect') await screen.findByText('Key connected', { exact: true });
 if (action === 'remove') await screen.findByText('No key', { exact: true });
 expect(JSON.stringify(localStorage)).not.toContain(marker);
 expect(JSON.stringify(f.client.getQueryCache().getAll().map(q => q.state.data))).not.toContain(marker);
});
it.each(['company', 'learning', 'step'] as const)('%s model uses the live save once', async action => {
 let saved = false;
 const model = () => ({ model: saved ? 'other-model' : 'fixture-model', source: 'company', canChange: true, offered: ['fixture-model', 'other-model'], preselect: 'fixture-model' });
 const f = mount('/app/admin/ai-spending', async r => {
  if (r.path === '/v1/app/me') return { status: 200, body: identity };
  if (r.method !== 'GET') { saved = true; return { status: 200, body: action === 'step' ? { ok: true, revision: 4 } : model() }; }
  if (r.path.endsWith('/engine-model') || r.path.endsWith('/learning-model')) return { status: 200, body: model() };
  if (r.path.endsWith('/agent-models')) { const answer = reply(r); return { ...answer, body: { ...answer.body as object, offered: ['fixture-model', 'other-model'] } }; }
  return reply(r);
 });
 // LAYOUT-COUPLED: the model choices are in the "Change a model" dialog opened from the section header; the company Save is labelled "Save company model".
 fireEvent.click(await screen.findByRole('button', { name: 'Change a model' }));
 await screen.findByLabelText('Company model');
 fireEvent.change(await screen.findByLabelText(action === 'company' ? 'Company model' : action === 'learning' ? 'Learning model' : 'Coding'), { target: { value: 'other-model' } });
 if (action !== 'step') { const button = screen.getByRole('button', { name: action === 'company' ? 'Save company model' : 'Save learning model' }); fireEvent.click(button); fireEvent.click(button); }
 await waitFor(() => expect(writes(f.requests)).toHaveLength(1));
 expect(writes(f.requests)[0]).toMatchObject({ method: action === 'step' ? 'POST' : 'PUT', path: `/v1/app/org/${action === 'step' ? 'agent-models' : action === 'company' ? 'engine-model' : 'learning-model'}`, body: action === 'step' ? { action: 'set', stage: 'build', model: 'other-model', expectedRevision: 3 } : { model: 'other-model' } });
});
