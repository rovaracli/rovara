// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { AppNavSchema } from "@agentx/contracts/web";
// LEGACY HARNESS (WIRING-1B): this pinned test drives the screen that used to be mounted at /app/admin/{money/report,ai-spending,product-ai}; see support/legacy-admin-routes.ts.
import { appRoutes } from "./support/legacy-admin-routes.js";
import { AppHostProvider, type ApiRequest, type ApiResponse } from "../../packages/ui/src/host.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { ThemeProvider } from "../../packages/ui/src/theme.js";
import { fakeHost } from "./support/fake-host.js";
import { renderUi } from "./support/render.js";
import { h } from "./support/h.js";

const SONNET = "claude-sonnet-5-5", HAIKU = "claude-haiku-5-5";
const orgId = "org_aaaaaaaaaaaaaaaaaaaa", developerId = "a".repeat(64);
const features = { localAgents: false, admin: true, usage: false, chains: false, describe: false, notices: false };
const unavailable = { status: 501, body: { error: { code: "NOT_ON_CODE_YET", message: "Not available yet." } } };
function mount({ path = "/app/admin/ai-spending", role = "owner", width = 1280, overrides = {}, respond }: { path?: string; role?: "owner" | "admin" | "member"; width?: number; overrides?: Record<string, ApiResponse>; respond?: (r: ApiRequest) => ApiResponse | undefined } = {}) {
 const liveFeatures = { ...features, admin: role !== "member" };
 const identity = { developer: { id: developerId, name: "Priya", orgRole: role }, org: { orgId, name: "Acme", plan: "team" }, identities: [] };
 const nav = AppNavSchema.parse({ me: { developerId, name: "Priya", orgRole: role }, org: { name: "Acme" }, homeCount: 0, projects: [], shared: { agents: [], sessions: [] }, features: liveFeatures });
 const steps = ["understand", "plan", "plan_check", "build", "code_review", "security_review", "pull_request"].map(stage => ({ stage, setting: null, refused: false, effective: { model: stage === "understand" ? HAIKU : SONNET, companyDefault: true } }));
 steps.find(step => step.stage === "security_review")!.refused = true;
 const bodies: Record<string, unknown> = {
  "/v1/app/me": identity, "/v1/app/nav": nav,
  "/v1/app/github/installations": { installations: [{ installationId: 7, accountLogin: "Acme", accountType: "Organization", repositorySelection: "all", status: "active" }] },
  "/v1/app/connections": { connections: [] },
  "/v1/app/org/engine-model": { model: SONNET, source: "company", offered: [SONNET, HAIKU], preselect: SONNET, canChange: role !== "member" },
  "/v1/app/org/agent-models": { revision: 1, steps, offered: [SONNET, HAIKU], canChange: true },
  "/v1/app/org/learning-model": { model: HAIKU, source: "install", offered: [SONNET, HAIKU], preselect: HAIKU, canChange: true },
  "/v1/app/org/agent-ai": { version: 1, source: "openrouter_key", choices: [{ source: "openrouter_key", available: true }] },
  "/v1/app/org/settings": { version: 1, modelGateway: { ready: true }, settings: { budgets: { companyMonthlyUsdMicros: 500_000_000 } } },
  "/v1/app/org/model-sources": { orgId, developerId, revision: 1, order: ["openrouter_key"], sources: [{ source: "openrouter_key", available: true, connected: true, inOrder: true }] },
 };
 const f = fakeHost(async (r: ApiRequest) => respond?.(r) ?? overrides[r.path] ?? (r.path in bodies ? { status: 200, body: bodies[r.path] } : unavailable));
 f.host.storage = { get: key => localStorage.getItem(key) ?? undefined, set: (key, value) => { localStorage.setItem(key, value); } };
 f.host.features.admin = liveFeatures.admin; f.host.kind = "web"; f.host.viewport = { width: () => width, subscribe: () => () => undefined };
 const query = createQueryClient(); query.setQueryData(["nav"], nav);
 const router = createMemoryRouter(appRoutes(liveFeatures), { initialEntries: [path] });
 const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(ThemeProvider, { host: f.host, children: h(RouterProvider, { router }) }) }) }));
 return { ...f, ...ui, query, router, identity, bodies, close() { ui.unmount(); router.dispose(); query.clear(); } };
}

const emptyBedrock = { revision: 0, canChange: true, connection: null, removedUntil: null, usage: "AWS bills your account." };
const connectedBedrock = { ...emptyBedrock, revision: 1, connection: { connected: true, connectedAt: Date.UTC(2026, 10, 20), updatedAt: Date.UTC(2026, 10, 20), roleArn: "arn:aws:iam::123456789012:role/RovaraBedrockInvoke-fixture", region: "us-west-2", allowGlobal: false, checkedAt: Date.UTC(2026, 10, 20), models: [{ name: "claude-haiku-4-5", id: "us.anthropic.claude-haiku-4-5-v1:0", state: "ready" }], productModels: [] } };
const setupBedrock = { companyId: orgId, region: "us-west-2", externalId: "rvb-" + "a".repeat(40), brokerRoleArn: "arn:aws:iam::123456789012:role/broker", templateUrl: "https://docs.example/template.json", presets: { "claude-haiku-4-5": "us.anthropic.claude-haiku-4-5-v1:0" } };
async function form() { await screen.findByTestId("learning-model-current"); await screen.findByTestId("step-model-build"); fireEvent.click(await screen.findByText("Connect company AI")); return screen.findByRole("region", { name: "Your own Bedrock" }); }
it("mounts the Bedrock connection at the real AI settings route and shows served checks", async () => {
 const f = mount({ overrides: { "/v1/app/org/bedrock": { status: 200, body: connectedBedrock } } });
 try { const card = await form(); await within(card).findByText(/claude-haiku-4-5: ready/u); expect(within(card).getByText(connectedBedrock.connection.roleArn)).toBeTruthy(); expect(f.router.state.location.pathname).toBe("/app/admin/ai-spending"); } finally { f.close(); }
});
it("shows a model with no AWS quota room as not usable, with what to do, and keeps the other models' states", async () => {
 const quotaSteps = "AWS has no room for this model in your account right now: its Bedrock tokens-per-minute quota is probably 0 or used up. Choose another model, or ask AWS to raise the quota in Service Quotas, then test the connection again.";
 const body = { ...connectedBedrock, connection: { ...connectedBedrock.connection, models: [{ name: "claude-haiku-5-5", id: "us.anthropic.claude-haiku-5-5", state: "no_quota" }, { name: "claude-haiku-4-5", id: "us.anthropic.claude-haiku-4-5-v1:0", state: "ready" }], quotaSteps } };
 const f = mount({ overrides: { "/v1/app/org/bedrock": { status: 200, body } } });
 try {
  const card = await form();
  await within(card).findByText("claude-haiku-5-5: not usable right now (AWS quota is 0 or used up)");
  expect(within(card).getByText("claude-haiku-4-5: ready")).toBeTruthy();
  expect(within(card).getByText(quotaSteps).getAttribute("role")).toBe("status");
 } finally { f.close(); }
});
it("drops cached write authority on a failed latest read", async () => {
 let failed = false;
 const f = mount({ respond: r => r.path === "/v1/app/org/bedrock" ? failed ? { status: 403, body: { error: { code: "FORBIDDEN", message: "refused" } } } : { status: 200, body: connectedBedrock } : undefined });
 try { const card = await form(); await within(card).findByRole("button", { name: "Remove Bedrock connection" }); failed = true; fireEvent.click(within(card).getByRole("button", { name: "Check Bedrock connection" })); await within(card).findByRole("alert"); expect(within(card).queryByRole("button", { name: "Remove Bedrock connection" })).toBeNull(); } finally { f.close(); }
});
it("retains an unknown removal across remount and another tab; failed persistence never sends", async () => {
 localStorage.clear();
 const f = mount({ respond: r => r.path === "/v1/app/org/bedrock" ? r.method === "DELETE" ? { status: 503, body: {} } : { status: 200, body: connectedBedrock } : undefined });
 try { const card = await form(); fireEvent.click(await within(card).findByRole("button", { name: "Remove Bedrock connection" })); await within(card).findByText(/Rovara didn't confirm/u); expect(f.request.mock.calls.filter(([r]) => r.method === "DELETE")).toHaveLength(1); } finally { f.close(); }
 const g = mount({ overrides: { "/v1/app/org/bedrock": { status: 200, body: connectedBedrock } } });
 try { const card = await form(); await within(card).findByText(/Rovara didn't confirm/u); expect(within(card).queryByRole("button", { name: "Remove Bedrock connection" })).toBeNull(); } finally { g.close(); localStorage.clear(); }
 const h = mount({ overrides: { "/v1/app/org/bedrock": { status: 200, body: connectedBedrock } } });
 const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("storage unavailable"); });
 try { const card = await form(); fireEvent.click(await within(card).findByRole("button", { name: "Remove Bedrock connection" })); await within(card).findByText(/can't be made safely/u); expect(h.request.mock.calls.filter(([r]) => r.method === "DELETE")).toHaveLength(0); } finally { spy.mockRestore(); h.close(); }
});
it("shows the server's returned connection rather than the requested draft", async () => {
 localStorage.clear();
 const f = mount({ respond: r => {
  if (r.path === "/v1/app/org/bedrock/setup/us-west-2") return { status: 200, body: setupBedrock };
  if (r.path === "/v1/app/org/bedrock") return { status: 200, body: r.method === "PUT" ? connectedBedrock : emptyBedrock };
  return undefined;
 } });
 try { const card = await form(); fireEvent.change(await within(card).findByLabelText("Bedrock region"), { target: { value: "us-west-2" } }); fireEvent.click(await within(card).findByRole("button", { name: "Load Bedrock models" })); fireEvent.click(await within(card).findByLabelText("claude-haiku-4-5")); fireEvent.change(within(card).getByLabelText("Bedrock role ARN"), { target: { value: "arn:aws:iam::999999999999:role/RovaraBedrockInvoke-requested" } }); fireEvent.click(within(card).getByRole("button", { name: "Check and save Bedrock" })); await within(card).findByText(connectedBedrock.connection.roleArn); expect(within(card).queryByText(/Connection saved/u)).toBeNull(); } finally { f.close(); localStorage.clear(); }
});

for (const status of [202, 408, 429, 500]) it(`keeps an ambiguous ${status} removal locked after checking an unchanged revision`, async () => {
 localStorage.clear();
 const f = mount({ respond: r => r.path === "/v1/app/org/bedrock" ? { status: r.method === "DELETE" ? status : 200, body: connectedBedrock } : undefined });
 try {
  const card = await form(); fireEvent.click(await within(card).findByRole("button", { name: "Remove Bedrock connection" }));
  await within(card).findByText(/Rovara didn't confirm/u); fireEvent.click(within(card).getByRole("button", { name: "Check Bedrock connection" }));
  await waitFor(() => expect(within(card).queryByRole("button", { name: "Remove Bedrock connection" })).toBeNull());
  expect(f.request.mock.calls.filter(([r]) => r.method === "DELETE")).toHaveLength(1);
 } finally { f.close(); localStorage.clear(); }
});
it("responds to a persisted unknown change in another tab without granting another identity's lock", async () => {
 localStorage.clear();
 const f = mount({ overrides: { "/v1/app/org/bedrock": { status: 200, body: connectedBedrock } } });
 try {
  const card = await form(); await within(card).findByRole("button", { name: "Remove Bedrock connection" });
  const key = `bedrock:${orgId}:${developerId}:connection`;
  const value = JSON.stringify({ requestId: "11111111-1111-4111-8111-111111111111", expectedRevision: 1, body: { requestId: "11111111-1111-4111-8111-111111111111", expectedRevision: 1 }, startedAt: Date.now() });
  localStorage.setItem(key, value);
  fireEvent(window, new StorageEvent("storage", { key, newValue: value }));
  await within(card).findByText(/Rovara didn't confirm/u);
  expect(within(card).queryByRole("button", { name: "Remove Bedrock connection" })).toBeNull();
  expect(f.request.mock.calls.filter(([r]) => r.method !== "GET")).toHaveLength(0);
 } finally { f.close(); localStorage.clear(); }
});
it("a malformed pending Bedrock body never unlocks on a newer read", async () => {
 localStorage.clear();
 localStorage.setItem(`bedrock:${orgId}:${developerId}:connection`, JSON.stringify({ requestId: "pending-fixture", expectedRevision: 0, startedAt: Date.now() }));
 const f = mount({ overrides: { "/v1/app/org/bedrock": { status: 200, body: connectedBedrock } } });
 try {
  const card = await form(); await within(card).findByText("Couldn't read the current Bedrock connection. Check again.");
  expect(within(card).queryByRole("button", { name: "Remove Bedrock connection" })).toBeNull();
  expect(f.request.mock.calls.filter(([r]) => r.method !== "GET")).toHaveLength(0);
 } finally { f.close(); localStorage.clear(); }
});
it("Bedrock's extracted identity check refuses a company switch before Remove", async () => {
 localStorage.clear();
 const f = mount({ overrides: { "/v1/app/org/bedrock": { status: 200, body: connectedBedrock } } });
 try {
  const card = await form(), remove = await within(card).findByRole("button", { name: "Remove Bedrock connection" });
  f.identity.org.orgId = "org_bbbbbbbbbbbbbbbbbbbb";
  fireEvent.click(remove); await within(card).findByText("Couldn't verify the current connection. Check again.");
  expect(f.request.mock.calls.filter(([r]) => r.method !== "GET")).toHaveLength(0);
 } finally { f.close(); localStorage.clear(); }
});

for (const method of ['PUT', 'DELETE', 'POST'] as const) it.each([
 [400, 'CONFIG_INVALID', 'This Bedrock connection is not valid. Check the role ARN, the Region and the models.'],
 [403, 'FORBIDDEN', "Only a company admin can see or change the company's Bedrock connection."],
 [404, 'NOT_FOUND', 'No Bedrock connection is saved for this company.'],
 [409, 'CONFLICT', 'The Bedrock connection changed. Refresh and try again.'],
 [413, 'CONFIG_INVALID', 'The request is too large.'],
] as const)(`${method}: a clean %s %s Bedrock refusal releases the hold and preserves the server words`, async (status, code, message) => {
 localStorage.clear(); let sends = 0;
 const recovered = { ...emptyBedrock, revision: 1, removedUntil: Date.now() + 86_400_000 };
 const initial = method === 'PUT' ? emptyBedrock : method === 'POST' ? recovered : connectedBedrock;
 const f = mount({ respond: r => {
  if (r.path === '/v1/app/org/bedrock/setup/us-west-2') return { status: 200, body: setupBedrock };
  if (r.path === '/v1/app/org/bedrock' || r.path === '/v1/app/org/bedrock/recover') {
   if (r.method === 'GET') return { status: 200, body: initial };
   sends += 1;
   return sends === 1 ? { status, body: { error: { code, message } } } : { status: 200, body: { ...connectedBedrock, revision: 2 } };
  }
  return undefined;
 } });
 try {
  const card = await form();
  if (method === 'PUT') {
   fireEvent.change(await within(card).findByLabelText('Bedrock region'), { target: { value: 'us-west-2' } });
   fireEvent.click(await within(card).findByRole('button', { name: 'Load Bedrock models' }));
   fireEvent.click(await within(card).findByLabelText('claude-haiku-4-5'));
   fireEvent.change(within(card).getByLabelText('Bedrock role ARN'), { target: { value: 'arn:aws:iam::123456789012:role/RovaraBedrockInvoke-fixture' } });
  }
  const name = method === 'PUT' ? 'Check and save Bedrock' : method === 'DELETE' ? 'Remove Bedrock connection' : 'Recover Bedrock connection';
  fireEvent.click(await within(card).findByRole('button', { name }));
  await within(card).findByText(message);
  expect(within(card).queryByText(/Rovara didn't confirm/u)).toBeNull();
  expect(localStorage.getItem(`bedrock:${orgId}:${developerId}:connection`)).toBe('');
  expect(sends).toBe(1);
  const resubmit = within(card).getByRole('button', { name }); fireEvent.click(resubmit); fireEvent.click(resubmit);
  await waitFor(() => expect(sends).toBe(2));
  await waitFor(() => expect(within(card).queryByText(/Rovara didn't confirm/u)).toBeNull());
  expect(sends).toBe(2);
 } finally { f.close(); localStorage.clear(); }
});

it("keeps a Bedrock 500 CONFIG_INVALID held even though its code matches a clean refusal", async () => {
 localStorage.clear();
 const f = mount({ respond: r => r.path === "/v1/app/org/bedrock" ? r.method === "DELETE" ? { status: 500, body: { error: { code: "CONFIG_INVALID", message: "Unproven refusal." } } } : { status: 200, body: connectedBedrock } : undefined });
 try {
  const card = await form(); fireEvent.click(await within(card).findByRole("button", { name: "Remove Bedrock connection" }));
  await within(card).findByText(/Rovara didn't confirm/u);
  expect(within(card).queryByRole("button", { name: "Remove Bedrock connection" })).toBeNull();
  expect(f.request.mock.calls.filter(([r]) => r.method === "DELETE")).toHaveLength(1);
 } finally { f.close(); localStorage.clear(); }
});
