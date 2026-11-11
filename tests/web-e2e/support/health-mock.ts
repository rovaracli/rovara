// The Health and readiness journey (`admin` scenario, switch `rovara.health` = "v2"): every read the readiness list and "What needs an admin" make, answered with fixed rows.
// Nothing is answered until a test chooses a variant (POST /__mock/health?variant=...), and the scenario endpoint resets it, so other admin journeys keep their real answers.
// Variants: "mixed" (the default: a failed tracker check, a failed project check, a confirmation, a spending request and a rule proposal waiting) and "calm" (nothing waiting, every check passed).
// Times are relative to now, so the seven-day age rule behaves the same on any day.
import { FIXTURE_DEVELOPER, FIXTURE_ORG } from "../../web/support/fixtures.js";
export type HealthVariant = "mixed" | "calm";
let variant: HealthVariant | undefined;
export function setHealthVariant(value: string | null): void { variant = value === "mixed" || value === "calm" ? value : undefined; }
export function resetHealth(): void { variant = undefined; }
const ago = (ms: number) => new Date(Date.now() - ms).toISOString(), HOUR = 3_600_000, DAY = 24 * HOUR;
const lessonSources = { sources: [{ kind: "slack", scope: "#payments-dev", enabled: true, retention: "30d", health: "ok", audience: "project", updatedAt: ago(DAY), paused: false }], otherPaused: 0 };
export function healthAnswer(url: URL): { status: number; body: unknown } | undefined {
 if (variant === undefined) return undefined;
 const mixed = variant === "mixed", path = url.pathname;
 const done = (body: unknown) => ({ status: 200, body: { ...(body as object), requestId: "mock-gateway-request" } });
 if (path === "/v1/web/github/installations") return done({ installations: [{ installationId: 55, accountLogin: "acme", accountType: "Organization", repositorySelection: "all", status: "active", connectedBy: FIXTURE_DEVELOPER, connectedAt: ago(30 * DAY) }] });
 if (path === "/v1/web/github/requests") return done({ requests: [] });
 if (path === "/v1/web/connections") return done({ connections: [{ connectionId: "con_aaaaaaaaaaaaaaaaaaaa", type: "linear", label: "Linear (Acme)", hasCredential: true, access: "read_write", updatedAt: ago(10 * DAY), createdBy: FIXTURE_DEVELOPER, createdAt: ago(30 * DAY), lastCheck: { ok: !mixed, at: ago(mixed ? 3 * HOUR : DAY) }, ticketUpdates: "enabled" }] });
 if (path === "/v1/web/org/slack-workspace-evidence") return done({ orgId: FIXTURE_ORG, checkedAt: ago(HOUR), kind: "stored_workspace_associations", associationCount: 1, unavailableCount: 0, coverage: "complete", verification: "unverified" });
 if (path === "/v1/web/org/model-sources") return done({ orgId: FIXTURE_ORG, developerId: FIXTURE_DEVELOPER, revision: 1, sources: [{ sourceId: "src_aaaaaaaaaaaaaaaaaaaa", kind: "anthropic", label: "Company Anthropic key", hasCredential: true, inOrder: true, models: [{ catalog: { provider: "anthropic", modelId: "claude-fixture-model-1" } }] }], order: ["rovara", "src_aaaaaaaaaaaaaaaaaaaa"], available: ["anthropic", "openai"] });
 if (path === "/v1/web/projects") return done({ projects: [
  { name: "payments", description: "Payments", status: "active", latestRevision: 3, repositories: [{ fullName: "acme/payments", defaultBranch: "main" }], myRole: "maintainer", setup: mixed ? { status: "failed", checkedRevision: 3, checkedAt: ago(5 * HOUR), failedStep: "npm test" } : { status: "ready", checkedRevision: 3, checkedAt: ago(5 * HOUR) } },
  { name: "web", description: "Web", status: "active", latestRevision: 1, repositories: [{ fullName: "acme/web", defaultBranch: "main" }], myRole: "maintainer", setup: { status: "ready", checkedRevision: 1, checkedAt: ago(2 * DAY) } },
 ] });
 if (path === "/v1/web/org/service-status") return done({ orgId: FIXTURE_ORG, source: "stored_runtime_qualification", checkedAt: ago(10 * 60_000), configured: true, checks: [
  { kind: "web", state: "ready", observation: "qualified", reason: "qualified", expiresAt: new Date(Date.now() + 3 * DAY).toISOString() }, { kind: "api", state: "ready", observation: "qualified", reason: "qualified", expiresAt: new Date(Date.now() + 3 * DAY).toISOString() }], teamRecord: { status: "ok", detail: "No team record delete is waiting." } });
 if (/^\/v1\/web\/projects\/[^/]+\/lessons\/sources$/u.test(path)) return done(lessonSources);
 if (path === "/v1/web/approvals") return done({ approvals: mixed ? [{ approvalId: "apr_aaaaaaaaaaaaaaaaaaaa", kind: "org_guardrail_relax", status: "PENDING", createdAt: ago(3 * HOUR) }] : [] });
 if (path === "/v1/web/spend-requests") return done({ spendRequests: mixed ? [{ spendRequestId: "spr_aaaaaaaaaaaaaaaaaaaa", status: "PENDING", createdAt: ago(2 * HOUR), expiresAt: new Date(Date.now() + 5 * DAY).toISOString(), kind: "month", amountUsd: 25, approverRole: "org_admin" }] : [] });
 if (path === "/v1/web/org/lessons/preset") return done({ preset: "standard" });
 if (path === "/v1/web/org/design-review") return done({ revision: 1, allowed: mixed, lock: {}, unreadable: false, ...(mixed ? { pending: { changeId: "chg_aaaaaaaaaaaaaaaaaaaa", kind: "lock", proposedByYou: false, expiresAt: new Date(Date.now() + 5 * DAY).toISOString() } } : {}) });
 return undefined;
}
