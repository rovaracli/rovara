import type { ReadAppNav } from "@agentx/cloud-contracts/web";
import { paths } from "../paths.js";
/**
 * The new navigation's destinations, in order: Home, Work, Projects, Agents, Settings. One pure function so the sidebar, the phone tab bar and the tests agree.
 * Insights (managers, maintainers, admins) is added only when the caller passes `insights: true` (the device switch is on AND the server says this person may see it: `useInsightsNavVisible`). The phone tab bar keeps its five tabs; Insights is in the Menu.
 */
export type DestinationId = "home" | "work" | "projects" | "agents" | "insights" | "settings";
export interface Destination { id: DestinationId; label: string; to: string; /** True when only the exact path counts as current (Home). */ end: boolean; /** What needs this person, shown beside Home. */ count?: number }
/** Owners and admins reach company settings (when the install has them on); everyone else's Settings is their own account page. */
export function canOpenCompanySettings(nav: Pick<ReadAppNav, "me" | "features">): boolean { return nav.features.admin && (nav.me.orgRole === "owner" || nav.me.orgRole === "admin"); }
export function destinationsFor(nav: Pick<ReadAppNav, "me" | "features" | "homeCount">, options: { insights?: boolean } = {}): Destination[] {
 return [
  { id: "home", label: "Home", to: paths.home, end: true, count: nav.homeCount },
  { id: "work", label: "Work", to: paths.work, end: false },
  { id: "projects", label: "Projects", to: paths.projects, end: false },
  { id: "agents", label: "Agents", to: paths.directory, end: false },
  ...(options.insights === true ? [{ id: "insights" as const, label: "Insights", to: paths.insights, end: false }] : []),
  { id: "settings", label: "Settings", to: canOpenCompanySettings(nav) ? paths.admin.home : paths.account, end: false },
 ];
}
const under = (path: string, base: string): boolean => path === base || path.startsWith(base + "/");
/** Which destination a page belongs to. A work item (a session page) is part of Work; account and company pages are part of Settings. Anything else (Usage, Onboard) is no destination. */
export function currentDestination(pathname: string): DestinationId | undefined {
 const path = pathname.length > 1 ? pathname.replace(/\/+$/u, "") : pathname;
 if (path === paths.home) return "home";
 if (under(path, paths.work) || under(path, paths.live) || under(path, "/app/sessions")) return "work";
 if (under(path, paths.projects)) return "projects";
 if (under(path, paths.directory)) return "agents";
 if (under(path, paths.insights)) return "insights";
 if (under(path, "/app/admin") || under(path, paths.account) || under(path, "/app/settings")) return "settings";
 return undefined;
}
