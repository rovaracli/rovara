// @vitest-environment jsdom
// L4-JA7: "Knowledge stays in Rovara" on Company settings (owners and admins) and "Local coding tools can fetch lessons" on Project settings. Each reads Code's answer through Cloud, sets the ONE choice as the body and
// nothing else, says only fixed words, and draws nothing while Code serves no such route or the setting cannot be read. The switch on Company settings carries the one fixed sentence the knowledge tools say.
import { describe, expect, it } from "vitest";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { createMemoryRouter, MemoryRouter, RouterProvider } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { AppNavSchema, AppMeResponseSchema } from "@agentx/contracts/web";
import { appRoutes } from "../../packages/ui/src/routes.js";
import { AppHostProvider, type ApiRequest, type ApiResponse } from "../../packages/ui/src/host.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { KNOWLEDGE_STAYS_PATH, localToolsPath, readKnowledgeStays, readLocalTools } from "../../packages/ui/src/api/knowledge-switch.js";
import { KNOWLEDGE_STAYS_WORDS } from "../../packages/ui/src/screens/admin/settings/KnowledgeStays.js";
import { LocalToolsSetting, LOCAL_TOOLS_WORDS } from "../../packages/ui/src/screens/project/LocalToolsSetting.js";
import { ThemeProvider } from "../../packages/ui/src/theme.js";
import { fakeHost } from "./support/fake-host.js";
import { renderUi } from "./support/render.js";
import { h } from "./support/h.js";
import { expectNoAxeViolations } from "./support/axe.js";

const me = "a".repeat(64);
const features = { localAgents: false, admin: true, usage: false, chains: false, describe: false, notices: false };
const NOT_ON_CODE = { status: 501, body: { error: { code: "NOT_ON_CODE_YET", message: "not connected" } } };
const ok = (body: unknown): ApiResponse => ({ status: 200, body });
const view = (over: Record<string, unknown> = {}) => ({ enabled: true, preset: "standard", companyStays: false, canChange: true, ...over });
const PATH = localToolsPath("payments");

describe("the readers", () => {
 it("read exactly the contract and drop anything else", () => {
  expect(readKnowledgeStays({ stays: true, token: "x" })).toEqual({ stays: true });
  for (const bad of [{}, { stays: "yes" }, [], "x", null]) expect(() => readKnowledgeStays(bad)).toThrow();
  expect(readLocalTools({ ...view({ own: false, reason: "project_setting" }), secret: "x" })).toEqual({ enabled: true, own: false, reason: "project_setting", preset: "standard", companyStays: false, canChange: true });
  expect(readLocalTools({ ...view({ reason: "something_new" }) })).not.toHaveProperty("reason");
  for (const bad of [{}, view({ enabled: "yes" }), view({ preset: "other" }), { enabled: true, preset: "standard", companyStays: false }, view({ own: "x" }), []]) expect(() => readLocalTools(bad)).toThrow();
 });
});

function mountCompany(role: "owner" | "admin", respond: (r: ApiRequest) => ApiResponse | Promise<ApiResponse>) {
 const nav = AppNavSchema.parse({ me: { developerId: me, name: "Priya", orgRole: role }, org: { name: "Acme" }, homeCount: 0, projects: [], shared: { agents: [], sessions: [] }, features });
 const identity = AppMeResponseSchema.parse({ developer: { id: me, name: "Priya", orgRole: role }, org: { orgId: "org_aaaaaaaaaaaaaaaaaaaa", name: "Acme", plan: "team" }, identities: [] });
 const f = fakeHost(async r => (r.path === "/v1/app/nav" ? ok(nav) : r.path === "/v1/app/me" ? ok(identity) : r.path === KNOWLEDGE_STAYS_PATH ? respond(r) : r.path === "/v1/app/org/settings" ? { status: 404, body: { error: { code: "NOT_FOUND", message: "route not found" } } } : ok({})));
 const query = createQueryClient(); query.setQueryData(["nav"], nav); f.storage.set("rovara.theme", "light");
 const router = createMemoryRouter(appRoutes(nav.features), { initialEntries: ["/app/admin/settings"] });
 const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(ThemeProvider, { host: f.host, children: h(RouterProvider, { router }) }) }) }));
 return { ...f, ...ui, close: () => { ui.unmount(); router.dispose(); query.clear(); cleanup(); } };
}
const writes = (f: { request: { mock: { calls: Array<[ApiRequest]> } } }) => f.request.mock.calls.map(([r]) => r).filter(r => r.method !== "GET");

describe("Knowledge stays in Rovara on Company settings", () => {
 it("shows the company's switch off with what it means, and on with the one fixed sentence", async () => {
  const off = mountCompany("owner", () => ok({ stays: false }));
  try {
   const s = within(await screen.findByTestId("knowledge-stays"));
   expect(s.getByRole("switch", { name: KNOWLEDGE_STAYS_WORDS.LABEL }).getAttribute("aria-checked")).toBe("false");
   expect(s.getByText(KNOWLEDGE_STAYS_WORDS.OPEN)).toBeTruthy();
   expect(s.queryByText(KNOWLEDGE_STAYS_WORDS.STAYS)).toBeNull();
   await expectNoAxeViolations(off.container);
  } finally { off.close(); }
  const on = mountCompany("admin", () => ok({ stays: true }));
  try {
   const s = within(await screen.findByTestId("knowledge-stays"));
   expect(s.getByRole("switch", { name: KNOWLEDGE_STAYS_WORDS.LABEL }).getAttribute("aria-checked")).toBe("true");
   expect(s.getByText("Your company keeps team knowledge inside Rovara.")).toBeTruthy();
  } finally { on.close(); }
 });

 it("sets it with the one choice as the body and nothing else, and says the fixed word for what was saved", async () => {
  let stored = false;
  const f = mountCompany("owner", r => (r.method === "PUT" ? (stored = (r.body as { stays: boolean }).stays, ok({ stays: stored })) : ok({ stays: stored })));
  try {
   const s = within(await screen.findByTestId("knowledge-stays"));
   fireEvent.click(s.getByRole("switch", { name: KNOWLEDGE_STAYS_WORDS.LABEL }));
   await waitFor(() => expect(s.getByRole("status").textContent).toBe(KNOWLEDGE_STAYS_WORDS.ON));
   expect(writes(f)).toEqual([expect.objectContaining({ method: "PUT", path: KNOWLEDGE_STAYS_PATH, body: { stays: true } })]);
   await waitFor(() => expect(s.getByRole("switch", { name: KNOWLEDGE_STAYS_WORDS.LABEL }).getAttribute("aria-checked")).toBe("true"));
   fireEvent.click(s.getByRole("switch", { name: KNOWLEDGE_STAYS_WORDS.LABEL }));
   await waitFor(() => expect(s.getByRole("status").textContent).toBe(KNOWLEDGE_STAYS_WORDS.OFF));
   expect(writes(f).at(-1)).toMatchObject({ body: { stays: false } });
  } finally { f.close(); }
 });

 it("says a fixed sentence when saving fails, never the server's words", async () => {
  const f = mountCompany("owner", r => (r.method === "PUT" ? { status: 403, body: { error: { code: "FORBIDDEN", message: "SECRET words" } } } : ok({ stays: false })));
  try {
   const s = within(await screen.findByTestId("knowledge-stays"));
   fireEvent.click(s.getByRole("switch", { name: KNOWLEDGE_STAYS_WORDS.LABEL }));
   await waitFor(() => expect(s.getByRole("alert").textContent).toBe(KNOWLEDGE_STAYS_WORDS.SAVE_FAILED));
   expect(s.getByRole("switch", { name: KNOWLEDGE_STAYS_WORDS.LABEL }).getAttribute("aria-checked")).toBe("false");
  } finally { f.close(); }
 });

 it("is not drawn while Code serves no such route, the answer is not the contract, or Code is down; the rest of the page is", async () => {
  for (const answer of [NOT_ON_CODE, ok({ nope: 1 }), ok({ stays: "yes" }), { status: 503, body: { error: { code: "RUNTIME_UNAVAILABLE", message: "x" } } }]) {
   const f = mountCompany("owner", () => answer);
   try {
    await screen.findByRole("heading", { name: "Company settings" });
    await waitFor(() => expect(f.request.mock.calls.some(([r]) => r.path === KNOWLEDGE_STAYS_PATH)).toBe(true));
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(screen.queryByTestId("knowledge-stays")).toBeNull();
    expect(screen.getByTestId("company-upkeep")).toBeTruthy();
   } finally { f.close(); }
  }
 });
});

function mountProject(respond: (r: ApiRequest) => ApiResponse | Promise<ApiResponse>, project = "payments") {
 const f = fakeHost(async r => (r.path === localToolsPath(project) ? respond(r) : { status: 404, body: { error: { code: "NOT_FOUND", message: "nope" } } }));
 const query = createQueryClient();
 const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(MemoryRouter, { children: h(LocalToolsSetting, { project }) }) }) }), { theme: "light" });
 return { ...f, ...ui, close: () => { ui.unmount(); query.clear(); cleanup(); } };
}
const sw = () => screen.getByRole("switch", { name: LOCAL_TOOLS_WORDS.LABEL });

describe("Local coding tools can fetch lessons on Project settings", () => {
 it("is on until the project chooses otherwise; a project admin sets it with one choice and gets a fixed word", async () => {
  let own: boolean | undefined;
  const f = mountProject(r => (r.method === "PUT" ? (own = (r.body as { enabled: boolean }).enabled, ok(view({ enabled: own, own }))) : ok(view(own === undefined ? {} : { enabled: own, own }))));
  try {
   const s = within(await screen.findByTestId("local-tools-setting"));
   expect(sw().getAttribute("aria-checked")).toBe("true");
   expect(s.getByText(LOCAL_TOOLS_WORDS.HELP)).toBeTruthy();
   fireEvent.click(sw());
   await waitFor(() => expect(s.getByRole("status").textContent).toBe(LOCAL_TOOLS_WORDS.OFF));
   expect(writes(f)).toEqual([expect.objectContaining({ method: "PUT", path: PATH, body: { enabled: false } })]);
   await waitFor(() => expect(sw().getAttribute("aria-checked")).toBe("false"));
   fireEvent.click(sw());
   await waitFor(() => expect(s.getByRole("status").textContent).toBe(LOCAL_TOOLS_WORDS.ON));
   expect(writes(f).at(-1)).toMatchObject({ body: { enabled: true } });
  } finally { f.close(); }
 });

 it("says the saved choice is held shut, not that coding tools can fetch lessons, while the company keeps knowledge in Rovara", async () => {
  const f = mountProject(r => (r.method === "PUT" ? ok(view({ enabled: false, own: true, reason: "company_stays", companyStays: true })) : ok(view({ enabled: false, own: false, reason: "project_setting" }))));
  try {
   const s = within(await screen.findByTestId("local-tools-setting"));
   fireEvent.click(sw());
   await waitFor(() => expect(s.getByRole("status").textContent).toBe(LOCAL_TOOLS_WORDS.HELD));
   expect(s.getByRole("status").textContent).not.toContain("can fetch");
  } finally { f.close(); }
 });

 it("says why when the company or the preset keeps knowledge in Rovara, and keeps the project's own choice underneath", async () => {
  const company = mountProject(() => ok(view({ enabled: false, own: true, reason: "company_stays", companyStays: true })));
  try {
   await screen.findByTestId("local-tools-setting");
   expect(screen.getByTestId("local-tools-why").textContent).toBe(LOCAL_TOOLS_WORDS.WHY_COMPANY);
   expect(sw().getAttribute("aria-checked")).toBe("true");
  } finally { company.close(); }
  const regulated = mountProject(() => ok(view({ enabled: false, reason: "regulated", preset: "regulated" })));
  try {
   await screen.findByTestId("local-tools-setting");
   expect(screen.getByTestId("local-tools-why").textContent).toBe(LOCAL_TOOLS_WORDS.WHY_REGULATED);
  } finally { regulated.close(); }
 });

 it("a person who cannot change it sees the switch disabled with the fixed sentence, and sends nothing", async () => {
  const f = mountProject(() => ok(view({ canChange: false })));
  try {
   await screen.findByTestId("local-tools-setting");
   expect(sw().hasAttribute("disabled")).toBe(true);
   expect(screen.getByText(LOCAL_TOOLS_WORDS.ONLY_ADMINS)).toBeTruthy();
   fireEvent.click(sw());
   await new Promise(resolve => setTimeout(resolve, 30));
   expect(writes(f)).toEqual([]);
   await expectNoAxeViolations(f.container);
  } finally { f.close(); }
 });

 it("says a fixed sentence when saving fails, never the server's words", async () => {
  const f = mountProject(r => (r.method === "PUT" ? { status: 503, body: { error: { code: "AUDIT_UNAVAILABLE", message: "SECRET ledger" } } } : ok(view())));
  try {
   const s = within(await screen.findByTestId("local-tools-setting"));
   fireEvent.click(sw());
   await waitFor(() => expect(s.getByRole("alert").textContent).toBe(LOCAL_TOOLS_WORDS.SAVE_FAILED));
   expect(document.body.textContent).not.toContain("SECRET");
  } finally { f.close(); }
 });

 it("is not drawn while Code serves no such route, the answer is not the contract, or Code is down", async () => {
  for (const answer of [NOT_ON_CODE, ok({ nope: 1 }), ok(view({ preset: "weird" })), { status: 503, body: { error: { code: "RUNTIME_UNAVAILABLE", message: "x" } } }]) {
   const f = mountProject(() => answer);
   try {
    await waitFor(() => expect(f.request.mock.calls.some(([r]) => r.path === PATH)).toBe(true));
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(screen.queryByTestId("local-tools-setting")).toBeNull();
   } finally { f.close(); }
  }
 });

 it("reads the project it is given: the path carries the project name and nothing else", async () => {
  const f = mountProject(() => ok(view()), "ledger-2");
  try {
   await screen.findByTestId("local-tools-setting");
   expect(f.request.mock.calls.map(([r]) => `${r.method} ${r.path}`)).toEqual(["GET /v1/app/projects/ledger-2/lessons/local-tools"]);
  } finally { f.close(); }
 });
});
