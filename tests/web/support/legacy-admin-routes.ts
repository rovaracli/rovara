import type { RouteObject } from 'react-router';
import { createElement as h } from 'react';
import { appRoutes as liveRoutes } from '../../../packages/ui/src/routes.js';
import { PageHeader } from '../../../packages/ui/src/design/PageHeader.js';
import { AiSpendStep } from '../../../packages/ui/src/screens/setup/AiSpendStep.js';
import { useAdminContext } from '../../../packages/ui/src/screens/admin/AdminLayout.js';
/**
 * LEGACY HARNESS (WIRING-1B). In production the rebuilt company money / AI pages (G2) own /app/admin/money/report, .../features/:id, /ai-spending and /product-ai.
 * The pinned tests below were written against the screens those routes showed before; they exercise those screens' own components and handlers, which stay in the
 * source tree. This helper puts the old screens back at the same addresses FOR THOSE TESTS ONLY, so they keep proving the old components. It is never imported by
 * production code, and tests/web/company-money-ai-mount.test.ts proves the real router does not mount them.
 */
type Leaf = NonNullable<RouteObject['lazy']>;
/** The old "AI and spending" page was a ten-line shell around AiSpendStep; the live page wraps the same step, but the pinned tests below drive the step through this shell. */
function AiSpendingShell() {
 const { orgId, company, developerId, role, checking } = useAdminContext();
 return h('section', null, h(PageHeader, { focusOnMount: true, title: 'AI and spending', description: 'Company AI connections, models for each step, and spending limits.' }),
  !checking && h(AiSpendStep, { key: `${orgId}:${developerId}:${role}`, orgId, company, role, developerId }));
}
const legacy: Record<string, Leaf> = {
 'admin/ai-spending': async () => ({ Component: AiSpendingShell }),
 'product-ai': async () => ({ Component: (await import('../../../packages/ui/src/screens/admin/product-ai/ProductAiScreen.js')).ProductAiScreen }),
};
export function appRoutes(features: Parameters<typeof liveRoutes>[0]): RouteObject[] {
 const swap = (routes: RouteObject[]): RouteObject[] => routes.map(route => {
  const lazy = route.path === undefined ? undefined : legacy[route.path];
  if (lazy !== undefined) { const copy = { ...route }; delete copy.element; return { ...copy, lazy }; }
  return route.children ? { ...route, children: swap(route.children) } : route;
 });
 return swap(liveRoutes(features));
}
