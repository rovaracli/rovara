import { HomeScreen } from "./screens/home/HomeScreen.js";
import { Navigate, useLocation, useParams, type RouteObject } from "react-router";
import { type AppNav } from "@agentx/cloud-contracts/web";
import { AppShell } from "./shell/AppShell.js";
import { NotFound } from "./shell/NotFound.js";
import { Unavailable } from "./shell/Unavailable.js";
import { RouteError } from "./shell/ErrorBoundary.js";
import { paths } from "./paths.js";
/** UX2 slice 2 item 4: ONE task address. `/s/<id>` (older links) goes to `/app/sessions/<id>`, keeping the query and the tab. */
function OldSessionAddress() { const { id = "" } = useParams(), location = useLocation();return <Navigate replace to={{ pathname: "/app/sessions/" + encodeURIComponent(id), search: location.search, hash: location.hash }} />; }
function Page({ title }: { title: string }) { return <section><h1 tabIndex={-1}>{title}</h1></section>; }
/** New navigation only: `/app/live` is now Work. The query (filters) and the hash are kept, so an old bookmark or Slack link lands on the same view. */
function LiveToWork() { const location = useLocation();return <Navigate replace to={{ pathname: paths.work, search: location.search, hash: location.hash }} />; }
const liveScreen = async () => ({ Component: (await import("./screens/live/LiveScreen.js")).LiveScreen });
/** `newNav` is the new-navigation switch (nav-flags.ts). Off, this is exactly the route table as it was: no Work, no Projects list, Live stays Live. */
export function appRoutes(features: AppNav["features"], options: { newNav?: boolean; insights?: boolean; billing?: boolean; publish?: boolean } = {}): RouteObject[] {
 const newNav = options.newNav === true, billing = options.billing === true, publish = options.publish === true;
 const children: RouteObject[] = [
 { index: true, element: <HomeScreen /> }, ...(newNav ? [{ path: "live", element: <LiveToWork /> }, { path: "work", lazy: liveScreen }, { path: "projects", lazy: async () => ({ Component: (await import("./screens/project/ProjectsListScreen.js")).ProjectsListScreen }) }] : [{ path: "live", lazy: liveScreen }]),
 { path: "projects/:name", lazy: async () => ({ Component: (await import("./screens/project/ProjectScreen.js")).ProjectScreen }) }, { path: "sessions/:id", lazy: async () => ({ Component: (await import("./screens/session/SessionScreen.js")).SessionScreen }) },
 // Publish requests (switch `rovara.publish`, publish-flags.ts): registered only while the switch is on, so off the address is like any other: it falls to the agent directory, as it did before.
 ...(publish ? [{ path: "agents/requests", lazy: async () => ({ Component: (await import("./screens/agents/PublishRequestsScreen.js")).default }) }] : []),
 { path: "agents/:id?", lazy: async () => ({ Component: (await import("./screens/agents/DirectoryScreen.js")).DirectoryScreen }) }, { path: "agents/new", lazy: async () => ({ Component: (await import("./screens/builder/NewAgentScreen.js")).NewAgentScreen }) },
 { path: "agents/:id/edit", lazy: async () => ({ Component: (await import("./screens/builder/BuilderScreen.js")).BuilderScreen }) },
 { path: "onboard", lazy: async () => ({ Component: (await import("./screens/onboarding/OnboardScreen.js")).OnboardScreen }) },
 // Decision journey slice 3b: one decision on its own page (an outside approver's card).
 { path: "decisions/:kind/:subject", lazy: async () => ({ Component: (await import("./screens/decisions/DecisionScreen.js")).DecisionScreen }) },
 // UX2 slice 2 item 5: your account page (how you're notified; the task emails' "change" and "stop" links open it).
 { path: "account", lazy: async () => ({ Component: (await import("./screens/account/AccountScreen.js")).AccountScreen }) },
 ];
 // Insights (switch rovara.insights = v2): absent while the switch is off, direct URLs included. The screen itself asks the server who may see it.
 if (options.insights === true) children.push({ path: "insights", lazy: async () => ({ Component: (await import("./screens/insights/InsightsScreen.js")).InsightsScreen }) });
 // Trial page (switch `rovara.billing`, billing-flags.ts): absent while the switch is off, a direct address included. Any member may open it; the server decides what it shows.
 if (billing) children.push({ path: "trial", lazy: async () => ({ Component: (await import("./screens/billing/TrialScreen.js")).TrialScreen }) });
 // Lane C: waiting is caller-scoped, independent of the company-admin navigation flag.
 children.push({ path: "admin/waiting", handle: { webOnly: true }, lazy: async () => ({ Component: (await import("./screens/admin/AdminLayout.js")).AdminLayout }), children: [{ index: true, lazy: async () => ({ Component: (await import("./screens/admin/waiting/WaitingScreen.js")).WaitingScreen }) }] });
 // Part B owns these screen implementations. Disabled routes are absent, including direct URLs.
 // UX5b: script tokens, only where the install's switch is on (absent otherwise, direct URLs included). A browser session manages them, so the desktop app has no route.
 if (features.scriptTokens === true) children.push({ path: "settings/script-tokens", handle: { webOnly: true }, lazy: async () => ({ Component: (await import("./screens/settings/ScriptTokensScreen.js")).ScriptTokensScreen }) });
 // G-04: any member reads the company rules in force, only where the install's switch `si` is on (the nav answer's `companyRules`). Read only; changing them is in company settings.
 if (features.companyRules === true) children.push({ path: "settings/company-rules", handle: { webOnly: true }, lazy: async () => ({ Component: (await import("./screens/admin/company-rules/CompanyRulesCurrentScreen.js")).CompanyRulesCurrentScreen }) });
 if (features.usage) children.push({ path: "usage", element: <Page title="Usage" /> });
 if (features.admin) children.push({ path: "admin/*", handle: { webOnly: true }, lazy: async () => { const { AdminLayout } = await import("./screens/admin/AdminLayout.js");return { Component: AdminLayout }; }, children: [{ index: true, lazy: async () => ({ Component: (await import("./screens/admin/AdminOverview.js")).AdminOverview }) }, { path: "money/budgets", lazy: async () => ({ Component: (await import("./screens/admin/BudgetsScreen.js")).BudgetsScreen }) }, ...(billing ? [{ path: "billing", lazy: async () => ({ Component: (await import("./screens/billing/BillingScreen.js")).BillingScreen }) }] : []), { path: "invites", lazy: async () => ({ Component: (await import("./screens/admin/InvitesScreen.js")).InvitesScreen }) }, { path: "people", lazy: async () => ({ Component: (await import("./screens/admin/MembersScreen.js")).MembersScreen }) }, { path: "people/roles", lazy: async () => ({ Component: (await import("./screens/admin/RolesScreen.js")).RolesScreen }) }, // Lane B: projects and working branches. UX3: the Agents screens are part of company settings.
  { path: "agents", lazy: async () => ({ Component: (await import("./screens/admin/agents/AgentsScreen.js")).AgentsScreen }) },
  { path: "agents/:id/versions", lazy: async () => ({ Component: (await import("./screens/admin/agents/AgentVersionsScreen.js")).AgentVersionsScreen }) },
  // UX3: the old "Code step models" tab only pointed at How we work; the address now goes there.
  { path: "models/steps", element: <Navigate to="/app/admin/how-we-work" replace /> },
  { path: "health", lazy: async () => ({ Component: (await import("./screens/admin/health/ServiceStatusScreen.js")).ServiceStatusScreen }) },
  { path: "health/runtime/:kind", lazy: async () => ({ Component: (await import("./screens/admin/health/ServiceStatusScreen.js")).ServiceStatusScreen }) },
  { path: "new-screens", lazy: async () => ({ Component: (await import("./screens/admin/new-screens/NewScreensScreen.js")).NewScreensScreen }) },
  { path: "domains", lazy: async () => ({ Component: (await import("./screens/admin/domains/CompanyDomainsScreen.js")).CompanyDomainsScreen }) },
  { path: "projects", lazy: async () => ({ Component: (await import("./screens/admin/projects/ProjectsScreen.js")).ProjectsScreen }) },
  { path: "projects/:name", lazy: async () => ({ Component: (await import("./screens/admin/projects/ProjectDetailScreen.js")).ProjectDetailScreen }) },
  // Lane C: read-only company models, connections and permitted waiting items.
 { path: "how-we-work", lazy: async () => ({ Component: (await import("./screens/admin/how-we-work/HowWeWorkCompanyScreen.js")).HowWeWorkCompanyScreen }) },
 { path: "company-rules", lazy: async () => ({ Component: (await import("./screens/admin/company-rules/CompanyRulesScreen.js")).CompanyRulesScreen }) },
 { path: "how-we-work/recipes", lazy: async () => ({ Component: (await import("./screens/admin/how-we-work/SetupRecipesScreen.js")).SetupRecipesScreen }) },
 { path: "how-we-work/images", lazy: async () => ({ Component: (await import("./screens/admin/how-we-work/CompanyImagesScreen.js")).CompanyImagesScreen }) }, { path: "models/:section?", lazy: async () => ({ Component: (await import("./screens/admin/models/ModelsScreen.js")).ModelsScreen }) }, { path: "connections", lazy: async () => ({ Component: (await import("./screens/admin/connections/ConnectionsScreen.js")).ConnectionsScreen }) }, { path: "tracker-people", lazy: async () => ({ Component: (await import("./screens/admin/tracker-people/TrackerPeopleScreen.js")).TrackerPeopleScreen }) },
 // Lane C2: read-only company audit.
 { path: "second-review", lazy: async () => ({ Component: (await import("./screens/admin/second-review/SecondReviewScreen.js")).SecondReviewScreen }) },
 { path: "approval-window", lazy: async () => ({ Component: (await import("./screens/admin/approval-window/ApprovalWindowScreen.js")).ApprovalWindowScreen }) },
 // Lane C2: read-only company audit.
 { path: "audit", lazy: async () => ({ Component: (await import("./screens/admin/audit/AuditScreen.js")).AuditScreen }) }, { path: "*", element: <NotFound /> }] });
 // Chains and triggers are hidden: an old link shows "This isn't available" with a link home, not an error. Their code and data stay.
 children.push({ path: "chains/*", element: <Unavailable /> }, { path: "triggers/*", element: <Unavailable /> });
 if (features.describe) children.push({ path: "describe", element: <Page title="Describe an agent" /> });
 children.push({ path: "*", element: <NotFound /> });
 return [{ path: "/s/:id", element: <OldSessionAddress />, errorElement: <RouteError /> }, { path: "/app/signup", lazy: async () => ({ Component: (await import("./screens/onboarding/SignupScreen.js")).SignupScreen }), errorElement: <RouteError /> }, { path: "/app/welcome", lazy: async () => ({ Component: (await import("./screens/onboarding/WelcomeScreen.js")).WelcomeScreen }), errorElement: <RouteError /> }, { path: "/app/signed-out", lazy: async () => ({ Component: (await import("./screens/signed-out/SignedOutScreen.js")).SignedOutRoute }), errorElement: <RouteError /> }, { path: "/app", element: <AppShell />, errorElement: <RouteError />, children }, { path: "*", element: <NotFound /> }];
}
