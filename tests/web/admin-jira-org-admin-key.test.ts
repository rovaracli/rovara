// @vitest-environment jsdom
// DV-1: the Jira organization admin key form on the Connections page. Write-only, both fields together, owner or admin, one request per press, never shown back.
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
const JIRA = "con_bbbbbbbbbbbbbbbbbbbb", JIRA2 = "con_cccccccccccccccccccc";
const KEY = "ATAdminKey-0123456789", ORG = "org-id-1234";
const row = (connectionId: string, type: string, label: string) => ({ connectionId, type, label, identity: "service", hasCredential: true, createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-02T00:00:00Z", lastCheck: { ok: true, at: "2026-10-02T00:00:00Z" } });
function mount(options: { role?: "owner" | "admin" | "member"; connections?: unknown[]; respond?: (request: ApiRequest) => Promise<ApiResponse | undefined> } = {}) {
  const role = options.role ?? "owner";
  const nav = AppNavSchema.parse({ me: { developerId: "a".repeat(64), name: "Omar", orgRole: role }, org: { name: "Acme" }, homeCount: 0, projects: [], shared: { agents: [], sessions: [] }, features });
  const me = AppMeResponseSchema.parse({ developer: { id: "a".repeat(64), name: "Omar", orgRole: role }, org: { orgId: "org_aaaaaaaaaaaaaaaaaaaa", name: "Acme", plan: "team" }, identities: [] });
  const connections = options.connections ?? [row("con_aaaaaaaaaaaaaaaaaaaa", "linear", "Tracker"), row(JIRA, "jira", "Company Jira")];
  const f = fakeHost(async request => (await options.respond?.(request)) ?? { status: 200, body: request.path === "/v1/app/nav" ? nav : request.path === "/v1/app/me" ? me : request.path === "/v1/app/connections" ? { connections } : request.path === "/v1/app/github/installations" ? { installations: [] } : request.path === "/v1/app/github/requests" ? { requests: [] } : {} });
  f.host.kind = "web";
  f.host.viewport = { width: () => 1280, subscribe: () => () => undefined };
  const query = createQueryClient();
  query.setQueryData(["nav"], nav);
  const router = createMemoryRouter(appRoutes(nav.features), { initialEntries: ["/app/admin/connections?open=jira"] });
  const view = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(ThemeProvider, { host: f.host, children: h(RouterProvider, { router }) }) }) }));
  return { ...f, ...view, close: () => { view.unmount();router.dispose();query.clear(); } };
}
const posts = (f: ReturnType<typeof mount>) => f.request.mock.calls.map(([request]) => request).filter(request => request.method === "POST");
const fill = () => { fireEvent.change(screen.getByLabelText("Organization admin API key"), { target: { value: KEY } });fireEvent.change(screen.getByLabelText("Atlassian organization id"), { target: { value: ORG } }); };

it("shows the form to an owner with a Jira connection: a password field, both fields together, and Save is off until both are filled", async () => {
  const f = mount();
  await screen.findByRole("heading", { name: "Jira organization admin key" });
  const key = screen.getByLabelText<HTMLInputElement>("Organization admin API key");
  expect(key.type).toBe("password");
  expect(key.autocomplete).toBe("off");
  const save = screen.getByRole<HTMLButtonElement>("button", { name: "Save key" });
  expect(save.disabled).toBe(true);
  fireEvent.change(key, { target: { value: KEY } });
  expect(save.disabled).toBe(true);
  fireEvent.change(screen.getByLabelText("Atlassian organization id"), { target: { value: ORG } });
  expect(save.disabled).toBe(false);
  f.close();
});

it("is not on the page for a company with no Jira connection, nor for a member", async () => {
  const noJira = mount({ connections: [row("con_aaaaaaaaaaaaaaaaaaaa", "linear", "Tracker")] });
  await screen.findByRole("heading", { name: "Jira" });
  expect(screen.getByText("Not connected")).toBeTruthy();
  expect(screen.queryByRole("heading", { name: "Jira organization admin key" })).toBeNull();
  noJira.close();
  const admin = mount({ role: "admin" });
  await screen.findByRole("heading", { name: "Jira organization admin key" });
  admin.close();
});

it("sends one request carrying a request id, the connection, the key and the id; the key leaves the page at once and is never shown back", async () => {
  const f = mount();
  await screen.findByRole("heading", { name: "Jira organization admin key" });
  f.request.mockImplementation(async request => (request.method === "POST" ? { status: 200, body: { status: "saved" } } : { status: 200, body: request.path === "/v1/app/connections" ? { connections: [row(JIRA, "jira", "Company Jira")] } : {} }));
  fill();
  fireEvent.click(screen.getByRole("button", { name: "Save key" }));
  await waitFor(() => expect(posts(f)).toHaveLength(1));
  const sent = posts(f)[0]!;
  expect(sent.path).toBe("/v1/app/org/jira-org-admin");
  expect(sent.body).toMatchObject({ action: "set", connectionId: JIRA, orgAdminKey: KEY, atlassianOrgId: ORG });
  expect((sent.body as { requestId: string }).requestId).toMatch(/^[0-9a-f-]{36}$/);
  expect(sent.retry).toBe("never");
  await screen.findByText("Saved. Rovara does not show the key again.");
  expect((screen.getByLabelText<HTMLInputElement>("Organization admin API key")).value).toBe("");
  expect((screen.getByLabelText<HTMLInputElement>("Atlassian organization id")).value).toBe("");
  expect(f.container.textContent).not.toContain(KEY);
  // nothing in the page's data or caches holds the key either
  expect(JSON.stringify(f.request.mock.calls.filter(([request]) => request.method === "GET"))).not.toContain(KEY);
  f.close();
});

it("removes the key with a request that carries neither a key nor an id", async () => {
  const f = mount();
  await screen.findByRole("heading", { name: "Jira organization admin key" });
  f.request.mockImplementation(async request => (request.method === "POST" ? { status: 200, body: { status: "cleared" } } : { status: 200, body: request.path === "/v1/app/connections" ? { connections: [row(JIRA, "jira", "Company Jira")] } : {} }));
  fireEvent.click(screen.getByRole("button", { name: "Remove key" }));
  await waitFor(() => expect(posts(f)).toHaveLength(1));
  expect(posts(f)[0]!.body).toMatchObject({ action: "clear", connectionId: JIRA });
  expect(Object.keys(posts(f)[0]!.body as object).sort()).toStrictEqual(["action", "connectionId", "requestId"]);
  await screen.findByText(/Removed\. Rovara no longer holds/);
  f.close();
});

it("with two Jira connections the person picks which one", async () => {
  const f = mount({ connections: [row(JIRA, "jira", "Company Jira"), row(JIRA2, "jira", "Other Jira")] });
  await screen.findByRole("heading", { name: "Jira organization admin key" });
  fireEvent.change(screen.getByLabelText("Jira connection"), { target: { value: JIRA2 } });
  f.request.mockImplementation(async request => (request.method === "POST" ? { status: 200, body: { status: "saved" } } : { status: 200, body: { connections: [] } }));
  fill();
  fireEvent.click(screen.getByRole("button", { name: "Save key" }));
  await waitFor(() => expect(posts(f)).toHaveLength(1));
  expect(posts(f)[0]!.body).toMatchObject({ connectionId: JIRA2 });
  f.close();
});

it("says a sign-in is needed for a stale sign-in and offers to sign in again; the refusal words never repeat what was typed", async () => {
  const f = mount();
  await screen.findByRole("heading", { name: "Jira organization admin key" });
  f.request.mockImplementation(async request => (request.method === "POST" ? { status: 403, body: { error: { code: "REAUTH_REQUIRED", message: `Sign in again ${KEY}` } } } : { status: 200, body: { connections: [row(JIRA, "jira", "Company Jira")] } }));
  fill();
  fireEvent.click(screen.getByRole("button", { name: "Save key" }));
  await screen.findByText(/Sign in again to change the key/);
  expect(f.container.textContent).not.toContain(KEY);
  fireEvent.click(screen.getByRole("button", { name: "Sign in again" }));
  expect(f.host.signIn).toHaveBeenCalled();
  f.close();
});

it("each other refusal is a fixed sentence", async () => {
  const f = mount();
  await screen.findByRole("heading", { name: "Jira organization admin key" });
  for (const [status, code, words] of [[503, "AUDIT_UNAVAILABLE", /needs the audit log/], [404, "NOT_FOUND", /not available for this company/], [400, "CONFIG_INVALID", /Check the key and the organization id/]] as const) {
    f.request.mockImplementation(async request => (request.method === "POST" ? { status, body: { error: { code, message: `untrusted ${KEY}` } } } : { status: 200, body: { connections: [row(JIRA, "jira", "Company Jira")] } }));
    fill();
    fireEvent.click(screen.getByRole("button", { name: "Save key" }));
    await screen.findByText(words);
    expect(f.container.textContent).not.toContain("untrusted");
    expect(f.container.textContent).not.toContain(KEY);
  }
  f.close();
});
