// @vitest-environment jsdom
// Setup wizard (E4): the Setup step's test-environment section. Each state it can be in: the feature off (nothing shown), loading, a failed read, no draft, a stale draft, a draft to propose, a proposal (what will
// run with each value's source, the proof, the commands to add to the settings), the approvals (one press; a second person's confirmation; sign in again), an edit, and the approved environment.
import { expect, it } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { TestEnvironmentBodySchema, TestEnvironmentStateSchema } from "@agentx/cloud-contracts/web";
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
const DB_ROW = { id: "postgres", name: "Postgres", kind: "database", family: "postgres", found: [{ path: "src/db.ts", line: 2 }], usedBy: ["unit"], backing: { kind: "local", catalogId: "postgres@16", config: {} },
  connect: { env: [{ name: "DATABASE_URL", template: "postgres://{user}:{password}@{host}:{port}/{db}" }], hostAliases: ["postgres"] }, seeds: [], reset: "fresh_per_round" };
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

it("explains what is needed when no look has been made, with the one button that asks for it, and says a stale draft is old", async () => {
  const none = setup({ read: { status: 200, body: state({ draft: { status: "none", notes: [], questions: [], pendingServices: [] } }) } });
  expect(await screen.findByText(/You have not asked for that look yet/)).toBeTruthy();
  expect(screen.queryByText(/above first/)).toBeNull();
  expect(screen.queryByRole("button", { name: "Propose a test environment" })).toBeNull();
  fireEvent.click(await screen.findByRole("button", { name: "Look at my repositories and draft the test environment" }));
  await waitFor(() => expect(posts(none, "/setup-draft")).toHaveLength(1));
  expect(typeof (posts(none, "/setup-draft")[0]!.body as { requestId: unknown }).requestId).toBe("string");
  none.close();
  const stale = setup({ read: { status: 200, body: state({ draft: { looked: true, status: "stale", notes: [], questions: [], pendingServices: [] } }) } });
  expect(await screen.findByText(/older than your project's settings/)).toBeTruthy();
  expect(screen.getByText(/If test services were switched on after your last look/)).toBeTruthy();
  expect(screen.getByRole("button", { name: "Look again and draft the test environment" })).toBeTruthy();
  stale.close();
});

it("says what is missing when the look ran and found nothing to draft from, instead of asking to look first", async () => {
  const f = setup({ read: { status: 200, body: state({ draft: { looked: true, status: "none", notes: ["Rovara looked at your default branch and found no command that runs your tests."], questions: [], pendingServices: [] } }) } });
  expect(await screen.findByText(/found no command that runs your tests/)).toBeTruthy();
  expect(screen.getByText(/could not draft a test environment from what it found/)).toBeTruthy();
  expect(screen.queryByText(/You have not asked for that look yet/)).toBeNull();
  expect(screen.getByRole("button", { name: "Look again and draft the test environment" })).toBeTruthy();
  f.close();
});

it("shows the steps, with the one the person is on", async () => {
  const f = setup({ read: { status: 200, body: state({ proposal: PROPOSAL }) } });
  const region = await section();
  const steps = within(region).getByRole("list", { name: "Steps to a proven test environment" });
  // TS-UX-1 item 2: one press per step (the setup pattern).
  expect(within(steps).getAllByRole("listitem").map((item) => item.textContent)).toEqual(["Read your repositories", "Check it works", "Approve it"]);
  expect(within(steps).getByText("Check it works").closest("li")!.getAttribute("aria-current")).toBe("step");
  f.close();
});

it("shows what Rovara found, and ONE 'Check it works' proposes and checks it (no Propose press, no digest sent)", async () => {
  const f = setup({ read: { status: 200, body: state({ draft: { status: "ready", notes: ["Found a package.json."], questions: ["Which Node version?"], pendingServices: [{ kind: "http", target: "api.payments.example" }] } }) }, answers: { "/check": { status: 200, body: state({ proposal: { ...PROPOSAL, check: { status: "checking" } } }) } } });
  const region = await section();
  expect(within(region).getByText("Found a package.json.")).toBeTruthy();
  expect(within(region).getByText("Which Node version?")).toBeTruthy();
  expect(within(within(region).getByRole("list", { name: "Services not set up yet" })).getByText("api.payments.example")).toBeTruthy();
  expect(within(region).queryByRole("button", { name: "Propose a test environment" })).toBeNull();
  fireEvent.click(within(region).getByRole("button", { name: "Check it works" }));
  await waitFor(() => expect(posts(f, "/test-environment/check")).toHaveLength(1));
  expect(Object.keys(posts(f, "/test-environment/check")[0]!.body as object)).toEqual(["requestId"]);
  expect(posts(f, "/test-environment/propose")).toEqual([]);
  await within(region).findByText(/Checking: Rovara is running the setup and the tests/);
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
  // TE-2: the proposal has its own check first, and the commands are not added to the settings before approval. TS-UX-1 item 2: there is no Prove press; Prove comes from the check.
  expect(within(region).queryByRole("button", { name: "Prove it" })).toBeNull();
  expect(within(region).getByRole("button", { name: "Check it works" })).toHaveProperty("disabled", false);
  expect(within(region).queryByRole("button", { name: "Add these commands to the project's settings" })).toBeNull();
  await expectNoAxeViolations(region);
  f.close();
});

it("a passed check shows a tick and no Prove press; the plain rows show the services, their connection variables, test data and the nightly run, with JSON only under Advanced", async () => {
  const withDb = { ...PROPOSAL, proved: true, proveSteps: [{ step: "setup", status: "passed" }], check: { status: "ready" }, environment: { ...ENVIRONMENT, dependencies: [{ ...DB_ROW, seeds: [{ fixturePath: "web/db/seeds/users.sql" }] }] }, dependencySeeds: [{ id: "postgres", name: "Postgres", commands: [] }] };
  const f = setup({ read: { status: 200, body: state({ proposal: withDb }) } });
  const region = await section();
  expect(within(region).getByText(/✓ It works/)).toBeTruthy();
  expect(posts(f, "/test-environment/prove")).toEqual([]);
  const services = within(region).getByRole("list", { name: "Services the tests use" });
  expect(within(services).getByText("Postgres")).toBeTruthy();
  expect(within(services).getByText(/started by Rovara for each run \(postgres@16\)/)).toBeTruthy();
  expect(within(services).getByText("DATABASE_URL")).toBeTruthy();
  expect(within(services).getByText("web/db/seeds/users.sql")).toBeTruthy();
  expect(within(services).getByText(/as a role with no superuser rights; it cannot reach the network or your secrets/)).toBeTruthy();
  expect(within(region).getByText(/Nightly run of the whole suite: off/)).toBeTruthy();
  // The connection template (even with placeholders only) is not shown: names are.
  expect(region.textContent).not.toContain("{password}");
  expect(within(region).getByText("Advanced").closest("details")).toBeTruthy();
  await expectNoAxeViolations(region);
  f.close();
});

it("runs the proposal's own check, shows it running and shows how a failed one failed, with no command added to the settings", async () => {
  const running = { ...PROPOSAL, commandsNotInSettings: 2, check: { status: "checking" } };
  const f = setup({ read: { status: 200, body: state({ proposal: { ...PROPOSAL, commandsNotInSettings: 2 } }) }, answers: { "/check": { status: 200, body: state({ proposal: running }) } } });
  const region = await section();
  expect(within(region).getByText(/2 of them are not in the settings yet; approving adds them/)).toBeTruthy();
  fireEvent.click(within(region).getByRole("button", { name: "Check it works" }));
  await within(region).findByText(/Checking: Rovara is running/);
  const [call] = posts(f, "/test-environment/check");
  expect(call!.body).toMatchObject({ digest: DIGEST });
  expect(Object.keys(call!.body as object).sort()).toEqual(["digest", "requestId"]);
  expect(posts(f, "/test-environment/apply-commands")).toEqual([]);
  f.close();
  const failed = setup({ read: { status: 200, body: state({ proposal: { ...PROPOSAL, check: { status: "failed", failedStep: "setup: npm ci - exited 1" } } }) } });
  const failedRegion = await section();
  // TS-UX-1 item 2: the failed step, its cause and the fix.
  const alert = await within(failedRegion).findByRole("alert");
  expect(alert.textContent).toContain("What failed: setup: npm ci - exited 1");
  expect(alert.textContent).toContain("A setup command failed on a fresh machine");
  expect(alert.textContent).toContain("To fix it:");
  expect(within(failedRegion).getByRole("button", { name: "Check it works again" })).toBeTruthy();
  failed.close();
  // TS-UX-1 item 9: test data that did not load (a bad SQL seed file) is shown as its cause and fix.
  const seedFailed = setup({ read: { status: 200, body: state({ proposal: { ...PROPOSAL, check: { status: "failed", failedStep: "setup: A test service's seeds did not complete" } } }) } });
  const seedRegion = await section();
  const seedAlert = await within(seedRegion).findByRole("alert");
  expect(seedAlert.textContent).toContain("The test data did not load into the test database.");
  expect(seedAlert.textContent).toContain("a file must be plain SQL that loads into one");
  seedFailed.close();
  // Review I3: a seed file changed after approval asks for a fresh approval.
  const changed = setup({ read: { status: 200, body: state({ proposal: { ...PROPOSAL, check: { status: "failed", failedStep: "setup: A test service's seed file changed since the test environment was approved; check it works and approve it again" } } }) } });
  const changedAlert = await within(await section()).findByRole("alert");
  expect(changedAlert.textContent).toContain("The test data file changed since the test environment was approved");
  expect(changedAlert.textContent).toContain("approve the test environment again");
  changed.close();
  // Review: each file seed refusal has its own cause and fix.
  const meta = setup({ read: { status: 200, body: state({ proposal: { ...PROPOSAL, check: { status: "failed", failedStep: "setup: A test service's seed file holds a psql command (a backslash, as in \\copy, \\! or a pg_dump COPY FROM stdin block); a seed file is plain SQL only" } } }) } });
  const metaAlert = await within(await section()).findByRole("alert");
  expect(metaAlert.textContent).toContain("pg_dump --inserts");
  meta.close();
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
  expect(within(region).getByText(/✓ It works: the check ran these commands/)).toBeTruthy();
  fireEvent.click(within(region).getByRole("button", { name: "Approve" }));
  await within(region).findByText(/Approved: revision 1/);
  const [call] = posts(f, "/test-environment/approve");
  expect(call!.body).toMatchObject({ digest: DIGEST, expectedRevision: 0 });
  expect(typeof (call!.body as { requestId: string }).requestId).toBe("string");
  f.close();
});

const LESS_SAFE = { ...PROPOSAL, source: "edited", risk: "high", lessSafe: ["nightly_enabled"], proved: true, needs: { freshSignIn: true, secondPerson: true } };

it("a less-safe change says the real rule first; Approve asks for the second person, and the asker sees who it waits for on the same screen (no confirmation link)", async () => {
  const f = setup({ read: { status: 200, body: state({ approved: { revision: 1, approvedAt: "2026-11-01T12:00:00.000Z", digest: "b".repeat(64), summary: SUMMARY }, proposal: LESS_SAFE }) },
    answers: { "/request-approval": { status: 200, body: { status: "pending", confirmUrl: "https://cell.example/v1/app/approve/apr_abcdefghij0123456789", state: state({ proposal: { ...LESS_SAFE, approval: { status: "pending", askedByYou: true, youConfirm: false, approvalId: "apr_abcdefghij0123456789", waitingFor: "second_person" } } }) } } } });
  const region = await section();
  expect(within(region).getByText("Your edited proposal")).toBeTruthy();
  expect(within(region).getByText(/runs the whole test suite every night, which costs money/)).toBeTruthy();
  const note = within(region).getByText(/Approving it takes two people/);
  // One statement of the rule: the approver's ten-minute sign-in, a second person with an email code, the sole-owner route with its company switch.
  expect(note.textContent).toContain("after signing in within the last ten minutes");
  expect(note.textContent).toContain("signing in with an email code");
  expect(note.textContent).toContain("company allows its only owner to confirm (a company switch)");
  expect(region.textContent).not.toContain("or a fresh sign-in if you're the only owner");
  fireEvent.click(within(region).getByRole("button", { name: "Approve" }));
  await within(region).findByText(/Waiting for a second person \(an owner or admin of the company, or a maintainer of this project\)/);
  expect(posts(f, "/test-environment/request-approval")[0]!.body).toEqual({ digest: DIGEST, expectedRevision: 1 });
  expect(within(region).queryByRole("link", { name: "Open the confirmation page" })).toBeNull();
  expect(region.querySelector("a[target=_blank]")).toBeNull();
  expect(within(region).getByRole("button", { name: "Check again" })).toBeTruthy();
  f.close();
});

it("the company's only owner is told it waits for them, and the person who confirms sees the card on this screen", async () => {
  const sole = setup({ read: { status: 200, body: state({ proposal: { ...LESS_SAFE, approval: { status: "pending", askedByYou: true, youConfirm: true, approvalId: "apr_abcdefghij0123456789", waitingFor: "you_sole_owner" } } }) } });
  const soleRegion = await section();
  expect(within(soleRegion).getByText(/Waiting for you to confirm it on the card below: you are the company's only owner/)).toBeTruthy();
  expect(within(soleRegion).getByLabelText("Confirm this test environment")).toBeTruthy();
  await waitFor(() => expect(sole.request.mock.calls.some(([r]) => r.path === "/v1/app/decisions?approval=apr_abcdefghij0123456789")).toBe(true));
  sole.close();
  const second = setup({ read: { status: 200, body: state({ proposal: { ...LESS_SAFE, approval: { status: "pending", askedByYou: false, youConfirm: true, approvalId: "apr_abcdefghij0123456789" } } }) } });
  const secondRegion = await section();
  expect(within(secondRegion).getByText(/A maintainer asked you to confirm this test environment/)).toBeTruthy();
  expect(within(secondRegion).queryByRole("button", { name: "Approve" })).toBeNull();
  await waitFor(() => expect(second.request.mock.calls.some(([r]) => r.path === "/v1/app/decisions?approval=apr_abcdefghij0123456789")).toBe(true));
  second.close();
  const other = setup({ read: { status: 200, body: state({ proposal: { ...LESS_SAFE, approval: { status: "pending", askedByYou: false, youConfirm: false } } }) } });
  const otherRegion = await section();
  expect(within(otherRegion).getByText("Waiting for a second person to confirm it.")).toBeTruthy();
  expect(within(otherRegion).queryByLabelText("Confirm this test environment")).toBeNull();
  other.close();
});

it("once a second person confirmed, the asker finishes the approval; an old sign-in asks them to sign in again", async () => {
  const f = setup({ read: { status: 200, body: state({ proposal: { ...LESS_SAFE, approval: { status: "approved", askedByYou: true } } }) }, answers: { "/approve": { status: 403, body: { error: { code: "REAUTH_REQUIRED", message: "Sign in again to approve this change." } } } } });
  const region = await section();
  expect(within(region).getByText(/Confirmed. Approve to finish/)).toBeTruthy();
  fireEvent.click(within(region).getByRole("button", { name: "Approve" }));
  const alert = await within(region).findByRole("alert");
  expect(alert.textContent).toContain("Sign in again to approve this change.");
  fireEvent.click(within(alert).getByRole("button", { name: "Sign in again" }));
  expect(f.host.signIn).toHaveBeenCalledTimes(1);
  f.close();
});

it("an expired or declined confirmation can be asked for again with the same Approve", async () => {
  const f = setup({ read: { status: 200, body: state({ proposal: { ...LESS_SAFE, approval: { status: "expired" } } }) } });
  const region = await section();
  expect(within(region).getByText(/The last confirmation expired or was declined/)).toBeTruthy();
  expect(within(region).getByRole("button", { name: "Approve" })).toBeTruthy();
  f.close();
});

it("edits the proposal as JSON: a body that isn't JSON is refused here, a valid one is sent whole and becomes the proposal", async () => {
  const edited = { ...PROPOSAL, source: "edited" };
  const f = setup({ read: { status: 200, body: state({ proposal: PROPOSAL }) }, answers: { "/edit": { status: 200, body: state({ proposal: edited }) } } });
  const region = await section();
  fireEvent.click(within(region).getByRole("button", { name: "Edit as JSON" }));
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

const DB = { id: "postgres", name: "Postgres", kind: "database", family: "postgres", found: [{ path: "src/db.ts", line: 2 }], usedBy: ["integration"], backing: { kind: "local", catalogId: "postgres@16", config: {} },
  connect: { env: [{ name: "DATABASE_URL", template: "postgres://{user}:{password}@{host}:{port}/{db}" }], hostAliases: ["postgres"] }, seeds: [], reset: "fresh_per_round" };

it("has a plain field per dependency for the data commands: every command is shown, one per line, and what is typed is sent line by line", async () => {
  const withDb = { ...PROPOSAL, environment: { ...ENVIRONMENT, dependencies: [DB] }, dependencySeeds: [{ id: "postgres", name: "Postgres", commands: [] }] };
  const seeded = { ...withDb, digest: "b".repeat(64), source: "edited", risk: "high", lessSafe: ["dependency_seed"], needs: { freshSignIn: true, secondPerson: true }, dependencySeeds: [{ id: "postgres", name: "Postgres", commands: ["npx prisma migrate deploy", "npm run seed"] }] };
  const f = setup({ read: { status: 200, body: state({ proposal: withDb }) }, answers: { "/seed": { status: 200, body: state({ proposal: seeded }) } } });
  const region = await section();
  const field = within(region).getByLabelText<HTMLTextAreaElement>("Fill Postgres with test data");
  expect(within(region).getByText(/never in setup/)).toBeTruthy();
  expect(within(region).getByRole<HTMLButtonElement>("button", { name: "Save the test data commands" }).disabled).toBe(true);
  fireEvent.change(field, { target: { value: "npx prisma migrate deploy\n\n  npm run seed  \n" } });
  fireEvent.click(within(region).getByRole("button", { name: "Save the test data commands" }));
  await waitFor(() => expect(posts(f, "/test-environment/seed")).toHaveLength(1));
  expect(posts(f, "/test-environment/seed")[0]!.body).toEqual({ digest: DIGEST, dependencyId: "postgres", commands: ["npx prisma migrate deploy", "npm run seed"] });
  // I-2: the answer lists both commands, in order, so none runs unseen.
  await waitFor(() => expect(within(region).getByLabelText<HTMLTextAreaElement>("Fill Postgres with test data").value).toBe("npx prisma migrate deploy\nnpm run seed"));
  f.close();
});

it("shows every command a dependency already has, and clearing the field sends an empty list", async () => {
  const two = { ...PROPOSAL, source: "edited", risk: "high", lessSafe: ["dependency_seed"], needs: { freshSignIn: true, secondPerson: true }, environment: { ...ENVIRONMENT, dependencies: [DB] }, dependencySeeds: [{ id: "postgres", name: "Postgres", commands: ["npx prisma migrate deploy", "npm run seed"] }] };
  const f = setup({ read: { status: 200, body: state({ proposal: two }) }, answers: { "/seed": { status: 200, body: state({ proposal: { ...two, dependencySeeds: [{ id: "postgres", name: "Postgres", commands: [] }] } }) } } });
  const region = await section();
  expect(within(region).getByLabelText<HTMLTextAreaElement>("Fill Postgres with test data").value).toBe("npx prisma migrate deploy\nnpm run seed");
  fireEvent.change(within(region).getByLabelText("Fill Postgres with test data"), { target: { value: "  \n" } });
  fireEvent.click(within(region).getByRole("button", { name: "Save the test data commands" }));
  await waitFor(() => expect(posts(f, "/test-environment/seed")).toHaveLength(1));
  expect(posts(f, "/test-environment/seed")[0]!.body).toEqual({ digest: DIGEST, dependencyId: "postgres", commands: [] });
  f.close();
});

it("says before Approve why a seed makes it high tier, who must approve, and offers the sign-in right there when it is refused", async () => {
  const seeded = { ...PROPOSAL, source: "edited", risk: "high", lessSafe: ["dependency_seed"], needs: { freshSignIn: true, secondPerson: true }, proved: true, proveSteps: [{ step: "setup", status: "passed" }],
    approval: { status: "approved", askedByYou: true }, check: { status: "ready" }, dependencySeeds: [{ id: "postgres", name: "Postgres", commands: ["npm run seed"] }], environment: { ...ENVIRONMENT, dependencies: [{ ...DB, seeds: [{ command: command("npm", ["run", "seed"], 900) }] }] } };
  const f = setup({ read: { status: 200, body: state({ proposal: seeded }) }, answers: { "/approve": { status: 401, body: { error: { code: "REAUTH_REQUIRED", message: "Sign in again to approve this change." } } } } });
  const region = await section();
  expect(within(region).getByText(/A seed command runs your own code against the test database, with that database's network access/)).toBeTruthy();
  expect(within(region).getByText(/runs a command to fill a dependency with test data/)).toBeTruthy();
  fireEvent.click(within(region).getByRole("button", { name: "Approve" }));
  const alert = await within(region).findByRole("alert");
  expect(alert.textContent).toContain("Sign in again to approve this change.");
  expect(within(alert).getByRole("button", { name: "Sign in again" })).toBeTruthy();
  // The sign-in is on the approval, once: not a second alert at the bottom of the section.
  expect(within(region).getAllByRole("button", { name: "Sign in again" })).toHaveLength(1);
  f.close();
});
