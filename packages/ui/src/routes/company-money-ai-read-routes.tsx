import type { ComponentType } from 'react';
import type { RouteObject } from 'react-router';
// Type only: the pages themselves load through the dynamic import below.
import type * as Pages from '../screens/company-money-ai-read/LazyPages.js';

/**
 * The rebuilt company money / AI pages (G2), relative to the existing /app/admin host, mounted by routes.tsx on the real report, feature, AI, source-order and Product AI addresses.
 * Every route is lazy (WIRING-1B): the screens and their action host stay out of the initial bundle and load as one chunk the first time one of these pages opens.
 */
const page = (load: () => Promise<ComponentType>) => async () => ({ Component: await load() });
async function entry(pick: (pages: typeof Pages) => ComponentType): Promise<ComponentType> {
 const pages = await import('../screens/company-money-ai-read/LazyPages.js');
 return pick(pages);
}
export const COMPANY_MONEY_AI_READ_PATHS = ['money/report', 'money/report/features/:id', 'ai-spending', 'ai-spending/order', 'product-ai'] as const;
export type CompanyMoneyAiReadPath = (typeof COMPANY_MONEY_AI_READ_PATHS)[number];
export function companyMoneyAiReadRoutes(): RouteObject[] {
 return [
  { path: 'money/report', lazy: page(() => entry(pages => pages.CostReportPage)) },
  { path: 'money/report/features/:id', lazy: page(() => entry(pages => pages.FeatureDetailPage)) },
  { path: 'ai-spending', lazy: page(() => entry(pages => pages.AiSourcesPage)) },
  { path: 'ai-spending/order', lazy: page(() => entry(pages => pages.SourceOrderPage)) },
  { path: 'product-ai', lazy: page(() => entry(pages => pages.ProductAiPage)) },
 ];
}
/** One G2 route by its admin-relative path; a missing path throws at module load of the router, never silently mounts nothing. */
export function companyMoneyAiReadRoute(path: CompanyMoneyAiReadPath): RouteObject {
 const route = companyMoneyAiReadRoutes().find(item => item.path === path);
 if (route === undefined) throw new Error(`No rebuilt company money / AI route at ${path}.`);
 return route;
}
