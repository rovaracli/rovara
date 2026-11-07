// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { screen, fireEvent, waitFor, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { AppNavSchema } from "@agentx/contracts/web";
import { appRoutes } from "../../packages/ui/src/routes.js";
import { AppHostProvider, type ApiRequest } from "../../packages/ui/src/host.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { ThemeProvider } from "../../packages/ui/src/theme.js";
import { fakeHost } from "./support/fake-host.js";
import { renderUi } from "./support/render.js";
import { expectNoAxeViolations } from "./support/axe.js";
import { h } from "./support/h.js";

// jsdom has no ResizeObserver, which the checkbox inside a form measures with.
globalThis.ResizeObserver ??= class { observe(): void { /* none */ } unobserve(): void { /* none */ } disconnect(): void { /* none */ } };

// UX5b: the Script tokens screen. It is in the menu only where the switch is on; it lists tokens (name, visible start, projects, permissions, expiry, last used), makes one and
// shows it once, and revokes one after asking.

const PATH = "/v1/app/script-tokens";
const base = { localAgents: false, admin: false, usage: false, chains: false, describe: false, notices: false };
const when = "2026-11-07T09:00:00.000Z";
const later = "2026-12-07T09:00:00.000Z";
// A fake token, built at run time so nothing token-shaped is in the source.
const fakeSecret = () => `rvst_${"a".repeat(20)}_${"b".repeat(20)}_${"C".repeat(43)}`;
const row = (overrides: Record<string, unknown> = {}) => ({
 tokenId: "stk_bbbbbbbbbbbbbbbbbbbb", name: "Deploy job", hint: "rvst_…bbbbbbbb", projects: ["payments"], permissions: ["read", "start"], createdAt: when, expiresAt: later, status: "active", mine: true, ...overrides,
});

function mount(options: { on?: boolean; tokens?: Array<Record<string, unknown>> } = {}) {
 const features = options.on === false ? base : { ...base, scriptTokens: true as const };
 const nav = AppNavSchema.parse({ me: { developerId: "a".repeat(64), name: "Priya", orgRole: "member" }, org: { name: "Acme" }, homeCount: 0, projects: [{ name: "payments", agents: [] }, { name: "web", agents: [] }], shared: { agents: [], sessions: [] }, features });
 let tokens = options.tokens ?? [];
 const f = fakeHost(async (request: ApiRequest) => {
  const path = request.path.split("?")[0];
  if (path === "/v1/app/nav") return { status: 200, body: nav };
  if (path === PATH && request.method === "GET") return { status: 200, body: { tokens } };
  if (path === PATH && request.method === "POST") {
   const body = request.body as { name: string; projects: string[]; permissions: string[] };
   const made = row({ tokenId: "stk_cccccccccccccccccccc", hint: "rvst_…cccccccc", name: body.name, projects: body.projects, permissions: body.permissions });
   tokens = [made, ...tokens];
   return { status: 201, body: { token: made, secret: fakeSecret() } };
  }
  if (path?.startsWith(`${PATH}/`) && request.method === "DELETE") {
   tokens = tokens.map(token => (token.tokenId === path.slice(PATH.length + 1) ? { ...token, status: "revoked", revokedAt: when } : token));
   return { status: 200, body: { token: tokens[0] } };
  }
  return { status: 404, body: { error: { code: "NOT_FOUND", message: "Not found." } } };
 });
 f.host.kind = "web";f.host.origin = "https://cell.example";
 const query = createQueryClient();query.setQueryData(["nav"], nav);
 const router = createMemoryRouter(appRoutes(nav.features), { initialEntries: ["/app/settings/script-tokens"] });
 const view = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(ThemeProvider, { host: f.host, children: h(RouterProvider, { router }) }) }) }));
 const calls = () => f.request.mock.calls.map(([request]) => request);
 return { ...f, ...view, posts: () => calls().filter(request => request.method === "POST"), deletes: () => calls().filter(request => request.method === "DELETE") };
}
afterEach(() => { document.body.innerHTML = ""; });

describe("Script tokens", () => {
 it("is a menu link and a page only while the switch is on", async () => {
  mount();
  expect((await screen.findAllByRole("link", { name: "Script tokens" }))[0]!.getAttribute("href")).toBe("/app/settings/script-tokens");
  expect(await screen.findByRole("heading", { name: "Script tokens", level: 1 })).toBeTruthy();
  document.body.innerHTML = "";
  mount({ on: false });
  await waitFor(() => expect(screen.queryByRole("heading", { name: "Script tokens", level: 1 })).toBeNull());
  expect(screen.queryByRole("link", { name: "Script tokens" })).toBeNull();
 });

 it("lists a token's name, visible start, projects, permissions, expiry and last use, never more of it", async () => {
  mount({ tokens: [row({ lastUsedAt: when }), row({ tokenId: "stk_dddddddddddddddddddd", name: "Old job", hint: "rvst_…dddddddd", status: "revoked", revokedAt: when, mine: false, createdBy: "Omar" })] });
  const item = within(await screen.findByRole("listitem", { name: "Deploy job" }));
  expect(item.getByText("rvst_…bbbbbbbb")).toBeTruthy();
  expect(item.getByText("payments")).toBeTruthy();
  expect(item.getByText("Read tasks, Start tasks")).toBeTruthy();
  expect(item.getByText(/Active, expires Dec 7, 2026 UTC/u)).toBeTruthy();
  expect(item.getByText("Nov 7, 2026 UTC")).toBeTruthy();
  const old = within(screen.getByRole("listitem", { name: "Old job" }));
  expect(old.getByText("Omar")).toBeTruthy();
  expect(old.queryByRole("button", { name: "Revoke" })).toBeNull();
  await expectNoAxeViolations(document.body);
 });

 it("makes a token with the chosen name, projects, permissions and life, and shows it once", async () => {
  const f = mount();
  fireEvent.change(await screen.findByLabelText("Name"), { target: { value: "CI deploy" } });
  const make = screen.getByRole<HTMLButtonElement>("button", { name: "Make token" });
  expect(make.disabled).toBe(true);
  fireEvent.click(screen.getByRole("checkbox", { name: "payments" }));
  fireEvent.click(screen.getByRole("checkbox", { name: "Start tasks" }));
  fireEvent.change(screen.getByLabelText("Expires after"), { target: { value: "90" } });
  fireEvent.click(make);
  await waitFor(() => expect(f.posts()).toHaveLength(1));
  expect(f.posts()[0]).toMatchObject({ path: PATH, body: { name: "CI deploy", projects: ["payments"], permissions: ["read", "start"], days: 90 } });
  expect((f.posts()[0]!.body as { requestId?: unknown }).requestId).toEqual(expect.stringMatching(/^[0-9a-f-]{36}$/u));
  const dialog = within(await screen.findByRole("dialog", { name: "Copy your token now" }));
  expect(dialog.getByLabelText<HTMLInputElement>("Token").value).toBe(fakeSecret());
  fireEvent.click(dialog.getByRole("button", { name: "Done" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(document.body.innerHTML).not.toContain(fakeSecret());
  expect(await screen.findByRole("listitem", { name: "CI deploy" })).toBeTruthy();
 });

 it("revokes a token after asking", async () => {
  const f = mount({ tokens: [row()] });
  fireEvent.click(within(await screen.findByRole("listitem", { name: "Deploy job" })).getByRole("button", { name: "Revoke" }));
  expect(f.deletes()).toHaveLength(0);
  fireEvent.click(within(await screen.findByRole("dialog", { name: "Revoke this token?" })).getByRole("button", { name: "Revoke token" }));
  await waitFor(() => expect(f.deletes()).toHaveLength(1));
  expect(f.deletes()[0]).toMatchObject({ path: `${PATH}/stk_bbbbbbbbbbbbbbbbbbbb` });
  expect(await screen.findByText(/^Revoked/u)).toBeTruthy();
 });
});
