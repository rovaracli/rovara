// @vitest-environment jsdom
// Guided onboarding PR 9: the project setup checklist (Code #841 through Cloud), the Setup run row and Re-run setup (Code #844), Project settings for project
// admins, and Home's "Finish setting up" card. Rows come from the read, never a saved position; one required row is open at a time; optional rows can be set
// aside; a person who can't change the project sees it read-only with the admins' names; start/stop show only when Code says canManage; refusals show
// Cloud's fixed words only.
import { describe, expect, it } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { SETUP_CHECKLIST_WORDS } from "@agentx/contracts/web";
import type { ApiRequest, ApiResponse } from "../../packages/ui/src/host.js";
import { AppHostProvider } from "../../packages/ui/src/host.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { ProjectChecklist } from "../../packages/ui/src/screens/setup/ProjectChecklist.js";
import { ProjectSettingsTab } from "../../packages/ui/src/screens/project/ProjectSettingsTab.js";
import { FinishSetup } from "../../packages/ui/src/screens/home/FinishSetup.js";
import { fakeHost } from "./support/fake-host.js";
import { renderUi } from "./support/render.js";
import { h } from "./support/h.js";
import { expectNoAxeViolations } from "./support/axe.js";
import { navFixture, meFixture } from "./support/fixtures.js";
import type { ReactElement } from "react";

const LEAK = "SENSITIVE-SERVER-DETAIL";
function checklist(extra: Record<string, unknown> = {}) {
  return {
    project: "web",
    viewer: { companyRole: "owner", projectAdmin: false, canSkip: true },
    progress: { done: 2, total: 8, percent: 25, nextRequired: "setupRun" },
    repos: { state: "done", count: 2, items: [{ name: "web", fullName: "acme/web", defaultBranch: "main" }, { name: "api", fullName: "acme/api", defaultBranch: "main" }] },
    setupRun: { state: "failed", status: "failed", startedAt: "2026-11-17T10:00:00.000Z", elapsedMs: 300000, costCents: 31, commandsRun: 4, commandsFound: { setup: 1, tests: 1 }, testOutcome: "failed", failure: "A test command failed.", failedCommand: { n: 2, command: "npm test", exitCode: 1, timedOut: false, lastLines: ["FAIL src/app.test.ts", "expected 2"] } },
    evalConfirm: { state: "needs_you", report: "none", blockedBy: "setupRun" },
    aiAndSpend: { state: "done", source: "default", companyModelSaved: false, modelBudgetUsd: null },
    slackChannel: { state: "optional", channels: [] },
    linear: { state: "optional", team: null },
    invites: { state: "optional" },
    firstTask: { state: "needs_you", hasTask: false, canStart: false },
    ...extra,
  };
}
const runView = (status: string, canManage: boolean) => ({ status, basedOnRevision: 3, limits: { commands: 40, sameStepTries: 3, wallClockMin: 45, budgetCents: 400, hostAsks: 5 }, canManage });

interface Options { status?: () => ApiResponse; run?: () => ApiResponse; post?: (request: ApiRequest) => ApiResponse; role?: "owner" | "admin" | "member"; projects?: string[] }
function mount(element: ReactElement, options: Options = {}) {
  const f = fakeHost(async (request) => {
    if (request.path === "/v1/app/projects/web/setup-status") return options.status?.() ?? { status: 200, body: checklist() };
    if (request.path === "/v1/app/projects/web/setup-status/skips") return options.post?.(request) ?? { status: 200, body: { project: "web", row: (request.body as { row: string }).row, skipped: (request.body as { skipped: boolean }).skipped, skippedRows: [] } };
    if (request.path === "/v1/app/projects/web/setup-agent" && request.method === "GET") return options.run?.() ?? { status: 200, body: runView("failed", true) };
    if (request.path.startsWith("/v1/app/projects/web/setup-agent") && request.method === "POST") return options.post?.(request) ?? { status: 200, body: runView("running", true) };
    if (request.path.startsWith("/v1/app/projects/web/setup-agent/journal")) return { status: 200, body: { status: "failed", entries: [], hostAsks: [] } };
    if (request.path === "/v1/app/org/members") return { status: 200, body: { members: [{ developerId: "b".repeat(64), name: "Priya", role: "admin", joinedAt: "2026-10-23", identities: [] }, { developerId: "c".repeat(64), name: "Sam", role: "member", joinedAt: "2026-10-23", identities: [] }] } };
    if (request.path === "/v1/app/github/connections") return { status: 200, body: { installations: [{ installationId: 11, accountLogin: "acme", connectedAt: "2026-11-17T00:00:00Z", connectedBy: { kind: "operator" } }] } };
    if (request.path === "/v1/app/slack") return { status: 200, body: { workspace: null } };
    if (request.path === "/v1/app/linear") return { status: 200, body: { status: "disconnected" } };
    if (request.path === "/v1/app/projects/web/slack/channel") return { status: 200, body: { connected: false, channels: [] } };
    if (request.path === "/v1/app/nav") { const nav = navFixture(); return { status: 200, body: { ...nav, me: { ...nav.me, orgRole: options.role ?? "owner" }, projects: (options.projects ?? ["web"]).map((name) => ({ name, agents: [] })) } }; }
    if (request.path === "/v1/app/me") { const me = meFixture(); me.developer.orgRole = options.role ?? "owner"; return { status: 200, body: me }; }
    if (request.path === "/v1/app/projects/web/lifecycle") return { status: 200, body: { status: "active", actions: options.role === "member" ? [] : ["archive"] } };
    return { status: 404, body: { error: { code: "NOT_FOUND", message: "route not found" } } };
  });
  const query = createQueryClient();
  const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(MemoryRouter, { initialEntries: ["/app/projects/web"], children: element }) }) }), { theme: "light" });
  return { ...f, close() { ui.unmount(); query.clear(); } };
}
const calls = (f: ReturnType<typeof mount>, method: string, path: string) => f.request.mock.calls.map(([request]) => request).filter((request) => request.method === method && request.path === path);

describe("the project checklist", () => {
  it("shows every row's state from the read, with only the next required row open", async () => {
    const f = mount(h(ProjectChecklist, { project: "web" }));
    await screen.findByTestId("project-checklist");
    expect(screen.getByTestId("checklist-progress").textContent).toContain("25% done (2 of 8)");
    const state = (row: string) => screen.getByTestId(`checklist-row-${row}`).getAttribute("data-state");
    expect(["repos", "setupRun", "evalConfirm", "aiAndSpend", "slackChannel", "linear", "invites", "firstTask"].map(state)).toEqual(["done", "failed", "needs_you", "done", "optional", "optional", "optional", "needs_you"]);
    const open = (row: string) => (screen.getByTestId(`checklist-row-${row}`).querySelector("details") as HTMLDetailsElement).open;
    expect(open("setupRun")).toBe(true);
    expect(open("repos")).toBe(false);
    expect(open("evalConfirm")).toBe(false);
    expect(within(screen.getByTestId("checklist-row-repos")).getByText("acme/api")).toBeTruthy();
    await expectNoAxeViolations(document.body);
    f.close();
  });

  it("a failed setup run shows the failing command, its last lines, Edit commands and Run again (Code says canManage)", async () => {
    const f = mount(h(ProjectChecklist, { project: "web" }));
    const row = await screen.findByTestId("setup-run-row");
    expect(within(row).getByTestId("setup-run-failure").textContent).toBe("A test command failed.");
    expect(within(row).getByTestId("setup-run-failed-command").textContent).toContain("npm test");
    expect(within(row).getByTestId("setup-run-failed-command").textContent).toContain("FAIL src/app.test.ts");
    expect(within(row).getByTestId("setup-run-facts").textContent).toBe("Commands found: 1 to set up, 1 to test. Tests failed. Took 5 minutes, cost $0.31.");
    expect(within(row).getByTestId("setup-run-edit").getAttribute("href")).toBe("/app/onboard?project=web&step=setup");
    fireEvent.click(await within(row).findByRole("button", { name: "Run again" }));
    await waitFor(() => expect(calls(f, "POST", "/v1/app/projects/web/setup-agent")).toHaveLength(1));
    expect(Object.keys(calls(f, "POST", "/v1/app/projects/web/setup-agent")[0]!.body as object)).toEqual(["requestId"]);
    f.close();
  });

  it("offers no Run or Stop when Code says the person may not manage the run", async () => {
    const f = mount(h(ProjectChecklist, { project: "web" }), { run: () => ({ status: 200, body: runView("failed", false) }) });
    await screen.findByTestId("setup-run-row");
    await waitFor(() => expect(calls(f, "GET", "/v1/app/projects/web/setup-agent")).toHaveLength(1));
    expect(screen.queryByTestId("setup-run-controls")).toBeNull();
    expect(screen.queryByRole("button", { name: "Run again" })).toBeNull();
    f.close();
  });

  it("shows only Cloud's fixed words when a start is refused", async () => {
    const f = mount(h(ProjectChecklist, { project: "web" }), { post: () => ({ status: 409, body: { error: { code: "WORKSPACE_BUSY", message: SETUP_CHECKLIST_WORDS.busy } } }) });
    fireEvent.click(await screen.findByRole("button", { name: "Run again" }));
    expect((await screen.findByTestId("setup-run-error")).textContent).toBe(SETUP_CHECKLIST_WORDS.busy);
    f.close();
    const g = mount(h(ProjectChecklist, { project: "web" }), { post: () => ({ status: 409, body: { error: { code: "WORKSPACE_BUSY", message: LEAK } } }) });
    fireEvent.click(await screen.findByRole("button", { name: "Run again" }));
    expect((await screen.findByTestId("setup-run-error")).textContent).toBe("Couldn't do that just now. Try again.");
    expect(document.body.textContent).not.toContain(LEAK);
    g.close();
  });

  it("Set up later on Invite teammates sends exactly {row, skipped:true}; a refusal shows only fixed words", async () => {
    const f = mount(h(ProjectChecklist, { project: "web" }));
    fireEvent.click(await screen.findByTestId("checklist-skip-invites"));
    await waitFor(() => expect(calls(f, "PUT", "/v1/app/projects/web/setup-status/skips")).toHaveLength(1));
    expect(calls(f, "PUT", "/v1/app/projects/web/setup-status/skips")[0]!.body).toEqual({ row: "invites", skipped: true });
    f.close();
    const g = mount(h(ProjectChecklist, { project: "web" }), { post: () => ({ status: 403, body: { error: { code: "FORBIDDEN", message: LEAK } } }) });
    fireEvent.click(await screen.findByTestId("checklist-skip-invites"));
    expect((await screen.findByTestId("checklist-error")).textContent).toBe("That couldn't be saved just now. Try again.");
    g.close();
  });

  it("skipped optional rows say so and count; the checklist hides on the project page once everything is done or skipped", async () => {
    const f = mount(h(ProjectChecklist, { project: "web" }), { status: () => ({ status: 200, body: checklist({ invites: { state: "skipped" } }) }) });
    expect((await screen.findByTestId("checklist-row-invites")).textContent).toContain("Skipped (optional)");
    f.close();
    const g = mount(h(ProjectChecklist, { project: "web" }), { status: () => ({ status: 200, body: checklist({ progress: { done: 8, total: 8, percent: 100, nextRequired: null } }) }) });
    await waitFor(() => expect(calls(g, "GET", "/v1/app/projects/web/setup-status")).toHaveLength(1));
    expect(screen.queryByTestId("project-checklist")).toBeNull();
    g.close();
  });

  it("is read-only for a person who can't change the project, pointing to the company's admins without asking for the admin-only members list", async () => {
    const f = mount(h(ProjectChecklist, { project: "web" }), { status: () => ({ status: 200, body: checklist({ viewer: { companyRole: "member", projectAdmin: false, canSkip: false } }) }), run: () => ({ status: 200, body: runView("failed", false) }) });
    expect(await screen.findByText("Ask your company's admins to finish setup.")).toBeTruthy();
    expect(calls(f, "GET", "/v1/app/org/members")).toHaveLength(0);
    expect(screen.queryByTestId("checklist-skip-invites")).toBeNull();
    expect(screen.queryByTestId("checklist-company")).toBeNull();
    f.close();
  });

  it("shows nothing while Code doesn't serve the checklist; an unreadable read says fixed words only", async () => {
    const f = mount(h(ProjectChecklist, { project: "web" }), { status: () => ({ status: 501, body: { error: { code: "NOT_ON_CODE_YET", message: SETUP_CHECKLIST_WORDS.notYet } } }) });
    await waitFor(() => expect(calls(f, "GET", "/v1/app/projects/web/setup-status")).toHaveLength(1));
    expect(screen.queryByTestId("project-checklist")).toBeNull();
    f.close();
    const g = mount(h(ProjectChecklist, { project: "web" }), { status: () => ({ status: 403, body: { error: { code: "FORBIDDEN", message: LEAK } } }) });
    expect((await screen.findByTestId("checklist-read-error")).textContent).toBe("The project's setup couldn't be read just now. Try again.");
    g.close();
  });

  it("the first task is offered only when Code says it can start", async () => {
    const f = mount(h(ProjectChecklist, { project: "web" }), { status: () => ({ status: 200, body: checklist({ firstTask: { state: "needs_you", hasTask: false, canStart: true }, progress: { done: 6, total: 8, percent: 75, nextRequired: "firstTask" } }) }) });
    expect((await screen.findByTestId("checklist-start-task")).getAttribute("href")).toBe("/app/projects/web#start-work");
    f.close();
  });
});

describe("Project settings", () => {
  it("a manager gets Re-run setup and Archive; Re-run sends exactly {requestId}", async () => {
    const f = mount(h(ProjectSettingsTab, { project: "web", canEdit: true }), { run: () => ({ status: 200, body: runView("ready", true) }) });
    fireEvent.click(await screen.findByRole("button", { name: "Re-run setup" }));
    await waitFor(() => expect(calls(f, "POST", "/v1/app/projects/web/setup-agent")).toHaveLength(1));
    expect(await screen.findByRole("button", { name: "Review archive" })).toBeTruthy();
    f.close();
  });

  it("a project user gets no Re-run setup and no Archive", async () => {
    const f = mount(h(ProjectSettingsTab, { project: "web", canEdit: false }), { role: "member", run: () => ({ status: 200, body: runView("ready", false) }) });
    await screen.findByTestId("project-settings-lifecycle-none");
    expect(screen.queryByRole("button", { name: "Re-run setup" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Review archive" })).toBeNull();
    f.close();
  });
});

describe("Home", () => {
  it("shows a Finish setting up card for an unfinished project", async () => {
    const f = mount(h(FinishSetup, {}));
    const card = await screen.findByTestId("home-finish-setup");
    expect(card.textContent).toContain("Finish setting up web");
    expect(card.textContent).toContain("25% done. Next: the setup run.");
    f.close();
  });

  it("points an admin with no project to Pick repos, and a member to the admins without asking for the members list", async () => {
    const f = mount(h(FinishSetup, {}), { projects: [] });
    expect((await screen.findByRole("link", { name: "Pick repos" })).getAttribute("href")).toBe("/app/onboard?step=repositories");
    f.close();
    const g = mount(h(FinishSetup, {}), { projects: [], role: "member" });
    expect(await screen.findByText("Ask your company's admins to add you to a project.")).toBeTruthy();
    expect(calls(g, "GET", "/v1/app/org/members")).toHaveLength(0);
    g.close();
  });
});
