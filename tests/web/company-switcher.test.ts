// @vitest-environment jsdom
import { createElement, useMemo } from "react";
import { describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { AppNavSchema } from "@agentx/cloud-contracts/web";
import { z } from "zod";
import { AppHostProvider, useAppHost, type ApiRequest, type ApiResponse, type AppHost } from "../../packages/ui/src/host.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { createApiClient } from "../../packages/ui/src/api/client.js";
import { ThemeProvider } from "../../packages/ui/src/theme.js";
import { AppShell } from "../../packages/ui/src/shell/AppShell.js";
import { COMPANIES_STORAGE_KEY, isCompanySwitcherOn } from "../../packages/ui/src/company-flags.js";
import { CompaniesAnswerReaderSchema, CompaniesReaderSchema, linkCompany, withoutLinkCompany } from "../../packages/ui/src/api/companies.js";
import { COMPANY_HEADER, reloadIntoActiveCompany, withCompanyHeader } from "../../packages/ui/src/api/company-context.js";
import { NAV_STORAGE_KEY } from "../../packages/ui/src/nav-flags.js";
import { renderUi } from "./support/render.js";
import { expectNoAxeViolations } from "./support/axe.js";
import { fakeHost } from "./support/fake-host.js";
import { h } from "./support/h.js";
const A = "org_" + "a".repeat(20), B = "org_" + "b".repeat(20), C = "org_" + "c".repeat(20);
const features = { localAgents: true, usage: false, admin: false, chains: false, notices: false, describe: false };
const MACHINE = "This sign-in is bound to one company. Sign in again to use another.";
const REMOVED = "You were removed from this company, so you can't switch to it.";
type Role = "owner" | "admin" | "member" | "auditor";
const company = (companyId: string, name: string, role: Role, active: boolean) => ({ companyId, name, role, joinedAt: "2026-11-01T10:00:00.000Z", active, status: "open" as const });
const ALL = [{ id: A, name: "Acme", role: "owner" as Role }, { id: B, name: "Beta Ltd", role: "member" as Role }, { id: C, name: "Gamma", role: "auditor" as Role }];
const error = (status: number, code: string, message: string) => ({ status, body: { error: { code, message } } });
/** A small stand-in for the server: one session with one active company, the list, the switch, and a company-specific answer to read. */
function server(options: { companies?: typeof ALL; refuse?: ApiResponse; echo?: (request: ApiRequest) => string | undefined; start?: string } = {}) {
 const companies = options.companies ?? ALL;
 let active = options.start ?? companies[0]!.id;
 const calls: ApiRequest[] = [];
 const list = () => ({ activeCompanyId: active, companies: companies.map(item => company(item.id, item.name, item.role, item.id === active)), limits: { maxCompanies: 20 }, canCreate: false, canJoinByInvite: true });
 const nameOf = (id: string) => companies.find(item => item.id === id)?.name ?? "Unknown";
 const handler = async (request: ApiRequest): Promise<ApiResponse> => {
  calls.push(request);
  if (request.path === "/v1/app/companies") {
   if (request.method === "GET") return { status: 200, body: list() };
   const body = request.body as { action: string; companyId: string };
   if (options.refuse !== undefined) return options.refuse;
   active = body.companyId;
   return { status: 200, body: { status: "done", activeCompanyId: active, companies: list().companies, me: {} } };
  }
  const echo = options.echo?.(request);
  const base = request.path === "/v1/app/nav" ? { status: 200, body: nav(nameOf(active)) } : request.path === "/v1/app/test-data" ? { status: 200, body: { text: nameOf(active) + " data" } } : { status: 200, body: {} };
  return echo === undefined ? base : { ...base, company: echo };
 };
 return { handler, calls, active: () => active };
}
const nav = (orgName: string) => AppNavSchema.parse({ me: { developerId: "a".repeat(64), name: "Priya", orgRole: "member" }, org: { name: orgName }, homeCount: 0, projects: [], shared: { agents: [], sessions: [] }, features });
const answer = z.object({ text: z.string() });
function Data() {
 const host = useAppHost(), api = useMemo(() => createApiClient(host), [host]);
 const read = useQuery({ queryKey: ["data"], queryFn: () => api.get("/v1/app/test-data", answer) });
 return createElement("section", null, createElement("h1", { tabIndex: -1 }, "Home"), createElement("p", { "data-testid": "data" }, read.data?.text ?? (read.isError ? "Couldn't load" : "Loading")));
}
interface Options { on?: boolean; nav2?: boolean; path?: string; query?: QueryClient; server?: ReturnType<typeof server>; seedNav?: string }
function shell(options: Options = {}) {
 const s = options.server ?? server(), f = fakeHost(s.handler), query = options.query ?? createQueryClient();
 f.host.storage.set("rovara.theme", "light");
 if (options.on !== false) f.host.storage.set(COMPANIES_STORAGE_KEY, "v2");
 if (options.nav2 === true) f.host.storage.set(NAV_STORAGE_KEY, "v2");
 const router = createMemoryRouter([{ path: "/app", element: createElement(AppShell), children: [{ index: true, element: createElement(Data) }, { path: "other", element: createElement("h1", { tabIndex: -1 }, "Other page") }] }], { initialEntries: [options.path ?? "/app"] });
 const navigate = vi.fn<(url: string) => void>();f.host.navigate = navigate;connect(f.host);
 const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(ThemeProvider, { host: f.host, children: h(RouterProvider, { router }) }) }) }));
 return { ...ui, ...f, navigate, server: s, query, router, close: () => { ui.unmount();router.dispose();query.clear(); } };
}
/** What the browser host does: the one transport names the page's company while the device switch is on. */
const connect = (host: AppHost) => { host.transport = withCompanyHeader(host.transport, { isOn: () => isCompanySwitcherOn(host), onStale: () => { reloadIntoActiveCompany(host); } }); };
const companyCalls = (calls: ApiRequest[]) => calls.filter(call => call.path === "/v1/app/companies");
describe("the device switch", () => {
 const host = (value?: string) => ({ storage: { get: () => value, set: () => undefined } });
 it("is off unless the device key is exactly v2", () => {
  expect(COMPANIES_STORAGE_KEY).toBe("rovara.companies");
  expect(isCompanySwitcherOn(host())).toBe(false);for (const value of ["", "v1", "V2", "true", "1", "v2 "]) expect(isCompanySwitcherOn(host(value))).toBe(false);
  expect(isCompanySwitcherOn(host("v2"))).toBe(true);
 });
 it("is off when the store throws", () => { expect(isCompanySwitcherOn({ storage: { get: () => { throw new Error("blocked"); }, set: () => undefined } })).toBe(false); });
});
describe("the local schemas", () => {
 it("read the document's shapes, and refuse what it does not allow", () => {
  const listed = { activeCompanyId: A, companies: [company(A, "Acme", "owner", true), { ...company(B, "Beta Ltd", "auditor", false), status: "closing" }], limits: { maxCompanies: 20 }, canCreate: false, canJoinByInvite: true };
  expect(CompaniesReaderSchema.parse(listed).companies).toHaveLength(2);
  expect(() => CompaniesReaderSchema.parse({ ...listed, companies: [company("org_short", "x", "owner", true)] })).toThrow();
  expect(() => CompaniesReaderSchema.parse({ ...listed, companies: [company(A, "x", "boss" as Role, true)] })).toThrow();
  expect(() => CompaniesReaderSchema.parse({ ...listed, companies: Array.from({ length: 21 }, () => company(A, "x", "owner", false)) })).toThrow();
  expect(CompaniesAnswerReaderSchema.parse({ status: "done", activeCompanyId: B, companies: listed.companies, me: { anything: 1 } }).activeCompanyId).toBe(B);
  expect(() => CompaniesAnswerReaderSchema.parse({ status: "pending", activeCompanyId: B, companies: [], me: {} })).toThrow();
 });
 it("read a link's company only when it is a company id", () => {
  expect(linkCompany("?company=" + A)).toBe(A);expect(linkCompany("?x=1&company=" + B)).toBe(B);
  for (const search of ["", "?company=", "?company=acme", "?company=" + A + "x", "?company=ORG_" + "A".repeat(20), "?company=org_" + "a".repeat(19)]) expect(linkCompany(search), search).toBeUndefined();
  expect(withoutLinkCompany("/app/work", "?company=" + A + "&filter=mine", "#top")).toBe("/app/work?filter=mine#top");expect(withoutLinkCompany("/app", "?company=" + A, "")).toBe("/app");
 });
});
describe("switch off", () => {
 it("never calls the companies route, sends no company header, and renders today's header", async () => {
  const f = shell({ on: false });await screen.findByText("Acme data");
  expect(companyCalls(f.server.calls)).toHaveLength(0);
  for (const call of f.server.calls) expect(call.headers?.[COMPANY_HEADER], call.path).toBeUndefined();
  expect(document.querySelector(".rv-shell-org")?.outerHTML).toBe('<span class="rv-shell-org">Acme</span>');
  expect(document.querySelector(".rv-company-button, .rv-company-list, .rv-company-gate")).toBeNull();f.close();
 });
 it("ignores a company in the address, and shows no interstitial", async () => {
  const f = shell({ on: false, path: "/app?company=" + B });await screen.findByText("Acme data");
  expect(screen.queryByText(/This link is for/u)).toBeNull();expect(companyCalls(f.server.calls)).toHaveLength(0);f.close();
 });
 it("leaves the transport's input untouched (the same object, no header added)", async () => {
  const f = fakeHost(async () => ({ status: 200, body: { text: "x" } })), input: ApiRequest = { method: "GET", path: "/v1/app/test-data" };connect(f.host);
  await f.host.transport.request(input);expect(f.request.mock.calls[0]![0]).toBe(input);expect(f.request).toHaveBeenCalledTimes(1);
 });
});
describe("one company", () => {
 it("shows the name exactly as today: same markup, no button, no chevron, no menu", async () => {
  const f = shell({ server: server({ companies: [ALL[0]!] }) });await screen.findByText("Acme data");
  await waitFor(() => expect(companyCalls(f.server.calls).length).toBeGreaterThan(0));
  expect(document.querySelector(".rv-shell-org")?.outerHTML).toBe('<span class="rv-shell-org">Acme</span>');
  expect(screen.queryByRole("button", { name: /switch company/iu })).toBeNull();expect(document.querySelector(".rv-company-chevron")).toBeNull();
  // The page does say which company it is in.
  expect(f.server.calls.find(call => call.path === "/v1/app/test-data")?.headers?.[COMPANY_HEADER]).toBe(A);f.close();
 });
 it("has nothing for the phone's Menu either", async () => {
  const f = shell({ server: server({ companies: [ALL[0]!] }) });await screen.findByText("Acme data");
  await userEvent.setup().click(screen.getByRole("button", { name: "Open workspace menu" }));await screen.findByRole("dialog", { name: "Workspace" });
  expect(screen.queryByRole("heading", { name: "Company" })).toBeNull();f.close();
 });
});
describe("several companies: the header menu", () => {
  it("makes the name a button whose menu lists each company with the person's role in plain words and a check on the current one", async () => {
  const f = shell(), user = userEvent.setup();
  const trigger = await screen.findByRole("button", { name: /Acme.*switch company/iu });
  expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
  await user.click(trigger);
  const menu = await screen.findByRole("menu");
  const items = within(menu).getAllByRole("menuitemradio");
  expect(items.map(item => item.textContent)).toEqual(["Acme" + "Owner" + "✓", "Beta Ltd" + "Member", "Gamma" + "Auditor"]);
  expect(items.map(item => item.getAttribute("aria-checked"))).toEqual(["true", "false", "false"]);
  // Positive control: the check is on the current company only, and moves when the session's company is another one.
  f.close();
  const g = shell({ server: server({ start: B }) });await userEvent.setup().click(await screen.findByRole("button", { name: /Beta Ltd.*switch company/iu }));
  expect(within(await screen.findByRole("menu")).getAllByRole("menuitemradio").map(item => item.getAttribute("aria-checked"))).toEqual(["false", "true", "false"]);g.close();
 });
 it("does not offer to create a company", async () => {
  const f = shell();await userEvent.setup().click(await screen.findByRole("button", { name: /switch company/iu }));await screen.findByRole("menu");
  expect(screen.queryByText(/create|new company/iu)).toBeNull();f.close();
 });
 it("works from the keyboard: Enter opens, arrows move, Escape closes and focus returns to the name", async () => {
  const f = shell(), user = userEvent.setup();
  const trigger = await screen.findByRole("button", { name: /switch company/iu });trigger.focus();
  await user.keyboard("{Enter}");const menu = await screen.findByRole("menu");
  expect(document.activeElement?.textContent).toContain("Acme");
  await user.keyboard("{ArrowDown}");expect(document.activeElement?.textContent).toContain("Beta Ltd");expect(within(menu).getAllByRole("menuitemradio").includes(document.activeElement as HTMLElement)).toBe(true);
  await user.keyboard("{Escape}");await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  expect(document.activeElement).toBe(trigger);f.close();
 });
 it("has no accessibility violations, closed and open, with the old shell and the new navigation", async () => {
  for (const nav2 of [false, true]) {
   const f = shell({ nav2 }), user = userEvent.setup();
   await user.click(await screen.findByRole("button", { name: /switch company/iu }));await screen.findByRole("menu");
   await expectNoAxeViolations(document.body);f.close();
  }
 });
});
describe("switching", () => {
 it("posts the switch action, clears every cache and per-company draft, and reloads into Home", async () => {
  const f = shell(), user = userEvent.setup();
  expect(await screen.findByText("Acme data")).toBeTruthy();
  const draft = "project-slack:v1:" + A + ":" + "a".repeat(64) + ":payments", others = ["allowed-websites:v1:" + A + ":x", "working-branch-save:" + A + ":x"];
  f.storage.set(draft, "{}");for (const key of others) f.storage.set(key, "{}");
  Object.assign(f.host.storage, { keys: () => [...f.storage.keys()], remove: (key: string) => { f.storage.delete(key); } });
  // Positive control: the previous company's data is in the cache now.
  expect(f.query.getQueryData(["data"])).toEqual({ text: "Acme data" });expect(f.query.getQueryCache().getAll().length).toBeGreaterThan(0);
  await user.click(await screen.findByRole("button", { name: /switch company/iu }));
  await user.click(await screen.findByRole("menuitemradio", { name: /Beta Ltd/u }));
  await waitFor(() => expect(f.navigate).toHaveBeenCalledWith("/app"));
  const post = f.server.calls.filter(call => call.method === "POST");expect(post).toHaveLength(1);
  expect(post[0]!.path).toBe("/v1/app/companies");expect(post[0]!.body).toMatchObject({ action: "switch", companyId: B });expect((post[0]!.body as { requestId: string }).requestId).toMatch(/^[0-9a-f-]{36}$/u);
  expect(post[0]!.headers?.[COMPANY_HEADER]).toBe(A);
  expect(f.server.active()).toBe(B);
  expect(f.query.getQueryCache().getAll()).toHaveLength(0);expect(f.query.getQueryData(["data"])).toBeUndefined();expect(f.query.getQueryData(["nav"])).toBeUndefined();
  expect([...f.storage.keys()].filter(key => key.includes(":v1:") || key.startsWith("working-branch-save:"))).toEqual([]);
  // Device preferences are not company data: they stay.
  expect(f.storage.get("rovara.theme")).toBe("light");expect(f.storage.get(COMPANIES_STORAGE_KEY)).toBe("v2");f.close();
 });
 it("does not render the previous company's cached data after a switch", async () => {
  const query = createQueryClient(), first = shell({ query }), user = userEvent.setup();
  expect(await screen.findByText("Acme data")).toBeTruthy();
  const kept = new QueryClient();for (const entry of query.getQueryCache().getAll()) kept.setQueryData(entry.queryKey, entry.state.data);
  await user.click(await screen.findByRole("button", { name: /switch company/iu }));await user.click(await screen.findByRole("menuitemradio", { name: /Gamma/u }));
  await waitFor(() => expect(first.navigate).toHaveBeenCalled());
  // The reload: the old page is gone, but the same client object is handed to the next page (the worst case for a leak).
  first.unmount();first.router.dispose();
  // Positive control: a client that kept its cache shows Acme's data at once, before any answer, so the check below can fail.
  const control = shell({ query: kept, server: server({ start: C }) });
  expect((await screen.findByTestId("data")).textContent).toBe("Acme data");control.close();
  // The next page's own answer is held back, so anything on screen before it comes from the cache.
  let release: () => void = () => undefined;const held = new Promise<void>(resolve => { release = resolve; }), inner = server({ start: C });
  const second = shell({ query, server: { ...inner, handler: async request => { if (request.path === "/v1/app/test-data") await held;return inner.handler(request); } } });
  expect((await screen.findByTestId("data")).textContent).toBe("Loading");expect(screen.queryByText("Acme data")).toBeNull();
  release();expect(await screen.findByText("Gamma data")).toBeTruthy();expect(screen.queryByText("Acme data")).toBeNull();second.close();
 });
 it("does nothing when the current company is chosen again", async () => {
  const f = shell(), user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: /switch company/iu }));await user.click(await screen.findByRole("menuitemradio", { name: /Acme/u }));
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  expect(f.server.calls.filter(call => call.method === "POST")).toHaveLength(0);expect(f.navigate).not.toHaveBeenCalled();f.close();
 });
});
describe("refusals show the server's sentence word for word", () => {
 for (const [name, refusal, sentence] of [["a machine credential", error(403, "FORBIDDEN", MACHINE), MACHINE], ["a company that removed the person", error(403, "REMOVED_FROM_ORG", REMOVED), REMOVED], ["too many switches", error(429, "TOO_MANY_REQUESTS", "Too many switches. Try again in a few minutes."), "Too many switches. Try again in a few minutes."]] as const) {
  it(name + ", in the header menu", async () => {
   const f = shell({ server: server({ refuse: refusal }) }), user = userEvent.setup();
   await screen.findByText("Acme data");
   await user.click(await screen.findByRole("button", { name: /switch company/iu }));await user.click(await screen.findByRole("menuitemradio", { name: /Beta Ltd/u }));
   expect((await screen.findByRole("alert")).textContent).toBe(sentence);
   // Nothing changed: the sentence is in a dialog over the page, no reload, the caches are kept; closing it puts focus back on the company name.
   expect(screen.getByRole("dialog", { name: "Couldn't switch company" })).toBeTruthy();expect(screen.queryByRole("menu")).toBeNull();expect(f.navigate).not.toHaveBeenCalled();
   await user.keyboard("{Escape}");await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());expect(document.activeElement?.textContent).toContain("Acme");expect(f.query.getQueryData(["data"])).toEqual({ text: "Acme data" });f.close();
  });
  it(name + ", in the phone's Menu", async () => {
   const f = shell({ server: server({ refuse: refusal }), nav2: true }), user = userEvent.setup();
   await screen.findByText("Acme data");
   await user.click(screen.getByRole("button", { name: "Open workspace menu" }));
   await user.click(await screen.findByRole("button", { name: /Beta Ltd/u }));
   expect((await screen.findByRole("alert")).textContent).toBe(sentence);expect(f.navigate).not.toHaveBeenCalled();f.close();
  });
 }
});
describe("the phone's Menu", () => {
 for (const nav2 of [false, true]) it("lists the companies with roles, marks the current one, and switches (" + (nav2 ? "new navigation" : "old shell") + ")", async () => {
  const f = shell({ nav2 }), user = userEvent.setup();
  await screen.findByText("Acme data");await user.click(screen.getByRole("button", { name: "Open workspace menu" }));
  const dialog = await screen.findByRole("dialog", { name: "Workspace" }), section = await within(dialog).findByRole("heading", { name: "Company" });
  const rows = within(section.parentElement!).getAllByRole("button");
  expect(rows.map(row => row.textContent)).toEqual(["AcmeOwner✓", "Beta LtdMember", "GammaAuditor"]);
  expect(rows.map(row => row.getAttribute("aria-current"))).toEqual(["true", null, null]);
  // The navigation is still there under it, in whichever shell is on.
  expect(within(dialog).getByRole("navigation", { name: "Workspace" })).toBeTruthy();
  await expectNoAxeViolations(dialog);
  await user.click(rows[1]!);await waitFor(() => expect(f.navigate).toHaveBeenCalledWith("/app"));
  expect(f.server.calls.find(call => call.method === "POST")?.body).toMatchObject({ action: "switch", companyId: B });f.close();
 });
});
describe("a link for another company", () => {
 it("asks before showing anything: This link is for <Company B>. Switch to Company B? (Switch or Stay)", async () => {
  const f = shell({ path: "/app?company=" + B });
  const heading = await screen.findByRole("heading", { level: 1, name: "This link is for Beta Ltd. Switch to Beta Ltd?" });
  expect(document.activeElement).toBe(heading);
  expect(screen.getByRole("button", { name: "Switch" })).toBeTruthy();expect(screen.getByRole("button", { name: "Stay" })).toBeTruthy();
  // Never silently shown: the screen behind the link is not mounted, so it read nothing for any company.
  expect(screen.queryByText("Acme data")).toBeNull();expect(screen.queryByText("Beta Ltd data")).toBeNull();
  expect(f.server.calls.filter(call => call.path === "/v1/app/test-data")).toHaveLength(0);
  await expectNoAxeViolations(document.body);f.close();
 });
 it("Switch changes company and opens the linked page there", async () => {
  const f = shell({ path: "/app?company=" + B }), user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "Switch" }));
  await waitFor(() => expect(f.navigate).toHaveBeenCalledWith("/app"));
  expect(f.server.calls.find(call => call.method === "POST")?.body).toMatchObject({ action: "switch", companyId: B });expect(f.query.getQueryCache().getAll()).toHaveLength(0);f.close();
 });
 it("Stay keeps the current company, drops the company from the address and shows the page", async () => {
  const f = shell({ path: "/app?company=" + B }), user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "Stay" }));
  expect(await screen.findByText("Acme data")).toBeTruthy();expect(f.router.state.location.search).toBe("");expect(f.server.calls.filter(call => call.method === "POST")).toHaveLength(0);f.close();
 });
 it("shows the page at once when the link is for the company already open", async () => {
  const f = shell({ path: "/app?company=" + A });expect(await screen.findByText("Acme data")).toBeTruthy();expect(screen.queryByText(/This link is for/u)).toBeNull();f.close();
 });
 it("shows one generic sentence for a company the person is not in, naming none", async () => {
  const stranger = "org_" + "z".repeat(20), f = shell({ path: "/app?company=" + stranger });
  const heading = await screen.findByRole("heading", { level: 1, name: "You don't have access to this link" });
  expect(document.body.textContent).not.toContain("Beta Ltd");expect(document.body.textContent).not.toContain("Gamma");expect(document.body.textContent).not.toContain(stranger);
  expect(screen.queryByRole("button", { name: "Switch" })).toBeNull();expect(screen.queryByText("Acme data")).toBeNull();expect(heading).toBeTruthy();f.close();
 });
 it("shows a refused switch's sentence under the question", async () => {
  const f = shell({ path: "/app?company=" + B, server: server({ refuse: error(403, "REMOVED_FROM_ORG", REMOVED) }) });
  await userEvent.setup().click(await screen.findByRole("button", { name: "Switch" }));
  expect((await screen.findByRole("alert")).textContent).toBe(REMOVED);expect(f.navigate).not.toHaveBeenCalled();f.close();
 });
 it("fails closed when the companies cannot be read", async () => {
  const s = server(), f = shell({ path: "/app?company=" + B, server: { ...s, handler: async request => request.path === "/v1/app/companies" && request.method === "GET" ? error(403, "FORBIDDEN", "Not allowed.") : s.handler(request) } });
  expect(await screen.findByRole("heading", { level: 1, name: "We couldn't check which company this is for" })).toBeTruthy();expect(screen.queryByText("Acme data")).toBeNull();f.close();
 });
});
describe("an answer for another company", () => {
 it("is never used: the header-echoed company stops the page with the same question", async () => {
  const s = server({ echo: request => request.path === "/v1/app/test-data" ? B : undefined }), f = shell({ server: s });
  expect(await screen.findByRole("heading", { level: 1, name: "This page is for Beta Ltd. Switch to Beta Ltd?" })).toBeTruthy();
  expect(screen.queryByText("Acme data")).toBeNull();expect(screen.queryByText("Beta Ltd data")).toBeNull();f.close();
 });
 it("is refused by the client as COMPANY_MISMATCH with no body returned", async () => {
  const s = server({ echo: () => B }), f = fakeHost(s.handler);f.host.storage.set(COMPANIES_STORAGE_KEY, "v2");connect(f.host);
  const api = createApiClient(f.host);
  await expect(api.get("/v1/app/test-data", answer)).rejects.toMatchObject({ code: "COMPANY_MISMATCH" });
 });
 it("accepts an echo of the page's own company", async () => {
  const s = server({ echo: request => request.path === "/v1/app/test-data" ? A : undefined }), f = shell({ server: s });
  expect(await screen.findByText("Acme data")).toBeTruthy();expect(screen.queryByText(/This page is for/u)).toBeNull();f.close();
 });
 it("reloads into the active company on CSRF_STALE, once, never in a loop", async () => {
  const s = server(), stale = error(403, "CSRF_STALE", "Your company changed in another tab. Reloading."), f = fakeHost(async request => request.path === "/v1/app/test-data" ? stale : s.handler(request));
  f.host.storage.set(COMPANIES_STORAGE_KEY, "v2");const api = createApiClient(f.host), navigate = vi.fn<(url: string) => void>();f.host.navigate = navigate;connect(f.host);
  await expect(api.get("/v1/app/test-data", answer)).rejects.toMatchObject({ code: "CSRF_STALE", message: "Your company changed in another tab. Reloading." });
  expect(navigate).toHaveBeenCalledTimes(1);
  await expect(api.get("/v1/app/test-data", answer)).rejects.toMatchObject({ code: "CSRF_STALE" });expect(navigate).toHaveBeenCalledTimes(1);
 });
 it("does not treat CSRF_STALE as a company change when the switch is off", async () => {
  const f = fakeHost(async () => error(403, "CSRF_STALE", "Stale.")), navigate = vi.fn<(url: string) => void>();f.host.navigate = navigate;connect(f.host);
  await expect(createApiClient(f.host).get("/v1/app/test-data", answer)).rejects.toMatchObject({ code: "CSRF_STALE" });expect(navigate).not.toHaveBeenCalled();
 });
 it("goes on without a header when the companies read fails (the server's own switch is off)", async () => {
  const f = fakeHost(async request => request.path === "/v1/app/companies" ? error(404, "NOT_FOUND", "Not found.") : { status: 200, body: { text: "ok" } });f.host.storage.set(COMPANIES_STORAGE_KEY, "v2");connect(f.host);
  expect(await createApiClient(f.host).get("/v1/app/test-data", answer)).toEqual({ text: "ok" });
  expect(f.request.mock.calls.find(([input]) => input.path === "/v1/app/test-data")![0].headers).toBeUndefined();
 });
});

