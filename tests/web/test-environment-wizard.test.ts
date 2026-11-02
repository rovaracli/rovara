// @vitest-environment jsdom
// Setup wizard (E4): the Setup step's test-environment section. Each state it can be in: the feature off (nothing shown), loading, a failed read, no draft, a stale draft, a draft to propose, a proposal (what will
// run with each value's source, the proof, the commands to add to the settings), the approvals (one press; a second person's confirmation; sign in again), an edit, and the approved environment.
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
const project = (status = "unchecked", revision = 2) => ({
  name: "web", description: "Customer fixes", status: "active", latestRevision: revision, repositories: [{ fullName: "acme/web", defaultBranch: "main" }], myRole: "maintainer",
  setup: { status, ...(status === "ready" ? { checkedRevision: revision, checkedAt: "2026-11-01T12:00:00.000Z" } : {}) }, settings: { setupCommands: [], testCommands: [], devcontainer: null, allowedDomains: [] },
  createdAt: "2026-10-23T12:00:00.000Z", createdBy: { developerId: "a".repeat(64), name: "Maya" },
});
interface Options { read?: { status: number; body: unknown }; setupStatus?: string; answers?: Record<string, { status: number; body: unknown }> }
function setup(options: Options = {}) {
  let current = options.read ?? { status: 200, body: state() };
  const f = fakeHost(async (request) => {
    if (request.path === "/v1/app/me") return { status: 200, body: me };
    if (request.path === "/v1/app/github/installations") return { status: 200, body: { installations: [{ installationId: 55, accountLogin: "acme", accountType: "Organization", repositorySelection: "selected", status: "active" }] } };
    if (request.path === "/v1/app/projects/web") return { status: 200, body: project(options.setupStatus ?? "unchecked") };
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

it("shows nothing at all while the feature is off (the server answers not found)", async () => {
  const f = setup({ read: { status: 404, body: { error: { code: "NOT_FOUND", message: "This item wasn't found." } } } });
  await screen.findByRole("heading", { name: "Setup" });
  await waitFor(() => expect(f.request.mock.calls.some(([r]) => r.path.endsWith("/test-environment"))).toBe(true));
  expect(screen.queryByRole("region", { name: "Test environment" })).toBeNull();
  expect(screen.queryByText("Test environment")).toBeNull();
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

it("says it is loading, and offers a retry when the read fails", async () => {
  const f = setup({ read: { status: 403, body: { error: { code: "FORBIDDEN", message: "Not allowed." } } } });
  expect(await screen.findByText("Couldn't load the test environment.")).toBeTruthy();
  const region = await screen.findByRole("region", { name: "Test environment" });
  expect(within(region).getByRole("alert").textContent).toContain("Couldn't load");
  expect(within(region).getByRole("button", { name: "Try again" })).toBeTruthy();
  f.close();
});

it("asks the person to have Rovara propose the setup first when there is no draft, and says a stale draft is old", async () => {
  const none = setup({ read: { status: 200, body: state({ draft: { status: "none", notes: [], questions: [], pendingServices: [] } }) } });
  expect(await screen.findByText(/Ask Rovara to propose the setup above first/)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Propose a test environment" })).toBeNull();
  none.close();
  const stale = setup({ read: { status: 200, body: state({ draft: { status: "stale", notes: [], questions: [], pendingServices: [] } }) } });
  expect(await screen.findByText(/older than the project's settings/)).toBeTruthy();
  stale.close();
});

it("shows what Rovara found and proposes it with an empty request", async () => {
  const f = setup({ read: { status: 200, body: state({ draft: { status: "ready", notes: ["Found a package.json."], questions: ["Which Node version?"], pendingServices: [] } }) }, answers: { "/propose": { status: 200, body: state({ proposal: PROPOSAL }) } } });
  const region = await section();
  expect(within(region).getByText("Found a package.json.")).toBeTruthy();
  expect(within(region).getByText("Which Node version?")).toBeTruthy();
  fireEvent.click(within(region).getByRole("button", { name: "Propose a test environment" }));
  await waitFor(() => expect(posts(f, "/test-environment/propose")).toHaveLength(1));
  expect(posts(f, "/test-environment/propose")[0]!.body).toEqual({});
  await within(region).findByText("What will run");
  f.close();
});

it("a proposal says what will run, with the arguments that narrow the tests and where each value came from, and Approve waits for the proof", async () => {
  const f = setup({ read: { status: 200, body: state({ proposal: PROPOSAL }) } });
  const region = await section();
  const setupList = within(region).getByRole("list", { name: "Setup commands for web" });
  expect(within(setupList).getByText("npm ci")).toBeTruthy();
  expect(within(setupList).getByText(/package\.json, line 4/)).toBeTruthy();
  const checks = within(region).getByRole("list", { name: "Checks for web" });
  expect(within(checks).getByText("npm test")).toBeTruthy();
  expect(within(checks).getByText("{tests}")).toBeTruthy();
  expect(within(checks).getByText(/Found by the node detector/)).toBeTruthy();
  expect(within(region).getByText("Rovara's proposal")).toBeTruthy();
  expect(within(region).getByRole("button", { name: "Approve" })).toHaveProperty("disabled", true);
  // TE-2: the proposal has its own check first; there is nothing to prove until it passed, and the commands are not added to the settings before approval.
  expect(within(region).getByRole("button", { name: "Prove it" })).toHaveProperty("disabled", true);
  expect(within(region).getByRole("button", { name: "Run the check" })).toHaveProperty("disabled", false);
  expect(within(region).queryByRole("button", { name: "Add these commands to the project's settings" })).toBeNull();
  await expectNoAxeViolations(region);
  f.close();
});

it("proves the proposal from its passed check, and says why in the server's words when it can't", async () => {
  const f = setup({ read: { status: 200, body: state({ proposal: { ...PROPOSAL, check: { status: "ready" } } }) }, answers: { "/prove": { status: 400, body: { error: { code: "CONFIG_INVALID", message: "Some of the proposed commands are not among the commands the check ran." } } } } });
  const region = await section();
  fireEvent.click(within(region).getByRole("button", { name: "Prove it" }));
  expect((await within(region).findByRole("alert")).textContent).toContain("not among the commands the check ran");
  expect(posts(f, "/test-environment/prove")[0]!.body).toEqual({ digest: DIGEST });
  f.close();
});

it("runs the proposal's own check, shows it running and shows how a failed one failed, with no command added to the settings", async () => {
  const running = { ...PROPOSAL, commandsNotInSettings: 2, check: { status: "checking" } };
  const f = setup({ read: { status: 200, body: state({ proposal: { ...PROPOSAL, commandsNotInSettings: 2 } }) }, answers: { "/check": { status: 200, body: state({ proposal: running }) } } });
  const region = await section();
  expect(within(region).getByText(/2 of them are not in the settings yet; approving adds them/)).toBeTruthy();
  fireEvent.click(within(region).getByRole("button", { name: "Run the check" }));
  await within(region).findByText("The check is running.");
  const [call] = posts(f, "/test-environment/check");
  expect(call!.body).toMatchObject({ digest: DIGEST });
  expect(Object.keys(call!.body as object).sort()).toEqual(["digest", "requestId"]);
  expect(posts(f, "/test-environment/apply-commands")).toEqual([]);
  f.close();
  const failed = setup({ read: { status: 200, body: state({ proposal: { ...PROPOSAL, check: { status: "failed", failedStep: "setup: npm ci - exited 1" } } }) } });
  const failedRegion = await section();
  expect((await within(failedRegion).findByRole("alert")).textContent).toContain("The check failed: setup: npm ci - exited 1");
  expect(within(failedRegion).getByRole("button", { name: "Run the check again" })).toBeTruthy();
  failed.close();
});

it("S2: when an approved command is not in the settings, offers the check of the approved environment first, then writes exactly the approved commands, and loads the saved settings", async () => {
  const approvedState = (missing: number, check: Record<string, unknown>) => state({ approved: { revision: 1, approvedAt: "2026-11-01T12:00:00.000Z", digest: DIGEST, summary: SUMMARY, commandsNotInSettings: missing, check } });
  const f = setup({ read: { status: 200, body: approvedState(2, { status: "unchecked" }) }, answers: { "/check": { status: 200, body: approvedState(2, { status: "ready" }) } } });
  const region = await section();
  expect(within(region).getByText(/2 approved commands are not in the project's settings yet/)).toBeTruthy();
  expect(within(region).queryByRole("button", { name: "Write the approved commands to the project's settings" })).toBeNull();
  fireEvent.click(within(region).getByRole("button", { name: "Run the check" }));
  await within(region).findByText("The check passed at the current settings.");
  expect(posts(f, "/test-environment/check")[0]!.body).toMatchObject({ digest: DIGEST });
  f.close();
  const applied = { added: ["npm ci", "npm test"], skipped: [{ reason: "different_directory", count: 1 }], settingsRevision: 3, setupCheck: "started", state: approvedState(0, { status: "unchecked" }) };
  const g = setup({ read: { status: 200, body: approvedState(2, { status: "ready" }) }, answers: { "/apply-commands": { status: 200, body: applied } } });
  const again = await section();
  fireEvent.click(within(again).getByRole("button", { name: "Write the approved commands to the project's settings" }));
  await waitFor(() => expect(posts(g, "/test-environment/apply-commands")).toHaveLength(1));
  const [call] = posts(g, "/test-environment/apply-commands");
  expect(call!.body).toMatchObject({ digest: DIGEST, expectedRevision: 2 });
  expect(Object.keys(call!.body as object).sort()).toEqual(["digest", "expectedRevision", "requestId"]);
  await waitFor(() => expect(g.request.mock.calls.filter(([r]) => r.path === "/v1/app/projects/web" && r.method === "GET").length).toBeGreaterThan(1));
  await waitFor(() => expect(within(again).queryByRole("button", { name: "Write the approved commands to the project's settings" })).toBeNull());
  g.close();
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

it("a less-safe change says so in plain words, and is not approved by one press: it asks for a second person", async () => {
  const f = setup({ read: { status: 200, body: state({ approved: { revision: 1, approvedAt: "2026-11-01T12:00:00.000Z", digest: "b".repeat(64), summary: SUMMARY }, proposal: LESS_SAFE }) },
    answers: { "/request-approval": { status: 200, body: { status: "pending", confirmUrl: "https://cell.example/v1/app/approve/apr_abcdefghij0123456789", state: state({ proposal: { ...LESS_SAFE, approval: { status: "pending" } } }) } } } });
  const region = await section();
  expect(within(region).getByText("Your edited proposal")).toBeTruthy();
  expect(within(region).getByText(/runs the whole test suite every night, which costs money/)).toBeTruthy();
  expect(within(region).getByText(/needs a second person to confirm it, and you to sign in again/)).toBeTruthy();
  expect(within(region).queryByRole("button", { name: "Approve" })).toBeNull();
  fireEvent.click(within(region).getByRole("button", { name: "Ask a second person to confirm" }));
  await within(region).findByText("Waiting for a second person to confirm.");
  expect(posts(f, "/test-environment/request-approval")[0]!.body).toEqual({ digest: DIGEST, expectedRevision: 1 });
  expect(within(region).getByRole("link", { name: "Open the confirmation page" }).getAttribute("href")).toBe("https://cell.example/v1/app/approve/apr_abcdefghij0123456789");
  expect(within(region).getByRole("button", { name: "Check again" })).toBeTruthy();
  f.close();
});

it("never links to a confirmation address that isn't this cell's confirmation page", async () => {
  const f = setup({ read: { status: 200, body: state({ proposal: LESS_SAFE }) },
    answers: { "/request-approval": { status: 200, body: { status: "pending", confirmUrl: "https://evil.example/v1/app/approve/apr_abcdefghij0123456789", state: state({ proposal: { ...LESS_SAFE, approval: { status: "pending" } } }) } } } });
  const region = await section();
  fireEvent.click(within(region).getByRole("button", { name: "Ask a second person to confirm" }));
  await within(region).findByText("Waiting for a second person to confirm.");
  expect(within(region).queryByRole("link", { name: "Open the confirmation page" })).toBeNull();
  f.close();
});

it("once a second person confirmed, the asker finishes the approval; an old sign-in asks them to sign in again", async () => {
  const f = setup({ read: { status: 200, body: state({ proposal: { ...LESS_SAFE, approval: { status: "approved" } } }) }, answers: { "/approve": { status: 403, body: { error: { code: "REAUTH_REQUIRED", message: "Sign in again to approve this change." } } } } });
  const region = await section();
  expect(within(region).getByText(/Confirmed by a second person/)).toBeTruthy();
  fireEvent.click(within(region).getByRole("button", { name: "Approve" }));
  const alert = await within(region).findByRole("alert");
  expect(alert.textContent).toContain("Sign in again to approve this change.");
  fireEvent.click(within(alert).getByRole("button", { name: "Sign in again" }));
  expect(f.host.signIn).toHaveBeenCalledTimes(1);
  f.close();
});

it("an expired or declined confirmation can be asked for again", async () => {
  const f = setup({ read: { status: 200, body: state({ proposal: { ...LESS_SAFE, approval: { status: "expired" } } }) } });
  const region = await section();
  expect(within(region).getByRole("button", { name: "Ask again" })).toBeTruthy();
  f.close();
});

it("edits the proposal as JSON: a body that isn't JSON is refused here, a valid one is sent whole and becomes the proposal", async () => {
  const edited = { ...PROPOSAL, source: "edited" };
  const f = setup({ read: { status: 200, body: state({ proposal: PROPOSAL }) }, answers: { "/edit": { status: 200, body: state({ proposal: edited }) } } });
  const region = await section();
  fireEvent.click(within(region).getByRole("button", { name: "Edit this proposal" }));
  const box = within(region).getByLabelText<HTMLTextAreaElement>("Edit the test environment");
  expect(JSON.parse(box.value)).toMatchObject({ tier: "sandbox", roundBudgetMin: 30 });
  fireEvent.change(box, { target: { value: "{ not json" } });
  fireEvent.click(within(region).getByRole("button", { name: "Save my edit" }));
  expect((await within(region).findByRole("alert")).textContent).toContain("isn't valid JSON");
  expect(posts(f, "/test-environment/edit")).toHaveLength(0);
  fireEvent.change(box, { target: { value: JSON.stringify({ ...ENVIRONMENT, roundBudgetMin: 45 }) } });
  fireEvent.click(within(region).getByRole("button", { name: "Save my edit" }));
  await within(region).findByText("Your edited proposal");
  expect(posts(f, "/test-environment/edit")[0]!.body).toMatchObject({ environment: { roundBudgetMin: 45 } });
  expect(within(region).queryByLabelText("Edit the test environment")).toBeNull();
  f.close();
});
