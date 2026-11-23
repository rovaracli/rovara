// @vitest-environment jsdom
// WIRING-1 restore round (controller ruling, no-lost-live-actions): the monthly limit, who pays, Connect company AI, the models save where step models are not served, report paging,
// the pull-request links, the Back link and the Project field are on the rebuilt pages. Each action: allowed = exactly one send; refused / stale / no permission = zero sends.
import { beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { mount } from './harness.js';
import { FEATURE, product, report, detail, numbers, reply, scope } from './fixtures.js';
import { readCostReport, readFeatureDetail } from '../../../../packages/ui/src/api/admin-report.js';
import type { ApiRequest, ApiResponse } from '../../../../packages/ui/src/host.js';
const identity = { developer: { id: scope.developerId, name: 'Priya', orgRole: 'admin' }, org: { orgId: scope.orgId, name: 'Acme', plan: 'team' }, identities: [] };
const writes = (requests: ApiRequest[]) => requests.filter(r => r.method !== 'GET');
const marker = 'fixture-private-marker';
beforeEach(() => localStorage.clear());
const agentAi = (source: string | null, version = 1) => ({ version, source, effectiveSource: source ?? 'anthropic_key', sourceIsDefault: source === null, anthropicKeyConnected: true, bedrockConnected: false, choices: [{ source: 'rovara', available: true }, { source: 'anthropic_key', available: true }, { source: 'bedrock_byo', available: false }] });
const settingsBody = (micros: number, version = 1) => ({ version, modelGateway: { ready: true }, settings: { budgets: { companyMonthlyUsdMicros: micros } } });
/** The AI page with the spending routes as a small store: reads answer the current value, a PUT saves it. */
function spendingPage(options: { refuse?: ApiResponse; settingsVersion?: () => number; agentModels?: ApiResponse; me?: () => unknown } = {}) {
 let micros = 500_000_000, source: string | null = 'anthropic_key', version = 1;
 const f = mount('/app/admin/ai-spending', async r => {
  if (r.path === '/v1/app/me') return { status: 200, body: options.me?.() ?? identity };
  if (r.method !== 'GET' && (r.path === '/v1/app/org/settings' || r.path === '/v1/app/org/agent-ai')) {
   if (options.refuse !== undefined) return options.refuse;
   version += 1;
   if (r.path === '/v1/app/org/settings') micros = (r.body as { settings: { budgets: { companyMonthlyUsdMicros: number } } }).settings.budgets.companyMonthlyUsdMicros; else source = (r.body as { source: string }).source;
   return { status: 200, body: r.path === '/v1/app/org/settings' ? settingsBody(micros, version) : agentAi(source, version) };
  }
  if (r.path === '/v1/app/org/settings') return { status: 200, body: settingsBody(micros, options.settingsVersion?.() ?? version) };
  if (r.path === '/v1/app/org/agent-ai') return { status: 200, body: agentAi(source, version) };
  if (r.path === '/v1/app/org/agent-models' && options.agentModels !== undefined) return options.agentModels;
  return reply(r);
 });
 return f;
}
async function openSpending() {
 fireEvent.click(await screen.findByRole('button', { name: 'Change spending' }));
 const dialog = await screen.findByRole('dialog');
 return { dialog, limit: await within(dialog).findByLabelText<HTMLInputElement>(/Company monthly limit/u) };
}
describe('Change spending (the monthly limit and who pays)', () => {
 it('shows Loading while the dialog reads its settings', async () => {
  let finish: ((answer: ApiResponse) => void) | undefined;
  const pending = new Promise<ApiResponse>(resolve => { finish = resolve; });
  mount('/app/admin/ai-spending', async r => r.path === '/v1/app/me' ? { status: 200, body: identity } : r.path === '/v1/app/org/engine-model' ? pending : reply(r));
  fireEvent.click(await screen.findByRole('button', { name: 'Change spending' }));
  const dialog = await screen.findByRole('dialog');
  expect(within(dialog).getByRole('progressbar', { name: 'Loading AI and spending' })).toBeTruthy();
  finish?.(reply({ method: 'GET', path: '/v1/app/org/engine-model' }));
  await within(dialog).findByLabelText(/Company monthly limit/u);
 });
 it.each(['/v1/app/org/engine-model', '/v1/app/org/agent-ai', '/v1/app/org/settings'])('shows the server sentence when the dialog cannot read %s', async path => {
  mount('/app/admin/ai-spending', async r => r.path === '/v1/app/me' ? { status: 200, body: identity } : r.path === path ? { status: 501, body: { error: { code: 'NOT_ON_CODE_YET', message: 'This company setting is being restored. Check later.' } } } : reply(r));
  fireEvent.click(await screen.findByRole('button', { name: 'Change spending' }));
  const dialog = await screen.findByRole('dialog');
  expect(await within(dialog).findByText('This company setting is being restored. Check later.')).toBeTruthy();
  expect(within(dialog).queryByRole('button', { name: 'Save' })).toBeNull();
 });
 it('the section reads who pays and the limit from the same routes the dialog saves to', async () => {
  spendingPage();
  const section = await screen.findByRole('region', { name: 'Spending' });
  expect(await within(section).findByText('Your Anthropic key')).toBeTruthy(); expect(within(section).getByText('$500')).toBeTruthy();
 });
 it('allowed: a changed limit sends exactly one PUT with the version that was read, and nothing else', async () => {
  const f = spendingPage();
  const { dialog, limit } = await openSpending();
  expect(limit.value).toBe('500');
  fireEvent.change(limit, { target: { value: '600' } });
  const save = within(dialog).getByRole('button', { name: 'Save' });
  fireEvent.click(save); fireEvent.click(save);
  await waitFor(() => expect(writes(f.requests)).toHaveLength(1));
  const sent = writes(f.requests)[0]!;
  expect(sent.method).toBe('PUT'); expect(sent.path).toBe('/v1/app/org/settings');
  expect(sent.body).toMatchObject({ expectedVersion: 1, settings: { budgets: { companyMonthlyUsdMicros: 600_000_000 } } });
  expect(await screen.findByText(/Company monthly limit: \$600/u)).toBeTruthy();
  expect(writes(f.requests)).toHaveLength(1);
 });
 it('allowed: choosing Rovara\'s AI sends exactly one PUT to agent-ai and no settings write', async () => {
  const f = spendingPage();
  const { dialog } = await openSpending();
  fireEvent.click(within(dialog).getByTestId('ai-spend-rovara').querySelector('input')!);
  fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(writes(f.requests)).toHaveLength(1));
  expect(writes(f.requests)[0]).toMatchObject({ method: 'PUT', path: '/v1/app/org/agent-ai', body: { expectedVersion: 1, source: 'rovara' } });
 });
 it('refused: the server\'s own sentence is shown, nothing else is sent, and the next deliberate press works', async () => {
  const f = spendingPage({ refuse: { status: 403, body: { error: { code: 'FORBIDDEN', message: 'Only a company owner or admin can change the limit.' } } } });
  const { dialog, limit } = await openSpending();
  fireEvent.change(limit, { target: { value: '600' } });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
  expect((await screen.findByTestId('ai-spend-error')).textContent).toContain('Only a company owner or admin can change the limit.');
  expect(writes(f.requests)).toHaveLength(1);
  await new Promise(resolve => setTimeout(resolve, 10));
  fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(writes(f.requests)).toHaveLength(2));
 });
 it('stale: a settings version that moved after the page read sends nothing', async () => {
  let current = 1;
  const f = spendingPage({ settingsVersion: () => current });
  const { dialog, limit } = await openSpending();
  fireEvent.change(limit, { target: { value: '600' } });
  current = 2;
  fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
  await screen.findByTestId('ai-spend-error');
  expect(writes(f.requests)).toHaveLength(0);
 });
 it('no permission: a member sees no Change spending or Connect company AI, and nothing is written', async () => {
  const f = mount('/app/admin/ai-spending', async r => r.path === '/v1/app/me' ? { status: 200, body: { ...identity, developer: { ...identity.developer, orgRole: 'member' } } } : reply(r), { ...scope, role: 'member' });
  await screen.findByRole('heading', { name: 'AI and spending', level: 1 });
  expect(screen.queryByRole('button', { name: 'Change spending' })).toBeNull(); expect(screen.queryByRole('button', { name: 'Connect company AI' })).toBeNull();
  expect(writes(f.requests)).toHaveLength(0);
 });
 it('a role that became member after the page loaded sends nothing', async () => {
  let role = 'admin';
  const f = spendingPage({ me: () => ({ ...identity, developer: { ...identity.developer, orgRole: role } }) });
  const { dialog, limit } = await openSpending();
  fireEvent.change(limit, { target: { value: '600' } });
  role = 'member';
  fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
  await screen.findByTestId('ai-spend-error');
  expect(writes(f.requests)).toHaveLength(0);
 });
});
describe('Connect company AI', () => {
 const learningAi = { revision: 1, accounts: { anthropic: { connected: false }, openai: { connected: false }, gemini: { connected: false }, openrouter: { connected: false } }, listed: ['anthropic', 'openai', 'gemini'], removed: [], pausedNow: [], pauseReasons: [] };
 function connectPage(refuse?: ApiResponse) {
  return mount('/app/admin/ai-spending', async r => {
   if (r.path === '/v1/app/me') return { status: 200, body: identity };
   if (r.path === '/v1/app/org/learning-ai') return { status: 200, body: learningAi };
   if (r.path === '/v1/app/org/learning-ai/key') return refuse ?? { status: 200, body: { ...learningAi, revision: 2 } };
   if (r.path === '/v1/app/org/agent-ai' && r.method === 'GET') return { status: 200, body: agentAi('anthropic_key') };
   return reply(r);
  });
 }
 it('allowed: the Anthropic key is sent once to the live route, never shown back, and the page is not fenced out', async () => {
  const f = connectPage();
  fireEvent.click(await screen.findByRole('button', { name: 'Connect company AI' }));
  const dialog = await screen.findByRole('dialog');
  fireEvent.change(await within(dialog).findByLabelText('Paste the Anthropic key'), { target: { value: marker } });
  const connect = within(dialog).getAllByRole('button', { name: 'Connect key' })[0]!;
  fireEvent.click(connect); fireEvent.click(connect);
  await waitFor(() => expect(writes(f.requests)).toHaveLength(1));
  expect(writes(f.requests)[0]).toMatchObject({ method: 'PUT', path: '/v1/app/org/learning-ai/key', body: { provider: 'anthropic', key: marker, expectedRevision: 1 } });
  await waitFor(() => expect(document.body.innerHTML).not.toContain(marker));
  expect(JSON.stringify(localStorage)).not.toContain(marker);
 });
 it('refused: the server\'s sentence is shown and the key is not left in the page', async () => {
  const f = connectPage({ status: 403, body: { error: { code: 'FORBIDDEN', message: 'Only a company owner or admin can connect AI.' } } });
  fireEvent.click(await screen.findByRole('button', { name: 'Connect company AI' }));
  const dialog = await screen.findByRole('dialog');
  fireEvent.change(await within(dialog).findByLabelText('Paste the Anthropic key'), { target: { value: marker } });
  fireEvent.click(within(dialog).getAllByRole('button', { name: 'Connect key' })[0]!);
  expect(await within(dialog).findByText('Only a company owner or admin can connect AI.')).toBeTruthy();
  expect(writes(f.requests)).toHaveLength(1);
  expect(document.body.innerHTML).not.toContain(marker);
 });
});
describe('company and learning model Save where the step models are not served', () => {
 it('the Change a model button stays, and its company-model Save sends exactly one PUT', async () => {
  let saved = false;
  const model = () => ({ model: saved ? 'other-model' : 'fixture-model', source: 'company', canChange: true, offered: ['fixture-model', 'other-model'], preselect: 'fixture-model' });
  const f = mount('/app/admin/ai-spending', async r => {
   if (r.path === '/v1/app/me') return { status: 200, body: identity };
   if (r.path === '/v1/app/org/agent-models') return { status: 501, body: { error: { code: 'NOT_ON_CODE_YET', message: 'Not on Rovara Code yet.' } } };
   if (r.method !== 'GET' && r.path.endsWith('/engine-model')) { saved = true; return { status: 200, body: model() }; }
   if (r.path.endsWith('/engine-model') || r.path.endsWith('/learning-model')) return { status: 200, body: model() };
   return reply(r);
  });
  fireEvent.click(await screen.findByRole('button', { name: 'Change a model' }));
  const dialog = await screen.findByRole('dialog');
  fireEvent.change(await within(dialog).findByLabelText('Company model'), { target: { value: 'other-model' } });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Save company model' }));
  await waitFor(() => expect(writes(f.requests)).toHaveLength(1));
  expect(writes(f.requests)[0]).toMatchObject({ method: 'PUT', path: '/v1/app/org/engine-model', body: { model: 'other-model' } });
 });
 it('step models served with no permission to change (canChange false) draw no Change a model button', async () => {
  const { models } = await import('./fixtures.js');
  mount('/app/admin/ai-spending', async r => r.path === '/v1/app/me' ? { status: 200, body: identity } : r.path === '/v1/app/org/agent-models' ? { status: 200, body: { ...models, canChange: false } } : reply(r));
  await screen.findByRole('heading', { name: 'AI and spending', level: 1 });
  await screen.findByRole('table', { name: 'Effective step models' });
  expect(screen.queryByRole('button', { name: 'Change a model' })).toBeNull();
 });
 it('a failed (not "not served") step-models read still hides it: no save without a read', async () => {
  mount('/app/admin/ai-spending', async r => r.path === '/v1/app/me' ? { status: 200, body: identity } : r.path === '/v1/app/org/agent-models' ? { status: 503, body: { error: { code: 'UNAVAILABLE', message: 'x' } } } : reply(r));
  await screen.findByRole('heading', { name: 'AI and spending', level: 1 });
  await waitFor(() => expect(screen.queryByText(/Reading step models/u)).toBeNull());
  expect(screen.queryByRole('button', { name: 'Change a model' })).toBeNull();
 });
});
describe('the report pages', () => {
 const many = (n: number) => Array.from({ length: n }, (_, i) => ({ ...numbers, key: `ft_${i.toString(16).padStart(20, '0')}`, name: `Feature ${String(i).padStart(2, '0')}`, state: 'open', costCents: 10_000 - i }));
 const bigReport = (n: number) => readCostReport.parse({ range: {}, asOf: report.asOf, totals: { ...numbers, tasks: n }, projects: ['web'], byFeature: many(n), byProject: [{ ...numbers, key: 'web', name: 'web' }], canChange: true, features: [] });
 it('pages 25 rows at a time: data beyond the first page stays reachable, the totals row stays last', async () => {
  mount('/app/admin/money/report?range=all', async r => r.path.startsWith('/v1/app/org/report/features/') ? { status: 200, body: { ...detail, feature: { ...detail.feature, id: r.path.split('/').pop(), name: 'x' } } } : r.path === '/v1/app/org/report' || r.path.startsWith('/v1/app/org/report?') ? { status: 200, body: bigReport(60) } : reply(r));
  const table = await screen.findByRole('table', { name: 'Cost and time by feature' });
  expect(within(table).getAllByRole('row')).toHaveLength(27);
  expect(screen.getByText('Showing 1 to 25 of 60')).toBeTruthy();
  expect(within(table).queryByText('Feature 30')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
  expect(screen.getByText('Showing 26 to 50 of 60')).toBeTruthy();
  expect(within(screen.getByRole('table', { name: 'Cost and time by feature' })).getByText('Feature 30')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
  expect(screen.getByText('Showing 51 to 60 of 60')).toBeTruthy(); expect(screen.getByRole('button', { name: 'Next page' })).toHaveProperty('disabled', true);
  const last = within(screen.getByRole('table', { name: 'Cost and time by feature' })).getAllByRole('row').at(-1)!;
  expect(last.textContent).toContain('Task work in this report');
  fireEvent.click(screen.getByRole('tab', { name: 'By project' }));
  expect(screen.queryByRole('button', { name: 'Next page' })).toBeNull();
 });
 it('a report that fits one page draws no pager', async () => {
  mount('/app/admin/money/report?range=all');
  await screen.findByRole('table', { name: 'Cost and time by feature' });
  expect(screen.queryByRole('button', { name: 'Next page' })).toBeNull();
 });
 it('the feature page links a task\'s pull request and has a Back link that keeps the filters', async () => {
  const withPr = readFeatureDetail.parse({ ...detail, tasks: [{ ...detail.tasks[0]!, state: 'merged', prsOpened: 1, prsMerged: 1, prLinks: ['https://github.com/acme/web/pull/7'] }] });
  mount(`/app/admin/money/report/features/${FEATURE}?range=all&project=web`, async r => r.path.startsWith(`/v1/app/org/report/features/${FEATURE}`) ? { status: 200, body: withPr } : reply(r));
  const tasks = await screen.findByRole('table', { name: 'Tasks in this feature' });
  // The link is in the Pull request column and in the row's one-line summary (what a phone shows).
  const links = within(tasks).getAllByRole('link', { name: '1 merged of 1' });
  expect(links.length).toBeGreaterThan(0);
  for (const link of links) { expect(link.getAttribute('href')).toBe('https://github.com/acme/web/pull/7'); expect(link.getAttribute('rel')).toContain('noopener'); }
  expect(screen.getByRole('link', { name: 'Back to Cost and time' }).getAttribute('href')).toBe('/app/admin/money/report?range=all&project=web');
 });
 it('the report\'s selected-feature card links the pull request too', async () => {
  const withPr = readFeatureDetail.parse({ ...detail, tasks: [{ ...detail.tasks[0]!, state: 'merged', prsOpened: 1, prsMerged: 1, prLinks: ['https://github.com/acme/web/pull/7'] }] });
  mount('/app/admin/money/report?range=all', async r => r.path.startsWith(`/v1/app/org/report/features/${FEATURE}`) ? { status: 200, body: withPr } : reply(r));
  const card = await screen.findByRole('region', { name: 'Selected feature' });
  expect((await within(card).findAllByRole('link', { name: '1 merged of 1' })).every(link => link.getAttribute('href') === 'https://github.com/acme/web/pull/7')).toBe(true);
 });
});
describe('Product AI Project field', () => {
 it('opens the editor for a valid project that is not listed, reading only that project', async () => {
  const f = mount('/app/admin/product-ai', async r => r.path === '/v1/app/projects/other-app/product-ai' ? { status: 200, body: { ...product, project: 'other-app' } } : reply(r));
  await screen.findByText('Key connected');
  const field = screen.getByLabelText('Project'), open = screen.getByRole('button', { name: 'Open' });
  expect(open).toHaveProperty('disabled', true);
  fireEvent.change(field, { target: { value: 'Bad Name' } });
  expect(screen.getByText('Lowercase letters, digits and hyphens, starting with a letter.')).toBeTruthy(); expect(open).toHaveProperty('disabled', true);
  expect(f.requests.some(r => r.path.includes('Bad'))).toBe(false);
  fireEvent.change(field, { target: { value: 'other-app' } });
  fireEvent.click(open);
  expect(await screen.findByRole('region', { name: /product AI key/u })).toBeTruthy();
  await waitFor(() => expect(f.requests.filter(r => r.path === '/v1/app/projects/other-app/product-ai').length).toBeGreaterThan(0));
  expect(writes(f.requests)).toHaveLength(0);
 });
});

// Review test (lead 4 Opus, d960b6ed9): only Code's "not served" 501 (NOT_ON_CODE_YET) keeps the model Save without a step-models read; another 501 hides it.
it('a 501 step-models read that is not NOT_ON_CODE_YET draws no Change a model button', async () => {
 mount('/app/admin/ai-spending', async r => r.path === '/v1/app/me' ? { status: 200, body: identity } : r.path === '/v1/app/org/agent-models' ? { status: 501, body: { error: { code: 'NOT_IMPLEMENTED', message: 'x' } } } : reply(r));
 await screen.findByRole('heading', { name: 'AI and spending', level: 1 });
 await waitFor(() => expect(screen.queryByText(/Reading step models/u)).toBeNull());
 await screen.findByRole('button', { name: 'Change spending' });
 expect(screen.queryByRole('button', { name: 'Change a model' })).toBeNull();
});
