// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { AppNavSchema } from "@agentx/contracts/web";
import { appRoutes } from "../../packages/ui/src/routes.js";
import { AppHostProvider, type ApiRequest, type ApiResponse } from "../../packages/ui/src/host.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { ThemeProvider } from "../../packages/ui/src/theme.js";
import { fakeHost } from "./support/fake-host.js";
import { renderUi } from "./support/render.js";
import { expectNoAxeViolations } from "./support/axe.js";
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
 f.host.features.admin = liveFeatures.admin; f.host.kind = "web"; f.host.viewport = { width: () => width, subscribe: () => () => undefined };
 const query = createQueryClient(); query.setQueryData(["nav"], nav);
 const router = createMemoryRouter(appRoutes(liveFeatures), { initialEntries: [path] });
 const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(ThemeProvider, { host: f.host, children: h(RouterProvider, { router }) }) }) }));
 return { ...f, ...ui, query, router, identity, bodies, close() { ui.unmount(); router.dispose(); query.clear(); } };
}
async function ready() { await screen.findByTestId("learning-model-current"); await screen.findByTestId("step-model-build"); return screen.getByTestId("step-models"); }

for (const path of ["/app/admin/ai-spending", "/app/onboard?step=ai"]) it(`uses one model card and the same connection controls at ${path}`, async () => {
 const f = mount({ path });
 try {
  const card = await ready();
  expect(screen.getAllByRole("region", { name: "AI models for each step" })).toHaveLength(1);
  for (const label of ["Company model", "Understand and plan", "Plan check", "Coding", "Code and security review", "Pull request feedback", "Learning model"]) expect(within(card).getByRole("combobox", { name: label })).toBeTruthy();
  expect(screen.getAllByRole("combobox").every(input => card.contains(input))).toBe(true);
  const connections = screen.getByRole("region", { name: "Company AI connections" });
  expect(connections.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(within(connections).getByRole("button", { name: "Change source order" })).toBeTruthy();
  expect(card.textContent).toContain("Understand: claude-haiku-5-5");
  expect(within(card).getByRole("region", { name: "Design review model" }).compareDocumentPosition(screen.getByTestId("step-model-code_review")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(within(card).getByRole("region", { name: "Second review" }).compareDocumentPosition(screen.getByTestId("step-model-pull_request")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(within(screen.getByTestId("step-model-code_review")).getByRole("alert").textContent).toContain("No offered model");
  expect(f.request.mock.calls.every(([r]) => r.method === "GET")).toBe(true);
  await expectNoAxeViolations(f.container);
 } finally { f.close(); }
});

it("keeps second review, learning and answers truthful, with no second-review or answers picker", async () => {
 const f = mount();
 try {
  const card = await ready();
  const review = within(card).getByRole("region", { name: "Second review" });
  fireEvent.click(within(review).getByText("Second review availability"));
  expect(review.textContent).toContain("Second review through OpenRouter is not available yet");
  expect(review.textContent).toContain("Settings and mode could not be checked");
  expect(within(review).queryByRole("combobox")).toBeNull();
  expect(within(review).queryByRole("button")).toBeNull();
  const answers = within(card).getByRole("region", { name: "Answers and Slack chat" });
  expect(answers.textContent).toContain("Read only");
  expect(answers.textContent).toContain("current model, source and readiness could not be checked");
  expect(within(answers).queryByRole("combobox")).toBeNull();
  expect(within(answers).queryByRole("button")).toBeNull();
  expect(screen.getByTestId("learning-model-card").textContent).toContain("does not follow task source order");
  expect(f.request.mock.calls.some(([r]) => r.path.includes("second-review"))).toBe(false);
 } finally { f.close(); }
});

for (const [path, hash] of [
 ["/app/admin/models", "ai-models"], ["/app/admin/models/sources", "ai-connections"], ["/app/admin/models/available", "ai-models"], ["/app/admin/models/steps", "ai-models"], ["/app/admin/agent-ai", "ai-connections"], ["/app/admin/learning-ai", "ai-connections"], ["/app/admin/second-review", "second-review"], ["/app/agents/new", "ai-models"], ["/app/agents/agt_aaaaaaaaaaaaaaaaaaaa/edit", "ai-models"],
] as const) for (const role of ["owner", "member"] as const) it(`redirects ${role} ${path} to its replacement section and focuses it after loading`, async () => {
 const scroll = vi.fn(); const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollIntoView"); HTMLElement.prototype.scrollIntoView = scroll;
 const f = mount({ path: path + "?project=web", role });
 try {
  await ready(); expect(f.router.state.location).toMatchObject({ pathname: "/app/admin/ai-spending", search: "?project=web", hash: `#${hash}` });
  await waitFor(() => expect(document.activeElement).toBe(document.getElementById(hash)));
  expect(scroll).toHaveBeenCalled(); expect(screen.getAllByTestId("step-models")).toHaveLength(1);
  expect(f.request.mock.calls.some(([r]) => r.path === "/v1/app/models")).toBe(false);
  if (role === "member") expect(screen.queryByRole("combobox")).toBeNull();
 } finally { f.close(); if (original) Object.defineProperty(HTMLElement.prototype, "scrollIntoView", original); else Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView"); }
});

it("gives a narrow-screen member only the read-only card, even if a stale server response advertises edits", async () => {
 const f = mount({ role: "member", width: 375 });
 try {
  const card = await ready();
  expect(within(card).queryByRole("combobox")).toBeNull();
  expect(within(card).queryByRole("button")).toBeNull();
  expect(screen.queryByRole("navigation", { name: "Administration" })).toBeNull();
  expect(f.request.mock.calls.map(([r]) => r.path).filter(path => path.startsWith("/v1/app/org/")).sort()).toEqual(["/v1/app/org/agent-models", "/v1/app/org/engine-model", "/v1/app/org/learning-model"]);
  await expectNoAxeViolations(f.container);
  await act(async () => { await f.router.navigate("/app/admin/people"); });
  await screen.findByRole("heading", { name: "Not found" });
  expect(f.request.mock.calls.some(([r]) => r.path === "/v1/app/org/members")).toBe(false);
 } finally { f.close(); }
});

it("drops an admin's drafts and privileged controls when their live role becomes member", async () => {
 const f = mount();
 try {
  await ready(); fireEvent.change(screen.getByLabelText("Company model"), { target: { value: HAIKU } });
  f.identity.developer.orgRole = "member";
  await act(async () => { await f.query.invalidateQueries({ queryKey: ["admin", "identity"] }); });
  await screen.findByTestId("ai-spend-read-only");
  await waitFor(() => expect(screen.queryByRole("combobox")).toBeNull());
  expect(screen.queryByRole("region", { name: "Company AI connections" })).toBeNull();
  expect(f.query.getQueriesData({ queryKey: ["admin", "lane-c"] })).toEqual([]);
  expect(f.request.mock.calls.every(([r]) => r.method === "GET")).toBe(true);
 } finally { f.close(); }
});

it("keeps supported rows usable when learning is unavailable", async () => {
 const f = mount({ overrides: { "/v1/app/org/learning-model": unavailable } });
 try {
  await screen.findByTestId("learning-model-read-error");
  expect(screen.getByLabelText("Company model")).toBeTruthy(); expect(screen.getByLabelText("Coding")).toBeTruthy();
  expect(within(screen.getByTestId("learning-model-card")).queryByRole("button")).toBeNull();
  expect(screen.getByTestId("answers-model-row")).toBeTruthy();
 } finally { f.close(); }
});

it("keeps absent task rows unavailable and automatic rows present on an older partial read", async () => {
 const f = mount({ overrides: { "/v1/app/org/agent-models": { status: 200, body: { revision: 1, steps: [], offered: [SONNET], canChange: true } } } });
 try {
  const card = await ready();
  for (const stage of ["plan", "plan_check", "build", "code_review", "pull_request"]) {
   const row = screen.getByTestId(`step-model-${stage}`);
   expect(row.textContent).toContain("Not available on this Rovara yet.");
   expect(within(row).queryByRole("combobox")).toBeNull();
  }
  expect(within(card).getByRole("region", { name: "Second review" })).toBeTruthy();
  expect(within(card).getByRole("region", { name: "Design review model" })).toBeTruthy();
 } finally { f.close(); }
});

for (const [path, row] of [["/v1/app/org/agent-ai", "source"], ["/v1/app/org/settings", "settings"]] as const) for (const status of [501, 403]) it(`keeps the successful company model when only ${row} fails with ${status}`, async () => {
 const f = mount({ overrides: { [path]: { status, body: unavailable.body } } });
 try {
  const error = await screen.findByTestId(`ai-spend-${row}-read-error`);
  const company = screen.getByRole("region", { name: "Company model setting" });
  expect(company.textContent).toContain(SONNET); expect(company.textContent).toContain("company choice");
  expect(within(company).queryByRole("alert")).toBeNull(); expect(screen.queryByLabelText(/Company monthly limit/u)).toBeNull();
  expect(within(error.parentElement!).queryByRole("button", { name: "Try again" }) !== null).toBe(status !== 501);
  if (row === "settings") expect(screen.getByText("Task source: Your OpenRouter key.")).toBeTruthy();
 } finally { f.close(); }
});

it("refreshes source, payer, offered models and effective steps after a verified source-order save without submitting a draft", async () => {
 let revision = 1;
 const f = mount({ respond: r => {
  if (r.path === "/v1/app/org/model-sources-order") { revision = 2; return { status: 200, body: { revision, order: ["rovara", "openrouter_key"] } }; }
  if (r.path === "/v1/app/org/model-sources") return { status: 200, body: { orgId, developerId, revision, order: revision === 1 ? ["openrouter_key", "rovara"] : ["rovara", "openrouter_key"], sources: ["openrouter_key", "rovara"].map(source => ({ source, available: true, connected: true, inOrder: true })) } };
  if (r.path === "/v1/app/org/agent-ai") return { status: 200, body: { version: revision, source: revision === 1 ? "openrouter_key" : "rovara", choices: ["openrouter_key", "rovara"].map(source => ({ source, available: true })) } };
  if (r.path === "/v1/app/org/engine-model" && revision === 2) return { status: 200, body: { model: SONNET, source: "company", offered: [SONNET], preselect: SONNET, canChange: true } };
  return undefined;
 } });
 try {
  await ready(); expect(screen.getByText(/Task source: Your OpenRouter key/)).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Company model"), { target: { value: HAIKU } });
  fireEvent.click(screen.getByRole("button", { name: "Change source order" }));
  fireEvent.click(await screen.findByRole("button", { name: "Move up, Rovara's AI" }));
  fireEvent.click(screen.getByRole("button", { name: "Review order" }));
  fireEvent.click(await screen.findByRole("button", { name: "Confirm source order" }));
  await screen.findByText("Source order verified."); fireEvent.click(screen.getByRole("button", { name: "Close" }));
  await screen.findByText(/Task source: Rovara's AI/);
  expect(screen.getByTestId("ai-spend-rovara").querySelector("input")).toHaveProperty("checked", true);
  expect(screen.getByLabelText("Company model")).toHaveProperty("value", SONNET);
  expect(within(screen.getByLabelText("Company model")).queryByRole("option", { name: HAIKU })).toBeNull();
  expect(f.request.mock.calls.filter(([r]) => r.path === "/v1/app/org/agent-models").length).toBeGreaterThan(1);
  expect(f.request.mock.calls.filter(([r]) => r.method !== "GET").map(([r]) => r.path)).toEqual(["/v1/app/org/model-sources-order"]);
 } finally { f.close(); }
});

for (const state of ["unavailable", "install", "unusable-source", "pending-save", "pending-cap", "gateway-unready", "task-unready", "ready"] as const) it(`setup checks persisted required AI state: ${state}, with optional rows unavailable`, async () => {
 const f = mount({ path: "/app/onboard?step=ai", ...(state === "pending-cap" ? { respond: (r: ApiRequest) => r.path === "/v1/app/org/settings" && r.method === "PUT" ? { status: 200, body: { pending: { approvalId: "pending-limit" } } } : undefined } : {}), overrides: { "/v1/app/org/learning-model": unavailable, ...(state === "unavailable" ? { "/v1/app/org/engine-model": unavailable } : {}) } });
 const taskBody = f.bodies["/v1/app/org/agent-models"] as { steps: Array<{ refused: boolean }> };
 if (state !== "task-unready") taskBody.steps.forEach(step => { step.refused = false; });
 if (state === "gateway-unready") f.bodies["/v1/app/org/settings"] = { version: 1, modelGateway: { ready: false, reason: "blocked" }, settings: { budgets: { companyMonthlyUsdMicros: 500_000_000 } } };
 if (state === "install" || state === "pending-save") f.bodies["/v1/app/org/engine-model"] = { model: null, source: "install", offered: [SONNET], preselect: SONNET, canChange: true };
 if (state === "unusable-source") f.bodies["/v1/app/org/agent-ai"] = { version: 1, source: "openrouter_key", choices: [] };
 try {
  await screen.findByTestId("learning-model-read-error");
  const next = await screen.findByTestId("onboard-continue-repos");
  if (state === "pending-cap") fireEvent.change(await screen.findByLabelText(/Company monthly limit/u), { target: { value: "600" } });
  await waitFor(() => expect(next).toHaveProperty("disabled", state !== "ready"));
  if (state === "pending-save" || state === "pending-cap") {
   fireEvent.click(within(screen.getByTestId("ai-spend-step")).getAllByRole("button", { name: "Save" }).at(-1)!); await screen.findByTestId("ai-spend-saved");
   // A nominal write response whose follow-up read still has no company model cannot advance.
   await waitFor(() => expect(within(screen.getByTestId("ai-spend-step")).getAllByRole("button", { name: "Save" }).at(-1)!).toHaveProperty("disabled", false));
   expect(f.request.mock.calls.some(([r]) => r.method === "PUT" && r.path.endsWith(state === "pending-cap" ? "settings" : "engine-model"))).toBe(true);
  }
  fireEvent.click(next);
  await waitFor(() => expect(f.router.state.location.search).toBe(state === "ready" ? "?step=repositories" : "?step=ai"));
 } finally { f.close(); }
});

it("disables setup Continue for required unsaved edits until a save is confirmed by reads", async () => {
 let saved = false;
 const f = mount({ path: "/app/onboard?step=ai", respond: r => {
  if (r.path === "/v1/app/org/engine-model" && r.method === "PUT") { saved = true; return { status: 200, body: { model: HAIKU, source: "company", offered: [SONNET, HAIKU], preselect: HAIKU, canChange: true } }; }
  if (r.path === "/v1/app/org/engine-model" && saved) return { status: 200, body: { model: HAIKU, source: "company", offered: [SONNET, HAIKU], preselect: HAIKU, canChange: true } };
  return undefined;
 } });
 (f.bodies["/v1/app/org/agent-models"] as { steps: Array<{ refused: boolean }> }).steps.forEach(step => { step.refused = false; });
 try {
  await ready(); fireEvent.change(screen.getByLabelText("Company model"), { target: { value: HAIKU } });
  expect(screen.getByTestId("onboard-continue-repos")).toHaveProperty("disabled", true);
  fireEvent.click(within(screen.getByTestId("ai-spend-step")).getAllByRole("button", { name: "Save" }).at(-1)!);
  await waitFor(() => expect(f.router.state.location.search).toBe("?step=repositories"));
 } finally { f.close(); }
});

it("takes a real member from the project's model link to the read-only company section", async () => {
 const { projectFixture } = await import("./support/project-fixture.js");
 const { howWeWorkView } = await import("./support/how-we-work-view.js");
 const f = mount({ role: "member", path: "/app/projects/payments?tab=how-we-work", respond: r => {
  if (r.path === "/v1/app/projects/payments/overview") return { status: 200, body: projectFixture({ you: { role: "viewer", canStartWork: false, canEditSettings: false, canViewSpend: false } }) };
  if (r.path === "/v1/app/projects/payments/how-we-work") return { status: 200, body: howWeWorkView() };
  return undefined;
 } });
 try {
  fireEvent.click(await screen.findByRole("link", { name: "AI models for each step" }));
  await ready(); expect(f.router.state.location).toMatchObject({ pathname: "/app/admin/ai-spending", hash: "#ai-models" });
  await waitFor(() => expect(document.activeElement).toBe(document.getElementById("ai-models")));
  expect(screen.queryByRole("combobox")).toBeNull();
  expect(f.request.mock.calls.filter(([r]) => r.path.startsWith("/v1/app/org/")).map(([r]) => r.path).sort()).toEqual(["/v1/app/org/agent-models", "/v1/app/org/engine-model", "/v1/app/org/learning-model"]);
 } finally { f.close(); }
});
