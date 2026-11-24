// A world for the project's Setup tab: the project page opened at ?tab=setup on a fake host whose setup reads (the checklist, the setup run, its journal, the repair read, the limits) are held in plain objects a test changes
// between reads. Every request is recorded (`f.request`). A route the world does not know answers 404, as Code does for a route it does not serve.
import { MemoryRouter, Route, Routes } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import type { ApiRequest, ApiResponse } from "../../../packages/ui/src/host.js";
import { AppHostProvider } from "../../../packages/ui/src/host.js";
import { createQueryClient } from "../../../packages/ui/src/api/query.js";
import { Announcer } from "../../../packages/ui/src/design/Announcer.js";
import { ProjectScreen } from "../../../packages/ui/src/screens/project/ProjectScreen.js";
import { fakeHost } from "./fake-host.js";
import { renderUi } from "./render.js";
import { h } from "./h.js";
import { meFixture } from "./fixtures.js";
import { projectFixture } from "./project-fixture.js";

export const DEFAULTS = { commands: 40, sameStepTries: 3, wallClockMin: 45, budgetCents: 400, hostAsks: 5 };
export const MAXIMA = { commands: 120, sameStepTries: 5, wallClockMin: 120, budgetCents: 2000, hostAsks: 10 };
export const DIGEST = "ab12".repeat(16);
export const err = (status: number, code: string, message: string) => ({ status, body: { error: { code, message } } });
export const ask = (host: string, over: Record<string, unknown> = {}) => ({ host, status: "open", journalN: 1, canDecide: true, approval: { requestId: `host-${host.replace(/[^a-z0-9]/gu, "").padEnd(12, "0").slice(0, 40)}`, revision: 1, artifactDigest: DIGEST, kind: "setup_host", risk: "high" }, ...over });
export const entry = (n: number, command: string, exitCode: number | null, over: Record<string, unknown> = {}) => ({ n, source: "agent", command, exitCode, durationMs: 4000, timedOut: false, flagged: false, blockedHosts: [], tail: "", startedAt: "2026-11-24T10:00:00.000Z", ...over });
export const apply = (over: Record<string, unknown> = {}) => ({
  candidateRevision: 4, baseRevision: 3, setup: ["npm ci"], readiness: ["npm test"], check: { status: "ready" }, risk: "low", changes: [{ area: "setup_commands", risk: "low" }, { area: "test_commands", risk: "low" }],
  approver: "maintainer", canApprove: true, canReject: true, approval: { requestId: `setup-${DIGEST.slice(0, 40)}-4`, revision: 4, artifactDigest: DIGEST, kind: "setup", risk: "low" }, ...over,
});
const item = (id: string, value: unknown) => ({ id, value, from: [{ kind: "file", repo: "payments", path: "package.json", commit: "a".repeat(40), line: 3, quote: "\"ci\": \"npm ci\"" }], confidence: "high", risk: "safe" });
export const PROPOSAL = { version: 2, basedOnRevision: 2, repositories: [], setup: [item("setup-payments", { repo: "payments", commands: ["npm ci"] })], tests: [item("tests-payments", { repo: "payments", commands: ["npm test"] })], checks: [], testEnvironment: [], knowledge: [], sources: [], intake: [], allowedDomains: [], secretsNeeded: [], flaggedCommands: [], foundNotUsed: [], notes: "" };

export interface World {
  /** The checklist's Setup run row, merged over a failed run's. */
  row: Record<string, unknown>;
  /** The setup run's read. */
  run: Record<string, unknown>;
  entries: unknown[];
  asks: unknown[];
  /** `undefined`: Code does not serve the journal. */
  repair: unknown;
  /** The limits read: undefined is a 404. */
  limits: ReturnType<typeof limitsView> | "unavailable" | "forbidden" | undefined;
  /** Answers for POST and PUT routes; return undefined for the world's own answer. */
  write: (request: ApiRequest, world: World) => ApiResponse | Promise<ApiResponse> | undefined;
  /** Every route a test wants to answer itself. */
  route: (request: ApiRequest, world: World) => ApiResponse | Promise<ApiResponse> | undefined;
  canEdit: boolean;
  role: "owner" | "admin" | "member";
  firstTask: { canStart: boolean; hasTask: boolean };
}
export const limitsView = (over: Partial<{ revision: number; limits: Record<string, number>; companyLock: Record<string, number>; effective: Partial<typeof DEFAULTS> }> = {}) => ({ revision: 0, limits: {} as Record<string, number>, companyLock: {} as Record<string, number>, defaults: DEFAULTS, maxima: MAXIMA, ...over, effective: { ...DEFAULTS, ...over.effective } });
export type WorldWrite = World["write"];
export const failedRow = (over: Record<string, unknown> = {}) => ({ state: "failed", status: "failed", approval: "none", startedAt: "2026-11-24T10:00:00.000Z", elapsedMs: 192_000, costCents: 40, commandsRun: 12, commandsFound: { setup: 1, tests: 1 }, testOutcome: "failed", failure: "A test command failed.", failedCommand: { n: 2, command: "npm test", exitCode: 1, timedOut: false, lastLines: ["FAIL src/app.test.ts"] }, ...over });
export const checklistOf = (row: Record<string, unknown>, first: World["firstTask"], extra: Record<string, unknown> = {}) => ({
  project: "payments", viewer: { companyRole: "owner", projectAdmin: false, canSkip: true }, progress: { done: 2, total: 8, percent: 25, nextRequired: "setupRun" },
  repos: { state: "done", count: 1, items: [{ name: "payments", fullName: "acme/payments", defaultBranch: "main" }] }, setupRun: row,
  evalConfirm: { state: "needs_you", report: "none", blockedBy: "setupRun" }, aiAndSpend: { state: "done", source: "default", companyModelSaved: false, modelBudgetUsd: null },
  slackChannel: { state: "optional", channels: [] }, linear: { state: "optional", team: null }, invites: { state: "optional" }, firstTask: { state: "needs_you", ...first }, ...extra,
});

export function mountSetupTab(initial: Partial<World> = {}, options: { path?: string } = {}) {
  const world: World = {
    row: failedRow(), run: { status: "failed", basedOnRevision: 3, limits: DEFAULTS, canManage: true, failure: "A test command failed." }, entries: [], asks: [], repair: undefined, limits: limitsView(),
    write: () => undefined, route: () => undefined, canEdit: true, role: "owner", firstTask: { canStart: false, hasTask: false }, ...initial,
  };
  const f = fakeHost(async request => {
    const path = request.path.split("?")[0]!, base = "/v1/app/projects/payments";
    const custom = await world.route(request, world);
    if (custom !== undefined) return custom;
    if (path === "/v1/app/changes") return { status: 200, body: { notices: [], next: "settled" } };
    if (path === `${base}/machine-size`) return err(501, "NOT_ON_CODE_YET", "Machine size suggestions are not set up on Rovara Code yet.");
    if (path === `${base}/overview`) return { status: 200, body: projectFixture(world.canEdit ? {} : { you: { role: "contributor", canStartWork: true, canEditSettings: false, canViewSpend: false } }) };
    if (path === `${base}/setup-status`) return { status: 200, body: checklistOf(world.row, world.firstTask) };
    if (path === "/v1/app/me") { const me = meFixture(); me.developer.orgRole = world.role; return { status: 200, body: me }; }
    if (request.method !== "GET") { const written = await world.write(request, world); if (written !== undefined) return written; }
    if (path === `${base}/setup-agent` && request.method === "GET") return { status: 200, body: { basedOnRevision: 3, limits: DEFAULTS, ...world.run } };
    if (path === `${base}/setup-agent/journal`) return { status: 200, body: { status: world.run["status"], entries: world.entries, hostAsks: world.asks } };
    if (path === `${base}/setup-repair`) return world.repair === undefined ? err(501, "NOT_ON_CODE_YET", "Setup repair isn't available on this Rovara yet.") : { status: 200, body: world.repair };
    if (path === `${base}/setup-agent/limits`) {
      if (world.limits === undefined) return err(404, "NOT_FOUND", "Not found.");
      if (world.limits === "unavailable") return err(501, "NOT_ON_CODE_YET", "Not served.");
      if (world.limits === "forbidden") return err(403, "FORBIDDEN", "No.");
      if (request.method === "GET") return { status: 200, body: world.limits };
    }
    return err(404, "NOT_FOUND", "Not found.");
  });
  const query = createQueryClient();
  const element = h(MemoryRouter, { initialEntries: [options.path ?? "/app/projects/payments?tab=setup"], children: h(Announcer, { children: h(Routes, { children: h(Route, { path: "/app/projects/:name", element: h(ProjectScreen, {}) }) }) }) });
  const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: element }) }), { theme: "light" });
  const sent = (method: string, suffix: string) => f.request.mock.calls.map(([request]) => request).filter(request => request.method === method && request.path.split("?")[0]!.endsWith(suffix));
  return { ...f, ...ui, query, world, sent, close() { ui.unmount(); query.clear(); } };
}
export type SetupWorld = ReturnType<typeof mountSetupTab>;
