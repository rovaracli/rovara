import { HomeScreen } from "./screens/home/HomeScreen.js";
import { Navigate, useLocation, useParams, useSearchParams, type RouteObject } from "react-router";
import { type AppNav } from "@agentx/contracts/web";
import { SignInChoices } from "./screens/signed-out/SignInChoices.js";
import { AppShell } from "./shell/AppShell.js";
import { NotFound } from "./shell/NotFound.js";
import { RouteError } from "./shell/ErrorBoundary.js";
import { companyMoneyAiReadRoute, type CompanyMoneyAiReadPath } from "./routes/company-money-ai-read-routes.js";
function Page({ title }: { title: string }) { return <section><h1 tabIndex={-1}>{title}</h1></section>; }
function SignedOut() {
 const [params] = useSearchParams();
 const reason = params.get("reason"), message = reason === "removed" ? "Your access to this organization ended." : reason === "failed" ? "We couldn't finish signing you in. Try again." : reason === "cancelled" ? "Sign-in was cancelled." : "You've signed out.";
 return <main className="rv-entry" data-testid="signed-out"><h1 tabIndex={-1}>Sign in to Rovara</h1><p data-testid="signed-out-message">{message}</p><SignInChoices returnPath="/app" /></main>;
}
// Preserve supported URL context while retiring the competing editors.
function ModelSettingsRedirect({ section }: { section?: string }) {
 const { section: oldSection } = useParams(), location = useLocation();
 const target = section ?? (oldSection === "sources" ? "ai-connections" : "ai-models");
 return <Navigate to={{ pathname: "/app/admin/ai-spending", search: location.search, hash: `#${target}` }} replace />;
}
function TaskPreviewRedirect() {
 const { id } = useParams(), location = useLocation();
 return <Navigate to={{ pathname: "/s/" + encodeURIComponent(id ?? ""), search: location.search, hash: location.hash }} replace />;
}
function PreviewRedirect({ to }: { to: string }) {
 const location = useLocation();
 return <Navigate to={{ pathname: to, search: location.search, hash: location.hash }} replace />;
}
// WIRING-1B: the rebuilt company money / AI pages (G2) own the real report, feature, AI and Product AI addresses; each is lazy (its own chunk, outside the initial bundle).
const g2 = (path: CompanyMoneyAiReadPath, at: string): RouteObject => ({ ...companyMoneyAiReadRoute(path), path: at });
export function appRoutes(features: AppNav["features"]): RouteObject[] {
 const children: RouteObject[] = [
 { path: "design-system", handle: { bleed: true }, lazy: async () => ({ Component: (await import("./design/DesignSystemGallery.js")).DesignSystemGallery }) },
 { index: true, element: <HomeScreen /> }, // Home.
 // WIRING-3 (DEC 254zzz386): the rebuilt Work and Inbox own the real routes. Work stays at /app/live; the old split-inbox screens are retired.
 { path: "live", lazy: async () => ({ Component: (await import("./screens/work/WorkPreviewScreen.js")).WorkPreviewScreen }) },
 { path: "inbox", lazy: async () => ({ Component: (await import("./screens/inbox/InboxPreviewScreen.js")).InboxPreviewScreen }) },
 // The unlinked preview addresses redirect to the real pages and keep the query and the fragment (a saved ?task= or ?item= link still opens the same item).
 { path: "previews/work", element: <PreviewRedirect to="/app/live" /> },
 { path: "previews/inbox", element: <PreviewRedirect to="/app/inbox" /> },
 { path: "projects/:name", lazy: async () => ({ Component: (await import("./screens/project/ProjectScreen.js")).ProjectScreen }) }, { path: "sessions/:id", lazy: async () => ({ Component: (await import("./screens/session/SessionScreen.js")).SessionScreen }) },
 // Retire the preview at the canonical task address.
 { path: "task-preview/:id", element: <TaskPreviewRedirect /> },
 { path: "agents/:id?", lazy: async () => ({ Component: (await import("./screens/agents/DirectoryScreen.js")).DirectoryScreen }) }, { path: "agents/new", element: <ModelSettingsRedirect section="ai-models" /> },
 { path: "agents/:id/edit", element: <ModelSettingsRedirect section="ai-models" /> },
 { path: "account", lazy: async () => ({ Component: (await import("./screens/account/AccountScreen.js")).AccountScreen }) },
 { path: "account/automation-keys", lazy: async () => ({ Component: (await import("./screens/account/AutomationKeysScreen.js")).AutomationKeysScreen }) },
 { path: "onboard", lazy: async () => ({ Component: (await import("./screens/onboarding/OnboardScreen.js")).OnboardScreen }) },
 ];
 // Lane C: waiting is caller-scoped, independent of the company-admin navigation flag.
 children.push({ path: "admin/waiting", handle: { webOnly: true, bleed: true }, lazy: async () => ({ Component: (await import("./screens/admin/AdminLayout.js")).AdminLayout }), children: [{ index: true, lazy: async () => ({ Component: (await import("./screens/admin/waiting/WaitingScreen.js")).WaitingScreen }) }] });
 // The canonical card and its narrow legacy redirects are available without admin navigation.
 children.push({ handle: { webOnly: true, bleed: true }, lazy: async () => ({ Component: (await import("./screens/admin/AdminLayout.js")).AdminLayout }), children: [
  g2("ai-spending", "admin/ai-spending"),
  { path: "admin/models/:section?", element: <ModelSettingsRedirect /> },
  { path: "admin/agent-ai", element: <ModelSettingsRedirect section="ai-connections" /> },
  { path: "admin/learning-ai", element: <ModelSettingsRedirect section="ai-connections" /> },
  { path: "admin/second-review", element: <ModelSettingsRedirect section="ai-models" /> },
 ] });
 // Part B owns these screen implementations. Disabled routes are absent, including direct URLs.
 if (features.usage) children.push({ path: "usage", element: <Page title="Usage" /> });
 if (features.admin) children.push({ path: "admin/*", handle: { webOnly: true, bleed: true }, lazy: async () => { const { AdminLayout } = await import("./screens/admin/AdminLayout.js");return { Component: AdminLayout }; }, children: [{ index: true, lazy: async () => ({ Component: (await import("./screens/admin/AdminOverview.js")).AdminOverview }) }, { path: "money/budgets", lazy: async () => ({ Component: (await import("./screens/admin/BudgetsScreen.js")).BudgetsScreen }) }, { path: "money/limits", lazy: async () => ({ Component: (await import("./screens/admin/spend-limits/SpendLimitsScreen.js")).SpendLimitsScreen }) }, { path: "money/people", lazy: async () => ({ Component: (await import("./screens/admin/people-limits/PeopleLimitsScreen.js")).PeopleLimitsScreen }) }, g2("money/report", "money/report"), g2("money/report/features/:id", "money/report/features/:id"), g2("ai-spending/order", "ai-spending/order"), { path: "settings", lazy: async () => ({ Component: (await import("./screens/admin/settings/SettingsScreen.js")).SettingsScreen }) }, g2("product-ai", "product-ai"),
 { path: "invites", lazy: async () => ({ Component: (await import("./screens/admin/InvitesScreen.js")).InvitesScreen }) }, { path: "people", lazy: async () => ({ Component: (await import("./screens/admin/MembersScreen.js")).MembersScreen }) }, { path: "people/roles", lazy: async () => ({ Component: (await import("./screens/admin/RolesScreen.js")).RolesScreen }) }, // Lane B: projects and working branches (Agents screens stay held: no route, deep link falls to NotFound).
  { path: "projects", lazy: async () => ({ Component: (await import("./screens/admin/projects/ProjectsScreen.js")).ProjectsScreen }) },
  { path: "projects/:name", lazy: async () => ({ Component: (await import("./screens/admin/projects/ProjectDetailScreen.js")).ProjectDetailScreen }) },
  // Lane C: read-only company models, connections and permitted waiting items.
 { path: "how-we-work", lazy: async () => ({ Component: (await import("./screens/admin/how-we-work/HowWeWorkCompanyScreen.js")).HowWeWorkCompanyScreen }) },
 { path: "how-we-work/recipes", lazy: async () => ({ Component: (await import("./screens/admin/how-we-work/SetupRecipesScreen.js")).SetupRecipesScreen }) }, { path: "connections", lazy: async () => ({ Component: (await import("./screens/admin/connections/ConnectionsScreen.js")).ConnectionsScreen }) },
 // Lane C2: read-only company audit.
 { path: "audit", lazy: async () => ({ Component: (await import("./screens/admin/audit/AuditScreen.js")).AuditScreen }) }, { path: "*", element: <NotFound /> }] });
 if (features.chains) children.push({ path: "chains/*", element: <Page title="Chains" /> });
 if (features.describe) children.push({ path: "describe", element: <Page title="Describe an agent" /> });
 children.push({ path: "*", element: <NotFound /> });
 return [{ path: "/t/:taskId", element: <AppShell />, errorElement: <RouteError />, children: [{ index: true, lazy: async () => ({ Component: (await import("./screens/session/OpenTaskScreen.js")).OpenTaskScreen }) }] }, { path: "/s/:id", element: <AppShell />, errorElement: <RouteError />, children: [{ index: true, lazy: async () => ({ Component: (await import("./screens/session/SessionScreen.js")).SessionScreen }) }] }, { path: "/app/signup", lazy: async () => ({ Component: (await import("./screens/onboarding/SignupScreen.js")).SignupScreen }), errorElement: <RouteError /> }, { path: "/app/welcome", lazy: async () => ({ Component: (await import("./screens/onboarding/WelcomeScreen.js")).WelcomeScreen }), errorElement: <RouteError /> }, { path: "/app/signed-out", element: <SignedOut />, errorElement: <RouteError /> }, { path: "/app/no-company", lazy: async () => ({ Component: (await import("./screens/onboarding/CompanyScreens.js")).NoCompanyScreen }), errorElement: <RouteError /> }, { path: "/app/create-company", lazy: async () => ({ Component: (await import("./screens/onboarding/CompanyScreens.js")).CreateCompanyScreen }), errorElement: <RouteError /> }, { path: "/app/join", lazy: async () => ({ Component: (await import("./screens/onboarding/CompanyScreens.js")).JoinScreen }), errorElement: <RouteError /> }, { path: "/app", element: <AppShell />, errorElement: <RouteError />, children }, { path: "*", element: <NotFound /> }];
}
