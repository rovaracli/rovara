// @vitest-environment jsdom
// Guided onboarding PR 13: a teammate's welcome on Home (their projects, each project's Slack channel, Start a task / See what's running, no setup screens;
// dismissed once seen), and the "connection needs attention" banner and Home cards for company owners and admins (GitHub suspended or removed, Rovara removed
// from Slack, Linear refusing the token). Nothing is asked about connections for a plain member.
import { describe, expect, it } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import type { ApiResponse } from "../../packages/ui/src/host.js";
import { AppHostProvider } from "../../packages/ui/src/host.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { TeammateWelcome } from "../../packages/ui/src/screens/home/TeammateWelcome.js";
import { IntegrationBanner, IntegrationNoticeCards } from "../../packages/ui/src/screens/connect/integration-notices.js";
import { fakeHost } from "./support/fake-host.js";
import { renderUi } from "./support/render.js";
import { h } from "./support/h.js";
import { expectNoAxeViolations } from "./support/axe.js";
import { navFixture } from "./support/fixtures.js";
import type { ReactElement } from "react";

const AT = "2026-11-17T12:00:00.000Z";
const checklistWith = (channels: unknown[]) => ({
  project: "payments", viewer: { companyRole: "member", projectAdmin: false, canSkip: false }, progress: { done: 8, total: 8, percent: 100, nextRequired: null },
  repos: { state: "done", count: 1, items: [] }, setupRun: { state: "done", status: "ready" }, evalConfirm: { state: "done", report: "confirmed" }, aiAndSpend: { state: "done", source: "default", companyModelSaved: false, modelBudgetUsd: null },
  slackChannel: { state: channels.length > 0 ? "done" : "optional", channels }, linear: { state: "optional", team: null }, invites: { state: "optional" }, firstTask: { state: "done", hasTask: true, canStart: true },
});
interface Options { path?: string; role?: "owner" | "admin" | "member"; projects?: string[]; github?: unknown; slack?: unknown; linear?: unknown; storage?: Record<string, string> }
function mount(element: ReactElement, options: Options = {}) {
  const f = fakeHost(async (request): Promise<ApiResponse> => {
    if (request.path === "/v1/app/nav") return { status: 200, body: navFixture({ me: { developerId: "a".repeat(64), name: "Sam", orgRole: options.role ?? "member" }, projects: (options.projects ?? ["payments"]).map((name) => ({ name, agents: [] })) }) };
    if (request.path === "/v1/app/projects/payments/setup-status") return { status: 200, body: checklistWith([{ channelId: "CPAY00001", name: "payments-dev" }]) };
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
    const f = mount(h(TeammateWelcome, {}), { path: "/app" });
    fireEvent.click(await screen.findByTestId("welcome-dismiss"));
    expect(screen.queryByTestId("teammate-welcome")).toBeNull();
    expect(f.storage.get(`rovara.welcome.seen.${"a".repeat(64)}`)).toBe("1");
    f.close();
    const g = mount(h(TeammateWelcome, {}), { path: "/app", storage: { [`rovara.welcome.seen.${"a".repeat(64)}`]: "1" } });
    await waitFor(() => expect(asked(g, "/v1/app/nav")).toBe(true));
    expect(screen.queryByTestId("teammate-welcome")).toBeNull();
    g.close();
  });

  it("is not shown to a company admin on an ordinary visit, nor to a person with no project (Home's empty state names the admins)", async () => {
    const f = mount(h(TeammateWelcome, {}), { path: "/app", role: "admin" });
    await waitFor(() => expect(asked(f, "/v1/app/nav")).toBe(true));
    expect(screen.queryByTestId("teammate-welcome")).toBeNull();
    f.close();
    const g = mount(h(TeammateWelcome, {}), { projects: [] });
    await waitFor(() => expect(asked(g, "/v1/app/nav")).toBe(true));
    expect(screen.queryByTestId("teammate-welcome")).toBeNull();
    g.close();
  });
});

describe("connection notices", () => {
  const broken = { github: { installations: [{ installationId: 11, accountLogin: "acme", status: "uninstalled", connectedAt: AT, connectedBy: { kind: "operator" } }, { installationId: 12, accountLogin: "beta", status: "active", connectedAt: AT, connectedBy: { kind: "operator" } }] }, slack: { workspace: { teamName: "Acme", state: "disconnected", connectedAt: AT, connectedBy: { kind: "person" } } }, linear: { status: "needs_reconnect", workspace: { name: "Acme Linear", urlKey: "acme" } } };

  it("a company admin sees one Home card per broken connection, each pointing to Connections", async () => {
    const f = mount(h(IntegrationNoticeCards, { admin: true }), { ...broken });
    await waitFor(() => expect(screen.getAllByTestId("integration-notice")).toHaveLength(3));
    const text = screen.getAllByTestId("integration-notice").map((card) => card.textContent).join("\n");
    expect(text).toContain("GitHub disconnected: the Rovara app was removed from acme.");
    expect(text).toContain("Rovara was removed from Acme.");
    expect(text).toContain("Linear refused Rovara's token for Acme Linear.");
    expect(text).not.toContain("beta");
    expect(screen.getAllByRole("link", { name: "Open Connections" })[0]!.getAttribute("href")).toBe("/app/admin/connections");
    f.close();
  });

  it("the banner counts them and names the first", async () => {
    const f = mount(h(IntegrationBanner, { admin: true }), { ...broken });
    const banner = await screen.findByTestId("integration-banner");
    await waitFor(() => expect(banner.textContent).toContain("3 connections need attention."));
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
