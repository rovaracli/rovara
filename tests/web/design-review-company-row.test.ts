// @vitest-environment jsdom
// The company's design review card on the company How we work page (DR-FU4): for company owners and admins only, and only while design review exists in the environment (the route is not found otherwise).
// It shows whether design review is allowed, the default mode for projects and the stricter-only rules; allowing it waits for a different admin; the server decides all of it and the card shows its answer.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { AppNavSchema, AppMeResponseSchema } from "@agentx/contracts/web";
import { appRoutes } from "../../packages/ui/src/routes.js";
import { AppHostProvider, type ApiRequest, type ApiResponse } from "../../packages/ui/src/host.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { ThemeProvider } from "../../packages/ui/src/theme.js";
import { fakeHost } from "./support/fake-host.js";
import { renderUi } from "./support/render.js";
import { expectNoAxeViolations } from "./support/axe.js";
import { h } from "./support/h.js";
import { companyPolicyRaw } from "./support/company-policy-raw.js";

const PATH = "/v1/app/org/design-review";
const features = { localAgents: false, admin: true, usage: false, chains: false, describe: false, notices: false };
const EXPIRES = "2026-11-03T12:30:00.000Z";
type State = { revision: number; allowed: boolean; lock: Record<string, unknown>; unreadable: boolean; groups?: boolean; pending?: { changeId: string; kind: "allowed" | "lock"; proposedByYou: boolean; expiresAt: string } };
type Handler = (request: ApiRequest) => ApiResponse | undefined | Promise<ApiResponse | undefined>;
const refuse = (status: number, code: string, message: string) => ({ status, body: { error: { code, message } } });
const OFF: State = { revision: 0, allowed: false, lock: {}, unreadable: false };

function mount(options: { state?: State; missing?: boolean; post?: Handler; role?: "owner" | "admin" | "member"; theme?: "light" | "dark" } = {}) {
 const role = options.role ?? "owner";
 const nav = AppNavSchema.parse({ me: { developerId: "a".repeat(64), name: "Priya", orgRole: role }, org: { name: "Acme" }, homeCount: 0, projects: [], shared: { agents: [], sessions: [] }, features });
 const me = AppMeResponseSchema.parse({ developer: { id: "a".repeat(64), name: "Priya", orgRole: role }, org: { orgId: "org_aaaaaaaaaaaaaaaaaaaa", name: "Acme", plan: "team" }, identities: [] });
 let state: State = options.state ?? OFF;
 const f = fakeHost(async request => {
  const path = request.path.split("?")[0];
  if (path === "/v1/app/nav") return { status: 200, body: nav };
  if (path === "/v1/app/me") return { status: 200, body: me };
  if (path === "/v1/app/org/model-selection-policy") return { status: 200, body: companyPolicyRaw() };
  if (path === "/v1/app/org/model-sources") return { status: 200, body: { sources: [], order: ["rovara"] } };
  if (path === "/v1/app/org/learning-settings") return refuse(404, "NOT_FOUND", "Not found.");
  if (path === PATH && options.missing === true) return refuse(404, "NOT_FOUND", "Not found.");
  if (path === PATH && request.method === "GET") return { status: 200, body: state };
  if (path === PATH && request.method === "POST") {
   const custom = await options.post?.(request);
   if (custom !== undefined) return custom;
   const body = request.body as { action: string; allowed?: boolean; lock?: Record<string, unknown> };
   if (body.action === "save") { state = { ...state, revision: state.revision + 1, lock: body.lock ?? state.lock }; return { status: 200, body: { status: "applied", ...state } }; }
   if (body.action === "allow" && body.allowed === true) { state = { ...state, pending: { changeId: "chg_1", kind: "allowed", proposedByYou: true, expiresAt: EXPIRES } }; return { status: 202, body: { status: "needs_approval", changeId: "chg_1", ...state } }; }
   if (body.action === "cancel") { const { pending: _gone, ...rest } = state;void _gone;state = rest;return { status: 200, body: { status: "applied", ...state } }; }
   const { pending: _pending, ...rest } = state;void _pending;
   state = { ...rest, revision: state.revision + 1, allowed: body.action === "approve" };
   return { status: 200, body: { status: "applied", ...state } };
  }
  return refuse(404, "NOT_FOUND", "Not found.");
 });
 f.host.kind = "web";f.host.origin = "https://cell.example";
 const query = createQueryClient();query.setQueryData(["nav"], nav);f.storage.set("rovara.theme", options.theme ?? "light");
 const router = createMemoryRouter(appRoutes(nav.features), { initialEntries: ["/app/admin/how-we-work"] });
 const view = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(ThemeProvider, { host: f.host, children: h(RouterProvider, { router }) }) }) }), { theme: options.theme ?? "light" });
 const calls = () => f.request.mock.calls.map(([request]) => request);
 return { ...f, ...view, query, calls, posts: () => calls().filter(request => request.method === "POST" && request.path === PATH) };
}
const card = async () => within(await screen.findByRole("region", { name: "Design review" }));
afterEach(() => { vi.useRealTimers(); });

describe("who sees the card, and when", () => {
 it("is absent while design review is off in the environment (the route is not found): no card and no 'couldn't load' notice", async () => {
  const f = mount({ missing: true });
  await screen.findByRole("heading", { name: "How we work (company)" });
  await waitFor(() => expect(f.calls().some(request => request.path === PATH)).toBe(true));
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 100)); });
  expect(screen.queryByRole("region", { name: "Design review" })).toBeNull();
  expect(screen.queryByText("Couldn't load the design review settings.")).toBeNull();
 });

 it("is absent for a refused read (a member): the card is never shown and nothing is offered", async () => {
  const f = mount({ state: OFF });
  void f;
  const member = mount({ role: "member" });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 150)); });
  expect(member.calls().some(request => request.path === PATH)).toBe(false);
  expect(within(member.container).queryByRole("region", { name: "Design review" })).toBeNull();
 });

 it("an admin sees it, with design review not allowed and the default Off, in plain words", async () => {
  mount({ role: "admin" });
  const section = await card();
  expect((await section.findByRole("switch", { name: "Allow design review in this company" })).getAttribute("aria-checked")).toBe("false");
  expect(section.queryByRole("combobox", { name: "Projects that have not chosen" })).toBeNull();
  expect(section.queryByRole("combobox", { name: "Design review at least" })).toBeNull();
  expect(section.getByText(/each project's maintainers turn it on \(Auto or Always\) or off/u)).toBeTruthy();
  expect(section.getByText(/Off until an admin turns it on/)).toBeTruthy();
 });
});

describe("allowing design review", () => {
 it("opens a request for a different admin: one request, the card says it waits and offers the one who asked no confirmation", async () => {
  const f = mount();
  const section = await card();
  fireEvent.click(await section.findByRole("switch", { name: "Allow design review in this company" }));
  await section.findByText("Waiting for a different admin to confirm.");
  expect(f.posts()).toHaveLength(1);
  expect(f.posts()[0]!.body).toEqual({ action: "allow", expectedRevision: 0, allowed: true });
  await section.findByText("You asked to allow design review. A different admin has to confirm it here.");
  expect(section.queryByRole("button", { name: "Confirm allowing design review" })).toBeNull();
 });

 it("a different admin sees the waiting request and confirms it; the confirmation names the request", async () => {
  const f = mount({ role: "admin", state: { ...OFF, pending: { changeId: "chg_9", kind: "allowed", proposedByYou: false, expiresAt: EXPIRES } } });
  const section = await card();
  expect(await section.findByText("An admin asked to allow design review.")).toBeTruthy();
  fireEvent.click(section.getByRole("button", { name: "Confirm allowing design review" }));
  await section.findByText("Design review is allowed in this company.");
  expect(f.posts()[0]!.body).toEqual({ action: "approve", changeId: "chg_9" });
  await waitFor(() => expect(section.getByRole("switch", { name: "Allow design review in this company" }).getAttribute("aria-checked")).toBe("true"));
 });

 it("a confirmation without a recent sign-in shows the server's words and a way to sign in again, and changes nothing", async () => {
  const f = mount({ role: "admin", state: { ...OFF, pending: { changeId: "chg_9", kind: "allowed", proposedByYou: false, expiresAt: EXPIRES } }, post: () => refuse(403, "REAUTH_REQUIRED", "Sign in again to confirm this.") });
  const section = await card();
  fireEvent.click(await section.findByRole("button", { name: "Confirm allowing design review" }));
  expect((await screen.findByRole("alert")).textContent).toContain("Sign in again to confirm this.");
  fireEvent.click(screen.getByRole("button", { name: "Sign in again" }));
  expect(f.host.signIn).toHaveBeenCalledTimes(1);
  expect(section.getByRole("switch", { name: "Allow design review in this company" }).getAttribute("aria-checked")).toBe("false");
 });

 it("DR-UI-2: the answer to the allow switch shows right under the switch, not at the end of the card; a refusal there offers a sign-in", async () => {
  const f = mount({ post: () => refuse(403, "REAUTH_REQUIRED", "Sign in again to allow design review.") });
  const section = await card();
  const toggle = await section.findByRole("switch", { name: "Allow design review in this company" });
  fireEvent.click(toggle);
  const alert = await section.findByRole("alert");
  expect(alert.textContent).toContain("Sign in again to allow design review.");
  // Placed after the switch and before the rules: the person sees it where they pressed.
  const rules = section.getByRole("heading", { name: "Rules every project must follow" });
  expect(toggle.compareDocumentPosition(alert) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(alert.compareDocumentPosition(rules) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  fireEvent.click(within(alert).getByRole("button", { name: "Sign in again" }));
  expect(f.host.signIn).toHaveBeenCalledTimes(1);
  expect(toggle.getAttribute("aria-checked")).toBe("false");
 });

 it("DR-UI-2: says when the company's only owner can turn it on alone", async () => {
  mount();
  const section = await card();
  expect(await section.findByText(/unless you are the company's only owner and there is no other admin, and no admin was removed in the last 24 hours: then you can turn it on alone/u)).toBeTruthy();
 });

 it("not allowing applies at once", async () => {
  const f = mount({ state: { ...OFF, revision: 3, allowed: true } });
  const section = await card();
  fireEvent.click(await section.findByRole("switch", { name: "Allow design review in this company" }));
  await section.findByText("Design review is turned off for every project.");
  expect(f.posts()[0]!.body).toEqual({ action: "allow", expectedRevision: 3, allowed: false });
 });

 it("a change made meanwhile says so and reads the card again", async () => {
  mount({ state: { ...OFF, revision: 2 }, post: () => refuse(409, "POLICY_STALE", "This changed while you were looking. Reload and try again.") });
  const section = await card();
  fireEvent.click(await section.findByRole("switch", { name: "Allow design review in this company" }));
  expect((await screen.findByRole("alert")).textContent).toContain("This changed while you were looking.");
 });
});

describe("the one waiting request", () => {
 it("says plainly that Off projects can still use Design first, and that only one request waits at a time", async () => {
  mount({ role: "admin", state: { ...OFF, pending: { changeId: "chg_9", kind: "allowed", proposedByYou: false, expiresAt: EXPIRES } } });
  const section = await card();
  expect(await section.findByText("Projects set to Off can still ask for a design review on a single task with Design first.")).toBeTruthy();
  expect(section.getByText("Only one request can wait at a time.")).toBeTruthy();
 });

 it("the one who asked can withdraw the request, and the card then shows none", async () => {
  const f = mount({ state: { ...OFF, pending: { changeId: "chg_1", kind: "allowed", proposedByYou: true, expiresAt: EXPIRES } } });
  const section = await card();
  fireEvent.click(await section.findByRole("button", { name: "Withdraw the request" }));
  await section.findByText("The request is withdrawn.");
  expect(f.posts()[0]!.body).toEqual({ action: "cancel", changeId: "chg_1" });
  await waitFor(() => expect(section.queryByRole("button", { name: "Withdraw the request" })).toBeNull());
 });

 it("a request to loosen the rules is named as such, and a different admin confirms it with its own words", async () => {
  const f = mount({ role: "admin", state: { ...OFF, allowed: true, lock: { allowSkip: false }, pending: { changeId: "chg_5", kind: "lock", proposedByYou: false, expiresAt: EXPIRES } } });
  const section = await card();
  expect(await section.findByText("An admin asked to loosen the rules below.")).toBeTruthy();
  fireEvent.click(section.getByRole("button", { name: "Confirm the looser rules" }));
  await waitFor(() => expect(f.posts()).toHaveLength(1));
  expect(f.posts()[0]!.body).toEqual({ action: "approve", changeId: "chg_5" });
 });

 it("saving rules that loosen answers that they wait for a different admin", async () => {
  mount({ state: { ...OFF, revision: 2, allowed: true, lock: { allowSkip: false } }, post: () => ({ status: 202, body: { status: "needs_approval", changeId: "chg_7", ...OFF, revision: 2, allowed: true, lock: { allowSkip: false }, pending: { changeId: "chg_7", kind: "lock", proposedByYou: true, expiresAt: EXPIRES } } }) });
  const section = await card();
  fireEvent.click(await section.findByRole("switch", { name: "Nobody can skip design review" }));
  fireEvent.click(section.getByRole("button", { name: "Save rules" }));
  await section.findByText("The looser rules wait for a different admin to confirm.");
 });
});

describe("the off switch and the card's words", () => {
 it("R3: the off switch is disabled only while an allow request waits and design review is off; a waiting rules request never locks it", async () => {
  mount({ state: { ...OFF, allowed: true, lock: { allowSkip: false }, pending: { changeId: "chg_5", kind: "lock", proposedByYou: true, expiresAt: EXPIRES } } });
  const on = await card();
  expect((await on.findByRole("switch", { name: "Allow design review in this company" })).hasAttribute("disabled")).toBe(false);
  mount({ state: { ...OFF, pending: { changeId: "chg_1", kind: "allowed", proposedByYou: true, expiresAt: EXPIRES } } });
  await waitFor(() => expect(screen.getAllByRole("switch", { name: "Allow design review in this company" }).some(node => node.hasAttribute("disabled"))).toBe(true));
 });

 it("R5: says that turning design review off also withdraws a waiting change, and that rules never stop a project turning itself off", async () => {
  mount({ state: { ...OFF, allowed: true } });
  const section = await card();
  expect(await section.findByText(/Turning it off again also withdraws a change that is waiting for confirmation/u)).toBeTruthy();
  expect(section.getByText(/These rules never stop a project's maintainers turning their own project off/u)).toBeTruthy();
 });
});

describe("the default and the rules", () => {
 it("saves the rules in one request on the revision read", async () => {
  const f = mount({ state: { ...OFF, revision: 4, allowed: true } });
  const section = await card();
  expect((await section.findByRole("button", { name: "Save rules" })).hasAttribute("disabled")).toBe(true);
  fireEvent.change(await section.findByLabelText("Tier at least"), { target: { value: "standard" } });
  fireEvent.click(section.getByRole("switch", { name: "Nobody can skip design review" }));
  fireEvent.change(section.getByLabelText("Highest cost limit per task (USD)"), { target: { value: "8" } });
  fireEvent.click(section.getByRole("button", { name: "Save rules" }));
  await section.findByText("Saved. New design reviews use these settings; running ones keep theirs.");
  expect(f.posts()).toHaveLength(1);
  expect(f.posts()[0]!.body).toEqual({ action: "save", expectedRevision: 4, lock: { tierAtLeast: "standard", allowSkip: false, capCeilingUsd: 8 } });
  // The rules' answer stays at the end of the card, by its button, not under the allow switch.
  const saved = section.getByText("Saved. New design reviews use these settings; running ones keep theirs.");
  expect(section.getByRole("button", { name: "Save rules" }).compareDocumentPosition(saved) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
 });

 it("refuses a cost ceiling outside the range before sending anything", async () => {
  const f = mount({ state: { ...OFF, allowed: true } });
  const section = await card();
  fireEvent.change(await section.findByLabelText("Highest cost limit per task (USD)"), { target: { value: "500" } });
  expect(await section.findByText("Use an amount between $0.50 and $100.00.")).toBeTruthy();
  expect(section.getByRole("button", { name: "Save rules" }).hasAttribute("disabled")).toBe(true);
  expect(f.posts()).toHaveLength(0);
 });

 it("offers the approver group only where the edition has groups", async () => {
  mount({ state: { ...OFF, allowed: true } });
  const plain = await card();
  expect(plain.queryByLabelText("Group that approves high-risk designs (Enterprise)")).toBeNull();
 });

 it("shows a stored value it cannot read as such, and offers nothing to change", async () => {
  mount({ state: { ...OFF, unreadable: true } });
  const section = await card();
  expect(await section.findByRole("alert")).toBeTruthy();
  expect(section.queryByRole("button", { name: "Save rules" })).toBeNull();
  expect(section.queryByRole("switch")).toBeNull();
 });

 it("has no accessibility violations, light and dark", async () => {
  for (const theme of ["light", "dark"] as const) {
   const view = mount({ state: { ...OFF, allowed: true, lock: { mode: "auto", capCeilingUsd: 8 } }, theme });
   await card();
   await expectNoAxeViolations(view.container);
   view.unmount();
  }
 });
});
