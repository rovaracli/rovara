// The admin area's navigation: five groups instead of 14 flat tabs (Hybrid 1, DEC 223; the UX audit found 14 tabs on two rows).
export interface AdminLink { to: string; label: string; /** Shown on the Overview under the link. */ blurb: string; /** Only for these roles (the page and its routes refuse others too). */ ownerOnly?: boolean; /** Hidden while a probe says the page is off. */ key?: "second-review" }
export interface AdminGroup { id: string; title: string; links: readonly AdminLink[] }
export const ADMIN_GROUPS: readonly AdminGroup[] = [
 { id: "people", title: "People and access", links: [
  { to: "/app/admin/people", label: "People", blurb: "Who is in the company, their roles and how they sign in." },
  { to: "/app/admin/invites", label: "Invites", blurb: "Invites and pre-approved emails: who may join." },
  { to: "/app/admin/sign-in-clients", label: "Sign-in clients", blurb: "The apps and company logins that can sign people in." },
  { to: "/app/admin/sign-in-factors", label: "Sign-in factors", blurb: "Confirmation emails and passkeys, for fresh sign-ins." },
  { to: "/app/admin/domains", label: "Company domains", blurb: "Verify the email domains that belong to the company.", ownerOnly: true },
 ] },
 { id: "money", title: "Money", links: [
  { to: "/app/admin/money/budgets", label: "Spending", blurb: "Spent this month, what is left, by project and by person." },
 ] },
 { id: "work", title: "Work and rules", links: [
  { to: "/app/admin/projects", label: "Projects", blurb: "Project setup, working branches and archiving." },
  { to: "/app/admin/how-we-work", label: "How we work", blurb: "Company defaults for models, locks and learning." },
  { to: "/app/admin/settings", label: "Company settings", blurb: "Company rules, the approval window and who may start work." },
 ] },
 { id: "ai", title: "AI and connections", links: [
  { to: "/app/admin/ai-spending", label: "AI and spending", blurb: "Who pays for the AI, the model Rovara uses, and the company's monthly limit." },
  { to: "/app/admin/models/sources", label: "AI models", blurb: "Which model providers the company pays for." },
  { to: "/app/admin/product-ai", label: "Product AI keys", blurb: "A project's own AI key for its tests, and what its evals may spend." },
  { to: "/app/admin/agent-ai", label: "AI for your agents", blurb: "Rovara's AI, the company's own Anthropic key, or (soon) its own Bedrock.", ownerOnly: true },
  { to: "/app/admin/learning-ai", label: "Learning AI key", blurb: "The company's own AI account that lessons learn on, and its monthly learning cap.", ownerOnly: true },
  { to: "/app/admin/connections", label: "Connections", blurb: "Slack, GitHub, Jira and other connected tools." },
  { to: "/app/admin/tracker-people", label: "Tracker people", blurb: "Who in your tracker maps to whom in Rovara." },
  { to: "/app/admin/second-review", label: "Second opinion", blurb: "A second review of risky changes.", key: "second-review" },
 ] },
 { id: "oversight", title: "Oversight", links: [
  { to: "/app/admin/audit", label: "Audit", blurb: "Who did what, and when." },
  { to: "/app/admin/health", label: "Health", blurb: "Stored service status. No checks run here." },
  { to: "/app/admin/waiting", label: "Waiting for people", blurb: "Items waiting on a person." },
 ] },
];
/** The groups a person sees: owner-only links and the probed-off page are left out, and an empty group is not drawn. */
export function visibleAdminGroups(role: "owner" | "admin" | "member", secondReviewOff: boolean): AdminGroup[] {
 if (role === "member") return [{ id: "oversight", title: "Oversight", links: ADMIN_GROUPS.find(group => group.id === "oversight")!.links.filter(link => link.to.endsWith("/waiting")) }];
 return ADMIN_GROUPS.map(group => ({ ...group, links: group.links.filter(link => (link.ownerOnly !== true || role === "owner") && !(link.key === "second-review" && secondReviewOff)) })).filter(group => group.links.length > 0);
}
