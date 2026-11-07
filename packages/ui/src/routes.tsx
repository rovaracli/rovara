import { HomeScreen } from "./screens/home/HomeScreen.js";
import { type RouteObject } from "react-router";
import { type AppNav } from "@agentx/contracts/web";
import { AppShell } from "./shell/AppShell.js";
import { NotFound } from "./shell/NotFound.js";
import { Unavailable } from "./shell/Unavailable.js";
import { RouteError } from "./shell/ErrorBoundary.js";
function Page({ title }: { title: string }) { return <section><h1 tabIndex={-1}>{title}</h1></section>; }
export function appRoutes(features: AppNav["features"]): RouteObject[] {
 const children: RouteObject[] = [
 { index: true, element: <HomeScreen /> }, { path: "live", lazy: async () => ({ Component: (await import("./screens/live/LiveScreen.js")).LiveScreen }) },
 { path: "projects/:name", lazy: async () => ({ Component: (await import("./screens/project/ProjectScreen.js")).ProjectScreen }) }, { path: "sessions/:id", lazy: async () => ({ Component: (await import("./screens/session/SessionScreen.js")).SessionScreen }) },
 { path: "agents/:id?", lazy: async () => ({ Component: (await import("./screens/agents/DirectoryScreen.js")).DirectoryScreen }) }, { path: "agents/new", lazy: async () => ({ Component: (await import("./screens/builder/NewAgentScreen.js")).NewAgentScreen }) },
 { path: "agents/:id/edit", lazy: async () => ({ Component: (await import("./screens/builder/BuilderScreen.js")).BuilderScreen }) },
 { path: "onboard", lazy: async () => ({ Component: (await import("./screens/onboarding/OnboardScreen.js")).OnboardScreen }) },
 // Decision journey slice 3b: one decision on its own page (an outside approver's card).
 { path: "decisions/:kind/:subject", lazy: async () => ({ Component: (await import("./screens/decisions/DecisionScreen.js")).DecisionScreen }) },
 ];
 // Lane C: waiting is caller-scoped, independent of the company-admin navigation flag.
 children.push({ path: "admin/waiting", handle: { webOnly: true }, lazy: async () => ({ Component: (await import("./screens/admin/AdminLayout.js")).AdminLayout }), children: [{ index: true, lazy: async () => ({ Component: (await import("./screens/admin/waiting/WaitingScreen.js")).WaitingScreen }) }] });
 // Part B owns these screen implementations. Disabled routes are absent, including direct URLs.
 // UX5b: script tokens, only where the install's switch is on (absent otherwise, direct URLs included). A browser session manages them, so the desktop app has no route.
 if (features.scriptTokens === true) children.push({ path: "settings/script-tokens", handle: { webOnly: true }, lazy: async () => ({ Component: (await import("./screens/settings/ScriptTokensScreen.js")).ScriptTokensScreen }) });
 if (features.usage) children.push({ path: "usage", element: <Page title="Usage" /> });
 if (features.admin) children.push({ path: "admin/*", handle: { webOnly: true }, lazy: async () => { const { AdminLayout } = await import("./screens/admin/AdminLayout.js");return { Component: AdminLayout }; }, children: [{ index: true, lazy: async () => ({ Component: (await import("./screens/admin/AdminOverview.js")).AdminOverview }) }, { path: "money/budgets", lazy: async () => ({ Component: (await import("./screens/admin/BudgetsScreen.js")).BudgetsScreen }) }, { path: "invites", lazy: async () => ({ Component: (await import("./screens/admin/InvitesScreen.js")).InvitesScreen }) }, { path: "people", lazy: async () => ({ Component: (await import("./screens/admin/MembersScreen.js")).MembersScreen }) }, { path: "people/roles", lazy: async () => ({ Component: (await import("./screens/admin/RolesScreen.js")).RolesScreen }) }, // Lane B: projects and working branches (Agents screens stay held: no route, deep link falls to NotFound).
  { path: "health", lazy: async () => ({ Component: (await import("./screens/admin/health/ServiceStatusScreen.js")).ServiceStatusScreen }) },
  { path: "health/runtime/:kind", lazy: async () => ({ Component: (await import("./screens/admin/health/ServiceStatusScreen.js")).ServiceStatusScreen }) },
  { path: "domains", lazy: async () => ({ Component: (await import("./screens/admin/domains/CompanyDomainsScreen.js")).CompanyDomainsScreen }) },
  { path: "projects", lazy: async () => ({ Component: (await import("./screens/admin/projects/ProjectsScreen.js")).ProjectsScreen }) },
  { path: "projects/:name", lazy: async () => ({ Component: (await import("./screens/admin/projects/ProjectDetailScreen.js")).ProjectDetailScreen }) },
  // Lane C: read-only company models, connections and permitted waiting items.
 { path: "how-we-work", lazy: async () => ({ Component: (await import("./screens/admin/how-we-work/HowWeWorkCompanyScreen.js")).HowWeWorkCompanyScreen }) },
 { path: "how-we-work/recipes", lazy: async () => ({ Component: (await import("./screens/admin/how-we-work/SetupRecipesScreen.js")).SetupRecipesScreen }) }, { path: "models/:section?", lazy: async () => ({ Component: (await import("./screens/admin/models/ModelsScreen.js")).ModelsScreen }) }, { path: "connections", lazy: async () => ({ Component: (await import("./screens/admin/connections/ConnectionsScreen.js")).ConnectionsScreen }) }, { path: "tracker-people", lazy: async () => ({ Component: (await import("./screens/admin/tracker-people/TrackerPeopleScreen.js")).TrackerPeopleScreen }) },
 // Lane C2: read-only company audit.
 { path: "second-review", lazy: async () => ({ Component: (await import("./screens/admin/second-review/SecondReviewScreen.js")).SecondReviewScreen }) },
 // Lane C2: read-only company audit.
 { path: "audit", lazy: async () => ({ Component: (await import("./screens/admin/audit/AuditScreen.js")).AuditScreen }) }, { path: "*", element: <NotFound /> }] });
 // Chains and triggers are hidden: an old link shows "This isn't available" with a link home, not an error. Their code and data stay.
 children.push({ path: "chains/*", element: <Unavailable /> }, { path: "triggers/*", element: <Unavailable /> });
 if (features.describe) children.push({ path: "describe", element: <Page title="Describe an agent" /> });
 children.push({ path: "*", element: <NotFound /> });
 return [{ path: "/s/:id", element: <AppShell />, errorElement: <RouteError />, children: [{ index: true, lazy: async () => ({ Component: (await import("./screens/session/SessionScreen.js")).SessionScreen }) }] }, { path: "/app/signup", lazy: async () => ({ Component: (await import("./screens/onboarding/SignupScreen.js")).SignupScreen }), errorElement: <RouteError /> }, { path: "/app/welcome", lazy: async () => ({ Component: (await import("./screens/onboarding/WelcomeScreen.js")).WelcomeScreen }), errorElement: <RouteError /> }, { path: "/app/signed-out", lazy: async () => ({ Component: (await import("./screens/signed-out/SignedOutScreen.js")).SignedOutRoute }), errorElement: <RouteError /> }, { path: "/app", element: <AppShell />, errorElement: <RouteError />, children }, { path: "*", element: <NotFound /> }];
}
