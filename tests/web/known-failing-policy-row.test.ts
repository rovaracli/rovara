// @vitest-environment jsdom
// The company setting "always two people" for marking tests as already failing, on the company How we work page: shows the current value and any waiting request to turn it off; turning it on applies at once; turning it
// off opens a request that a DIFFERENT admin approves, signed in within the last 10 minutes. The server decides all of it; the row shows its answer.
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

const POLICY = "/v1/app/org/known-failing-policy";
const features = { localAgents: false, admin: true, usage: false, chains: false, describe: false, notices: false };
const EXPIRES = "2026-11-03T12:30:00.000Z";
type State = { alwaysTwoPeople: boolean; pendingLoosening: boolean; pending?: { changeId: string; proposedByYou: boolean; expiresAt: string } };
type Handler = (request: ApiRequest) => ApiResponse | undefined | Promise<ApiResponse | undefined>;
const refuse = (status: number, code: string, message: string) => ({ status, body: { error: { code, message } } });

function mount(options: { state?: State; missing?: boolean; failReadsAfterWrite?: boolean; post?: Handler; role?: "owner" | "admin"; theme?: "light" | "dark" } = {}) {
 const role = options.role ?? "owner";
 const nav = AppNavSchema.parse({ me: { developerId: "a".repeat(64), name: "Priya", orgRole: role }, org: { name: "Acme" }, homeCount: 0, projects: [], shared: { agents: [], sessions: [] }, features });
 const me = AppMeResponseSchema.parse({ developer: { id: "a".repeat(64), name: "Priya", orgRole: role }, org: { orgId: "org_aaaaaaaaaaaaaaaaaaaa", name: "Acme", plan: "team" }, identities: [] });
 let state: State = options.state ?? { alwaysTwoPeople: false, pendingLoosening: false };
 let wrote = false;
 const f = fakeHost(async request => {
  const path = request.path.split("?")[0];
  if (path === "/v1/app/nav") return { status: 200, body: nav };
  if (path === "/v1/app/me") return { status: 200, body: me };
  if (path === "/v1/app/org/model-selection-policy") return { status: 200, body: companyPolicyRaw() };
  if (path === "/v1/app/org/model-sources") return { status: 200, body: { sources: [], order: ["rovara"] } };
  if (path === "/v1/app/org/learning-settings") return refuse(404, "NOT_FOUND", "Not found.");
  if (path === POLICY && options.missing === true) return refuse(404, "NOT_FOUND", "Not found.");
  if (path === POLICY && request.method === "GET" && options.failReadsAfterWrite === true && wrote) return refuse(400, "REQUEST_FAILED", "Read failed.");
  if (path === POLICY && request.method === "GET") return { status: 200, body: state };
  if (path === POLICY && request.method === "POST") {
   wrote = true;
   const custom = await options.post?.(request);
   if (custom !== undefined) return custom;
   const body = request.body as { action: string; alwaysTwoPeople?: boolean };
   if (body.action === "set" && body.alwaysTwoPeople === true) { state = { alwaysTwoPeople: true, pendingLoosening: false }; return { status: 200, body: { status: "applied", ...state } }; }
   if (body.action === "set") { state = { alwaysTwoPeople: true, pendingLoosening: true, pending: { changeId: "chg_1", proposedByYou: true, expiresAt: EXPIRES } }; return { status: 202, body: { status: "needs_approval", changeId: "chg_1", ...state } }; }
   state = { alwaysTwoPeople: false, pendingLoosening: false }; return { status: 200, body: { status: "applied", ...state } };
  }
  return refuse(404, "NOT_FOUND", "Not found.");
 });
 f.host.kind = "web";f.host.origin = "https://cell.example";
 const query = createQueryClient();query.setQueryData(["nav"], nav);f.storage.set("rovara.theme", options.theme ?? "light");
 const router = createMemoryRouter(appRoutes(nav.features), { initialEntries: ["/app/admin/how-we-work"] });
 const view = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(ThemeProvider, { host: f.host, children: h(RouterProvider, { router }) }) }) }), { theme: options.theme ?? "light" });
 const calls = () => f.request.mock.calls.map(([request]) => request);
 return { ...f, ...view, query, posts: () => calls().filter(request => request.method === "POST" && request.path === POLICY), setState(next: State) { state = next; } };
}
const row = async () => within(await screen.findByRole("region", { name: "Marking tests as already failing" }));
afterEach(() => { vi.useRealTimers(); });

describe("the row", () => {
 it("is absent while the four test results are off (the setting is not found)", async () => {
  const f = mount({ missing: true });
  await screen.findByRole("heading", { name: "How we work (company)" });
  await waitFor(() => expect(f.request.mock.calls.some(([request]) => request.path === POLICY)).toBe(true));
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 100)); });
  // Neither the row nor its "couldn't load" notice: the setting simply does not exist.
  expect(screen.queryByRole("region", { name: "Marking tests as already failing" })).toBeNull();
  expect(screen.queryByText("Couldn't load this setting.")).toBeNull();
 });

 it("shows 'One maintainer may mark' by default, with the way to require two people and no way to ask to turn off", async () => {
  mount();
  const section = await row();
  expect(section.getByText("One maintainer may mark", { selector: "strong" })).toBeTruthy();
  expect(section.getByRole("button", { name: "Require two people" })).toBeTruthy();
  expect(section.queryByRole("button", { name: "Ask to turn off" })).toBeNull();
 });

 it("turning it on applies at once: one request, and the row shows the new value", async () => {
  const f = mount();
  const section = await row();
  fireEvent.click(await section.findByRole("button", { name: "Require two people" }));
  await section.findByText("Always two people", { selector: "strong" });
  expect(f.posts()).toHaveLength(1);
  expect(f.posts()[0]!.body).toEqual({ action: "set", alwaysTwoPeople: true });
  expect(section.getByText("Every mark now needs a second person.")).toBeTruthy();
  expect(section.getByRole("button", { name: "Ask to turn off" })).toBeTruthy();
  expect(section.queryByRole("button", { name: "Require two people" })).toBeNull();
 });

 it("shows the answer of a change even when reading the setting again fails", async () => {
  mount({ failReadsAfterWrite: true });
  const section = await row();
  fireEvent.click(await section.findByRole("button", { name: "Require two people" }));
  await section.findByText("Every mark now needs a second person.");
  await waitFor(() => expect(section.getByText("Always two people", { selector: "strong" })).toBeTruthy());
  expect(section.getByRole("button", { name: "Ask to turn off" })).toBeTruthy();
 });

 it("asking to turn it off opens a request: the row says it waits for a different admin, shows when it expires and offers no approval to the one who asked", async () => {
  const f = mount({ state: { alwaysTwoPeople: true, pendingLoosening: false } });
  const section = await row();
  fireEvent.click(await section.findByRole("button", { name: "Ask to turn off" }));
  await section.findByText("You asked to turn this off. A different admin has to approve it.");
  expect(f.posts()[0]!.body).toEqual({ action: "set", alwaysTwoPeople: false });
  expect(section.getByText("Always two people", { selector: "strong" })).toBeTruthy();
  expect(section.getByText("The request expires at 2026-11-03 12:30 UTC.")).toBeTruthy();
  expect(section.queryByRole("button", { name: "Approve turning it off" })).toBeNull();
  expect(section.queryByRole("button", { name: "Ask to turn off" })).toBeNull();
  expect(section.getByText("Waiting for a different admin to approve turning this off.")).toBeTruthy();
 });

 it("a different admin sees the waiting request and can approve it; the approval names the request and the row then shows one maintainer may mark", async () => {
  const f = mount({ role: "admin", state: { alwaysTwoPeople: true, pendingLoosening: true, pending: { changeId: "chg_9", proposedByYou: false, expiresAt: EXPIRES } } });
  const section = await row();
  expect(await section.findByText("An admin asked to turn this off. You can approve it.")).toBeTruthy();
  expect(section.getByText("You need to have signed in within the last 10 minutes.")).toBeTruthy();
  fireEvent.click(section.getByRole("button", { name: "Approve turning it off" }));
  await section.findByText("One maintainer may mark", { selector: "strong" });
  expect(f.posts()[0]!.body).toEqual({ action: "approve", changeId: "chg_9" });
  expect(section.getByText("Done. One maintainer may mark again.")).toBeTruthy();
 });

 it("an approval without a recent sign-in shows the server's words and a way to sign in again, and changes nothing", async () => {
  const f = mount({ role: "admin", state: { alwaysTwoPeople: true, pendingLoosening: true, pending: { changeId: "chg_9", proposedByYou: false, expiresAt: EXPIRES } }, post: () => refuse(403, "REAUTH_REQUIRED", "Sign in again to approve this.") });
  const section = await row();
  fireEvent.click(await section.findByRole("button", { name: "Approve turning it off" }));
  expect((await screen.findByRole("alert")).textContent).toContain("Sign in again to approve this.");
  fireEvent.click(screen.getByRole("button", { name: "Sign in again" }));
  expect(f.host.signIn).toHaveBeenCalledTimes(1);
  expect(section.getByText("Always two people", { selector: "strong" })).toBeTruthy();
 });

 it("a request that is no longer there says the setting changed and reads it again", async () => {
  const f = mount({ role: "admin", state: { alwaysTwoPeople: true, pendingLoosening: true, pending: { changeId: "chg_9", proposedByYou: false, expiresAt: EXPIRES } }, post: () => refuse(409, "CHANGE_STALE", "That proposal expired. Ask again.") });
  const section = await row();
  f.setState({ alwaysTwoPeople: true, pendingLoosening: false });
  fireEvent.click(await section.findByRole("button", { name: "Approve turning it off" }));
  expect((await screen.findByRole("alert")).textContent).toContain("This setting changed. It was read again.");
  await section.findByRole("button", { name: "Ask to turn off" });
 });

 it("says plainly that a request is waiting when the viewer is told no more than that", async () => {
  mount({ state: { alwaysTwoPeople: true, pendingLoosening: true } });
  const section = await row();
  expect(await section.findByText("A request to turn this off is waiting for a different admin.")).toBeTruthy();
  expect(section.queryByRole("button", { name: "Approve turning it off" })).toBeNull();
  expect(section.queryByRole("button", { name: "Ask to turn off" })).toBeNull();
 });

 it("sends one request even when two presses land before the page has redrawn", async () => {
  let release: (() => void) | undefined;
  const f = mount({ post: () => new Promise<ApiResponse>(resolve => { release = () => resolve({ status: 200, body: { status: "applied", alwaysTwoPeople: true, pendingLoosening: false } }); }) });
  const section = await row();
  const button = await section.findByRole("button", { name: "Require two people" });
  act(() => { button.click();button.click(); });
  await waitFor(() => expect(f.posts()).toHaveLength(1));
  f.setState({ alwaysTwoPeople: true, pendingLoosening: false });
  release?.();
  await section.findByText("Always two people", { selector: "strong" });
  expect(f.posts()).toHaveLength(1);
 });

 it("shows a refusal in the server's words and keeps the value", async () => {
  mount({ post: () => refuse(403, "FORBIDDEN", "Only a company owner or admin can change this.") });
  const section = await row();
  fireEvent.click(await section.findByRole("button", { name: "Require two people" }));
  expect((await screen.findByRole("alert")).textContent).toContain("Only a company owner or admin can change this.");
  expect(section.getByText("One maintainer may mark", { selector: "strong" })).toBeTruthy();
 });

 for (const theme of ["light", "dark"] as const) it("has an accessible row in " + theme, async () => { const f = mount({ theme, state: { alwaysTwoPeople: true, pendingLoosening: true, pending: { changeId: "chg_9", proposedByYou: false, expiresAt: EXPIRES } } }); const section = await row(); await section.findByRole("button", { name: "Approve turning it off" }); await expectNoAxeViolations(f.container); });
});
