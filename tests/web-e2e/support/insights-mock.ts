import type { Page } from "@playwright/test";
// The Insights journey's reads (`page.route` fixtures, no server). Shapes follow the agreed API doc (briefs/insights-api.md), including the two fields the doc lacks that the screen reads when present (stuck `owner`, shipped `tickets`).
// Variants: "owner" (company scope, per-person spend present, grant control), "viewer" (company scope, no per-person spend, no grant control), "maintainer" (two projects, no company totals), "refused" (the overview answers 403).
export type InsightsVariant = "owner" | "viewer" | "maintainer" | "refused";
const ME = "a".repeat(64), MAYA = "b".repeat(64), SAM = "c".repeat(64), ASOF = "2026-11-11T12:00:00.000Z";
const coverage = { sources: ["sessions", "spend_requests"], notCovered: ["change_approvals", "plan_reviews", "merge_readiness"], partial: false, truncated: false };
const SES_A = "ses_" + "a".repeat(20), SES_B = "ses_" + "b".repeat(20);
function overview(variant: InsightsVariant) {
 const maintainer = variant === "maintainer";
 return { enabled: true, viewer: { role: variant === "owner" ? "owner" : "member", via: [variant === "owner" ? "owner" : maintainer ? "maintainer" : "viewer_grant"], scope: maintainer ? { kind: "projects", projects: ["payments", "web"] } : { kind: "company" }, contentLevel: variant === "viewer" ? "metadata_only_elsewhere" : "full_where_readable", canSeePerPerson: variant === "owner" },
  panels: { stuck: { status: "ready", coverage }, shipped: { status: "collecting", collectingSince: "2026-11-01T00:00:00.000Z" }, spend: { status: "ready", outcomesStatus: "collecting" }, flow: { status: "unavailable", collectingSince: null } },
  capture: { workEvents: "off", since: null, retentionMonths: 13 }, asOf: ASOF };
}
const stuck = { status: "ready", asOf: ASOF, coverage, summary: { total: 2, over24h: 2, over72h: 1, byNextActorKind: { person: 2 }, byBlocker: { review: 1, decision: 1 } }, items: [
 { itemId: SES_A, project: "payments", blocker: "decision", state: "needs_you", stateWords: "Needs you", nextActor: { kind: "person", name: "Maya Chen", role: "reviewer" }, since: "2026-11-10T10:00:00.000Z", sinceKind: "last_update", ageHours: 26, visibility: "full", title: "Retry the payment webhook", reason: "the checks didn't pass", link: "https://app.example/s/" + SES_A, owner: { id: ME, name: "Priya Shah" } },
 { itemId: SES_B, project: "web", blocker: "review", state: "needs_you", stateWords: "Needs you", nextActor: { kind: "person", name: "Dana Wu" }, since: "2026-11-07T10:00:00.000Z", sinceKind: "last_update", ageHours: 98, visibility: "metadata", owner: { id: SAM, name: "Sam Lee" } },
] };
const shipped = { status: "collecting", collectingSince: "2026-11-01T00:00:00.000Z", weeks: [{ weekStart: "2026-11-09", shipped: 12, byProject: [{ project: "payments", shipped: 7, items: [{ itemId: SES_A, mergedAt: "2026-11-10T09:00:00.000Z", visibility: "full", title: "Fix refunds", prs: [{ repository: "acme/api", number: 412, url: "https://github.com/acme/api/pull/412" }], tickets: [{ key: "PAY-9", url: "https://linear.app/acme/issue/PAY-9" }] }, { itemId: SES_B, mergedAt: "2026-11-10T10:00:00.000Z", visibility: "metadata" }] }] }] };
function spend(variant: InsightsVariant) {
 const byProject = [{ project: "payments", spentUsd: 210.2, committedUsd: 218, limitUsd: 300, people: 1, shipped: null, costPerShippedUsd: null }, { project: "web", spentUsd: 100, committedUsd: 100, people: null, shipped: null, costPerShippedUsd: null }];
 return { month: "2026-11", status: "ready", scope: variant === "maintainer" ? "projects" : "company", ...(variant === "maintainer" ? {} : { totals: { spentUsd: 412.5, committedUsd: 431, limitUsd: 500 } }), byProject, ...(variant === "owner" ? { byPerson: [{ developerId: MAYA, name: "Maya Chen", spentUsd: 88.1, limitUsd: 29 }] } : {}), outcomes: { status: "collecting" } };
}
const access = { viewers: [{ person: { id: MAYA, name: "Maya Chen" }, grantedBy: { id: ME, name: "Priya" }, grantedAt: "2026-11-10T09:00:00.000Z" }], eligibleCount: 1 };
const members = { members: [{ developerId: ME, name: "Priya", role: "owner" }, { developerId: MAYA, name: "Maya Chen", role: "member" }, { developerId: SAM, name: "Sam Lee", role: "member" }] };
/** Answers every Insights read; returns the list of request paths seen (for "nothing was asked" checks). */
export async function mockInsights(page: Page, variant: InsightsVariant = "owner"): Promise<string[]> {
 const seen: string[] = [];
 await page.route(/\/v1\/web\/(insights(\/(stuck|shipped|spend|flow))?|org\/insights-access|org\/members)(\?|$)/u, route => {
  const url = new URL(route.request().url()), path = url.pathname.replace("/v1/web/", "");
  if (path.startsWith("insights") || path === "org/insights-access") seen.push(path);
  if (variant === "refused" && path === "insights") return route.fulfill({ status: 403, json: { error: { code: "FORBIDDEN", message: "You can't see Insights." } } });
  const body = path === "insights" ? overview(variant) : path === "insights/stuck" ? stuck : path === "insights/shipped" ? shipped : path === "insights/spend" ? spend(variant) : path === "org/insights-access" ? (variant === "owner" ? access : undefined) : path === "org/members" ? members : undefined;
  if (body === undefined) return route.fulfill({ status: 403, json: { error: { code: "FORBIDDEN", message: "Not allowed." } } });
  return route.fulfill({ status: 200, json: { ...body, requestId: "mock-gateway-request" } });
 });
 return seen;
}
