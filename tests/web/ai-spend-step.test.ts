// @vitest-environment jsdom
// Guided onboarding PR 15 (DEC 254l item 7, DEC 254n item 1): the company step "AI and spending" and a project's "AI and spend limit".
// The step follows the served default until an explicit model choice, prefills the saved monthly limit or the existing default, and its one
// Save writes changed rows only; pinning a model always requires an explicit choice. A plain member sees it read only. Refusals are the server's fixed sentences. The project part keeps "Same as company" picked.
import { beforeEach, describe, expect, it } from "vitest";
import { act, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { AppNavSchema, AppMeResponseSchema } from "@agentx/contracts/web";
import { DEFAULT_ORG_MONTHLY_BUDGET_USD } from "../../packages/contracts/src/org-budget.js";
// LEGACY HARNESS (WIRING-1B): this pinned test drives the screen that used to be mounted at /app/admin/{money/report,ai-spending,product-ai}; see support/legacy-admin-routes.ts.
import { appRoutes } from "./support/legacy-admin-routes.js";
import { AppHostProvider, type ApiRequest, type ApiResponse } from "../../packages/ui/src/host.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { ThemeProvider } from "../../packages/ui/src/theme.js";
import { COMPANY_MONTHLY_DEFAULT_USD, dollarsOf, readEngineModel, readSpendLimits } from "../../packages/ui/src/api/ai-spend.js";
import { AGENT_AI_SOURCES } from "../../packages/ui/src/api/admin-agent-ai.js";
import { AiSpendStep } from "../../packages/ui/src/screens/setup/AiSpendStep.js";
import { sourceLabel } from "../../packages/ui/src/screens/admin/models/source-order.js";
import { ProjectSpendLimits } from "../../packages/ui/src/screens/setup/ProjectSpendLimits.js";
import { fakeHost } from "./support/fake-host.js";
import { renderUi } from "./support/render.js";
import { h } from "./support/h.js";

const me = "a".repeat(64);
const features = { localAgents: false, admin: true, usage: false, chains: false, describe: false, notices: false };
const seeded = new Map<string, string>();
beforeEach(() => { seeded.clear(); });
type Respond = (r: ApiRequest) => ApiResponse | Promise<ApiResponse>;
function mountRoute(path: string, respond: Respond) {
 const nav = AppNavSchema.parse({ me: { developerId: me, name: "Priya", orgRole: "owner" }, org: { name: "Acme" }, homeCount: 0, projects: [], shared: { agents: [], sessions: [] }, features });
 const identity = AppMeResponseSchema.parse({ developer: { id: me, name: "Priya", orgRole: "owner" }, org: { orgId: "org_aaaaaaaaaaaaaaaaaaaa", name: "Acme", plan: "team" }, identities: [] });
 const f = fakeHost(async r => (r.path === "/v1/app/nav" ? { status: 200, body: nav } : r.path === "/v1/app/me" ? { status: 200, body: identity } : respond(r)));
 const query = createQueryClient(); query.setQueryData(["nav"], nav); f.storage.set("rovara.theme", "light");
 for (const [key, value] of seeded) f.storage.set(key, value);
 const router = createMemoryRouter(appRoutes(nav.features), { initialEntries: [path] });
 const view = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(ThemeProvider, { host: f.host, children: h(RouterProvider, { router }) }) }) }));
 return { ...f, query, close: () => { view.unmount(); router.dispose(); query.clear(); } };
}
/** The component alone, as PR 9's setup shell places it. */
function mountAlone(element: ReturnType<typeof h>, respond: Respond, path = "/app/setup") {
 const f = fakeHost(async r => respond(r));
 for (const [key, value] of seeded) f.storage.set(key, value);
 const query = createQueryClient();
 const router = createMemoryRouter([{ path: "/app/setup", element }], { initialEntries: [path] });
 const view = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(RouterProvider, { router }) }) }));
 return { ...f, query, close: () => { view.unmount(); router.dispose(); query.clear(); } };
}

const OFFERED = ["zai.glm-4.7", "claude-sonnet-4-5"];
const engine = (model: string | null, source: "company" | "install", canChange = true) => ({ model, source, offered: OFFERED, preselect: model !== null && OFFERED.includes(model) ? model : OFFERED[0], canChange });
const agentAi = (source: string | null, version: number) => ({ source, version, canChange: true, anthropicKeyConnected: false, bedrockConnected: null, choices: [{ source: "rovara", available: true }, { source: "anthropic_key", available: true }, { source: "bedrock_byo", available: false }] });
const settings = (capMicros: number | null, version: number) => ({ companyId: "org_aaaaaaaaaaaaaaaaaaaa", version, modelGateway: capMicros === null ? { ready: false, reason: "company_monthly_cap_unset", message: "Set a monthly cap to use the model gateway." } : { ready: true },
 settings: { featureGates: {}, websiteCeiling: { mode: "any" }, instructions: [], evalBudgetUsdMicros: null, freshSignInSeconds: 600, start: { allow: true, maxEstimateUsdMicros: null }, decisions: [{ what: "setting.loosen", secondPerson: true }], locks: {},
  budgets: { companyMonthlyUsdMicros: capMicros, memberMonthlyUsdMicros: null, projectMonthlyUsdMicros: null, taskUsdMicros: null, learningMonthlyUsdMicros: 20_000_000 } } });

/** A Cloud that answers the step's three reads and records every write. */
function company(state: { cap: number | null; source: string | null; model: string | null }, refuse: Partial<Record<string, ApiResponse>> = {}) {
 const writes: ApiRequest[] = [];
 let settingsVersion = state.cap === null ? 0 : 3, sourceVersion = state.source === null ? 0 : 2;
 const respond: Respond = (r) => {
  if (r.method !== "GET") { writes.push(r); const refused = refuse[r.path]; if (refused !== undefined) return refused; }
  if (r.path === "/v1/app/org/engine-model") {
   if (r.method === "PUT") state.model = (r.body as { model: string }).model;
   return { status: 200, body: state.model === null ? engine(null, "install") : engine(state.model, "company") };
  }
  if (r.path === "/v1/app/org/agent-ai") {
   if (r.method === "PUT") { state.source = (r.body as { source: string }).source; sourceVersion += 1; }
   return { status: 200, body: agentAi(state.source, sourceVersion) };
  }
  if (r.path === "/v1/app/org/settings") {
   if (r.method === "PUT") { state.cap = ((r.body as { settings: { budgets: { companyMonthlyUsdMicros: number } } }).settings.budgets.companyMonthlyUsdMicros); settingsVersion += 1; }
   return { status: 200, body: settings(state.cap, settingsVersion) };
  }
  return { status: 404, body: { error: { code: "NOT_FOUND", message: "route not found" } } };
 };
 return { writes, respond, state };
}

describe("readers", () => {
 it("the prefilled company limit is the existing default company cap", () => { expect(COMPANY_MONTHLY_DEFAULT_USD).toBe(DEFAULT_ORG_MONTHLY_BUDGET_USD); });
 it("read only the shapes they expect", () => {
  expect(readEngineModel(engine("claude-sonnet-4-5", "company"))).toEqual({ model: "claude-sonnet-4-5", source: "company", offered: OFFERED, preselect: "claude-sonnet-4-5", canChange: true });
  for (const bad of [{ ...engine(null, "install"), preselect: "other" }, { ...engine(null, "install"), offered: [] }, { ...engine(null, "install"), canChange: "yes" }, { ...engine(null, "install"), source: "x" }, null]) expect(() => readEngineModel(bad)).toThrow();
  expect(readSpendLimits({ project: "web", revision: 2, perTask: { sameAsCompany: true, usd: null }, appliedUsd: 50, canChange: true })).toMatchObject({ perTask: { sameAsCompany: true }, appliedUsd: 50 });
  for (const bad of [{ project: "web", revision: 2, perTask: { sameAsCompany: true, usd: 5 }, canChange: true }, { project: "web", revision: -1, perTask: { sameAsCompany: true, usd: null }, canChange: true }, { project: "web", revision: 1, perTask: { sameAsCompany: false, usd: -2 }, canChange: true }]) expect(() => readSpendLimits(bad)).toThrow();
  expect([dollarsOf("500", 1e6), dollarsOf("12.50", 1e6), dollarsOf("1.234", 1e6), dollarsOf("-1", 1e6), dollarsOf("2000000", 1e6), dollarsOf("", 1e6)]).toEqual([500, 12.5, undefined, undefined, undefined, undefined]);
 });
});

describe("the company step, AI and spending", () => {
 it("a new company: the default option is picked, Rovara's AI is picked, the default limit is prefilled; Save is there at once (no step-up)", async () => {
  const c = company({ cap: null, source: null, model: null });
  const f = mountRoute("/app/admin/ai-spending", c.respond);
  try {
   expect((await screen.findByLabelText<HTMLSelectElement>("Company model")).value).toBe("@default");
   expect((screen.getByTestId("ai-spend-rovara").querySelector("input") as HTMLInputElement).checked).toBe(true);
   expect(screen.getByLabelText<HTMLInputElement>(/Company monthly limit/u).value).toBe("500");
   expect(screen.queryByTestId("fresh-sign-in")).toBeNull();
   expect(screen.getByRole("button", { name: "Save" })).toBeTruthy();
  } finally { f.close(); }
 });

 it("a served default shows company billing and a working Change link on the real route", async () => {
  const c = company({ cap: 500_000_000, source: null, model: null });
  const f = mountRoute("/app/admin/ai-spending", r => r.path === "/v1/app/org/agent-ai" && r.method === "GET"
   ? { status: 200, body: { ...agentAi(null, 0), effectiveSource: "rovara", sourceIsDefault: true } } : c.respond(r));
  try {
   const note = await screen.findByTestId("ai-spend-default");
   expect(note.textContent).toContain("Rovara's AI, billed to your company");
   const change = within(note).getByRole("link", { name: "Change" });
   expect(change.getAttribute("href")).toBe("/app/admin/ai-spending#ai-connections");
   fireEvent.click(change);
   expect(await screen.findByRole("heading", { name: "Company AI connections" })).toBeTruthy();
   fireEvent.change(screen.getByLabelText(/Company monthly limit/u), { target: { value: "600" } });
   fireEvent.click(screen.getByRole("button", { name: "Save" }));
   await screen.findByTestId("ai-spend-saved");
   expect(c.writes.map(w => w.path)).toEqual(["/v1/app/org/settings"]);
   expect(c.state.source).toBeNull();
  } finally { f.close(); }
 });

 it.each([false, true])("inline Anthropic connect refreshes the source; explicit Rovara save=%s", async (chooseRovara) => {
  const c = company({ cap: 500_000_000, source: null, model: null });
  let connected = false;
  const f = mountRoute("/app/admin/ai-spending", r => {
   if (r.path === "/v1/app/org/learning-ai/key" && r.method === "PUT") { connected = true; return { status: 200, body: { revision: 1, accounts: { anthropic: { connected } }, removed: [], pausedNow: [], pauseReasons: [] } }; }
   if (r.path === "/v1/app/org/learning-ai") return { status: 200, body: { revision: connected ? 1 : 0, accounts: { anthropic: { connected }, openai: { connected: false }, gemini: { connected: false } }, removed: [], pausedNow: [], pauseReasons: [] } };
   if (r.path === "/v1/app/org/agent-ai" && r.method === "GET" && c.state.source === null) return { status: 200, body: { ...agentAi(null, 0), anthropicKeyConnected: connected, bedrockConnected: false, effectiveSource: connected ? "anthropic_key" : "rovara", sourceIsDefault: true } };
   return c.respond(r);
  });
  try {
   expect((await screen.findByTestId("ai-spend-default")).textContent).toContain("Rovara's AI, billed to your company");
   expect(screen.getByTestId("ai-spend-rovara").querySelector<HTMLInputElement>("input")!.checked).toBe(true);
   fireEvent.click(screen.getByText("Connect company AI"));
   const input = await screen.findByLabelText("Paste the Anthropic key");
   fireEvent.change(input, { target: { value: "fixture-anthropic-key" } });
   fireEvent.submit(input.closest("form")!);
   await screen.findByText("Key connected.");
   await waitFor(() => expect(screen.queryByTestId("ai-spend-default")).toBeNull());
   expect(screen.getByTestId("ai-spend-own").querySelector<HTMLInputElement>("input")!.checked).toBe(true);
   expect(screen.getByRole<HTMLInputElement>("radio", { name: "Your own Anthropic key" }).checked).toBe(true);
   expect(screen.getByText(/Task source: Your Anthropic key/u)).toBeTruthy();
   expect(c.writes).toEqual([]);
   if (chooseRovara) fireEvent.click(screen.getByTestId("ai-spend-rovara").querySelector<HTMLInputElement>("input")!);
   fireEvent.click(screen.getByRole("button", { name: "Save" }));
   const saved = await screen.findByTestId("ai-spend-saved");
   expect(c.writes).toEqual(chooseRovara ? [{ method: "PUT", path: "/v1/app/org/agent-ai", retry: "never", body: { expectedVersion: 0, source: "rovara" } }] : []);
   expect(saved.textContent).toContain(chooseRovara ? "Current AI source: Rovara's AI" : "Current AI source: Your Anthropic key");
   expect(screen.getByTestId(chooseRovara ? "ai-spend-rovara" : "ai-spend-own").querySelector<HTMLInputElement>("input")!.checked).toBe(true);
  } finally { f.close(); }
 });

 it.each([false, true, "anthropic_key"] as const)("inline Bedrock connect refreshes the source; explicit choice=%s", async (choice) => {
  const chooseRovara = choice === true;
  const c = company({ cap: 500_000_000, source: null, model: null });
  const roleArn = "arn:aws:iam::123456789012:role/RovaraBedrockInvoke-fixture";
  let connected = false;
  const f = mountRoute("/app/admin/ai-spending", r => {
   if (r.path === "/v1/app/org/bedrock/setup/us-west-2") return { status: 200, body: { companyId: "org_aaaaaaaaaaaaaaaaaaaa", region: "us-west-2", externalId: "rvb-" + "a".repeat(40), brokerRoleArn: "arn:aws:iam::123456789012:role/broker", templateUrl: "https://docs.example/template.json", presets: { "claude-haiku-4-5": "us.anthropic.claude-haiku-4-5-v1:0" } } };
   if (r.path === "/v1/app/org/bedrock") {
    if (r.method === "PUT") connected = true;
    return { status: 200, body: { revision: connected ? 1 : 0, canChange: true, removedUntil: null, usage: "AWS bills your account.", connection: connected ? { connected: true, connectedAt: 1, updatedAt: 1, checkedAt: 1, roleArn, region: "us-west-2", allowGlobal: false, models: [{ name: "claude-haiku-4-5", id: "us.anthropic.claude-haiku-4-5-v1:0", state: "ready" }], productModels: [] } : null } };
   }
   if (r.path === "/v1/app/org/agent-ai" && r.method === "GET" && c.state.source === null) return { status: 200, body: { ...agentAi(null, 0), bedrockConnected: connected, effectiveSource: connected ? "bedrock_byo" : "rovara", sourceIsDefault: true, choices: [{ source: "rovara", available: true }, { source: "anthropic_key", available: true }, { source: "bedrock_byo", available: true }] } };
   return c.respond(r);
  });
  try {
   expect((await screen.findByTestId("ai-spend-default")).textContent).toContain("Rovara's AI, billed to your company");
   expect(screen.getByTestId("ai-spend-rovara").querySelector<HTMLInputElement>("input")!.checked).toBe(true);
   fireEvent.click(screen.getByText("Connect company AI"));
   const card = within(screen.getByRole("region", { name: "Your own Bedrock" }));
   fireEvent.click(await card.findByRole("button", { name: "Load Bedrock models" }));
   fireEvent.click(await card.findByLabelText("claude-haiku-4-5"));
   fireEvent.change(card.getByLabelText("Bedrock role ARN"), { target: { value: roleArn } });
   fireEvent.click(card.getByRole("button", { name: "Check and save Bedrock" }));
   await card.findByText(roleArn);
   await waitFor(() => expect(screen.queryByTestId("ai-spend-default")).toBeNull());
   expect(screen.getByTestId("ai-spend-own").querySelector<HTMLInputElement>("input")!.checked).toBe(true);
   expect(screen.getByRole<HTMLInputElement>("radio", { name: "Your own Bedrock" }).checked).toBe(true);
   expect(screen.getByText(/Task source: Your Bedrock/u)).toBeTruthy();
   expect(c.writes).toEqual([]);
   if (choice === "anthropic_key") {
    fireEvent.click(screen.getByRole("radio", { name: "Your own Anthropic key (not connected yet)" }));
    expect.soft(screen.getByTestId("ai-spend-own").querySelector<HTMLInputElement>("input")!.checked).toBe(true);
    expect.soft(screen.queryByRole<HTMLInputElement>("radio", { name: "Your own Anthropic key (not connected yet)" })?.checked).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByTestId("ai-spend-saved");
    expect(c.writes).toEqual([{ method: "PUT", path: "/v1/app/org/agent-ai", retry: "never", body: { expectedVersion: 0, source: "anthropic_key" } }]);
    return;
   }
   if (chooseRovara) fireEvent.click(screen.getByTestId("ai-spend-rovara").querySelector<HTMLInputElement>("input")!);
   fireEvent.click(screen.getByRole("button", { name: "Save" }));
   const saved = await screen.findByTestId("ai-spend-saved");
   expect(c.writes).toEqual(chooseRovara ? [{ method: "PUT", path: "/v1/app/org/agent-ai", retry: "never", body: { expectedVersion: 0, source: "rovara" } }] : []);
   expect(saved.textContent).toContain(chooseRovara ? "Current AI source: Rovara's AI" : "Current AI source: Your Bedrock");
   expect(screen.getByTestId(chooseRovara ? "ai-spend-rovara" : "ai-spend-own").querySelector<HTMLInputElement>("input")!.checked).toBe(true);
  } finally { f.close(); }
 });

 it.each([
  { effectiveSource: "anthropic_key", provider: "Your own Bedrock", source: "bedrock_byo" },
  { effectiveSource: "bedrock_byo", provider: "Your own Anthropic key (not connected yet)", source: "anthropic_key" },
 ])("selecting $provider after a source refresh keeps Own selected and saves $source", async ({ effectiveSource, provider, source }) => {
  const c = company({ cap: 500_000_000, source: null, model: null });
  let refreshed = false;
  const f = mountRoute("/app/admin/ai-spending", r => {
   if (r.path === "/v1/app/org/agent-ai" && r.method === "GET" && c.state.source === null) return { status: 200, body: {
    ...agentAi(null, 0), anthropicKeyConnected: refreshed && effectiveSource === "anthropic_key", bedrockConnected: refreshed,
    effectiveSource: refreshed ? effectiveSource : "rovara", sourceIsDefault: true,
    choices: [{ source: "rovara", available: true }, { source: "anthropic_key", available: true }, { source: "bedrock_byo", available: true }],
   } };
   return c.respond(r);
  });
  try {
   await screen.findByTestId("ai-spend-default");
   expect(screen.getByTestId("ai-spend-rovara").querySelector<HTMLInputElement>("input")!.checked).toBe(true);
   refreshed = true;
   await act(async () => { await f.query.invalidateQueries({ queryKey: ["ai-spend"] }); });
   await waitFor(() => expect(screen.queryByTestId("ai-spend-default")).toBeNull());
   expect(screen.getByTestId("ai-spend-own").querySelector<HTMLInputElement>("input")!.checked).toBe(true);
   const providerRadio = screen.getByRole<HTMLInputElement>("radio", { name: provider });
   expect(providerRadio.checked).toBe(false);
   expect(c.writes).toEqual([]);
   fireEvent.click(providerRadio);
   expect.soft(screen.getByTestId("ai-spend-own").querySelector<HTMLInputElement>("input")!.checked).toBe(true);
   expect.soft(screen.queryByRole<HTMLInputElement>("radio", { name: provider })?.checked).toBe(true);
   fireEvent.click(screen.getByRole("button", { name: "Save" }));
   await screen.findByTestId("ai-spend-saved");
   expect(c.writes).toEqual([{ method: "PUT", path: "/v1/app/org/agent-ai", retry: "never", body: { expectedVersion: 0, source } }]);
  } finally { f.close(); }
 });

 it("a new company with no saved source and no default: one Save writes the limit and the shown Rovara's AI (#255)", async () => {
  const c = company({ cap: null, source: null, model: null });
  const f = mountRoute("/app/admin/ai-spending", c.respond);
  try {
   await screen.findByLabelText("Company model");
   fireEvent.click(screen.getByRole("button", { name: "Save" }));
   await screen.findByTestId("ai-spend-saved");
   expect(c.writes).toEqual([
    {
     method: "PUT", path: "/v1/app/org/settings", retry: "never", body: {
      expectedVersion: 0,
      settings: {
       featureGates: {}, websiteCeiling: { mode: "any" }, instructions: [], evalBudgetUsdMicros: null, freshSignInSeconds: 600,
       start: { allow: true, maxEstimateUsdMicros: null }, decisions: [{ what: "setting.loosen", secondPerson: true }], locks: {},
       budgets: { companyMonthlyUsdMicros: 500_000_000, memberMonthlyUsdMicros: null, projectMonthlyUsdMicros: null, taskUsdMicros: null, learningMonthlyUsdMicros: 20_000_000 },
      },
     },
    },
    { method: "PUT", path: "/v1/app/org/agent-ai", retry: "never", body: { expectedVersion: 0, source: "rovara" } },
   ]);
   expect(c.state).toEqual({ cap: 500_000_000, source: "rovara", model: null });
  } finally { f.close(); }
 });

 it("one Save writes only the changed limit when model and source are untouched", async () => {
  const c = company({ cap: null, source: "rovara", model: null });
  const f = mountRoute("/app/admin/ai-spending", c.respond);
  try {
   await screen.findByLabelText("Company model");
   fireEvent.click(screen.getByRole("button", { name: "Save" }));
   await screen.findByTestId("ai-spend-saved");
   expect(c.writes.map(w => `${w.method} ${w.path}`)).toEqual(["PUT /v1/app/org/settings"]);
   const sent = c.writes[0]!.body as { expectedVersion: number; settings: { budgets: Record<string, unknown>; decisions: unknown[] } };
   expect(sent.expectedVersion).toBe(0);
   expect(sent.settings.budgets).toEqual({ companyMonthlyUsdMicros: 500_000_000, memberMonthlyUsdMicros: null, projectMonthlyUsdMicros: null, taskUsdMicros: null, learningMonthlyUsdMicros: 20_000_000 });
   // Everything else in the settings goes back as read.
   expect(sent.settings.decisions).toEqual([{ what: "setting.loosen", secondPerson: true }]);
   expect(c.state).toEqual({ cap: 500_000_000, source: "rovara", model: null });
  } finally { f.close(); }
 });

 it("with nothing changed, Save writes no model or source", async () => {
  const c = company({ cap: 800_000_000, source: "rovara", model: null });
  const f = mountRoute("/app/admin/ai-spending", c.respond);
  try {
   expect((await screen.findByLabelText<HTMLInputElement>(/Company monthly limit/u)).value).toBe("800");
   fireEvent.click(screen.getByRole("button", { name: "Save" }));
   await screen.findByTestId("ai-spend-saved");
   expect(c.writes).toEqual([]);
  } finally { f.close(); }
 });

 it("a refetched effective default never makes an untouched source choice save", async () => {
  const c = company({ cap: 800_000_000, source: null, model: null });
  let chosen = false;
  const respond: Respond = r => {
   if (r.path === "/v1/app/org/agent-ai" && r.method === "GET") {
    return { status: 200, body: chosen ? agentAi("anthropic_key", 1) : { ...agentAi(null, 0), effectiveSource: "rovara", sourceIsDefault: true } };
   }
   if (r.path === "/v1/app/org/engine-model" && r.method === "PUT") chosen = true;
   return c.respond(r);
  };
  const f = mountRoute("/app/admin/ai-spending", respond);
  try {
   await screen.findByLabelText("Company model");
   expect((screen.getByTestId("ai-spend-rovara").querySelector("input") as HTMLInputElement).checked).toBe(true);
   fireEvent.change(screen.getByLabelText("Company model"), { target: { value: "zai.glm-4.7" } });
   fireEvent.click(screen.getByRole("button", { name: "Save" }));
   await screen.findByTestId("ai-spend-saved");
   await waitFor(() => expect(screen.queryByTestId("ai-spend-default")).toBeNull());
   expect(c.writes.map(w => w.path)).toEqual(["/v1/app/org/engine-model"]);
   fireEvent.click(screen.getByRole("button", { name: "Save" }));
   await waitFor(() => expect(screen.getByRole<HTMLButtonElement>("button", { name: "Save" }).disabled).toBe(false));
   expect(c.writes.filter(w => w.path === "/v1/app/org/engine-model")).toHaveLength(1);
   expect(c.writes.some(w => w.path === "/v1/app/org/agent-ai")).toBe(false);
   expect(c.state.source).toBeNull();
  } finally { f.close(); }
 });

 it("a source refresh preserves explicit drafts and saves against the current source version", async () => {
  const c = company({ cap: 500_000_000, source: null, model: null });
  let refreshed = false;
  const f = mountRoute("/app/admin/ai-spending", async r => {
   if (r.path === "/v1/app/org/agent-ai") {
    if (r.method === "PUT") { await c.respond(r); return { status: 200, body: agentAi(c.state.source, 5) }; }
    return { status: 200, body: c.state.source !== null ? agentAi(c.state.source, 5) : refreshed ? agentAi("bedrock_byo", 4) : { ...agentAi(null, 0), effectiveSource: "rovara", sourceIsDefault: true } };
   }
   return c.respond(r);
  });
  try {
   await screen.findByLabelText("Company model");
   fireEvent.change(screen.getByLabelText("Company model"), { target: { value: "claude-sonnet-4-5" } });
   fireEvent.change(screen.getByLabelText(/Company monthly limit/u), { target: { value: "600" } });
   fireEvent.click(screen.getByTestId("ai-spend-own").querySelector<HTMLInputElement>("input")!);
   refreshed = true;
   await act(async () => { await f.query.invalidateQueries({ queryKey: ["ai-spend"] }); });
   expect(await screen.findByText(/Task source: Your Bedrock/u)).toBeTruthy();
   expect(screen.getByRole<HTMLInputElement>("radio", { name: "Your own Anthropic key (not connected yet)" }).checked).toBe(true);
   expect(screen.getByLabelText<HTMLSelectElement>("Company model").value).toBe("claude-sonnet-4-5");
   expect(screen.getByLabelText<HTMLInputElement>(/Company monthly limit/u).value).toBe("600");
   fireEvent.click(screen.getByRole("button", { name: "Save" }));
   const saved = await screen.findByTestId("ai-spend-saved");
   expect(c.writes.map(w => w.path)).toEqual(["/v1/app/org/settings", "/v1/app/org/agent-ai", "/v1/app/org/engine-model"]);
   expect(c.writes[1]).toEqual({ method: "PUT", path: "/v1/app/org/agent-ai", retry: "never", body: { expectedVersion: 4, source: "anthropic_key" } });
   expect(saved.textContent).toContain("Current AI source: Your Anthropic key");
  } finally { f.close(); }
 });

 for (const savedModel of ["claude-retired", "claude-sonnet-4-5"]) it(`a spending-only save preserves untouched company model ${savedModel}, even when preselect differs`, async () => {
  const c = company({ cap: 500_000_000, source: "rovara", model: savedModel });
  const f = mountRoute("/app/admin/ai-spending", r => r.path === "/v1/app/org/engine-model" && r.method === "GET" ? { status: 200, body: { ...engine(savedModel, "company"), preselect: "zai.glm-4.7" } } : c.respond(r));
  try {
   const picker = await screen.findByLabelText<HTMLSelectElement>("Company model");
   expect(picker.value).toBe(savedModel);
   if (savedModel === "claude-retired") expect(within(picker).getByRole<HTMLOptionElement>("option", { name: "claude-retired (no longer offered)" }).disabled).toBe(true);
   fireEvent.change(screen.getByLabelText(/Company monthly limit/u), { target: { value: "600" } });
   fireEvent.click(screen.getByRole("button", { name: "Save" })); await screen.findByTestId("ai-spend-saved");
   expect(c.writes.map(w => w.path)).toEqual(["/v1/app/org/settings"]);
   expect(c.state.model).toBe(savedModel);
  } finally { f.close(); }
 });
 it("returning the model draft to its loaded choice makes no model PUT", async () => {
  const c = company({ cap: 500_000_000, source: "rovara", model: "claude-sonnet-4-5" });
  const f = mountRoute("/app/admin/ai-spending", c.respond);
  try {
   const picker = await screen.findByLabelText("Company model");
   fireEvent.change(picker, { target: { value: "zai.glm-4.7" } });
   fireEvent.change(picker, { target: { value: "claude-sonnet-4-5" } });
   fireEvent.click(screen.getByRole("button", { name: "Save" })); await screen.findByTestId("ai-spend-saved");
   expect(c.writes).toEqual([]);
   fireEvent.change(picker, { target: { value: "zai.glm-4.7" } });
   fireEvent.click(screen.getByRole("button", { name: "Save" }));
   await waitFor(() => expect(c.writes).toHaveLength(1));
   expect(c.writes[0]!.body).toEqual({ model: "zai.glm-4.7" });
  } finally { f.close(); }
 });

 it("every saved source is shown by name and Save never rewrites it", async () => {
  for (const savedSource of AGENT_AI_SOURCES) {
   const c = company({ cap: 800_000_000, source: savedSource, model: null });
   const f = mountRoute("/app/admin/ai-spending", c.respond);
   try {
    await screen.findByLabelText("Company model");
    if (savedSource === "rovara") {
     expect((screen.getByTestId("ai-spend-rovara").querySelector("input") as HTMLInputElement).checked).toBe(true);
    } else if (savedSource === "anthropic_key" || savedSource === "bedrock_byo") {
     expect((screen.getByTestId("ai-spend-own-choices").querySelector(`input[value="${savedSource}"]`) as HTMLInputElement).checked).toBe(true);
    } else {
     expect(screen.getByTestId("ai-spend-source-read-only").textContent).toContain(sourceLabel(savedSource));
     expect(screen.getByTestId("ai-spend-source-read-only").textContent).not.toContain(savedSource);
     expect(screen.getByTestId("ai-spend-source-read-only").querySelector("a")?.getAttribute("href")).toBe("/app/admin/ai-spending#ai-connections");
    }
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByTestId("ai-spend-saved");
    expect(c.writes.some(w => w.path === "/v1/app/org/agent-ai")).toBe(false);
   } finally { f.close(); }
  }
 });

 it("returning to the initial source makes no source PUT", async () => {
  for (const initial of [
   { cap: 800_000_000, source: "openai_key", model: null },
   { cap: null, source: "rovara", model: null },
  ]) {
   const c = company(initial);
   const f = mountRoute("/app/admin/ai-spending", c.respond);
   try {
    await screen.findByLabelText("Company model");
    if (initial.source === "rovara") {
     fireEvent.click(screen.getByTestId("ai-spend-own").querySelector("input")!);
     fireEvent.click(screen.getByTestId("ai-spend-rovara").querySelector("input")!);
    } else {
     fireEvent.click(screen.getByTestId("ai-spend-rovara").querySelector("input")!);
     fireEvent.click(screen.getByTestId("ai-spend-own").querySelector("input")!);
    }
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByTestId("ai-spend-saved");
    expect(c.writes.some(w => w.path === "/v1/app/org/agent-ai")).toBe(false);
    expect(c.state.source).toBe(initial.source);
   } finally { f.close(); }
  }
 });

 it("the read-only source link reaches the source-order editor in the consolidated card", async () => {
  const c = company({ cap: 800_000_000, source: "openai_key", model: null });
  const f = mountRoute("/app/admin/ai-spending", r => r.method === "GET" && r.path === "/v1/app/org/model-sources"
   ? { status: 200, body: { orgId: "org_aaaaaaaaaaaaaaaaaaaa", developerId: me, revision: 1, canChange: true, order: ["openai_key"], sources: [{ source: "openai_key", available: true, connected: true, inOrder: true }] } }
   : c.respond(r));
  try {
   await screen.findByLabelText("Company model");
   fireEvent.click(screen.getByTestId("ai-spend-source-read-only").querySelector("a")!);
   expect(await screen.findByText("AI source order")).toBeTruthy();
   expect(screen.getByRole("heading", { name: "Company AI connections" })).toBeTruthy();
   expect(f.request.mock.calls.some(([r]) => r.path === "/v1/app/org/model-sources")).toBe(true);
  } finally { f.close(); }
 });

 it("Rovara-cloud#308: where the server lists the company's own OpenAI key, setup offers it and saves it as the source", async () => {
  for (const connected of [false, true]) {
   const c = company({ cap: 800_000_000, source: "rovara", model: null });
   const listed = (r: ApiRequest): ApiResponse | Promise<ApiResponse> => {
    if (r.path !== "/v1/app/org/agent-ai") return c.respond(r);
    const answer = c.respond(r) as ApiResponse;
    const body = answer.body as ReturnType<typeof agentAi>;
    return { status: 200, body: { ...body, openaiKeyConnected: connected, choices: [...body.choices, { source: "openai_key", available: connected }] } };
   };
   const f = mountRoute("/app/admin/ai-spending", listed);
   try {
    await screen.findByLabelText("Company model");
    fireEvent.click(screen.getByTestId("ai-spend-own").querySelector("input")!);
    const radio = screen.getByTestId("ai-spend-openai").querySelector("input") as HTMLInputElement;
    expect(radio.disabled).toBe(!connected);
    expect(screen.queryByTestId("ai-spend-no-openai-key") !== null).toBe(!connected);
    if (connected) {
     fireEvent.click(radio);
     fireEvent.click(screen.getByRole("button", { name: "Save" }));
     await screen.findByTestId("ai-spend-saved");
     expect(c.writes.find(w => w.path === "/v1/app/org/agent-ai")?.body).toMatchObject({ source: "openai_key" });
    }
   } finally { f.close(); }
  }
 });

 it("changing a saved read-only source to Rovara writes only the selected source", async () => {
  const c = company({ cap: 800_000_000, source: "openai_key", model: null });
  const f = mountRoute("/app/admin/ai-spending", c.respond);
  try {
   await screen.findByLabelText("Company model");
   fireEvent.click(screen.getByTestId("ai-spend-rovara").querySelector("input")!);
   fireEvent.click(screen.getByRole("button", { name: "Save" }));
   await screen.findByTestId("ai-spend-saved");
   expect(c.writes.map(w => w.path)).toEqual(["/v1/app/org/agent-ai"]);
   expect(c.writes[0]!.body).toEqual({ expectedVersion: 2, source: "rovara" });
  } finally { f.close(); }
 });

 it("the person's own provider, another model and another limit; a lower limit lowers the learning cap too", async () => {
  const c = company({ cap: null, source: null, model: null });
  const f = mountRoute("/app/admin/ai-spending", c.respond);
  try {
   fireEvent.change(await screen.findByLabelText("Company model"), { target: { value: "claude-sonnet-4-5" } });
   fireEvent.click(screen.getByTestId("ai-spend-own").querySelector("input")!);
   expect(screen.getByTestId("ai-spend-connect").getAttribute("href")).toBe("/app/admin/ai-spending#ai-connections");
   fireEvent.change(screen.getByLabelText(/Company monthly limit/u), { target: { value: "15.50" } });
   fireEvent.click(screen.getByRole("button", { name: "Save" }));
   await screen.findByTestId("ai-spend-saved");
   expect((c.writes[0]!.body as { settings: { budgets: Record<string, number> } }).settings.budgets).toMatchObject({ companyMonthlyUsdMicros: 15_500_000, learningMonthlyUsdMicros: 15_500_000 });
   expect(c.writes[1]!.body).toEqual({ expectedVersion: 0, source: "anthropic_key" });
   expect(c.writes[2]!.body).toEqual({ model: "claude-sonnet-4-5" });
  } finally { f.close(); }
 });

 it("a bad limit is not sent", async () => {
  const c = company({ cap: null, source: null, model: null });
  const f = mountRoute("/app/admin/ai-spending", c.respond);
  try {
   for (const value of ["0", "abc", "1.234", "2000000"]) {
    fireEvent.change(await screen.findByLabelText(/Company monthly limit/u), { target: { value } });
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Save" }).disabled).toBe(true);
   }
   expect(c.writes).toEqual([]);
  } finally { f.close(); }
 });

 it("Code's refusal shows the server's fixed sentence; what was saved is read again", async () => {
  const notOffered = { status: 400, body: { error: { code: "MODEL_NOT_OFFERED", message: "That model isn't offered to this company now. Pick one from the list." } } };
  const c = company({ cap: null, source: null, model: null }, { "/v1/app/org/engine-model": notOffered });
  const f = mountRoute("/app/admin/ai-spending", c.respond);
  try {
   await screen.findByLabelText("Company model");
   const reads = f.request.mock.calls.length;
   fireEvent.change(screen.getByLabelText("Company model"), { target: { value: "zai.glm-4.7" } });
   fireEvent.click(screen.getByRole("button", { name: "Save" }));
   expect((await screen.findByTestId("ai-spend-error")).textContent).toBe("That model isn't offered to this company now. Pick one from the list.");
   await waitFor(() => { expect(f.request.mock.calls.slice(reads).filter(([r]) => r.method === "GET" && r.path === "/v1/app/org/settings")).not.toHaveLength(0); });
  } finally { f.close(); }
 });

 it("a refused money write shows the server's words, no sign-in step, and saves nothing more", async () => {
  const refused = { status: 403, body: { error: { code: "FORBIDDEN", message: "Only a company admin can do this." } } };
  const c = company({ cap: null, source: null, model: null }, { "/v1/app/org/settings": refused });
  const f = mountRoute("/app/admin/ai-spending", c.respond);
  try {
   await screen.findByLabelText("Company model");
   // The page also carries the learning-model and per-step model cards (#209, #219): read the company step's own save and alert.
   const step = within(screen.getByTestId("ai-spend-step"));
   fireEvent.click(step.getByRole("button", { name: "Save" }));
   expect((await step.findByTestId("ai-spend-error")).textContent).toContain("Only a company admin can do this.");
   expect(screen.queryByTestId("fresh-sign-in")).toBeNull();
   expect(c.writes.map(w => w.path)).toEqual(["/v1/app/org/settings"]);
   expect(c.state).toEqual({ cap: null, source: null, model: null });
  } finally { f.close(); }
 });

 it("a read failure says fixed words, never the server's (501: not available yet)", async () => {
  for (const [status, words] of [[501, "AI and spending isn't available on this Rovara yet."], [403, "Couldn't load AI and spending. Try again."]] as const) {
   const f = mountAlone(h(AiSpendStep, { role: "owner", developerId: me }), r => (r.path === "/v1/app/org/engine-model" ? { status, body: { error: { code: "X", message: "private canary" } } } : company({ cap: null, source: null, model: null }).respond(r)));
   try {
    expect((await screen.findByTestId("ai-spend-read-error")).textContent).toBe(words);
    expect(document.body.textContent).not.toContain("private canary");
   } finally { f.close(); }
  }
 });
 it("a plain member sees the model read only: no money reads, no Save", async () => {
  const c = company({ cap: null, source: null, model: "claude-sonnet-4-5" });
  const f = mountAlone(h(AiSpendStep, { role: "member", developerId: me }), r => (r.path === "/v1/app/org/engine-model" ? { status: 200, body: engine("claude-sonnet-4-5", "company", false) } : c.respond(r)));
  try {
   expect((await screen.findByTestId("ai-spend-read-only")).textContent).toMatch(/claude-sonnet-4-5.*Only a company owner or admin can change this/u);
   expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
   // The member receives only the read-only model and step/learning rows, with no money or source-control reads.
   expect(f.request.mock.calls.map(([r]) => r.path).sort()).toEqual(["/v1/app/org/agent-models", "/v1/app/org/engine-model", "/v1/app/org/learning-model"]);
  } finally { f.close(); }
 });
});

describe("a project's AI and spend limit", () => {
 const limits = (perTask: { sameAsCompany: boolean; usd: number | null }, canChange = true, revision = 2) => ({ project: "web", revision, perTask, appliedUsd: perTask.usd ?? 50, canChange });
 it("'Same as company' starts picked; the project's admin sets its own per-task limit, then goes back", async () => {
  let current = limits({ sameAsCompany: true, usd: null });
  const sent: ApiRequest[] = [];
  const f = mountAlone(h(ProjectSpendLimits, { project: "web", developerId: me }), r => {
   if (r.method === "PUT") { sent.push(r); const usd = (r.body as { perTaskUsd: number | null }).perTaskUsd; current = limits(usd === null ? { sameAsCompany: true, usd: null } : { sameAsCompany: false, usd }, true, current.revision + 1); }
   return { status: 200, body: current };
  }, "/app/setup");
  try {
   expect((await screen.findByTestId("project-spend-same")).querySelector("input")!.checked).toBe(true);
   expect(screen.getByTestId("project-spend-applied").textContent).toBe("Applies now: $50 a task.");
   fireEvent.click(screen.getByTestId("project-spend-own").querySelector("input")!);
   fireEvent.change(screen.getByLabelText(/Per-task limit \(USD\)/u), { target: { value: "12.50" } });
   fireEvent.click(screen.getByRole("button", { name: "Save" }));
   await screen.findByTestId("project-spend-saved");
   expect(sent[0]!.path).toBe("/v1/app/projects/web/spend-limits");
   expect(sent[0]!.body).toEqual({ expectedRevision: 2, perTaskUsd: 12.5 });
   await waitFor(() => { expect((screen.getByTestId("project-spend-own").querySelector("input") as HTMLInputElement).checked).toBe(true); });
   fireEvent.click(screen.getByTestId("project-spend-same").querySelector("input")!);
   fireEvent.click(screen.getByRole("button", { name: "Save" }));
   await waitFor(() => { expect(sent).toHaveLength(2); });
   expect(sent[1]!.body).toEqual({ expectedRevision: 3, perTaskUsd: null });
  } finally { f.close(); }
 });
 it("the project's admin gets Save at once (no step-up since owner DEC 254zzz73); a read failure says fixed words, never the server's", async () => {
  const f = mountAlone(h(ProjectSpendLimits, { project: "web", developerId: me }), () => ({ status: 200, body: limits({ sameAsCompany: true, usd: null }) }));
  try {
   await screen.findByTestId("project-spend-same");
   expect(screen.queryByTestId("fresh-sign-in")).toBeNull();
   expect(screen.getByRole("button", { name: "Save" })).toBeTruthy();
  } finally { f.close(); }
  const bad = mountAlone(h(ProjectSpendLimits, { project: "web", developerId: me }), () => ({ status: 403, body: { error: { code: "FORBIDDEN", message: "private canary" } } }));
  try {
   expect((await screen.findByTestId("project-spend-unread")).textContent).toBe("Couldn't load the spending limits. Try again.");
   expect(document.body.textContent).not.toContain("private canary");
  } finally { bad.close(); }
 });
 it("someone who can't change it sees it read only; a refusal shows the server's sentence", async () => {
  const ro = mountAlone(h(ProjectSpendLimits, { project: "web", developerId: me }), () => ({ status: 200, body: limits({ sameAsCompany: false, usd: 7 }, false) }));
  try {
   expect((await screen.findByTestId("project-spend-read-only")).textContent).toMatch(/\$7.*Only this project's admins can change it/u);
   expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
  } finally { ro.close(); }
  const f = mountAlone(h(ProjectSpendLimits, { project: "web", developerId: me }), r => (r.method === "PUT" ? { status: 403, body: { error: { code: "FORBIDDEN", message: "That's above your company's per-task limit. Pick a lower amount." } } } : { status: 200, body: limits({ sameAsCompany: true, usd: null }) }), "/app/setup");
  try {
   fireEvent.click((await screen.findByTestId("project-spend-own")).querySelector("input")!);
   fireEvent.change(screen.getByLabelText(/Per-task limit \(USD\)/u), { target: { value: "999" } });
   fireEvent.click(screen.getByRole("button", { name: "Save" }));
   expect((await screen.findByTestId("project-spend-error")).textContent).toBe("That's above your company's per-task limit. Pick a lower amount.");
  } finally { f.close(); }
 });
});

// R1/R2/R4: fresh served facts, no stale billing or premature save claim.
for (const failure of [403, 503]) it(`a later source read failure ${failure} drops the default claim and Save, even with cached data`, async () => {
 const c = company({ cap: 500_000_000, source: null, model: null }); let failed = false;
 const f = mountRoute("/app/admin/ai-spending", r => r.path === "/v1/app/org/agent-ai" && r.method === "GET"
  ? failed ? { status: failure, body: { error: { code: "FORBIDDEN", message: "not readable" } } } : { status: 200, body: { ...agentAi(null, 0), effectiveSource: "rovara", sourceIsDefault: true } } : c.respond(r));
 try {
  await screen.findByTestId("ai-spend-default");
  fireEvent.click(screen.getByRole("button", { name: "Save" })); await screen.findByTestId("ai-spend-saved");
  failed = true;
  await act(async () => { await f.query.refetchQueries({ predicate: q => q.queryKey[0] === "ai-spend" && q.queryKey.at(-1) === "agent-ai" }); });
  await screen.findByTestId("ai-spend-source-read-error", {}, { timeout: 5000 });
  expect(screen.queryByTestId("ai-spend-default")).toBeNull();
  expect(screen.queryByTestId("ai-spend-saved")).toBeNull();
  expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
 } finally { f.close(); }
});
it("does not claim Saved when the confirming source read fails", async () => {
 const c = company({ cap: 500_000_000, source: null, model: null }); let wrote = false;
 const f = mountRoute("/app/admin/ai-spending", r => {
  if (r.method === "PUT") wrote = true;
  if (r.path === "/v1/app/org/agent-ai" && r.method === "GET") return wrote ? { status: 403, body: { error: { code: "UNAVAILABLE", message: "unreadable" } } } : { status: 200, body: { ...agentAi(null, 0), effectiveSource: "rovara", sourceIsDefault: true } };
  return c.respond(r);
 });
 try {
  await screen.findByTestId("ai-spend-default");
  fireEvent.change(screen.getByLabelText(/Company monthly limit/u), { target: { value: "600" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await screen.findByTestId("ai-spend-source-read-error", {}, { timeout: 5000 });
  expect(screen.queryByTestId("ai-spend-saved")).toBeNull();
  expect(document.body.textContent).toContain("Rovara didn't confirm this yet");
 } finally { f.close(); }
});
it("a served default can continue without saving, but model, cap, gateway and step checks still gate it", async () => {
 const stages = ["understand", "plan", "plan_check", "build", "code_review", "security_review", "pull_request"];
 for (const blocked of ["none", "model", "cap", "gateway", "steps", "source"]) {
  const c = company({ cap: 500_000_000, source: null, model: "zai.glm-4.7" });
  const f = mountAlone(h(AiSpendStep, { role: "owner", developerId: me, onContinue: () => undefined }), r => {
   if (r.path === "/v1/app/org/agent-ai") return { status: 200, body: { ...agentAi(null, 0), ...(blocked === "source" ? {} : { effectiveSource: "rovara", sourceIsDefault: true }) } };
   if (r.path === "/v1/app/org/agent-models") return { status: 200, body: { revision: 1, offered: OFFERED, canChange: true, steps: stages.map(stage => ({ stage, setting: null, refused: blocked === "steps", effective: blocked === "steps" ? null : { model: "zai.glm-4.7", companyDefault: true } })) } };
   if (r.path === "/v1/app/org/engine-model" && blocked === "model") return { status: 200, body: engine(null, "install") };
   if (r.path === "/v1/app/org/settings") return { status: 200, body: { ...settings(blocked === "cap" ? null : 500_000_000, 1), ...(blocked === "gateway" ? { modelGateway: { ready: false, reason: "not_ready", message: "not ready" } } : {}) } };
   return c.respond(r);
  });
  try {
   await screen.findByLabelText("Company model");
   await waitFor(() => expect(screen.getByTestId("onboard-continue-repos")).toHaveProperty("disabled", blocked !== "none"));
   expect(c.writes).toEqual([]);
   if (blocked === "source") expect(screen.queryByTestId("ai-spend-default")).toBeNull();
  } finally { f.close(); }
 }
});

it("R2 reports the re-read company limit, and retires the status on a newer disagreeing read", async () => {
 const c = company({ cap: 500_000_000, source: null, model: null });
 const f = mountRoute("/app/admin/ai-spending", r => {
  if (r.path === "/v1/app/org/settings" && r.method === "PUT") return { status: 200, body: settings(550_000_000, 2) };
  if (r.path === "/v1/app/org/settings" && r.method === "GET") return { status: 200, body: settings(c.state.cap === 500_000_000 ? 550_000_000 : c.state.cap, 2) };
  if (r.path === "/v1/app/org/agent-ai") return { status: 200, body: { ...agentAi(null, 0), effectiveSource: "rovara", sourceIsDefault: true } };
  return c.respond(r);
 });
 try {
  await screen.findByLabelText("Company model");
  fireEvent.change(screen.getByLabelText(/Company monthly limit/u), { target: { value: "600" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  const status = await screen.findByTestId("ai-spend-saved");
  expect(status.textContent).toContain("$550"); expect(status.textContent).not.toContain("$600");
  c.state.cap = 700_000_000;
  await act(async () => { await f.query.refetchQueries({ predicate: q => q.queryKey[0] === "ai-spend" && q.queryKey.at(-1) === "settings" }); });
  await waitFor(() => expect(screen.queryByTestId("ai-spend-saved")).toBeNull());
 } finally { f.close(); }
});
it("R2 offers a read-only Check after an unconfirmed default-card save", async () => {
 const c = company({ cap: 500_000_000, source: null, model: null }); let wrote = false, unavailable = false;
 const f = mountRoute("/app/admin/ai-spending", r => {
  if (r.method === "PUT") { wrote = true; unavailable = true; }
  if (r.path === "/v1/app/org/agent-ai") return wrote && unavailable ? { status: 403, body: { error: { code: "FORBIDDEN", message: "unreadable" } } } : { status: 200, body: { ...agentAi(null, 0), effectiveSource: "rovara", sourceIsDefault: true } };
  return c.respond(r);
 });
 try {
  await screen.findByLabelText("Company model");
  fireEvent.change(screen.getByLabelText(/Company monthly limit/u), { target: { value: "600" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  const check = await screen.findByRole("button", { name: "Check" });
  const before = c.writes.length; unavailable = false; fireEvent.click(check);
  await waitFor(() => expect(screen.getByTestId("ai-spend-saved").textContent).toContain("$600"));
  expect(c.writes).toHaveLength(before);
 } finally { f.close(); }
});
