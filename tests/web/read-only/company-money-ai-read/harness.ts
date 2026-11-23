import { createElement as h } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { createQueryClient } from '../../../../packages/ui/src/api/query.js';
import { createMemoryRouter, RouterProvider, Outlet } from 'react-router';
import { renderUi } from '../../support/render.js';
import { AppHostProvider, type ApiRequest, type ApiResponse } from '../../../../packages/ui/src/host.js';
import { ProjectScopeContext, type AdminContext } from '../../../../packages/ui/src/screens/admin/admin-context.js';
import { companyMoneyAiReadRoutes } from '../../../../packages/ui/src/routes/company-money-ai-read-routes.js';
import { ThemeProvider } from '../../../../packages/ui/src/theme.js';
import { AppNavSchema, AppMeResponseSchema } from '@agentx/contracts/web';
import { appRoutes } from '../../../../packages/ui/src/routes.js';
import { fixtureHost, reply, scope } from './fixtures.js';
/** G2_REAL_ROUTES=1 runs every G2 journey through the REAL router (appRoutes + AdminLayout + the shell), the way production mounts the pages (WIRING-1B). */
export const REAL_ROUTES = process.env['G2_REAL_ROUTES'] === '1';
export function mount(path: string, transport: (request: ApiRequest) => Promise<ApiResponse> = async request => reply(request), initial: AdminContext = scope) {
 if (REAL_ROUTES) return mountReal(path, transport, initial);
 const requests: ApiRequest[] = [], client = createQueryClient();
 const host = fixtureHost(async request => { requests.push(request); return transport(request); });
 const router = createMemoryRouter([{ path: '/app/admin', element: h(Outlet), children: companyMoneyAiReadRoutes() }], { initialEntries: [path] });
 const tree = (context: AdminContext) => h(AppHostProvider, { host, children: h(QueryClientProvider, { client }, h(ThemeProvider, { host, children: h(ProjectScopeContext.Provider, { value: context }, h(RouterProvider, { router })) })) });
 const view = renderUi(tree(initial));
 return { client, router, requests, view, setScope: (context: AdminContext) => view.rerender(h('div', { 'data-theme': 'light' }, tree(context))) };
}

/** The same fixtures through the production router. The shell's own identity and nav reads are answered from the scope unless the test's transport answers them first. */
export function mountReal(path: string, transport: (request: ApiRequest) => Promise<ApiResponse> = async request => reply(request), initial: AdminContext = scope) {
 const requests: ApiRequest[] = [], client = createQueryClient();
 let context = initial;
 const identity = () => AppMeResponseSchema.parse({ developer: { id: context.developerId, name: 'Priya', orgRole: context.role }, org: { orgId: context.orgId, name: context.company, plan: 'team' }, identities: [] });
 const nav = () => AppNavSchema.parse({ me: { developerId: context.developerId, name: 'Priya', orgRole: context.role }, org: { name: context.company }, homeCount: 0, projects: [], shared: { agents: [], sessions: [] }, features: { localAgents: false, admin: true, usage: false, chains: false, describe: false, notices: false } });
 const host = fixtureHost(async request => {
  if (request.path === '/v1/app/me' || request.path === '/v1/app/nav') {
   // A transport that fails or garbles EVERYTHING (a 5xx or 202 window, an unreadable body, a throw) is testing the page's own reads, not the shell's identity probe: the shell then sees the scope. A deliberate 401/403/404 and a served identity are passed through.
   const own = { status: 200, body: request.path === '/v1/app/me' ? identity() : nav() };
   try { const answer = await transport(request); return [401, 403, 404].includes(answer.status) || (answer.status === 200 && request.path === '/v1/app/me' && JSON.stringify(answer.body).includes('orgRole')) ? answer : own; } catch { return own; }
  }
  requests.push(request); return transport(request);
 });
 host.viewport = { width: () => 1280, subscribe: () => () => undefined };
 client.setQueryData(['nav'], nav());
 const router = createMemoryRouter(appRoutes(nav().features), { initialEntries: [path] });
 const tree = () => h(AppHostProvider, { host, children: h(QueryClientProvider, { client }, h(ThemeProvider, { host, children: h(RouterProvider, { router }) })) });
 const view = renderUi(tree());
 return { client, router, requests, view, setScope: (next: AdminContext) => { context = next; void client.invalidateQueries({ queryKey: ['admin', 'identity'] }); } };
}
