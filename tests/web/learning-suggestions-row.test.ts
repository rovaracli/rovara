// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { AppNavSchema, AppMeResponseSchema, LearningCompanySettingsAnswerSchema } from "@agentx/cloud-contracts/web";
import { appRoutes } from "../../packages/ui/src/routes.js";
import { AppHostProvider, type ApiRequest, type ApiResponse } from "../../packages/ui/src/host.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { ThemeProvider } from "../../packages/ui/src/theme.js";
import { fakeHost } from "./support/fake-host.js";
import { renderUi } from "./support/render.js";
import { expectNoAxeViolations } from "./support/axe.js";
import { h } from "./support/h.js";
import { companyPolicyRaw } from "./support/company-policy-raw.js";

const SETTINGS = "/v1/app/org/learning-settings";
const features = { localAgents: false, admin: true, usage: false, chains: false, describe: false, notices: false };
type Handler = (request: ApiRequest) => ApiResponse | undefined | Promise<ApiResponse | undefined>;
const answer = (overrides: Record<string, unknown> = {}) => LearningCompanySettingsAnswerSchema.parse({ suggestions: "off", source: "company", revision: 3, canChange: true, ...overrides });
const refuse = (status: number, code: string, message: string) => ({ status, body: { error: { code, message } } });
/** The company How we work page of an owner; `state` is what GET answers (and what a PUT leaves behind). */
function mount(options: { settings?: Record<string, unknown>; missing?: boolean; failReads?: boolean; put?: Handler; theme?: "light" | "dark" } = {}) {
 const nav = AppNavSchema.parse({ me: { developerId: "a".repeat(64), name: "Priya", orgRole: "owner" }, org: { name: "Acme" }, homeCount: 0, projects: [], shared: { agents: [], sessions: [] }, features });
 const me = AppMeResponseSchema.parse({ developer: { id: "a".repeat(64), name: "Priya", orgRole: "owner" }, org: { orgId: "org_aaaaaaaaaaaaaaaaaaaa", name: "Acme", plan: "team" }, identities: [] });
 let state = answer(options.settings);
 const initial = state.revision;
 const f = fakeHost(async request => {
  const path = request.path.split("?")[0];
  if (path === "/v1/app/nav") return { status: 200, body: nav };
  if (path === "/v1/app/me") return { status: 200, body: me };
  if (path === "/v1/app/org/model-selection-policy") return { status: 200, body: companyPolicyRaw() };
  if (path === "/v1/app/org/model-sources") return { status: 200, body: { sources: [], order: ["rovara"] } };
  if (path === SETTINGS && options.missing === true) return refuse(404, "NOT_FOUND", "Not found.");
  if (path === SETTINGS && request.method === "GET" && options.failReads === true && state.revision !== initial) return refuse(400, "REQUEST_FAILED", "Read failed.");
  if (path === SETTINGS && request.method === "GET") return { status: 200, body: state };
  if (path === SETTINGS && request.method === "PUT") {
   const custom = await options.put?.(request);
   if (custom !== undefined) return custom;
   const body = request.body as { expectedRevision: number; suggestions: "on" | "off" };
   state = answer({ suggestions: body.suggestions, source: "company", revision: body.expectedRevision + 1 });
   return { status: 200, body: state };
  }
  return { status: 404, body: { error: { code: "NOT_FOUND", message: "Not found." } } };
 });
 f.host.kind = "web";f.host.origin = "https://cell.example";
 const query = createQueryClient();query.setQueryData(["nav"], nav);f.storage.set("rovara.theme", options.theme ?? "light");
 const router = createMemoryRouter(appRoutes(nav.features), { initialEntries: ["/app/admin/how-we-work"] });
 const view = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(ThemeProvider, { host: f.host, children: h(RouterProvider, { router }) }) }) }), { theme: options.theme ?? "light" });
 const calls = () => f.request.mock.calls.map(([request]) => request);
 return { ...f, ...view, query, puts: () => calls().filter(request => request.method === "PUT" && request.path === SETTINGS), reads: () => calls().filter(request => request.method === "GET" && request.path === SETTINGS) };
}
const row = async () => within(await screen.findByRole("region", { name: "Rule suggestions" }));
const CONFIRM = "Turning suggestions on can show suggestions built from corrections collected while they were off.";
afterEach(() => { vi.useRealTimers(); });
const statusLine = (section: { getByRole: (role: "status") => HTMLElement }) => section.getByRole("status");

describe("the company Rule suggestions row", () => {
 it("is on the company How we work page, with the heading, the help text and an Off state", async () => {
  mount();
  const section = await row();
  expect(section.getByRole("heading", { name: "Rule suggestions" })).toBeTruthy();
  expect(section.getByText("Off", { selector: "strong" })).toBeTruthy();
  expect(section.getByText("Rovara always collects your team's corrections. When suggestions are on, it suggests a rule once the same correction comes up twice.")).toBeTruthy();
  expect(section.queryByText(/default for this install/u)).toBeNull();
  expect(section.getByRole("button", { name: "Turn on" })).toBeTruthy();
 });
 it("says On, and offers Turn off", async () => {
  mount({ settings: { suggestions: "on" } });
  const section = await row();
  expect(section.getByText("On", { selector: "strong" })).toBeTruthy();
  expect(section.getByRole("button", { name: "Turn off" })).toBeTruthy();
  expect(section.queryByRole("button", { name: "Turn on" })).toBeNull();
 });
 it("says when the state is Rovara's default for this install", async () => {
  mount({ settings: { source: "install_default", revision: 0 } });
  expect((await row()).getByText("(Rovara's default for this install)")).toBeTruthy();
 });
 it("is read only without canChange, and says who can change it", async () => {
  mount({ settings: { canChange: false } });
  const section = await row();
  expect(section.getByText("Only a company owner or admin can change this.")).toBeTruthy();
  expect(section.queryByRole("button")).toBeNull();
 });
 it("turns off with the exact body, then reads again", async () => {
  const f = mount({ settings: { suggestions: "on", revision: 7 } });
  fireEvent.click((await row()).getByRole("button", { name: "Turn off" }));
  await waitFor(() => expect(f.puts()).toHaveLength(1));
  expect(f.puts()[0]!.body).toEqual({ expectedRevision: 7, suggestions: "off" });
  await waitFor(() => expect(f.reads().length).toBe(2));
  expect(await screen.findByText("Off", { selector: "strong" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Turn on" })).toBeTruthy();
 });
 it("asks first before turning on, with the required words, and Cancel sends nothing", async () => {
  const f = mount();
  const section = await row();
  fireEvent.click(section.getByRole("button", { name: "Turn on" }));
  expect(section.getByText(CONFIRM)).toBeTruthy();
  expect(f.puts()).toHaveLength(0);
  fireEvent.click(section.getByRole("button", { name: "Cancel" }));
  expect(section.queryByText(CONFIRM)).toBeNull();
  expect(section.getByRole("button", { name: "Turn on" })).toBeTruthy();
  expect(f.puts()).toHaveLength(0);
 });
 it("sends the exact body once the turn on is confirmed", async () => {
  const f = mount({ settings: { source: "install_default", revision: 0 } });
  const section = await row();
  fireEvent.click(section.getByRole("button", { name: "Turn on" }));
  fireEvent.click(section.getByRole("button", { name: "Turn on" }));
  await waitFor(() => expect(f.puts()).toHaveLength(1));
  expect(f.puts()[0]!.body).toEqual({ expectedRevision: 0, suggestions: "on" });
  expect(await screen.findByText("On", { selector: "strong" })).toBeTruthy();
  expect(screen.queryByText(CONFIRM)).toBeNull();
  expect(screen.queryByText(/default for this install/u)).toBeNull();
 });
 it("sends one request for a double click, with the buttons disabled while it is in flight", async () => {
  let release: () => void = () => undefined;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const f = mount({ settings: { suggestions: "on" }, put: async () => { await gate;return undefined; } });
  const button = (await row()).getByRole("button", { name: "Turn off" });
  fireEvent.click(button);fireEvent.click(button);
  await waitFor(() => expect(f.puts()).toHaveLength(1));
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "Turn off" }).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Turn off" }));
  release();
  await waitFor(() => expect(screen.getByRole("button", { name: "Turn on" })).toBeTruthy());
  expect(f.puts()).toHaveLength(1);
 });
 it("reads again and says so when someone else changed it", async () => {
  const f = mount({ settings: { suggestions: "on", revision: 3 }, put: () => refuse(409, "LEARNING_SETTINGS_CHANGED", "Changed by someone else.") });
  fireEvent.click((await row()).getByRole("button", { name: "Turn off" }));
  expect(await screen.findByText("Someone else changed this. The setting was refreshed.")).toBeTruthy();
  await waitFor(() => expect(f.reads().length).toBe(2));
  expect(f.puts()).toHaveLength(1);
  expect(screen.queryByText("Changed by someone else.")).toBeNull();
 });
 it("shows the throttle message and makes exactly one call, even after the retry delays pass", async () => {
  const f = mount({ settings: { suggestions: "on" }, put: () => refuse(429, "TOO_MANY_REQUESTS", "Too many changes. Wait a minute.") });
  const section = await row();
  vi.useFakeTimers();
  fireEvent.click(section.getByRole("button", { name: "Turn off" }));
  await vi.advanceTimersByTimeAsync(120_000);
  vi.useRealTimers();
  expect(await screen.findByText("Too many changes. Wait a minute.")).toBeTruthy();
  expect(f.puts()).toHaveLength(1);
  expect(screen.getByRole("button", { name: "Turn off" })).toBeTruthy();
 });
 it("shows a refusal's words as plain text, never as markup", async () => {
  const message = "Not yours <img src=x onerror=alert(1)> to change.";
  const { container } = mount({ settings: { suggestions: "on" }, put: () => refuse(403, "FORBIDDEN", message) });
  fireEvent.click((await row()).getByRole("button", { name: "Turn off" }));
  expect(await screen.findByText(message)).toBeTruthy();
  expect(container.querySelector("img")).toBeNull();
  expect(screen.getByRole("alert").textContent).toContain("<img src=x onerror=alert(1)>");
 });
 it("shows nothing when the server has no such setting (an older server)", async () => {
  const f = mount({ missing: true });
  await screen.findByRole("heading", { name: "How we work (company)" });
  await waitFor(() => expect(f.reads()).toHaveLength(1));
  expect(screen.queryByRole("region", { name: "Rule suggestions" })).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
 });
 it("has no accessibility violations in light and dark, in the confirm step too", async () => {
  const light = mount();
  fireEvent.click((await row()).getByRole("button", { name: "Turn on" }));
  await screen.findByText(CONFIRM);
  await expectNoAxeViolations(light.container);
  light.unmount();
  const dark = mount({ theme: "dark", settings: { suggestions: "on" } });
  await row();
  await expectNoAxeViolations(dark.container);
 });
});

describe("the Rule suggestions row: fix round 1", () => {
 it("keeps the new state on screen when the re-read after a successful change fails (the change's own answer seeds the cache)", async () => {
  const f = mount({ settings: { suggestions: "on", revision: 3 }, failReads: true });
  fireEvent.click((await row()).getByRole("button", { name: "Turn off" }));
  await waitFor(() => expect(f.reads().length).toBe(2));
  const section = await row();
  expect(await section.findByText("Off", { selector: "strong" })).toBeTruthy();
  expect(section.getByRole("button", { name: "Turn on" })).toBeTruthy();
  expect(section.queryByText("On", { selector: "strong" })).toBeNull();
 });
 it("has one live status region from the start, filled after a change and emptied once the state is refreshed elsewhere", async () => {
  const f = mount({ settings: { suggestions: "on", revision: 3 } });
  const section = await row();
  expect(statusLine(section).textContent).toBe("");
  fireEvent.click(section.getByRole("button", { name: "Turn off" }));
  await waitFor(() => expect(statusLine(section).textContent).toBe("Suggestions are off."));
  const region = statusLine(section);
  // Someone else turns it on, and the page reads again.
  act(() => { f.query.setQueryData(["learning", "company-settings"], answer({ suggestions: "on", revision: 9 }));});
  await waitFor(() => expect(statusLine(section).textContent).toBe(""));
  expect(statusLine(section)).toBe(region);
 });
 it("moves focus into the confirm step, back to Turn on on Cancel, and to the row's button after a confirmed change", async () => {
  mount();
  const section = await row();
  fireEvent.click(section.getByRole("button", { name: "Turn on" }));
  await waitFor(() => expect(document.activeElement).toBe(section.getByRole("button", { name: "Turn on" })));
  expect(section.getByText(CONFIRM)).toBeTruthy();
  fireEvent.click(section.getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(document.activeElement).toBe(section.getByRole("button", { name: "Turn on" })));
  expect(section.queryByText(CONFIRM)).toBeNull();
  fireEvent.click(section.getByRole("button", { name: "Turn on" }));
  await waitFor(() => expect(section.getByText(CONFIRM)).toBeTruthy());
  fireEvent.click(section.getByRole("button", { name: "Turn on" }));
  await waitFor(() => expect(document.activeElement).toBe(section.getByRole("button", { name: "Turn off" })));
 });
});
