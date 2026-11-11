// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { screen, within, waitFor, fireEvent } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { AppNavSchema } from "@agentx/cloud-contracts/web";
import { appRoutes } from "../../packages/ui/src/routes.js";
import { AppHostProvider, type ApiRequest, type ApiResponse } from "../../packages/ui/src/host.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { ThemeProvider } from "../../packages/ui/src/theme.js";
import type { Read, ReadinessReads } from "../../packages/ui/src/api/readiness.js";
import { HEALTH_STORAGE_KEY, isHealthV2On } from "../../packages/ui/src/screens/admin/health/health-flags.js";
import {
 ago, buildNeedsAdmin, buildReadiness, chatRow, codeHostRow, connectionVerdict, fallbackLine, featuresRow, freshness, lessonsRow, modelRow, observe, projectRow, serviceRow, sortRows, stamp, teamRecordRow, trackerRow,
} from "../../packages/ui/src/screens/admin/health/readiness.js";
import { fakeHost } from "./support/fake-host.js";
import { renderUi } from "./support/render.js";
import { h } from "./support/h.js";
import { expectNoAxeViolations } from "./support/axe.js";

const orgId = "org_aaaaaaaaaaaaaaaaaaaa", me = "a".repeat(64);
const NOW = Date.parse("2026-11-11T12:00:00Z");
const ok = <T,>(data: T, at = NOW): Read<T> => ({ state: "ok", data, at });
const loading = { state: "loading" } as const, refused = { state: "refused" } as const, failed = { state: "failed" } as const, missing = { state: "missing" } as const;
const install = (status: "active" | "suspended" | "removed", accountLogin = "acme") => ({ installationId: 1, accountLogin, status, connectedBy: undefined, connectedAt: undefined });
const connection = (over: Record<string, unknown> = {}) => ({ connectionId: "c1", type: "linear", label: "Linear (team)", hasCredential: true, updatedAt: "2026-11-01T00:00:00Z", lastCheck: { ok: true, at: "2026-11-10T12:00:00Z" }, ...over }) as never;
const service = { orgId, source: "stored_runtime_qualification" as const, checkedAt: "2026-11-11T11:00:00.000Z", configured: true, checks: [{ kind: "web" as const, state: "ready" as const, observation: "qualified" as const, reason: "qualified" as const, expiresAt: "2026-11-14T00:00:00.000Z" }, { kind: "api" as const, state: "ready" as const, observation: "qualified" as const, reason: "qualified" as const, expiresAt: "2026-11-14T00:00:00.000Z" }], teamRecord: { status: "ok" as const, detail: "No delete is waiting." } };
const project = (name: string, status: string, extra: Record<string, unknown> = {}) => ({ name, status: "active" as const, setup: { status, checkedAt: undefined, failedStep: undefined, ...extra } }) as never;
// The broker's health observations (a company that has never run a check reads `{ checked: false }` for each); `observed({...})` overrides single features. Ages are the broker's, at its read time (NOW).
const observed = (over: Record<string, unknown> = {}) => ({ orgId, readAt: new Date(NOW).toISOString(), github: { checked: false }, slack: { checked: false }, modelSource: { checked: false }, modelUse: { checked: false }, ...over }) as never;
const passed = (secondsAgo: number, result: "ok" | "failed" | "unknown" = "ok", ageSeconds = secondsAgo) => ({ checked: true, checkedAt: new Date(NOW - secondsAgo * 1000).toISOString(), ageSeconds, result });
function reads(over: Partial<ReadinessReads> = {}): ReadinessReads {
 return {
  github: ok([install("active")]), githubRequests: ok([]), connections: ok([connection()]), slack: ok({ checkedAt: "2026-11-11T11:30:00.000Z", associationCount: 1, unavailableCount: 0 }),
  sources: ok({ sources: [{ sourceId: "src_a", kind: "anthropic", label: "Company Anthropic key", hasCredential: true, models: [{ catalog: { provider: "anthropic", modelId: "claude-secret-model-1" } }] }] }),
  projects: ok([project("payments", "ready", { checkedAt: "2026-11-10T09:00:00.000Z" })]), serviceStatus: ok(service as never), observations: ok(observed()), features: ok({ localAgents: false, usage: true, chains: false, notices: false, describe: true, scriptTokens: false, decisionCards: false }),
  lessons: [{ project: "payments", read: ok({ sources: [{ kind: "slack", scope: "#dev", enabled: true, retention: "30d", health: "ok", audience: "project", updatedAt: "2026-11-10T00:00:00Z", paused: false }], otherPaused: 0 } as never) }], lessonsSkipped: 0,
  approvals: ok({ total: 0, approvals: [] }), spend: ok([]), preset: ok({ preset: "standard" } as never), designReview: ok({ allowed: false, unreadable: false }), busy: false, now: NOW, refetch() {}, ...over,
 };
}

describe("the switch", () => {
 it("is off unless the device key is exactly v2, and never throws", () => {
  expect(isHealthV2On({ storage: { get: () => undefined } })).toBe(false);
  expect(isHealthV2On({ storage: { get: key => key === "rovara.health" ? "v2" : undefined } })).toBe(true);
  expect(HEALTH_STORAGE_KEY).toBe("rovara.health");
  expect(isHealthV2On({ storage: { get: () => "on" } })).toBe(false);
  expect(isHealthV2On({ storage: { get: () => { throw new Error("blocked"); } } })).toBe(false);
 });
});

describe("status mapping: green needs an observation", () => {
 it("code host: an active app is Unknown (no check time), a suspended or missing one needs action, an unread one is Unknown", () => {
  // The stored install status has no observation time, so an active app is Unknown, never Healthy.
  const active = codeHostRow(reads({ observations: missing }));
  expect(active.status).toBe("unknown");expect(active.checked).toBe("Check time not recorded");expect(active.source).toMatch(/GitHub/);expect(active.line).toMatch(/records no time/);expect(active.fix?.to).toBe("/app/admin/connections?open=github");
  const suspended = codeHostRow(reads({ github: ok([install("suspended")]) }));
  expect(suspended.status).toBe("action");expect(suspended.fix?.to).toBe("/app/admin/connections?open=github");expect(suspended.fix?.text).toMatch(/unsuspend/);
  expect(codeHostRow(reads({ github: ok([]) })).status).toBe("action");
  expect(codeHostRow(reads({ github: ok([]), githubRequests: ok([{ accountLogin: "acme", status: "waiting", requestedAt: "x" }]) })).line).toMatch(/Waiting for your GitHub admin/);
  for (const read of [failed, refused, missing]) { const row = codeHostRow(reads({ github: read })); expect(row.status).toBe("unknown");expect(row.checked).toBe("Not checked"); }
  expect(codeHostRow(reads({ github: loading })).status).toBe("checking");
 });
 it("chat: stored Slack links are configuration, so they are Unknown, never Healthy; a broken link needs action; the time is the stored read", () => {
  const row = chatRow(reads({ observations: missing }));
  expect(row.status).toBe("unknown");expect(row.line).toMatch(/nothing shows it still works/);expect(row.checked).toBe("Stored associations read Nov 11, 2026, 11:30 AM UTC");expect(row.checkedAt).toBe("2026-11-11T11:30:00.000Z");
  expect(chatRow(reads({ slack: ok({ checkedAt: "2026-11-11T11:30:00.000Z", associationCount: 2, unavailableCount: 1 }) })).status).toBe("action");
  const none = chatRow(reads({ slack: ok({ checkedAt: "2026-11-11T11:30:00.000Z", associationCount: 0, unavailableCount: 0 }) }));
  expect(none.status).toBe("unknown");expect(none.line).toMatch(/isn't connected/);expect(none.fix?.to).toBe("/app/admin/connections?open=slack");
  expect(chatRow(reads({ slack: refused })).line).toBe("Rovara wouldn't show the Slack connection to your account, so it can't be checked.");
 });
 it("a saved connection is Healthy only when its own last check passed, recently; no check, an old check or no time is Unknown; a failed check, no key or read-only is action", () => {
  expect(connectionVerdict(connection(), NOW)).toEqual({ status: "healthy", line: "Its last check passed.", checkedAt: "2026-11-10T12:00:00Z" });
  expect(connectionVerdict(connection({ lastCheck: undefined }), NOW).status).toBe("unknown");
  expect(connectionVerdict(connection({ lastCheck: { ok: true, at: "2026-10-30T12:00:00Z" } }), NOW)).toMatchObject({ status: "unknown", line: "Its last check passed more than 7 days ago." });
  expect(connectionVerdict(connection({ lastCheck: { ok: true, at: "not a time" } }), NOW).status).toBe("unknown");
  expect(connectionVerdict(connection({ lastCheck: { ok: true, at: "2026-11-11T13:00:00Z" } }), NOW)).toMatchObject({ status: "unknown", line: "Its last check is dated in the future, so it isn't believed." });
  expect(connectionVerdict(connection({ lastCheck: { ok: true, at: "2026-11-11T12:03:00Z" } }), NOW).status).toBe("healthy");
  expect(connectionVerdict(connection({ lastCheck: { ok: false, at: "2026-11-10T12:00:00Z" } }), NOW).status).toBe("action");
  expect(connectionVerdict(connection({ hasCredential: false }), NOW).status).toBe("action");
  expect(connectionVerdict(connection({ ticketUpdates: "needs_write_access" }), NOW)).toMatchObject({ status: "action", line: "It passed its last check, but Rovara can't write ticket updates back: it is read only." });
  expect(connectionVerdict(connection({ type: "cloudwatch", hasCredential: false }), NOW).status).toBe("healthy");
 });
 it("tracker row: worst connection wins, the oldest check is the time, none connected is Unknown with a connect action", () => {
  const row = trackerRow(reads({ connections: ok([connection(), connection({ connectionId: "c2", type: "jira", label: "Jira (ops)", lastCheck: { ok: false, at: "2026-11-09T12:00:00Z" } })]) }), NOW);
  expect(row.status).toBe("action");expect(row.line).toBe("Jira (ops): Its last check failed.");expect(row.checked).toBe("Oldest check Nov 9, 2026, 12:00 PM UTC");expect(row.fix?.to).toBe("/app/admin/connections?open=jira");
  expect(trackerRow(reads({ connections: ok([connection()]) }), NOW).status).toBe("healthy");
  const jira = trackerRow(reads({ connections: ok([connection({ type: "jira", label: "Jira (ops)", lastCheck: { ok: false, at: "2026-11-10T12:00:00Z" } })]) }), NOW);
  expect(jira.fix?.to).toBe("/app/admin/connections?open=jira");
  const none = trackerRow(reads({ connections: ok([connection({ type: "sentry" })]) }), NOW);
  expect(none.status).toBe("unknown");expect(none.fix?.label).toBe("Connect a tracker");
  expect(trackerRow(reads({ connections: failed }), NOW).status).toBe("unknown");
 });
 it("models: Unknown while no read shows the main model or a fallback, action for a source with no key; model ids only under details", () => {
  const row = modelRow(reads({ observations: missing }));
  expect(row.status).toBe("unknown");expect(row.line).toMatch(/fallback/);expect(row.line).not.toMatch(/claude-secret-model-1/);expect(row.details.join(" ")).toMatch(/claude-secret-model-1/);
  expect(modelRow(reads({ sources: ok({ sources: [] } as never) })).line).toMatch(/Rovara's own models/);
  const broken = modelRow(reads({ sources: ok({ sources: [{ sourceId: "src_a", kind: "openai", label: "Team OpenAI", hasCredential: false, models: [] }] } as never) }));
  expect(broken.status).toBe("action");expect(broken.fix?.to).toBe("/app/admin/connections?open=ai-provider");
  expect(modelRow(reads({ sources: refused })).status).toBe("unknown");
 });
 it("project environment: ready is Healthy with its time; failed needs action; never checked, outdated and running are Unknown", () => {
  expect(projectRow(project("payments", "ready", { checkedAt: "2026-11-10T09:00:00.000Z" }), NOW)).toMatchObject({ status: "healthy", checked: "Last checked Nov 10, 2026, 9:00 AM UTC" });
  // A passed check with no time, a time in the future, or one older than the age limit is not an observation of today.
  expect(projectRow(project("payments", "ready"), NOW)).toMatchObject({ status: "unknown", checked: "Check time not recorded", line: expect.stringContaining("recorded no time") as unknown });
  expect(projectRow(project("payments", "ready", { checkedAt: "2026-11-01T09:00:00.000Z" }), NOW)).toMatchObject({ status: "unknown", fix: { label: "Check test setup" } });
  expect(projectRow(project("payments", "ready", { checkedAt: "2026-11-12T09:00:00.000Z" }), NOW).status).toBe("unknown");
  const failedRow = projectRow(project("pay ments", "failed", { failedStep: "npm test" }), NOW);
  expect(failedRow).toMatchObject({ status: "action", fix: { to: "/app/onboard?project=pay%20ments&step=setup" } });expect(failedRow.line).not.toMatch(/npm test/);expect(failedRow.details.join(" ")).toMatch(/npm test/);
  expect(projectRow(project("p", "unchecked"), NOW)).toMatchObject({ status: "unknown", checked: "Never checked" });
  expect(projectRow(project("p", "outdated"), NOW).status).toBe("unknown");
  expect(projectRow(project("p", "checking"), NOW).status).toBe("unknown");
 });
 it("team record and lessons: the live delete check maps ok, warn and unknown; stored source health is never green, failing or paused is action", () => {
  expect(teamRecordRow(reads()).status).toBe("healthy");
  expect(teamRecordRow(reads({ serviceStatus: ok({ ...service, teamRecord: { status: "warn", detail: "x" } } as never) })).status).toBe("action");
  expect(teamRecordRow(reads({ serviceStatus: ok({ ...service, teamRecord: undefined } as never) })).status).toBe("unknown");
  expect(teamRecordRow(reads()).checked).toBe("Stored status read Nov 11, 2026, 11:00 AM UTC");
  // A stored health word has no time: "ok" is never Healthy, only a failing or paused source is news.
  expect(lessonsRow(reads())).toMatchObject({ status: "unknown", checked: "Check time not recorded" });
  const allOff = lessonsRow(reads({ lessons: [{ project: "payments", read: ok({ sources: [{ kind: "slack", enabled: false, retention: "30d", health: "ok", audience: "project", updatedAt: "x", paused: false }], otherPaused: 0 } as never) }] }));
  expect(allOff?.status).toBe("unknown");
  const failing = lessonsRow(reads({ lessons: [{ project: "payments", read: ok({ sources: [{ kind: "slack", scope: "#dev", enabled: true, retention: "30d", health: "failing", audience: "project", updatedAt: "x", paused: false }], otherPaused: 0 } as never) }] }));
  expect(failing).toMatchObject({ status: "action", fix: { to: "/app/projects/payments?tab=sources" } });
  const paused = lessonsRow(reads({ lessons: [{ project: "payments", read: ok({ sources: [{ kind: "slack", enabled: true, retention: "30d", health: "ok", audience: "project", updatedAt: "x", paused: true }], otherPaused: 0 } as never) }] }));
  expect(paused?.status).toBe("action");
  expect(lessonsRow(reads({ lessons: [{ project: "a", read: ok({ sources: [{ kind: "slack", enabled: true, retention: "30d", health: "ok", audience: "project", updatedAt: "x", paused: false }], otherPaused: 0 } as never) }, { project: "b", read: failed }] }))?.status).toBe("unknown");
  expect(lessonsRow(reads({ lessonsSkipped: 3 }))?.status).toBe("unknown");
  expect(lessonsRow(reads({ lessons: [{ project: "a", read: missing }] }))?.line).toMatch(/aren't set up/);
  expect(lessonsRow(reads({ lessons: [{ project: "a", read: ok({ sources: [{ kind: "slack", enabled: true, retention: "30d", health: "unknown", audience: "project", updatedAt: "x", paused: false }], otherPaused: 0 } as never) }] }))?.status).toBe("unknown");
 });
 it("service qualification and features: current is Healthy, expired needs action, none recorded is Unknown; features are never green", () => {
  expect(serviceRow(reads()).status).toBe("healthy");
  const expired = ok({ ...service, checks: [{ ...service.checks[0], observation: "expired", reason: "expired", state: "unavailable" }, service.checks[1]] } as never);
  expect(serviceRow(reads({ serviceStatus: expired })).status).toBe("action");
  expect(serviceRow(reads({ serviceStatus: ok({ ...service, configured: false } as never) })).status).toBe("unknown");
  const feature = featuresRow(reads());
  expect(feature.status).toBe("unknown");expect(feature.line).toMatch(/Usage, Describe a task/);expect(feature.line).toMatch(/Nothing checks/);
  expect(featuresRow(reads({ designReview: ok({ allowed: true, unreadable: true }) })).status).toBe("action");
  expect(featuresRow(reads({ designReview: ok({ allowed: true, unreadable: false }) })).line).toMatch(/Design review/);
 });
 it("the list: counts add up to the rows, nothing is green without an observation, action sorts first", () => {
  const readiness = buildReadiness(reads({ github: ok([install("suspended")]) }), NOW);
  expect(readiness.counts.healthy + readiness.counts.action + readiness.counts.unknown + readiness.checking).toBe(readiness.rows.length);
  expect(readiness.rows.map(row => row.id)).toEqual(["code-host", "chat", "tracker", "models", "project:payments", "team-record", "lessons", "features", "service"]);
  expect(readiness.counts).toEqual({ healthy: 4, action: 1, unknown: 4 });
  expect(sortRows(readiness.rows)[0]!.id).toBe("code-host");
  const nothing = buildReadiness(reads({ github: failed, connections: failed, slack: failed, sources: failed, projects: failed, serviceStatus: failed, features: failed, lessons: [] }), NOW);
  expect(nothing.counts.healthy).toBe(0);expect(nothing.rows.every(row => row.status === "unknown")).toBe(true);
  for (const row of readiness.rows) { expect(row.source).not.toBe("");expect(row.checked).not.toBe("");expect(row.line).not.toMatch(/undefined|NaN|\[object/); }
  expect([freshness(undefined, NOW), freshness("x", NOW), freshness("2026-11-11T11:00:00Z", NOW), freshness("2026-11-04T11:00:00Z", NOW), freshness("2026-11-11T12:04:00Z", NOW), freshness("2026-11-11T12:06:00Z", NOW)]).toEqual(["none", "none", "fresh", "stale", "fresh", "future"]);
  expect(stamp("garbage")).toBeUndefined();expect(stamp(undefined)).toBeUndefined();expect(stamp("2026-11-11T12:00:00Z")).toBe("Nov 11, 2026, 12:00 PM UTC");
 });
});

describe("health observations: when each check last ran", () => {
 const seen = (feature: "github" | "slack" | "modelSource", value: unknown, at = NOW) => ok(observed({ [feature]: value }), at);
 it("words for how long ago, and the age is the broker's plus the time since the page read it", () => {
  expect([0, 59_000, 60_000, 5 * 60_000, 3_600_000, 23 * 3_600_000, 24 * 3_600_000, 3 * 86_400_000].map(ago)).toEqual(["less than a minute ago", "less than a minute ago", "1 minute ago", "5 minutes ago", "1 hour ago", "23 hours ago", "1 day ago", "3 days ago"]);
  expect(observe(seen("github", passed(300)), "github", NOW)).toMatchObject({ kind: "ok", checked: "Checked 5 minutes ago", age: "5 minutes ago" });
  // The page read the answer two minutes before now: five minutes at the broker plus two since.
  expect(observe(seen("github", passed(300), NOW - 120_000), "github", NOW).checked).toBe("Checked 7 minutes ago");
  expect(observe(loading, "github", NOW).kind).toBe("loading");
  for (const read of [refused, missing, failed]) expect(observe(read, "github", NOW)).toEqual({ kind: "unread", checked: "Check time not recorded" });
  expect(observe(ok(observed()), "github", NOW)).toEqual({ kind: "never", checked: "Never checked" });
  expect(observe(ok({ orgId, readAt: "2026-11-11T12:00:00.000Z" } as never), "slack", NOW).kind).toBe("never");
 });
 it("GitHub: Healthy only with a fresh passing check; a failing one needs action; none, stale, future or 'could not tell' is Unknown", () => {
  const row = (value: unknown, over: Partial<ReadinessReads> = {}) => codeHostRow(reads({ observations: seen("github", value), ...over }));
  const fresh = row(passed(300));
  expect(fresh).toMatchObject({ status: "healthy", checked: "Checked 5 minutes ago", checkedAt: new Date(NOW - 300_000).toISOString() });expect(fresh.fix).toBeUndefined();expect(fresh.source).toMatch(/GitHub App installed check/);
  expect(fresh.details.join(" ")).toMatch(/Last GitHub App check: 5 minutes ago \(Nov 11, 2026, 11:55 AM UTC\)/);
  const bad = row(passed(300, "failed"));
  expect(bad).toMatchObject({ status: "action", line: "The last check that the GitHub App is installed failed.", checked: "Checked 5 minutes ago", fix: { to: "/app/admin/connections?open=github", label: "Fix GitHub" } });
  expect(row(passed(300, "unknown"))).toMatchObject({ status: "unknown", line: expect.stringContaining("couldn't tell") as unknown });
  expect(row({ checked: false })).toMatchObject({ status: "unknown", checked: "Never checked", line: expect.stringContaining("never been run") as unknown });
  const old = row(passed(8 * 86_400));
  expect(old).toMatchObject({ status: "unknown", checked: "Checked 8 days ago", line: expect.stringContaining("more than 7 days ago") as unknown });
  // The broker's own age counts too: a time that looks fresh against the clock but a server age over seven days is still stale.
  expect(row({ ...passed(300), ageSeconds: 8 * 86_400 }).status).toBe("unknown");
  const future = row({ checked: true, checkedAt: new Date(NOW + 10 * 60_000).toISOString(), ageSeconds: 0, result: "ok" });
  expect(future).toMatchObject({ status: "unknown", checked: "Check time not believed: it is dated in the future" });expect(future.checkedAt).toBeUndefined();
  expect(row({ checked: true, checkedAt: new Date(NOW + 4 * 60_000).toISOString(), ageSeconds: 0, result: "ok" }).status).toBe("healthy");
  // The stored install status still decides first: a suspended or missing app needs action whatever the last check said.
  expect(row(passed(300), { github: ok([install("suspended")]) }).status).toBe("action");
  expect(row(passed(300), { github: ok([]) }).status).toBe("action");
  expect(row(passed(300), { github: failed }).status).toBe("unknown");
  expect(codeHostRow(reads({ observations: loading })).status).toBe("checking");
  // A refused, missing or failed observations read: today's row.
  for (const read of [refused, missing, failed]) expect(codeHostRow(reads({ observations: read }))).toMatchObject({ status: "unknown", checked: "Check time not recorded", line: expect.stringContaining("records no time") as unknown });
 });
 it("Slack: Healthy only with a fresh passing live check; stored links alone are never green; a broken stored link still needs action", () => {
  const row = (value: unknown, over: Partial<ReadinessReads> = {}) => chatRow(reads({ observations: seen("slack", value), ...over }));
  expect(row(passed(120))).toMatchObject({ status: "healthy", checked: "Checked 2 minutes ago", line: "Slack is connected and its last live check passed." });
  expect(row(passed(120)).details.join(" ")).toMatch(/Stored workspace links read: Nov 11, 2026, 11:30 AM UTC/);
  expect(row(passed(120, "failed"))).toMatchObject({ status: "action", fix: { to: "/app/admin/connections?open=slack" }, line: "The last live check of the Slack connection failed." });
  expect(row(passed(120, "unknown")).status).toBe("unknown");expect(row({ checked: false })).toMatchObject({ status: "unknown", checked: "Never checked" });
  expect(row(passed(9 * 86_400)).status).toBe("unknown");
  expect(row(passed(120), { slack: ok({ checkedAt: "2026-11-11T11:30:00.000Z", associationCount: 2, unavailableCount: 1 }) }).status).toBe("action");
  expect(row(passed(120), { slack: ok({ checkedAt: "2026-11-11T11:30:00.000Z", associationCount: 0, unavailableCount: 0 }) }).status).toBe("unknown");
  expect(chatRow(reads({ observations: loading })).status).toBe("checking");
  for (const read of [refused, missing, failed]) expect(chatRow(reads({ observations: read })).status).toBe("unknown");
 });
 it("AI models: Healthy only with a fresh passing source check; a failing one needs action; a source with no key still does; the backup model line is one plain sentence", () => {
  const row = (value: unknown, use: unknown = { checked: false }, over: Partial<ReadinessReads> = {}) => modelRow(reads({ observations: ok(observed({ modelSource: value, modelUse: use })), ...over }));
  const healthy = row(passed(600));
  expect(healthy).toMatchObject({ status: "healthy", checked: "Checked 10 minutes ago" });expect(healthy.note).toBeUndefined();expect(healthy.line).toMatch(/last check of an AI provider passed/);
  expect(row(passed(600, "failed"))).toMatchObject({ status: "action", fix: { to: "/app/admin/models/sources" } });
  expect(row({ checked: false }).status).toBe("unknown");expect(row(passed(8 * 86_400)).status).toBe("unknown");expect(row(passed(600, "unknown")).status).toBe("unknown");
  const broken = modelRow(reads({ sources: ok({ sources: [{ sourceId: "src_a", kind: "openai", label: "Team OpenAI", hasCredential: false, models: [] }] } as never), observations: ok(observed({ modelSource: passed(60) })) }));
  expect(broken.status).toBe("action");expect(broken.fix?.to).toBe("/app/admin/connections?open=ai-provider");
  const use = { checked: true, windowHours: 24, usedMain: true, usedFallback: true, lastMainAt: "2026-11-11T11:59:00.000Z", lastMainAgeSeconds: 60, lastFallbackAt: "2026-11-11T11:05:00.000Z", lastFallbackAgeSeconds: 3300, lastFallbackReason: "DEFAULT_MODEL_UNAVAILABLE" };
  const backup = row(passed(600), use);
  expect(backup.note).toBe("Rovara used a backup model in the last 24 hours (the main model was unavailable); last at 11:05 UTC.");
  expect(backup.status).toBe("healthy");expect(`${backup.line} ${backup.note ?? ""}`).not.toMatch(/claude-secret-model-1|DEFAULT_MODEL_UNAVAILABLE/);expect(backup.details.join(" ")).toMatch(/claude-secret-model-1/);
  expect(backup.details.join(" ")).toMatch(/Backup model last used: Nov 11, 2026, 11:05 AM UTC/);
  expect(row({ checked: false }, use).note).toBeDefined();
  expect(modelRow(reads({ observations: missing })).note).toBeUndefined();
  expect(modelRow(reads({ observations: loading })).status).toBe("checking");
  for (const read of [refused, failed]) expect(modelRow(reads({ observations: read }))).toMatchObject({ status: "unknown", checked: "Check time not recorded" });
 });
 it("the backup model line: used, not needed, never run, an older last time, a reason it does not know", () => {
  const use = (over: Record<string, unknown>) => ({ checked: true, windowHours: 24, usedMain: true, usedFallback: false, ...over }) as never;
  expect(fallbackLine(undefined, NOW)).toBeUndefined();expect(fallbackLine({ checked: false }, NOW)).toBeUndefined();
  expect(fallbackLine(use({ usedFallback: true, lastFallbackAt: "2026-11-11T14:05:00.000Z", lastFallbackReason: "MODEL_CALL_REFUSED" }), NOW)).toBe("Rovara used a backup model in the last 24 hours (the main model refused the call); last at 14:05 UTC.");
  expect(fallbackLine(use({ usedFallback: true, lastFallbackAt: "2026-11-10T20:30:00.000Z" }), NOW)).toBe("Rovara used a backup model in the last 24 hours; last at Nov 10, 20:30 UTC.");
  expect(fallbackLine(use({ usedFallback: true, lastFallbackAt: "2026-11-11T09:00:00.000Z", lastFallbackReason: "SOME_NEW_CODE" }), NOW)).toBe("Rovara used a backup model in the last 24 hours (the main model could not be used); last at 09:00 UTC.");
  expect(fallbackLine(use({}), NOW)).toBe("Rovara did not need a backup model in the last 24 hours.");
  expect(fallbackLine(use({ lastFallbackAt: "2026-11-03T09:10:00.000Z" }), NOW)).toBe("Rovara did not need a backup model in the last 24 hours; the last time was Nov 3, 09:10 UTC.");
 });
 it("What needs an admin picks up a failing observation with its fix link and 'Checked N ago'; the counts are the same list's", () => {
  const r = reads({ observations: ok(observed({ github: passed(300, "failed"), slack: passed(60, "failed"), modelSource: passed(600, "failed") })) });
  const readiness = buildReadiness(r, NOW), need = buildNeedsAdmin(r, readiness);
  expect(need.items.map(item => [item.id, item.link.to, item.when])).toEqual([["row:code-host", "/app/admin/connections?open=github", "Checked 5 minutes ago"], ["row:chat", "/app/admin/connections?open=slack", "Checked 1 minute ago"], ["row:models", "/app/admin/models/sources", "Checked 10 minutes ago"]]);
  expect(readiness.counts.action).toBe(need.items.length);
  const calm = buildReadiness(reads({ observations: ok(observed({ github: passed(300), slack: passed(60), modelSource: passed(600) })) }), NOW);
  expect(calm.counts).toEqual({ healthy: 7, action: 0, unknown: 2 });
 });
 it("a refused, missing or failed observations read is named as unread, and the rows stay as they were", () => {
  for (const read of [refused, missing, failed]) {
   const r = reads({ observations: read }), need = buildNeedsAdmin(r, buildReadiness(r, NOW));
   expect(need.unread).toEqual(["when each check last ran"]);expect(need.items).toEqual([]);
   expect(buildReadiness(r, NOW).counts).toEqual({ healthy: 4, action: 0, unknown: 5 });
  }
 });
});

describe("What needs an admin", () => {
 const item = (id: string, over: Record<string, unknown> = {}) => ({ approvalId: id, kind: "change", subjectKind: "org_guardrail", title: "Loosen the company's design review rules", proposedBy: "Maya", createdAt: "2026-11-10T10:00:00.000Z", confirmUrl: "https://cell.example/v1/app/approve/" + id, ...over });
 const approvals = ok({ total: 1, approvals: [item("apr_a")] } as never);
 const spend = ok([{ spendRequestId: "spr_a", status: "PENDING", createdAt: "2026-11-10T11:00:00.000Z", kind: "month", amountUsd: 25 }]);
 it("lists confirmations, spending requests and rule proposals, each with where to fix it; waiting-for-others comes last", () => {
  const r = reads({ approvals, spend, designReview: ok({ allowed: false, unreadable: false, pending: { kind: "allowed", proposedByYou: true, expiresAt: "2026-11-17T10:00:00.000Z" } }), preset: ok({ preset: "regulated", proposal: { changeId: "c", to: "standard", mine: false, soleOwner: false, expiresAt: 1 } } as never) });
  const need = buildNeedsAdmin(r, buildReadiness(r, NOW));
  expect(need.items.map(item => item.id)).toEqual(["approval:apr_a", "spend:spr_a", "rule:lessons-preset", "rule:design-review"]);
  expect(need.items[0]).toMatchObject({ title: "Loosen the company's design review rules", link: { to: "/app/admin/waiting" }, when: "Asked Nov 10, 2026, 10:00 AM UTC", confirmUrl: "https://cell.example/v1/app/approve/apr_a", why: "A protected change waits for a person to confirm. Asked by Maya." });
  expect(need.items[0]!.why).not.toMatch(/org_guardrail/);expect(need.items[0]!.details).toEqual(["Kind: change", "Change: org_guardrail"]);
  expect(need.approvals).toEqual({ total: 1, truncated: false });
  expect(need.items[1]).toMatchObject({ title: "Spending request: More monthly budget", why: "A spending request for $25.00 is waiting for a decision." });
  expect(need.items[3]).toMatchObject({ others: true, link: { to: "/app/admin/how-we-work" } });expect(need.items[3]!.why).toMatch(/You asked/);
  expect(need.unread).toEqual([]);
 });
 it("broken connections and failed checks come from the readiness rows and link to their fix; Unknown rows are not listed as work", () => {
  const r = reads({ github: ok([install("removed")]), projects: ok([project("payments", "failed"), project("web", "unchecked")]) });
  const need = buildNeedsAdmin(r, buildReadiness(r, NOW));
  expect(need.items.map(item => [item.kind, item.link.to])).toEqual([["connection", "/app/admin/connections?open=github"], ["check", "/app/onboard?project=payments&step=setup"]]);
 });
 it("never claims 'nothing' over a read that failed: it names what could not be read", () => {
  const r = reads({ approvals: failed, spend: failed });
  const need = buildNeedsAdmin(r, buildReadiness(r, NOW));
  expect(need.items).toEqual([]);expect(need.unread).toEqual(["approvals waiting in the company", "spending requests"]);
 });
 it("a refused or missing read is unread too: for an owner or admin it is an anomaly, never 'nothing'", () => {
  for (const read of [refused, missing]) {
   const r = reads({ approvals: read, spend: read, preset: read, designReview: read });
   expect(buildNeedsAdmin(r, buildReadiness(r, NOW)).unread).toEqual(["approvals waiting in the company", "spending requests", "company lesson rules", "company design review rules"]);
  }
 });
 it("every read the list depends on is named when it did not answer, the lessons reads included", () => {
  const names: Array<[Partial<ReadinessReads>, string]> = [[{ github: failed }, "the GitHub connection"], [{ githubRequests: failed }, "GitHub installation requests"], [{ connections: refused }, "saved connections"], [{ slack: failed }, "the Slack connection"], [{ sources: failed }, "AI model sources"], [{ projects: failed, lessons: [] }, "project environment checks"], [{ serviceStatus: failed }, "Rovara's service status and team record check"], [{ features: failed }, "the turned-on features"], [{ lessons: [{ project: "payments", read: failed }] }, "team record sources"]];
  for (const [over, words] of names) { const r = reads(over);expect(buildNeedsAdmin(r, buildReadiness(r, NOW)).unread, words).toEqual([words]); }
  const all = reads();expect(buildNeedsAdmin(all, buildReadiness(all, NOW)).unread).toEqual([]);
 });
 it("a failing team record source reaches the list, with the project's Sources tab as its fix", () => {
  const r = reads({ lessons: [{ project: "payments", read: ok({ sources: [{ kind: "slack", scope: "#dev", enabled: true, retention: "30d", health: "failing", audience: "project", updatedAt: "x", paused: false }], otherPaused: 0 } as never) }] });
  expect(buildNeedsAdmin(r, buildReadiness(r, NOW)).items.map(item => [item.title, item.link.to])).toEqual([["Lessons and team record sources", "/app/projects/payments?tab=sources"]]);
 });
 it("every approval the summary lists is an item, the total and the truncated flag come through, and a proposer or kind the summary leaves out is not invented", () => {
  const r = reads({ approvals: ok({ total: 120, truncated: true, approvals: [item("apr_b", { kind: "write", subjectKind: undefined, proposedBy: undefined }), item("apr_c", { kind: "step" })] } as never) });
  const need = buildNeedsAdmin(r, buildReadiness(r, NOW));
  expect(need.items.map(entry => entry.id)).toEqual(["approval:apr_b", "approval:apr_c"]);
  expect(need.approvals).toEqual({ total: 120, truncated: true });
  expect(need.items[0]).toMatchObject({ why: "An agent's change waits for a person to confirm.", details: ["Kind: write"] });
  expect(need.items[1]!.why).toBe("A step of a run waits for a person to confirm. Asked by Maya.");
  // A kind this version does not know is still listed, in general words.
  const odd = reads({ approvals: ok({ total: 1, approvals: [item("apr_d", { kind: "unknown" })] } as never) });
  expect(buildNeedsAdmin(odd, buildReadiness(odd, NOW)).items[0]!.why).toBe("An approval is waiting for a person to confirm. Asked by Maya.");
 });
 it("an empty summary says nothing is waiting, and no total is claimed over a read that did not answer", () => {
  expect(buildNeedsAdmin(reads({ approvals: ok({ total: 0, approvals: [] }) }), buildReadiness(reads(), NOW)).approvals).toEqual({ total: 0, truncated: false });
  const r = reads({ approvals: failed });
  expect(buildNeedsAdmin(r, buildReadiness(r, NOW)).approvals).toBeUndefined();
 });
});

// ---- the screens

const nav = (role: string) => AppNavSchema.parse({ me: { developerId: me, name: "Priya", orgRole: role }, org: { name: "Acme" }, homeCount: 0, projects: [], shared: { agents: [], sessions: [] }, features: { admin: true, localAgents: false, usage: true, chains: false, describe: true, notices: false } });
const connectionsBody = { connections: [{ connectionId: "c1", type: "linear", label: "Linear (team)", hasCredential: true, updatedAt: "2026-11-01T00:00:00Z", lastCheck: { ok: false, at: "2026-11-10T12:00:00Z" } }] };
type Answers = Record<string, ApiResponse>;
const answers = (): Answers => ({
 "/v1/app/github/installations": { status: 200, body: { installations: [{ installationId: 1, accountLogin: "acme", accountType: "Organization", repositorySelection: "all", status: "active" }] } },
 "/v1/app/github/requests": { status: 200, body: { requests: [] } }, "/v1/app/connections": { status: 200, body: connectionsBody },
 "/v1/app/org/slack-workspace-evidence": { status: 200, body: { orgId, checkedAt: "2026-11-11T11:30:00.000Z", kind: "stored_workspace_associations", associationCount: 1, unavailableCount: 0, coverage: "complete", verification: "unverified" } },
 "/v1/app/org/model-sources": { status: 200, body: { sources: [], order: ["rovara"] } },
 "/v1/app/projects": { status: 200, body: { projects: [{ name: "payments", status: "active", latestRevision: 1, repositories: [], myRole: "maintainer", setup: { status: "failed", checkedAt: "2026-11-10T09:00:00.000Z" } }] } },
 "/v1/app/org/service-status": { status: 200, body: service },
 "/v1/app/org/health-observations": { status: 200, body: { orgId, readAt: "2026-11-11T12:00:00.000Z", github: { checked: false }, slack: { checked: false }, modelSource: { checked: false }, modelUse: { checked: false } } },
 "/v1/app/projects/payments/lessons/sources": { status: 200, body: { sources: [{ kind: "slack", scope: "#dev", enabled: true, retention: "30d", health: "ok", audience: "project", updatedAt: "2026-11-10T00:00:00Z", paused: false }], otherPaused: 0 } },
 "/v1/app/org/approvals/pending-summary": { status: 200, body: { total: 2, approvals: [{ approvalId: "apr_aaaaaaaaaaaaaaaaaaaa", kind: "change", subjectKind: "org_guardrail", title: "Loosen the company's design review rules", proposedBy: "Maya", createdAt: "2026-11-10T10:00:00.000Z", confirmUrl: "https://cell.example/v1/app/approve/apr_aaaaaaaaaaaaaaaaaaaa" }], truncated: true } },
 "/v1/app/spend-requests": { status: 200, body: { spendRequests: [{ spendRequestId: "spr_aaaaaaaaaaaaaaaaaaaa", status: "PENDING", createdAt: "2026-11-10T11:00:00.000Z", kind: "month", amountUsd: 25 }] } },
 "/v1/app/org/lessons/preset": { status: 200, body: { preset: "standard" } },
 "/v1/app/org/design-review": { status: 200, body: { revision: 1, allowed: false, lock: {}, unreadable: false } },
});
function mount(options: { on?: boolean; role?: string; path?: string; override?: Answers } = {}) {
 const role = options.role ?? "owner", data = nav(role);
 const identity = { developer: { id: me, name: "Priya", orgRole: role }, org: { orgId, name: "Acme", plan: "team" }, identities: [] };
 const all = { ...answers(), ...options.override };
 const f = fakeHost(async (r: ApiRequest) => { const path = r.path.split("?")[0]!;if (path === "/v1/app/me") return { status: 200, body: identity };if (path === "/v1/app/nav") return { status: 200, body: data };return all[path] ?? { status: 404, body: { error: { code: "NOT_FOUND" } } }; });
 f.storage.set("rovara.theme", "light");if (options.on !== false) f.storage.set(HEALTH_STORAGE_KEY, "v2");
 const query = createQueryClient();query.setQueryData(["nav"], data);
 const router = createMemoryRouter(appRoutes(data.features), { initialEntries: [options.path ?? "/app/admin/health"] });
 const view = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(ThemeProvider, { host: f.host, children: h(RouterProvider, { router }) }) }) }));
 return { ...f, ...view, query, router, close() { view.unmount();router.dispose();query.clear(); } };
}
const called = (f: ReturnType<typeof mount>, path: string) => f.request.mock.calls.filter(([r]) => r.path.split("?")[0] === path).length;
const READ_PATHS = ["/v1/app/org/health-observations", "/v1/app/github/installations", "/v1/app/connections", "/v1/app/org/model-sources", "/v1/app/org/approvals/pending-summary", "/v1/app/spend-requests", "/v1/app/org/lessons/preset", "/v1/app/org/design-review", "/v1/app/projects/payments/lessons/sources"];

describe("the Health page", () => {
 it("off: today's page, and none of the readiness reads are made", async () => {
  const f = mount({ on: false });
  try {
   await screen.findByRole("heading", { name: "Rovara service status" });
   expect(screen.getByText(/stored qualification evidence, not a live availability check/)).toBeTruthy();
   expect(screen.queryByRole("list", { name: "Readiness checks" })).toBeNull();
   await waitFor(() => expect(called(f, "/v1/app/org/service-status")).toBe(1));
   for (const path of READ_PATHS) expect(called(f, path)).toBe(0);
  } finally { f.close(); }
 });
 it("on: every row has a status in words, its source and time, and its one fix; raw facts only under Details; reads only", async () => {
  const f = mount();
  try {
   const list = await screen.findByRole("list", { name: "Readiness checks" });
   await waitFor(() => expect(within(list).getByText("Test environment: payments")).toBeTruthy());
   await waitFor(() => expect(screen.getByRole("status").textContent).toMatch(/checks shown/));
   const rows = within(list).getAllByRole("listitem").filter(item => item.classList.contains("rv-health-row"));
   // Action first, then Unknown, then Healthy: the payments check and the tracker need action; GitHub (no check time), chat, models, lessons and features are Unknown; the team record and Rovara service are computed live.
   expect(rows.map(row => row.getAttribute("data-status"))).toEqual(["action", "action", "unknown", "unknown", "unknown", "unknown", "unknown", "healthy", "healthy"]);
   const tracker = rows.find(row => within(row).queryByText("Tracker: Linear or Jira") !== null)!;
   expect(within(tracker).getByText("Action needed")).toBeTruthy();expect(tracker.textContent).toMatch(/Source: Each connection's own last "Check it works" result/);expect(tracker.textContent).toMatch(/Last checked Nov 10, 2026, 12:00 PM UTC/);
   expect(within(tracker).getByRole("link", { name: "Fix tracker connection" }).getAttribute("href")).toBe("/app/admin/connections?open=linear");
   const chat = rows.find(row => within(row).queryByText("Chat: Slack") !== null)!;
   expect(within(chat).getByText("Unknown")).toBeTruthy();expect(within(chat).queryByText("Healthy")).toBeNull();
   const details = list.querySelectorAll("details");
   expect(details.length).toBeGreaterThan(0);for (const item of details) expect(item.hasAttribute("open")).toBe(false);
   const counts = screen.getByRole("group", { name: "Summary" }).textContent ?? "";
   expect(counts).toBe("Healthy2Action needed2Unknown5");
   expect(f.request.mock.calls.every(([r]) => r.method === "GET")).toBe(true);
   await expectNoAxeViolations(document.body);
  } finally { f.close(); }
 });
 it("on: a read that fails shows Unknown for its row, never Healthy, and Check again reads again", async () => {
  const f = mount({ override: { "/v1/app/github/installations": { status: 500, body: {} } } });
  try {
   const list = await screen.findByRole("list", { name: "Readiness checks" });
   await waitFor(() => expect(screen.getByRole("status").textContent).toMatch(/checks shown/), { timeout: 10000 });
   const code = within(list).getByText("Code host: GitHub").closest("li")!;
   expect(within(code).getByText("Unknown")).toBeTruthy();expect(within(code).queryByText("Healthy")).toBeNull();expect(code.textContent).toMatch(/couldn't read the GitHub connection/);
  } finally { f.close(); }
 });
 it("the runtime pages under Health are today's pages, switch on or off", async () => {
  const f = mount({ path: "/app/admin/health/runtime/web" });
  try { await screen.findByRole("heading", { name: "Rovara service status: browser runtime" });expect(screen.queryByRole("list", { name: "Readiness checks" })).toBeNull(); } finally { f.close(); }
 });
});

describe("the Health page and overview with observations", () => {
 // Times are relative to the real clock here: the screens read it themselves.
 const live = (over: Record<string, unknown>): Answers => ({ "/v1/app/org/health-observations": { status: 200, body: { orgId, readAt: new Date().toISOString(), ...over } } });
 const check = (secondsAgo: number, result = "ok") => ({ checked: true, checkedAt: new Date(Date.now() - secondsAgo * 1000).toISOString(), ageSeconds: secondsAgo, result });
 const rowOf = (list: HTMLElement, title: string) => within(list).getByText(title).closest("li")!;
 it("Health: a fresh passing check turns its row Healthy with 'Checked N minutes ago' and the absolute time in a tooltip; the backup model line sits under the model row; model ids stay under Details", async () => {
  const use = { checked: true, windowHours: 24, usedMain: true, usedFallback: true, lastFallbackAt: "2026-11-11T14:05:00.000Z", lastFallbackAgeSeconds: 600, lastFallbackReason: "DEFAULT_MODEL_UNAVAILABLE" };
  const f = mount({ override: { ...live({ github: check(300), slack: check(120), modelSource: check(900), modelUse: use }), "/v1/app/org/model-sources": { status: 200, body: { sources: [{ sourceId: "src_a", kind: "anthropic", label: "Company Anthropic key", hasCredential: true, models: [{ catalog: { provider: "anthropic", modelId: "claude-secret-model-1" } }] }], order: ["rovara"] } } } });
  try {
   const list = await screen.findByRole("list", { name: "Readiness checks" });
   await waitFor(() => expect(screen.getByRole("status").textContent).toMatch(/checks shown/));
   for (const [title, words] of [["Code host: GitHub", "Checked 5 minutes ago"], ["Chat: Slack", "Checked 2 minutes ago"], ["AI models", "Checked 15 minutes ago"]] as const) {
    const row = rowOf(list, title);
    expect(row.getAttribute("data-status"), title).toBe("healthy");expect(within(row).getByText("Healthy")).toBeTruthy();expect(row.textContent).toMatch(words);
    expect(within(row).getByText(words).closest("time")!.getAttribute("title")).toMatch(/UTC$/);
   }
   const models = rowOf(list, "AI models");
   expect(models.textContent).toMatch(/Rovara used a backup model in the last 24 hours \(the main model was unavailable\); last at 14:05 UTC\./);
   expect(models.textContent).not.toMatch(/DEFAULT_MODEL_UNAVAILABLE/);
   expect(models.querySelector("details")!.hasAttribute("open")).toBe(false);expect(models.querySelector("summary")!.textContent).toBe("Details");expect(models.querySelector("details")!.textContent).toMatch(/claude-secret-model-1/);
   expect(screen.queryByText(/when each check last ran/)).toBeNull();
   expect(f.request.mock.calls.every(([r]) => r.method === "GET")).toBe(true);
   expect(f.request.mock.calls.some(([r]) => r.path === "/v1/app/org/health-observations?expectedOrgId=" + orgId)).toBe(true);
   await expectNoAxeViolations(document.body);
  } finally { f.close(); }
 });
 it("Health and overview agree: a failing check is Action needed on the page and an item with its fix link in What needs an admin, with the same count", async () => {
  const override = live({ github: check(300), slack: check(60, "failed"), modelSource: { checked: false }, modelUse: { checked: false } });
  const f = mount({ override });
  try {
   const list = await screen.findByRole("list", { name: "Readiness checks" });
   await waitFor(() => expect(screen.getByRole("status").textContent).toMatch(/checks shown/));
   const chat = rowOf(list, "Chat: Slack");expect(chat.getAttribute("data-status")).toBe("action");
   expect(within(chat).getByRole("link", { name: "Open Slack connection" }).getAttribute("href")).toBe("/app/admin/connections?open=slack");
   expect(screen.getByRole("group", { name: "Summary" }).textContent).toBe("Healthy3Action needed3Unknown3");
  } finally { f.close(); }
  const g = mount({ path: "/app/admin", override });
  try {
   const section = (await screen.findByRole("heading", { name: "What needs an admin" })).closest("section")!;
   await waitFor(() => expect(within(section).getByText("Chat: Slack")).toBeTruthy());
   const item = within(section).getByText("Chat: Slack").closest("li")!;
   expect(item.textContent).toMatch(/Checked 1 minute ago/);expect(within(item).getByRole("link", { name: "Open Slack connection" }).getAttribute("href")).toBe("/app/admin/connections?open=slack");
   const glance = (await screen.findByRole("heading", { name: "Health at a glance" })).closest("section")!;
   await waitFor(() => expect(glance.textContent).toMatch(/3 action needed/));
   expect(glance.textContent).toMatch(/3 healthy · 3 action needed · 3 unknown/);
  } finally { g.close(); }
 });
 it("Health: with no observations for a feature, its row is Unknown and says never checked, not Healthy", async () => {
  const f = mount();
  try {
   const list = await screen.findByRole("list", { name: "Readiness checks" });
   await waitFor(() => expect(screen.getByRole("status").textContent).toMatch(/checks shown/));
   for (const title of ["Code host: GitHub", "Chat: Slack", "AI models"]) { const row = rowOf(list, title);expect(row.getAttribute("data-status")).toBe("unknown");expect(row.textContent).toMatch(/Never checked/);expect(within(row).queryByText("Healthy")).toBeNull(); }
  } finally { f.close(); }
 });
 it("Health: a 404, 403 or failed observations read keeps today's rows and says so for an owner; the overview names it as unread", async () => {
  for (const status of [404, 403, 500]) {
   const override: Answers = { "/v1/app/org/health-observations": { status, body: status === 404 ? { error: { code: "NOT_FOUND", message: "x" } } : {} } };
   const f = mount({ override });
   try {
    const list = await screen.findByRole("list", { name: "Readiness checks" });
    await waitFor(() => expect(screen.getByRole("status").textContent).toMatch(/checks shown/), { timeout: 10000 });
    expect(screen.getByRole("note").textContent).toMatch(status === 404 ? /This install doesn't say when checks last ran/ : /Couldn't read when each check last ran/);
    const code = rowOf(list, "Code host: GitHub");expect(code.getAttribute("data-status")).toBe("unknown");expect(code.textContent).toMatch(/Check time not recorded/);expect(within(code).queryByText("Healthy")).toBeNull();
   } finally { f.close(); }
   const g = mount({ path: "/app/admin", override });
   try { await screen.findByText(/Couldn't read: .*when each check last ran/, undefined, { timeout: 10000 }); } finally { g.close(); }
  }
 });
 it("off: the observations read is never made", async () => {
  const f = mount({ on: false, path: "/app/admin" });
  try { await screen.findByRole("heading", { name: "Company settings" });expect(called(f, "/v1/app/org/health-observations")).toBe(0); } finally { f.close(); }
 });
});

describe("the admin overview", () => {
 it("off: today's overview; no waiting reads", async () => {
  const f = mount({ on: false, path: "/app/admin" });
  try {
   await screen.findByRole("heading", { name: "Company settings" });
   expect(screen.queryByRole("heading", { name: "What needs an admin" })).toBeNull();
   expect(called(f, "/v1/app/org/approvals/pending-summary")).toBe(0);expect(called(f, "/v1/app/spend-requests")).toBe(0);expect(called(f, "/v1/app/connections")).toBe(0);
  } finally { f.close(); }
 });
 it("on, owner: each Open to review button is named for its own approval and opens that approval's page", async () => {
  const entry = (id: string, title: string) => ({ approvalId: id, kind: "change", title, createdAt: "2026-11-10T10:00:00.000Z", confirmUrl: "https://cell.example/v1/app/approve/" + id });
  const f = mount({ path: "/app/admin", override: { "/v1/app/org/approvals/pending-summary": { status: 200, body: { total: 2, approvals: [entry("apr_aaaaaaaaaaaaaaaaaaaa", "Raise the agent spending guardrail"), entry("apr_bbbbbbbbbbbbbbbbbbbb", "Publish the refunds agent")] } } } });
  try {
   const section = (await screen.findByRole("heading", { name: "What needs an admin" })).closest("section")!;
   const second = await within(section).findByRole("button", { name: "Open to review: Publish the refunds agent" });
   expect(within(section).getByRole("button", { name: "Open to review: Raise the agent spending guardrail" })).toBeTruthy();
   expect(within(section).getAllByRole("button", { name: /^Open to review: / })).toHaveLength(2);expect(second.textContent).toBe("Open to review");
   fireEvent.click(second);expect(f.host.openExternal).toHaveBeenCalledTimes(1);expect(f.host.openExternal).toHaveBeenCalledWith("https://cell.example/v1/app/approve/apr_bbbbbbbbbbbbbbbbbbbb");
  } finally { f.close(); }
 });
 it("on, owner: an approval whose link is not this app's own confirmation address is not opened from the list; the waiting list is offered instead", async () => {
  const f = mount({ path: "/app/admin", override: { "/v1/app/org/approvals/pending-summary": { status: 200, body: { total: 1, approvals: [{ approvalId: "apr_aaaaaaaaaaaaaaaaaaaa", kind: "change", title: "Loosen the company's design review rules", createdAt: "2026-11-10T10:00:00.000Z", confirmUrl: "https://elsewhere.example/v1/app/approve/apr_aaaaaaaaaaaaaaaaaaaa" }] } } } });
  try {
   const section = (await screen.findByRole("heading", { name: "What needs an admin" })).closest("section")!;
   await waitFor(() => expect(within(section).getByText("Loosen the company's design review rules")).toBeTruthy());
   expect(within(section).getByText("1 approval is waiting in the company.")).toBeTruthy();expect(within(section).queryByText(/may be incomplete/)).toBeNull();
   expect(within(section).queryByRole("button", { name: /^Open to review/ })).toBeNull();
  } finally { f.close(); }
 });
 it("on, owner: What needs an admin lists the waiting items with links, and the health counts link to the Health page", async () => {
  const f = mount({ path: "/app/admin" });
  try {
   const heading = await screen.findByRole("heading", { name: "What needs an admin" });
   const section = heading.closest("section")!;
   await waitFor(() => expect(within(section).getByText("Loosen the company's design review rules")).toBeTruthy());
   expect(within(section).getByText("2 approvals are waiting in the company. The list may be incomplete.")).toBeTruthy();
   expect(within(section).getByText(/Asked by Maya/)).toBeTruthy();
   fireEvent.click(within(section).getByRole("button", { name: /^Open to review: Loosen the company's design review rules$/ }));
   expect(f.host.openExternal).toHaveBeenCalledWith("https://cell.example/v1/app/approve/apr_aaaaaaaaaaaaaaaaaaaa");
   expect(within(section).getByText("Spending request: More monthly budget")).toBeTruthy();
   expect(within(section).getByText("Tracker: Linear or Jira")).toBeTruthy();expect(within(section).getByText("Test environment: payments")).toBeTruthy();
   const links = within(section).getAllByRole("link").map(link => link.getAttribute("href"));
   expect(links).toEqual(expect.arrayContaining(["/app/admin/waiting", "/app/admin/connections?open=linear", "/app/onboard?project=payments&step=setup"]));
   expect(section.textContent).not.toMatch(/org_guardrail|PENDING/);
   const glance = (await screen.findByRole("heading", { name: "Health at a glance" })).closest("section")!;
   await waitFor(() => expect(within(glance).getByRole("link", { name: "All checks" }).getAttribute("href")).toBe("/app/admin/health"));
   // The overview reads the team record sources too, so its counts and list agree with the Health page.
   await waitFor(() => expect(called(f, "/v1/app/projects/payments/lessons/sources")).toBe(1));
   expect(screen.getByRole("heading", { name: "People and access" })).toBeTruthy();
  } finally { f.close(); }
 });
 it("on, member: no admin list and none of its reads", async () => {
  const f = mount({ path: "/app/admin", role: "member" });
  try {
   await screen.findByRole("heading", { level: 1 });await waitFor(() => expect(called(f, "/v1/app/me")).toBeGreaterThan(0));
   expect(screen.queryByRole("heading", { name: "What needs an admin" })).toBeNull();
   expect(called(f, "/v1/app/org/approvals/pending-summary")).toBe(0);expect(called(f, "/v1/app/spend-requests")).toBe(0);
  } finally { f.close(); }
 });
 it("on, nothing waiting and every read answered: says so plainly; a failed read is named instead", async () => {
  const quiet: Answers = { "/v1/app/org/approvals/pending-summary": { status: 200, body: { total: 0, approvals: [] } }, "/v1/app/spend-requests": { status: 200, body: { spendRequests: [] } }, "/v1/app/connections": { status: 200, body: { connections: [] } }, "/v1/app/projects": { status: 200, body: { projects: [] } } };
  const f = mount({ path: "/app/admin", override: quiet });
  try { await screen.findByText("Nothing needs an admin right now."); } finally { f.close(); }
  const g = mount({ path: "/app/admin", override: { ...quiet, "/v1/app/org/approvals/pending-summary": { status: 500, body: {} } } });
  try { await screen.findByText(/Couldn't read: approvals waiting in the company/, undefined, { timeout: 10000 }); expect(screen.queryByText("Nothing needs an admin right now.")).toBeNull(); } finally { g.close(); }
 });
});
