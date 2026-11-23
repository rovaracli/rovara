// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { screen, act } from '@testing-library/react';
import { mount } from './harness.js';
import { FEATURE, reply, product } from './fixtures.js';
describe('G2 actions keep reads passive and secrets write-only', () => {
 it.each(['/app/admin/money/report?range=all', `/app/admin/money/report/features/${FEATURE}?range=all`, '/app/admin/ai-spending', '/app/admin/product-ai', '/app/admin/ai-spending/order'])('loading and refreshing %s never submits a change', async path => {
  const f = mount(path); await screen.findByRole('heading', { level: 1 });
  await act(async () => { await f.client.refetchQueries(); });
  expect(f.requests.length).toBeGreaterThan(0); expect(f.requests.every(r => r.method === 'GET')).toBe(true);
 });
 it('projects key data without rendering or caching extra secret fields', async () => {
  const f = mount('/app/admin/product-ai', async r => r.path.includes('product-ai') ? { status: 200, body: { ...product, secret: 'fixture-private-marker', key: { ...product.key, value: 'fixture-private-marker' } } } : reply(r));
  await screen.findByText('Key connected', { exact: true });
  expect(document.body.textContent).not.toContain('fixture-private-marker');
  expect(JSON.stringify(f.client.getQueryCache().getAll().map(q => q.state.data))).not.toContain('fixture-private-marker');
 });
});
