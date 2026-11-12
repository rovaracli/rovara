// UX3: the map of company settings. One list drives both the navigation and the overview, so every setting has one home and nothing is listed twice.
// Pages that change nothing (health, audit, agents) sit under the group they belong to. Who may open a page is decided by the page and the server, not here.
import type { SettingsAreaId } from "./settings-text.js";
export interface AdminLinkItem { to: string; label: string; area: SettingsAreaId; blurb: string; action: string; end?: true; ownerOnly?: true; needsSecondReview?: true; needsBilling?: true; needsCompanyRules?: true; needsApprovalWindow?: true }
export interface AdminSection { id: string; title: string; items: readonly AdminLinkItem[] }
export const ADMIN_SECTIONS: readonly AdminSection[] = [
  { id: "people", title: "People and access", items: [
    { to: "/app/admin/people", label: "People", area: "people", blurb: "See company members and understand their roles before making access decisions.", action: "Review company members" },
    { to: "/app/admin/people/roles", label: "Roles", area: "roles", blurb: "What owners, admins and members, and project roles, can do.", action: "Read the roles" },
    { to: "/app/admin/invites", label: "Invites", area: "invites", blurb: "Check masked pending invites. Older invite links may still exist outside this directory.", action: "Review pending invites" },
    { to: "/app/admin/tracker-people", label: "Tracker people", area: "tracker-people", blurb: "Match Linear and Jira people to Rovara members when Rovara can't do it itself.", action: "Match tracker people" },
  ] },
  { id: "connect", title: "Connections and models", items: [
    { to: "/app/admin/connections", label: "Connections", area: "connections", blurb: "GitHub, your AI provider, Slack, Linear, Jira and cloud tools: set up, check and fix each in place.", action: "Open connections" },
    { to: "/app/admin/models/sources", label: "AI models", area: "models", blurb: "Which AI provider Rovara tries first, and the models it can use.", action: "Review AI models" },
  ] },
  { id: "money", title: "Money and limits", items: [
    { to: "/app/admin/money/budgets", label: "Spending", area: "money", blurb: "What the company spent this month, what is held for work in progress, and what is left.", action: "Review this month's spend" },
    { to: "/app/admin/billing", label: "Billing", area: "billing", blurb: "The trial allowance, auto-billing, the payment method and invoices.", action: "Open billing", needsBilling: true },
  ] },
  { id: "work", title: "How work runs", items: [
    { to: "/app/admin/company-rules", label: "Company rules", area: "company-rules", blurb: "The standing instructions every agent follows: Required and Preferred rules, changed with a second admin's approval.", action: "Review company rules", needsCompanyRules: true },
    { to: "/app/admin/how-we-work", label: "How we work", area: "how-we-work", blurb: "Company defaults for steps and models, design review and learning, and the locks projects can't change.", action: "Review how we work" },
    { to: "/app/admin/projects", label: "Projects", area: "projects", blurb: "Each project's repositories, people, Slack links and working branches.", action: "Review projects" },
    { to: "/app/admin/agents", label: "Agents", area: "agents", blurb: "Agent versions and the company's agent guardrails.", action: "Review agents" },
  ] },
  { id: "security", title: "Security and sign-in", items: [
    { to: "/app/admin/domains", label: "Company domains", area: "domains", blurb: "Verify the email domains that count as your company's.", action: "Review company domains", ownerOnly: true },
    { to: "/app/admin/second-review", label: "Second opinion", area: "second-review", blurb: "Review outside second opinions on risky changes.", action: "Review second opinions", needsSecondReview: true },
    { to: "/app/admin/approval-window", label: "Recent sign-in window", area: "approval-window", blurb: "How recently a person must have signed in to approve medium-risk work from chat or comments, and where each risk level can be decided.", action: "Review the sign-in window", needsApprovalWindow: true },
    { to: "/app/admin/audit", label: "Audit", area: "audit", blurb: "What happened, and who did it.", action: "Open the audit" },
    { to: "/app/admin/health", label: "Health", area: "health", blurb: "Review stored, shared runtime qualification. No active checks run here.", action: "Review Rovara service status" },
  ] },
];
/** The items a viewer is offered: the owner-only page only to an owner, the second opinion page only while it exists on this install, the Billing page only while the device's billing switch is on, Company rules only while the nav answer says its switch (`si`) is on, the recent sign-in window page only while the server has it on. */
export function visibleSections(role: "owner" | "admin" | "member", secondReviewOff: boolean, billingOn = false, companyRulesOn = false, approvalWindowOff = false): AdminSection[] {
  return ADMIN_SECTIONS.map(section => ({ ...section, items: section.items.filter(item => !(item.ownerOnly === true && role !== "owner") && !(item.needsSecondReview === true && secondReviewOff) && !(item.needsBilling === true && !billingOn) && !(item.needsCompanyRules === true && !companyRulesOn) && !(item.needsApprovalWindow === true && approvalWindowOff)) })).filter(section => section.items.length > 0);
}
