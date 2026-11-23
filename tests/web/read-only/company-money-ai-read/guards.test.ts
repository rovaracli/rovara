// @vitest-environment jsdom
import { expect, it } from 'vitest';
import { act, screen } from '@testing-library/react';
import { mount } from './harness.js';
import { reply, product, sources, scope, report } from './fixtures.js';
it('never accepts a 202 body as a confirmed read, even if it parses', async () => {
 mount('/app/admin/money/report?range=all', async () => ({ status: 202, body: report }));
 expect(await screen.findByText(/last read did not answer/u)).toBeTruthy();
 expect(screen.queryByRole('link', { name: 'Refunds' })).toBeNull();
});
it('does not turn an absent key status into not connected', async () => {
 mount('/app/admin/product-ai', async r => r.path.includes('product-ai') ? { status: 200, body: { ...product, key: {}, vertex: {} } } : reply(r));
 await screen.findByText('web');
 expect(screen.queryByText('No key')).toBeNull(); expect(screen.queryByText('Key connected')).toBeNull();
 expect(await screen.findByRole('img', { name: 'Unknown' })).toBeTruthy();
});
it('rejects company and person mismatches in source reads', async () => {
 mount('/app/admin/ai-spending', async r => r.path.includes('model-sources') ? { status: 200, body: { ...sources, orgId: scope.orgId, developerId: 'someone-else' } } : reply(r));
 expect(await screen.findByText(/last read did not answer/u)).toBeTruthy();
 expect(screen.queryByRole('heading', { name: 'AI source order' })).toBeNull();
});
it('does not fabricate an order when the server sends none', async () => {
 mount('/app/admin/ai-spending', async r => r.path.includes('model-sources') ? { status: 200, body: { ...sources, order: [] } } : reply(r));
 expect(await screen.findByText('No source order was served.')).toBeTruthy();
 expect(document.querySelector('#ai-connections ol')).toBeNull();
});
it('shows the 4e block and wipes a refused product row while retaining the authorized project list', async () => {
 let bad = false;
 const f = mount('/app/admin/product-ai', async r => bad && r.path.includes('/product-ai') ? { status: 403, body: { error: { code: 'FORBIDDEN', message: 'Fixture refusal' } } } : reply(r));
 await screen.findByText('Key connected'); bad = true;
 await act(async () => { await f.client.refetchQueries(); });
 await screen.findByRole('alert');
 expect(screen.queryByText('Key connected')).toBeNull();
 expect(screen.queryByText(/AI Studio key connected/u)).toBeNull();
 expect(screen.getByText(/You no longer have access/u)).toBeTruthy();
 expect(f.client.getQueriesData({ predicate: query => query.queryKey[4] === 'product' }).map(([, data]) => data)).toEqual([undefined]);
});
