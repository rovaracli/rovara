// @vitest-environment jsdom
// UX3 (platform UX slice 3), item 1: the one Connections page. Every connection is a row with its state, who connected it, which projects use it, and its setup in place.
import { expect, it } from "vitest";
import { screen, fireEvent, waitFor, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { AppNavSchema, AppMeResponseSchema } from "@agentx/contracts/web";
import { appRoutes } from "../../packages/ui/src/routes.js";
import { AppHostProvider } from "../../packages/ui/src/host.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { ThemeProvider } from "../../packages/ui/src/theme.js";
import { causeText, connectionSummary, githubSummary, groupSummary, providerSummary, slackSummary, whoWhen } from "../../packages/ui/src/screens/admin/connections/connection-state.js";
import { readOnlyReason, SETTINGS_AREAS } from "../../packages/ui/src/screens/admin/settings-text.js";
import { fakeHost } from "./support/fake-host.js";
import { renderUi } from "./support/render.js";
import { h } from "./support/h.js";
import type { ApiRequest, ApiResponse } from "../../packages/ui/src/host.js";

const OWNER = "a".repeat(64), MAYA = "b".repeat(64), ORG = "org_aaaaaaaaaaaaaaaaaaaa";
const features = { localAgents: false, admin: true, usage: false, chains: false, describe: false, notices: false };
const linear = { connectionId: "con_aaaaaaaaaaaaaaaaaaaa", type: "linear", label: "Team Linear", hasCredential: true, access: "read", identity: "service", createdBy: MAYA, createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-02T00:00:00Z", lastCheck: { ok: true, at: "2026-10-02T00:00:00Z" } };
function mount(options: { path?: string; role?: "owner" | "admin"; connections?: unknown[]; respond?: (r: ApiRequest) => Promise<ApiResponse | undefined> } = {}) {
 const role = options.role ?? "owner", nav = AppNavSchema.parse({ me: { developerId: OWNER, name: "Priya", orgRole: role }, org: { name: "Acme" }, homeCount: 0, projects: [], shared: { agents: [], sessions: [] }, features });
 const me = AppMeResponseSchema.parse({ developer: { id: OWNER, name: "Priya", orgRole: role }, org: { orgId: ORG, name: "Acme", plan: "team" }, identities: [{ provider: "github", login: "priya", linkedAt: "x", lastSignInAt: "x" }] });
 const bodies: Record<string, unknown> = {
  "/v1/app/me": me, "/v1/app/nav": nav, "/v1/app/home": { cards: [], total: 0 },
  "/v1/app/connections": { connections: options.connections ?? [linear] },
  "/v1/app/github/installations": { installations: [{ installationId: 7, accountLogin: "Acme-Inc", status: "active", connectedBy: OWNER, connectedAt: "2026-09-30T00:00:00Z" }] },
  "/v1/app/github/requests": { requests: [] },
  "/v1/app/org/model-sources": { orgId: ORG, developerId: OWNER, revision: 1, sources: [], order: ["rovara"], available: [] },
  "/v1/app/org/members": { members: [{ developerId: OWNER, name: "Priya" }, { developerId: MAYA, name: "Maya" }] },
  "/v1/app/org/slack-workspace-evidence": { orgId: ORG, checkedAt: "2026-10-27T23:00:00Z", kind: "stored_workspace_associations", associationCount: 2, unavailableCount: 0, coverage: "complete", verification: "unverified" },
  "/v1/app/projects": { projects: [] },
 };
 const f = fakeHost(async r => (await options.respond?.(r)) ?? { status: 200, body: bodies[r.path] ?? {} });
 f.host.kind = "web";f.host.viewport = { width: () => 1280, subscribe: () => () => undefined };
 const query = createQueryClient();query.setQueryData(["nav"], nav);
 const router = createMemoryRouter(appRoutes(nav.features), { initialEntries: [options.path ?? "/app/admin/connections"] });
 const view = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(ThemeProvider, { host: f.host, children: h(RouterProvider, { router }) }) }) }));
 return { ...f, ...view, query, router, close: () => { view.unmount();router.dispose();query.clear(); } };
}
const card = (id: string) => document.querySelector(`[data-card="${id}"]`) as HTMLElement;

it("summarises each connection in words, with the cause and the fix when it needs attention", () => {
 expect(githubSummary([{ installationId: 1, accountLogin: "acme", status: "active" }], [])).toMatchObject({ state: "connected" });
 expect(githubSummary([{ installationId: 1, accountLogin: "acme", status: "suspended" }], [])).toMatchObject({ state: "attention", why: expect.stringContaining("suspended"), fix: expect.stringContaining("unsuspend") });
 expect(githubSummary([], [{ status: "waiting", accountLogin: "acme" }])).toMatchObject({ state: "attention", why: expect.stringContaining("Waiting for your GitHub admin") });
 expect(githubSummary([], [])).toMatchObject({ state: "not_connected" });
 expect(connectionSummary({ ...linear, lastCheck: undefined }, undefined)).toMatchObject({ state: "attention", fix: "Press Check it works." });
 expect(connectionSummary({ ...linear, lastCheck: { ok: false, at: "x" } }, "Linear refused the saved secret (HTTP 401)")).toMatchObject({ state: "attention", why: expect.stringContaining("Linear refused") });
 expect(connectionSummary({ ...linear, hasCredential: false }, undefined)).toMatchObject({ state: "attention", why: "No key is saved for this connection." });
 expect(connectionSummary({ ...linear, type: "cloudwatch", hasCredential: false, lastCheck: { ok: true, at: "x" } }, undefined)).toMatchObject({ state: "connected" });
 expect(groupSummary([], {}, "Jira")).toMatchObject({ state: "not_connected" });
 expect(groupSummary([linear, { ...linear, connectionId: "con_bbbbbbbbbbbbbbbbbbbb", lastCheck: { ok: false, at: "x" } }], {}, "Linear").state).toBe("attention");
 expect(providerSummary([], ["anthropic"], new Set()).state).toBe("not_connected");
 expect(providerSummary([{ sourceId: "src_a", label: "Mine" }], [], new Set(["src_a"])).state).toBe("attention");
 expect(slackSummary({ status: "ok", associations: 0 }).state).toBe("not_connected");expect(slackSummary({ status: "ok", associations: 1 }).state).toBe("connected");expect(slackSummary({ status: "unavailable" }).state).toBe("attention");
 expect(causeText("x\u0000y\n.")).toBe("x y");expect(causeText(undefined)).toContain("didn't give a reason");expect(causeText("a".repeat(400)).length).toBe(300);
 const names = new Map([[MAYA, "Maya"]]);
 expect(whoWhen(MAYA, "2026-10-01T00:00:00Z", names)).toBe("Maya on Oct 1, 2026");expect(whoWhen("c".repeat(64), undefined, names)).toBe("A former member or an admin");expect(whoWhen(undefined, undefined, names)).toBe("Not recorded");
});
it("says what a change affects and who can change it, and why a viewer can't", () => {
 for (const entry of Object.values(SETTINGS_AREAS)) { expect(entry.affects.length).toBeGreaterThan(10);expect(entry.who.length).toBeGreaterThan(10); }
 expect(readOnlyReason("domains", "admin")).toContain("Only company owners");expect(readOnlyReason("domains", "owner")).toBeUndefined();
 expect(readOnlyReason("connections", "admin")).toBeUndefined();expect(readOnlyReason("audit", "admin")).toBeUndefined();expect(readOnlyReason("connections", "member")).toContain("You are a member");
});
it("shows every connection as a row with its state, who connected it and which projects use it", async () => {
 const f = mount({ respond: async r => r.path === "/v1/app/projects" ? { status: 200, body: { projects: [] } } : undefined });
 try {
  await screen.findByRole("heading", { name: "Connections" });
  for (const id of ["github", "ai-provider", "slack", "email", "linear", "jira", "cloud", "test-services", "tools"]) expect(card(id)).toBeTruthy();
  await waitFor(() => expect(within(card("github")).getByText("✓ Connected")).toBeTruthy());
  expect(within(card("github")).getByText(/Priya on Sep 30, 2026/)).toBeTruthy();
  await waitFor(() => expect(within(card("linear")).getByText(/Maya on Oct 1, 2026/)).toBeTruthy());
  expect(within(card("linear")).getByText("✓ Connected")).toBeTruthy();
  expect(within(card("jira")).getByText("Not connected")).toBeTruthy();
  await waitFor(() => expect(within(card("slack")).getByText("✓ Connected")).toBeTruthy());
  expect(within(card("email")).getByText("✓ Built in")).toBeTruthy();
  expect(within(card("github")).getByText("Used by")).toBeTruthy();
  expect(screen.getByText("What a change affects.")).toBeTruthy();
  expect(f.request.mock.calls.every(([r]) => r.method === "GET")).toBe(true);
 } finally { f.close(); }
});
it("opens Linear setup in place, adds with plain fields, then checks it, and never keeps the key", async () => {
 const secret = ["lin", "api", "x".repeat(12)].join("_");
 let saved = false;
 const f = mount({ connections: [], respond: async r => {
  if (r.method === "POST" && r.path === "/v1/app/connections") { saved = true;return { status: 201, body: { connection: { ...linear, lastCheck: undefined } } }; }
  if (r.method === "POST" && r.path.endsWith("/check")) return { status: 200, body: { ok: false, message: "Linear refused the saved secret (HTTP 401)" } };
  if (r.path === "/v1/app/connections") return { status: 200, body: { connections: saved ? [{ ...linear, lastCheck: { ok: false, at: "2026-10-03T00:00:00Z" } }] : [] } };
  return undefined;
 } });
 try {
  await screen.findByRole("heading", { name: "Connections" });
  fireEvent.click(within(card("linear")).getByRole("button", { name: /Connect Linear/ }));
  const key = await screen.findByLabelText("API key");
  fireEvent.change(key, { target: { value: secret } });
  fireEvent.click(screen.getByRole("button", { name: "Add and check it works" }));
  expect(await screen.findByText(/It didn't work:/)).toBeTruthy();
  expect(screen.getAllByText(/Linear refused the saved secret \(HTTP 401\)/).length).toBeGreaterThan(0);
  const post = f.request.mock.calls.map(([r]) => r).find(r => r.method === "POST" && r.path === "/v1/app/connections")!;
  expect(post.body).toMatchObject({ connection: { type: "linear", access: "read", identity: "service" }, secret: { apiKey: secret } });
  await waitFor(() => expect((screen.getByLabelText("API key") as HTMLInputElement).value).toBe(""));
  expect(JSON.stringify(f.query.getQueriesData({ queryKey: ["admin"] }))).not.toContain(secret);
  expect(document.body.textContent).not.toContain(secret);
  expect(within(card("linear")).getByText("Needs attention")).toBeTruthy();
 } finally { f.close(); }
});
it("adds Jira with a site name turned into its address and the token kept apart from the email", async () => {
 const f = mount({ connections: [], respond: async r => r.method === "POST" && r.path === "/v1/app/connections" ? { status: 201, body: { connection: { ...linear, type: "jira" } } } : r.method === "POST" ? { status: 200, body: { ok: true } } : undefined });
 try {
  await screen.findByRole("heading", { name: "Connections" });
  fireEvent.click(within(card("jira")).getByRole("button", { name: /Connect Jira/ }));
  fireEvent.change(await screen.findByLabelText("Jira site"), { target: { value: "acme" } });
  fireEvent.change(screen.getByLabelText("Atlassian account email"), { target: { value: "bot@acme.test" } });
  fireEvent.change(screen.getByLabelText("API token"), { target: { value: "tok-1234567890" } });
  fireEvent.click(screen.getByRole("button", { name: "Add and check it works" }));
  await waitFor(() => expect(f.request.mock.calls.some(([r]) => r.path.endsWith("/check"))).toBe(true));
  const post = f.request.mock.calls.map(([r]) => r).find(r => r.method === "POST" && r.path === "/v1/app/connections")!;
  expect(post.body).toMatchObject({ connection: { type: "jira", siteUrl: "https://acme.atlassian.net" }, secret: { email: "bot@acme.test", apiToken: "tok-1234567890" } });
 } finally { f.close(); }
});
it("checks and removes a saved connection from its row", async () => {
 const f = mount({ path: "/app/admin/connections?open=linear", respond: async r => r.method === "POST" && r.path.endsWith("/check") ? { status: 200, body: { ok: true } } : r.method === "DELETE" ? { status: 200, body: { removed: { connectionId: linear.connectionId } } } : undefined });
 try {
  fireEvent.click(await screen.findByRole("button", { name: "Check it works" }));
  expect(await screen.findByText(/It works\. Rovara reached the service/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Remove" }));
  fireEvent.click(await screen.findByRole("button", { name: "Remove connection" }));
  await waitFor(() => expect(f.request.mock.calls.some(([r]) => r.method === "DELETE" && r.path === `/v1/app/connections/${linear.connectionId}`)).toBe(true));
 } finally { f.close(); }
});
it("opens GitHub and AI provider setup in place from a deep link, and old places point here", async () => {
 const f = mount({ path: "/app/admin/connections?open=github" });
 try {
  expect(await screen.findByRole("button", { name: "Connect GitHub" })).toBeTruthy();
  expect(within(card("github")).getByRole("button", { name: /Close/ }).getAttribute("aria-expanded")).toBe("true");
  fireEvent.click(within(card("ai-provider")).getByRole("button", { name: /AI provider/ }));
  expect(await screen.findByRole("heading", { name: "AI providers" })).toBeTruthy();
 } finally { f.close(); }
 const models = mount({ path: "/app/admin/models/sources" });
 try {
  await screen.findByRole("heading", { name: "AI models" });
  const link = (await screen.findAllByRole("link", { name: "Connections" })).find(node => node.getAttribute("href")?.includes("open=ai-provider"));
  expect(link?.getAttribute("href")).toBe("/app/admin/connections?open=ai-provider");
  expect(screen.queryByRole("heading", { name: "Add a provider" })).toBeNull();
 } finally { models.close(); }
});
it("says a Slack workspace is not connected, and who connects it, when none is stored", async () => {
 const f = mount({ respond: async r => r.path === "/v1/app/org/slack-workspace-evidence" ? { status: 200, body: { orgId: ORG, checkedAt: "2026-10-27T23:00:00Z", kind: "stored_workspace_associations", associationCount: 0, unavailableCount: 0, coverage: "complete", verification: "unverified" } } : undefined });
 try {
  await waitFor(() => expect(within(card("slack")).getByText(/Ask your Rovara operator/)).toBeTruthy());
  expect(within(card("slack")).getByText("Not connected")).toBeTruthy();
 } finally { f.close(); }
});
