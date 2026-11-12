// @vitest-environment jsdom
// Owner decision 123: Settings > Internal addresses. The answers are fixtures the contract's readers accept; the server's own rules are tested in tests/contract/private-addresses-route.test.ts.
import { afterEach, expect, it } from "vitest";
import { screen, waitFor, fireEvent, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { AppNavSchema, AppMeResponseSchema } from "@agentx/cloud-contracts/web";
import { appRoutes } from "../../packages/ui/src/routes.js";
import { AppHostProvider } from "../../packages/ui/src/host.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { ThemeProvider } from "../../packages/ui/src/theme.js";
import { PrivateAddressesAnswerReaderSchema, PrivateAddressesStateReaderSchema } from "../../packages/ui/src/api/private-addresses.js";
import { PRIVATE_ADDRESSES_TEXT as T } from "../../packages/ui/src/screens/admin/private-addresses/PrivateAddressesScreen.js";
import { visibleSections } from "../../packages/ui/src/screens/admin/admin-sections.js";
import { fakeHost } from "./support/fake-host.js";
import { renderUi } from "./support/render.js";
import { h } from "./support/h.js";
import type { ApiRequest, ApiResponse } from "../../packages/ui/src/host.js";

const PATH = "/v1/app/org/private-addresses";
const features = { localAgents: false, admin: true, usage: false, chains: false, describe: false, notices: false };
const D1 = "1".repeat(64), D2 = "2".repeat(64);
type State = Record<string, unknown>;
const base = (over: State = {}): State => ({ revision: 2, entries: ["10.20.0.15:443"], digest: D1, max: 16, openPorts: [443, 8081], canChange: true, ...over });
const pending = (mine: boolean): State => ({ changeId: "chg_1", entries: ["10.20.0.15:443", "nexus.corp.example:8081"], digest: D2, added: ["nexus.corp.example:8081"], removed: [], proposedByYou: mine, expiresAt: "2026-11-19T09:00:00.000Z" });
const refusal = (status: number, code: string, message: string): ApiResponse => ({ status, body: { error: { code, message } } });
let close: (() => void) | undefined;
afterEach(() => { close?.();close = undefined; });

function mount(options: { state?: State; respond?: (request: ApiRequest) => Promise<ApiResponse | undefined>; path?: string } = {}) {
  const nav = AppNavSchema.parse({ me: { developerId: "a".repeat(64), name: "Omar", orgRole: "admin" }, org: { name: "Acme" }, homeCount: 0, projects: [], shared: { agents: [], sessions: [] }, features });
  const me = AppMeResponseSchema.parse({ developer: { id: "a".repeat(64), name: "Omar", orgRole: "admin" }, org: { orgId: "org_aaaaaaaaaaaaaaaaaaaa", name: "Acme", plan: "team" }, identities: [] });
  const f = fakeHost(async request => {
    const own = await options.respond?.(request);
    if (own !== undefined) return own;
    if (request.path === "/v1/app/nav") return { status: 200, body: nav };
    if (request.path === "/v1/app/me") return { status: 200, body: me };
    if (request.path === PATH && request.method === "GET") return { status: 200, body: base(options.state) };
    return { status: 200, body: { status: "applied", ...base(options.state) } };
  });
  f.host.kind = "web";
  f.host.viewport = { width: () => 1280, subscribe: () => () => undefined };
  const query = createQueryClient();
  query.setQueryData(["nav"], nav);
  const router = createMemoryRouter(appRoutes(nav.features), { initialEntries: [options.path ?? "/app/admin/private-addresses"] });
  const view = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(ThemeProvider, { host: f.host, children: h(RouterProvider, { router }) }) }) }));
  close = () => { view.unmount();router.dispose();query.clear(); };
  return f;
}
const posts = (f: ReturnType<typeof mount>) => f.request.mock.calls.map(([request]) => request).filter(request => request.method === "POST");

it("the fixtures are shapes the readers accept, and the page is listed under Security and sign-in", () => {
  expect(PrivateAddressesStateReaderSchema.safeParse(base({ pending: pending(false), futureField: 1 })).success).toBe(true);
  expect(PrivateAddressesAnswerReaderSchema.safeParse({ status: "needs_approval", changeId: "chg_1", ...base({ pending: pending(true) }) }).success).toBe(true);
  const security = visibleSections("admin", false).find(section => section.id === "security");
  expect(security?.items.map(item => item.to)).toContain("/app/admin/private-addresses");
  // Review H1: not offered on an install with no route to a private network (the read answers 404 there).
  expect(visibleSections("admin", false, false, false, false, true).flatMap(section => section.items.map(item => item.to))).not.toContain("/app/admin/private-addresses");
});

it("shows the approved list and sends the whole edited list, one entry per line", async () => {
  const f = mount({ respond: async request => request.method === "POST" ? { status: 202, body: { status: "needs_approval", changeId: "chg_1", ...base({ pending: pending(true) }) } } : undefined });
  await screen.findByRole("heading", { name: T.TITLE, level: 1 });
  expect(within(screen.getByRole("list", { name: T.CURRENT })).getByText("10.20.0.15:443")).toBeTruthy();
  const field = screen.getByLabelText(T.FIELD);
  fireEvent.change(field, { target: { value: "10.20.0.15:443\n\n  nexus.corp.example:8081  \n" } });
  fireEvent.click(screen.getByRole("button", { name: T.SAVE }));
  await waitFor(() => { expect(posts(f)).toHaveLength(1); });
  expect(posts(f)[0]?.body).toEqual({ action: "propose", expectedRevision: 2, entries: ["10.20.0.15:443", "nexus.corp.example:8081"] });
  expect(await screen.findByText(T.ASKED)).toBeTruthy();
});

it("offers another admin's proposal for approval with the digest shown, and never the proposer's own", async () => {
  const f = mount({ state: { pending: pending(false) } });
  const card = await screen.findByRole("region", { name: T.PENDING });
  expect(within(within(card).getByRole("list", { name: T.ADDS })).getByText("nexus.corp.example:8081")).toBeTruthy();
  fireEvent.click(within(card).getByRole("button", { name: T.APPROVE }));
  await waitFor(() => { expect(posts(f)).toHaveLength(1); });
  expect(posts(f)[0]?.body).toEqual({ action: "approve", changeId: "chg_1", expectedDigest: D2 });
  close?.();
  mount({ state: { pending: pending(true) } });
  const mine = await screen.findByRole("region", { name: T.PENDING });
  expect(within(mine).queryByRole("button", { name: T.APPROVE })).toBeNull();
  expect(within(mine).getByRole("button", { name: T.WITHDRAW_MINE })).toBeTruthy();
});

it("shows the server's refusal as it is, and a sign-in button when a fresh sign-in is needed", async () => {
  mount({ state: { pending: pending(false) }, respond: async request => request.method === "POST" ? refusal(403, "REAUTH_REQUIRED", "Sign in again to approve this.") : undefined });
  const card = await screen.findByRole("region", { name: T.PENDING });
  fireEvent.click(within(card).getByRole("button", { name: T.APPROVE }));
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain("Sign in again to approve this.");
  expect(within(alert).getByRole("button", { name: T.SIGN_IN_AGAIN })).toBeTruthy();
});

it("tells a viewer the server refuses that only owners and admins change it", async () => {
  mount({ respond: async request => request.path === PATH ? refusal(403, "FORBIDDEN", "Only a company owner or admin can change the internal addresses tasks may reach.") : undefined });
  expect(await screen.findByText(T.READ_ONLY)).toBeTruthy();
});

it("hides the link where the server answers 404 (no routed private network), and shows it where it answers", async () => {
  mount({ path: "/app/admin", respond: async request => request.path === PATH ? refusal(404, "NOT_FOUND", "none") : undefined });
  const nav = await screen.findByRole("navigation", { name: "Administration" });
  await waitFor(() => { expect(within(nav).queryByRole("link", { name: "Internal addresses" })).toBeNull(); });
  expect(within(nav).getByRole("link", { name: "Audit" })).toBeTruthy();
  close?.();
  mount({ path: "/app/admin" });
  const shown = await screen.findByRole("navigation", { name: "Administration" });
  expect(await within(shown).findByRole("link", { name: "Internal addresses" })).toBeTruthy();
});

it("shows the open ports, a list that can't be read, and the warnings an answer carries", async () => {
  mount({ state: { unreadable: true }, respond: async request => request.method === "POST" ? { status: 202, body: { status: "needs_approval", changeId: "chg_1", ...base({ pending: pending(true) }), warnings: ["Entry 2 is a name that is not on this install's allowed websites, so tasks may not be able to look it up."] } } : undefined });
  await screen.findByRole("heading", { name: T.TITLE, level: 1 });
  expect(screen.getByText(`${T.PORTS} 443, 8081.`)).toBeTruthy();
  expect(screen.getByRole("alert").textContent).toContain(T.UNREADABLE);
  fireEvent.change(screen.getByLabelText(T.FIELD), { target: { value: "10.20.0.15:443\nnexus.corp.example:8081" } });
  fireEvent.click(screen.getByRole("button", { name: T.SAVE }));
  const warnings = await screen.findByRole("region", { name: T.WARNINGS });
  expect(warnings.textContent).toContain("Entry 2 is a name that is not on this install's allowed websites");
});
