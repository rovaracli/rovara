// @vitest-environment jsdom
// TRUTH-BUNDLE (owner DEC 540: the product never claims a protection or shows a control it does not have). Each change has a screen test, and the removed sentence/box must not render.
import { afterEach, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { ProjectScreen } from "../../packages/ui/src/screens/project/ProjectScreen.js";
import { AppHostProvider, type ApiRequest, type ApiResponse } from "../../packages/ui/src/host.js";
import { Announcer } from "../../packages/ui/src/design/Announcer.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { ADMIN_GROUPS, visibleAdminGroups } from "../../packages/ui/src/screens/admin/admin-nav.js";
import { renderUi } from "./support/render.js";
import { fakeHost } from "./support/fake-host.js";
import { h } from "./support/h.js";
import { projectFixture } from "./support/project-fixture.js";
import { identity } from "./read-only/company-admin-read/fixtures.js";
import { mount } from "./read-only/company-admin-read/mount.js";

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const ok = (body: unknown): ApiResponse => ({ status: 200, body });
const missing: ApiResponse = { status: 404, body: { error: { code: "NOT_FOUND", message: "Not found." } } };

function project(options: { path?: string; slack?: (request: ApiRequest) => ApiResponse; overview?: unknown } = {}) {
 const f = fakeHost(async request => {
  const path = request.path.split("?")[0];
  if (path === "/v1/app/changes") return ok({ notices: [], next: "settled" });
  if (path === "/v1/app/projects/payments/overview") return ok(options.overview ?? projectFixture());
  if (path === "/v1/app/projects/payments/slack/channel" || path === "/v1/app/slack/channels") return options.slack?.(request) ?? missing;
  return missing;
 });
 const query = createQueryClient();
 const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(MemoryRouter, { initialEntries: [options.path ?? "/app/projects/payments"], children: h(Announcer, { children: h(Routes, { children: h(Route, { path: "/app/projects/:name", element: h(ProjectScreen, {}) }) }) }) }) }) }), { theme: "light" });
 return { ...f, ...ui, query };
}

it("the project page does not say who can see its sessions, and its running list says whose tasks it holds", async () => {
 const f = project();
 await screen.findByRole("heading", { name: "payments" });
 expect(await screen.findByRole("heading", { name: "Your running tasks" })).toBeTruthy();
 expect(screen.queryByRole("heading", { name: "Running now" })).toBeNull();
 expect(document.body.textContent).not.toMatch(/can see its sessions|Slack channel\./u);
 expect(document.querySelector(".rv-project-visibility")).toBeNull();
 f.unmount();
});

it("with nothing running, the empty line says it is about the person's own tasks", async () => {
 const f = project({ overview: projectFixture({ running: [] }) });
 expect(await screen.findByText("None of your tasks in this project are running right now.")).toBeTruthy();
 expect(screen.queryByText("No sessions are running here right now.")).toBeNull();
 f.unmount();
});

it("the header shows the linked Slack channel from the existing route (name for an editor)", async () => {
 const f = project({ slack: request => request.path.startsWith("/v1/app/slack/channels") ? ok({ channels: [{ id: "C0123ABCD", name: "payments-dev", isPrivate: false }] }) : ok({ connected: true, channels: [{ id: "C0123ABCD" }] }) });
 const channel = await screen.findByTestId("project-slack-channel");
 await waitFor(() => expect(channel.textContent).toBe("Slack #payments-dev"));
 expect(f.request.mock.calls.every(([request]) => request.method === "GET")).toBe(true);
 expect(f.request.mock.calls.some(([request]) => request.path === "/v1/app/projects/payments/slack/channel")).toBe(true);
 f.unmount();
});

it("a person who cannot edit sees that a channel is linked, never its raw id", async () => {
 const f = project({ overview: projectFixture({ you: { role: "contributor", canStartWork: true, canEditSettings: false, canViewSpend: false } }), slack: () => ok({ connected: true, channels: [{ id: "C0123ABCD" }] }) });
 expect((await screen.findByTestId("project-slack-channel")).textContent).toBe("A linked Slack channel");
 expect(document.body.textContent).not.toContain("C0123ABCD");
 expect(f.request.mock.calls.some(([request]) => request.path === "/v1/app/slack/channels")).toBe(false);
 f.unmount();
});

it("no channel is drawn when none is linked, the workspace is not connected, or the read is refused", async () => {
 for (const slack of [() => ok({ connected: true, channels: [] }), () => ok({ connected: false, channels: [{ id: "C0123ABCD" }] }), () => ({ status: 403, body: { error: { code: "FORBIDDEN", message: "no" } } })] as const) {
  const f = project({ slack });
  await screen.findByRole("heading", { name: "payments" });
  await waitFor(() => expect(f.request.mock.calls.some(([request]) => request.path === "/v1/app/projects/payments/slack/channel")).toBe(true));
  expect(screen.queryByTestId("project-slack-channel")).toBeNull();
  f.unmount();
 }
});

it("the company settings page shows the company id from /me with a Copy button", async () => {
 const writeText = vi.fn(async () => undefined);
 vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
 const app = await mount("/app/admin/settings");
 const id = await screen.findByTestId("company-id");
 expect(id.textContent).toBe(identity.org.orgId);
 fireEvent.click(screen.getByRole("button", { name: "Copy the company ID" }));
 await waitFor(() => expect(writeText).toHaveBeenCalledWith(identity.org.orgId));
 expect(await screen.findByText("Copied.")).toBeTruthy();
 expect(app.request.mock.calls.every(([request]) => request.method === "GET")).toBe(true);
 app.close();
});

it("a failed copy says so in one sentence", async () => {
 vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText: async () => { throw new Error("denied"); } } });
 const app = await mount("/app/admin/settings");
 await screen.findByTestId("company-id");
 fireEvent.click(screen.getByRole("button", { name: "Copy the company ID" }));
 expect((await screen.findByRole("alert")).textContent).toContain("Couldn't copy.");
 app.close();
});

it("the Admin nav links Automation keys to the Account page that holds them, and a member still sees only the waiting queue", async () => {
 const labels = visibleAdminGroups("admin", false).flatMap(group => group.links);
 expect(labels.find(link => link.label === "Automation keys")?.to).toBe("/app/account/automation-keys");
 expect(visibleAdminGroups("member", false).flatMap(group => group.links.map(link => link.label))).toEqual(["Waiting for people"]);
 expect(ADMIN_GROUPS.flatMap(group => group.links).filter(link => link.to === "/app/account/automation-keys")).toHaveLength(1);
 const app = await mount("/app/admin");
 const nav = await screen.findByRole("navigation", { name: "Administration" });
 expect(within(nav).getByRole("link", { name: "Automation keys" }).getAttribute("href")).toBe("/app/account/automation-keys");
 app.close();
});

it("the Setup tab has no Run a command box on a hosted install, and the old sentence is nowhere", async () => {
 const f = project({ path: "/app/projects/payments?tab=setup" });
 await screen.findByRole("heading", { name: "payments" });
 await screen.findByRole("tab", { name: "Setup" });
 expect(screen.queryByLabelText("Run a command yourself")).toBeNull();
 expect(screen.queryByRole("button", { name: "Run command" })).toBeNull();
 expect(f.request.mock.calls.some(([request]) => request.path.endsWith("/setup-agent/command"))).toBe(false);
 f.unmount();
});
