// @vitest-environment jsdom
// Reviewer-added checks for b454e8178 (uncommitted): key-shape matrix for valid keys of each slot, and the corrupt-marker dead end.
import { createElement as h } from 'react';
import { beforeEach, describe, expect, it } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { AppHostProvider } from '../../packages/ui/src/host.js';
import { ProjectScopeContext } from '../../packages/ui/src/screens/admin/admin-context.js';
import { useConnectionChange } from '../../packages/ui/src/screens/admin/ai-spending/connection-change.js';
import { wrongProviderKeyHint } from '../../packages/ui/src/api/admin-learning-ai.js';
import { wrongProviderKey } from '../../packages/cloud-server/src/learning-ai-routes.js';
import { fixtureHost, scope } from './read-only/company-money-ai-read/fixtures.js';

const pad = (n: number) => 'a1B2_-'.repeat(20).slice(0, n);
const valid: Array<[ 'anthropic' | 'openai' | 'gemini' | 'openrouter', string ]> = [
 ['openai', 'sk-' + pad(48)], ['openai', 'sk-proj-' + pad(120)], ['openai', 'sk-svcacct-' + pad(100)], ['openai', 'sk-admin-' + pad(60)],
 ['anthropic', 'sk-ant-api03-' + pad(90)], ['anthropic', 'sk-ant-admin01-' + pad(90)], ['anthropic', 'sk-ant-oat01-' + pad(60)],
 ['openrouter', 'sk-or-v1-' + pad(60)],
 ['gemini', 'AIza' + pad(35)], ['gemini', 'AQ.' + pad(50)],
];
describe('valid keys of every slot are never refused by the shape check', () => {
 for (const [provider, key] of valid) it(`${provider} ${key.slice(0, 10)}`, () => {
  expect(wrongProviderKeyHint(provider, key)).toBeUndefined();
  expect(wrongProviderKey(provider, key)).toBeUndefined();
 });
 it('server and client agree for every slot x every sample', () => {
  for (const [, key] of valid) for (const slot of ['anthropic', 'openai', 'gemini', 'openrouter'] as const) {
   const client = wrongProviderKeyHint(slot, key), server = wrongProviderKey(slot, key);
   expect(server === undefined).toBe(client === undefined);
   if (server !== undefined) expect(JSON.stringify(server)).toContain(client!);
  }
 });
});
describe('corrupt marker', () => {
 beforeEach(() => localStorage.clear());
 const mountHook = (status = 200) => {
  const requests: string[] = [];
  const host = fixtureHost(async r => { requests.push(r.path); return { status: 200, body: r.path === '/v1/app/me' ? { developer: { id: scope.developerId, name: 'P', orgRole: 'admin' }, org: { orgId: scope.orgId, name: 'A', plan: 'team' }, identities: [] } : { revision: status } }; });
  host.storage = { get: key => localStorage.getItem(key) ?? undefined, set: (key, value) => localStorage.setItem(key, value) };
  localStorage.setItem(`connection:${scope.orgId}:${scope.developerId}:/k`, 'not json');
  const hook = renderHook(() => useConnectionChange({ path: '/k', readPath: '/r', reader: { parse: v => v as { revision: number } }, revision: 1, revisionOf: v => v.revision, reload: () => undefined }), { wrapper: ({ children }) => h(AppHostProvider, { host, children: h(ProjectScopeContext.Provider, { value: scope }, children) }) });
  return { hook, host, requests };
 };
 it('an unreadable marker recovers: Check reads the settings, says not confirmed, offers continue, and release clears it', async () => {
  const { hook, requests } = mountHook();
  await waitFor(() => expect(hook.result.current.unconfirmed).toBe(true));
  expect(requests.filter(p => p === '/r')).toHaveLength(1);
  expect(hook.result.current.held).toBe(true);
  expect(hook.result.current.notice?.ok).toBe(false);
  act(() => { hook.result.current.release(); });
  expect(hook.result.current.held).toBe(false);
  expect(localStorage.getItem(`connection:${scope.orgId}:${scope.developerId}:/k`)).toBe('');
  hook.unmount();
 });
 it('release reports a storage failure instead of returning silently', async () => {
  const { hook, host } = mountHook();
  await waitFor(() => expect(hook.result.current.unconfirmed).toBe(true));
  host.storage.set = () => { throw new Error('quota'); };
  act(() => { hook.result.current.release(); });
  expect(hook.result.current.held).toBe(true);
  expect(hook.result.current.notice?.ok).toBe(false);
  expect(hook.result.current.notice?.text).toMatch(/Couldn't clear the pending change/u);
  hook.unmount();
 });
 it('release that does not take (storage ignores the write) is reported too', async () => {
  const { hook, host } = mountHook();
  await waitFor(() => expect(hook.result.current.unconfirmed).toBe(true));
  host.storage.set = () => undefined;
  act(() => { hook.result.current.release(); });
  expect(hook.result.current.held).toBe(true);
  expect(hook.result.current.notice?.text).toMatch(/Couldn't clear the pending change/u);
  hook.unmount();
 });
});
