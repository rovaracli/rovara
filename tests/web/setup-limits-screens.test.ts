// @vitest-environment jsdom
// SU-1: the project page's "Setup limits" (a maintainer's, with the company's caps beside the boxes) and the company How we work page's "Setup locks" (an admin's: off switch, caps, a loosening waiting for a different admin
// and when it expires, Approve with "Sign in again" on REAUTH_REQUIRED, Repair for an unreadable row). Nothing shows while the setup agent is off (not found). Every word that comes from the server goes through VisibleText.
import { describe, expect, it } from "vitest";
import { act, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Routes, Route, createMemoryRouter, RouterProvider } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { AppNavSchema, AppMeResponseSchema } from "@agentx/contracts/web";
import { ProjectScreen } from "../../packages/ui/src/screens/project/ProjectScreen.js";
import { appRoutes } from "../../packages/ui/src/routes.js";
import { AppHostProvider, type ApiRequest, type ApiResponse } from "../../packages/ui/src/host.js";
import { Announcer } from "../../packages/ui/src/design/Announcer.js";
import { ThemeProvider } from "../../packages/ui/src/theme.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { renderUi } from "./support/render.js";
import { expectNoAxeViolations } from "./support/axe.js";
import { fakeHost } from "./support/fake-host.js";
import { h } from "./support/h.js";
import { projectFixture } from "./support/project-fixture.js";
import { companyPolicyRaw } from "./support/company-policy-raw.js";

const LIMITS_PATH = "/v1/app/projects/payments/setup-agent/limits";
const LOCKS_PATH = "/v1/app/org/setup-agent/locks";
const DEFAULTS = { commands: 40, sameStepTries: 3, wallClockMin: 45, budgetCents: 400, hostAsks: 5 };
const MAXIMA = { commands: 120, sameStepTries: 5, wallClockMin: 120, budgetCents: 2000, hostAsks: 10 };
const refuse = (status: number, code: string, message: string) => ({ status, body: { error: { code, message } } });
type Handler = (request: ApiRequest) => ApiResponse | undefined | Promise<ApiResponse | undefined>;

// ---- the project page

interface ProjectView { revision: number; limits: Record<string, number>; companyLock: Record<string, number>; effective: Record<string, number> }
const projectView = (over: Partial<ProjectView> = {}) => ({ revision: 0, limits: {}, companyLock: {}, effective: DEFAULTS, defaults: DEFAULTS, maxima: MAXIMA, ...over });

function mountProject(options: { view?: ReturnType<typeof projectView>; missing?: boolean; put?: Handler; canEdit?: boolean; page?: boolean } = {}) {
 let view = options.view ?? projectView();
 const f = fakeHost(async request => {
  const path = request.path.split("?")[0];
  if (path === "/v1/app/changes") return { status: 200, body: { notices: [], next: "settled" } };
  if (path === "/v1/app/projects/payments/overview") return { status: 200, body: projectFixture(options.canEdit === false ? { you: { role: "contributor", canStartWork: true, canEditSettings: false, canViewSpend: false } } : {}) };
  if (path === LIMITS_PATH && options.missing === true) return refuse(404, "NOT_FOUND", "Not found.");
  if (path === LIMITS_PATH && request.method === "GET") return { status: 200, body: view };
  if (path === LIMITS_PATH && request.method === "PUT") {
   const custom = await options.put?.(request);
   if (custom !== undefined) return custom;
   const sent = request.body as { limits: Record<string, number> };
   view = { ...view, revision: view.revision + 1, limits: sent.limits, effective: { ...DEFAULTS, ...sent.limits } };
   return { status: 200, body: view };
  }
  return refuse(404, "NOT_FOUND", "Not found.");
 });
 const query = createQueryClient();
 const element = h(MemoryRouter, { initialEntries: ["/app/projects/payments"], children: h(Announcer, { children: h(Routes, { children: h(Route, { path: "/app/projects/:name", element: h(ProjectScreen, {}) }) }) }) });
 const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: element }) }));
 const puts = () => f.request.mock.calls.map(([request]) => request).filter(request => request.method === "PUT");
 return { ...f, ...ui, query, puts, set(next: ReturnType<typeof projectView>) { view = next; } };
}
const limitsRegion = async () => within(await screen.findByRole("region", { name: "Setup limits" }));
const type = (label: string | RegExp, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });

describe("the project's Setup limits", () => {
 it("shows nothing while the setup agent is off (not found)", async () => {
  const f = mountProject({ missing: true });
  await screen.findByRole("heading", { name: "payments" });
  await waitFor(() => expect(f.request.mock.calls.some(([request]) => request.path === LIMITS_PATH)).toBe(true));
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)); });
  expect(screen.queryByRole("region", { name: "Setup limits" })).toBeNull();
  expect(screen.queryByText("Couldn't load the setup limits.")).toBeNull();
 });

 it("is a maintainer's: a person who cannot edit settings never asks for it", async () => {
  const f = mountProject({ canEdit: false });
  await screen.findByRole("heading", { name: "payments" });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)); });
  expect(screen.queryByRole("region", { name: "Setup limits" })).toBeNull();
  expect(f.request.mock.calls.some(([request]) => request.path === LIMITS_PATH)).toBe(false);
 });

 it("shows what a run would use, and the default, the most and the company's cap beside each box", async () => {
  mountProject({ view: projectView({ revision: 2, limits: { commands: 30 }, companyLock: { wallClockMin: 60, budgetCents: 250 }, effective: { ...DEFAULTS, commands: 30, wallClockMin: 45, budgetCents: 250 } }) });
  const section = await limitsRegion();
  expect(await section.findByText(/A run started now would use/u)).toBeTruthy();
  expect((section.getByLabelText("Commands a run may run") as HTMLInputElement).value).toBe("30");
  expect((section.getByLabelText("Model spend of a run, in dollars") as HTMLInputElement).value).toBe("");
  expect(section.getByText("Default 40. Most 120. No company cap.")).toBeTruthy();
  expect(section.getByText("Default $4.00. Most $20.00. Company cap $2.50.")).toBeTruthy();
  expect(section.getByText("Default 45. Most 120. Company cap 60.")).toBeTruthy();
 });

 it("saves what was typed once: the spend in cents, the revision the person saw, and shows the answer", async () => {
  const f = mountProject({ view: projectView({ revision: 2, limits: { commands: 30 } }) });
  const section = await limitsRegion();
  await section.findByLabelText("Commands a run may run");
  expect((section.getByRole("button", { name: "Save limits" }) as HTMLButtonElement).disabled).toBe(true);
  type("Commands a run may run", "25");
  type("Model spend of a run, in dollars", "3.5");
  fireEvent.click(section.getByRole("button", { name: "Save limits" }));
  await section.findByText("Saved. New runs use these limits.");
  expect(f.puts()).toHaveLength(1);
  expect(f.puts()[0]!.body).toMatchObject({ expectedRevision: 2, limits: { commands: 25, budgetCents: 350 } });
  expect(typeof (f.puts()[0]!.body as { requestId: string }).requestId).toBe("string");
  expect(Object.keys(f.puts()[0]!.body as object).sort()).toEqual(["expectedRevision", "limits", "requestId"]);
  expect((section.getByLabelText("Commands a run may run") as HTMLInputElement).value).toBe("25");
 });

 it("emptying a box removes the project's own value (the default applies)", async () => {
  const f = mountProject({ view: projectView({ revision: 1, limits: { commands: 30, hostAsks: 2 } }) });
  const section = await limitsRegion();
  await section.findByLabelText("Commands a run may run");
  type("Commands a run may run", "");
  fireEvent.click(section.getByRole("button", { name: "Save limits" }));
  await section.findByText("Saved. New runs use these limits.");
  expect(f.puts()[0]!.body).toMatchObject({ limits: { hostAsks: 2 } });
  expect((f.puts()[0]!.body as { limits: object }).limits).not.toHaveProperty("commands");
 });

 it("keeps a number above the company's cap, a non-number and zero out of the request", async () => {
  const f = mountProject({ view: projectView({ companyLock: { commands: 20 } }) });
  const section = await limitsRegion();
  await section.findByLabelText("Commands a run may run");
  type("Commands a run may run", "30");
  expect(section.getByText("No more than 20")).toBeTruthy();
  expect((section.getByRole("button", { name: "Save limits" }) as HTMLButtonElement).disabled).toBe(true);
  type("Commands a run may run", "abc");
  expect(section.getByText("Use a whole number")).toBeTruthy();
  type("Commands a run may run", "0");
  expect(section.getByText("At least 1")).toBeTruthy();
  type("Commands a run may run", "20");
  expect((section.getByRole("button", { name: "Save limits" }) as HTMLButtonElement).disabled).toBe(false);
  expect(f.puts()).toHaveLength(0);
 });

 it("a limit changed meanwhile says so and reads the limits again", async () => {
  const f = mountProject({ view: projectView({ revision: 1 }), put: () => refuse(409, "CHANGE_STALE", "The limits changed since you looked. Refresh and try again.") });
  const section = await limitsRegion();
  await section.findByLabelText("Commands a run may run");
  f.set(projectView({ revision: 2, limits: { commands: 10 }, effective: { ...DEFAULTS, commands: 10 } }));
  type("Commands a run may run", "25");
  fireEvent.click(section.getByRole("button", { name: "Save limits" }));
  expect((await screen.findByRole("alert")).textContent).toContain("The limits changed since you looked. They were read again.");
  await waitFor(() => expect((screen.getByLabelText("Commands a run may run") as HTMLInputElement).value).toBe("10"));
 });

 it("shows a refusal through VisibleText: a hidden control character is shown, never obeyed", async () => {
  mountProject({ put: () => refuse(400, "CONFIG_INVALID", "commands: too‮many") });
  const section = await limitsRegion();
  await section.findByLabelText("Commands a run may run");
  type("Commands a run may run", "25");
  fireEvent.click(section.getByRole("button", { name: "Save limits" }));
  expect((await screen.findByRole("alert")).textContent).toContain("commands: too[U+202E]many");
 });

 it("has no accessibility violations", async () => {
  const f = mountProject({ view: projectView({ companyLock: { commands: 20 } }) });
  await limitsRegion();
  await expectNoAxeViolations(f.container);
 });
});

// ---- the company page

interface LockState { limits: Record<string, number>; setupAgentOff: boolean; devcontainerImages: string[] | null; noSoleOwnerException: boolean }
const PENDING_AT = "2026-11-02T12:30:00.000Z";
const DIGEST = "d".repeat(64);
const locksView = (over: Record<string, unknown> = {}) => ({ revision: 3, limits: {}, setupAgentOff: false, devcontainerImages: null, noSoleOwnerException: false, defaults: DEFAULTS, maxima: MAXIMA, ...over });
const features = { localAgents: false, admin: true, usage: false, chains: false, describe: false, notices: false };

function mountCompany(options: { view?: unknown; missing?: boolean; role?: "owner" | "admin" | "member"; write?: Handler } = {}) {
 const role = options.role ?? "owner";
 const nav = AppNavSchema.parse({ me: { developerId: "a".repeat(64), name: "Priya", orgRole: role }, org: { name: "Acme" }, homeCount: 0, projects: [], shared: { agents: [], sessions: [] }, features });
 const me = AppMeResponseSchema.parse({ developer: { id: "a".repeat(64), name: "Priya", orgRole: role }, org: { orgId: "org_aaaaaaaaaaaaaaaaaaaa", name: "Acme", plan: "team" }, identities: [] });
 let view: unknown = options.view ?? locksView();
 const f = fakeHost(async request => {
  const path = request.path.split("?")[0];
  if (path === "/v1/app/nav") return { status: 200, body: nav };
  if (path === "/v1/app/me") return { status: 200, body: me };
  if (path === "/v1/app/org/model-selection-policy") return { status: 200, body: companyPolicyRaw() };
  if (path === "/v1/app/org/model-sources") return { status: 200, body: { sources: [], order: ["rovara"] } };
  if (path === "/v1/app/org/learning-settings") return refuse(404, "NOT_FOUND", "Not found.");
  if (path === LOCKS_PATH && options.missing === true) return refuse(404, "NOT_FOUND", "Not found.");
  if (path === LOCKS_PATH && request.method === "GET") return { status: 200, body: view };
  if (path.startsWith(LOCKS_PATH) && request.method !== "GET") {
   const custom = await options.write?.(request);
   if (custom !== undefined) return custom;
   return { status: 200, body: { status: "applied" } };
  }
  return refuse(404, "NOT_FOUND", "Not found.");
 });
 f.host.kind = "web";f.host.origin = "https://cell.example";
 const query = createQueryClient();query.setQueryData(["nav"], nav);f.storage.set("rovara.theme", "light");
 const router = createMemoryRouter(appRoutes(nav.features), { initialEntries: ["/app/admin/how-we-work"] });
 const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(ThemeProvider, { host: f.host, children: h(RouterProvider, { router }) }) }) }), { theme: "light" });
 const writes = () => f.request.mock.calls.map(([request]) => request).filter(request => request.path.startsWith(LOCKS_PATH) && request.method !== "GET");
 return { ...f, ...ui, writes, set(next: unknown) { view = next; } };
}
const locksRegion = async () => within(await screen.findByRole("region", { name: "Setup locks" }));

describe("the company's Setup locks", () => {
 it("shows nothing while the setup agent is off (not found)", async () => {
  const f = mountCompany({ missing: true });
  await screen.findByRole("heading", { name: "How we work (company)" });
  await waitFor(() => expect(f.request.mock.calls.some(([request]) => request.path === LOCKS_PATH)).toBe(true));
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)); });
  expect(screen.queryByRole("region", { name: "Setup locks" })).toBeNull();
  expect(screen.queryByText("Couldn't load the setup locks.")).toBeNull();
 });

 it("shows 'Setup agent off', the caps and the allowed images (the images through VisibleText)", async () => {
  mountCompany({ view: locksView({ setupAgentOff: true, limits: { commands: 20, budgetCents: 250 }, devcontainerImages: ["ghcr.io/acme/base‮:1"], noSoleOwnerException: true }) });
  const section = await locksRegion();
  expect(await section.findByText("Setup agent off", { selector: "strong" })).toBeTruthy();
  expect(section.getByText("No setup run can start in any project of the company.")).toBeTruthy();
  expect(section.getByText("Company limits for a run: Commands 20, Model spend $2.50")).toBeTruthy();
  expect(section.getByText("Dev container images allowed: ghcr.io/acme/base[U+202E]:1")).toBeTruthy();
  expect(section.getByText("A company with one admin cannot loosen locks by itself.")).toBeTruthy();
  expect(section.queryByRole("button", { name: "Approve this change" })).toBeNull();
 });

 it("is an admin's: a member never asks for the locks", async () => {
  const f = mountCompany({ role: "member" });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 150)); });
  expect(screen.queryByRole("region", { name: "Setup locks" })).toBeNull();
  expect(f.request.mock.calls.some(([request]) => request.path === LOCKS_PATH)).toBe(false);
 });

 it("shows 'Setup agent on' with no company limit set", async () => {
  mountCompany();
  const section = await locksRegion();
  expect(await section.findByText("Setup agent on", { selector: "strong" })).toBeTruthy();
  expect(section.getByText(/No company limit is set/u)).toBeTruthy();
 });

 const waiting = (byYou: boolean) => locksView({ setupAgentOff: true, pending: { limits: { commands: 80 }, setupAgentOff: false, devcontainerImages: null, noSoleOwnerException: false, digest: DIGEST, proposedAt: PENDING_AT, byYou } });

 it("shows a loosening that waits, what it would set and when it expires; the one who proposed it cannot approve it", async () => {
  mountCompany({ view: waiting(true) });
  const section = await locksRegion();
  expect(await section.findByText("A change is waiting for a different admin")).toBeTruthy();
  expect(section.getByText("It would set: Setup agent on; Commands 80.")).toBeTruthy();
  expect(section.getByText("It expires at 2026-11-03 12:30 UTC.")).toBeTruthy();
  expect(section.getByText("You proposed this. A different admin has to approve it.")).toBeTruthy();
  expect(section.queryByRole("button", { name: "Approve this change" })).toBeNull();
 });

 it("a different admin approves exactly the revision and digest they saw, once", async () => {
  const f = mountCompany({ role: "admin", view: waiting(false) });
  const section = await locksRegion();
  expect(await section.findByText("Another admin proposed this. You can approve it.")).toBeTruthy();
  f.set(locksView({ setupAgentOff: false, limits: { commands: 80 } }));
  fireEvent.click(section.getByRole("button", { name: "Approve this change" }));
  await section.findByText("Approved. The change is on.");
  expect(f.writes()).toHaveLength(1);
  expect(f.writes()[0]!.method).toBe("POST");
  expect(f.writes()[0]!.path).toBe(LOCKS_PATH + "/approve");
  expect(f.writes()[0]!.body).toMatchObject({ expectedRevision: 3, expectedDigest: DIGEST });
  expect(await section.findByText("Setup agent on", { selector: "strong" })).toBeTruthy();
  expect(section.queryByRole("button", { name: "Approve this change" })).toBeNull();
 });

 it("an approval without a recent sign-in shows the server's words and 'Sign in again', and changes nothing", async () => {
  const f = mountCompany({ role: "admin", view: waiting(false), write: () => refuse(403, "REAUTH_REQUIRED", "Sign in again to approve this.") });
  const section = await locksRegion();
  fireEvent.click(await section.findByRole("button", { name: "Approve this change" }));
  expect((await screen.findByRole("alert")).textContent).toContain("Sign in again to approve this.");
  fireEvent.click(screen.getByRole("button", { name: "Sign in again" }));
  expect(f.host.signIn).toHaveBeenCalledTimes(1);
  expect(section.getByText("Setup agent off", { selector: "strong" })).toBeTruthy();
 });

 it("a change that moved says so and reads the locks again", async () => {
  const f = mountCompany({ role: "admin", view: waiting(false), write: () => refuse(409, "CHANGE_STALE", "The locks changed since you looked. Refresh and try again.") });
  const section = await locksRegion();
  f.set(locksView());
  fireEvent.click(await section.findByRole("button", { name: "Approve this change" }));
  expect((await screen.findByRole("alert")).textContent).toContain("The locks changed since you looked. They were read again.");
  await waitFor(() => expect(section.queryByText("A change is waiting for a different admin")).toBeNull());
 });

 it("sends one approval even when two presses land before the page has redrawn", async () => {
  let release: (() => void) | undefined;
  const f = mountCompany({ role: "admin", view: waiting(false), write: () => new Promise<ApiResponse>(resolve => { release = () => resolve({ status: 200, body: { status: "applied" } }); }) });
  const section = await locksRegion();
  const button = await section.findByRole("button", { name: "Approve this change" });
  act(() => { button.click();button.click(); });
  await waitFor(() => expect(f.writes()).toHaveLength(1));
  release?.();
  await section.findByText("Approved. The change is on.");
  expect(f.writes()).toHaveLength(1);
 });

 const unreadable = { unreadable: true, revision: 4, message: "Company locks unreadable, runs held. A company admin has to repair them.‮" };

 it("offers Repair when the locks do not read, sending the stored revision once", async () => {
  const f = mountCompany({ view: unreadable });
  const section = await locksRegion();
  expect(await section.findByText("The setup locks can't be read")).toBeTruthy();
  expect(section.getByText("Company locks unreadable, runs held. A company admin has to repair them.[U+202E]")).toBeTruthy();
  f.set(locksView({ revision: 5 }));
  fireEvent.click(section.getByRole("button", { name: "Repair the locks" }));
  await section.findByText("Repaired. Setup runs can start again.");
  expect(f.writes()).toHaveLength(1);
  expect(f.writes()[0]!.path).toBe(LOCKS_PATH + "/repair");
  expect(f.writes()[0]!.body).toMatchObject({ expectedRevision: 4 });
  expect(await section.findByText("Setup agent on", { selector: "strong" })).toBeTruthy();
 });

 it("a repair without a recent sign-in shows 'Sign in again'", async () => {
  const f = mountCompany({ view: unreadable, write: () => refuse(403, "REAUTH_REQUIRED", "Sign in again to repair the locks.") });
  const section = await locksRegion();
  fireEvent.click(await section.findByRole("button", { name: "Repair the locks" }));
  expect((await screen.findByRole("alert", {}, { timeout: 2000 })).textContent).toBeTruthy();
  fireEvent.click(await screen.findByRole("button", { name: "Sign in again" }));
  expect(f.host.signIn).toHaveBeenCalledTimes(1);
 });

 it("turning setup runs off applies at once and sends only what changed", async () => {
  const f = mountCompany({ write: () => ({ status: 200, body: { status: "applied" } }) });
  const section = await locksRegion();
  fireEvent.click(await section.findByRole("button", { name: "Change the locks" }));
  fireEvent.click(section.getByRole("switch", { name: "Turn off setup runs for the company" }));
  fireEvent.click(section.getByRole("button", { name: "Save locks" }));
  await section.findByText("Saved. The change is on.");
  expect(f.writes()).toHaveLength(1);
  expect(f.writes()[0]!.method).toBe("PUT");
  expect(f.writes()[0]!.body).toMatchObject({ expectedRevision: 3, setupAgentOff: true });
  expect(Object.keys(f.writes()[0]!.body as object).sort()).toEqual(["expectedRevision", "requestId", "setupAgentOff"]);
 });

 it("a change that loosens a lock says a different admin has to approve it", async () => {
  const f = mountCompany({ view: locksView({ setupAgentOff: true }), write: () => ({ status: 202, body: { status: "needs_second_admin" } }) });
  const section = await locksRegion();
  fireEvent.click(await section.findByRole("button", { name: "Change the locks" }));
  fireEvent.click(section.getByRole("switch", { name: "Turn off setup runs for the company" }));
  fireEvent.click(section.getByRole("button", { name: "Save locks" }));
  await section.findByText("Saved. Part of this loosens a lock, so a different admin has to approve it.");
  expect(f.writes()[0]!.body).toMatchObject({ setupAgentOff: false });
 });

 it("has no accessibility violations", async () => {
  const f = mountCompany({ role: "admin", view: waiting(false) });
  await locksRegion();
  await expectNoAxeViolations(f.container);
 });
});
