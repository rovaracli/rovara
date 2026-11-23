// @vitest-environment jsdom
import { expect, it } from 'vitest';
import { act, screen, within } from '@testing-library/react';
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
it('does not fabricate an order when the server sends none: an empty order with Rovara listed is the served default, never Unknown', async () => {
 mount('/app/admin/ai-spending', async r => r.path.includes('model-sources') ? { status: 200, body: { ...sources, order: [], sources: [{ source: 'rovara', available: true, connected: true, inOrder: false }] } } : reply(r));
 expect(await screen.findByText("Rovara's AI (the default). No company sources connected.")).toBeTruthy();
 expect(document.querySelector('#ai-connections ol')).toBeNull();
 expect(within(document.querySelector('#ai-connections') as HTMLElement).queryByRole('img', { name: 'Unknown' })).toBeNull();
 expect(screen.queryByText('No source order was served.')).toBeNull();
});
it('a failed or empty model-sources read still shows the shared Unknown, never the served default', async () => {
 // A read that lists nothing to say the default from (no Rovara row, no company source): the missing fact stays Unknown.
 mount('/app/admin/ai-spending', async r => r.path.includes('model-sources') ? { status: 200, body: { ...sources, order: [], sources: [] } } : reply(r));
 expect(await screen.findByText('No source order was served.')).toBeTruthy();
 expect(within(document.querySelector('#ai-connections') as HTMLElement).getByRole('img', { name: 'Unknown' })).toBeTruthy();
 expect(screen.queryByText(/the default/u)).toBeNull(); expect(screen.queryByText("Using Rovara's AI")).toBeNull();
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
