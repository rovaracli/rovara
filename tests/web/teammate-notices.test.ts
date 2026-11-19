// @vitest-environment jsdom
// Guided onboarding PR 13: a teammate's welcome on Home (their projects, each project's Slack channel, Start a task / See what's running, no setup screens;
// dismissed once seen), and the "connection needs attention" banner and Home cards for company owners and admins (GitHub suspended or removed, Rovara removed
// from Slack, Linear refusing the token). Nothing is asked about connections for a plain member.
import { describe, expect, it } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, RouterProvider, createMemoryRouter } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import type { ApiResponse } from "../../packages/ui/src/host.js";
import { AppHostProvider } from "../../packages/ui/src/host.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { appRoutes } from "../../packages/ui/src/routes.js";
import { ThemeProvider } from "../../packages/ui/src/theme.js";
import { TeammateWelcome } from "../../packages/ui/src/screens/home/TeammateWelcome.js";
import { IntegrationBanner, IntegrationNoticeCards } from "../../packages/ui/src/screens/connect/integration-notices.js";
import { fakeHost } from "./support/fake-host.js";
import { renderUi } from "./support/render.js";
import { h } from "./support/h.js";
import { expectNoAxeViolations } from "./support/axe.js";
import { navFixture } from "./support/fixtures.js";
import type { ReactElement } from "react";

const AT = "2026-11-17T12:00:00.000Z";
const checklistWith = (channels: unknown[], repoItems: unknown[] = []) => ({
  project: "payments", viewer: { companyRole: "member", projectAdmin: false, canSkip: false }, progress: { done: 8, total: 8, percent: 100, nextRequired: null },
  repos: { state: "done", count: 1, items: repoItems }, setupRun: { state: "done", status: "ready", approval: "approved", check: { status: "ready" } }, evalConfirm: { state: "done", report: "confirmed" }, aiAndSpend: { state: "done", source: "default", companyModelSaved: false, modelBudgetUsd: null },
  slackChannel: { state: channels.length > 0 ? "done" : "optional", channels }, linear: { state: "optional", team: null }, invites: { state: "optional" }, firstTask: { state: "done", hasTask: true, canStart: true },
});
interface Options { repoItems?: unknown[]; path?: string; role?: "owner" | "admin" | "member"; projects?: string[]; github?: unknown; slack?: unknown; linear?: unknown; storage?: Record<string, string> }
function mount(element: ReactElement, options: Options = {}) {
  const f = fakeHost(async (request): Promise<ApiResponse> => {
    if (request.path === "/v1/app/nav") return { status: 200, body: navFixture({ me: { developerId: "a".repeat(64), name: "Sam", orgRole: options.role ?? "member" }, projects: (options.projects ?? ["payments"]).map((name) => ({ name, agents: [] })) }) };
    if (request.path === "/v1/app/projects/payments/setup-status") return { status: 200, body: checklistWith([{ channelId: "CPAY00001", name: "payments-dev" }], options.repoItems) };
    if (request.path === "/v1/app/github/connections") return { status: 200, body: options.github ?? { installations: [] } };
    if (request.path === "/v1/app/slack") return { status: 200, body: options.slack ?? { workspace: null } };
    if (request.path === "/v1/app/linear") return { status: 200, body: options.linear ?? { status: "disconnected" } };
    return { status: 404, body: { error: { code: "NOT_FOUND", message: "route not found" } } };
  });
  for (const [key, value] of Object.entries(options.storage ?? {})) f.host.storage.set(key, value);
  const query = createQueryClient();
  const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(MemoryRouter, { initialEntries: [options.path ?? "/app?joined=1"], children: element }) }) }), { theme: "light" });
  return { ...f, close() { ui.unmount(); query.clear(); } };
}
const asked = (f: ReturnType<typeof mount>, path: string) => f.request.mock.calls.some(([request]) => request.path === path);

describe("a teammate's welcome", () => {
  it("names the company, the projects, each project's Slack channel, and the two ways in; no setup screens", async () => {
    const f = mount(h(TeammateWelcome, {}));
    const welcome = await screen.findByTestId("teammate-welcome");
    expect(welcome.textContent).toContain("Welcome to Acme");
    await waitFor(() => expect(screen.getByTestId("welcome-project").textContent).toContain("payments · Slack: #payments-dev"));
    expect(screen.getByRole("link", { name: "Start a task" }).getAttribute("href")).toBe("/app/projects/payments#start-work");
    expect(screen.getByRole("link", { name: "See what's running" }).getAttribute("href")).toBe("/app/live");
    expect(welcome.textContent).not.toMatch(/setup|Connect GitHub/iu);
    await expectNoAxeViolations(document.body);
    f.close();
  });

  it("is dismissed once seen, and stays dismissed for that person", async () => {
    const f = mount(h(TeammateWelcome, {}));
    fireEvent.click(await screen.findByTestId("welcome-dismiss"));
    expect(screen.queryByTestId("teammate-welcome")).toBeNull();
    expect(f.storage.get(`rovara.welcome.seen.${"a".repeat(64)}`)).toBe("1");
    f.close();
    const g = mount(h(TeammateWelcome, {}), { storage: { [`rovara.welcome.seen.${"a".repeat(64)}`]: "1" } });
    await waitFor(() => expect(asked(g, "/v1/app/nav")).toBe(true));
    expect(screen.queryByTestId("teammate-welcome")).toBeNull();
    g.close();
  });

  it("is shown only right after joining (not to an existing member on an ordinary visit, nor to a person with no project), and asks nothing when hidden", async () => {
    for (const role of ["member", "admin"] as const) {
      const f = mount(h(TeammateWelcome, {}), { path: "/app", role });
      await waitFor(() => expect(asked(f, "/v1/app/nav")).toBe(true));
      await new Promise((done) => setTimeout(done, 30));
      expect(screen.queryByTestId("teammate-welcome")).toBeNull();
      expect(asked(f, "/v1/app/projects/payments/setup-status")).toBe(false);
      f.close();
    }
    const g = mount(h(TeammateWelcome, {}), { projects: [] });
    await waitFor(() => expect(asked(g, "/v1/app/nav")).toBe(true));
    expect(screen.queryByTestId("teammate-welcome")).toBeNull();
    g.close();
  });

  it("still shows when the browser's storage can't be read", async () => {
    const f = mount(h(TeammateWelcome, {}));
    f.host.storage.get = () => { throw new Error("blocked"); };
    f.host.storage.set = () => { throw new Error("blocked"); };
    expect(await screen.findByTestId("teammate-welcome")).toBeTruthy();
    fireEvent.click(screen.getByTestId("welcome-dismiss"));
    expect(screen.queryByTestId("teammate-welcome")).toBeNull();
    f.close();
  });
});

describe("in the app", () => {
  function app(role: "member" | "owner", path: string, broken = false) {
    const nav = navFixture({ me: { developerId: "a".repeat(64), name: "Sam", orgRole: role }, projects: [{ name: "payments", agents: [] }] });
    const f = fakeHost(async (request): Promise<ApiResponse> => {
      if (request.path === "/v1/app/nav") return { status: 200, body: nav };
      if (request.path === "/v1/app/home") return { status: 200, body: { cards: [], total: 0 } };
      if (request.path === "/v1/app/projects/payments/setup-status") return { status: 200, body: checklistWith([]) };
      if (request.path === "/v1/app/github/connections") return { status: 200, body: { installations: [] } };
      if (request.path === "/v1/app/slack") return { status: 200, body: { workspace: broken ? { teamName: "Acme", state: "disconnected", connectedAt: AT, connectedBy: { kind: "person" } } : null } };
      if (request.path === "/v1/app/linear") return { status: 200, body: { status: "disconnected" } };
      return { status: 404, body: { error: { code: "NOT_FOUND", message: "route not found" } } };
    });
    const query = createQueryClient();query.setQueryData(["nav"], nav);
    const router = createMemoryRouter(appRoutes(nav.features), { initialEntries: [path] });
    const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(ThemeProvider, { host: f.host, children: h(RouterProvider, { router }) }) }) }));
    return { ...f, close() { ui.unmount(); router.dispose(); query.clear(); } };
  }

  it("a new teammate gets the welcome on Home and no connection reads", async () => {
    const f = app("member", "/app?joined=1", true);
    expect(await screen.findByTestId("teammate-welcome")).toBeTruthy();
    // The banner's chunk loads lazily: give it time to mount and (wrongly) ask.
    await new Promise((done) => setTimeout(done, 400));
    expect(["/v1/app/github/connections", "/v1/app/slack", "/v1/app/linear"].some((path) => asked(f as never, path))).toBe(false);
    expect(screen.queryByTestId("integration-banner")).toBeNull();
    f.close();
  });

  it("an owner with a broken connection gets the banner and the Home card", async () => {
    const f = app("owner", "/app", true);
    expect((await screen.findByTestId("integration-banner")).textContent).toContain("Rovara was removed from Acme.");
    expect((await screen.findByTestId("integration-notice")).textContent).toContain("Rovara was removed from Acme.");
    f.close();
  });
});

describe("connection notices", () => {
  const broken = { github: { installations: [{ installationId: 11, accountLogin: "acme", status: "uninstalled", connectedAt: AT, connectedBy: { kind: "operator" } }, { installationId: 13, accountLogin: "gamma", status: "suspended", connectedAt: AT, connectedBy: { kind: "operator" } }, { installationId: 12, accountLogin: "beta", status: "active", connectedAt: AT, connectedBy: { kind: "operator" } }] }, slack: { workspace: { teamName: "Acme", state: "disconnected", connectedAt: AT, connectedBy: { kind: "person" } } }, linear: { status: "needs_reconnect", workspace: { name: "Acme Linear", urlKey: "acme" } } };

  it("a company admin sees one Home card per broken connection, each pointing to Connections", async () => {
    const f = mount(h(IntegrationNoticeCards, { admin: true }), { ...broken });
    await waitFor(() => expect(screen.getAllByTestId("integration-notice")).toHaveLength(4));
    const text = screen.getAllByTestId("integration-notice").map((card) => card.textContent).join("\n");
    expect(text).toContain("GitHub disconnected: the Rovara app was removed from acme.");
    expect(text).toContain("GitHub suspended the Rovara app on gamma.");
    expect(text).toContain("Rovara was removed from Acme.");
    expect(text).toContain("Linear refused Rovara's token for Acme Linear.");
    expect(text).not.toContain("beta");
    expect(screen.getAllByRole("link", { name: "Open Connections" })[0]!.getAttribute("href")).toBe("/app/admin/connections");
    f.close();
  });

  it("the banner counts them and names the first", async () => {
    const f = mount(h(IntegrationBanner, { admin: true }), { ...broken });
    const banner = await screen.findByTestId("integration-banner");
    await waitFor(() => expect(banner.textContent).toContain("4 connections need attention."));
    expect(screen.getByRole("link", { name: "Company settings, Connections" }).getAttribute("href")).toBe("/app/admin/connections");
    f.close();
  });

  it("shows nothing when every connection works, and asks nothing for a plain member", async () => {
    const f = mount(h(IntegrationBanner, { admin: true }));
    await waitFor(() => expect(asked(f, "/v1/app/linear")).toBe(true));
    expect(screen.queryByTestId("integration-banner")).toBeNull();
    f.close();
    const g = mount(h(IntegrationNoticeCards, { admin: false }), { ...broken });
    await new Promise((done) => setTimeout(done, 50));
    expect(screen.queryByTestId("integration-notice")).toBeNull();
    expect(asked(g, "/v1/app/github/connections") || asked(g, "/v1/app/slack") || asked(g, "/v1/app/linear")).toBe(false);
    g.close();
  });
});

describe("repository notices (DEC 254zc(1))", () => {
  const moved = [{ name: "payments", fullName: "acme/payments", defaultBranch: "main", access: "transferred" }, { name: "ledger", fullName: "acme/ledger", defaultBranch: "main", access: "removed" }, { name: "docs", fullName: "acme/docs", defaultBranch: "main" }];

  it("a company admin gets one fixed line per repository GitHub says is gone, by its access word, and none for an ordinary one", async () => {
    const f = mount(h(IntegrationNoticeCards, { admin: true }), { repoItems: moved });
    await waitFor(() => expect(screen.getAllByTestId("integration-notice")).toHaveLength(2));
    const lines = screen.getAllByTestId("integration-notice").map((card) => card.querySelector(".rv-attention-reason")?.textContent);
    expect(lines).toEqual([
      "acme/payments in payments was moved to another GitHub owner. Tasks can't reach it until the project points at its new address.",
      "acme/ledger in payments is no longer shared with the Rovara app on GitHub. Tasks can't reach it until it's added back.",
    ]);
    expect(screen.getAllByRole("link", { name: "Open Connections" })[0]!.getAttribute("href")).toBe("/app/admin/connections");
    f.close();
  });

  it("the banner counts them with the other broken connections", async () => {
    const f = mount(h(IntegrationBanner, { admin: true }), { repoItems: moved });
    const banner = await screen.findByTestId("integration-banner");
    await waitFor(() => expect(banner.textContent).toContain("2 connections need attention."));
    expect(banner.textContent).toContain("acme/payments in payments was moved to another GitHub owner.");
    f.close();
  });

  it("nothing is shown when no repository has an access word, and a plain member's page asks nothing about projects", async () => {
    const f = mount(h(IntegrationNoticeCards, { admin: true }), { repoItems: [moved[2]] });
    await waitFor(() => expect(asked(f, "/v1/app/projects/payments/setup-status")).toBe(true));
    await new Promise((done) => setTimeout(done, 30));
    expect(screen.queryByTestId("integration-notice")).toBeNull();
    f.close();
    const g = mount(h(IntegrationNoticeCards, { admin: false }), { repoItems: moved });
    await new Promise((done) => setTimeout(done, 50));
    expect(screen.queryByTestId("integration-notice")).toBeNull();
    expect(asked(g, "/v1/app/projects/payments/setup-status")).toBe(false);
    g.close();
  });

  it("asks about no more than twenty projects", async () => {
    const names = Array.from({ length: 25 }, (_, index) => `p${String(index)}`);
    const f = mount(h(IntegrationNoticeCards, { admin: true }), { projects: names });
    await waitFor(() => expect(asked(f, "/v1/app/nav")).toBe(true));
    await new Promise((done) => setTimeout(done, 50));
    expect(f.request.mock.calls.filter(([request]) => String(request.path).endsWith("/setup-status")).length).toBe(20);
    f.close();
  });
});
