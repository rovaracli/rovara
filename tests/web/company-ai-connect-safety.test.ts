// @vitest-environment jsdom
// Both production entry points must bind credentials to the identity that opened them and hold unknown writes.
import { createElement as h } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, renderHook, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, Outlet, RouterProvider } from 'react-router';
import { QueryClientProvider } from '@tanstack/react-query';
import { createQueryClient } from '../../packages/ui/src/api/query.js';
import { AppHostProvider, type ApiRequest, type ApiResponse } from '../../packages/ui/src/host.js';
import { ProjectScopeContext } from '../../packages/ui/src/screens/admin/admin-context.js';
import { AiSpendStep } from '../../packages/ui/src/screens/setup/AiSpendStep.js';
import { companyMoneyAiReadRoutes } from '../../packages/ui/src/routes/company-money-ai-read-routes.js';
import { ApiError } from '../../packages/ui/src/api/errors.js';
import { ThemeProvider } from '../../packages/ui/src/theme.js';
import { renderUi } from './support/render.js';
import { fixtureHost, reply, scope } from './read-only/company-money-ai-read/fixtures.js';
import { connectionHoldAt, observeConnectionHold, persistConnectionHold, isConnectionRefusal, useConnectionChange } from '../../packages/ui/src/screens/admin/ai-spending/connection-change.js';

const original = { developer: { id: scope.developerId, name: 'Priya', orgRole: 'admin' }, org: { orgId: scope.orgId, name: 'Acme', plan: 'team' }, identities: [] };
const marker = 'fixture-private-marker';
type Form = 'key' | 'endpoint';
type Entry = 'setup' | 'admin';
const PATHS = { key: '/v1/app/org/learning-ai/key', endpoint: '/v1/app/org/agent-ai/endpoint' };
beforeEach(() => localStorage.clear());
const learning = (revision: number) => ({ revision, accounts: { anthropic: { connected: false }, openai: { connected: false }, gemini: { connected: false } }, removed: [], pausedNow: [], pauseReasons: [] });
const agent = (revision: number) => ({ version: 1, source: 'anthropic_key', choices: [{ source: 'anthropic_key', available: true }, { source: 'custom_endpoint', available: true }], endpointConnected: false, keysRevision: revision });
function mount(entry: Entry, outcome?: () => Promise<ApiResponse>) {
 let me: unknown = original, revision = 1, identityStatus = 200;
 const requests: ApiRequest[] = [], client = createQueryClient();
 const host = fixtureHost(async r => {
  requests.push(r);
  if (r.path === '/v1/app/me') return { status: identityStatus, body: me };
  if (Object.values(PATHS).includes(r.path) && r.method !== 'GET') { if (outcome) return outcome(); revision += 1; return { status: 200, body: r.path === PATHS.key ? learning(revision) : agent(revision) }; }
  if (r.path === '/v1/app/org/learning-ai') return { status: 200, body: learning(revision) };
  if (r.path === '/v1/app/org/agent-ai') return { status: 200, body: agent(revision) };
  if (r.path === '/v1/app/org/bedrock') return { status: 503, body: {} };
  return reply(r);
 });
 host.storage = { get: key => localStorage.getItem(key) ?? undefined, set: (key, value) => localStorage.setItem(key, value) };
 const path = entry === 'setup' ? '/app/onboard' : '/app/admin/ai-spending';
 const router = createMemoryRouter(entry === 'setup' ? [{ path, element: h(AiSpendStep, scope) }] : [{ path: '/app/admin', element: h(Outlet), children: companyMoneyAiReadRoutes() }], { initialEntries: [path] });
 const view = renderUi(h(AppHostProvider, { host, children: h(QueryClientProvider, { client }, h(ThemeProvider, { host, children: h(ProjectScopeContext.Provider, { value: scope }, h(RouterProvider, { router })) })) }));
 return { host, requests, view, switchTo: (next: unknown) => { me = next; }, identityStatus: (value: number) => { identityStatus = value; }, revision: (value: number) => { revision = value; }, close: () => { view.unmount(); router.dispose(); client.clear(); } };
}
async function open(entry: Entry, form: Form) {
 if (entry === 'setup') { await screen.findByLabelText(/Company monthly limit/u); fireEvent.click(await screen.findByText('Connect company AI', { selector: 'summary' })); }
 else fireEvent.click(await screen.findByRole('button', { name: 'Connect company AI' }));
 const field = await screen.findByLabelText<HTMLInputElement>(form === 'key' ? 'Paste the Anthropic key' : 'Key');
 if (form === 'endpoint') {
  fireEvent.change(screen.getByLabelText('Address (https, port 443)'), { target: { value: 'https://llm.example.com/v1' } });
  fireEvent.change(screen.getByLabelText('Models, one per line: name=provider/model'), { target: { value: 'coder=openai/gpt-5-mini' } });
 }
 fireEvent.change(field, { target: { value: marker } });
 const element = field.closest('form')!;
 return { element, field, submit: () => fireEvent.submit(element) };
}
const writes = (f: ReturnType<typeof mount>) => f.requests.filter(r => r.method !== 'GET');
describe.each(['setup', 'admin'] as const)('%s company AI', entry => {
 describe.each(['key', 'endpoint'] as const)('%s form', form => {
  it.each([202, 503])('an unconfirmed identity HTTP %s with a readable body still sends nothing', async status => {
   const f = mount(entry);
   try {
    const fields = await open(entry, form); f.identityStatus(status); fields.submit();
    await screen.findByText('Company access changed. Reload to check access.'); expect(writes(f)).toHaveLength(0);
   } finally { f.close(); }
  });
  it.each(['company', 'person', 'role', 'unreadable'] as const)('a %s change before Save sends zero credentials', async change => {
   const f = mount(entry);
   try {
    const fields = await open(entry, form);
    f.switchTo(change === 'company' ? { ...original, org: { ...original.org, orgId: 'org_bbbbbbbbbbbbbbbbbbbb' } } : change === 'person' ? { ...original, developer: { ...original.developer, id: 'b'.repeat(64) } } : change === 'role' ? { ...original, developer: { ...original.developer, orgRole: 'member' } } : {});
    fields.submit();
    await screen.findByText('Company access changed. Reload to check access.');
    expect(writes(f)).toHaveLength(0);
   } finally { f.close(); }
  });
  it('the documented inputs still send once, following a fresh identity read, without storing the key', async () => {
   const f = mount(entry);
   try {
    const fields = await open(entry, form), before = f.requests.length;
    fields.submit(); fields.submit();
    await waitFor(() => expect(writes(f)).toHaveLength(1));
    expect(f.requests.slice(before, before + 2).map(r => r.path)).toEqual(['/v1/app/me', PATHS[form]]);
    expect(writes(f)[0]).toMatchObject({ method: 'PUT', path: PATHS[form], retry: 'never', body: { expectedRevision: 1, key: marker, ...(form === 'key' ? { provider: 'anthropic' } : { baseUrl: 'https://llm.example.com/v1', models: [{ name: 'coder', catalog: { provider: 'openai', modelId: 'gpt-5-mini' } }] }) } });
    await waitFor(() => expect(fields.field.value).toBe(''));
    await waitFor(() => expect(screen.queryAllByTestId('held-connection')).toHaveLength(0));
    expect(JSON.stringify(localStorage)).not.toContain(marker);
   } finally { f.close(); }
  });
  it.each([
   [400, 'CONFIG_INVALID', 'This learning AI key is not valid.', "This endpoint can't be used: it needs an https address on port 443 of a public host, a key, and 1 to 20 models."],
   [403, 'FORBIDDEN', "Only a company admin can see or change the company's learning AI key.", "Only a company admin can see or change the AI the company's agents use."],
   [404, 'NOT_FOUND', 'No learning AI key is connected for that provider.', 'No endpoint is connected.'],
   [409, 'CONFLICT', 'The learning AI key changed. Refresh and try again.', "The company's AI keys changed. Refresh and try again."],
   [413, 'CONFIG_INVALID', 'The request is too large.', 'The request is too large.'],
  ] as const)('a clean %s %s refusal releases the hold and a corrected resubmit sends exactly once', async (status, code, keyWords, endpointWords) => {
   const words = form === 'key' ? keyWords : endpointWords;
   let attempts = 0;
   const f = mount(entry, async () => ++attempts === 1 ? { status, body: { error: { code, message: words } } } : { status: 200, body: form === 'key' ? learning(2) : agent(2) });
   try {
    const fields = await open(entry, form); fields.submit();
    await screen.findByText(words);
    expect(screen.queryAllByTestId('held-connection')).toHaveLength(0);
    expect(connectionHoldAt(f.host.storage, `connection:${scope.orgId}:${scope.developerId}:${PATHS[form]}`)).toBeUndefined();
    expect(writes(f)).toHaveLength(1);
    fireEvent.change(fields.field, { target: { value: 'corrected-fixture-key' } }); fields.submit(); fields.submit();
    await waitFor(() => expect(fields.field.value).toBe(''));
    expect(writes(f)).toHaveLength(2);
    expect(writes(f)[1]?.body).toMatchObject({ key: 'corrected-fixture-key', expectedRevision: 1 });
   } finally { f.close(); }
  });
  it.each([
   [400, 'FORBIDDEN'], [403, 'CONFIG_INVALID'], [404, 'CONFIG_INVALID'], [409, 'NOT_FOUND'], [413, 'FORBIDDEN'],
   [408, 'CONFIG_INVALID'], [429, 'CONFIG_INVALID'], [500, 'CONFIG_INVALID'], [503, 'FORBIDDEN'],
   [400, undefined], [403, undefined], [404, undefined], [409, undefined], [413, undefined],
  ] as const)('an unproven %s %s refusal stays held with no resend', async (status, code) => {
   const f = mount(entry, async () => ({ status, body: code === undefined ? {} : { error: { code, message: 'Unproven refusal.' } } }));
   try {
    const fields = await open(entry, form); fields.submit(); await screen.findAllByTestId('held-connection');
    fireEvent.change(fields.field, { target: { value: 'corrected-fixture-key' } }); fields.submit();
    await act(async () => { await Promise.resolve(); }); expect(writes(f)).toHaveLength(1);
   } finally { f.close(); }
  });
  it.each(['network', 'timeout', '500', '503', '202', '503-with-body', '202-with-body', 'unreadable', 'unchanged'] as const)('an unknown %s outcome holds every resend until Check observes a newer revision', async kind => {
   const f = mount(entry, async () => { if (kind === 'network' || kind === 'timeout') throw new Error(kind); return { status: kind === 'unreadable' || kind === 'unchanged' ? 200 : Number(kind.split('-')[0]), body: kind === 'unchanged' ? (form === 'key' ? learning(1) : agent(1)) : kind.endsWith('-with-body') ? (form === 'key' ? learning(2) : agent(2)) : {} }; });
   try {
    const fields = await open(entry, form);
    fields.submit();
    await screen.findAllByTestId('held-connection');
    const beforeResend = f.requests.length;
    fireEvent.change(fields.field, { target: { value: marker } }); fields.submit();
    await act(async () => { await Promise.resolve(); });
    expect(f.requests).toHaveLength(beforeResend);
    expect(writes(f)).toHaveLength(1);
    expect(JSON.stringify(localStorage)).not.toContain(marker);
    const check = screen.getByRole('button', { name: form === 'key' ? 'Check Anthropic key' : 'Check own endpoint' });
    fireEvent.click(check);
    await waitFor(() => expect(check).toHaveProperty('disabled', false));
    expect(screen.getAllByTestId('held-connection').length).toBeGreaterThan(0);
    fields.submit(); await act(async () => { await Promise.resolve(); }); expect(writes(f)).toHaveLength(1);
    f.revision(2); fireEvent.click(check);
    await waitFor(() => expect(screen.queryAllByTestId('held-connection')).toHaveLength(0));
    expect(writes(f)).toHaveLength(1);
   } finally { f.close(); }
  });
  it('a hold survives closing and reopening the entry', async () => {
   const f = mount(entry, async () => ({ status: 503, body: {} }));
   const fields = await open(entry, form); fields.submit(); await screen.findAllByTestId('held-connection'); f.close();
   const g = mount(entry);
   try { const reopened = await open(entry, form); await screen.findAllByTestId('held-connection'); reopened.submit(); await act(async () => { await Promise.resolve(); }); expect(writes(g)).toHaveLength(0); }
   finally { g.close(); }
  });
  it('a failed persistence verification sends nothing', async () => {
   const f = mount(entry);
   try {
    const fields = await open(entry, form); f.host.storage.set = () => undefined;
    fields.submit(); await screen.findByText("This change can't be made safely in this browser.");
    expect(writes(f)).toHaveLength(0);
   } finally { f.close(); }
  });
  it('a pending write discovered at send time blocks the send', async () => {
   const f = mount(entry);
   try {
    const fields = await open(entry, form);
    persistConnectionHold(f.host.storage, `connection:${scope.orgId}:${scope.developerId}:${PATHS[form]}`, { requestId: 'other-tab', expectedRevision: 1, startedAt: Date.now() });
    fields.submit(); await screen.findAllByTestId('held-connection'); expect(writes(f)).toHaveLength(0);
   } finally { f.close(); }
  });
  it.each(['CSRF_INVALID', 'CSRF_STALE'])('the documented pre-send %s refusal allows a new deliberate press', async code => {
   let refused = false;
   const f = mount(entry, async () => { if (!refused) { refused = true; return { status: 403, body: { error: { code, message: 'Check your sign-in and try again.' } } }; } return { status: 200, body: form === 'key' ? learning(2) : agent(2) }; });
   try {
    const fields = await open(entry, form); fields.submit();
    await screen.findByText('Check your sign-in and try again.');
    expect(screen.queryAllByTestId('held-connection')).toHaveLength(0);
    fireEvent.change(fields.field, { target: { value: marker } }); fields.submit();
    await waitFor(() => expect(writes(f)).toHaveLength(2));
   } finally { f.close(); }
  });
  it('a company switch during Check cannot clear the hold', async () => {
   const f = mount(entry, async () => ({ status: 503, body: {} }));
   try {
    const fields = await open(entry, form); fields.submit(); await screen.findAllByTestId('held-connection'); f.revision(2);
    const request = f.host.transport.request.bind(f.host.transport);
    f.host.transport.request = async r => { const answer = await request(r); if (r.path === (form === 'key' ? '/v1/app/org/learning-ai' : '/v1/app/org/agent-ai')) f.switchTo({ ...original, org: { ...original.org, orgId: 'org_bbbbbbbbbbbbbbbbbbbb' } }); return answer; };
    fireEvent.click(screen.getByRole('button', { name: form === 'key' ? 'Check Anthropic key' : 'Check own endpoint' }));
    await screen.findByText('Company access changed. Reload to check access.');
    expect(screen.getAllByTestId('held-connection').length).toBeGreaterThan(0); expect(writes(f)).toHaveLength(1);
   } finally { f.close(); }
  });
  it('a changed identity refuses Check before reading another company', async () => {
   const f = mount(entry, async () => ({ status: 503, body: {} }));
   try {
    const fields = await open(entry, form); fields.submit(); await screen.findAllByTestId('held-connection');
    f.switchTo({ ...original, org: { ...original.org, orgId: 'org_bbbbbbbbbbbbbbbbbbbb' } });
    const before = f.requests.length;
    fireEvent.click(screen.getByRole('button', { name: form === 'key' ? 'Check Anthropic key' : 'Check own endpoint' }));
    await screen.findByText('Company access changed. Reload to check access.');
    expect(f.requests.slice(before).map(r => r.path)).toEqual(['/v1/app/me']);
    expect(screen.getAllByTestId('held-connection').length).toBeGreaterThan(0);
   } finally { f.close(); }
  });
  it('a real send timeout remains held when the transport never settles', async () => {
   const f = mount(entry, () => new Promise<ApiResponse>(() => undefined));
   try {
    const fields = await open(entry, form); vi.useFakeTimers();
    await act(async () => { fields.submit(); await Promise.resolve(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(30_001); });
    expect(screen.getAllByTestId('held-connection').length).toBeGreaterThan(0); expect(writes(f)).toHaveLength(1);
   } finally { vi.useRealTimers(); f.close(); }
  });
 });
});

describe('Bedrock pending metadata shared with company credentials', () => {
 const hold = { requestId: 'pending-fixture', expectedRevision: 3, startedAt: 123 };
 const storage = { get: (key: string) => localStorage.getItem(key) ?? undefined, set: (key: string, value: string) => localStorage.setItem(key, value) };
 it.each(['', undefined])('an absent marker (%s) is not a pending change', raw => {
  if (raw !== undefined) localStorage.setItem('connection', raw);
  expect(connectionHoldAt(storage, 'connection')).toBeUndefined();
 });
 it.each([{ ...hold, requestId: 1 }, { ...hold, expectedRevision: 1.5 }, { ...hold, startedAt: 'yesterday' }, null])('unreadable pending metadata refuses: %j', value => {
  localStorage.setItem('connection', JSON.stringify(value));
  expect(() => connectionHoldAt(storage, 'connection')).toThrow();
 });
 it.each([2, 3])('an observed revision of %s does not resolve revision 3', revision => {
  persistConnectionHold(storage, 'connection', hold);
  expect(observeConnectionHold(storage, 'connection', hold, revision)).toBe(false);
  expect(connectionHoldAt(storage, 'connection')).toEqual(hold);
 });
 it('a newer revision resolves the held observation', () => {
  persistConnectionHold(storage, 'connection', hold);
  expect(observeConnectionHold(storage, 'connection', hold, 4)).toBe(true);
  expect(connectionHoldAt(storage, 'connection')).toBeUndefined();
 });
});

describe('shared connection hook gates', () => {
 function hook(identity?: () => Promise<ApiResponse>) {
  const requests: ApiRequest[] = [];
  const host = fixtureHost(async r => { requests.push(r); return r.path === '/v1/app/me' ? identity ? identity() : { status: 200, body: original } : { status: 200, body: learning(2) }; });
  host.storage = { get: key => localStorage.getItem(key) ?? undefined, set: (key, value) => localStorage.setItem(key, value) };
  const result = renderHook(() => useConnectionChange({ path: PATHS.key, readPath: '/v1/app/org/learning-ai', reader: { parse: value => value as { revision: number } }, revision: 1, revisionOf: value => value.revision, reload: () => undefined }), { wrapper: ({ children }) => h(AppHostProvider, { host, children: h(ProjectScopeContext.Provider, { value: scope }, children) }) });
  return { ...result, requests };
 }
 it.each(['send', 'check'] as const)('blocks a concurrent %s before its identity read finishes', async operation => {
  let finish: ((value: ApiResponse) => void) | undefined;
  const pending = new Promise<ApiResponse>(resolve => { finish = resolve; }), f = hook(() => pending);
  let first: Promise<unknown> | undefined, second: Promise<unknown> | undefined;
  await act(async () => { first = operation === 'send' ? f.result.current.send('PUT', {}, 'Done') : f.result.current.check(); second = operation === 'send' ? f.result.current.send('PUT', {}, 'Done') : f.result.current.check(); await Promise.resolve(); });
  expect(f.requests.filter(r => r.path === '/v1/app/me')).toHaveLength(1);
  await act(async () => { finish?.({ status: 200, body: original }); await Promise.all([first, second]); });
  f.unmount();
 });
 it.each([`connection:${scope.orgId}:${scope.developerId}:${PATHS.key}`, null])('a matching storage event (%s) holds the form until Check', async key => {
  const f = hook();
  act(() => { fireEvent(window, new StorageEvent('storage', { key: 'unrelated' })); }); expect(f.result.current.held).toBe(false);
  act(() => { fireEvent(window, new StorageEvent('storage', { key })); }); expect(f.result.current.held).toBe(true);
  await act(async () => { await f.result.current.send('PUT', {}, 'Done'); }); expect(f.requests).toHaveLength(0); f.unmount();
 });
 it('an unreadable stored marker starts held; Check reads the current settings, never clears it by itself, and offers an explicit release', async () => {
  const markerKey = `connection:${scope.orgId}:${scope.developerId}:${PATHS.key}`;
  localStorage.setItem(markerKey, 'unreadable');
  const f = hook(); expect(f.result.current.held).toBe(true);
  // The once-per-load automatic Check covers an unreadable marker too.
  await waitFor(() => expect(f.result.current.unconfirmed).toBe(true));
  expect(f.result.current.held).toBe(true);
  expect(f.requests.map(r => r.path)).toEqual(['/v1/app/me', '/v1/app/org/learning-ai', '/v1/app/me']);
  expect(localStorage.getItem(markerKey)).toBe('unreadable');
  act(() => { f.result.current.release(); });
  expect(f.result.current.held).toBe(false); expect(localStorage.getItem(markerKey)).toBe(''); f.unmount();
 });
});

describe('connection refusal boundaries', () => {
 it.each(['/v1/app/org/settings', '/v1/app/org/bedrock/setup', '/v1/app/org/learning-ai', '/v1/app/org/agent-ai/endpoint/other'])('never releases a different route: %s', path => {
  expect(isConnectionRefusal(new ApiError(400, 'CONFIG_INVALID', 'Refused.'), path)).toBe(false);
 });
 it.each([new Error('Network error'), { status: 400, code: 'CONFIG_INVALID', message: 'Unparsed transport failure' }, undefined])('requires a parsed API refusal: %j', error => {
  expect(isConnectionRefusal(error, PATHS.key)).toBe(false);
 });
});
