// The Spending page journey (`admin` scenario, switch `rovara.spending` = "v2"): the three reads the page makes that the admin scenario's real directory does not answer.
// The people are the admin directory's (Priya, who is signed in, and Maya). Variants: "owner" (the default: everything), "restricted" (the broker refuses the company breakdown, as it does for anyone who is not an
// owner or admin), "over" (spent and held are past the allowance), "empty" (a month with nothing in it).
export type SpendingVariant = "owner" | "restricted" | "over" | "empty";
let variant: SpendingVariant = "owner";
export function setSpendingVariant(value: string | null): void { variant = value === "restricted" || value === "over" || value === "empty" ? value : "owner"; }
const ME = "a".repeat(64), MAYA = "b".repeat(64);
export function spendingAnswer(url: URL, origin: string): { status: number; body: unknown } | undefined {
 if (url.pathname === "/v1/web/budget") {
  const org = variant === "over" ? { spentUsd: 480, committedUsd: 60, limitUsd: 500 } : variant === "empty" ? { spentUsd: 0, committedUsd: 0 } : { spentUsd: 200, committedUsd: 50, limitUsd: 500 };
  return { status: 200, body: { month: "2026-11", member: { spentUsd: variant === "empty" ? 0 : 12.5, committedUsd: variant === "empty" ? 0 : 1, limitUsd: 29 }, org, testing: { spentUsd: 0, committedUsd: 0 }, personalPlan: { tokens: 0 }, alerts: [], requestId: "mock-gateway-request" } };
 }
 if (url.pathname === "/v1/web/org/spend") {
  if (variant === "restricted") return { status: 403, body: { error: { code: "FORBIDDEN", message: "Only an org owner or admin can see the company's spend." } } };
  if (variant === "empty") return { status: 200, body: { month: "2026-11", totalUsd: 0, committedUsd: 0, byProject: [], byMember: [], byAgent: [], bySource: [], byModel: [], requestId: "mock-gateway-request" } };
  return { status: 200, body: { month: "2026-11", totalUsd: 200, committedUsd: 50, limitUsd: 500, byProject: [{ project: "payments", spentUsd: 150, committedUsd: 30 }, { project: "web", spentUsd: 50, committedUsd: 20 }], byMember: [{ developerId: MAYA, spentUsd: 187.5 }, { developerId: ME, spentUsd: 12.5 }], byAgent: [], byModel: [], bySource: [{ source: "rovara", spentUsd: 150 }, { source: "anthropic", spentUsd: 50 }], requestId: "mock-gateway-request" } };
 }
 if (url.pathname === "/v1/web/spend-requests") {
  const open = variant === "empty" ? [] : [
   { spendRequestId: "spr_aaaaaaaaaaaaaaaaaaaa", status: "PENDING", createdAt: "2026-11-10T10:00:00.000Z", expiresAt: "2026-11-17T10:00:00.000Z", kind: "month", amountUsd: 25, reason: "Release week needs more room", approverRole: "org_admin", confirmUrl: origin + "/v1/app/approve/spr_aaaaaaaaaaaaaaaaaaaa" },
   { spendRequestId: "spr_bbbbbbbbbbbbbbbbbbbb", status: "PENDING", createdAt: "2026-11-10T11:00:00.000Z", expiresAt: "2026-11-17T11:00:00.000Z", kind: "run_limit", amountUsd: 5, approverRole: "project_maintainer", confirmUrl: origin + "/v1/app/approve/spr_bbbbbbbbbbbbbbbbbbbb" },
  ];
  return { status: 200, body: { spendRequests: open, requestId: "mock-gateway-request" } };
 }
 return undefined;
}
