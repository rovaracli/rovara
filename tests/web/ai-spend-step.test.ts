// @vitest-environment jsdom
// Guided onboarding PR 15 (DEC 254l item 7, DEC 254n item 1): the company step "AI and spending" and a project's "AI and spend limit".
// The step preselects Code's `preselect` from the company's own offered list, prefills the saved monthly limit or the existing default, and its one
// Save writes the limit and the source only when they changed but the model ALWAYS (explicitly, so a new company never depends on the install
// default). A plain member sees it read only. Refusals are the server's fixed sentences. The project part keeps "Same as company" picked.
import { beforeEach, describe, expect, it } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { AppNavSchema, AppMeResponseSchema } from "@agentx/contracts/web";
import { DEFAULT_ORG_MONTHLY_BUDGET_USD } from "../../packages/contracts/src/org-budget.js";
import { appRoutes } from "../../packages/ui/src/routes.js";
import { AppHostProvider, type ApiRequest, type ApiResponse } from "../../packages/ui/src/host.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { ThemeProvider } from "../../packages/ui/src/theme.js";
import { COMPANY_MONTHLY_DEFAULT_USD, dollarsOf, readEngineModel, readSpendLimits } from "../../packages/ui/src/api/ai-spend.js";
import { AiSpendStep } from "../../packages/ui/src/screens/setup/AiSpendStep.js";
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
 return { ...f, close: () => { view.unmount(); router.dispose(); query.clear(); } };
}
/** The component alone, as PR 9's setup shell places it. */
function mountAlone(element: ReturnType<typeof h>, respond: Respond, path = "/app/setup") {
 const f = fakeHost(async r => respond(r));
 for (const [key, value] of seeded) f.storage.set(key, value);
 const query = createQueryClient();
 const router = createMemoryRouter([{ path: "/app/setup", element }], { initialEntries: [path] });
 const view = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(RouterProvider, { router }) }) }));
 return { ...f, close: () => { view.unmount(); router.dispose(); query.clear(); } };
}
function confirmedPath(path: string, nonce = "n-1"): string { seeded.set("rovara.stepup.nonce", JSON.stringify({ nonce, at: Date.now() })); return `${path}?confirmed=${nonce}`; }

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
 it("a new company: Code's preselected model is picked, Rovara's AI is picked, the default limit is prefilled; no Save before the fresh sign-in", async () => {
  const c = company({ cap: null, source: null, model: null });
  const f = mountRoute("/app/admin/ai-spending", c.respond);
  try {
   expect((await screen.findByLabelText<HTMLSelectElement>("Model")).value).toBe("zai.glm-4.7");
   expect((screen.getByTestId("ai-spend-rovara").querySelector("input") as HTMLInputElement).checked).toBe(true);
   expect(screen.getByLabelText<HTMLInputElement>(/Company monthly limit/u).value).toBe("500");
   expect(screen.getByTestId("fresh-sign-in")).toBeTruthy();
   expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
  } finally { f.close(); }
 });

 it("one Save writes the limit, the source and the preselected model explicitly, in that order", async () => {
  const c = company({ cap: null, source: null, model: null });
  const f = mountRoute(confirmedPath("/app/admin/ai-spending"), c.respond);
  try {
   await screen.findByLabelText("Model");
   fireEvent.click(screen.getByRole("button", { name: "Save" }));
   await screen.findByTestId("ai-spend-saved");
   expect(c.writes.map(w => `${w.method} ${w.path}`)).toEqual(["PUT /v1/app/org/settings", "PUT /v1/app/org/agent-ai", "PUT /v1/app/org/engine-model"]);
   const sent = c.writes[0]!.body as { expectedVersion: number; settings: { budgets: Record<string, unknown>; decisions: unknown[] } };
   expect(sent.expectedVersion).toBe(0);
   expect(sent.settings.budgets).toEqual({ companyMonthlyUsdMicros: 500_000_000, memberMonthlyUsdMicros: null, projectMonthlyUsdMicros: null, taskUsdMicros: null, learningMonthlyUsdMicros: 20_000_000 });
   // Everything else in the settings goes back as read.
   expect(sent.settings.decisions).toEqual([{ what: "setting.loosen", secondPerson: true }]);
   expect(c.writes[1]!.body).toEqual({ expectedVersion: 0, source: "rovara" });
   expect(c.writes[2]!.body).toEqual({ model: "zai.glm-4.7" });
   expect(c.state).toEqual({ cap: 500_000_000, source: "rovara", model: "zai.glm-4.7" });
  } finally { f.close(); }
 });

 it("with nothing changed, Save still writes the model (and only the model)", async () => {
  const c = company({ cap: 800_000_000, source: "rovara", model: null });
  const f = mountRoute(confirmedPath("/app/admin/ai-spending"), c.respond);
  try {
   expect((await screen.findByLabelText<HTMLInputElement>(/Company monthly limit/u)).value).toBe("800");
   fireEvent.click(screen.getByRole("button", { name: "Save" }));
   await screen.findByTestId("ai-spend-saved");
   expect(c.writes.map(w => `${w.method} ${w.path}`)).toEqual(["PUT /v1/app/org/engine-model"]);
   expect(c.writes[0]!.body).toEqual({ model: "zai.glm-4.7" });
  } finally { f.close(); }
 });

 it("the person's own provider, another model and another limit; a lower limit lowers the learning cap too", async () => {
  const c = company({ cap: null, source: null, model: null });
  const f = mountRoute(confirmedPath("/app/admin/ai-spending"), c.respond);
  try {
   fireEvent.change(await screen.findByLabelText("Model"), { target: { value: "claude-sonnet-4-5" } });
   fireEvent.click(screen.getByTestId("ai-spend-own").querySelector("input")!);
   expect(screen.getByTestId("ai-spend-connect").getAttribute("href")).toBe("/app/admin/learning-ai");
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
  const f = mountRoute(confirmedPath("/app/admin/ai-spending"), c.respond);
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
  const f = mountRoute(confirmedPath("/app/admin/ai-spending"), c.respond);
  try {
   await screen.findByLabelText("Model");
   const reads = f.request.mock.calls.length;
   fireEvent.click(screen.getByRole("button", { name: "Save" }));
   expect((await screen.findByTestId("ai-spend-error")).textContent).toBe("That model isn't offered to this company now. Pick one from the list.");
   await waitFor(() => { expect(f.request.mock.calls.slice(reads).filter(([r]) => r.method === "GET" && r.path === "/v1/app/org/settings")).not.toHaveLength(0); });
  } finally { f.close(); }
 });

 it("a step-up the server finds too old shows the fresh sign-in again and saves nothing more", async () => {
  const stepUp = { status: 403, body: { error: { code: "STEP_UP_REQUIRED", message: "Confirm it's you again, then try once more." } } };
  const c = company({ cap: null, source: null, model: null }, { "/v1/app/org/settings": stepUp });
  const f = mountRoute(confirmedPath("/app/admin/ai-spending"), c.respond);
  try {
   await screen.findByLabelText("Model");
   fireEvent.click(screen.getByRole("button", { name: "Save" }));
   await waitFor(() => { expect(screen.getByTestId("fresh-sign-in").getAttribute("data-state")).toBe("needed"); });
   expect(c.writes.map(w => w.path)).toEqual(["/v1/app/org/settings"]);
   expect(c.state).toEqual({ cap: null, source: null, model: null });
  } finally { f.close(); }
 });

 it("a plain member sees the model read only: no money reads, no Save", async () => {
  const c = company({ cap: null, source: null, model: "claude-sonnet-4-5" });
  const f = mountAlone(h(AiSpendStep, { role: "member", developerId: me }), r => (r.path === "/v1/app/org/engine-model" ? { status: 200, body: engine("claude-sonnet-4-5", "company", false) } : c.respond(r)));
  try {
   expect((await screen.findByTestId("ai-spend-read-only")).textContent).toMatch(/claude-sonnet-4-5.*Only a company owner or admin can change this/u);
   expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
   expect(f.request.mock.calls.map(([r]) => r.path)).toEqual(["/v1/app/org/engine-model"]);
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
  }, confirmedPath("/app/setup"));
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
 it("the project's admin gets no Save before the fresh sign-in; a read failure says fixed words, never the server's", async () => {
  const f = mountAlone(h(ProjectSpendLimits, { project: "web", developerId: me }), () => ({ status: 200, body: limits({ sameAsCompany: true, usd: null }) }));
  try {
   await screen.findByTestId("project-spend-same");
   expect(screen.getByTestId("fresh-sign-in")).toBeTruthy();
   expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
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
  const f = mountAlone(h(ProjectSpendLimits, { project: "web", developerId: me }), r => (r.method === "PUT" ? { status: 403, body: { error: { code: "FORBIDDEN", message: "That's above your company's per-task limit. Pick a lower amount." } } } : { status: 200, body: limits({ sameAsCompany: true, usd: null }) }), confirmedPath("/app/setup"));
  try {
   fireEvent.click((await screen.findByTestId("project-spend-own")).querySelector("input")!);
   fireEvent.change(screen.getByLabelText(/Per-task limit \(USD\)/u), { target: { value: "999" } });
   fireEvent.click(screen.getByRole("button", { name: "Save" }));
   expect((await screen.findByTestId("project-spend-error")).textContent).toBe("That's above your company's per-task limit. Pick a lower amount.");
  } finally { f.close(); }
 });
});
