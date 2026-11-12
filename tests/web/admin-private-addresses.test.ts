// @vitest-environment jsdom
// Owner decision 123: Settings > Internal addresses. The answers are fixtures the contract's readers accept; the server's own rules are tested in tests/contract/private-addresses-route.test.ts.
// bd's review (H1, H2, M3): a save sends the revision the edit STARTED from (a refetch never moves it), an approval sends the proposal its dialog FROZE (a refetch with another proposal disables Approve), and removals
// and turning a proposal down confirm first, with focus back on the opener.
import { afterEach, expect, it } from "vitest";
import { screen, waitFor, fireEvent, within, act } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { AppNavSchema, AppMeResponseSchema } from "@agentx/cloud-contracts/web";
import { appRoutes } from "../../packages/ui/src/routes.js";
import { AppHostProvider } from "../../packages/ui/src/host.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { ThemeProvider } from "../../packages/ui/src/theme.js";
import { PrivateAddressesAnswerReaderSchema, PrivateAddressesStateReaderSchema } from "../../packages/ui/src/api/private-addresses.js";
import { PRIVATE_ADDRESSES_TEXT as T, savedRemovingText } from "../../packages/ui/src/screens/admin/private-addresses/PrivateAddressesScreen.js";
import { visibleSections } from "../../packages/ui/src/screens/admin/admin-sections.js";
import { fakeHost } from "./support/fake-host.js";
import { renderUi } from "./support/render.js";
import { h } from "./support/h.js";
import type { ApiRequest, ApiResponse } from "../../packages/ui/src/host.js";

const PATH = "/v1/app/org/private-addresses";
const features = { localAgents: false, admin: true, usage: false, chains: false, describe: false, notices: false };
const D1 = "1".repeat(64), D2 = "2".repeat(64), D3 = "3".repeat(64);
type State = Record<string, unknown>;
const base = (over: State = {}): State => ({ revision: 2, entries: ["10.20.0.15:443"], digest: D1, max: 16, openPorts: [443, 8081], canChange: true, ...over });
const pending = (mine: boolean, over: State = {}): State => ({ changeId: "chg_1", entries: ["10.20.0.15:443", "nexus.corp.example:8081"], digest: D2, added: ["nexus.corp.example:8081"], removed: [], proposedByYou: mine, expiresAt: "2026-11-19T09:00:00.000Z", ...over });
const refusal = (status: number, code: string, message: string): ApiResponse => ({ status, body: { error: { code, message } } });
const STALE = "The list changed meanwhile. Reload and try again.";
let close: (() => void) | undefined;
const fieldValue = (): string => { const node = screen.getByLabelText(T.FIELD);if (!(node instanceof HTMLTextAreaElement)) throw new Error("not a text area");return node.value; };
afterEach(() => { close?.();close = undefined; });

/** A page over a server whose state the test can change (`live.state`), as another admin's change would. */
function mount(options: { state?: State; respond?: (request: ApiRequest) => Promise<ApiResponse | undefined>; path?: string } = {}) {
  const live = { state: base(options.state) };
  const nav = AppNavSchema.parse({ me: { developerId: "a".repeat(64), name: "Omar", orgRole: "admin" }, org: { name: "Acme" }, homeCount: 0, projects: [], shared: { agents: [], sessions: [] }, features });
  const me = AppMeResponseSchema.parse({ developer: { id: "a".repeat(64), name: "Omar", orgRole: "admin" }, org: { orgId: "org_aaaaaaaaaaaaaaaaaaaa", name: "Acme", plan: "team" }, identities: [] });
  const f = fakeHost(async request => {
    const own = await options.respond?.(request);
    if (own !== undefined) return own;
    if (request.path === "/v1/app/nav") return { status: 200, body: nav };
    if (request.path === "/v1/app/me") return { status: 200, body: me };
    if (request.path === PATH && request.method === "GET") return { status: 200, body: live.state };
    return { status: 200, body: { status: "applied", ...live.state } };
  });
  f.host.kind = "web";
  f.host.viewport = { width: () => 1280, subscribe: () => () => undefined };
  const query = createQueryClient();
  query.setQueryData(["nav"], nav);
  const router = createMemoryRouter(appRoutes(nav.features), { initialEntries: [options.path ?? "/app/admin/private-addresses"] });
  const view = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(ThemeProvider, { host: f.host, children: h(RouterProvider, { router }) }) }) }));
  close = () => { view.unmount();router.dispose();query.clear(); };
  return { ...f, live, query };
}
const posts = (f: ReturnType<typeof mount>) => f.request.mock.calls.map(([request]) => request).filter(request => request.method === "POST");
/** Another admin's change arrives: the server's state moves and the page refetches it. */
async function refetch(query: QueryClient) { await act(async () => { await query.invalidateQueries({ queryKey: ["admin", "private-addresses"] }); }); }

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
  fireEvent.change(screen.getByLabelText(T.FIELD), { target: { value: "10.20.0.15:443\n\n  nexus.corp.example:8081  \n" } });
  fireEvent.click(screen.getByRole("button", { name: T.SAVE }));
  await waitFor(() => { expect(posts(f)).toHaveLength(1); });
  expect(posts(f)[0]?.body).toEqual({ action: "propose", expectedRevision: 2, entries: ["10.20.0.15:443", "nexus.corp.example:8081"] });
  expect(await screen.findByText(T.ASKED)).toBeTruthy();
});

it("H1: a save sends the revision the edit started from, even after a refetch brought a newer list; refused, it keeps the draft and offers to discard it", async () => {
  const f = mount({ respond: async request => request.method === "POST" ? ((request.body as { expectedRevision: number }).expectedRevision === 2 ? refusal(409, "CHANGE_STALE", STALE) : undefined) : undefined });
  await screen.findByRole("heading", { name: T.TITLE, level: 1 });
  fireEvent.change(screen.getByLabelText(T.FIELD), { target: { value: "10.20.0.15:443\n10.20.0.16:443" } });
  // Another admin removed everything meanwhile: revision 3, empty list. The page refetches it.
  f.live.state = base({ revision: 3, entries: [], digest: D3 });
  await refetch(f.query);
  await screen.findByText(T.NONE);
  expect(await screen.findByText(T.EDITING_STALE)).toBeTruthy();
  // The draft is still what was typed, and the save names the revision it started from.
  expect(fieldValue()).toBe("10.20.0.15:443\n10.20.0.16:443");
  fireEvent.click(screen.getByRole("button", { name: T.SAVE }));
  await waitFor(() => { expect(posts(f)).toHaveLength(1); });
  expect(posts(f)[0]?.body).toEqual({ action: "propose", expectedRevision: 2, entries: ["10.20.0.15:443", "10.20.0.16:443"] });
  expect((await screen.findAllByRole("alert")).map(node => node.textContent).join(" ")).toContain(STALE);
  expect(fieldValue()).toBe("10.20.0.15:443\n10.20.0.16:443");
  // A second save is refused the same way (still the old revision), never a win over the newer list.
  fireEvent.click(screen.getByRole("button", { name: T.SAVE }));
  await waitFor(() => { expect(posts(f)).toHaveLength(2); });
  expect(posts(f)[1]?.body).toMatchObject({ expectedRevision: 2 });
  fireEvent.click(screen.getByRole("button", { name: T.DISCARD }));
  await waitFor(() => { expect(fieldValue()).toBe(""); });
  expect(screen.queryByText(T.EDITING_STALE)).toBeNull();
});

it("H2: Approve opens a dialog that sends the proposal it shows, frozen; a refetch with another proposal disables Approve", async () => {
  const f = mount({ state: { pending: pending(false) } });
  const card = await screen.findByRole("region", { name: T.PENDING });
  const opener = within(card).getByRole("button", { name: T.REVIEW });
  fireEvent.click(opener);
  const dialog = await screen.findByRole("dialog", { name: T.APPROVE_TITLE });
  expect(within(within(dialog).getByRole("list", { name: T.ADDS })).getByText("nexus.corp.example:8081")).toBeTruthy();
  expect(within(within(dialog).getByRole("list", { name: T.NEW_LIST })).getAllByRole("listitem")).toHaveLength(2);
  // A different proposal arrives while the dialog is open.
  f.live.state = base({ pending: pending(false, { changeId: "chg_2", digest: D3, entries: ["10.20.0.15:443", "evil.corp.example:443"], added: ["evil.corp.example:443"] }) });
  await refetch(f.query);
  expect(await within(dialog).findByText(T.PROPOSAL_CHANGED)).toBeTruthy();
  expect(within(dialog).getByRole("button", { name: T.APPROVE }).hasAttribute("disabled")).toBe(true);
  // What the dialog shows is still what was frozen.
  expect(within(dialog).queryByText("evil.corp.example:443")).toBeNull();
  fireEvent.click(within(dialog).getByRole("button", { name: T.APPROVE }));
  expect(posts(f)).toHaveLength(0);
  fireEvent.click(within(dialog).getByRole("button", { name: T.CANCEL }));
  await waitFor(() => { expect(screen.queryByRole("dialog")).toBeNull(); });
  // Focus goes back to the button that opened it (WCAG 2.4.3).
  await waitFor(() => { expect(document.activeElement?.textContent).toBe(T.REVIEW); });
  // Opened again, it freezes the new proposal and sends exactly it.
  fireEvent.click(within(await screen.findByRole("region", { name: T.PENDING })).getByRole("button", { name: T.REVIEW }));
  const again = await screen.findByRole("dialog", { name: T.APPROVE_TITLE });
  expect(within(within(again).getByRole("list", { name: T.ADDS })).getByText("evil.corp.example:443")).toBeTruthy();
  fireEvent.click(within(again).getByRole("button", { name: T.APPROVE }));
  await waitFor(() => { expect(posts(f)).toHaveLength(1); });
  expect(posts(f)[0]?.body).toEqual({ action: "approve", changeId: "chg_2", expectedDigest: D3 });
});

it("the proposer sees no approval, only Withdraw", async () => {
  mount({ state: { pending: pending(true) } });
  const mine = await screen.findByRole("region", { name: T.PENDING });
  expect(within(mine).queryByRole("button", { name: T.REVIEW })).toBeNull();
  expect(within(mine).getByRole("button", { name: T.WITHDRAW_MINE })).toBeTruthy();
});

it("M3: a save that removes anything confirms first, naming what is removed and that workers restart; the result names it too", async () => {
  const f = mount({ state: { entries: ["10.20.0.15:443", "10.20.0.16:443"] } });
  await screen.findByRole("heading", { name: T.TITLE, level: 1 });
  fireEvent.change(screen.getByLabelText(T.FIELD), { target: { value: "10.20.0.15:443" } });
  const save = screen.getByRole("button", { name: T.SAVE });
  fireEvent.click(save);
  const dialog = await screen.findByRole("dialog", { name: T.REMOVE_TITLE });
  expect(dialog.textContent).toContain(T.REMOVE_DESCRIPTION);
  expect(within(within(dialog).getByRole("list", { name: T.REMOVES })).getByText("10.20.0.16:443")).toBeTruthy();
  expect(posts(f)).toHaveLength(0);
  fireEvent.click(within(dialog).getByRole("button", { name: T.CANCEL }));
  await waitFor(() => { expect(document.activeElement).toBe(save); });
  expect(posts(f)).toHaveLength(0);
  fireEvent.click(save);
  fireEvent.click(within(await screen.findByRole("dialog", { name: T.REMOVE_TITLE })).getByRole("button", { name: T.REMOVE_CONFIRM }));
  await waitFor(() => { expect(posts(f)).toHaveLength(1); });
  expect(posts(f)[0]?.body).toEqual({ action: "propose", expectedRevision: 2, entries: ["10.20.0.15:443"] });
  expect(await screen.findByText(savedRemovingText(["10.20.0.16:443"]))).toBeTruthy();
});

it("M3: turning another admin's proposal down confirms first and sends the proposal it showed", async () => {
  const f = mount({ state: { pending: pending(false) } });
  const card = await screen.findByRole("region", { name: T.PENDING });
  fireEvent.click(within(card).getByRole("button", { name: T.WITHDRAW_OTHER }));
  const dialog = await screen.findByRole("dialog", { name: T.TURN_DOWN_TITLE });
  expect(posts(f)).toHaveLength(0);
  fireEvent.click(within(dialog).getByRole("button", { name: T.TURN_DOWN_CONFIRM }));
  await waitFor(() => { expect(posts(f)).toHaveLength(1); });
  expect(posts(f)[0]?.body).toEqual({ action: "withdraw", changeId: "chg_1" });
});

it("shows the server's refusal as it is, and a sign-in button when a fresh sign-in is needed", async () => {
  mount({ state: { pending: pending(false) }, respond: async request => request.method === "POST" ? refusal(403, "REAUTH_REQUIRED", "Sign in again to approve this.") : undefined });
  const card = await screen.findByRole("region", { name: T.PENDING });
  fireEvent.click(within(card).getByRole("button", { name: T.REVIEW }));
  fireEvent.click(within(await screen.findByRole("dialog", { name: T.APPROVE_TITLE })).getByRole("button", { name: T.APPROVE }));
  const alert = await screen.findByText("Sign in again to approve this.");
  expect(within(alert.closest("p")!).getByRole("button", { name: T.SIGN_IN_AGAIN })).toBeTruthy();
});

it("tells a viewer the server refuses that only owners and admins change it", async () => {
  mount({ respond: async request => request.path === PATH ? refusal(403, "FORBIDDEN", "Only a company owner or admin can change the internal addresses tasks may reach.") : undefined });
  expect(await screen.findByText(T.READ_ONLY)).toBeTruthy();
});

it("hides the link only where the server answers 404 (no routed private network); a 403 or 500 keeps it", async () => {
  for (const [status, hidden] of [[404, true], [403, false], [500, false], [200, false]] as const) {
    mount({ path: "/app/admin", respond: async request => request.path === PATH && status !== 200 ? refusal(status, status === 404 ? "NOT_FOUND" : status === 403 ? "FORBIDDEN" : "INTERNAL", "x") : undefined });
    const nav = await screen.findByRole("navigation", { name: "Administration" });
    expect(await within(nav).findByRole("link", { name: "Audit" })).toBeTruthy();
    if (hidden) await waitFor(() => { expect(within(nav).queryByRole("link", { name: "Internal addresses" })).toBeNull(); });
    else expect(await within(nav).findByRole("link", { name: "Internal addresses" })).toBeTruthy();
    close?.();close = undefined;
  }
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
