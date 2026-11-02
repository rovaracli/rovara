// @vitest-environment jsdom
// Lane team-record-links: the admin page for Linear and Jira people the automatic linker could not match.
import { expect, it } from "vitest";
import { screen, waitFor, fireEvent } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { AppNavSchema, AppMeResponseSchema } from "@agentx/contracts/web";
import { appRoutes } from "../../packages/ui/src/routes.js";
import { AppHostProvider } from "../../packages/ui/src/host.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { ThemeProvider } from "../../packages/ui/src/theme.js";
import { fakeHost } from "./support/fake-host.js";
import { renderUi } from "./support/render.js";
import { h } from "./support/h.js";
import type { ApiRequest, ApiResponse } from "../../packages/ui/src/host.js";

const features = { localAgents: false, admin: true, usage: false, chains: false, describe: false, notices: false };
const SAM = "b".repeat(64), PRIYA = "c".repeat(64);
const members = [{ developerId: SAM, name: "Sam Kerr", role: "member", identities: ["github"], joinedAt: "2026-10-01T00:00:00Z" }, { developerId: PRIYA, name: "Priya Rao", role: "member", identities: ["github"], joinedAt: "2026-10-01T00:00:00Z" }];
const people = {
  unmatched: [{ tool: "Linear", system: "linear", sourceId: "lin-sam", displayName: "Sam K" }, { tool: "Jira", system: "jira:acme.atlassian.net", sourceId: "acc-9", displayName: "Nine <b>bold</b>" }],
  linked: [{ tool: "Linear", system: "linear", sourceId: "lin-priya", displayName: "Priya R", developerId: PRIYA, via: "admin" }],
  truncated: false,
};
function mount(options: { role?: "owner" | "admin" | "member"; respond?: (request: ApiRequest) => Promise<ApiResponse | undefined> } = {}) {
  const role = options.role ?? "owner";
  const nav = AppNavSchema.parse({ me: { developerId: "a".repeat(64), name: "Omar", orgRole: role }, org: { name: "Acme" }, homeCount: 0, projects: [], shared: { agents: [], sessions: [] }, features });
  const me = AppMeResponseSchema.parse({ developer: { id: "a".repeat(64), name: "Omar", orgRole: role }, org: { orgId: "org_aaaaaaaaaaaaaaaaaaaa", name: "Acme", plan: "team" }, identities: [] });
  const f = fakeHost(async request => (await options.respond?.(request)) ?? { status: 200, body: request.path === "/v1/app/nav" ? nav : request.path === "/v1/app/me" ? me : request.path === "/v1/app/org/tracker-people" ? people : request.path === "/v1/app/org/members" ? { members } : {} });
  f.host.kind = "web";
  f.host.viewport = { width: () => 1280, subscribe: () => () => undefined };
  const query = createQueryClient();
  query.setQueryData(["nav"], nav);
  const router = createMemoryRouter(appRoutes(nav.features), { initialEntries: ["/app/admin/tracker-people"] });
  const view = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(ThemeProvider, { host: f.host, children: h(RouterProvider, { router }) }) }) }));
  return { ...f, ...view, close: () => { view.unmount();router.dispose();query.clear(); } };
}
const posts = (f: ReturnType<typeof mount>) => f.request.mock.calls.map(([request]) => request).filter(request => request.method === "POST");

it("lists the people by name and tool id, in plain text, and never an email; the nav links to it", async () => {
  const f = mount();
  await screen.findByRole("heading", { name: "Tracker people" });
  await screen.findByText("Sam K");
  expect(screen.getAllByText("lin-sam").length).toBeGreaterThan(0);
  expect(screen.getByText("Nine <b>bold</b>")).toBeTruthy();
  expect(f.container.querySelector("b")).toBeNull();
  expect(screen.getByRole("link", { name: "Tracker people" })).toBeTruthy();
  expect(screen.getAllByText("Priya Rao").length).toBeGreaterThan(0);
  expect(f.container.textContent).not.toMatch(/@acme|@example/);
  expect(f.request.mock.calls.every(([request]) => request.method === "GET")).toBe(true);
  f.close();
});

it("maps a person to the chosen member with one request carrying a request id, then reloads", async () => {
  const f = mount();
  await screen.findByText("Sam K");
  const map = screen.getAllByRole("button", { name: "Map" })[0] as HTMLButtonElement;
  expect(map.disabled).toBe(true);
  fireEvent.change(screen.getByLabelText("Company member for Sam K"), { target: { value: SAM } });
  expect(map.disabled).toBe(false);
  f.request.mockImplementation(async request => (request.method === "POST" ? { status: 200, body: { status: "mapped" } } : { status: 200, body: request.path === "/v1/app/org/tracker-people" ? people : request.path === "/v1/app/org/members" ? { members } : {} }));
  fireEvent.click(map);
  await waitFor(() => expect(posts(f)).toHaveLength(1));
  const sent = posts(f)[0]!;
  expect(sent.path).toBe("/v1/app/org/tracker-people");
  expect(sent.body).toMatchObject({ action: "map", system: "linear", sourceId: "lin-sam", developerId: SAM });
  expect((sent.body as { requestId: string }).requestId).toMatch(/^[0-9a-f-]{36}$/);
  expect(sent.retry).toBe("never");
  await screen.findByText("Mapped Sam K to Sam Kerr.");
  f.close();
});

it("unmaps a matched person", async () => {
  const f = mount();
  await screen.findByText("Priya R");
  f.request.mockImplementation(async request => (request.method === "POST" ? { status: 200, body: { status: "unmapped" } } : { status: 200, body: request.path === "/v1/app/org/tracker-people" ? people : request.path === "/v1/app/org/members" ? { members } : {} }));
  fireEvent.click(screen.getByRole("button", { name: "Unmap" }));
  await waitFor(() => expect(posts(f)).toHaveLength(1));
  expect(posts(f)[0]!.body).toMatchObject({ action: "unmap", system: "linear", sourceId: "lin-priya" });
  await screen.findByText(/Took away the mapping of Priya R/);
  f.close();
});

it("says a sign-in is needed when the change is refused for a stale sign-in, and offers to sign in again", async () => {
  const f = mount();
  await screen.findByText("Sam K");
  fireEvent.change(screen.getByLabelText("Company member for Sam K"), { target: { value: SAM } });
  f.request.mockImplementation(async request => (request.method === "POST" ? { status: 403, body: { error: { code: "REAUTH_REQUIRED", message: "Sign in again." } } } : { status: 200, body: request.path === "/v1/app/org/tracker-people" ? people : { members } }));
  fireEvent.click(screen.getAllByRole("button", { name: "Map" })[0]!);
  await screen.findByText(/Sign in again to make this change/);
  fireEvent.click(screen.getByRole("button", { name: "Sign in again" }));
  expect(f.host.signIn).toHaveBeenCalled();
  f.close();
});

it("a member does not get the page; a company without the Team record is told so", async () => {
  const member = mount({ role: "member" });
  await screen.findByText("Administration unavailable");
  expect(member.request.mock.calls.some(([request]) => request.path === "/v1/app/org/tracker-people")).toBe(false);
  member.close();
  const off = mount({ respond: async request => (request.path === "/v1/app/org/tracker-people" ? { status: 404, body: { error: { code: "NOT_FOUND", message: "no" } } } : undefined) });
  await screen.findByText("Tracker people are not turned on for this company.");
  off.close();
});
