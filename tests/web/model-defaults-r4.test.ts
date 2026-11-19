// @vitest-environment jsdom
import { expect, it } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { AppHostProvider, type ApiRequest, type ApiResponse } from "../../packages/ui/src/host.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { AiSpendStep } from "../../packages/ui/src/screens/setup/AiSpendStep.js";
import { STEP_GROUPS } from "../../packages/ui/src/api/agent-models.js";
import { fakeHost } from "./support/fake-host.js";
import { renderUi } from "./support/render.js";
import { h } from "./support/h.js";

const A = "claude-sonnet-5-5", B = "claude-haiku-5-5";
const back = "Go back to Rovara's default";
const org = "org_aaaaaaaaaaaaaaaaaaaa", person = "a".repeat(64);
const stages = ["understand", "plan", "plan_check", "build", "code_review", "security_review", "pull_request"];
function mount(respond?: (r: ApiRequest) => ApiResponse | Promise<ApiResponse> | undefined) {
 const state = { company: null as string | null, learning: null as string | null, effective: A, revision: 1, steps: {} as Record<string, string>, cap: 500_000_000 };
 const f = fakeHost(async r => {
  const custom = respond?.(r); if (custom !== undefined) return custom;
  if (r.path === "/v1/app/org/engine-model" || r.path === "/v1/app/org/learning-model") {
   const key = r.path.endsWith("engine-model") ? "company" : "learning";
   if (r.method === "PUT") state[key] = (r.body as { model: string | null }).model;
   return { status: 200, body: { model: state[key] ?? state.effective, source: state[key] === null ? "install" : "company", offered: [A, B], preselect: state[key] ?? A, canChange: true } };
  }
  if (r.path === "/v1/app/org/agent-models") {
   if (r.method === "POST") {
    const body = r.body as { stage: string; action: string; model: string };
    for (const stage of body.stage === "plan" ? ["understand", "plan"] : body.stage === "code_review" ? ["code_review", "security_review"] : [body.stage]) {
     if (body.action === "clear") delete state.steps[stage]; else state.steps[stage] = body.model;
    }
    state.revision++;
   }
   return { status: 200, body: { revision: state.revision, offered: [A, B], canChange: true, steps: stages.map(stage => ({ stage, setting: state.steps[stage] ?? null, refused: false, effective: { model: state.steps[stage] ?? state.effective, companyDefault: state.steps[stage] === undefined } })) } };
  }
  if (r.path === "/v1/app/org/agent-ai") return { status: 200, body: { version: 1, source: "rovara", choices: [{ source: "rovara", available: true }] } };
  if (r.path === "/v1/app/org/settings") {
   if (r.method === "PUT") state.cap = (r.body as { settings: { budgets: { companyMonthlyUsdMicros: number } } }).settings.budgets.companyMonthlyUsdMicros;
   return { status: 200, body: { version: state.cap, modelGateway: { ready: true }, settings: { budgets: { companyMonthlyUsdMicros: state.cap } } } };
  }
  return { status: 501, body: { error: { code: "NOT_ON_CODE_YET", message: "Not available yet." } } };
 });
 const query = createQueryClient();
 const router = createMemoryRouter([{ path: "*", element: h("div") }], { initialEntries: ["/app/setup"] });
 const draw = () => h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(RouterProvider, { router }) }) });
 // Keep the component mounted across scope changes, as an embedding host can do.
 const element = (company = org, developerId = person, role: "owner" | "member" = "owner") => h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(AiSpendStep, { orgId: company, developerId, role }) }) });
 // AiSpendStep uses the router location; swap the route's element for scope changes.
 router.routes[0]!.element = element();
 const ui = renderUi(draw());
 return { ...f, state, query, async scope(company: string, developerId: string, role: "owner" | "member") { router.routes[0]!.element = element(company, developerId, role); await act(async () => { await router.navigate("/app/setup?scope=" + company + developerId + role); }); }, close() { ui.unmount(); router.dispose(); query.clear(); } };
}
async function ready() { await screen.findByTestId("learning-model-current"); await screen.findByLabelText("Company model"); }
function companyRow() { return screen.getByRole("region", { name: "Company model setting" }); }
function companySave() { return within(screen.getByTestId("ai-spend-step")).getAllByRole("button", { name: "Save" }).at(-1)!; }
function writes(f: ReturnType<typeof mount>) { return f.request.mock.calls.map(([r]) => r).filter(r => r.method !== "GET"); }

it("company default: spending-only Save never pins the untouched preselect", async () => {
 const f = mount(); try {
  await ready(); expect(companyRow().textContent).toContain(`Rovara's default (currently ${A})`);
  fireEvent.change(screen.getByLabelText(/Company monthly limit/u), { target: { value: "600" } });
  fireEvent.click(companySave()); await screen.findByTestId("ai-spend-saved");
  await waitFor(() => expect(companySave()).toHaveProperty("disabled", false));
  expect(writes(f).map(r => r.path)).toEqual(["/v1/app/org/settings"]);
 } finally { f.close(); }
});

it("company pin is explicit, including the model currently used by default, and clears on the current endpoint", async () => {
 const f = mount(); try {
  await ready(); fireEvent.change(screen.getByLabelText("Company model"), { target: { value: A } });
  fireEvent.click(companySave()); await waitFor(() => expect(companyRow().textContent).toContain(`Your choice: ${A}`));
  fireEvent.click(within(companyRow()).getByRole("button", { name: back }));
  await waitFor(() => expect(companyRow().textContent).toContain(`Rovara's default (currently ${A})`));
  expect(writes(f).map(r => [r.path, r.body])).toEqual([["/v1/app/org/engine-model", { model: A }], ["/v1/app/org/engine-model", { model: null }]]);
 } finally { f.close(); }
});

for (const group of STEP_GROUPS) it(`${group.label}: follows the actual effective default, pins only an explicit edit and clears only that row`, async () => {
 const f = mount(); try {
  await ready(); const row = screen.getByTestId(`step-model-${group.stage}`);
  expect(row.textContent).toContain(`Rovara's default (currently ${A})`);
  fireEvent.click(companySave()); await screen.findByTestId("ai-spend-saved");
  expect(writes(f)).toEqual([]);
  fireEvent.change(within(row).getByRole("combobox"), { target: { value: B } });
  await waitFor(() => expect(row.textContent).toContain(`Your choice: ${B}`));
  fireEvent.click(within(row).getByRole("button", { name: back }));
  await waitFor(() => expect(row.textContent).toContain(`Rovara's default (currently ${A})`));
  expect(writes(f).map(r => r.body)).toEqual([{ action: "set", stage: group.stage, model: B, expectedRevision: 1 }, { action: "clear", stage: group.stage, expectedRevision: 2 }]);
 } finally { f.close(); }
});

it("learning default: untouched Save is disabled; an explicit pin can be cleared", async () => {
 const f = mount(); try {
  await ready(); const row = screen.getByTestId("learning-model-card");
  expect(row.textContent).toContain(`Rovara's default (currently Claude Sonnet 5.5)`);
  const save = within(row).getByRole("button", { name: "Save" });
  expect(save).toHaveProperty("disabled", true); fireEvent.click(save); expect(writes(f)).toEqual([]);
  fireEvent.change(within(row).getByRole("combobox"), { target: { value: A } });
  fireEvent.click(save); await waitFor(() => expect(row.textContent).toContain("Your choice: Claude Sonnet 5.5"));
  fireEvent.click(within(row).getByRole("button", { name: back }));
  await waitFor(() => expect(row.textContent).toContain("Rovara's default (currently Claude Sonnet 5.5)"));
  expect(writes(f).map(r => [r.path, r.body])).toEqual([["/v1/app/org/learning-model", { model: A }], ["/v1/app/org/learning-model", { model: null }]]);
 } finally { f.close(); }
});

for (const label of ["Design review model", "Second review", "Answers and Slack chat"]) it(`${label}: unknown managed default stays unavailable and Save never writes it`, async () => {
 const f = mount(); try {
  await ready(); const row = screen.getByRole("region", { name: label });
  expect(row.textContent).toContain("Rovara's default (current model can't be shown yet)");
  expect(row.textContent).toContain("unavailable");
  expect(within(row).queryByRole("combobox")).toBeNull(); expect(within(row).queryByRole("button")).toBeNull();
  fireEvent.click(companySave()); await screen.findByTestId("ai-spend-saved"); expect(writes(f)).toEqual([]);
 } finally { f.close(); }
});

it("effective-default refetches cannot turn preselects into changes", async () => {
 const f = mount(); try {
  await ready(); f.state.effective = B;
  await act(async () => { await f.query.invalidateQueries({ queryKey: ["ai-spend", org, person, "owner"] }); });
  fireEvent.click(companySave()); await screen.findByTestId("ai-spend-saved");
  expect(writes(f)).toEqual([]);
  expect(within(screen.getByTestId("learning-model-card")).getByRole("button", { name: "Save" })).toHaveProperty("disabled", true);
 } finally { f.close(); }
});

it("unknown company and step defaults never use the offered preselect as evidence", async () => {
 const f = mount(r => r.path === "/v1/app/org/engine-model" ? { status: 200, body: { model: null, source: "install", offered: [A], preselect: A, canChange: true } } : r.path === "/v1/app/org/agent-models" ? { status: 200, body: { revision: 1, offered: [A], canChange: true, steps: stages.map(stage => ({ stage, setting: null, refused: true, effective: null })) } } : undefined);
 try {
  await ready();
  for (const row of [companyRow(), ...STEP_GROUPS.map(group => screen.getByTestId(`step-model-${group.stage}`))]) expect(row.textContent).toContain("Rovara's default (current model can't be shown yet)");
 } finally { f.close(); }
});

for (const [company, developerId, role] of [["org_bbbbbbbbbbbbbbbbbbbb", person, "owner"], [org, "b".repeat(64), "owner"], [org, person, "member"]] as const) it(`drops drafts and old query work when scope changes to ${company}/${developerId}/${role}`, async () => {
 const f = mount(); try {
  await ready(); fireEvent.change(screen.getByLabelText("Company model"), { target: { value: B } });
  fireEvent.change(screen.getByLabelText("Learning model"), { target: { value: B } });
  await f.scope(company, developerId, role);
  if (role === "owner") {
   await ready(); fireEvent.click(companySave()); await screen.findByTestId("ai-spend-saved"); expect(writes(f)).toEqual([]);
  } else { await screen.findByTestId("ai-spend-read-only"); expect(screen.queryByRole("combobox")).toBeNull(); }
  expect(f.query.getQueriesData({ queryKey: ["ai-spend", org, person, "owner"] })).toEqual([]);
  expect(f.query.getQueriesData({ queryKey: ["step-models", org, person, "owner"] })).toEqual([]);
  await f.scope("org_bbbbbbbbbbbbbbbbbbbb", "b".repeat(64), "member");
  await screen.findByTestId("ai-spend-read-only"); expect(screen.queryByRole("combobox")).toBeNull();
  expect(screen.queryByLabelText(/Company monthly limit/u)).toBeNull();
 } finally { f.close(); }
});

it("a scope change while saving stops the remaining writes and old notices/refetches", async () => {
 let finish: ((r: ApiResponse) => void) | undefined;
 const f = mount(r => r.path === "/v1/app/org/settings" && r.method === "PUT" ? new Promise(resolve => { finish = resolve; }) : undefined);
 try {
  await ready(); fireEvent.change(screen.getByLabelText("Company model"), { target: { value: B } });
  fireEvent.change(screen.getByLabelText(/Company monthly limit/u), { target: { value: "600" } }); fireEvent.click(companySave());
  await waitFor(() => expect(finish).toBeDefined());
  await f.scope("org_bbbbbbbbbbbbbbbbbbbb", person, "owner"); await ready();
  const before = f.request.mock.calls.length;
  await act(async () => { finish!({ status: 200, body: {} }); });
  expect(writes(f).map(r => r.path)).toEqual(["/v1/app/org/settings"]);
  expect(f.request.mock.calls).toHaveLength(before); expect(screen.queryByTestId("ai-spend-saved")).toBeNull();
 } finally { f.close(); }
});

it("cancels a pending old-company model read without caching or applying its late reply", async () => {
 let finish: ((r: ApiResponse) => void) | undefined, held = false;
 const f = mount(r => {
  if (r.path !== "/v1/app/org/engine-model") return undefined;
  if (!held) { held = true; return new Promise(resolve => { finish = resolve; }); }
  return { status: 200, body: { model: B, source: "install", offered: [A, B], preselect: B, canChange: true } };
 });
 try {
  await waitFor(() => expect(finish).toBeDefined());
  await f.scope("org_bbbbbbbbbbbbbbbbbbbb", person, "owner"); await ready();
  await act(async () => { finish!({ status: 200, body: { model: "retired", source: "company", offered: [A], preselect: A, canChange: true } }); });
  expect(companyRow().textContent).toContain(`Rovara's default (currently ${B})`);
  expect(companyRow().textContent).not.toContain("retired");
  expect(f.query.getQueriesData({ queryKey: ["ai-spend", org, person, "owner"] })).toEqual([]);
  fireEvent.click(companySave()); await screen.findByTestId("ai-spend-saved"); expect(writes(f)).toEqual([]);
 } finally { f.close(); }
});

for (const [path, label, saved] of [["/v1/app/org/learning-model", "Learning model", "learning-model-saved"], ["/v1/app/org/agent-models", "Coding", "step-models-saved"]] as const) it(`drops the late ${label} save receipt after a scope change`, async () => {
 let finish: ((r: ApiResponse) => void) | undefined;
 const f = mount(r => r.path === path && r.method !== "GET" ? new Promise(resolve => { finish = resolve; }) : undefined);
 try {
  await ready(); fireEvent.change(screen.getByLabelText(label), { target: { value: B } });
  if (label === "Learning model") fireEvent.click(within(screen.getByTestId("learning-model-card")).getByRole("button", { name: "Save" }));
  await waitFor(() => expect(finish).toBeDefined());
  await f.scope("org_bbbbbbbbbbbbbbbbbbbb", person, "owner"); await ready();
  const before = f.request.mock.calls.length;
  await act(async () => { finish!({ status: 200, body: { model: B, source: "company", offered: [A, B], preselect: B, canChange: true } }); });
  expect(screen.queryByTestId(saved)).toBeNull(); expect(f.request.mock.calls).toHaveLength(before);
 } finally { f.close(); }
});

it("captures an explicit learning draft once even if the effective default changes on refetch", async () => {
 const f = mount(); try {
  await ready(); fireEvent.change(screen.getByLabelText("Learning model"), { target: { value: B } });
  f.state.effective = B;
  await act(async () => { await f.query.invalidateQueries({ queryKey: ["ai-spend", org, person, "owner", "learning-model"] }); });
  expect(screen.getByLabelText("Learning model")).toHaveProperty("value", B);
  fireEvent.click(within(screen.getByTestId("learning-model-card")).getByRole("button", { name: "Save" }));
  await screen.findByTestId("learning-model-saved");
  expect(writes(f).map(r => r.body)).toEqual([{ model: B }]);
 } finally { f.close(); }
});
