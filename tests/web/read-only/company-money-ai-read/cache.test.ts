// @vitest-environment jsdom
import { it, expect } from 'vitest';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { mount } from './harness.js';
import { report, denied, failed, reply } from './fixtures.js';
it('keeps repeated failed refreshes, replaces on success, then wipes on refusal and remount', async () => {
 let response: 'good' | 'failed' | 'replaced' | 'denied' = 'good';
 const replacement = { ...report, byFeature: report.byFeature.map(row => ({ ...row, name: 'Updated refunds' })) };
 const f = mount('/app/admin/money/report?range=all', async r => response === 'denied' ? denied : response === 'failed' ? failed : response === 'replaced' && !r.path.includes('/features/') ? { status: 200, body: replacement } : reply(r));
 await screen.findByRole('link', { name: 'Refunds' });
 const query = f.client.getQueryCache().getAll().find(q => q.queryKey[4] === 'report');
 const updatedAt = query?.state.dataUpdatedAt;
 response = 'failed';
 for (let attempt = 0; attempt < 2; attempt++) {
  await act(async () => { await f.client.refetchQueries(); });
  await waitFor(() => expect(screen.getAllByText(/Reconnecting/u)).toHaveLength(1));
  expect(query?.state.data).toEqual(report);
  expect(screen.getByText(/Reconnecting/u).textContent).toMatch(/^Updated [0-2]\d:[0-5]\d · Reconnecting$/u);
  expect(query?.state.dataUpdatedAt).toBe(updatedAt);
 }
 response = 'replaced';
 await act(async () => { await f.client.refetchQueries(); });
 await screen.findByRole('link', { name: 'Updated refunds' });
 expect(query?.state.data).toEqual(replacement);
 expect(screen.queryByText(/Reconnecting/u)).toBeNull();
 response = 'failed';
 await act(async () => { await f.client.refetchQueries(); });
 await screen.findByText(/Reconnecting/u);
 response = 'denied';
 await act(async () => { await f.client.refetchQueries(); });
 await screen.findByRole('alert');
 expect(f.client.getQueriesData({ queryKey: ['company-money-ai-read'] }).every(([, data]) => data === undefined)).toBe(true);
 await act(async () => { await f.router.navigate('/app/admin/ai-spending/order'); await f.router.navigate('/app/admin/money/report?range=all'); });
 await screen.findByRole('alert');
 expect(screen.queryByRole('link', { name: 'Updated refunds' })).toBeNull();
 expect(f.client.getQueriesData({ queryKey: ['company-money-ai-read'] }).every(([, data]) => data === undefined)).toBe(true);
});
it.each(['model-sources', 'agent-models'])('purges both AI projections when only %s returns an access signal', async path => {
 let bad = false;
 const f = mount('/app/admin/ai-spending', async r => bad && r.path.includes(path) ? { status: 200, body: { error: { code: 'SESSION_EXPIRED' } } } : reply(r));
 await screen.findAllByText('fixture-model'); bad = true;
 await act(async () => { await f.client.refetchQueries(); });
 await screen.findByRole('alert');
 await waitFor(() => expect(f.client.getQueriesData({ queryKey: ['company-money-ai-read'] }).map(([, data]) => data)).toEqual([undefined, undefined]));
 expect(screen.queryByText('fixture-model')).toBeNull();
 expect(screen.queryByText('Your Anthropic key')).toBeNull();
 // A later successful sibling recheck cannot repopulate the refused composition.
 await act(async () => { await f.client.refetchQueries({ predicate: query => !String(query.queryKey[5]).includes(path) }); });
 await waitFor(() => expect(f.client.getQueriesData({ queryKey: ['company-money-ai-read'] }).map(([, data]) => data)).toEqual([undefined, undefined]));
});
it.each(['model-sources', 'agent-models'])('Load again restores both purged AI projections after %s refuses', async path => {
 let bad = false;
 const f = mount('/app/admin/ai-spending', async r => bad && r.path.includes(path) ? denied : reply(r));
 await screen.findAllByText('fixture-model');
 await screen.findAllByText('Your Anthropic key');
 bad = true;
 await act(async () => { await f.client.refetchQueries(); });
 await screen.findByRole('alert');
 await waitFor(() => expect(f.client.getQueriesData({ queryKey: ['company-money-ai-read'] }).map(([, data]) => data)).toEqual([undefined, undefined]));
 bad = false;
 const before = f.requests.length;
 fireEvent.click(screen.getByRole('button', { name: 'Load again' }));
 await screen.findAllByText('Your Anthropic key');
 await screen.findAllByText('fixture-model');
 expect(screen.queryByText(/^Reading /u)).toBeNull();
 expect(document.querySelector('.rv-outcome')).toBeNull();
 expect(f.requests.slice(before).filter(request => request.path === '/v1/app/org/agent-models' || request.path === '/v1/app/org/model-sources').map(request => request.path)).toEqual(expect.arrayContaining(['/v1/app/org/agent-models', '/v1/app/org/model-sources']));
 expect(f.requests.every(request => request.method === 'GET')).toBe(true);
});
