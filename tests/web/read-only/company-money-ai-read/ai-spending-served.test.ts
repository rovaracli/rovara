// @vitest-environment jsdom
// AI-SPENDING-UNKNOWNS: the AI and spending page says the facts it was served. Unknown only where the read itself failed or served nothing to say it from.
import { describe, it, expect } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import { mount } from './harness.js';
import { failed, models, reply, sources } from './fixtures.js';
const rovara = { source: 'rovara', available: true, connected: true, inOrder: false };
const own = (source: string, connected: boolean | null, inOrder = false) => ({ source, available: true, connected, inOrder });
const serve = (body: object, others: (path: string) => object | undefined = () => undefined) => async (r: { path: string }) => r.path.includes('model-sources') ? { status: 200, body } : others(r.path) === undefined ? reply(r as never) : { status: 200, body: others(r.path) };
const header = () => screen.getByRole('heading', { level: 1 }).closest('header') as HTMLElement;
const noUnknown = (node: HTMLElement) => expect(within(node).queryByRole('img', { name: 'Unknown' })).toBeNull();
describe('AI and spending: the status chip says served facts', () => {
 it('Rovara default, no company sources: "Using Rovara\'s AI" and the empty-order line, no Unknown in either', async () => {
  mount('/app/admin/ai-spending', serve({ ...sources, revision: 0, order: [], sources: [rovara] }));
  expect(await screen.findByText("Rovara's AI (the default). No company sources connected.")).toBeTruthy();
  await waitFor(() => expect(within(header()).getByText("Using Rovara's AI")).toBeTruthy());
  expect(header().textContent).toMatch(/No company sources connected · Read from Rovara /u);
  noUnknown(header()); noUnknown(document.querySelector('#ai-connections') as HTMLElement);
 });
 it('two company sources in order: the chip counts the connected ones and the count line counts the order', async () => {
  mount('/app/admin/ai-spending', serve({ ...sources, order: ['anthropic_key', 'bedrock_byo'], sources: [rovara, own('anthropic_key', true, true), own('bedrock_byo', true, true)] }));
  await waitFor(() => expect(within(header()).getByText('2 company sources connected')).toBeTruthy());
  expect(header().textContent).toMatch(/2 sources in order · Read from Rovara /u);
  noUnknown(header());
  expect(Array.from(document.querySelectorAll('#ai-connections ol li strong')).map(node => node.textContent)).toEqual(['Your Anthropic key', 'Your Bedrock']);
 });
 it('company sources connected but no order saved: says so without naming a default it was not served', async () => {
  mount('/app/admin/ai-spending', serve({ ...sources, revision: 0, order: [], sources: [rovara, own('anthropic_key', true)] }));
  expect(await screen.findByText('No order saved yet. 1 company source connected.')).toBeTruthy();
  expect(within(header()).getByText('1 company source connected')).toBeTruthy();
  expect(screen.queryByText(/the default/u)).toBeNull();
 });
 it('a failed model-sources read shows no served chip: the page carries the shared failed-read state, never "Using Rovara\'s AI"', async () => {
  mount('/app/admin/ai-spending', async r => r.path.includes('model-sources') ? failed : reply(r));
  await waitFor(() => expect(screen.getAllByText("Rovara couldn't read this section").length).toBeGreaterThan(0));
  expect(screen.queryByText("Using Rovara's AI")).toBeNull(); expect(screen.queryByText(/company sources? connected/u)).toBeNull();
  expect(screen.queryByText("Rovara's AI (the default). No company sources connected.")).toBeNull();
  expect(header().textContent).not.toMatch(/Read from Rovara/u);
 });
 it('a source row missing from a served list keeps its own Unknown chip (not a verdict)', async () => {
  mount('/app/admin/ai-spending', serve({ ...sources, order: ['custom_endpoint'], sources: [rovara, own('custom_endpoint', null, true)] }));
  await waitFor(() => expect(within(document.querySelector('#ai-connections') as HTMLElement).getByRole('img', { name: 'Unknown' })).toBeTruthy());
  // an order led by a company source never sits beside "No company sources connected"
  expect(within(header()).getByText('Your own endpoint first')).toBeTruthy();
  expect(screen.queryByText(/No company sources connected/u)).toBeNull();
 });
 it('an unanswered (connected: null) company source is never counted as not connected: no "none connected", no default named', async () => {
  mount('/app/admin/ai-spending', serve({ ...sources, revision: 0, order: [], sources: [rovara, own('anthropic_key', null)] }));
  expect(await screen.findByText("No order saved yet. Rovara can't confirm which company sources are connected yet.")).toBeTruthy();
  expect(screen.queryByText(/No company sources connected/u)).toBeNull(); expect(screen.queryByText(/the default/u)).toBeNull(); expect(screen.queryByText("Using Rovara's AI")).toBeNull();
  expect(within(header()).getByRole('img', { name: 'Unknown' })).toBeTruthy();
 });
 it('every company source served connected: false (available or not) is the default; a saved order led by a company source says what it starts with', async () => {
  mount('/app/admin/ai-spending', serve({ ...sources, revision: 0, order: [], sources: [rovara, own('anthropic_key', false), { source: 'custom_endpoint', available: false, connected: false, inOrder: false }] }));
  expect(await screen.findByText("Rovara's AI (the default). No company sources connected.")).toBeTruthy();
 });
 it('a saved order led by a company source with none confirmed connected says what it starts with, not "No company sources connected"', async () => {
  mount('/app/admin/ai-spending', serve({ ...sources, order: ['anthropic_key', 'rovara'], sources: [rovara, own('anthropic_key', false, true)] }));
  await waitFor(() => expect(within(header()).getByText('Your Anthropic key first')).toBeTruthy());
  expect(screen.queryByText(/No company sources connected/u)).toBeNull(); expect(header().textContent).toMatch(/2 sources in order/u);
 });
});
const rovaraPays = { version: 0, source: null, effectiveSource: 'rovara', sourceIsDefault: true, choices: [{ source: 'rovara', available: true }] };
describe('AI and spending: the models section names a source only when the served effective source is that source', () => {
 it('Rovara\'s AI is the served effective source: the title names it', async () => {
  mount('/app/admin/ai-spending', async r => r.path.endsWith('/org/agent-ai') ? { status: 200, body: rovaraPays } : reply(r));
  const section = await screen.findByRole('region', { name: 'Models' });
  await waitFor(() => expect(within(section).getByRole('heading', { name: "Models offered through Rovara's AI" })).toBeTruthy());
 });
 it('a company source pays (the default fixture: Your Anthropic key): the title makes no per-source claim', async () => {
  mount('/app/admin/ai-spending');
  expect(await screen.findByText('Your Anthropic key', { selector: 'dd' })).toBeTruthy();
  const section = await screen.findByRole('region', { name: 'Models' });
  expect(within(section).getByRole('heading', { name: 'Models you can use' })).toBeTruthy();
  expect(screen.queryByText(/Models offered through Rovara/u)).toBeNull();
 });
 it('the who-pays read failed: no source is named in the title', async () => {
  mount('/app/admin/ai-spending', async r => r.path.endsWith('/org/agent-ai') ? failed : reply(r));
  const section = await screen.findByRole('region', { name: 'Models' });
  await waitFor(() => expect(within(section).getByRole('heading', { name: 'Models you can use' })).toBeTruthy());
  expect(screen.queryByText(/Models offered through Rovara/u)).toBeNull();
 });
});
describe('AI and spending: the models section lists offered[]', () => {
 it('lists offered[] under the served title, with no per-source claim and no literal Unknown', async () => {
  mount('/app/admin/ai-spending', async r => r.path.endsWith('agent-models') ? { status: 200, body: { ...models, offered: ['claude-sonnet-4-5', 'claude-haiku-4-5'] } } : reply(r));
  const section = await screen.findByRole('region', { name: 'Models' });
  expect(within(section).getByRole('heading', { name: 'Models you can use' })).toBeTruthy();
  expect(await within(section).findByText('Claude Sonnet 4.5, Claude Haiku 4.5')).toBeTruthy();
  expect(screen.queryByText(/Which source offers each model/u)).toBeNull(); expect(screen.queryByText('Models each source offers')).toBeNull();
  noUnknown(section);
 });
 it('a failed models read shows the section-level failure, not the offered title with facts', async () => {
  mount('/app/admin/ai-spending', async r => r.path.endsWith('agent-models') ? failed : reply(r));
  const section = await screen.findByRole('region', { name: 'Models' });
  await waitFor(() => expect(within(section).getByText("Rovara couldn't read this section")).toBeTruthy());
  expect(within(section).queryByText('fixture-model')).toBeNull();
 });
});
describe('Order of AI sources: the empty order is the served default', () => {
 it('Rovara default: the served line and a Default chip; a failed read shows none of it', async () => {
  mount('/app/admin/ai-spending/order', serve({ ...sources, revision: 0, order: [], sources: [rovara] }));
  expect(await screen.findByText("Rovara's AI (the default). No company sources connected.")).toBeTruthy();
  expect(screen.queryByText('No saved order yet.')).toBeNull();
 });
 it('a failed read shows the shared failure, not the default', async () => {
  mount('/app/admin/ai-spending/order', async r => r.path.includes('model-sources') ? failed : reply(r));
  await screen.findByRole('alert');
  expect(screen.queryByText(/the default/u)).toBeNull();
 });
});
describe('Cost report: the info aside is not an Unknown placeholder', () => {
 it('Spending-can-differ aside carries no Unknown chip; unserved facts elsewhere still do', async () => {
  mount('/app/admin/money/report?range=all');
  const aside = (await screen.findByText('Spending can show a different total.')).closest('aside') as HTMLElement;
  noUnknown(aside);
 });
});
