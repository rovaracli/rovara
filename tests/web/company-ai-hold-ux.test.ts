// @vitest-environment jsdom
// AI-CONNECTION-HOLD-UX: a held company AI change must explain itself inside each provider card, never look live while dead, never dead-end,
// check itself once on load, and refuse an obviously wrong-provider key before anything is sent.
import { readFileSync } from 'node:fs';
import { createElement as h } from 'react';
import { beforeEach, describe, expect, it } from 'vitest';
import { act, fireEvent, renderHook, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, Outlet, RouterProvider } from 'react-router';
import { QueryClientProvider } from '@tanstack/react-query';
import { createQueryClient } from '../../packages/ui/src/api/query.js';
import { AppHostProvider, type ApiRequest, type ApiResponse } from '../../packages/ui/src/host.js';
import { ProjectScopeContext } from '../../packages/ui/src/screens/admin/admin-context.js';
import { companyMoneyAiReadRoutes } from '../../packages/ui/src/routes/company-money-ai-read-routes.js';
import { ThemeProvider } from '../../packages/ui/src/theme.js';
import { Button } from '../../packages/ui/src/design/Button.js';
import { CONNECTION_HELD_SEND, CONNECTION_NOT_CONFIRMED, CONNECTION_NOT_CONFIRMED_SHORT, CONNECTION_NO_ANSWER, CONNECTION_PAUSED, persistConnectionHold, useConnectionChange } from '../../packages/ui/src/screens/admin/ai-spending/connection-change.js';
import { renderUi } from './support/render.js';
import { expectNoAxeViolations } from './support/axe.js';
import { fixtureHost, reply, scope } from './read-only/company-money-ai-read/fixtures.js';

const me = { developer: { id: scope.developerId, name: 'Priya', orgRole: 'admin' }, org: { orgId: scope.orgId, name: 'Acme', plan: 'team' }, identities: [] };
const KEY_PATH = '/v1/app/org/learning-ai/key', READ_PATH = '/v1/app/org/learning-ai';
const HOLD_KEY = `connection:${scope.orgId}:${scope.developerId}:${KEY_PATH}`;
const heldWords = /A key change on this page isn't confirmed yet/u;
const fake = (prefix: string) => prefix + 'x'.repeat(40);
beforeEach(() => localStorage.clear());
const learning = (revision: number, connected = ['anthropic']) => ({
 revision,
 accounts: { anthropic: { connected: connected.includes('anthropic'), updatedAt: 1_700_000_000_000 }, openai: { connected: connected.includes('openai') }, gemini: { connected: false }, openrouter: { connected: false } },
 removed: [], pausedNow: [], pauseReasons: [],
});

function mount(options: { putOutcome?: () => Promise<ApiResponse>; revision?: number; connected?: string[]; identityFails?: boolean; readBody?: unknown } = {}) {
 let revision = options.revision ?? 1;
 const identityStatus = 200;
 const requests: ApiRequest[] = [], client = createQueryClient();
 const host = fixtureHost(async r => {
  requests.push(r);
  if (r.path === '/v1/app/me') return { status: options.identityFails === true && identityStatus === 200 && requests.filter(x => x.path === '/v1/app/me').length > 1 ? 503 : identityStatus, body: me };
  if (r.path === KEY_PATH) { if (options.putOutcome) return options.putOutcome(); revision += 1; return { status: 200, body: learning(revision, options.connected) }; }
  if (r.path === READ_PATH) return { status: 200, body: options.readBody ?? learning(revision, options.connected) };
  if (r.path === '/v1/app/org/bedrock') return { status: 503, body: {} };
  return reply(r);
 });
 host.storage = { get: key => localStorage.getItem(key) ?? undefined, set: (key, value) => localStorage.setItem(key, value) };
 const router = createMemoryRouter([{ path: '/app/admin', element: h(Outlet), children: companyMoneyAiReadRoutes() }], { initialEntries: ['/app/admin/ai-spending'] });
 const view = renderUi(h(AppHostProvider, { host, children: h(QueryClientProvider, { client }, h(ThemeProvider, { host, children: h(ProjectScopeContext.Provider, { value: scope }, h(RouterProvider, { router })) })) }));
 return { host, requests, setRevision: (value: number) => { revision = value; }, close: () => { view.unmount(); router.dispose(); client.clear(); } };
}
const card = (name: string) => screen.findByRole('region', { name });
const writes = (f: ReturnType<typeof mount>) => f.requests.filter(r => r.method !== 'GET');
async function openPage() { fireEvent.click(await screen.findByRole('button', { name: 'Connect company AI' })); return card('Anthropic'); }
/** Press Connect key in a card until the (503) outcome puts the page on hold. */
async function holdVia(name: string, label: string) {
  const region = await card(name);
  fireEvent.change(within(region).getByLabelText(label), { target: { value: fake('sk-ant-') } });
  fireEvent.submit(within(region).getByLabelText(label).closest('form')!);
  await screen.findAllByText(heldWords);
}
const held503 = async (): Promise<ApiResponse> => ({ status: 503, body: {} });

describe('(a) the hold message and Check sit inside every provider card', () => {
 it('each of the three provider cards says why it is held and has its own Check button', async () => {
  const f = mount({ putOutcome: held503 });
  try {
   await openPage(); await holdVia('Anthropic', 'Replace the Anthropic key');
   for (const name of ['Anthropic', 'OpenAI', 'Google AI Studio (Gemini)']) {
    const region = await card(name);
    expect(within(region).getByText(heldWords)).toBeTruthy();
    expect(within(region).getByRole('button', { name: name.startsWith('Google') ? 'Check Gemini key' : `Check ${name} key` })).toHaveProperty('disabled', false);
   }
  } finally { f.close(); }
 });
 it('the Check button inside a card runs the check and the card passes axe, held and not confirmed', async () => {
  const f = mount({ putOutcome: held503 });
  try {
   await openPage(); await holdVia('Anthropic', 'Replace the Anthropic key');
   const region = await card('OpenAI');
   await expectNoAxeViolations(region);
   fireEvent.click(within(region).getByRole('button', { name: 'Check OpenAI key' }));
   await within(region).findByRole('button', { name: "Continue with these settings" });
   await expectNoAxeViolations(region);
   await expectNoAxeViolations(await card('Anthropic'));
  } finally { f.close(); }
 });
});

describe('(b) disabled buttons look disabled, every variant', () => {
 function withCss(run: () => void) {
  const style = document.createElement('style');
  const tokens: Record<string, string> = { '--rv-bg-raised': '#ffffff', '--rv-bg-sunken': '#eeeeee', '--rv-text-muted': '#666666', '--rv-text': '#111111', '--rv-border': '#cccccc', '--rv-border-strong': '#999999', '--rv-status-failed': '#ff0000', '--rv-danger': '#ff0001', '--rv-on-danger': '#fffffe', '--rv-accent': '#0000ff', '--rv-on-accent': '#fffffd' };
  style.textContent = (readFileSync('packages/ui/src/design/design.css', 'utf8') + readFileSync('packages/ui/src/design/parts/chips-buttons.css', 'utf8')).replace(/var\((--rv-[a-z-]+)\)/gu, (source, name: string) => tokens[name] ?? source);
  document.head.append(style);
  try { run(); } finally { style.remove(); }
 }
 it.each(['primary', 'secondary', 'quiet', 'danger'] as const)('a disabled %s button is muted, not live-coloured', variant => {
  withCss(() => {
   renderUi(h('div', null, h(Button, { variant }, 'Live'), h(Button, { variant, disabled: true }, 'Dead')));
   const live = getComputedStyle(screen.getByRole('button', { name: 'Live' })), dead = getComputedStyle(screen.getByRole('button', { name: 'Dead' }));
   expect(dead.color).toBe('rgb(102, 102, 102)');
   expect(dead.color).not.toBe(live.color === 'rgb(102, 102, 102)' ? '' : live.color);
   expect(dead.opacity).toBe('1');
   expect(dead.cursor).toBe('not-allowed');
   expect(dead.backgroundColor).toBe(variant === 'quiet' ? 'rgba(0, 0, 0, 0)' : 'rgb(238, 238, 238)');
  });
 });
 it('the Remove key button in a held card (inside a disabled fieldset) is natively disabled and muted', async () => {
  const f = mount({ putOutcome: held503 });
  try {
   await openPage(); await holdVia('Anthropic', 'Replace the Anthropic key');
   withCss(() => {
    const remove = screen.getByRole<HTMLButtonElement>('button', { name: 'Remove Anthropic key' });
    expect(remove.matches(':disabled')).toBe(true);
    expect(getComputedStyle(remove).color).toBe('rgb(102, 102, 102)');
    expect(getComputedStyle(remove).backgroundColor).toBe('rgb(238, 238, 238)');
   });
  } finally { f.close(); }
 });
});

describe('(c) a send while held says why, never silently', () => {
 it('the page: a resend while held shows the reason in the card and sends nothing', async () => {
  const f = mount({ putOutcome: held503 });
  try {
   await openPage(); await holdVia('Anthropic', 'Replace the Anthropic key');
   const before = f.requests.length;
   const region = await card('Anthropic');
   const field = within(region).getByLabelText('Replace the Anthropic key');
   fireEvent.change(field, { target: { value: fake('sk-ant-') } }); fireEvent.submit(field.closest('form')!);
   expect(await within(region).findByText(CONNECTION_HELD_SEND)).toBeTruthy();
   expect(f.requests).toHaveLength(before);
  } finally { f.close(); }
 });
 it('the hook: send returns false and sets the reason', async () => {
  const host = fixtureHost(async r => ({ status: 200, body: r.path === '/v1/app/me' ? me : learning(1) }));
  host.storage = { get: key => localStorage.getItem(key) ?? undefined, set: (key, value) => localStorage.setItem(key, value) };
  // An unreadable marker starts held and is never auto-checked, so only the send's own message is under test here.
  localStorage.setItem(HOLD_KEY, 'unreadable');
  const hook = renderHook(() => useConnectionChange({ path: KEY_PATH, readPath: READ_PATH, reader: { parse: v => v as { revision: number } }, revision: 1, revisionOf: v => v.revision, reload: () => undefined }), { wrapper: ({ children }) => h(AppHostProvider, { host, children: h(ProjectScopeContext.Provider, { value: scope }, children) }) });
  let sent: boolean | undefined;
  await act(async () => { sent = await hook.result.current.send('PUT', {}, 'Done'); });
  expect(sent).toBe(false);
  expect(hook.result.current.notice).toEqual({ ok: false, text: CONNECTION_HELD_SEND });
  hook.unmount();
 });
});

describe('(d) a hold found on load is checked once', () => {
 const storageHost = () => {
  const requests: ApiRequest[] = [];
  const host = fixtureHost(async r => { requests.push(r); return { status: 200, body: r.path === '/v1/app/me' ? me : learning(2) }; });
  host.storage = { get: key => localStorage.getItem(key) ?? undefined, set: (key, value) => localStorage.setItem(key, value) };
  return { host, requests };
 };
 const renderIt = (host: ReturnType<typeof storageHost>['host']) => renderHook(() => useConnectionChange({ path: KEY_PATH, readPath: READ_PATH, reader: { parse: v => v as { revision: number } }, revisionOf: v => v.revision, revision: 1, reload: () => undefined }), { wrapper: ({ children }) => h(AppHostProvider, { host, children: h(ProjectScopeContext.Provider, { value: scope }, children) }) });
 it('with a hold, one read happens by itself, clears a hold that landed, and never repeats', async () => {
  const { host, requests } = storageHost();
  persistConnectionHold(host.storage, HOLD_KEY, { requestId: 'earlier', expectedRevision: 1, startedAt: 1 });
  const hook = renderIt(host);
  await waitFor(() => expect(hook.result.current.held).toBe(false));
  const reads = () => requests.filter(r => r.path === READ_PATH).length;
  expect(reads()).toBe(1);
  hook.rerender(); await act(async () => { await Promise.resolve(); });
  expect(reads()).toBe(1);
  hook.unmount();
 });
 it('without a hold nothing is read', async () => {
  const { host, requests } = storageHost();
  const hook = renderIt(host);
  await act(async () => { await Promise.resolve(); });
  expect(requests).toHaveLength(0); expect(hook.result.current.held).toBe(false);
  hook.unmount();
 });
 it('a failing automatic check stays held with the reason shown, and does not loop', async () => {
  const requests: ApiRequest[] = [];
  const host = fixtureHost(async r => { requests.push(r); return r.path === '/v1/app/me' ? { status: 503, body: {} } : { status: 200, body: learning(2) }; });
  host.storage = { get: key => localStorage.getItem(key) ?? undefined, set: (key, value) => localStorage.setItem(key, value) };
  persistConnectionHold(host.storage, HOLD_KEY, { requestId: 'earlier', expectedRevision: 1, startedAt: 1 });
  const hook = renderIt(host);
  await waitFor(() => expect(hook.result.current.notice?.ok).toBe(false));
  const after = requests.length;
  hook.rerender(); await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
  expect(requests).toHaveLength(after); expect(hook.result.current.held).toBe(true);
  hook.unmount();
 });
 it('the page: a stored hold whose change landed clears by itself on load', async () => {
  persistConnectionHold({ get: key => localStorage.getItem(key) ?? undefined, set: (key, value) => localStorage.setItem(key, value) }, HOLD_KEY, { requestId: 'earlier', expectedRevision: 1, startedAt: 1 });
  const f = mount({ revision: 2 });
  try {
   await openPage();
   await waitFor(() => expect(screen.queryAllByText(heldWords)).toHaveLength(0));
   expect(within(await card('Anthropic')).getByLabelText('Replace the Anthropic key').closest('fieldset')).toHaveProperty('disabled', false);
  } finally { f.close(); }
 });
});

describe('the hold is never a dead end', () => {
 it('a PUT that is not observed: Check says so with the current state, and "I\'ve checked; continue" releases it', async () => {
  // The write answers 200 but the revision never rises (or the write never landed): Check can never see a newer revision.
  const f = mount({ putOutcome: async () => ({ status: 200, body: learning(1) }) });
  try {
   await openPage(); await holdVia('Anthropic', 'Replace the Anthropic key');
   const region = await card('Anthropic');
   const check = within(region).getByRole('button', { name: 'Check Anthropic key' });
   expect(within(region).queryByRole('button', { name: "Continue with these settings" })).toBeNull();
   fireEvent.click(check);
   expect(await within(region).findByText(CONNECTION_NOT_CONFIRMED)).toBeTruthy();
   // The current state is on the page (re-read), the buttons are still dead, and the way out is explicit.
   expect(within(region).getByText(/A key is connected/u)).toBeTruthy();
   expect(within(region).getByRole<HTMLButtonElement>('button', { name: 'Remove Anthropic key' }).matches(':disabled')).toBe(true);
   fireEvent.click(within(region).getByRole('button', { name: "Continue with these settings" }));
   await waitFor(() => expect(screen.queryAllByText(heldWords)).toHaveLength(0));
   expect(within(region).getByRole<HTMLButtonElement>('button', { name: 'Remove Anthropic key' }).matches(':disabled')).toBe(false);
   expect(localStorage.getItem(HOLD_KEY)).toBe('');
   // The buttons work again: a new press sends.
   const before = writes(f).length;
   fireEvent.click(within(region).getByRole('button', { name: 'Remove Anthropic key' }));
   await waitFor(() => expect(writes(f)).toHaveLength(before + 1));
   expect(writes(f).at(-1)).toMatchObject({ method: 'DELETE', path: KEY_PATH });
  } finally { f.close(); }
 });
 it('after Not confirmed, a later Check that sees a newer revision clears the hold without the explicit release', async () => {
  const f = mount({ putOutcome: async () => ({ status: 200, body: learning(1) }) });
  try {
   await openPage(); await holdVia('Anthropic', 'Replace the Anthropic key');
   const region = await card('Anthropic');
   fireEvent.click(within(region).getByRole('button', { name: 'Check Anthropic key' }));
   await within(region).findByRole('button', { name: "Continue with these settings" });
   f.setRevision(2);
   fireEvent.click(within(region).getByRole('button', { name: 'Check Anthropic key' }));
   await waitFor(() => expect(screen.queryAllByText(heldWords)).toHaveLength(0));
   expect(screen.queryByRole('button', { name: "Continue with these settings" })).toBeNull();
  } finally { f.close(); }
 });
 it('the continue button is offered only after a Check that saw no newer revision', async () => {
  const f = mount({ putOutcome: held503 });
  try {
   await openPage(); await holdVia('Anthropic', 'Replace the Anthropic key');
   expect(screen.queryByRole('button', { name: "Continue with these settings" })).toBeNull();
  } finally { f.close(); }
 });
});

describe('(e) an obviously wrong-provider key is refused before anything is sent', () => {
 async function paste(name: string, label: string, key: string) {
  const region = await card(name);
  const field = within(region).getByLabelText(label);
  fireEvent.change(field, { target: { value: key } }); fireEvent.submit(field.closest('form')!);
  return region;
 }
 it.each([
  ['OpenAI', 'Paste the OpenAI key', 'sk-or-', 'This looks like an OpenRouter key. Paste it under OpenRouter.'],
  ['Anthropic', 'Replace the Anthropic key', 'sk-or-', 'This looks like an OpenRouter key. Paste it under OpenRouter.'],
  ['OpenAI', 'Paste the OpenAI key', 'sk-ant-', 'This looks like an Anthropic key. Paste it under Anthropic.'],
  ['Google AI Studio (Gemini)', 'Paste the Google AI Studio (Gemini) key', 'sk-ant-', 'This looks like an Anthropic key. Paste it under Anthropic.'],
 ])('the %s slot refuses a key starting %s', async (name, label, prefix, words) => {
  const f = mount();
  try {
   await openPage();
   const before = f.requests.length;
   const region = await paste(name, label, fake(prefix));
   expect(await within(region).findByText(words)).toBeTruthy();
   expect(f.requests).toHaveLength(before);
   expect(writes(f)).toHaveLength(0);
   expect(screen.queryAllByText(heldWords)).toHaveLength(0);
  } finally { f.close(); }
 });
 it('an OpenAI-looking key in the OpenRouter slot is refused with nothing sent', async () => {
  const f = mount();
  try {
   await openPage();
   const region = await card('OpenRouter (agents only)');
   const before = f.requests.length;
   const field = within(region).getByLabelText(/^Paste the OpenRouter/u);
   fireEvent.change(field, { target: { value: fake('sk-proj-') } }); fireEvent.submit(field.closest('form')!);
   expect(await within(region).findByText('This looks like an OpenAI key. Paste it under OpenAI.')).toBeTruthy();
   expect(f.requests).toHaveLength(before);
  } finally { f.close(); }
 });
 it.each([
  ['a console command', () => `export OPENAI_API_KEY=${fake('sk-proj-')}`],
  ['a tab inside', () => `${fake('sk-proj-')}\t${fake('sk-proj-')}`],
 ])('a pasted key with %s is refused with the reason and nothing is sent', async (_name, make) => {
  const f = mount();
  try {
   await openPage();
   const before = f.requests.length;
   const region = await card('OpenAI');
   const field = within(region).getByLabelText('Paste the OpenAI key');
   fireEvent.change(field, { target: { value: make() } }); fireEvent.submit(field.closest('form')!);
   expect(await within(region).findByText("A key can't contain spaces or line breaks. Copy just the key.")).toBeTruthy();
   expect(f.requests).toHaveLength(before);
   expect(writes(f)).toHaveLength(0);
  } finally { f.close(); }
 });
 it('a key file with a line break inside is refused with the reason and nothing is sent', async () => {
  const f = mount();
  try {
   await openPage();
   const before = f.requests.length;
   const region = await card('OpenAI');
   const upload = within(region).getByLabelText('Upload a file that holds the key');
   const file = new File([`${fake('sk-proj-')}\n${fake('sk-proj-')}`], 'key.txt', { type: 'text/plain' });
   Object.defineProperty(file, 'text', { value: async () => `${fake('sk-proj-')}\n${fake('sk-proj-')}` });
   fireEvent.change(upload, { target: { files: [file] } });
   await waitFor(() => expect(within(region).getByText(/Read from the file/u)).toBeTruthy());
   fireEvent.submit(upload.closest('form')!);
   expect(await within(region).findByText("A key can't contain spaces or line breaks. Copy just the key.")).toBeTruthy();
   expect(f.requests).toHaveLength(before);
  } finally { f.close(); }
 });
 it('whitespace around the key alone is trimmed as before and the key sends', async () => {
  const f = mount();
  try {
   await openPage();
   const region = await card('OpenAI');
   const field = within(region).getByLabelText('Paste the OpenAI key');
   const key = fake('sk-proj-');
   fireEvent.change(field, { target: { value: ` ${key} ` } }); fireEvent.submit(field.closest('form')!);
   await waitFor(() => expect(writes(f)).toHaveLength(1));
   expect(writes(f)[0]).toMatchObject({ method: 'PUT', body: { provider: 'openai', key } });
  } finally { f.close(); }
 });
 it('a key of the slot\'s own shape still sends, and editing clears the hint', async () => {
  const f = mount();
  try {
   await openPage();
   const wrong = await paste('OpenAI', 'Paste the OpenAI key', fake('sk-or-'));
   const field = within(wrong).getByLabelText('Paste the OpenAI key');
   await within(wrong).findByText(/looks like an OpenRouter key/u);
   fireEvent.change(field, { target: { value: fake('sk-proj-') } });
   expect(within(wrong).queryByText(/looks like/u)).toBeNull();
   fireEvent.submit(field.closest('form')!);
   await waitFor(() => expect(writes(f)).toHaveLength(1));
   expect(writes(f)[0]).toMatchObject({ method: 'PUT', body: { provider: 'openai' } });
  } finally { f.close(); }
 });
});

describe('the OpenRouter card (agents only)', () => {
 it('says where the key is used, and saves through the company key route the agents read', async () => {
  const f = mount();
  try {
   await openPage();
   const region = await card('OpenRouter (agents only)');
   expect(within(region).getByText(/Your agents use this key when you choose OpenRouter as their AI source/u)).toBeTruthy();
   expect(within(region).getByText(/Lessons and answers don't use it/u)).toBeTruthy();
   const field = within(region).getByLabelText('Paste the OpenRouter key');
   const key = fake('sk-or-');
   fireEvent.change(field, { target: { value: key } }); fireEvent.submit(field.closest('form')!);
   await waitFor(() => expect(writes(f)).toHaveLength(1));
   // The one company key route (ProductKeys learning document), the same store the agents' own-key sources read.
   expect(writes(f)[0]).toMatchObject({ method: 'PUT', path: KEY_PATH, body: { provider: 'openrouter', key } });
  } finally { f.close(); }
 });
 it('is not offered at all where Cloud does not list it (the provider is switched off)', async () => {
  const body = learning(1);
  const withoutOpenRouter = { ...body, accounts: { anthropic: body.accounts.anthropic, openai: body.accounts.openai, gemini: body.accounts.gemini } };
  const f = mount({ readBody: withoutOpenRouter });
  try {
   await openPage();
   expect(screen.queryByRole('region', { name: 'OpenRouter (agents only)' })).toBeNull();
   expect(screen.queryByText(/Your agents use this key when you choose OpenRouter/u)).toBeNull();
  } finally { f.close(); }
 });
});

describe('copy and look of the hold notice (vision review)', () => {
 it('B1: the hold is a warning callout with an icon, Check is primary while held and secondary once not confirmed', async () => {
  const f = mount({ putOutcome: async () => ({ status: 200, body: learning(1) }) });
  try {
   await openPage(); await holdVia('Anthropic', 'Replace the Anthropic key');
   const region = await card('OpenAI');
   const callout = within(region).getByTestId('held-connection');
   expect(callout.className).toBe('rv-held-connection');
   expect(callout.querySelector('svg[aria-hidden=true]')).toBeTruthy();
   expect(within(region).getByText(CONNECTION_PAUSED)).toBeTruthy();
   expect(within(region).getByRole('button', { name: 'Check OpenAI key' }).className).toContain('rv-button-primary');
   fireEvent.click(within(region).getByRole('button', { name: 'Check OpenAI key' }));
   const next = await within(region).findByRole('button', { name: 'Continue with these settings' });
   expect(next.className).toContain('rv-button-primary');
   expect(within(region).getByRole('button', { name: 'Check OpenAI key' }).className).toContain('rv-button-secondary');
  } finally { f.close(); }
 });
 it('B1: the callout has its own tinted, bordered styling from design tokens, with space before the form', () => {
  const css = readFileSync('packages/ui/src/design/parts/held-connection.css', 'utf8');
  expect(css).toMatch(/\.rv-held-connection\{[^}]*background:var\(--rv-status-needs-you-bg\)/u);
  expect(css).toMatch(/border-left:var\(--rv-space-1\) solid var\(--rv-status-needs-you\)/u);
  expect(css).toMatch(/margin-block:var\(--rv-space-3\) var\(--rv-space-5\)/u);
  expect(css).not.toMatch(/#[0-9a-f]{3,6}\b|rgb\(/iu);
 });
 it('B2: a lost answer says it cannot tell whether the key was saved, not "try again"', async () => {
  const f = mount({ putOutcome: held503 });
  try {
   await openPage(); await holdVia('Anthropic', 'Replace the Anthropic key');
   const region = await card('Anthropic');
   expect(within(region).getByText(CONNECTION_NO_ANSWER)).toBe(within(region).getByText("Rovara didn't get an answer, so it can't tell whether the new key was saved."));
   expect(document.body.textContent).not.toMatch(/Try again shortly/u);
  } finally { f.close(); }
 });
 it('B3: after Check, every card replaces the pause line: long words where the change was made, short words elsewhere; Continue unlocks with the new line', async () => {
  const f = mount({ putOutcome: async () => ({ status: 200, body: learning(1) }) });
  try {
   await openPage(); await holdVia('Anthropic', 'Replace the Anthropic key');
   fireEvent.click(within(await card('OpenAI')).getByRole('button', { name: 'Check OpenAI key' }));
   await within(await card('OpenAI')).findByRole('button', { name: 'Continue with these settings' });
   expect(within(await card('Anthropic')).getByText(CONNECTION_NOT_CONFIRMED)).toBeTruthy();
   for (const name of ['OpenAI', 'Google AI Studio (Gemini)', 'OpenRouter (agents only)']) {
    const region = await card(name);
    expect(within(region).getByText(CONNECTION_NOT_CONFIRMED_SHORT)).toBeTruthy();
    expect(within(region).queryByText(CONNECTION_PAUSED)).toBeNull();
    expect(within(region).getByRole('button', { name: 'Continue with these settings' })).toBeTruthy();
   }
   expect(within(await card('Anthropic')).queryByText(CONNECTION_PAUSED)).toBeNull();
   fireEvent.click(within(await card('OpenAI')).getByRole('button', { name: 'Continue with these settings' }));
   expect(await screen.findByText('Changes are unlocked. The settings shown are the current ones.')).toBeTruthy();
   expect(screen.queryByText(/Continuing\./u)).toBeNull();
  } finally { f.close(); }
 });
 it('nits: "(agents only)" stays in the card title only, and the path to AI source order is a link', async () => {
  const f = mount();
  try {
   await openPage();
   const region = await card('OpenRouter (agents only)');
   expect(within(region).getByText('No OpenRouter key is connected.')).toBeTruthy();
   expect(within(region).getByLabelText('Paste the OpenRouter key')).toBeTruthy();
   const link = within(region).getByRole('link', { name: 'AI and spending > AI source order' });
   expect(link.getAttribute('href')).toBe('/app/admin/ai-spending');
  } finally { f.close(); }
 });
});
