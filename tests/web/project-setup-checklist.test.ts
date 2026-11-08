// @vitest-environment jsdom
// UX-4b: the project setup checklist, always on the project page (each row's state and why, opened in place), and the team record search (owner decision 3).
import { expect, it } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { ProjectScreen } from "../../packages/ui/src/screens/project/ProjectScreen.js";
import { savedEnvRowOf, setupRow } from "../../packages/ui/src/screens/project/ProjectSetupChecklist.js";
import { setupFailureOf } from "../../packages/ui/src/screens/onboarding/steps/setup-failure.js";
import { AppHostProvider, type ApiRequest, type ApiResponse } from "../../packages/ui/src/host.js";
import { Announcer } from "../../packages/ui/src/design/Announcer.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { renderUi } from "./support/render.js";
import { fakeHost } from "./support/fake-host.js";
import { h } from "./support/h.js";
import { expectNoAxeViolations } from "./support/axe.js";
import { projectFixture } from "./support/project-fixture.js";

const notFound: ApiResponse = { status: 404, body: { code: "NOT_FOUND", message: "x" } };
const detail = { name: "payments", description: "x", status: "active", latestRevision: 2, repositories: [{ fullName: "acme/payments", defaultBranch: "main" }], myRole: "maintainer", setup: { status: "failed", failedStep: "test: npm test - 3 tests failed" }, settings: { setupCommands: ["npm ci"], testCommands: ["npm test"], devcontainer: null, allowedDomains: [] }, createdAt: "2026-10-23T12:00:00.000Z", createdBy: { developerId: "a".repeat(64), name: "Maya" } };

function setup(options: { overview?: ReturnType<typeof projectFixture>; route?: (request: ApiRequest, path: string) => ApiResponse | undefined; theme?: "light" | "dark" } = {}) {
 const overview = options.overview ?? projectFixture();
 const f = fakeHost(async request => {
  const path = request.path.split("?")[0]!;
  const custom = options.route?.(request, path);
  if (custom !== undefined) return custom;
  if (path === "/v1/app/changes") return { status: 200, body: { notices: [], next: "settled" } };
  if (path.endsWith("/start-preview")) return { status: 200, body: { orgId: "org_aaaaaaaaaaaaaaaaaaaa", project: "payments", kind: "disabled" } };
  if (path === "/v1/app/projects/payments/overview") return { status: 200, body: overview };
  if (path === "/v1/app/projects/payments/record/learning-mode") return { status: 200, body: { mode: "off", effective: "off", canChange: true } };
  if (path === "/v1/app/projects/payments/lessons/sources") return { status: 200, body: { sources: [], otherPaused: 0 } };
  return notFound;
 });
 const query = createQueryClient();
 const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(MemoryRouter, { initialEntries: ["/app/projects/payments"], children: h(Announcer, { children: h(Routes, { children: h(Route, { path: "/app/projects/:name", element: h(ProjectScreen, {}) }) }) }) }) }) }), { theme: options.theme ?? "light" });
 return { ...f, ...ui, close() { ui.unmount();query.clear(); } };
}
const row = (name: string) => screen.getByRole("heading", { name, level: 3 }).closest("li")!;

it("shows every setup row with its state and why, even when the setup is ready", async () => {
 const f = setup();
 await screen.findByRole("region", { name: "Project setup" });
 await waitFor(() => { expect(within(row("Learning sources")).getByText(/Learning is off/u)).toBeTruthy(); });
 for (const name of ["Repository", "Setup commands", "Test environment", "Saved environment", "How we work", "Learning sources", "Connections used"]) expect(row(name)).toBeTruthy();
 expect(within(row("Repository")).getByText("acme/payments")).toBeTruthy();
 expect(within(row("Setup commands")).getByText("Done.")).toBeTruthy();
 expect(within(row("Learning sources")).getByText("Needs attention.")).toBeTruthy();
 expect(within(row("Connections used")).getByText(/payments-dev/u)).toBeTruthy();
 expect(within(row("Test environment")).getByText(/aren't turned on in this installation/u)).toBeTruthy();
 await waitFor(() => { expect(within(row("Saved environment")).getByText("Saved environments aren't turned on in this installation.")).toBeTruthy(); });
 expect(within(row("Saved environment")).queryByRole("button", { name: "Open" })).toBeNull();
 f.close();
});

it("opens the learning row in place with the mode control, and turns learning on from there", async () => {
 const posts: unknown[] = [];
 const f = setup({ route: (request, path) => path === "/v1/app/projects/payments/record/learning-mode" && request.method === "POST" ? (posts.push(request.body), { status: 200, body: { mode: "suggest", effective: "suggest", canChange: true } }) : undefined });
 await screen.findByRole("region", { name: "Project setup" });
 await waitFor(() => { expect(within(row("Learning sources")).getByText(/Learning is off/u)).toBeTruthy(); });
 fireEvent.click(within(row("Learning sources")).getByRole("button", { name: "Open" }));
 fireEvent.change(await screen.findByLabelText("How this project learns"), { target: { value: "suggest" } });
 fireEvent.click(screen.getByRole("button", { name: "Turn learning on" }));
 await waitFor(() => { expect(posts).toHaveLength(1); });
 f.close();
});

it("opens the setup in place for a maintainer, with the failed step, its cause and a fix", async () => {
 const failed = projectFixture();failed.project.setup = { status: "failed", failedStep: "test: npm test - 3 tests failed" };
 const f = setup({ overview: failed, route: (request, path) => path === "/v1/app/projects/payments" && request.method === "GET" ? { status: 200, body: detail } : undefined });
 await screen.findByRole("region", { name: "Project setup" });
 expect(within(row("Setup commands")).getByText(/The last check failed/u)).toBeTruthy();
 fireEvent.click(within(row("Setup commands")).getByRole("button", { name: "Open" }));
 expect(await screen.findByText("The setup check failed.")).toBeTruthy();
 expect(screen.getByText("Test command")).toBeTruthy();
 expect(screen.getByText("3 tests failed")).toBeTruthy();
 f.close();
});

it("gives a person who can't change settings the states, with nothing to open for setup", async () => {
 const viewer = projectFixture({ you: { role: "viewer", canStartWork: false, canEditSettings: false, canViewSpend: false } });
 const f = setup({ overview: viewer });
 await screen.findByRole("region", { name: "Project setup" });
 expect(within(row("Setup commands")).queryByRole("button", { name: "Open" })).toBeNull();
 expect(within(row("Test environment")).getByText("A maintainer of this project sets it up.")).toBeTruthy();
 f.close();
});

it("switches to the How we work tab from its row", async () => {
 const f = setup();
 await screen.findByRole("region", { name: "Project setup" });
 fireEvent.click(within(row("How we work")).getByRole("button", { name: "Open" }));
 await waitFor(() => { expect(screen.getByRole("tab", { name: "How we work" }).getAttribute("aria-selected")).toBe("true"); });
 f.close();
});

for (const theme of ["light", "dark"] as const) it("keeps the checklist accessible in " + theme, async () => { const f = setup({ theme });await screen.findByRole("region", { name: "Project setup" });await expectNoAxeViolations(f.container);f.close(); });

it("reads the setup row's state from the check", () => {
 expect(setupRow({ status: "ready" })).toMatchObject({ state: "done" });
 expect(setupRow({ status: "outdated" })).toMatchObject({ state: "attention", why: "The settings changed since the last check. Check them again." });
 expect(setupRow({ status: "checking" })).toMatchObject({ state: "neutral" });
});

it("splits a failed check's line into its step, cause and fix", () => {
 expect(setupFailureOf("setup: npm ci - sh: pnpm: command not found")).toMatchObject({ step: "Setup command", command: "npm ci", cause: "sh: pnpm: command not found" });
 expect(setupFailureOf("setup: npm ci - getaddrinfo ENOTFOUND registry.example")!.fix).toMatch(/Allowed websites/u);
 expect(setupFailureOf("setup: did not finish within 50 minutes")).toMatchObject({ step: "Preparing the machine", cause: "did not finish within 50 minutes" });
 expect(setupFailureOf("test: npm test - 3 tests failed")).toMatchObject({ step: "Test command", command: "npm test" });
 expect(setupFailureOf("")).toBeUndefined();
});

it("UX-4b review M3: the learning row says the team record is paused", async () => {
 const f = setup({ route: (_request, path) => path === "/v1/app/projects/payments/record/learning-mode" ? { status: 503, body: { code: "TEAM_RECORD_PAUSED", message: "x" } } : undefined });
 await screen.findByRole("region", { name: "Project setup" });
 await waitFor(() => { expect(within(row("Learning sources")).getByText(/paused in this installation/u)).toBeTruthy(); });
 f.close();
});

// SV-1l: the saved environment row, and its on/off setting opened in place.
const SAVED_ENV = "/v1/app/projects/payments/environment-image";
const savedPanel = (over: Record<string, unknown> = {}) => ({ health: "healthy", canReset: true, enabled: true, canChangeSetting: true, ...over });

it("SV-1l: a maintainer opens the saved environment row and turns it off with one Save", async () => {
 const puts: unknown[] = [];
 let enabled = true;
 const f = setup({ route: (request, path) => {
  if (path === SAVED_ENV + "/setting" && request.method === "PUT") { puts.push(request.body);enabled = (request.body as { enabled: boolean }).enabled;return { status: 200, body: { enabled, changed: true } }; }
  if (path === SAVED_ENV && request.method === "GET") return { status: 200, body: savedPanel({ enabled }) };
  return undefined;
 } });
 await screen.findByRole("region", { name: "Project setup" });
 await waitFor(() => { expect(within(row("Saved environment")).getByText("On. New tasks start from the saved copy.")).toBeTruthy(); });
 expect(within(row("Saved environment")).getByText("Done.")).toBeTruthy();
 fireEvent.click(within(row("Saved environment")).getByRole("button", { name: "Open" }));
 const opened = within(row("Saved environment"));
 expect(await opened.findByText("A maintainer of this project.")).toBeTruthy();
 fireEvent.click(opened.getByRole("switch", { name: "Use a saved environment for new tasks" }));
 fireEvent.click(opened.getByRole("button", { name: "Save" }));
 expect(await opened.findByText("Saved. New tasks set up fresh.")).toBeTruthy();
 expect(puts).toEqual([{ enabled: false }]);
 await waitFor(() => { expect(within(row("Saved environment")).getByText("Off for this project. Every new task sets up fresh.")).toBeTruthy(); });
 await expectNoAxeViolations(f.container);
 f.close();
});

it("SV-1l: a viewer opens the row to read the setting and who can change it, with no switch", async () => {
 const viewer = projectFixture({ you: { role: "viewer", canStartWork: false, canEditSettings: false, canViewSpend: false } });
 const f = setup({ overview: viewer, route: (request, path) => path === SAVED_ENV && request.method === "GET" ? { status: 200, body: savedPanel({ canReset: false, canChangeSetting: false }) } : undefined });
 await screen.findByRole("region", { name: "Project setup" });
 await waitFor(() => { expect(within(row("Saved environment")).getByRole("button", { name: "Open" })).toBeTruthy(); });
 fireEvent.click(within(row("Saved environment")).getByRole("button", { name: "Open" }));
 const opened = within(row("Saved environment"));
 expect(await opened.findByText("You can see this setting but not change it. Ask a maintainer of this project.")).toBeTruthy();
 expect(opened.queryByRole("switch")).toBeNull();
 f.close();
});

it("SV-1l: reads the saved environment row's state", () => {
 expect(savedEnvRowOf({ enabled: false, health: "healthy" })).toMatchObject({ state: "neutral", why: "Off for this project. Every new task sets up fresh." });
 expect(savedEnvRowOf({ enabled: true, health: "healthy" })).toMatchObject({ state: "done" });
 expect(savedEnvRowOf({ enabled: true, health: "needs_repair" })).toMatchObject({ state: "attention", why: "On, but the saved copy needs repair. New tasks set up fresh until the next build works." });
 expect(savedEnvRowOf({ enabled: true, health: "never_proved" })).toMatchObject({ state: "neutral" });
});

it("SV-1l: an older server that sends no setting offers nothing to open, and a 403 read is not called 'not turned on'", async () => {
 const old = setup({ route: (request, path) => path === SAVED_ENV && request.method === "GET" ? { status: 200, body: { health: "healthy", canReset: true } } : undefined });
 await screen.findByRole("region", { name: "Project setup" });
 await waitFor(() => { expect(within(row("Saved environment")).getByText("On. New tasks start from the saved copy.")).toBeTruthy(); });
 expect(within(row("Saved environment")).queryByRole("button", { name: "Open" })).toBeNull();
 old.close();
 const refused = setup({ route: (request, path) => path === SAVED_ENV && request.method === "GET" ? { status: 403, body: { code: "FORBIDDEN", message: "x" } } : undefined });
 await screen.findByRole("region", { name: "Project setup" });
 await waitFor(() => { expect(within(row("Saved environment")).getByText("The saved environment isn't shown for this sign-in.")).toBeTruthy(); });
 expect(within(row("Saved environment")).queryByRole("button", { name: "Open" })).toBeNull();
 refused.close();
});
