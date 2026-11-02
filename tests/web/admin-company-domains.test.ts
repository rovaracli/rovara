// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { screen, fireEvent, waitFor, within } from "@testing-library/react";
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

// The owner-only Company domains page: the record to publish, check now, remove after confirming, and a fresh sign-in asked for in words.

const PATH = "/v1/app/org/domains";
const features = { localAgents: false, admin: true, usage: false, chains: false, describe: false, notices: false };
const TOKEN = "c".repeat(40);
const when = "2026-11-02T09:00:00.000Z";
const view = (overrides: Record<string, unknown> = {}) => ({
 domain: "acme.example", state: "pending", addedAt: when,
 record: { type: "TXT", name: "_rovara-verify.acme.example", value: `rovara-verify=${TOKEN}` }, ...overrides,
});
const refuse = (status: number, code: string, message: string) => ({ status, body: { error: { code, message } } });
type Handler = (request: ApiRequest) => ApiResponse | undefined | Promise<ApiResponse | undefined>;

function mount(options: { role?: "owner" | "admin"; domains?: Array<Record<string, unknown>>; post?: Handler } = {}) {
 const role = options.role ?? "owner";
 const nav = AppNavSchema.parse({ me: { developerId: "a".repeat(64), name: "Priya", orgRole: role }, org: { name: "Acme" }, homeCount: 0, projects: [], shared: { agents: [], sessions: [] }, features });
 const me = AppMeResponseSchema.parse({ developer: { id: "a".repeat(64), name: "Priya", orgRole: role }, org: { orgId: "org_aaaaaaaaaaaaaaaaaaaa", name: "Acme", plan: "team" }, identities: [] });
 let domains = options.domains ?? [];
 const f = fakeHost(async request => {
  const path = request.path.split("?")[0];
  if (path === "/v1/app/nav") return { status: 200, body: nav };
  if (path === "/v1/app/me") return { status: 200, body: me };
  if (path === PATH && request.method === "GET") return { status: 200, body: { domains, max: 20, lostAfterDays: 3 } };
  if (path?.startsWith(PATH) && request.method === "POST") {
   const custom = await options.post?.(request);
   if (custom !== undefined) return custom;
   const body = request.body as { domain: string };
   if (path === PATH) { const added = view({ domain: body.domain }); domains = [...domains, added]; return { status: 200, body: { domain: added } }; }
   if (path === `${PATH}/check`) { const found = domains.find(entry => entry.domain === body.domain)!; return { status: 200, body: { domain: found, result: "not_found" } }; }
   if (path === `${PATH}/remove`) { domains = domains.filter(entry => entry.domain !== body.domain); return { status: 200, body: { removed: true } }; }
  }
  return { status: 404, body: { error: { code: "NOT_FOUND", message: "Not found." } } };
 });
 f.host.kind = "web";f.host.origin = "https://cell.example";
 const query = createQueryClient();query.setQueryData(["nav"], nav);
 const router = createMemoryRouter(appRoutes(nav.features), { initialEntries: ["/app/admin/domains"] });
 const view_ = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(ThemeProvider, { host: f.host, children: h(RouterProvider, { router }) }) }) }));
 const calls = () => f.request.mock.calls.map(([request]) => request);
 return { ...f, ...view_, posts: () => calls().filter(request => request.method === "POST"), reads: () => calls().filter(request => request.method === "GET" && request.path === PATH) };
}
afterEach(() => { document.body.innerHTML = ""; });

describe("Company domains", () => {
 it("is in the admin navigation for an owner and not for an admin, who is told in words", async () => {
  mount();
  expect((await screen.findByRole("link", { name: "Company domains" })).getAttribute("href")).toBe("/app/admin/domains");
  document.body.innerHTML = "";
  mount({ role: "admin" });
  expect(await screen.findByText("Only a company owner can see or change company domains.")).toBeTruthy();
  expect(screen.queryByRole("link", { name: "Company domains" })).toBeNull();
 });

 it("shows the record to publish for an unverified domain, in plain words", async () => {
  mount({ domains: [view()] });
  const item = within(await screen.findByRole("listitem", { name: "acme.example" }));
  expect(item.getByText("Not verified yet")).toBeTruthy();
  expect(item.getByText("TXT")).toBeTruthy();
  expect(item.getByText("_rovara-verify.acme.example")).toBeTruthy();
  expect(item.getByText(`rovara-verify=${TOKEN}`)).toBeTruthy();
 });

 it("shows a verified domain without the record, and a lost one with it and the way back", async () => {
  mount({ domains: [view({ domain: "ok.example", state: "verified", verifiedAt: when }), view({ domain: "gone.example", state: "lost", lostAt: when })] });
  const ok = within(await screen.findByRole("listitem", { name: "ok.example" }));
  expect(ok.getByText("Verified")).toBeTruthy();
  expect(ok.queryByText("TXT")).toBeNull();
  const gone = within(screen.getByRole("listitem", { name: "gone.example" }));
  expect(gone.getByText("Lost")).toBeTruthy();
  expect(gone.getByText(/Put the record back and press Check now/u)).toBeTruthy();
  expect(gone.getByText("TXT")).toBeTruthy();
 });

 it("says when a verified domain's record has gone missing and how long it has", async () => {
  mount({ domains: [view({ domain: "ok.example", state: "verified", verifiedAt: when, missingSince: "2026-11-01T09:00:00.000Z" })] });
  expect(await screen.findByText(/has not been found since Nov 1, 2026 UTC/u)).toBeTruthy();
  expect(screen.getByText(/lost if it stays gone for 3 days in a row/u)).toBeTruthy();
 });

 it("adds a domain with the exact body, shows its record, and clears the field", async () => {
  const f = mount();
  fireEvent.change(await screen.findByLabelText("Domain"), { target: { value: "Acme.Example" } });
  fireEvent.click(screen.getByRole("button", { name: "Add domain" }));
  await waitFor(() => expect(f.posts()).toHaveLength(1));
  expect(f.posts()[0]).toMatchObject({ path: PATH, body: { domain: "Acme.Example" } });
  expect(await screen.findByRole("listitem", { name: "Acme.Example" })).toBeTruthy();
  expect(screen.getByLabelText<HTMLInputElement>("Domain").value).toBe("");
 });

 it("sends no add for an empty field", async () => {
  const f = mount();
  expect((await screen.findByRole<HTMLButtonElement>("button", { name: "Add domain" })).disabled).toBe(true);
  expect(f.posts()).toHaveLength(0);
 });

 it("shows the server's sentence for a refused domain", async () => {
  mount({ post: () => refuse(400, "CONFIG_INVALID", "An IP address is not a company domain.") });
  fireEvent.change(await screen.findByLabelText("Domain"), { target: { value: "10.0.0.1" } });
  fireEvent.click(screen.getByRole("button", { name: "Add domain" }));
  expect((await screen.findByRole("alert")).textContent).toContain("An IP address is not a company domain.");
 });

 it("asks for a fresh sign-in in words and offers to sign in", async () => {
  const f = mount({ post: () => refuse(403, "REAUTH_REQUIRED", "Sign in again to change company domains.") });
  fireEvent.change(await screen.findByLabelText("Domain"), { target: { value: "acme.example" } });
  fireEvent.click(screen.getByRole("button", { name: "Add domain" }));
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain("Sign in again to change company domains.");
  fireEvent.click(within(alert).getByRole("button", { name: "Sign in again" }));
  expect(f.host.signIn).toHaveBeenCalledTimes(1);
 });

 it("checks now and says what the look found", async () => {
  const f = mount({ domains: [view()] });
  fireEvent.click(within(await screen.findByRole("listitem", { name: "acme.example" })).getByRole("button", { name: "Check now" }));
  await waitFor(() => expect(f.posts()).toHaveLength(1));
  expect(f.posts()[0]).toMatchObject({ path: `${PATH}/check`, body: { domain: "acme.example" } });
  expect(await screen.findByText(/The record was not found/u)).toBeTruthy();
 });

 it("removes only after the owner confirms, and Cancel sends nothing", async () => {
  const f = mount({ domains: [view()] });
  const item = within(await screen.findByRole("listitem", { name: "acme.example" }));
  fireEvent.click(item.getByRole("button", { name: "Remove" }));
  const dialog = within(await screen.findByRole("dialog"));
  expect(dialog.getByText("Remove this domain?")).toBeTruthy();
  fireEvent.click(dialog.getByRole("button", { name: "Cancel" }));
  expect(f.posts()).toHaveLength(0);
  fireEvent.click(item.getByRole("button", { name: "Remove" }));
  fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Remove domain" }));
  await waitFor(() => expect(f.posts()).toHaveLength(1));
  expect(f.posts()[0]).toMatchObject({ path: `${PATH}/remove`, body: { domain: "acme.example" } });
  await waitFor(() => expect(screen.queryByRole("listitem", { name: "acme.example" })).toBeNull());
 });

 it("has no accessibility violations with a domain listed", async () => {
  const { container } = mount({ domains: [view()] });
  await screen.findByRole("listitem", { name: "acme.example" });
  await expectNoAxeViolations(container);
 });
});
