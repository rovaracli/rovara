// G2 reuses the live handlers. This transport fence adds no API or authority:
// the existing identity, canChange, revision and offered-list reads still decide.
import type { QueryClient } from '@tanstack/react-query';
import { AppMeResponseReaderSchema } from '@agentx/contracts/web';
import { createApiClient } from '../../api/client.js';
import { accessEndedCode } from '../../api/served-read.js';
import { sourcesReader } from './read-model.js';
import { ApiError } from '../../api/errors.js';
import { readCostReport, readFeatureDetail, REPORT_PATH } from '../../api/admin-report.js';
import { readProductAi } from '../../api/admin-product-ai.js';
import { readAgentModels } from '../../api/agent-models.js';
import { readEngineModel } from '../../api/ai-spend.js';
import { readLearningModel } from '../../api/learning-model.js';
import { readAgentAi } from '../../api/admin-agent-ai.js';
import { readCompanySettings } from '../../api/admin-company.js';
import { fenceFor, fencedRead, postWithTimeout, withActionClaim } from '../../safe-action.js';
import { sourceOrderReceipt } from '../admin/models/source-order.js';
import type { ApiRequest, ApiResponse, AppHost } from '../../host.js';
import type { AdminContext } from '../admin/admin-context.js';
const object = (value: unknown): Record<string, unknown> => typeof value === 'object' && value !== null ? value as Record<string, unknown> : {};
const PREFIX = 'rovara:g2-action:';
const UNKNOWN = "Rovara didn't confirm this yet. Check the action outcome before another change.";
const STALE = 'The information or your access changed. Load again before making a change.';
const sharedPaths = new WeakMap<QueryClient, Map<string, Set<string>>>();
/** Only parsed, secret-free projections enter the shared read fence. */
export function moneyAiActionHost(host: AppHost, client: QueryClient, context: AdminContext, active: () => boolean, changed: () => void) {
 const scope = `${context.orgId}:${context.developerId}`;
 let scopes = sharedPaths.get(client); if (!scopes) { scopes = new Map(); sharedPaths.set(client, scopes); }
 let paths = scopes.get(scope); if (!paths) { paths = new Set(); scopes.set(scope, paths); }
 const knownPaths = paths;
 const api = createApiClient({ ...host, transport: { async request(input) { const response = await host.transport.request(input); if (input.method === 'GET' && response.status === 202 && accessEndedCode(response.body) === undefined) throw new ApiError(202, 'READ_UNCONFIRMED', 'The read is not confirmed.'); return response; } } });
 const fence = (path: string) => fenceFor(client, scope, `g2:${path}`);
 function parse(path: string, body: unknown): unknown {
  const route = path.split('?')[0]!;
  if (route === REPORT_PATH) return readCostReport.parse(body);
  if (route.startsWith(`${REPORT_PATH}/features/`)) {
   const data = readFeatureDetail.parse(body), id = decodeURIComponent(route.slice(`${REPORT_PATH}/features/`.length));
   if (id === 'none' ? !data.feature.none : data.feature.id !== id || data.feature.none) throw new Error('Wrong feature');
   return data;
  }
  if (/^\/v1\/app\/projects\/[^/]+\/product-ai$/u.test(route)) {
   const data = readProductAi(body);
   if (data.project !== decodeURIComponent(route.split('/')[4]!)) throw new Error('Wrong project');
   // A missing canChange is NOT permission: only an explicit true allows a send.
   return { ...data, canChange: object(body)['canChange'] === true };
  }
  if (route === '/v1/app/org/model-sources') return sourcesReader(context.orgId, context.developerId).parse(body);
  if (route === '/v1/app/org/agent-models') return readAgentModels(body);
  if (route === '/v1/app/org/engine-model') return readEngineModel(body);
  if (route === '/v1/app/org/learning-model') return readLearningModel(body);
  if (route === '/v1/app/org/agent-ai') return readAgentAi(body);
  if (route === '/v1/app/org/settings') return readCompanySettings(body);
  return undefined;
 }
 function basis(value: unknown): string {
  const data = object(value);
  // Changes in amounts/asOf alone do not change a feature-management proposal.
  return JSON.stringify('totals' in data ? { canChange: data['canChange'], feature: data['feature'], features: data['features'], tasks: (data['tasks'] as Array<{ taskId: string }> | undefined)?.map(task => task.taskId) } : value);
 }
 async function read(path: string) {
  knownPaths.add(path);
  let raw: unknown;
  const result = await fencedRead(fence(path), async () => {
   const response = await api.get(path, { parse: body => { raw = body; return parse(path, body); } }, undefined, { retry: 'never' });
   if (response === undefined) throw new Error('Unallocated action read');
   return response;
  });
  return { ...result, raw };
 }
 function subject(input: ApiRequest): string | undefined {
  const route = input.path;
  const recent = [...knownPaths].sort((a, b) => (fence(b).latestRead?.issued ?? 0) - (fence(a).latestRead?.issued ?? 0));
  const find = (prefix: string) => recent.find(path => path.split('?')[0] === prefix);
  if (route === `${REPORT_PATH}/features`) return find(REPORT_PATH);
  if (/\/report\/features\/[^/]+\/(rename|merge|state)$/u.test(route)) return find(route.slice(0, route.lastIndexOf('/')));
  if (/\/tasks\/[^/]+\/feature$/u.test(route)) {
   const id = decodeURIComponent(route.split('/')[4]!);
   return recent.find(path => (object(fence(path).latestRead?.data)['tasks'] as Array<{ taskId: string }> | undefined)?.some(task => task.taskId === id));
  }
  if (/\/product-ai\/(key|vertex|eval-budget|eval-approval)$/u.test(route)) return find(route.slice(0, route.lastIndexOf('/')));
  if (route === '/v1/app/org/model-sources-order') return find('/v1/app/org/model-sources');
  return find(route);
 }
 const lockKey = (path: string) => `${PREFIX}${scope}:${path.split('?')[0]}`;
 function pending() {
  try { return Object.keys(globalThis.localStorage).filter(key => key.startsWith(`${PREFIX}${scope}:`)); } catch { return []; }
 }
 async function identity() {
  const me = await api.get('/v1/app/me', AppMeResponseReaderSchema, undefined, { retry: 'never' });
  if (!active() || context.checking || me.org.orgId !== context.orgId || me.developer.id !== context.developerId || !['owner', 'admin'].includes(me.developer.orgRole)) throw new ApiError(403, 'FORBIDDEN', STALE);
 }
 function permitted(input: ApiRequest, value: unknown) {
  const data = object(value), body = object(input.body);
  if ('canChange' in data && data['canChange'] !== true) return false;
  if (body['expectedRevision'] !== undefined && body['expectedRevision'] !== data['revision']) return false;
  if (body['expectedVersion'] !== undefined && body['expectedVersion'] !== data['version']) return false;
  if (typeof body['model'] === 'string' && Array.isArray(data['offered']) && !data['offered'].includes(body['model'])) return false;
  return true;
 }
 /** An approval is observed when the product read shows exactly the one that was sent (selection and inputs digest), or none after a withdraw. */
 function approvalObserved(shown: unknown, body: Record<string, unknown>): boolean {
  const sent = body['approval'], now = object(shown);
  if (sent === null) return shown === undefined || shown === null;
  return now['selection'] === object(sent)['selection'] && now['inputsDigest'] === object(sent)['inputsDigest'];
 }
 /** A 4xx that carries an answer is a clear refusal: the server did not change anything. 408 (timeout) and an empty body stay unknown. */
 function definiteRefusal(response: ApiResponse) {
  return response.status >= 400 && response.status < 500 && response.status !== 408 && Object.keys(object(response.body)).length > 0;
 }
 function answer(input: ApiRequest, response: ApiResponse) {
  if (response.status < 200 || response.status >= 300 || response.status === 202) return false;
  const data = object(response.body);
  if (input.path.includes('/product-ai/')) {
   const saved = readProductAi(response.body), before = object(input.body)['expectedRevision'];
   const body = object(input.body), action = input.path.split('/').pop();
   const observed = action === 'key' ? saved.key.connected === (input.method === 'PUT') : action === 'vertex' ? saved.vertex.connected === (input.method === 'PUT') : action === 'eval-budget' ? saved.evalBudget.calls === body['calls'] && saved.evalBudget.costMicros === body['costMicros'] : action === 'eval-approval' ? approvalObserved(saved.evalApproval, body) : true;
   return saved.project === input.path.split('/')[4] && typeof before === 'number' && saved.revision > before && observed;
  }
  if (input.path.includes('/report/features')) {
   const feature = object(data['feature']);
   return typeof feature['id'] === 'string' && /^ft_[a-z0-9]{20}$/u.test(feature['id']) && typeof feature['name'] === 'string' && ['open', 'done'].includes(String(feature['state']));
  }
  if (/\/tasks\/[^/]+\/feature$/u.test(input.path)) return object(data['task'])['taskId'] === input.path.split('/')[4];
  if (input.path.endsWith('/agent-models')) return data['ok'] === true && data['revision'] === Number(object(input.body)['expectedRevision']) + 1;
  if (input.path.endsWith('model-sources-order')) return sourceOrderReceipt.safeParse(response.body).success;
  const saved = object(parse(input.path, response.body)), body = object(input.body);
  if (input.path.endsWith('/engine-model') || input.path.endsWith('/learning-model')) return body['model'] === null ? saved['source'] === 'install' : saved['model'] === body['model'];
  if (input.path.endsWith('/agent-ai')) return saved['source'] === body['source'];
  return Object.keys(saved).length > 0;
 }
 async function request(input: ApiRequest): Promise<ApiResponse> {
  if (input.method === 'GET') {
   // Unknown supplementary live-screen reads retain their own readers and policy.
   const probe = input.path.split('?')[0]!;
   const tracked = probe.startsWith(REPORT_PATH) || /^\/v1\/app\/projects\/[^/]+\/product-ai$/u.test(probe) || ['/v1/app/org/model-sources', '/v1/app/org/agent-models', '/v1/app/org/engine-model', '/v1/app/org/learning-model', '/v1/app/org/agent-ai', '/v1/app/org/settings'].includes(probe);
   if (!tracked) return host.transport.request(input);
   const result = await read(input.path);
   // The exact live readers consume this wire body; only the parsed projection enters the fence.
   return { status: 200, body: result.raw };
  }
  const path = subject(input);
  if (!path || !active()) throw new ApiError(409, 'CHANGE_STALE', STALE);
  const state = fence(path), shown = state.latestRead;
  if (state.taskFailed !== undefined || shown === undefined) throw new ApiError(409, 'CHANGE_STALE', STALE);
  const claim = await withActionClaim(lockKey(path), () => {
   if (globalThis.localStorage.getItem(lockKey(path)) !== null) throw new Error(UNKNOWN);
   // Persist before any async work. Only a non-secret basis and target are stored;
   // keys remain write-only in memory and no uncertain request is ever replayed.
   const body = Object.fromEntries(Object.entries(object(input.body)).filter(([key]) => key !== 'key'));
   const entry = JSON.stringify({ requestId: body['requestId'] ?? crypto.randomUUID(), startedAt: new Date().toISOString(), path, basis: basis(shown.data), request: { method: input.method, path: input.path, body } });
   globalThis.localStorage.setItem(lockKey(path), entry);
   if (globalThis.localStorage.getItem(lockKey(path)) !== entry) throw new Error('Storage unavailable');
   return entry;
  });
  if (claim.kind !== 'done') throw new ApiError(409, 'ACTION_LOCKED', UNKNOWN);
  let sent = false;
  try {
   await identity();
   const current = await read(path);
   if (state.taskFailed !== undefined || state.latestRead?.issued !== current.issued || basis(current.body) !== basis(shown.data) || !permitted(input, current.body)) throw new ApiError(409, 'CHANGE_STALE', STALE);
   await identity();
   if (!active() || state.taskFailed !== undefined || state.latestRead?.issued !== current.issued || globalThis.localStorage.getItem(lockKey(path)) !== claim.value) throw new ApiError(409, 'CHANGE_STALE', STALE);
   sent = true;
   const response = await postWithTimeout(() => host.transport.request({ ...input, retry: 'never' }));
   // A monthly-limit change that needs another admin's approval is answered 202 with `pending` and no settings: nothing was changed and the server says so, so the lock is released and the live handler shows its words.
   if (input.path.endsWith('/org/settings') && response.status === 202 && typeof object(response.body)['pending'] === 'object' && object(response.body)['pending'] !== null && !('settings' in object(response.body))) {
    globalThis.localStorage.removeItem(lockKey(path));
    void client.invalidateQueries({ queryKey: ['company-money-ai-read', context.orgId, context.developerId] });
    return response;
   }
   if (!answer(input, response)) {
    // A refusal is displayed by the exact live handler. Ambiguous statuses keep
    // the lock; a nominal 2xx whose body is unreadable never claims success.
    if (response.status >= 200 && response.status < 300) throw new ApiError(502, 'INVALID_RESPONSE', 'Rovara returned an unreadable response. ' + UNKNOWN);
    const error = object(object(response.body)['error']);
    // A clear refusal (an HTTP 4xx that carries an answer) proves nothing was changed: release the lock so the next deliberate press works.
    // Only an unknown outcome (network error, 5xx, timeout, 408, or a 4xx with no answer) keeps it.
    if (definiteRefusal(response)) globalThis.localStorage.removeItem(lockKey(path));
    if (!input.path.includes('/product-ai/')) return response;
    // The server's own refusal sentence is shown, unless it would repeat the secret that was just submitted.
    const secret = object(input.body)['key'], said = error['message'];
    const echoes = typeof secret === 'string' && secret !== '' && typeof said === 'string' && said.includes(secret);
    const words = definiteRefusal(response) && typeof said === 'string' && said !== '' && !echoes ? said : 'The product AI change was not confirmed. Check its current state.';
    return { status: response.status, body: { error: { code: error['code'], message: words, reason: error['reason'] } } };
   }
   globalThis.localStorage.removeItem(lockKey(path));
   void client.invalidateQueries({ queryKey: ['company-money-ai-read', context.orgId, context.developerId] });
   return response;
  } finally {
   try { if (!sent) globalThis.localStorage.removeItem(lockKey(path)); } finally { claim.release(); changed(); }
  }
 }
 function observed(entry: Record<string, unknown>, value: unknown): boolean {
  const request = object(entry['request']), body = object(request['body']), data = object(value);
  const route = request['path'], method = request['method'];
  if (typeof route !== 'string') return false;
  if (route === `${REPORT_PATH}/features`) return (data['features'] as Array<{ name: string }> | undefined)?.some(feature => feature.name === body['name']) === true;
  if (route.endsWith('/rename')) return object(data['feature'])['name'] === body['name'];
  if (route.endsWith('/state')) return object(data['feature'])['state'] === body['state'];
  if (route.includes('/product-ai/')) {
   if (typeof body['expectedRevision'] !== 'number' || typeof data['revision'] !== 'number' || data['revision'] <= body['expectedRevision']) return false;
   if (route.endsWith('/key')) return object(data['key'])['connected'] === (method === 'PUT');
   if (route.endsWith('/vertex')) return object(data['vertex'])['connected'] === (method === 'PUT');
   if (route.endsWith('/eval-budget')) return object(data['evalBudget'])['calls'] === body['calls'] && object(data['evalBudget'])['costMicros'] === body['costMicros'];
   if (route.endsWith('/eval-approval')) return approvalObserved(data['evalApproval'], body);
  }
  // The company settings (the monthly limit) and who pays: observed when the read shows a newer version holding exactly what was sent.
  if (route.endsWith('/org/settings')) { const sent = object(object(body['settings'])['budgets'])['companyMonthlyUsdMicros']; return typeof data['version'] === 'number' && data['version'] > Number(body['expectedVersion']) && typeof data['monthlyCapUsd'] === 'number' && typeof sent === 'number' && Math.round(data['monthlyCapUsd'] * 1_000_000) === sent; }
  if (route.endsWith('/org/agent-ai')) return typeof data['version'] === 'number' && data['version'] > Number(body['expectedVersion']) && data['source'] === body['source'];
  if (route.endsWith('/engine-model') || route.endsWith('/learning-model')) return body['model'] === null ? data['source'] === 'install' : data['model'] === body['model'];
  if (route.endsWith('/agent-models')) return typeof data['revision'] === 'number' && data['revision'] > Number(body['expectedRevision']) && (data['steps'] as Array<{ stage: string; setting: string | null }> | undefined)?.some(step => step.stage === body['stage'] && step.setting === (body['action'] === 'clear' ? null : body['model'])) === true;
  if (route.endsWith('/model-sources-order')) return typeof data['revision'] === 'number' && data['revision'] > Number(body['expectedRevision']) && JSON.stringify(data['order']) === JSON.stringify(body['order']);
  // A move is observed when the task has left this feature's page (only when the page lists every task, so a truncated list proves nothing).
  if (/\/tasks\/[^/]+\/feature$/u.test(route)) { const tasks = data['tasks'] as Array<{ taskId: string }> | undefined; return Array.isArray(tasks) && data['tasksTotal'] === tasks.length && !tasks.some(task => task.taskId === route.split('/')[4]); }
  // An old revision or unrelated changes are not a receipt. (A merge is observed in check(): the merged feature's own page is gone.)
  return false;
 }
 async function check() {
  for (const key of pending()) {
   try {
    const previous = object(JSON.parse(globalThis.localStorage.getItem(key) ?? '{}'));
    const path = previous['path'];
    if (typeof path !== 'string' || lockKey(path) !== key) continue;
    await identity();
    let current: Awaited<ReturnType<typeof read>> | undefined;
    try { current = await read(path); } catch (failure) {
     // A merge removes the merged feature: its own page answering 404 is the observed outcome.
     if (failure instanceof ApiError && failure.status === 404 && String(object(previous['request'])['path']).endsWith('/merge')) globalThis.localStorage.removeItem(key);
     continue;
    }
    if (observed(previous, current.body)) globalThis.localStorage.removeItem(key);
   } catch { /* keep the unresolved press */ }
  }
  await client.invalidateQueries({ predicate: query => query.queryKey.includes(context.orgId) && query.queryKey.includes(context.developerId) }); changed();
 }
 return { host: { ...host, transport: { request } }, pending, check };
}
