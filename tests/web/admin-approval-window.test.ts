// @vitest-environment jsdom
// Lane exp/approval-window: Settings > Recent sign-in window. Every answer is a fixture shaped by briefs/approval-place-api.md section 2; the server is built in parallel.
import { expect, it } from "vitest";
import { screen, waitFor, fireEvent, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { AppNavSchema, AppMeResponseSchema } from "@agentx/cloud-contracts/web";
import { appRoutes } from "../../packages/ui/src/routes.js";
import { AppHostProvider } from "../../packages/ui/src/host.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { ThemeProvider } from "../../packages/ui/src/theme.js";
import { ApprovalWindowAnswerReaderSchema, ApprovalWindowBodySchema, ApprovalWindowStateReaderSchema } from "../../packages/ui/src/api/approval-window.js";
import { durationWords, policyRows, windowChoices } from "../../packages/ui/src/screens/admin/approval-window/approval-window-text.js";
import { visibleSections } from "../../packages/ui/src/screens/admin/admin-sections.js";
import { fakeHost } from "./support/fake-host.js";
import { renderUi } from "./support/render.js";
import { h } from "./support/h.js";
import type { ApiRequest, ApiResponse } from "../../packages/ui/src/host.js";

const asSelect = (node: HTMLElement): HTMLSelectElement => { if (!(node instanceof HTMLSelectElement)) throw new Error("not a select"); return node; };
const asButton = (node: HTMLElement): HTMLButtonElement => { if (!(node instanceof HTMLButtonElement)) throw new Error("not a button"); return node; };
const PATH = "/v1/app/org/approval-window";
const features = { localAgents: false, admin: true, usage: false, chains: false, describe: false, notices: false };
const HOUR = 3600, DAY = 86400;
type State = Record<string, unknown>;
const base = (over: State = {}): State => ({ revision: 3, seconds: DAY, isDefault: true, defaultSeconds: DAY, minSeconds: HOUR, maxSeconds: 7 * DAY, canChange: true, unreadable: false, ...over });
const pending = (mine: boolean, seconds = 3 * DAY) => ({ changeId: "chg_0123456789", seconds, proposedByYou: mine, expiresAt: "2026-11-18T09:00:00.000Z" });
const refusal = (status: number, code: string, message: string): ApiResponse => ({ status, body: { error: { code, message } } });

function mount(options: { state?: State; respond?: (request: ApiRequest) => Promise<ApiResponse | undefined>; role?: "owner" | "admin"; off?: boolean } = {}) {
  const role = options.role ?? "admin", current: { state: State } = { state: base(options.state) };
  const nav = AppNavSchema.parse({ me: { developerId: "a".repeat(64), name: "Omar", orgRole: role }, org: { name: "Acme" }, homeCount: 0, projects: [], shared: { agents: [], sessions: [] }, features });
  const me = AppMeResponseSchema.parse({ developer: { id: "a".repeat(64), name: "Omar", orgRole: role }, org: { orgId: "org_aaaaaaaaaaaaaaaaaaaa", name: "Acme", plan: "team" }, identities: [] });
  const f = fakeHost(async request => {
    const own = await options.respond?.(request);
    if (own !== undefined) return own;
    if (request.path === "/v1/app/nav") return { status: 200, body: nav };
    if (request.path === "/v1/app/me") return { status: 200, body: me };
    if (request.path === PATH && options.off === true) return refusal(404, "NOT_FOUND", "none");
    if (request.path === PATH && request.method === "GET") return { status: 200, body: current.state };
    return { status: 200, body: { status: "applied", ...current.state } };
  });
  f.host.kind = "web";
  f.host.viewport = { width: () => 1280, subscribe: () => () => undefined };
  const query = createQueryClient();
  query.setQueryData(["nav"], nav);
  const router = createMemoryRouter(appRoutes(nav.features), { initialEntries: ["/app/admin/approval-window"] });
  const view = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(ThemeProvider, { host: f.host, children: h(RouterProvider, { router }) }) }) }));
  return { ...f, ...view, current, router, query, close: () => { view.unmount();router.dispose();query.clear(); } };
}
const posts = (f: ReturnType<typeof mount>) => f.request.mock.calls.map(([request]) => request).filter(request => request.method === "POST");
const optionValues = (select: HTMLElement) => within(select).getAllByRole("option").map(option => option.getAttribute("value")).filter(value => value !== "");

it("the fixtures are shapes the readers accept, and the body schema refuses what the doc refuses", () => {
  expect(ApprovalWindowStateReaderSchema.safeParse(base()).success).toBe(true);
  expect(ApprovalWindowStateReaderSchema.safeParse(base({ pending: pending(false), futureField: 1 })).success).toBe(true);
  expect(ApprovalWindowAnswerReaderSchema.safeParse({ status: "needs_approval", changeId: "chg_1", ...base({ pending: pending(true) }) }).success).toBe(true);
  expect(ApprovalWindowAnswerReaderSchema.safeParse({ status: "applied", ...base() }).success).toBe(true);
  expect(ApprovalWindowBodySchema.safeParse({ action: "set", expectedRevision: 0, seconds: 7 * DAY }).success).toBe(true);
  for (const seconds of [7 * DAY + 1, HOUR - 1, 90.5]) expect(ApprovalWindowBodySchema.safeParse({ action: "set", expectedRevision: 0, seconds }).success).toBe(false);
  expect(ApprovalWindowBodySchema.safeParse({ action: "set", expectedRevision: 0, seconds: DAY, extra: 1 }).success).toBe(false);
});

it("says the window in plain words with the default and the company's value, links to the audit for who and when, and the nav links to the page", async () => {
  const f = mount({ state: { seconds: 3 * DAY, isDefault: false, revision: 4 } });
  await screen.findByRole("heading", { name: "Recent sign-in window", level: 1 });
  await screen.findByText("People can approve medium-risk work from chat or comments if they signed in to Rovara in the last 3 days.");
  const facts = screen.getByText("Default").closest("dl")!;
  expect(facts.textContent).toContain("24 hours");expect(facts.textContent).toContain("3 days");
  expect(screen.getByText(/Your company changed this from the default \(24 hours\)/u)).toBeTruthy();
  expect(screen.getByRole("link", { name: "Who changed it and when is in the audit log" }).getAttribute("href")).toBe("/app/admin/audit");
  expect(screen.getByText(/A Slack or GitHub sign-in does not count/u)).toBeTruthy();
  expect(screen.getByRole("link", { name: "Recent sign-in window" }).getAttribute("href")).toBe("/app/admin/approval-window");
  expect(f.request.mock.calls.filter(([request]) => request.path === PATH).every(([request]) => request.method === "GET")).toBe(true);
  f.close();
  const one = mount({ state: { seconds: HOUR, isDefault: false } });
  await screen.findByText("People can approve medium-risk work from chat or comments if they signed in to Rovara in the last hour.");
  one.close();
  const def = mount();
  await screen.findByText(/This is the default\. Your company has not changed it\./u);
  expect(screen.queryByRole("link", { name: /audit log/u })).toBeNull();
  def.close();
});

it("shows who set the window and when, whichever of the two the server sends; sent neither, today's wording", async () => {
  const set = { seconds: 12 * HOUR, isDefault: false, revision: 5 };
  const both = mount({ state: { ...set, changedBy: "Ada Admin", changedAt: "2026-11-11T12:00:00.000Z" } });
  const line = await screen.findByText(/^Set to 12 hours by Ada Admin on Nov 11, 2026\./u);
  expect(line.textContent).toContain("Who changed it and when is in the audit log");
  expect(within(line).getByRole("link", { name: "Who changed it and when is in the audit log" }).getAttribute("href")).toBe("/app/admin/audit");
  expect(screen.queryByText(/Your company changed this from the default/u)).toBeNull();
  both.close();
  const markup = mount({ state: { ...set, changedBy: "<b>Ada</b>\u202e", changedAt: "2026-11-11T12:00:00.000Z" } });
  await screen.findByText(/^Set to 12 hours by <b>Ada<\/b>\[U\+202E\] on Nov 11, 2026\./u);
  expect(markup.container.querySelector("main b")).toBeNull();
  markup.close();
  const onlyWho = mount({ state: { ...set, changedBy: "Ada Admin", changedAt: null } });
  await screen.findByText(/^Set to 12 hours by Ada Admin\./u);
  onlyWho.close();
  const onlyWhen = mount({ state: { ...set, changedAt: "2026-11-11T12:00:00.000Z" } });
  await screen.findByText(/^Set to 12 hours on Nov 11, 2026\./u);
  onlyWhen.close();
  const neither = mount({ state: set });
  await screen.findByText(/^Your company changed this from the default \(24 hours\)\./u);
  expect(screen.queryByText(/^Set to /u)).toBeNull();
  neither.close();
  const unset = mount({ state: { changedBy: "Ada Admin", changedAt: "2026-11-11T12:00:00.000Z" } });
  await screen.findByText(/This is the default\. Your company has not changed it\./u);
  expect(screen.queryByText(/Ada Admin/u)).toBeNull();
  unset.close();
  expect(ApprovalWindowStateReaderSchema.safeParse(base({ changedBy: "Ada", changedAt: "2026-11-11T12:00:00.000Z" })).success).toBe(true);
  expect(ApprovalWindowStateReaderSchema.safeParse(base({ changedBy: null, changedAt: null })).success).toBe(true);
});

it("the policy table is a real table with a plain caption, column and row headers, and says what each place needs", async () => {
  const f = mount({ state: { seconds: 4 * HOUR, isDefault: false } });
  const table = await screen.findByRole("table", { name: /Where work can be approved, by risk level/u });
  expect(table.querySelector("caption")?.textContent).toBe("Where work can be approved, by risk level, and what each place needs. Read only.");
  expect(within(table).getAllByRole("columnheader").map(cell => cell.textContent)).toEqual(["Where", "Low risk", "Medium risk", "High risk"]);
  const rows = within(table).getAllByRole("row");
  expect(rows).toHaveLength(6);
  expect(within(rows[1]!).getByRole("rowheader").textContent).toBe("In Rovara (the app)");
  expect(within(table).getAllByRole("rowheader").map(cell => cell.textContent)).toEqual(["In Rovara (the app)", "Chat (Slack)", "Tracker comment", "Code host comment (pull request)", "AI tool, CLI or token"]);
  expect(rows[1]!.textContent).toContain("after a sign-in with the email code");
  expect(rows[2]!.textContent).toContain("Yes, with a linked account and a Rovara sign-in in the last 4 hours.");
  expect(rows[2]!.textContent).toContain("No. Open it in Rovara.");
  expect(rows[5]!.textContent).toContain("No. It gets a link to open in Rovara.");
  expect(within(table).queryByRole("button")).toBeNull();expect(within(table).queryByRole("link")).toBeNull();
  expect(screen.getByText(/Asking for changes works anywhere a linked person can reach/u)).toBeTruthy();
  expect(screen.getByRole("region", { name: "Why this matters" }).textContent).toContain("A longer window means fewer interruptions");
  expect(policyRows(DAY)).toHaveLength(5);
  f.close();
});

it("shortening applies at once: one request with the revision it saw, sent once from the browser", async () => {
  const f = mount();
  await screen.findByRole("heading", { name: "Change the window" });
  const select = asSelect(screen.getByLabelText("Window length"));
  expect(asButton(screen.getByRole("button", { name: "Save window" })).disabled).toBe(true);
  fireEvent.change(select, { target: { value: String(4 * HOUR) } });
  await screen.findByText("Shorter: applies at once.");
  f.current.state = base({ seconds: 4 * HOUR, isDefault: false, revision: 4 });
  fireEvent.click(screen.getByRole("button", { name: "Save window" }));
  await waitFor(() => expect(posts(f)).toHaveLength(1));
  expect(posts(f)[0]).toMatchObject({ path: PATH, body: { action: "set", expectedRevision: 3, seconds: 4 * HOUR }, retry: "never" });
  await screen.findByText("Saved. The window is now 4 hours.");
  await screen.findByText("People can approve medium-risk work from chat or comments if they signed in to Rovara in the last 4 hours.");
  f.close();
});

it("lengthening creates a pending change: 'Waiting for a second admin', with the proposer's Cancel and no Approve", async () => {
  const f = mount({ respond: async request => {
    if (request.method !== "POST") return undefined;
    return { status: 202, body: { status: "needs_approval", changeId: "chg_0123456789", ...base({ pending: pending(true) }) } };
  } });
  await screen.findByRole("heading", { name: "Change the window" });
  fireEvent.change(screen.getByLabelText("Window length"), { target: { value: String(3 * DAY) } });
  await screen.findByText(/Longer: needs a second admin to approve/u);
  f.current.state = base({ pending: pending(true) });
  fireEvent.click(screen.getByRole("button", { name: "Save window" }));
  await waitFor(() => expect(posts(f)).toHaveLength(1));
  expect(posts(f)[0]!.body).toEqual({ action: "set", expectedRevision: 3, seconds: 3 * DAY });
  await screen.findByText("Waiting for a second admin. A different admin has to approve a window of 3 days.");
  const card = screen.getByRole("region", { name: "Waiting for a second admin" });
  expect(card.textContent).toContain("You asked to lengthen the window from 24 hours to 3 days");
  expect(card.textContent).toContain("Expires");
  expect(within(card).queryByRole("button", { name: "Approve the longer window" })).toBeNull();
  expect(within(card).getByRole("button", { name: "Cancel the request" })).toBeTruthy();
  // The window itself is still the old one until a second admin approves.
  expect(screen.getByText("People can approve medium-risk work from chat or comments if they signed in to Rovara in the last 24 hours.")).toBeTruthy();
  f.close();
});

it("a different admin can approve the waiting lengthening: one request, the change id, and the new window shown", async () => {
  const f = mount({ state: { pending: pending(false) } });
  const card = await screen.findByRole("region", { name: "Waiting for a second admin" });
  expect(card.textContent).toContain("Another admin asked to lengthen the window from 24 hours to 3 days");
  expect(within(card).getByText(/Approving needs a sign-in from the last 10 minutes/u)).toBeTruthy();
  f.current.state = base({ seconds: 3 * DAY, isDefault: false, revision: 4 });
  fireEvent.click(within(card).getByRole("button", { name: "Approve the longer window" }));
  await waitFor(() => expect(posts(f)).toHaveLength(1));
  expect(posts(f)[0]).toMatchObject({ path: PATH, body: { action: "approve", changeId: "chg_0123456789" }, retry: "never" });
  await screen.findByText("Approved. The window is now 3 days.");
  await waitFor(() => expect(screen.queryByRole("region", { name: "Waiting for a second admin" })).toBeNull());
  // The answer stays on screen after the card it came from has gone.
  expect(screen.getByText("Approved. The window is now 3 days.")).toBeTruthy();
  f.close();
});

it("the proposer cannot approve: no button, and if the server refuses an approval its sentence is shown word for word", async () => {
  const mine = mount({ state: { pending: pending(true) } });
  const own = await screen.findByRole("region", { name: "Waiting for a second admin" });
  expect(within(own).queryByRole("button", { name: /Approve/u })).toBeNull();
  mine.close();
  const sentence = "A different admin has to approve this. If you are the company's only admin, only the company owner can do it alone.";
  const other = mount({ state: { pending: pending(false) }, respond: async request => (request.method === "POST" ? refusal(403, "FORBIDDEN", sentence) : undefined) });
  fireEvent.click(await screen.findByRole("button", { name: "Approve the longer window" }));
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toBe(sentence);
  expect(screen.queryByRole("button", { name: "Sign in again" })).toBeNull();
  other.close();
});

it("cancel withdraws the waiting request, for its proposer and for another admin", async () => {
  for (const mine of [true, false]) {
    const f = mount({ state: { pending: pending(mine) } });
    fireEvent.click(await screen.findByRole("button", { name: "Cancel the request" }));
    f.current.state = base();
    await waitFor(() => expect(posts(f)).toHaveLength(1));
    expect(posts(f)[0]!.body).toEqual({ action: "cancel", changeId: "chg_0123456789" });
    await screen.findByText("The request was cancelled.");
    await waitFor(() => expect(screen.queryByRole("region", { name: "Waiting for a second admin" })).toBeNull());
    expect(screen.getByText("The request was cancelled.")).toBeTruthy();
    f.close();
  }
});

it("never offers more than 7 days, even if the server's maximum is higher, and shows the server's refusal word for word", async () => {
  const sentence = "seconds: must be at most 604800";
  const f = mount({ state: { maxSeconds: 14 * DAY }, respond: async request => (request.method === "POST" ? refusal(400, "CONFIG_INVALID", sentence) : undefined) });
  await screen.findByRole("heading", { name: "Change the window" });
  const values = optionValues(screen.getByLabelText("Window length")).map(Number);
  expect(Math.max(...values)).toBe(7 * DAY);
  expect(values).toEqual([HOUR, 4 * HOUR, 12 * HOUR, DAY, 3 * DAY, 7 * DAY]);
  expect(windowChoices(DAY, HOUR, 30 * DAY).every(value => value <= 7 * DAY)).toBe(true);
  expect(within(screen.getByLabelText("Window length")).getAllByRole("option").map(option => option.textContent)).toContain("7 days");
  fireEvent.change(screen.getByLabelText("Window length"), { target: { value: String(7 * DAY) } });
  fireEvent.click(screen.getByRole("button", { name: "Save window" }));
  expect((await screen.findByRole("alert")).textContent).toBe(sentence);
  f.close();
  // A smaller server range narrows the list; a value the company already has (2 days) stays visible.
  expect(windowChoices(2 * DAY, 4 * HOUR, 3 * DAY)).toEqual([4 * HOUR, 12 * HOUR, DAY, 2 * DAY, 3 * DAY]);
  expect(durationWords(90 * 60)).toBe("90 minutes");
});

it("a refused sign-in asks to sign in again, and the button starts the sign-in", async () => {
  const f = mount({ state: { pending: pending(false) }, respond: async request => (request.method === "POST" ? refusal(403, "REAUTH_REQUIRED", "Sign in again to approve this. It needs a sign-in within the last 10 minutes.") : undefined) });
  fireEvent.click(await screen.findByRole("button", { name: "Approve the longer window" }));
  await screen.findByText("Sign in again to approve this. It needs a sign-in within the last 10 minutes.");
  // A 403 REAUTH_REQUIRED never redirects by itself: only the button starts the sign-in.
  expect(f.host.signIn).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Sign in again" }));
  expect(f.host.signIn).toHaveBeenCalledTimes(1);
  expect(f.host.signIn).toHaveBeenCalledWith("/app/live");
  f.close();
});

it("a lengthening that needs a fresh sign-in says so too", async () => {
  const f = mount({ respond: async request => (request.method === "POST" ? refusal(403, "REAUTH_REQUIRED", "Sign in again to lengthen the window.") : undefined) });
  await screen.findByRole("heading", { name: "Change the window" });
  fireEvent.change(screen.getByLabelText("Window length"), { target: { value: String(3 * DAY) } });
  fireEvent.click(screen.getByRole("button", { name: "Save window" }));
  await screen.findByText("Sign in again to lengthen the window.");
  expect(screen.getByRole("button", { name: "Sign in again" })).toBeTruthy();
  expect(f.host.signIn).not.toHaveBeenCalled();
  f.close();
});

it("a request that is already waiting, or a window that moved, is shown as the server says it and the page reads again", async () => {
  const sentence = "A request is already waiting for a different admin. Withdraw it first.";
  const f = mount({ respond: async request => (request.method === "POST" ? refusal(409, "CHANGE_STALE", sentence) : undefined) });
  await screen.findByRole("heading", { name: "Change the window" });
  fireEvent.change(screen.getByLabelText("Window length"), { target: { value: String(3 * DAY) } });
  const reads = () => f.request.mock.calls.filter(([request]) => request.path === PATH && request.method === "GET").length, before = reads();
  f.current.state = base({ pending: pending(false) });
  fireEvent.click(screen.getByRole("button", { name: "Save window" }));
  expect((await screen.findByText(sentence)).textContent).toBe(sentence);
  await screen.findByRole("region", { name: "Waiting for a second admin" });
  expect(reads()).toBeGreaterThan(before);
  f.close();
});

it("an unreadable saved window says so, shows the default and offers no change", async () => {
  const f = mount({ state: { unreadable: true } });
  await screen.findByText(/could not be read, so the default applies/u);
  expect(screen.queryByRole("heading", { name: "Change the window" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Save window" })).toBeNull();
  expect(screen.getByText("People can approve medium-risk work from chat or comments if they signed in to Rovara in the last 24 hours.")).toBeTruthy();
  expect(screen.getByRole("table")).toBeTruthy();
  f.close();
});

it("a person who cannot change it can read it but sees no controls", async () => {
  const f = mount({ state: { canChange: false } });
  await screen.findByText("Only company owners and admins can change the window.");
  expect(screen.queryByRole("button", { name: "Save window" })).toBeNull();
  expect(screen.queryByLabelText("Window length")).toBeNull();
  f.close();
});

it("when the server has it off the page says 'not turned on' and the nav and overview do not link to it", async () => {
  const f = mount({ off: true });
  await screen.findByText("The recent sign-in window is not turned on for your company yet.");
  expect(screen.queryByRole("table")).toBeNull();
  await waitFor(() => expect(screen.queryByRole("link", { name: "Recent sign-in window" })).toBeNull());
  expect(posts(f)).toHaveLength(0);
  f.close();
  expect(visibleSections("owner", false, false, false, true).flatMap(section => section.items.map(item => item.label))).not.toContain("Recent sign-in window");
  const on = visibleSections("admin", false).find(section => section.id === "security")!;
  expect(on.items.map(item => item.label)).toContain("Recent sign-in window");
});
