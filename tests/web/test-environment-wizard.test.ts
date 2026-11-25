// @vitest-environment jsdom
// Hosted test-environment view and approval remain; its unfinished mutation controls are hidden.
import { expect, it } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { TestEnvironmentBodySchema, TestEnvironmentStateSchema } from "@agentx/contracts/web";
import { AppHostProvider } from "../../packages/ui/src/host.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { OnboardScreen } from "../../packages/ui/src/screens/onboarding/OnboardScreen.js";
import { fakeHost } from "./support/fake-host.js";
import { renderUi } from "./support/render.js";
import { h } from "./support/h.js";
import { expectNoAxeViolations } from "./support/axe.js";

const DIGEST = "a".repeat(64);
const me = { developer: { id: "a".repeat(64), name: "Maya", orgRole: "owner" }, org: { orgId: "org_aaaaaaaaaaaaaaaaaaaa", name: "Acme", plan: "cloud", nameIsDefault: false }, identities: [] };
const command = (executable: string, args: string[], timeoutSeconds: number) => ({ cwd: "repo/web", executable, args, timeoutSeconds });
const ENVIRONMENT = TestEnvironmentBodySchema.parse({
  tier: "sandbox",
  repos: [{ repositoryId: "web", setupCommands: [command("npm", ["ci"], 900)], checks: [{ id: "unit", label: "Unit tests", command: command("npm", ["test"], 1800), kind: "test", selectArgs: ["{tests}"] }] }],
  roundBudgetMin: 30, selection: { method: "coverage_map", alwaysRun: [], fullSuiteOn: [] }, nightly: { enabled: false, cronUtc: "0 6 * * *", branch: "main" },
  services: [], data: { seeds: [], generator: "faker_seeded", seed: 1 }, accounts: [], prodDeny: { accountIds: [], hosts: [], arnPrefixes: [] }, capture: { screenshots: "failed", video: false, traces: false },
});
const SUMMARY = { tier: "sandbox", repositories: [{ repositoryId: "web", setupCommands: 1, checks: [{ id: "unit", label: "Unit tests", kind: "test", selectArgs: ["{tests}"] }] }], selectionMethod: "coverage_map", roundBudgetMin: 30, nightly: { enabled: false, cronUtc: "0 6 * * *", branch: "main" }, services: 0 };
const PROPOSAL = {
  digest: DIGEST, source: "setup", risk: "medium", lessSafe: [], summary: SUMMARY, environment: ENVIRONMENT,
  runs: [{ repositoryId: "web", setup: ["npm ci"], checks: [{ id: "unit", label: "Unit tests", kind: "test", command: "npm test", selectArgs: ["{tests}"] }] }],
  valueSources: [{ field: "repos[0].setupCommands[0]", source: { path: "package.json", line: 4 } }, { field: "repos[0].checks[0]", source: "detector:node" }],
  proved: false, proveSteps: [], needs: { freshSignIn: false, secondPerson: false }, approval: { status: "none" }, commandsNotInSettings: 0,
};
const state = (over: Record<string, unknown> = {}) => TestEnvironmentStateSchema.parse({ draft: { status: "ready", notes: ["Found a package.json."], questions: [], pendingServices: [] }, ...over });
const project = (status = "unchecked", revision = 2, role = "maintainer") => ({
  name: "web", description: "Customer fixes", status: "active", latestRevision: revision, repositories: [{ fullName: "acme/web", defaultBranch: "main" }], myRole: role,
  setup: { status, ...(status === "ready" ? { checkedRevision: revision, checkedAt: "2026-11-01T12:00:00.000Z" } : {}) }, settings: { setupCommands: [], testCommands: [], devcontainer: null, allowedDomains: [] },
  createdAt: "2026-10-23T12:00:00.000Z", createdBy: { developerId: "a".repeat(64), name: "Maya" },
});
interface Options { role?: string; share?: { status: number; body: unknown }; read?: { status: number; body: unknown }; setupStatus?: string; answers?: Record<string, { status: number; body: unknown }> }
function setup(options: Options = {}) {
  let current = options.read ?? { status: 200, body: state() };
  const f = fakeHost(async (request) => {
    if (request.path === "/v1/app/me") return { status: 200, body: me };
    if (request.path === "/v1/app/projects/web/machine-size") return { status: 501, body: { status: "not_set_up", message: "Machine size suggestions are not set up on Rovara Code yet." } };
    if (request.path === "/v1/app/github/installations") return { status: 200, body: { installations: [{ installationId: 55, accountLogin: "acme", accountType: "Organization", repositorySelection: "selected", status: "active" }] } };
    if (request.path === "/v1/app/projects/web") return { status: 200, body: project(options.setupStatus ?? "unchecked", 2, options.role) };
    if (request.path === "/v1/app/projects/web/setup-recipe") return options.share ?? { status: 404, body: { error: { code: "NOT_FOUND", message: "Not found." } } };
    if (request.path === "/v1/app/projects/web/setup-draft") return { status: 200, body: { status: "none", basedOnRevision: 2, requestId: "g" } };
    if (request.path === "/v1/app/projects/web/test-environment" && request.method === "GET") return { status: current.status, body: current.status === 200 ? { ...(current.body as object), requestId: "gateway-1" } : current.body };
    const answer = options.answers?.[request.path.replace("/v1/app/projects/web/test-environment", "")];
    if (answer !== undefined) {
      if (answer.status === 200 && typeof answer.body === "object" && answer.body !== null && "state" in answer.body) current = { status: 200, body: answer.body.state };
      else if (answer.status === 200) current = { status: 200, body: answer.body };
      return { status: answer.status, body: answer.status === 200 ? { ...(answer.body as object), requestId: "gateway-2" } : answer.body };
    }
    return { status: 200, body: { project: project(), warnings: [] } };
  });
  const query = createQueryClient();
  const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(MemoryRouter, { initialEntries: ["/app/onboard?project=web&step=setup"], children: h(OnboardScreen) }) }) }), { theme: "light" });
  return { ...f, close() { ui.unmount(); query.clear(); } };
}
const posts = (f: ReturnType<typeof setup>, suffix: string) => f.request.mock.calls.map(([r]) => r).filter((r) => r.method === "POST" && r.path.endsWith(suffix));
const section = async () => {
  const region = await screen.findByRole("region", { name: "Test environment" });
  await waitFor(() => expect(within(region).queryByText("Loading the test environment.")).toBeNull());
  return region;
};

it("hides hosted test-environment editing controls while keeping the read view accessible", async () => {
  const f = setup();
  const region = await section();
  expect(within(region).getByText("Found a package.json.")).toBeTruthy();
  for (const name of ["Propose a test environment", "Run the check", "Prove it", "Edit this proposal", "Ask a second person to confirm", "Apply"]) {
    expect(within(region).queryByRole("button", { name })).toBeNull();
  }
  expect(f.request.mock.calls.some(([request]) => request.method !== "GET" && request.path.includes("test-environment"))).toBe(false);
  await expectNoAxeViolations(region);
  f.close();
});

it("shows nothing at all while the feature is off (the server answers not found)", async () => {
  const f = setup({ read: { status: 404, body: { error: { code: "NOT_FOUND", message: "This item wasn't found." } } } });
  await screen.findByRole("heading", { name: "Setup" });
  await waitFor(() => expect(f.request.mock.calls.some(([r]) => r.path.endsWith("/test-environment"))).toBe(true));
  expect(screen.queryByRole("region", { name: "Test environment" })).toBeNull();
  expect(screen.queryByText("Test environment")).toBeNull();
  f.close();
});

it("hides a hosted test-environment section answered with 501 without offering a retry", async () => {
  const f = setup({ read: { status: 501, body: { error: { code: "NOT_ON_CODE_YET", message: "Not available yet." } } } });
  await screen.findByRole("heading", { name: "Setup" });
  await waitFor(() => expect(f.request.mock.calls.some(([request]) => request.path.endsWith("/test-environment"))).toBe(true));
  expect(screen.queryByRole("region", { name: "Test environment" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  await expectNoAxeViolations(document.body);
  f.close();
});

it("shows nothing when the server answers in a shape this page can't read", async () => {
  const f = setup({ read: { status: 200, body: { unexpected: true } } });
  await screen.findByRole("heading", { name: "Setup" });
  await waitFor(() => expect(f.request.mock.calls.some(([r]) => r.path.endsWith("/test-environment"))).toBe(true));
  await waitFor(() => expect(screen.queryByText("Loading the test environment.")).toBeNull());
  expect(screen.queryByRole("region", { name: "Test environment" })).toBeNull();
  f.close();
});

it("keeps the proposal view and approval while hiding proposal mutations", async () => {
  const f = setup({ read: { status: 200, body: state({ proposal: PROPOSAL }) } });
  const region = await section();
  const setupList = within(region).getByRole("list", { name: "Setup commands for web" });
  expect(within(setupList).getByText("npm ci")).toBeTruthy();
  expect(within(setupList).getByText(/package\.json/)).toBeTruthy();
  expect(within(setupList).queryByText(/line 4/)).toBeNull();
  const checks = within(region).getByRole("list", { name: "Checks for web" });
  expect(within(checks).getByText("npm test")).toBeTruthy();
  expect(within(checks).getByText("{tests}")).toBeTruthy();
  expect(within(checks).getByText(/Found by the node detector/)).toBeTruthy();
  expect(within(region).getByText("Rovara's proposal")).toBeTruthy();
  expect(within(region).getByRole("button", { name: "Approve" })).toHaveProperty("disabled", true);
  for (const name of [/Propose/, /Run the check/, /Prove it/, /Edit this proposal/, /Ask a second person/, /Apply/, /Write the approved commands/]) expect(within(region).queryByRole("button", { name })).toBeNull();
  expect(f.request.mock.calls.some(([request]) => request.method !== "GET" && request.path.includes("test-environment"))).toBe(false);
  await expectNoAxeViolations(region);
  f.close();
});

it("a proved proposal is approved with the revision it was looked at against, and the approved environment is shown", async () => {
  const proved = { ...PROPOSAL, proved: true, proveSteps: [{ step: "setup", status: "passed" }, { step: "full_suite", status: "passed" }] };
  const approved = { revision: 1, digest: DIGEST, replayed: false, state: state({ approved: { revision: 1, approvedAt: "2026-11-01T12:00:00.000Z", digest: DIGEST, summary: SUMMARY } }) };
  const f = setup({ read: { status: 200, body: state({ proposal: proved }) }, answers: { "/approve": { status: 200, body: approved } } });
  const region = await section();
  expect(within(region).getByText(/Proved: the check ran these commands/)).toBeTruthy();
  fireEvent.click(within(region).getByRole("button", { name: "Approve" }));
  await within(region).findByText(/Approved: revision 1/);
  const [call] = posts(f, "/test-environment/approve");
  expect(call!.body).toMatchObject({ digest: DIGEST, expectedRevision: 0 });
  expect(typeof (call!.body as { requestId: string }).requestId).toBe("string");
  f.close();
});

const LESS_SAFE = { ...PROPOSAL, source: "edited", risk: "high", lessSafe: ["nightly_enabled"], proved: true, needs: { freshSignIn: true, secondPerson: true } };

it("an already-confirmed change remains approvable without a step-up prompt", async () => {
  const f = setup({ read: { status: 200, body: state({ proposal: { ...LESS_SAFE, approval: { status: "approved" } } }) }, answers: { "/approve": { status: 403, body: { error: { code: "REAUTH_REQUIRED", message: "Sign in again to approve this change." } } } } });
  const region = await section();
  expect(within(region).getByText(/Confirmed by a second person/)).toBeTruthy();
  fireEvent.click(within(region).getByRole("button", { name: "Approve" }));
  expect((await within(region).findByRole("alert")).textContent).toContain("Sign in again to approve this change.");
  expect(within(region).queryByRole("button", { name: /confirm it's you/i })).toBeNull();
  expect(f.host.signIn).not.toHaveBeenCalled();
  f.close();
});

it("hides edit and request-approval controls for unconfirmed proposals", async () => {
  const f = setup({ read: { status: 200, body: state({ proposal: PROPOSAL }) } });
  const region = await section();
  for (const name of [/Edit/, /Propose/, /Run the check/, /Prove it/, /Ask a second person/, /Apply/]) expect(within(region).queryByRole("button", { name })).toBeNull();
  expect(f.request.mock.calls.some(([request]) => request.method !== "GET" && request.path.includes("test-environment"))).toBe(false);
  f.close();
});

it("offers a maintainer 'Share as company recipe' under the approved environment, only when recipes are on and the setup is fully in the settings (F8)", async () => {
  const approved = { revision: 1, approvedAt: "2026-11-01T12:00:00.000Z", digest: DIGEST, summary: SUMMARY };
  const share = { status: 200, body: { repositories: ["web"], markerFiles: ["package.json"], hasApprovedEnvironment: true } };
  const on = setup({ read: { status: 200, body: state({ approved }) }, share });
  expect(await screen.findByRole("region", { name: "Company recipe" })).toBeTruthy();
  on.close();
  const off = setup({ read: { status: 200, body: state({ approved }) } });
  await section();
  await waitFor(() => expect(off.request.mock.calls.some(([r]) => r.path.endsWith("/setup-recipe"))).toBe(true));
  expect(screen.queryByRole("region", { name: "Company recipe" })).toBeNull();
  off.close();
  const none = setup({ read: { status: 200, body: state() }, share });
  await section();
  expect(screen.queryByRole("region", { name: "Company recipe" })).toBeNull();
  none.close();
  // A viewer's page never asks (no refusal logged), even with recipes on and an approved environment.
  const viewer = setup({ read: { status: 200, body: state({ approved }) }, share, role: "viewer" });
  await section();
  await waitFor(() => expect(viewer.request.mock.calls.some(([r]) => r.path.endsWith("/test-environment"))).toBe(true));
  expect(viewer.request.mock.calls.some(([r]) => r.path.endsWith("/setup-recipe"))).toBe(false);
  expect(screen.queryByRole("region", { name: "Company recipe" })).toBeNull();
  viewer.close();
});
