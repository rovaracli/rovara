import type { ComponentType } from "react";
import type { RouteObject } from "react-router";
// Type only: the pages themselves load through the dynamic import below.
import type * as Pages from "../screens/company-admin-read/LazyPages.js";

/**
 * The rebuilt company administration pages (G1), relative to the existing /app/admin host: Overview (the index), Settings and Audit, on their existing addresses
 * (so no redirect is needed). Every route is lazy: the screens load as one chunk the first time one of these pages opens, outside the initial bundle.
 */
const page = (load: () => Promise<ComponentType>) => async () => ({ Component: await load() });
async function entry(pick: (pages: typeof Pages) => ComponentType): Promise<ComponentType> {
 return pick(await import("../screens/company-admin-read/LazyPages.js"));
}
export const COMPANY_ADMIN_READ_PATHS = ["index", "settings", "audit"] as const;
export type CompanyAdminReadPath = (typeof COMPANY_ADMIN_READ_PATHS)[number];
export function companyAdminReadRoutes(): RouteObject[] {
 return [
  { index: true, lazy: page(() => entry(pages => pages.OverviewPage)) },
  { path: "settings", lazy: page(() => entry(pages => pages.SettingsPage)) },
  { path: "audit", lazy: page(() => entry(pages => pages.AuditPage)) },
 ];
}
/** One G1 route by name; a missing one throws when the router module loads, never silently mounts nothing. */
export function companyAdminReadRoute(path: CompanyAdminReadPath): RouteObject {
 const route = companyAdminReadRoutes().find(item => (path === "index" ? item.index === true : item.path === path));
 if (route === undefined) throw new Error(`No rebuilt company administration route at ${path}.`);
 return route;
}
