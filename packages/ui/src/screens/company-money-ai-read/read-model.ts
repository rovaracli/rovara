// G2 owns a GET-only read projection. Existing contracts stay with their owners.
import { useMemo } from 'react';
import { useQueries, useQuery, type UseQueryResult } from '@tanstack/react-query';
import { useSearchParams } from 'react-router';
import { useAppHost } from '../../host.js';
import { createApiClient, type Reader } from '../../api/client.js';
import { accessEndedCode, isAccessEnded, servedReadState } from '../../api/served-read.js';
import { ApiError } from '../../api/errors.js';
import { readCostReport, readFeatureDetail, REPORT_PATH, featurePath, filterQuery, rangeBounds, isRange, ORIGINS, PATHS, type Origin, type TaskPath, type StateFilter, type ReportFilters } from '../../api/admin-report.js';
import { readProductAi, productAiPath } from '../../api/admin-product-ai.js';
import { readAgentModels, AGENT_MODELS_PATH } from '../../api/agent-models.js';
import { modelSourcesSnapshot } from '../admin/models/source-order.js';
import { useAdminContext } from '../admin/admin-context.js';
export const REPORT_HOME = '/app/admin/money/report';
/** The fenced GET-only client and the scope-bound query options shared by one read and by a list of reads. */
function useMoneyAiOptions() {
 const host = useAppHost(), api = useMemo(() => createApiClient({ ...host, transport: { async request(input) {
  const response = await host.transport.request(input);
  if (response.status === 202 && accessEndedCode(response.body) === undefined) throw new ApiError(202, 'READ_UNCONFIRMED', 'The read is not confirmed.');
  return response;
 } } }), [host]);
 const { orgId, developerId, role, checking } = useAdminContext();
 return function options<T>(area: string, path: string, reader: Reader<T>, enabled = true) {
  return { queryKey: ['company-money-ai-read', orgId, developerId, role, area, path],
   queryFn: () => api.get(path, reader, undefined, { retry: 'never' }), enabled: enabled && !checking && (role === 'owner' || role === 'admin'), gcTime: 0, staleTime: 0, retry: false as const, refetchOnMount: 'always' as const };
 };
}
export function useMoneyAiRead<T>(area: string, path: string, reader: Reader<T>, enabled = true) {
 const options = useMoneyAiOptions();
 return useQuery(options(area, path, reader, enabled));
}
/** One read per item (a project row each); every read has the same fence as a single read. */
export function useMoneyAiReads<T>(area: string, items: ReadonlyArray<{ path: string; reader: Reader<T> }>): UseQueryResult<T>[] {
 const options = useMoneyAiOptions();
 return useQueries({ queries: items.map(item => options(area, item.path, item.reader)) });
}
/** Keep the mount fence; the shared policy decides which served facts survive a failed refresh. */
export function freshFacts<T>(read: UseQueryResult<T>): T | undefined {
 return read.isFetchedAfterMount && !read.isPending ? servedReadState(read).data : undefined;
}
export function accessLost(read: UseQueryResult<unknown>): boolean {
 return read.isError && isAccessEnded(read.error);
}
export const reportReader = readCostReport;
export function featureReader(id: string) {
 return { parse(body: unknown) { const data = readFeatureDetail.parse(body); if (id === 'none' ? !data.feature.none : data.feature.id !== id || data.feature.none) throw new Error('Feature scope mismatch'); return data; } };
}
export { REPORT_PATH, featurePath };
/** The project names the company's own report serves (all time); the product-key page lists one row for each. */
export const PROJECTS_PATH = REPORT_PATH + filterQuery({});
export function sourcesReader(orgId: string, developerId: string) {
 return { parse(body: unknown) {
  const data = modelSourcesSnapshot.parse(body);
  if ((data.orgId !== undefined && data.orgId !== orgId) || (data.developerId !== undefined && data.developerId !== developerId)) throw new Error('Source scope mismatch');
  const known = new Set(data.sources.map(source => source.source));
  if (known.size !== data.sources.length || new Set(data.order).size !== data.order.length || data.order.some(source => !known.has(source))) throw new Error('Unreadable source order');
  return data;
 } };
}
export const stepModelsReader = { parse: readAgentModels };
export const STEP_MODELS_PATH = AGENT_MODELS_PATH;
export { productAiPath };
export function productReader(project: string) {
 return { parse(body: unknown) {
  const data = readProductAi(body);
  if (data.project !== project) throw new Error('Project scope mismatch');
  // Only project/provider status metadata enters this group's cache; no key or setup bag.
  const raw = body as Record<string, unknown>;
  const connection = (value: unknown): boolean | null => {
   if (typeof value !== 'object' || value === null || !('connected' in value)) return null;
   return typeof value.connected === 'boolean' ? value.connected : null;
  };
  return { project: data.project, revision: data.revision, evalBudget: data.evalBudget, key: { connected: connection(raw['key']), ...(data.key.refusedAt === undefined ? {} : { refusedAt: data.key.refusedAt }) }, vertex: { connected: connection(raw['vertex']), ...(data.vertex.refusedAt === undefined ? {} : { refusedAt: data.vertex.refusedAt }) } };
 } };
}
/** Preserve the existing report's URL vocabulary, without importing its writer children. */
export function useReadReportFilters() {
 const [params, setParams] = useSearchParams();
 const value = params.get('range'), range = isRange(value) ? value : 'this-month';
 const origin = params.get('origin'), state = params.get('state'), path = params.get('path'), project = params.get('project');
 // One UTC-day boundary per selected filter set keeps query-state/local renders on the same read key.
 const filters = useMemo<ReportFilters>(() => {
  const today = new Date(); today.setUTCHours(0, 0, 0, 0);
  return { ...rangeBounds(range, today), ...(project ? { project } : {}), ...(origin && (ORIGINS as readonly string[]).includes(origin) ? { origin: origin as Origin } : {}), ...(state && ['open', 'merged', 'closed'].includes(state) ? { state: state as StateFilter } : {}), ...(path && (PATHS as readonly string[]).includes(path) ? { path: path as TaskPath } : {}) };
 }, [range, project, origin, state, path]);
 const carry = new URLSearchParams();
 for (const key of ['range', 'project', 'origin', 'state', 'path']) { const current = params.get(key); if (current) carry.set(key, current); }
 function select(key: string, next: string) { const out = new URLSearchParams(params); if (next) out.set(key, next); else out.delete(key); setParams(out); }
 return { range, filters, query: filterQuery(filters), carry: carry.size ? '?' + carry.toString() : '', select };
}
