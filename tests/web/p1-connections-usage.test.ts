// @vitest-environment jsdom
// p1-ux-connections: the Connections page says exactly which projects use each AI provider and connection (from the usage read), and adds cloud and monitoring tools with plain forms.
import { expect, it } from "vitest";
import { screen, fireEvent, waitFor, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { AppNavSchema, AppMeResponseSchema } from "@agentx/contracts/web";
import { appRoutes } from "../../packages/ui/src/routes.js";
import { AppHostProvider } from "../../packages/ui/src/host.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { ThemeProvider } from "../../packages/ui/src/theme.js";
import { type RegistryConnection, projectsUsing, usedByLine } from "../../packages/ui/src/screens/admin/connections/connection-state.js";
import { MONITORING_TOOLS, parseRegions } from "../../packages/ui/src/screens/admin/connections/AddMonitoring.js";
import { fakeHost } from "./support/fake-host.js";
import { renderUi } from "./support/render.js";
import { h } from "./support/h.js";
import type { ApiRequest, ApiResponse } from "../../packages/ui/src/host.js";

const OWNER = "a".repeat(64), MAYA = "b".repeat(64), ORG = "org_aaaaaaaaaaaaaaaaaaaa";
const features = { localAgents: false, admin: true, usage: false, chains: false, describe: false, notices: false };
const linear: RegistryConnection = { connectionId: "con_aaaaaaaaaaaaaaaaaaaa", type: "linear", label: "Team Linear", hasCredential: true, access: "read", identity: "service", createdBy: MAYA, createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-02T00:00:00Z", lastCheck: { ok: true, at: "2026-10-02T00:00:00Z" } };
function mount(options: { path?: string; role?: "owner" | "admin"; connections?: unknown[]; respond?: (r: ApiRequest) => Promise<ApiResponse | undefined> } = {}) {
 const role = options.role ?? "owner", nav = AppNavSchema.parse({ me: { developerId: OWNER, name: "Priya", orgRole: role }, org: { name: "Acme" }, homeCount: 0, projects: [], shared: { agents: [], sessions: [] }, features });
 const me = AppMeResponseSchema.parse({ developer: { id: OWNER, name: "Priya", orgRole: role }, org: { orgId: ORG, name: "Acme", plan: "team" }, identities: [{ provider: "github", login: "priya", linkedAt: "x", lastSignInAt: "x" }] });
 const bodies: Record<string, unknown> = {
  "/v1/app/me": me, "/v1/app/nav": nav, "/v1/app/home": { cards: [], total: 0 },
  "/v1/app/connections": { connections: options.connections ?? [linear] },
  "/v1/app/github/installations": { installations: [{ installationId: 7, accountLogin: "Acme-Inc", accountType: "Organization", repositorySelection: "all", status: "active", connectedBy: OWNER, connectedAt: "2026-09-30T00:00:00Z" }] },
  "/v1/app/github/requests": { requests: [] },
  "/v1/app/org/model-sources": { orgId: ORG, developerId: OWNER, revision: 1, sources: [], order: ["rovara"], available: [] },
  "/v1/app/org/members": { members: [{ developerId: OWNER, name: "Priya" }, { developerId: MAYA, name: "Maya" }] },
  "/v1/app/org/slack-workspace-evidence": { orgId: ORG, checkedAt: "2026-10-27T23:00:00Z", kind: "stored_workspace_associations", associationCount: 2, unavailableCount: 0, coverage: "complete", verification: "unverified" },
  "/v1/app/projects": { projects: [] }, "/v1/app/connection-usage": { complete: true, connections: [], sources: [] },
 };
 const f = fakeHost(async r => (await options.respond?.(r)) ?? { status: 200, body: bodies[r.path] ?? {} });
 f.host.kind = "web";f.host.viewport = { width: () => 1280, subscribe: () => () => undefined };f.host.currentPath = () => options.path ?? "/app/admin/connections";
 const query = createQueryClient();query.setQueryData(["nav"], nav);
 const router = createMemoryRouter(appRoutes(nav.features), { initialEntries: [options.path ?? "/app/admin/connections"] });
 const view = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(ThemeProvider, { host: f.host, children: h(RouterProvider, { router }) }) }) }));
 return { ...f, ...view, query, router, close: () => { view.unmount();router.dispose();query.clear(); } };
}
const card = (id: string) => document.querySelector(`[data-card="${id}"]`) as HTMLElement;
const jira: RegistryConnection = { ...linear, connectionId: "con_cccccccccccccccccccc", type: "jira", label: "Our Jira" };
const SRC = "src_aaaaaaaaaaaaaaaaaaaa";
const withSource = { orgId: ORG, developerId: OWNER, revision: 1, sources: [{ sourceId: SRC, kind: "anthropic", label: "Our Anthropic key", hasCredential: true, inOrder: true, models: [] }], order: [SRC, "rovara"], available: ["anthropic"] };

it("words the usage: names, none, unknown, and the member's limit", () => {
 const usage = { complete: true, connections: [{ connectionId: "con_a", projects: ["web", "api"] }, { connectionId: "con_b", projects: ["web"] }, { connectionId: "con_c", projects: [] }], sources: [{ sourceId: "s", projects: ["z"] }] };
 expect(projectsUsing(usage, "connections", ["con_a", "con_b"])).toEqual(["api", "web"]);
 expect(projectsUsing(usage, "connections", ["con_c"])).toEqual([]);
 expect(projectsUsing(usage, "sources", ["s"])).toEqual(["z"]);
 expect(projectsUsing(undefined, "connections", ["con_a"])).toBeUndefined();
 expect(projectsUsing({ ...usage, complete: false }, "connections", ["con_a"])).toBeUndefined();
 const words = { none: "None.", unknown: "Unknown." };
 expect(usedByLine(["a", "b"], words, true)).toBe("a, b");
 expect(usedByLine([], words, true)).toBe("None.");
 expect(usedByLine(undefined, words, true)).toBe("Unknown.");
 expect(usedByLine(["a"], words, false)).toContain("only projects you can see");
 expect(usedByLine(["1", "2", "3", "4", "5", "6", "7", "8"], words, true)).toBe("1, 2, 3, 4, 5, 6 and 2 more");
});
it("shows exactly which projects use each AI provider, tracker and monitoring connection", async () => {
 const sentry = { ...linear, connectionId: "con_dddddddddddddddddddd", type: "sentry", label: "Errors" };
 const usage = { complete: true, connections: [{ connectionId: linear.connectionId, projects: ["web", "api"] }, { connectionId: jira.connectionId, projects: [] }, { connectionId: sentry.connectionId, projects: ["api"] }], sources: [{ sourceId: SRC, projects: ["web"] }, { sourceId: "rovara", projects: ["web", "api"] }] };
 const f = mount({ connections: [linear, jira, sentry], respond: async r => r.path === "/v1/app/connection-usage" ? { status: 200, body: usage } : r.path === "/v1/app/org/model-sources" ? { status: 200, body: withSource } : undefined });
 try {
  await waitFor(() => expect(within(card("linear")).getByText("web, api".split(", ").sort().join(", "))).toBeTruthy());
  expect(within(card("jira")).getByText("No project uses it yet.")).toBeTruthy();
  expect(within(card("cloud")).getByText("api")).toBeTruthy();
  await waitFor(() => expect(within(card("ai-provider")).getByText("web")).toBeTruthy());
  expect(card("linear").textContent).not.toContain("company-wide");
  fireEvent.click(within(card("linear")).getByRole("button", { name: /Manage Linear/ }));
  expect(await within(card("linear")).findByText(/Used by:/)).toBeTruthy();
  fireEvent.click(within(card("ai-provider")).getByRole("button", { name: /Manage AI provider/ }));
  const list = await within(card("ai-provider")).findByRole("list", { name: "Which projects use each provider" });
  expect(list.textContent).toContain("Our Anthropic key: web");
 } finally { f.close(); }
});
it("keeps the careful company-wide wording when the usage can't be read or is not complete", async () => {
 for (const respond of [
  async (r: ApiRequest) => r.path === "/v1/app/connection-usage" ? { status: 503, body: { error: { code: "RUNTIME_UNAVAILABLE", message: "x" } } } : undefined,
  async (r: ApiRequest) => r.path === "/v1/app/connection-usage" ? { status: 200, body: { complete: false, connections: [], sources: [] } } : undefined,
 ]) {
  const f = mount({ respond: async r => r.path === "/v1/app/org/model-sources" ? { status: 200, body: withSource } : respond(r) });
  try {
   await waitFor(() => expect(within(card("linear")).getByText("✓ Connected")).toBeTruthy());
   expect(within(card("linear")).getByText(/company-wide connection/)).toBeTruthy();
   await waitFor(() => expect(within(card("ai-provider")).getByText(/Every project \(company-wide\)/)).toBeTruthy());
   expect(card("linear").textContent).not.toContain("No project uses it yet");
  } finally { f.close(); }
 }
});
it("parses the regions a CloudWatch form takes", () => {
 expect(parseRegions("us-east-1, eu-west-1")).toEqual(["us-east-1", "eu-west-1"]);
 for (const bad of ["", "us-east-9", "us-east-1 us-east-1", "us-east-1,us-east-2,us-west-1,us-west-2,eu-west-1,eu-west-2"]) expect(typeof parseRegions(bad)).toBe("string");
});

const FILL = {
 sentry: { "Sentry organization": "acme", "Auth token": ["sn", "tok", "s".repeat(10)].join("_") },
 datadog: { "API key": ["dd", "api", "a".repeat(10)].join("_"), "Application key": ["dd", "app", "b".repeat(10)].join("_") },
 grafana: { "Grafana address": "https://grafana.acme.dev", "Service account token": ["gf", "sa", "c".repeat(10)].join("_") },
 vercel: { "Team id (optional)": "team_abc123", "Access token": ["vc", "tok", "d".repeat(10)].join("_") },
 pagerduty: { "API key": ["pd", "key", "e".repeat(10)].join("_") },
} satisfies Record<string, Record<string, string>>;
const EXPECT: Record<keyof typeof FILL, { connection: Record<string, unknown>; secret: Record<string, unknown> }> = {
 sentry: { connection: { type: "sentry", access: "read", region: "us", orgSlug: "acme" }, secret: { authToken: FILL.sentry["Auth token"] } },
 datadog: { connection: { type: "datadog", access: "read", site: "datadoghq.com" }, secret: { apiKey: FILL.datadog["API key"], appKey: FILL.datadog["Application key"] } },
 grafana: { connection: { type: "grafana", access: "read", baseUrl: "https://grafana.acme.dev" }, secret: { serviceAccountToken: FILL.grafana["Service account token"] } },
 vercel: { connection: { type: "vercel", access: "read", teamId: "team_abc123" }, secret: { token: FILL.vercel["Access token"] } },
 pagerduty: { connection: { type: "pagerduty", access: "read", region: "us" }, secret: { apiKey: FILL.pagerduty["API key"] } },
};
for (const kind of Object.keys(FILL) as Array<keyof typeof FILL>) {
 it(`adds a ${MONITORING_TOOLS[kind].name} connection through the shared create route, checks it, and never keeps the key`, async () => {
  const added = { ...linear, connectionId: "con_eeeeeeeeeeeeeeeeeeee", type: kind, label: "Added", lastCheck: undefined };
  const f = mount({ connections: [], respond: async r => {
   if (r.method === "POST" && r.path === "/v1/app/connections") return { status: 201, body: { connection: added } };
   if (r.method === "POST" && r.path.endsWith("/check")) return { status: 200, body: { ok: true } };
   return undefined;
  } });
  try {
   await screen.findByRole("heading", { name: "Connections" });
   fireEvent.click(within(card("cloud")).getByRole("button", { name: /See cloud tools/ }));
   fireEvent.change(await screen.findByLabelText("Which tool"), { target: { value: kind } });
   for (const [label, value] of Object.entries<string>(FILL[kind])) fireEvent.change(await screen.findByLabelText(label), { target: { value } });
   fireEvent.click(screen.getByRole("button", { name: "Add and check it works" }));
   await waitFor(() => expect(f.request.mock.calls.some(([r]) => r.path === `/v1/app/connections/${added.connectionId}/check`)).toBe(true));
   const post = f.request.mock.calls.map(([r]) => r).find(r => r.method === "POST" && r.path === "/v1/app/connections")!;
   expect(post.body).toMatchObject({ connection: EXPECT[kind].connection, secret: EXPECT[kind].secret });
   expect(Object.keys((post.body as { secret: object }).secret).sort()).toEqual(Object.keys(EXPECT[kind].secret).sort());
   await waitFor(() => { for (const input of document.querySelectorAll<HTMLInputElement>("input[type=password]")) expect(input.value).toBe(""); });
   const everything = JSON.stringify(f.query.getQueriesData({ queryKey: ["admin"] })) + document.body.textContent;
   for (const value of Object.values(EXPECT[kind].secret)) expect(everything).not.toContain(value as string);
  } finally { f.close(); }
 });
}
it("adds Amazon CloudWatch without a key, then shows the external id and trust policy and does not check yet", async () => {
 const added = { ...linear, connectionId: "con_ffffffffffffffffffff", type: "cloudwatch", label: "AWS", hasCredential: false, lastCheck: undefined };
 const policy = { Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: "sts:AssumeRole", Principal: { AWS: "arn:aws:iam::123456789012:role/broker" } }] };
 const f = mount({ connections: [], respond: async r => {
  if (r.method === "POST" && r.path === "/v1/app/connections") return { status: 201, body: { connection: added } };
  if (r.method === "GET" && r.path === `/v1/app/connections/${added.connectionId}`) return { status: 200, body: { connection: { ...added, setup: { externalId: `rovara-${ORG}`, trustPolicy: policy } } } };
  return undefined;
 } });
 try {
  await screen.findByRole("heading", { name: "Connections" });
  fireEvent.click(within(card("cloud")).getByRole("button", { name: /See cloud tools/ }));
  fireEvent.change(await screen.findByLabelText("Which tool"), { target: { value: "cloudwatch" } });
  expect(document.querySelectorAll("input[type=password]").length).toBe(0);
  fireEvent.change(screen.getByLabelText("IAM role Rovara may assume"), { target: { value: "arn:aws:iam::123456789012:role/RovaraReadOnly" } });
  fireEvent.change(screen.getByLabelText("Regions"), { target: { value: "us-east-1, eu-west-1" } });
  fireEvent.click(screen.getByRole("button", { name: "Add Amazon CloudWatch" }));
  expect(await screen.findByText(`rovara-${ORG}`)).toBeTruthy();
  expect(screen.getByText(/sts:AssumeRole/)).toBeTruthy();
  const post = f.request.mock.calls.map(([r]) => r).find(r => r.method === "POST" && r.path === "/v1/app/connections")!;
  expect(post.body).toMatchObject({ connection: { type: "cloudwatch", access: "read", roleArn: "arn:aws:iam::123456789012:role/RovaraReadOnly", regions: ["us-east-1", "eu-west-1"] } });
  expect((post.body as Record<string, unknown>).secret).toBeUndefined();
  expect(f.request.mock.calls.some(([r]) => r.path.endsWith("/check"))).toBe(false);
 } finally { f.close(); }
});
it("shows the reason a monitoring add was refused, without the key, and refuses a bad CloudWatch region before sending", async () => {
 const key = ["sn", "tok", "z".repeat(10)].join("_");
 const f = mount({ connections: [], respond: async r => r.method === "POST" && r.path === "/v1/app/connections" ? { status: 400, body: { error: { code: "CONFIG_INVALID", message: "connection.orgSlug: Invalid string: must match pattern" } } } : undefined });
 try {
  await screen.findByRole("heading", { name: "Connections" });
  fireEvent.click(within(card("cloud")).getByRole("button", { name: /See cloud tools/ }));
  fireEvent.change(await screen.findByLabelText("Sentry organization"), { target: { value: "Acme Inc" } });
  fireEvent.change(screen.getByLabelText("Auth token"), { target: { value: key } });
  fireEvent.click(screen.getByRole("button", { name: "Add and check it works" }));
  expect(await screen.findByText(/connection\.orgSlug/)).toBeTruthy();
  expect(document.body.textContent).not.toContain(key);
  await waitFor(() => expect(screen.getByLabelText<HTMLInputElement>("Auth token").value).toBe(""));
  fireEvent.change(screen.getByLabelText("Which tool"), { target: { value: "cloudwatch" } });
  fireEvent.change(screen.getByLabelText("IAM role Rovara may assume"), { target: { value: "arn:aws:iam::123456789012:role/R" } });
  fireEvent.change(screen.getByLabelText("Regions"), { target: { value: "mars-1" } });
  const before = f.request.mock.calls.filter(([r]) => r.method === "POST").length;
  fireEvent.click(screen.getByRole("button", { name: "Add Amazon CloudWatch" }));
  expect(await screen.findByText(/not an AWS region code/)).toBeTruthy();
  expect(f.request.mock.calls.filter(([r]) => r.method === "POST").length).toBe(before);
 } finally { f.close(); }
});
