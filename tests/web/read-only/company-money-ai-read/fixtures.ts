import { readCostReport, readFeatureDetail } from '../../../../packages/ui/src/api/admin-report.js';
import { readProductAi } from '../../../../packages/ui/src/api/admin-product-ai.js';
import { readAgentModels } from '../../../../packages/ui/src/api/agent-models.js';
import { modelSourcesSnapshot } from '../../../../packages/ui/src/screens/admin/models/source-order.js';
import type { ApiRequest, ApiResponse, AppHost } from '../../../../packages/ui/src/host.js';
import type { AdminContext } from '../../../../packages/ui/src/screens/admin/admin-context.js';
export const scope: AdminContext = { orgId: 'org_aaaaaaaaaaaaaaaaaaaa', developerId: 'a'.repeat(64), company: 'Acme', role: 'admin', checking: false };
export const FEATURE = 'ft_aaaaaaaaaaaaaaaaaaaa';
export const numbers = { tasks: 2, prsOpened: 2, prsMerged: 1, costCents: 6123, unpricedCalls: 1, costIsFloor: true, pricedTasks: 1, foreignCurrencyTasks: 0, endToEndMs: 7500000, endToEndSoFar: true };
export const report = readCostReport.parse({ range: {}, asOf: '2026-11-21T15:20:00Z', totals: numbers, projects: ['web'], byFeature: [{ ...numbers, key: FEATURE, name: 'Refunds', state: 'open' }], byProject: [{ ...numbers, key: 'web', name: 'web' }], canChange: true, features: [] });
export const detail = readFeatureDetail.parse({ feature: { id: FEATURE, name: 'Refunds', none: false, state: 'open' }, range: {}, asOf: report.asOf, totals: numbers, sources: [{ source: 'tracker', count: 2 }], tasks: [{ taskId: 'task-1', title: 'Handle duplicate refunds', project: 'web', origin: 'web', state: 'open', startedAt: report.asOf, costCents: 0, costUnavailable: true, unpricedCalls: 0, prsOpened: 0, prsMerged: 0, prLinks: [] }], tasksTotal: 2, unreadableTasks: 1, canChange: true, features: [] });
export const sources = modelSourcesSnapshot.parse({ orgId: scope.orgId, developerId: scope.developerId, revision: 3, canChange: true, order: ['anthropic_key', 'custom_endpoint'], sources: [{ source: 'anthropic_key', available: true, connected: true, inOrder: true }, { source: 'custom_endpoint', available: false, connected: null, inOrder: true }] });
export const models = readAgentModels({ revision: 3, canChange: true, offered: ['fixture-model'], steps: [{ stage: 'build', setting: null, effective: { model: 'fixture-model', companyDefault: true }, refused: false }, { stage: 'plan', setting: null, effective: null, refused: true }] });
// The server always says canChange: true on this read; a body without it is NOT permission (action-host.test.ts proves that).
export const product = { ...readProductAi({ project: 'web', revision: 3, key: { connected: true }, vertex: { connected: false }, evalBudget: { calls: 400, costMicros: 4000000 } }), canChange: true };
export const denied: ApiResponse = { status: 403, body: { error: { code: 'FORBIDDEN', message: 'Fixture refusal' } } };
export const failed: ApiResponse = { status: 503, body: { error: { code: 'UNAVAILABLE', message: 'Fixture unavailable' } } };
export function reply(request: ApiRequest): ApiResponse {
 const path = request.path.split('?')[0];
 if (request.method !== 'GET') throw new Error('G2 attempted a write');
 if (path === '/v1/app/org/report') return { status: 200, body: report };
 if (path === `/v1/app/org/report/features/${FEATURE}`) return { status: 200, body: detail };
 if (path === '/v1/app/org/engine-model' || path === '/v1/app/org/learning-model') return { status: 200, body: { model: 'fixture-model', source: 'company', offered: ['fixture-model'], preselect: 'fixture-model', canChange: true } };
 if (path === '/v1/app/org/settings') return { status: 200, body: { version: 1, settings: { budgets: { companyMonthlyUsdMicros: 500000000 } } } };
 if (path === '/v1/app/org/agent-ai') return { status: 200, body: { version: 1, source: 'anthropic_key', choices: [{ source: 'anthropic_key', available: true }] } };
 if (path === '/v1/app/org/model-sources') return { status: 200, body: sources };
 if (path === '/v1/app/org/agent-models') return { status: 200, body: models };
 if (path === '/v1/app/projects/web/product-ai') return { status: 200, body: product };
 throw new Error('Unallocated fixture read: ' + request.path);
}
export function fixtureHost(transport: (request: ApiRequest) => Promise<ApiResponse>): AppHost {
 const storage = new Map<string, string>();
 return { kind: 'web', origin: 'https://fixture.invalid', transport: { request: transport }, currentPath: () => '/app/admin', setTitle: () => undefined, realtimeToken: () => Promise.reject(new Error('No realtime in read fixtures')), openSocket: () => { throw new Error('No sockets'); }, openExternal: () => undefined, navigate: () => undefined, signIn: () => undefined, signOut: async () => undefined, saveFile: () => undefined, features: { admin: true }, storage: { get: key => storage.get(key), set: (key, value) => { storage.set(key, value); } } };
}
