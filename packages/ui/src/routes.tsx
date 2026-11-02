import { HomeScreen } from "./screens/home/HomeScreen.js";
import { useSearchParams, type RouteObject } from "react-router";
import { type AppNav } from "@agentx/contracts/web";
import { useAppHost } from "./host.js";
import { Button } from "./design/Button.js";
import { AppShell } from "./shell/AppShell.js";
import { NotFound } from "./shell/NotFound.js";
import { RouteError } from "./shell/ErrorBoundary.js";
function Page({ title }: { title: string }) { return <section><h1 tabIndex={-1}>{title}</h1></section>; }
function SignedOut() {
 const host = useAppHost(), [params] = useSearchParams();
 const reason = params.get("reason"), message = reason === "removed" ? "Your access to this organization ended." : reason === "failed" ? "We couldn't finish signing you in. Try again." : reason === "cancelled" ? "Sign-in was cancelled." : "You've signed out.";
 return <main className="rv-entry"><h1 tabIndex={-1}>Sign in to Rovara</h1><p>{message}</p><Button variant="primary" onClick={() => host.signIn("/app")}>Sign in</Button></main>;
}
export function appRoutes(features: AppNav["features"]): RouteObject[] {
 const children: RouteObject[] = [
 { index: true, element: <HomeScreen /> }, { path: "live", lazy: async () => ({ Component: (await import("./screens/live/LiveScreen.js")).LiveScreen }) },
 { path: "projects/:name", lazy: async () => ({ Component: (await import("./screens/project/ProjectScreen.js")).ProjectScreen }) }, { path: "sessions/:id", lazy: async () => ({ Component: (await import("./screens/session/SessionScreen.js")).SessionScreen }) },
 { path: "agents/:id?", lazy: async () => ({ Component: (await import("./screens/agents/DirectoryScreen.js")).DirectoryScreen }) }, { path: "agents/new", lazy: async () => ({ Component: (await import("./screens/builder/NewAgentScreen.js")).NewAgentScreen }) },
 { path: "agents/:id/edit", lazy: async () => ({ Component: (await import("./screens/builder/BuilderScreen.js")).BuilderScreen }) },
 { path: "onboard", lazy: async () => ({ Component: (await import("./screens/onboarding/OnboardScreen.js")).OnboardScreen }) },
 ];
 // Lane C: waiting is caller-scoped, independent of the company-admin navigation flag.
 children.push({ path: "admin/waiting", handle: { webOnly: true }, lazy: async () => ({ Component: (await import("./screens/admin/AdminLayout.js")).AdminLayout }), children: [{ index: true, lazy: async () => ({ Component: (await import("./screens/admin/waiting/WaitingScreen.js")).WaitingScreen }) }] });
 // Part B owns these screen implementations. Disabled routes are absent, including direct URLs.
 if (features.usage) children.push({ path: "usage", element: <Page title="Usage" /> });
 if (features.admin) children.push({ path: "admin/*", handle: { webOnly: true }, lazy: async () => { const { AdminLayout } = await import("./screens/admin/AdminLayout.js");return { Component: AdminLayout }; }, children: [{ index: true, lazy: async () => ({ Component: (await import("./screens/admin/AdminOverview.js")).AdminOverview }) }, { path: "money/budgets", lazy: async () => ({ Component: (await import("./screens/admin/BudgetsScreen.js")).BudgetsScreen }) }, { path: "invites", lazy: async () => ({ Component: (await import("./screens/admin/InvitesScreen.js")).InvitesScreen }) }, { path: "people", lazy: async () => ({ Component: (await import("./screens/admin/MembersScreen.js")).MembersScreen }) }, { path: "people/roles", lazy: async () => ({ Component: (await import("./screens/admin/RolesScreen.js")).RolesScreen }) }, // Lane B: projects and working branches (Agents screens stay held: no route, deep link falls to NotFound).
  { path: "health", lazy: async () => ({ Component: (await import("./screens/admin/health/ServiceStatusScreen.js")).ServiceStatusScreen }) },
  { path: "health/runtime/:kind", lazy: async () => ({ Component: (await import("./screens/admin/health/ServiceStatusScreen.js")).ServiceStatusScreen }) },
  { path: "projects", lazy: async () => ({ Component: (await import("./screens/admin/projects/ProjectsScreen.js")).ProjectsScreen }) },
  { path: "projects/:name", lazy: async () => ({ Component: (await import("./screens/admin/projects/ProjectDetailScreen.js")).ProjectDetailScreen }) },
  // Lane C: read-only company models, connections and permitted waiting items.
 { path: "how-we-work", lazy: async () => ({ Component: (await import("./screens/admin/how-we-work/HowWeWorkCompanyScreen.js")).HowWeWorkCompanyScreen }) }, { path: "models/:section?", lazy: async () => ({ Component: (await import("./screens/admin/models/ModelsScreen.js")).ModelsScreen }) }, { path: "connections", lazy: async () => ({ Component: (await import("./screens/admin/connections/ConnectionsScreen.js")).ConnectionsScreen }) }, { path: "tracker-people", lazy: async () => ({ Component: (await import("./screens/admin/tracker-people/TrackerPeopleScreen.js")).TrackerPeopleScreen }) },
 // Lane C2: read-only company audit.
 { path: "audit", lazy: async () => ({ Component: (await import("./screens/admin/audit/AuditScreen.js")).AuditScreen }) }, { path: "*", element: <NotFound /> }] });
 if (features.chains) children.push({ path: "chains/*", element: <Page title="Chains" /> });
 if (features.describe) children.push({ path: "describe", element: <Page title="Describe an agent" /> });
 children.push({ path: "*", element: <NotFound /> });
 return [{ path: "/s/:id", element: <AppShell />, errorElement: <RouteError />, children: [{ index: true, lazy: async () => ({ Component: (await import("./screens/session/SessionScreen.js")).SessionScreen }) }] }, { path: "/app/signup", lazy: async () => ({ Component: (await import("./screens/onboarding/SignupScreen.js")).SignupScreen }), errorElement: <RouteError /> }, { path: "/app/welcome", lazy: async () => ({ Component: (await import("./screens/onboarding/WelcomeScreen.js")).WelcomeScreen }), errorElement: <RouteError /> }, { path: "/app/signed-out", element: <SignedOut />, errorElement: <RouteError /> }, { path: "/app", element: <AppShell />, errorElement: <RouteError />, children }, { path: "*", element: <NotFound /> }];
}
