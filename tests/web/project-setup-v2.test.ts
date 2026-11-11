// @vitest-environment jsdom
// The rich project setup (exp/project-setup): off by default (today's onboarding is unchanged), the per-repository environment rows and their recoveries, the first task (suggestions, a real start through the
// existing start route, a refusal with the server's reason and a fix), and the whole flow's first screen.
import { expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { AppProjectDetailSchema, type AppProjectDetail } from "@agentx/cloud-contracts/web";
import { AppHostProvider } from "../../packages/ui/src/host.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { ApiError } from "../../packages/ui/src/api/errors.js";
import { OnboardScreen } from "../../packages/ui/src/screens/onboarding/OnboardScreen.js";
import { PROJECT_SETUP_STORAGE_KEY, isProjectSetupV2On } from "../../packages/ui/src/screens/onboarding/project-setup-flags.js";
import { attributeFailure, recoveryChoices, repoCheckModel, runIsOf, type EnvRun } from "../../packages/ui/src/screens/onboarding/setup-v2/repo-check.js";
import { firstTaskGate, refusalOf, suggestFirstOutcomes } from "../../packages/ui/src/screens/onboarding/setup-v2/first-task.js";
import { nameProblem, planCreate } from "../../packages/ui/src/screens/onboarding/setup-v2/repo-plan.js";
import { EnvironmentStep } from "../../packages/ui/src/screens/onboarding/setup-v2/EnvironmentStep.js";
import { FirstTaskStep } from "../../packages/ui/src/screens/onboarding/setup-v2/FirstTaskStep.js";
import { setupFailureOf } from "../../packages/ui/src/screens/onboarding/steps/setup-failure.js";
import { renderUi } from "./support/render.js";
import { fakeHost } from "./support/fake-host.js";
import { h } from "./support/h.js";
import { projectFixture } from "./support/project-fixture.js";
import { taskFixture, SESSION_FIXTURE_ID } from "./support/session-fixture.js";

const API = { fullName: "acme/checkout-api", defaultBranch: "main" }, IOS = { fullName: "acme/checkout-ios", defaultBranch: "main" };
const FAIL_IOS = "setup: pnpm install - ERR_PNPM_FETCH_401 GET https://registry.example/ failed: 403 Forbidden";
const RUNS: EnvRun[] = [{ repositoryId: "checkout-api", setup: ["npm ci"], checks: [{ command: "npm test" }] }, { repositoryId: "repo-https-github.com-acme-checkout-ios", setup: ["pnpm install"], checks: [{ command: "pnpm test" }] }];

it("is off unless the device key says v2", () => {
 const f = fakeHost();
 expect(isProjectSetupV2On(f.host)).toBe(false);
 for (const value of ["", "v1", "true", "V2", "1"]) { f.storage.set(PROJECT_SETUP_STORAGE_KEY, value);expect(isProjectSetupV2On(f.host)).toBe(false); }
 f.storage.set(PROJECT_SETUP_STORAGE_KEY, "v2");expect(isProjectSetupV2On(f.host)).toBe(true);
 expect(isProjectSetupV2On({ storage: { get() { throw new Error("blocked"); }, set() { /* none */ } } })).toBe(false);
});

it("a passing check puts every repository at Ready, and a running one at Checking", () => {
 const ready = repoCheckModel({ repositories: [API, IOS], setup: { status: "ready" } });
 expect(ready.rows.map(row => [row.fullName, row.state, row.label])).toEqual([["acme/checkout-api", "ready", "Ready"], ["acme/checkout-ios", "ready", "Ready"]]);
 expect(ready.allReady).toBe(true);
 const running = repoCheckModel({ repositories: [API, IOS], setup: { status: "checking" } });
 expect(running.rows.every(row => row.state === "checking")).toBe(true);expect(running.allReady).toBe(false);
});

it("a failed check is placed in the repository whose command failed (matched through the test environment's per-repository commands), the others are Not checked on their own", () => {
 const model = repoCheckModel({ repositories: [API, IOS], setup: { status: "failed", failedStep: FAIL_IOS }, runs: RUNS });
 const byName = Object.fromEntries(model.rows.map(row => [row.fullName, row]));
 expect(byName["acme/checkout-ios"]).toMatchObject({ state: "needs_action", label: "Needs action", failure: { step: "Setup command", command: "pnpm install" } });
 expect(byName["acme/checkout-ios"]!.failure!.fix).toContain("Allowed websites");
 expect(byName["acme/checkout-api"]).toMatchObject({ state: "not_checked", label: "Not checked on its own" });
 expect(byName["acme/checkout-api"]!.detail).toContain("acme/checkout-ios");
 expect(model.unattributed).toBeUndefined();expect(model.allReady).toBe(false);
});

it("a failure that names a repository in its words is placed there; one that names none is shown once for the whole check, never guessed", () => {
 const named = repoCheckModel({ repositories: [API, IOS], setup: { status: "failed", failedStep: "setup: cloning acme/checkout-api failed - permission denied" } });
 expect(named.rows.find(row => row.state === "needs_action")?.fullName).toBe("acme/checkout-api");
 const none = repoCheckModel({ repositories: [API, IOS], setup: { status: "failed", failedStep: FAIL_IOS } });
 expect(none.rows.every(row => row.state === "not_checked")).toBe(true);
 expect(none.unattributed).toMatchObject({ command: "pnpm install" });
 // A single repository owns every failure, and an empty reason still gets a row to act on.
 const single = repoCheckModel({ repositories: [API], setup: { status: "failed" } });
 expect(single.rows[0]).toMatchObject({ state: "needs_action", failure: { cause: "No reason was recorded." } });
});

it("matches repository ids written as a full name, a short name or a clone address, and never a different repository", () => {
 expect(runIsOf("acme/checkout-api", "acme/checkout-api")).toBe(true);
 expect(runIsOf("checkout-api", "acme/checkout-api")).toBe(true);
 expect(runIsOf("repo-https-github.com-acme-checkout-api", "acme/checkout-api")).toBe(true);
 expect(runIsOf("checkout-api", "acme/checkout-ios")).toBe(false);
 expect(attributeFailure(setupFailureOf("setup: npm ci - nope")!, [API, IOS], [{ repositoryId: "checkout-api", setup: ["npm ci"], checks: [] }, { repositoryId: "checkout-ios", setup: ["npm ci"], checks: [] }])).toBeUndefined();
});

it("an unchecked or outdated project says so on every repository, and the meta repo is a row that needs nothing", () => {
 const unchecked = repoCheckModel({ repositories: [API], setup: { status: "unchecked" }, metaRepository: "acme/mobile-meta" });
 expect(unchecked.rows.map(row => [row.fullName, row.state])).toEqual([["acme/checkout-api", "not_checked"], ["acme/mobile-meta", "meta"]]);
 expect(unchecked.rows[0]!.label).toBe("Not checked yet");
 expect(repoCheckModel({ repositories: [API], setup: { status: "outdated" } }).rows[0]!.label).toBe("Settings changed");
 // A meta repo that is also code is not listed twice.
 expect(repoCheckModel({ repositories: [API], setup: { status: "ready" }, metaRepository: "ACME/checkout-api" }).rows).toHaveLength(1);
});

it("recovery: the setup agent first only where it is on, then Retry, then Edit; rows that are fine offer none", () => {
 expect(recoveryChoices("needs_action", { agentAvailable: true })).toEqual(["fix_with_agent", "retry", "edit_setup"]);
 expect(recoveryChoices("needs_action", { agentAvailable: false })).toEqual(["retry", "edit_setup"]);
 expect(recoveryChoices("not_checked", { agentAvailable: true })).toEqual(["retry", "edit_setup"]);
 for (const state of ["ready", "checking", "meta"] as const) expect(recoveryChoices(state, { agentAvailable: true })).toEqual([]);
});

it("suggests two or three first outcomes from the repositories, naming the meta repo for the cross-repo one", () => {
 expect(suggestFirstOutcomes([])).toEqual([]);
 const one = suggestFirstOutcomes(["acme/checkout-api"]);
 expect(one).toHaveLength(3);expect(one.every(text => text.includes("checkout-api"))).toBe(true);
 const many = suggestFirstOutcomes(["acme/checkout-api", "acme/checkout-ios"], "acme/mobile-meta");
 expect(many[0]).toBe("Map how checkout-api and checkout-ios work together and write a summary to mobile-meta");
 expect(many).toHaveLength(3);expect(new Set(many).size).toBe(3);
});

it("a refusal keeps the server's reason and gets a fix chosen from what was refused", () => {
 const full = refusalOf(new ApiError(409, "WORKSPACE_LIMIT", "x"));expect(full.action).toBe("close_tasks");expect(full.fix).toContain("Close one");
 expect(refusalOf(new ApiError(409, "SETUP_NOT_READY", "The project's setup check has not passed."))).toMatchObject({ reason: "The project's setup check has not passed.", action: "environment" });
 const spend = refusalOf(new ApiError(422, "CONFIG_INVALID", "This task would go over the project's spending stop."));expect(spend.reason).toBe("This task would go over the project's spending stop.");expect(spend.fix).toContain("spending limit");
 expect(refusalOf(new ApiError(403, "FORBIDDEN", "No."))).toMatchObject({ action: "project" });
 expect(refusalOf(new Error("boom"))).toMatchObject({ reason: "Couldn't start this task.", action: "retry" });
 expect(firstTaskGate("ready")).toEqual({ ok: true });
 for (const status of ["failed", "checking", "unchecked", "outdated"]) expect(firstTaskGate(status).ok).toBe(false);
});

it("one repository on its own is created the old way, several need a meta repo, and a bad name is said before the press", () => {
 expect(planCreate({ codeRepositories: ["a/b"], metaRepository: "" })).toEqual({ kind: "single", repository: "a/b" });
 expect(planCreate({ codeRepositories: ["a/b", "a/c"], metaRepository: "" }).kind).toBe("invalid");
 expect(planCreate({ codeRepositories: [], metaRepository: "" }).kind).toBe("invalid");
 expect(planCreate({ codeRepositories: ["a/b", "a/m"], metaRepository: "a/m" })).toEqual({ kind: "meta", metaRepository: "a/m", codeRepositories: ["a/b"] });
 expect(planCreate({ codeRepositories: [], metaRepository: "a/m" })).toEqual({ kind: "meta", metaRepository: "a/m", codeRepositories: [] });
 expect(nameProblem("")).toBeUndefined();expect(nameProblem("checkout-2")).toBeUndefined();
 for (const bad of ["Checkout", "2fast", "a b", "-x"]) expect(nameProblem(bad), bad).toBeTruthy();
});

// ---- screens ----
const detail = (setup: { status: string; failedStep?: string }, repositories = [API, IOS]) => AppProjectDetailSchema.parse({ name: "mobile", description: "Pay in the app.", status: "active", latestRevision: 2, repositories, myRole: "maintainer", setup, settings: { setupCommands: ["pnpm install"], testCommands: ["pnpm test"], devcontainer: null, allowedDomains: [] }, createdAt: "2026-11-01T00:00:00.000Z", createdBy: { developerId: "d".repeat(64), name: "Maya" } });
const LIMITS = { commands: 40, sameStepTries: 3, wallClockMin: 45, budgetCents: 400, hostAsks: 5 };
const NOT_FOUND = { status: 404, body: { error: { code: "NOT_FOUND", message: "Not found." } } };
function mount(element: ReturnType<typeof h>, options: { agent?: boolean; start?: (request: { path: string; body?: unknown }) => { status: number; body: unknown }; canStart?: boolean; checked?: ReturnType<typeof detail>; path?: string; store?: Record<string, string>; me?: "owner" | "member" } = {}) {
 const f = fakeHost(async request => {
  if (request.path.endsWith("/setup-agent") && request.method === "GET") return options.agent === true ? { status: 200, body: { status: "none", basedOnRevision: 2, limits: LIMITS } } : NOT_FOUND;
  if (request.path.endsWith("/setup-agent") && request.method === "POST") return { status: 200, body: { status: "running", basedOnRevision: 2, limits: LIMITS } };
  if (request.path.endsWith("/test-environment")) return NOT_FOUND;
  if (request.path.endsWith("/setup-check")) return { status: 202, body: { project: options.checked ?? detail({ status: "checking" }) } };
  if (request.path.endsWith("/code")) return options.start?.(request) ?? NOT_FOUND;
  if (/\/overview$/u.test(request.path)) { const base = projectFixture();return { status: 200, body: { ...base, you: { ...base.you, canStartWork: options.canStart !== false } } }; }
  if (request.path === "/v1/app/me") return { status: 200, body: { developer: { id: "a".repeat(64), name: "Maya", orgRole: options.me ?? "owner" }, org: { orgId: "org_aaaaaaaaaaaaaaaaaaaa", name: "Acme", plan: "cloud", nameIsDefault: false }, identities: [{ provider: "github", login: "maya", linkedAt: "x", lastSignInAt: "x" }] } };
  if (request.path === "/v1/app/github/installations") return { status: 200, body: { installations: [{ installationId: 55, accountLogin: "acme", accountType: "Organization", repositorySelection: "selected", status: "active" }] } };
  if (request.path.startsWith("/v1/app/github/repositories")) return { status: 200, body: { repositories: [{ fullName: "acme/checkout-api", githubRepositoryId: 1, private: true, defaultBranch: "main" }, { fullName: "acme/checkout-ios", githubRepositoryId: 2, private: true, defaultBranch: "main" }, { fullName: "acme/mobile-meta", githubRepositoryId: 3, private: true, defaultBranch: "main" }] } };
  return { status: 200, body: { notices: [], next: "settled" } };
 });
 for (const [key, value] of Object.entries(options.store ?? {})) f.storage.set(key, value);
 const navigate = vi.fn<(url: string) => void>();f.host.navigate = navigate;
 const query = createQueryClient();
 const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(MemoryRouter, { initialEntries: [options.path ?? "/app/onboard"], children: element }) }) }));
 return { ...f, ...ui, query, navigate, close() { ui.unmount();query.clear(); } };
}
const sent = (f: ReturnType<typeof mount>, suffix: string) => f.request.mock.calls.map(call => call[0]).filter(request => request.method === "POST" && request.path.endsWith(suffix));

it("with the switch off, the onboarding is today's six steps (the page never loads the new setup)", async () => {
 const f = mount(h(OnboardScreen));
 expect(await screen.findByRole("heading", { name: "Onboard a project" })).toBeTruthy();
 await screen.findByRole("heading", { name: "Choose repositories" });
 expect(screen.getByText("Step 2 of 6")).toBeTruthy();
 expect(f.container.querySelector(".rv-psv2")).toBeNull();
 f.close();
});

it("with the switch on, the first screen names the project and shows the company setup as done by an admin once", async () => {
 const f = mount(h(OnboardScreen), { store: { [PROJECT_SETUP_STORAGE_KEY]: "v2" } });
 expect(await screen.findByRole("heading", { name: "Set up a project" })).toBeTruthy();
 expect(await screen.findByRole("heading", { name: "Name the project" })).toBeTruthy();
 expect(screen.getByText("Step 1 of 6: Name")).toBeTruthy();
 const company = screen.getByRole("region", { name: "Company setup" });
 expect(within(company).getByText(/connected as/)).toBeTruthy();expect(within(company).getByText(/An admin does these once/)).toBeTruthy();
 expect(within(company).getByRole("link", { name: "Manage connections" }).getAttribute("href")).toBe("/app/admin/connections");
 // Several repositories without a meta repo cannot be created: the page says so before anything is sent.
 fireEvent.click(screen.getByRole("button", { name: "Choose repositories" }));
 fireEvent.click(await screen.findByRole("checkbox", { name: "acme/checkout-api" }));fireEvent.click(screen.getByRole("checkbox", { name: "acme/checkout-ios" }));
 expect(screen.getByRole<HTMLButtonElement>("button", { name: "Create the project" }).disabled).toBe(true);
 expect(screen.getByRole("status").textContent).toContain("meta repo");
 fireEvent.click(screen.getByRole("radio", { name: "acme/mobile-meta" }));
 expect(screen.getByRole<HTMLButtonElement>("button", { name: "Create the project" }).disabled).toBe(false);
 f.close();
});

it("environment check: one repository needs action with its failing step and the recovery; Retry sends the existing check", async () => {
 const project = detail({ status: "failed", failedStep: "setup: pnpm install - ERR_PNPM_FETCH_401 403 Forbidden" }, [IOS]);
 const f = mount(h(EnvironmentStep, { project, metaRepository: "acme/mobile-meta", onProject: vi.fn(), refresh: vi.fn(), onNext: vi.fn() }), { agent: true });
 expect(await screen.findByText("Needs action")).toBeTruthy();
 expect(screen.getByText("Step that failed")).toBeTruthy();expect(screen.getByText("pnpm install")).toBeTruthy();
 expect(screen.getByText(/couldn't reach a website/)).toBeTruthy();
 expect(screen.getByText("Meta repo")).toBeTruthy();
 expect(await screen.findByRole("button", { name: "Fix with the setup agent for acme/checkout-ios" })).toBeTruthy();
 const onProject = vi.fn<(project: AppProjectDetail) => void>();f.close();
 const g = mount(h(EnvironmentStep, { project, onProject, refresh: vi.fn(), onNext: vi.fn() }), { agent: false, checked: detail({ status: "checking" }, [IOS]) });
 fireEvent.click(await screen.findByRole("button", { name: "Retry the check for acme/checkout-ios" }));
 await waitFor(() => expect(onProject).toHaveBeenCalled());
 expect(sent(g, "/setup-check")).toHaveLength(1);
 expect(onProject.mock.calls[0]![0].setup.status).toBe("checking");
 g.close();
});

it("environment check: without the setup agent the choices are Retry and Edit only; with it, Fix with the setup agent starts a run", async () => {
 const project = detail({ status: "failed", failedStep: "setup: pnpm install - boom" }, [IOS]);
 const off = mount(h(EnvironmentStep, { project, onProject: vi.fn(), refresh: vi.fn(), onNext: vi.fn() }), { agent: false });
 await screen.findByText("Needs action");
 await waitFor(() => expect(off.request.mock.calls.some(call => call[0].path.endsWith("/setup-agent"))).toBe(true));
 expect(screen.queryByRole("button", { name: /Fix with the setup agent/ })).toBeNull();
 expect(screen.getByRole("button", { name: /Retry the check/ })).toBeTruthy();expect(screen.getByRole("button", { name: /Edit the setup/ })).toBeTruthy();
 off.close();
 const on = mount(h(EnvironmentStep, { project, onProject: vi.fn(), refresh: vi.fn(), onNext: vi.fn() }), { agent: true });
 fireEvent.click(await screen.findByRole("button", { name: /Fix with the setup agent/ }));
 await waitFor(() => expect(sent(on, "/setup-agent")).toHaveLength(1));
 on.close();
});

it("environment check: a passing project continues; a failing one can still be left, in words that say the first task needs it", async () => {
 const onNext = vi.fn();
 const ready = mount(h(EnvironmentStep, { project: detail({ status: "ready" }), onProject: vi.fn(), refresh: vi.fn(), onNext }), {});
 expect((await screen.findAllByText("Ready")).length).toBe(2);expect(screen.getByText(/All ready/)).toBeTruthy();
 fireEvent.click(screen.getByRole("button", { name: "Continue to agents" }));expect(onNext).toHaveBeenCalledTimes(1);
 ready.close();
 const failed = mount(h(EnvironmentStep, { project: detail({ status: "failed", failedStep: FAIL_IOS }), onProject: vi.fn(), refresh: vi.fn(), onNext }), {});
 await screen.findByText(/The whole check/);
 expect(screen.getByText(/The first task needs a ready environment/)).toBeTruthy();
 expect(screen.getByRole("button", { name: "Continue without a ready environment" })).toBeTruthy();
 failed.close();
});

const STARTED = () => ({ status: 202, body: { task: taskFixture({ sessionId: SESSION_FIXTURE_ID }), sessionId: SESSION_FIXTURE_ID, sessionUrl: "https://cell.example/app/sessions/" + SESSION_FIXTURE_ID } });
it("first task: a suggested outcome starts through the start route once, then the new task page opens", async () => {
 const f = mount(h(FirstTaskStep, { project: detail({ status: "ready" }), metaRepository: "acme/mobile-meta", onBack: vi.fn() }), { start: () => STARTED() });
 const first = await screen.findByRole("button", { name: /Map how checkout-api and checkout-ios work together and write a summary to mobile-meta/ });
 expect(screen.getByRole<HTMLButtonElement>("button", { name: "Start the first task" }).disabled).toBe(true);
 fireEvent.click(first);
 expect(screen.getByLabelText<HTMLTextAreaElement>("What do you need?").value).toContain("Map how checkout-api");
 const start = screen.getByRole<HTMLButtonElement>("button", { name: "Start the first task" });
 await waitFor(() => expect(start.disabled).toBe(false));
 fireEvent.click(start);fireEvent.click(start);
 await waitFor(() => expect(f.navigate).toHaveBeenCalledWith("/app/sessions/" + SESSION_FIXTURE_ID));
 expect(sent(f, "/code")).toHaveLength(1);
 expect(sent(f, "/code")[0]!.path).toBe("/v1/app/projects/mobile/code");
 expect((sent(f, "/code")[0]!.body as { input: { text: string } }).input.text).toContain("Map how checkout-api");
 expect(screen.getByRole("status").textContent).toContain("first task was started");
 f.close();
});

it("first task: free text starts too", async () => {
 const f = mount(h(FirstTaskStep, { project: detail({ status: "ready" }, [API]), onBack: vi.fn() }), { start: () => STARTED() });
 fireEvent.change(await screen.findByLabelText("What do you need?"), { target: { value: "Fix the flaky refund test" } });
 fireEvent.click(screen.getByRole("button", { name: "Start the first task" }));
 await waitFor(() => expect(f.navigate).toHaveBeenCalled());
 expect((sent(f, "/code")[0]!.body as { input: { text: string } }).input.text).toBe("Fix the flaky refund test");
 f.close();
});

it("first task: a refusal shows the server's reason and the fix, and nothing opens", async () => {
 const f = mount(h(FirstTaskStep, { project: detail({ status: "ready" }, [API]), onBack: vi.fn() }), { start: () => ({ status: 409, body: { error: { code: "SETUP_NOT_READY", message: "The setup check for this project has not passed." } } }) });
 fireEvent.change(await screen.findByLabelText("What do you need?"), { target: { value: "Explain checkout" } });
 fireEvent.click(screen.getByRole("button", { name: "Start the first task" }));
 const alert = await screen.findByRole("alert");
 expect(alert.textContent).toContain("The setup check for this project has not passed.");
 expect(alert.textContent).toContain("environment check");
 expect(within(alert).getByRole("button", { name: "Go to the environment check" })).toBeTruthy();
 expect(f.navigate).not.toHaveBeenCalled();
 f.close();
});

it("first task: an environment that isn't ready is said first with the way back, and Start stays off", async () => {
 const onBack = vi.fn(), f = mount(h(FirstTaskStep, { project: detail({ status: "failed", failedStep: FAIL_IOS }), onBack }), { start: () => STARTED() });
 expect((await screen.findByText(/Not ready to start/)).closest("div")!.textContent).toContain("would fail on setup");
 fireEvent.change(screen.getByLabelText("What do you need?"), { target: { value: "Explain checkout" } });
 expect(screen.getByRole<HTMLButtonElement>("button", { name: "Start the first task" }).disabled).toBe(true);
 fireEvent.click(screen.getByRole("button", { name: "Go to the environment check" }));expect(onBack).toHaveBeenCalled();
 expect(sent(f, "/code")).toHaveLength(0);
 f.close();
});

it("first task: a person who can't start work is told, and Start stays off", async () => {
 const f = mount(h(FirstTaskStep, { project: detail({ status: "ready" }, [API]), onBack: vi.fn() }), { canStart: false, start: () => STARTED() });
 expect(await screen.findByText(/You can't start work in this project/)).toBeTruthy();
 fireEvent.change(screen.getByLabelText("What do you need?"), { target: { value: "Explain checkout" } });
 expect(screen.getByRole<HTMLButtonElement>("button", { name: "Start the first task" }).disabled).toBe(true);
 f.close();
});
