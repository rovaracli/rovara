// @vitest-environment jsdom
// LT-2 (lessons leftovers sweep): the company's lessons setting on the company How we work page: the preset in force, a way to require a person for every lesson in every project, and the
// approve / cancel of a proposal to go back to Standard. Only an owner or admin sees it; the server decides again on every tap.
import { afterEach, describe, expect, it } from "vitest";
import { screen, fireEvent, waitFor, within } from "@testing-library/react";
import { createMemoryRouter, Outlet, RouterProvider } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { appRoutes } from "../../packages/ui/src/routes.js";
import { AppHostProvider, type ApiRequest, type ApiResponse } from "../../packages/ui/src/host.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { ThemeProvider } from "../../packages/ui/src/theme.js";
import { fakeHost } from "./support/fake-host.js";
import { renderUi } from "./support/render.js";
import { h } from "./support/h.js";
import { navFixture, meFixture } from "./support/fixtures.js";
import { companyPolicyRaw } from "./support/company-policy-raw.js";
import LessonsPresetRow from "../../packages/ui/src/screens/admin/how-we-work/LessonsPresetRow.js";

const COMPANY = "/v1/app/org/lessons/preset";
const POLICY = "/v1/app/org/model-selection-policy";
const proposal = (over: Record<string, unknown> = {}) => ({ changeId: "chg-9", to: "standard", mine: false, soleOwner: false, expiresAt: Date.now() + 86_400_000, ...over });
type Doc = { preset: "standard" | "regulated"; proposal?: ReturnType<typeof proposal> };

function mount(options: { doc?: Doc; role?: string; routed?: boolean; answer?: (request: ApiRequest) => ApiResponse | undefined } = {}) {
 const state: { doc: Doc } = { doc: options.doc ?? { preset: "standard" } };
 const me = meFixture();me.developer.orgRole = (options.role ?? "owner") as typeof me.developer.orgRole;
 const nav = navFixture({ me: { developerId: me.developer.id, name: "Priya", orgRole: options.role === "member" ? "member" : "owner" }, features: { localAgents: false, admin: true, usage: false, chains: false, describe: false, notices: false } });
 const f = fakeHost(async request => {
  if (request.path === "/v1/app/me") return { status: 200, body: structuredClone(me) };
  if (request.path === "/v1/app/nav") return { status: 200, body: nav };
  if (request.path === COMPANY || request.path.startsWith(COMPANY + "/")) return options.answer?.(request) ?? (request.method === "GET" ? { status: 200, body: structuredClone(state.doc) } : { status: 200, body: { done: true } });
  if (request.path === POLICY) return { status: 200, body: companyPolicyRaw() };
  if (request.path === "/v1/app/org/model-sources") return { status: 200, body: { sources: [], order: ["rovara"] } };
  return { status: 404, body: { error: { code: "NOT_FOUND", message: "Not found." } } };
 });
 const query = createQueryClient();query.setQueryData(["nav"], nav);
 const context = { orgId: "org_aaaaaaaaaaaaaaaaaaaa", company: "Acme", developerId: me.developer.id, role: options.role ?? "owner", checking: false };
 const router = createMemoryRouter(options.routed === true ? appRoutes(nav.features) : [{ path: "/", element: h(Outlet, { context }), children: [{ index: true, element: h(LessonsPresetRow, {}) }] }], { initialEntries: [options.routed === true ? "/app/admin/how-we-work" : "/"] });
 const view = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(ThemeProvider, { host: f.host, children: h(RouterProvider, { router }) }) }) }));
 const calls = () => f.request.mock.calls.map(([request]) => request).filter(request => request.path.startsWith(COMPANY));
 return { ...f, ...view, state, calls, writes: () => calls().filter(request => request.method !== "GET"), close() { view.unmount();router.dispose();query.clear(); } };
}
const box = () => screen.findByRole("region", { name: "Lessons: company setting" });
afterEach(() => { document.body.innerHTML = ""; });

describe("the company's lessons setting", () => {
 it("is on the company How we work page for an owner", async () => {
  const f = mount({ routed: true });
  await screen.findByRole("heading", { name: /How we work/u });
  expect(within(await box()).getByText(/Standard: a low-risk lesson/u)).toBeTruthy();
  f.close();
 });
 it("shows Standard with a button that requires a person for every lesson in every project, and sends Regulated once", async () => {
  const f = mount({ role: "admin", answer: request => request.method === "POST" ? { status: 200, body: { preset: "regulated", changed: true } } : undefined });
  const region = await box();
  fireEvent.click(within(region).getByRole("button", { name: "Require a person for every lesson in every project" }));
  await screen.findByText("Saved. Every lesson in every project now waits for a person.");
  expect(f.writes().map(request => [request.method, request.path, request.body])).toEqual([["POST", COMPANY, { preset: "regulated" }]]);
  f.close();
 });
 it("under Regulated, going back asks a different owner or admin", async () => {
  const f = mount({ doc: { preset: "regulated" }, answer: request => request.method === "POST" ? { status: 200, body: { preset: "regulated", changed: false, needsApproval: true, changeId: "chg-9" } } : undefined });
  const region = await box();
  expect(within(region).getByText(/Regulated: every lesson in every project waits for a person/u)).toBeTruthy();
  fireEvent.click(within(region).getByRole("button", { name: "Allow lessons on trial again" }));
  await screen.findByText(/A different owner or admin has to approve going back to Standard/u);
  expect(f.writes().map(request => request.body)).toEqual([{ preset: "standard" }]);
  f.close();
 });
 it("another owner or admin sees the waiting request and approves it (the change id goes to the company approve route)", async () => {
  const f = mount({ doc: { preset: "regulated", proposal: proposal() }, answer: request => request.method === "POST" ? { status: 200, body: { preset: "standard", changed: true } } : undefined });
  const region = await box();
  expect(within(region).getByText(/Someone asked to allow lessons on trial again/u)).toBeTruthy();
  expect(within(region).queryByRole("button", { name: "Allow lessons on trial again" })).toBeNull();
  fireEvent.click(within(region).getByRole("button", { name: "Approve going back to Standard" }));
  await screen.findByText(/Approved\. Low-risk lessons from a team member's correction go live on trial again/u);
  expect(f.writes().map(request => [request.path, request.body])).toEqual([[COMPANY + "/approve", { changeId: "chg-9" }]]);
  f.close();
 });
 it("cancel goes to the company cancel route", async () => {
  const f = mount({ doc: { preset: "regulated", proposal: proposal({ mine: true }) } });
  const region = await box();
  expect(within(region).getByText(/You asked to allow lessons on trial again\. A different owner or admin has to approve it/u)).toBeTruthy();
  expect(within(region).queryByRole("button", { name: "Approve going back to Standard" })).toBeNull();
  fireEvent.click(within(region).getByRole("button", { name: "Cancel the request" }));
  await screen.findByText(/Cancelled\. Every lesson still waits for a person/u);
  expect(f.writes().map(request => [request.path, request.body])).toEqual([[COMPANY + "/cancel", { changeId: "chg-9" }]]);
  f.close();
 });
 it("shows a refusal in the server's words", async () => {
  const f = mount({ doc: { preset: "regulated", proposal: proposal() }, answer: request => request.method === "POST" ? { status: 403, body: { error: { code: "FORBIDDEN", message: "A different maintainer or admin has to approve going back to Standard." } } } : undefined });
  fireEvent.click(within(await box()).getByRole("button", { name: "Approve going back to Standard" }));
  expect((await screen.findByRole("alert")).textContent).toContain("A different maintainer or admin has to approve");
  f.close();
 });
 it("a member gets nothing: no box, and no read of the company setting", async () => {
  const f = mount({ role: "member" });
  await waitFor(() => expect(f.request).toBeDefined());
  expect(screen.queryByRole("region", { name: "Lessons: company setting" })).toBeNull();
  expect(f.calls()).toHaveLength(0);
  f.close();
 });
 it("an install without lessons (the route is not there) shows nothing", async () => {
  const f = mount({ answer: () => ({ status: 404, body: { error: { code: "NOT_FOUND", message: "Not found." } } }) });
  await waitFor(() => expect(f.calls().length).toBeGreaterThan(0));
  expect(screen.queryByRole("region", { name: "Lessons: company setting" })).toBeNull();
  f.close();
 });
});
