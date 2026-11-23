// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { moneyAiActionHost } from '../../../../packages/ui/src/screens/company-money-ai-read/action-host.js';
import { createQueryClient } from '../../../../packages/ui/src/api/query.js';
import { fixtureHost, scope, report, detail, FEATURE, product, sources, models } from './fixtures.js';
import type { ApiRequest, ApiResponse } from '../../../../packages/ui/src/host.js';
import '../../support/render.js'; // installs the faithful exclusive Web Locks shim
const F2 = 'ft_bbbbbbbbbbbbbbbbbbbb', taskId = 'task-1';
const me = { developer: { id: scope.developerId, name: 'Priya', orgRole: 'admin' }, org: { orgId: scope.orgId, name: 'Acme', plan: 'team' }, identities: [] };
const feature = { id: FEATURE, name: 'Refund receipts', state: 'open' };
const model = { model: 'fixture-model', source: 'company', offered: ['fixture-model', 'other-model'], preselect: 'fixture-model', canChange: true };
type Case = { name: string; read: string; snapshot: unknown; input: ApiRequest; answer: unknown; /** The read carries no canChange (company settings, agent AI): the company-admin role from /v1/app/me before every press is the authority the page can check; the server stays the real one. */ roleOnly?: boolean };
const settingsSnapshot = { version: 1, settings: { budgets: { companyMonthlyUsdMicros: 500_000_000 } } };
const agentAiSnapshot = { version: 1, source: 'anthropic_key', choices: [{ source: 'anthropic_key', available: true }, { source: 'rovara', available: true }] };
const base = '/v1/app/org/report', productPath = '/v1/app/projects/web/product-ai';
const APPROVAL = { selection: 'refund-summary', inputsDigest: 'a'.repeat(64), maxCalls: 10, maxCostMicros: 1000000 };
const cases: Case[] = [
 { name: 'New feature', read: base, snapshot: report, input: { method: 'POST', path: `${base}/features`, body: { name: 'Refund receipts' } }, answer: { feature } },
 ...(['rename', 'merge', 'state', 'reopen'] as const).map(action => ({ name: action, read: `${base}/features/${FEATURE}`, snapshot: action === 'reopen' ? { ...detail, feature: { ...detail.feature, state: 'done' } } : detail, input: { method: 'POST' as const, path: `${base}/features/${FEATURE}/${action === 'reopen' ? 'state' : action}`, body: action === 'rename' ? { name: 'Refund receipts' } : action === 'merge' ? { into: F2 } : { state: action === 'state' ? 'done' : 'open' } }, answer: { feature } })),
 { name: 'Move to feature', read: `${base}/features/${FEATURE}`, snapshot: detail, input: { method: 'POST', path: `/v1/app/tasks/${taskId}/feature`, body: { feature: F2 } }, answer: { task: { taskId, feature: { id: F2 } } } },
 { name: 'Company model', read: '/v1/app/org/engine-model', snapshot: model, input: { method: 'PUT', path: '/v1/app/org/engine-model', body: { model: 'other-model' } }, answer: { ...model, model: 'other-model' } },
 { name: 'Learning model', read: '/v1/app/org/learning-model', snapshot: model, input: { method: 'PUT', path: '/v1/app/org/learning-model', body: { model: 'other-model' } }, answer: { ...model, model: 'other-model' } },
 { name: 'Step model', read: '/v1/app/org/agent-models', snapshot: models, input: { method: 'POST', path: '/v1/app/org/agent-models', body: { action: 'set', stage: 'build', model: 'fixture-model', expectedRevision: 3 } }, answer: { ok: true, revision: 4 } },
 { name: 'Change source order', read: '/v1/app/org/model-sources', snapshot: sources, input: { method: 'PUT', path: '/v1/app/org/model-sources-order', body: { requestId: 'c49e20e8-c9d8-49b2-9a63-01d5a3edea96', expectedOrgId: scope.orgId, expectedDeveloperId: scope.developerId, expectedRevision: 3, order: ['custom_endpoint', 'anthropic_key'] } }, answer: { revision: 4, order: ['custom_endpoint', 'anthropic_key'] } },
 // Approve / Withdraw of the approved eval spend (the live page's section): same path, same body, same observation.
 { name: 'approve eval spend', read: productPath, snapshot: product, input: { method: 'PUT', path: `${productPath}/eval-approval`, body: { requestId: 'c49e20e8-c9d8-49b2-9a63-01d5a3edea96', expectedRevision: 3, approval: APPROVAL } }, answer: { ...product, revision: 4, evalApproval: { ...APPROVAL, approvedAt: 1, approvedByYou: true, state: 'current' } } },
 { name: 'withdraw approval', read: productPath, snapshot: { ...product, evalApproval: { ...APPROVAL, approvedAt: 1, approvedByYou: true, state: 'current' } }, input: { method: 'PUT', path: `${productPath}/eval-approval`, body: { requestId: 'c49e20e8-c9d8-49b2-9a63-01d5a3edea96', expectedRevision: 3, approval: null } }, answer: { ...product, revision: 4 } },
 // WIRING-1 restore: the monthly limit and who pays, saved by the setup step's own Save through this same fence.
 { name: 'Monthly limit', read: '/v1/app/org/settings', snapshot: settingsSnapshot, roleOnly: true, input: { method: 'PUT', path: '/v1/app/org/settings', body: { expectedVersion: 1, settings: { budgets: { companyMonthlyUsdMicros: 600_000_000 } } } }, answer: { version: 2, settings: { budgets: { companyMonthlyUsdMicros: 600_000_000 } } } },
 { name: 'Who pays', read: '/v1/app/org/agent-ai', snapshot: agentAiSnapshot, roleOnly: true, input: { method: 'PUT', path: '/v1/app/org/agent-ai', body: { expectedVersion: 1, source: 'rovara' } }, answer: { ...agentAiSnapshot, version: 2, source: 'rovara' } },
 ...(['connect key', 'replace key', 'remove key', 'connect Vertex', 'remove Vertex', 'save eval budget'] as const).map(name => {
  const key = name.includes('key'), vertex = name.includes('Vertex'), remove = name.startsWith('remove');
  const body = { requestId: 'c49e20e8-c9d8-49b2-9a63-01d5a3edea96', expectedRevision: 3, ...(remove ? {} : key ? { key: 'fixture-private-marker' } : vertex ? { projectId: 'acme-evals', location: 'us-central1', audience: '//iam.googleapis.com/projects/123456789/locations/global/workloadIdentityPools/rovara-pool/providers/rovara-aws', serviceAccount: null } : { calls: 10, costMicros: 1000000 }) };
  return { name, read: productPath, snapshot: product, input: { method: remove ? 'DELETE' as const : 'PUT' as const, path: `${productPath}/${key ? 'key' : vertex ? 'vertex' : 'eval-budget'}`, body }, answer: { ...product, revision: 4, key: { connected: key ? !remove : true }, vertex: { connected: vertex && !remove }, evalBudget: { calls: 10, costMicros: 1000000 } } };
 }),
];
function fixture(c: Case, change?: (input: ApiRequest) => ApiResponse | undefined) {
 const sent: ApiRequest[] = [], client = createQueryClient(); let live = true;
 const host = fixtureHost(async input => {
  if (input.method !== 'GET') sent.push(input); const override = change?.(input);
  return override ?? { status: 200, body: input.path === '/v1/app/me' ? me : input.method === 'GET' ? c.snapshot : c.answer };
 });
 const actions = moneyAiActionHost(host, client, scope, () => live, () => undefined);
 return { ...actions, raw: host, sent, client, end: () => { live = false; } };
}
beforeEach(() => localStorage.clear());
describe.each(cases)('$name action + authority', c => {
 it('allowed: exact method, ids and body, exactly one send', async () => {
  const f = fixture(c); await f.host.transport.request({ method: 'GET', path: c.read });
  await f.host.transport.request(c.input); expect(f.sent).toEqual([{ ...c.input, retry: 'never' }]);
  expect(JSON.stringify(localStorage)).not.toContain('fixture-private-marker');
 });
 it.each(['refused', 'stale', 'no-permission', 'identity', 'ended'] as const)('%s: zero sends', async kind => {
  let changed = false;
  const f = fixture(c, input => {
   if (!changed) return undefined;
   // A read with no canChange: the person's role is the check, so "no permission" is a member role at the press.
   if (input.path === '/v1/app/me' && kind === 'no-permission' && c.roleOnly === true) return { status: 200, body: { ...me, developer: { ...me.developer, orgRole: 'member' } } };
   if (input.path === '/v1/app/me' && kind === 'identity') return { status: 200, body: { ...me, org: { ...me.org, orgId: 'org_bbbbbbbbbbbbbbbbbbbb' } } };
   if (input.path === c.read) return kind === 'refused' ? { status: 403, body: { error: { code: 'FORBIDDEN', message: 'Refused' } } } : kind === 'stale' ? { status: 200, body: { ...c.snapshot as object, canChange: true, revision: 99, feature: { ...feature, name: 'Changed' }, model: 'other-model', version: 99, features: [{ id: F2, name: 'Other' }] } } : kind === 'no-permission' ? { status: 200, body: { ...c.snapshot as object, canChange: false } } : undefined;
   return undefined;
  });
  await f.host.transport.request({ method: 'GET', path: c.read }); changed = true; if (kind === 'ended') f.end();
  await expect(f.host.transport.request(c.input)).rejects.toThrow(); expect(f.sent).toEqual([]);
 });
 it.skipIf(c.roleOnly === true)('an initially refused snapshot cannot authorize a send', async () => {
  const denied = { ...c, snapshot: { ...c.snapshot as object, canChange: false } };
  const f = fixture(denied); await f.host.transport.request({ method: 'GET', path: c.read });
  await expect(f.host.transport.request(c.input)).rejects.toThrow(); expect(f.sent).toEqual([]);
 });
 it('unknown result locks through a new host and Check never repeats the send', async () => {
  const f = fixture(c, input => input.method !== 'GET' ? { status: 503, body: {} } : undefined);
  await f.host.transport.request({ method: 'GET', path: c.read }); await f.host.transport.request(c.input);
  const next = moneyAiActionHost(f.host, createQueryClient(), scope, () => true, () => undefined);
  await next.host.transport.request({ method: 'GET', path: c.read });
  await expect(next.host.transport.request(c.input)).rejects.toThrow(); await next.check(); expect(f.sent).toHaveLength(1);
 });
});

it.each(['Monthly limit', 'Who pays'])('%s: a member role at the first press sends nothing', async name => {
 const c = cases.find(item => item.name === name)!;
 const f = fixture(c, input => input.path === '/v1/app/me' ? { status: 200, body: { ...me, developer: { ...me.developer, orgRole: 'member' } } } : undefined);
 await f.host.transport.request({ method: 'GET', path: c.read });
 await expect(f.host.transport.request(c.input)).rejects.toThrow(); expect(f.sent).toEqual([]);
});
it('a monthly limit that waits for another admin (202 + pending, no settings) releases the lock and sends once; any other 202 stays locked', async () => {
 const c = cases.find(item => item.name === 'Monthly limit')!;
 const pending = fixture(c, input => input.method !== 'GET' ? { status: 202, body: { companyId: 'c', version: 1, pending: { id: 'p1' } } } : undefined);
 await pending.host.transport.request({ method: 'GET', path: c.read });
 expect((await pending.host.transport.request(c.input)).status).toBe(202); expect(pending.pending()).toHaveLength(0);
 await new Promise(resolve => setTimeout(resolve, 5)); // the claim releases on a later tick
 await pending.host.transport.request(c.input); expect(pending.sent).toHaveLength(2);
 for (const body of [{ companyId: 'c', version: 2, settings: {} }, {}, { pending: true }]) {
  localStorage.clear();
  const other = fixture(c, input => input.method !== 'GET' ? { status: 202, body } : undefined);
  await other.host.transport.request({ method: 'GET', path: c.read });
  await expect(other.host.transport.request(c.input)).rejects.toThrow(); expect(other.pending()).toHaveLength(1); expect(other.sent).toHaveLength(1);
 }
});
it('a failed latest read fences an older success even when the transport recovers', async () => {
 const c = cases[0]!; let bad = false;
 const f = fixture(c, input => bad && input.path === c.read ? { status: 503, body: {} } : undefined);
 await f.host.transport.request({ method: 'GET', path: c.read }); bad = true;
 await expect(f.host.transport.request({ method: 'GET', path: c.read })).rejects.toThrow(); bad = false;
 await expect(f.host.transport.request(c.input)).rejects.toThrow(); expect(f.sent).toEqual([]);
});
it.each(['revision', 'version', 'offered'] as const)('rejects an invalid %s at the unchanged snapshot', async kind => {
 const original = cases.find(c => c.name === (kind === 'offered' ? 'Company model' : 'Step model'))!;
 const c = { ...original, input: { ...original.input, body: { ...original.input.body as object, ...(kind === 'offered' ? { model: 'not-offered' } : kind === 'revision' ? { expectedRevision: 99 } : { expectedVersion: 99 }) } } };
 const f = fixture(c); await f.host.transport.request({ method: 'GET', path: c.read });
 await expect(f.host.transport.request(c.input)).rejects.toThrow(); expect(f.sent).toEqual([]);
});
it('two concurrent presses send exactly once', async () => {
 const c = cases[0]!; let finish!: (r: ApiResponse) => void;
 const wait = new Promise<ApiResponse>(resolve => { finish = resolve; });
 const sent: ApiRequest[] = [];
 const host = fixtureHost(async input => { if (input.method !== 'GET') { sent.push(input); return wait; } return { status: 200, body: input.path === '/v1/app/me' ? me : c.snapshot }; });
 const f = moneyAiActionHost(host, createQueryClient(), scope, () => true, () => undefined);
 await f.host.transport.request({ method: 'GET', path: c.read });
 const first = f.host.transport.request(c.input); await expect(f.host.transport.request(c.input)).rejects.toThrow();
 while (sent.length === 0) await new Promise(resolve => setTimeout(resolve, 1));
 finish({ status: 200, body: c.answer }); await first; expect(sent).toHaveLength(1);
});
it.each([202, 200] as const)('unconfirmed %s answers cannot unlock a press', async status => {
 const c = cases[0]!, f = fixture(c, input => input.method !== 'GET' ? { status, body: status === 202 ? c.answer : {} } : undefined);
 await f.host.transport.request({ method: 'GET', path: c.read }); await expect(f.host.transport.request(c.input)).rejects.toThrow();
 await expect(f.host.transport.request(c.input)).rejects.toThrow(); expect(f.sent).toHaveLength(1);
});
it('an unchanged Check never unlocks the pending press', async () => {
 const c = cases[0]!, f = fixture(c, input => input.method !== 'GET' ? { status: 503, body: {} } : undefined);
 await f.host.transport.request({ method: 'GET', path: c.read }); await f.host.transport.request(c.input); await f.check();
 await expect(f.host.transport.request(c.input)).rejects.toThrow(); expect(f.sent).toHaveLength(1);
});
it('product refusals do not echo submitted material', async () => {
 const c = cases.find(item => item.name === 'connect key')!, f = fixture(c, input => input.method !== 'GET' ? { status: 403, body: { error: { code: 'FORBIDDEN', message: 'fixture-private-marker' } } } : undefined);
 await f.host.transport.request({ method: 'GET', path: c.read }); const answer = await f.host.transport.request(c.input);
 expect(JSON.stringify(answer)).not.toContain('fixture-private-marker');
});

it('silent storage failure refuses before a send', async () => {
 const c = cases[0]!, f = fixture(c); await f.host.transport.request({ method: 'GET', path: c.read });
 const descriptor = Object.getOwnPropertyDescriptor(Storage.prototype, 'setItem')!;
 Object.defineProperty(Storage.prototype, 'setItem', { ...descriptor, value: () => undefined });
 try { await expect(f.host.transport.request(c.input)).rejects.toThrow(); expect(f.sent).toEqual([]); } finally { Object.defineProperty(Storage.prototype, 'setItem', descriptor); }
});
it('an unknown key press never persists the typed secret', async () => {
 const c = cases.find(item => item.name === 'connect key')!, f = fixture(c, input => input.method !== 'GET' ? { status: 503, body: {} } : undefined);
 await f.host.transport.request({ method: 'GET', path: c.read }); await f.host.transport.request(c.input);
 expect(f.pending()).toHaveLength(1); expect(JSON.stringify(localStorage)).not.toContain('fixture-private-marker');
});
it('a successful answer with a contradictory key state stays unknown', async () => {
 const c = cases.find(item => item.name === 'connect key')!, f = fixture(c, input => input.method !== 'GET' ? { status: 200, body: { ...product, revision: 4, key: { connected: false } } } : undefined);
 await f.host.transport.request({ method: 'GET', path: c.read }); await expect(f.host.transport.request(c.input)).rejects.toThrow(); expect(f.pending()).toHaveLength(1);
});
it.each(['person', 'role'] as const)('a changed identity %s refuses the send', async kind => {
 const c = cases[0]!, f = fixture(c, input => input.path === '/v1/app/me' ? { status: 200, body: { ...me, developer: { ...me.developer, ...(kind === 'person' ? { id: 'b'.repeat(64) } : { orgRole: 'member' }) } } } : undefined);
 await f.host.transport.request({ method: 'GET', path: c.read }); await expect(f.host.transport.request(c.input)).rejects.toThrow(); expect(f.sent).toEqual([]);
});
it('a newer read during the final identity check invalidates the proposal', async () => {
 const c = cases[0]!; let identities = 0, finish!: (r: ApiResponse) => void;
 const wait = new Promise<ApiResponse>(resolve => { finish = resolve; });
 const sent: ApiRequest[] = [];
 const host = fixtureHost(async input => { if (input.method !== 'GET') sent.push(input); if (input.path === '/v1/app/me' && ++identities === 2) return wait; return { status: 200, body: input.path === '/v1/app/me' ? me : input.method === 'GET' ? c.snapshot : c.answer }; });
 const f = moneyAiActionHost(host, createQueryClient(), scope, () => true, () => undefined);
 await f.host.transport.request({ method: 'GET', path: c.read }); const press = f.host.transport.request(c.input);
 while (identities < 2) await new Promise(resolve => setTimeout(resolve, 1));
 await f.host.transport.request({ method: 'GET', path: c.read }); finish({ status: 200, body: me });
 await expect(press).rejects.toThrow(); expect(sent).toEqual([]);
});
it.each(['feature', 'project'] as const)('a mismatched %s never enters the read fence', async kind => {
 const c = cases.find(item => item.name === (kind === 'feature' ? 'rename' : 'connect key'))!;
 const f = fixture(c, () => ({ status: 200, body: kind === 'feature' ? { ...detail, feature: { ...detail.feature, id: F2 } } : { ...product, project: 'other' } }));
 await expect(f.host.transport.request({ method: 'GET', path: c.read })).rejects.toThrow(); expect(f.sent).toEqual([]);
});
it('a parsing 202 read supplies no authority', async () => {
 const c = cases[0]!, f = fixture(c, () => ({ status: 202, body: c.snapshot }));
 await expect(f.host.transport.request({ method: 'GET', path: c.read })).rejects.toThrow();
 await expect(f.host.transport.request(c.input)).rejects.toThrow(); expect(f.sent).toEqual([]);
});
it('a documented report refusal allows another deliberate press', async () => {
 const c = cases[0]!, f = fixture(c, input => input.method !== 'GET' ? { status: 400, body: { error: { code: 'CONFIG_INVALID', message: 'A feature with that name already exists.' } } } : undefined);
 await f.host.transport.request({ method: 'GET', path: c.read });
 await f.host.transport.request(c.input); await new Promise(resolve => setTimeout(resolve, 0)); await f.host.transport.request(c.input); expect(f.sent).toHaveLength(2);
});
it('changing report filters cannot evade an unknown action lock', async () => {
 const c = cases[0]!, f = fixture(c, input => input.method !== 'GET' ? { status: 503, body: {} } : undefined);
 await f.host.transport.request({ method: 'GET', path: c.read + '?project=web' }); await f.host.transport.request(c.input);
 await f.host.transport.request({ method: 'GET', path: c.read + '?range=all' });
 await expect(f.host.transport.request(c.input)).rejects.toThrow(); expect(f.sent).toHaveLength(1);
});
it('unrelated changes do not resolve an unknown create, but the observed feature does', async () => {
 const c = cases[0]!; let features: Array<{ id: string; name: string }> = [];
 const f = fixture(c, input => input.method !== 'GET' ? { status: 503, body: {} } : input.path === '/v1/app/me' ? undefined : { status: 200, body: { ...report, features } });
 await f.host.transport.request({ method: 'GET', path: c.read }); await f.host.transport.request(c.input);
 features = [{ id: F2, name: 'Unrelated feature' }]; await f.check(); expect(f.pending()).toHaveLength(1);
 features = [{ id: F2, name: 'Refund receipts' }]; await f.check(); expect(f.pending()).toHaveLength(0); expect(f.sent).toHaveLength(1);
});
it('a same-revision key read cannot resolve the pending replacement', async () => {
 const c = cases.find(item => item.name === 'replace key')!, f = fixture(c, input => input.method !== 'GET' ? { status: 503, body: {} } : undefined);
 await f.host.transport.request({ method: 'GET', path: c.read }); await f.host.transport.request(c.input); await f.check(); expect(f.pending()).toHaveLength(1);
});

describe.each(cases.filter(c => !['merge', 'Move to feature'].includes(c.name)))('$name observation', c => {
 it('a matching fresh read resolves uncertainty without another send', async () => {
  let recovered = false;
  const body = c.input.body as Record<string, unknown>;
  const f = fixture(c, input => {
   if (input.method !== 'GET') return { status: 503, body: {} };
   if (!recovered || input.path === '/v1/app/me') return undefined;
   const snapshot = c.snapshot as Record<string, unknown>;
   const result = c.name === 'New feature' ? { ...snapshot, features: [{ id: F2, name: 'Refund receipts' }] }
    : ['rename', 'state', 'reopen'].includes(c.name) ? { ...snapshot, feature: { ...snapshot['feature'] as object, ...feature, ...(c.name === 'rename' ? { name: body['name'] } : { state: body['state'] }) } }
    : c.name === 'Step model' ? { ...snapshot, revision: 4, steps: [{ stage: 'build', setting: 'fixture-model', effective: { model: 'fixture-model', companyDefault: false }, refused: false }] }
    : c.name === 'Change source order' ? { ...snapshot, revision: 4, order: body['order'] }
    : c.answer;
   return { status: 200, body: result };
  });
  await f.host.transport.request({ method: 'GET', path: c.read }); await f.host.transport.request(c.input);
  recovered = true; await f.check(); expect(f.pending()).toHaveLength(0); expect(f.sent).toHaveLength(1);
 });
});

it('a pending record removed during preflight prevents the send', async () => {
 const c = cases[0]!; let identities = 0, finish!: (r: ApiResponse) => void;
 const wait = new Promise<ApiResponse>(resolve => { finish = resolve; }); const sent: ApiRequest[] = [];
 const host = fixtureHost(async input => { if (input.method !== 'GET') sent.push(input); if (input.path === '/v1/app/me' && ++identities === 2) return wait; return { status: 200, body: input.path === '/v1/app/me' ? me : input.method === 'GET' ? c.snapshot : c.answer }; });
 const f = moneyAiActionHost(host, createQueryClient(), scope, () => true, () => undefined);
 await f.host.transport.request({ method: 'GET', path: c.read }); const press = f.host.transport.request(c.input);
 while (identities < 2) await new Promise(resolve => setTimeout(resolve, 1));
 for (const key of f.pending()) localStorage.removeItem(key);
 finish({ status: 200, body: me }); await expect(press).rejects.toThrow(); expect(sent).toEqual([]);
});

describe.each(cases.filter(c => !['merge', 'Move to feature'].includes(c.name)))('$name unresolved observation', c => {
 it('a newer but different state cannot resolve the press', async () => {
  let checking = false;
  const f = fixture(c, input => {
   if (input.method !== 'GET') return { status: 503, body: {} };
   if (!checking || input.path === '/v1/app/me') return undefined;
   const snapshot = c.snapshot as Record<string, unknown>;
   const wrong = c.input.path.endsWith('/key') ? { key: { connected: c.input.method !== 'PUT' } } : c.input.path.endsWith('/vertex') ? { vertex: { connected: c.input.method !== 'PUT' } } : {};
   return { status: 200, body: { ...snapshot, revision: 99, ...wrong } };
  });
  await f.host.transport.request({ method: 'GET', path: c.read }); await f.host.transport.request(c.input); checking = true; await f.check();
  expect(f.pending()).toHaveLength(1); expect(f.sent).toHaveLength(1);
 });
});

// F1 (lead 4 Opus, d2baa4058): a clear server refusal must not lock an action forever; only an unknown outcome keeps the lock.
const REFUSALS = [
 { name: 'Vertex', case: 'connect Vertex', status: 422, code: 'REFUSED', text: 'Google did not accept this Workload identity provider.' },
 { name: 'eval budget', case: 'save eval budget', status: 400, code: 'CONFIG_INVALID', text: 'The eval budget must be a whole number of calls.' },
 { name: 'key', case: 'connect key', status: 403, code: 'FORBIDDEN', text: 'Only a company admin or the project administrator can change this.' },
 { name: 'company model', case: 'Company model', status: 403, code: 'FORBIDDEN', text: 'Only a company owner or admin can change the model.' },
 { name: 'step model needing a second admin', case: 'Step model', status: 403, code: 'SECOND_PERSON_REQUIRED', text: 'Another admin must approve this change.' },
  { name: 'eval approval', case: 'approve eval spend', status: 403, code: 'FORBIDDEN', text: 'Only the project administrator or a company admin can approve eval spend.' },
] as const;
describe.each(REFUSALS)('a clear refusal of $name', r => {
 const c = cases.find(item => item.name === r.case)!;
 const refuse = (input: ApiRequest): ApiResponse | undefined => input.method !== 'GET' ? { status: r.status, body: { error: { code: r.code, message: r.text, reason: 'fixture-reason' } } } : undefined;
 it('shows the server refusal text and lets the very next press (even after a reload) work', async () => {
  let refusing = true;
  const f = fixture(c, input => refusing ? refuse(input) : undefined);
  await f.host.transport.request({ method: 'GET', path: c.read });
  const first = await f.host.transport.request(c.input);
  expect(first.status).toBe(r.status);
  expect((first.body as { error: { message: string; code: string } }).error).toMatchObject({ code: r.code, message: r.text });
  expect(f.pending()).toHaveLength(0);
  // A reload: a new host in the same browser takes a fresh read and a second deliberate press.
  refusing = false;
  const next = moneyAiActionHost(f.raw, createQueryClient(), scope, () => true, () => undefined);
  await next.host.transport.request({ method: 'GET', path: c.read });
  const second = await next.host.transport.request(c.input);
  expect(second.status).toBe(200); expect(f.sent).toHaveLength(2); expect(next.pending()).toHaveLength(0);
 });
});
it('a refusal never echoes a submitted key, even in the server words', async () => {
 const c = cases.find(item => item.name === 'connect key')!, f = fixture(c, input => input.method !== 'GET' ? { status: 403, body: { error: { code: 'FORBIDDEN', message: 'The key fixture-private-marker was refused.' } } } : undefined);
 await f.host.transport.request({ method: 'GET', path: c.read }); const answer = await f.host.transport.request(c.input);
 expect(JSON.stringify(answer)).not.toContain('fixture-private-marker'); expect(f.pending()).toHaveLength(0);
});
describe.each([
 ['a 5xx answer', () => ({ status: 503, body: { error: { code: 'UNAVAILABLE', message: 'Fixture unavailable' } } })],
 ['a 408 timeout', () => ({ status: 408, body: { error: { code: 'TIMEOUT', message: 'Fixture timeout' } } })],
 ['a 4xx with no body', () => ({ status: 403, body: {} })],
 ['a network error', () => { throw new Error('network down'); }],
] as const)('%s keeps the lock', (_name, answer) => {
 it.each(['connect Vertex', 'save eval budget', 'Company model', 'Step model', 'Change source order'])('%s stays locked', async name => {
  const c = cases.find(item => item.name === name)!;
  const f = fixture(c, input => input.method !== 'GET' ? answer() : undefined);
  await f.host.transport.request({ method: 'GET', path: c.read });
  await f.host.transport.request(c.input).catch(() => undefined);
  expect(f.pending()).toHaveLength(1);
  const next = moneyAiActionHost(f.raw, createQueryClient(), scope, () => true, () => undefined);
  await next.host.transport.request({ method: 'GET', path: c.read });
  await expect(next.host.transport.request(c.input)).rejects.toThrow(); expect(f.sent).toHaveLength(1);
 });
});
it('a product read with no canChange is NOT permission: zero sends', async () => {
 const c = cases.find(item => item.name === 'connect key')!, bare: Record<string, unknown> = { ...product }; delete bare['canChange'];
 const f = fixture({ ...c, snapshot: bare }); await f.host.transport.request({ method: 'GET', path: c.read });
 await expect(f.host.transport.request(c.input)).rejects.toThrow(); expect(f.sent).toEqual([]);
});
it('an unknown merge clears when the merged feature page is gone (404)', async () => {
 const c = cases.find(item => item.name === 'merge')!; let gone = false, down = false;
 const f = fixture(c, input => input.method !== 'GET' ? { status: 503, body: {} } : down && input.path === c.read ? { status: 503, body: { error: { code: 'UNAVAILABLE', message: 'Down.' } } } : gone && input.path === c.read ? { status: 404, body: { error: { code: 'NOT_FOUND', message: 'No such feature.' } } } : undefined);
 await f.host.transport.request({ method: 'GET', path: c.read }); await f.host.transport.request(c.input);
 await f.check(); expect(f.pending()).toHaveLength(1);
 down = true; await f.check(); expect(f.pending()).toHaveLength(1);
 down = false; gone = true; await f.check(); expect(f.pending()).toHaveLength(0); expect(f.sent).toHaveLength(1);
});
it('an unknown move clears only when the task has left the (complete) feature page', async () => {
 const c = cases.find(item => item.name === 'Move to feature')!; let tasks: unknown = (detail as { tasks: unknown[] }).tasks, total: number = detail.tasksTotal;
 const f = fixture(c, input => input.method !== 'GET' ? { status: 503, body: {} } : input.path === c.read ? { status: 200, body: { ...detail, tasks, tasksTotal: total } } : undefined);
 await f.host.transport.request({ method: 'GET', path: c.read }); await f.host.transport.request(c.input);
 await f.check(); expect(f.pending()).toHaveLength(1);
 tasks = []; total = 2; await f.check(); expect(f.pending()).toHaveLength(1);
 total = 0; await f.check(); expect(f.pending()).toHaveLength(0); expect(f.sent).toHaveLength(1);
});
it.each(['missing', 'other digest', 'other selection'] as const)('an approve answer showing %s stays unknown', async kind => {
 const c = cases.find(item => item.name === 'approve eval spend')!;
 const shown = kind === 'missing' ? undefined : { ...APPROVAL, approvedAt: 1, approvedByYou: true, state: 'current', ...(kind === 'other digest' ? { inputsDigest: 'c'.repeat(64) } : { selection: 'other-selection' }) };
 const f = fixture(c, input => input.method !== 'GET' ? { status: 200, body: { ...product, revision: 4, ...(shown === undefined ? {} : { evalApproval: shown }) } } : undefined);
 await f.host.transport.request({ method: 'GET', path: c.read }); await expect(f.host.transport.request(c.input)).rejects.toThrow(); expect(f.pending()).toHaveLength(1);
});
it('an unknown approve is not resolved by a read that shows the same selection with another digest', async () => {
 const c = cases.find(item => item.name === 'approve eval spend')!; let checking = false;
 const f = fixture(c, input => input.method !== 'GET' ? { status: 503, body: {} } : checking && input.path === c.read ? { status: 200, body: { ...product, revision: 4, evalApproval: { ...APPROVAL, inputsDigest: 'c'.repeat(64), approvedAt: 1, approvedByYou: true, state: 'current' } } } : undefined);
 await f.host.transport.request({ method: 'GET', path: c.read }); await f.host.transport.request(c.input); checking = true; await f.check();
 expect(f.pending()).toHaveLength(1);
});

// Review tests (lead 4 Opus, d960b6ed9): each part of the monthly-limit / who-pays observation and of the pending-202 release is pinned on its own.
describe('Monthly limit and who pays: Check resolves only a newer version holding exactly what was sent', () => {
 const unresolved = (name: 'Monthly limit' | 'Who pays', read: unknown) => async () => {
  const c = cases.find(item => item.name === name)!; let checking = false;
  const f = fixture(c, input => input.method !== 'GET' ? { status: 503, body: {} } : checking && input.path === c.read ? { status: 200, body: read } : undefined);
  await f.host.transport.request({ method: 'GET', path: c.read }); await f.host.transport.request(c.input);
  checking = true; await f.check(); expect(f.pending()).toHaveLength(1); expect(f.sent).toHaveLength(1);
 };
 it('limit: a newer version holding a different limit (someone else\'s change) keeps the press locked', unresolved('Monthly limit', { version: 2, settings: { budgets: { companyMonthlyUsdMicros: 700_000_000 } } }));
 it('limit: the sent limit at the version that was read (not newer) keeps the press locked', unresolved('Monthly limit', { version: 1, settings: { budgets: { companyMonthlyUsdMicros: 600_000_000 } } }));
 it('who pays: a newer version with another source keeps the press locked', unresolved('Who pays', { ...agentAiSnapshot, version: 2, source: 'anthropic_key' }));
 it('who pays: the sent source at the version that was read (not newer) keeps the press locked', unresolved('Who pays', { ...agentAiSnapshot, version: 1, source: 'rovara' }));
});
it('a 202 that carries settings beside pending is not the "waits for another admin" answer: it stays locked', async () => {
 const c = cases.find(item => item.name === 'Monthly limit')!;
 const f = fixture(c, input => input.method !== 'GET' ? { status: 202, body: { companyId: 'c', version: 2, pending: { id: 'p1' }, settings: { budgets: { companyMonthlyUsdMicros: 600_000_000 } } } } : undefined);
 await f.host.transport.request({ method: 'GET', path: c.read });
 await expect(f.host.transport.request(c.input)).rejects.toThrow(); expect(f.pending()).toHaveLength(1); expect(f.sent).toHaveLength(1);
});
