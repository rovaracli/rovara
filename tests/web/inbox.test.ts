// @vitest-environment jsdom
// Web task channel K5: the Inbox screen and the nav badge. The screen draws what Cloud answers from Rovara Code's inbox (the person's own rows), links each
// row to the task, marks rows read, reads again every 30 seconds, and says one fixed sentence (and hides the badge) when Code has no inbox on this install.
import { expect, it, vi } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { AppNavSchema, INBOX_NOT_AVAILABLE_TEXT, InboxPageSchema, ProjectNoticesSchema } from "@agentx/contracts/web";
import { appRoutes } from "../../packages/ui/src/routes.js";
import { AppHostProvider } from "../../packages/ui/src/host.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { ThemeProvider } from "../../packages/ui/src/theme.js";
import { fakeHost } from "./support/fake-host.js";
import { renderUi } from "./support/render.js";
import { h } from "./support/h.js";
import { expectNoAxeViolations } from "./support/axe.js";
import { ApiError } from "../../packages/ui/src/api/errors.js";
import type { ApiRequest, ApiResponse } from "../../packages/ui/src/host.js";

const features = { localAgents: false, admin: true, usage: false, chains: false, describe: false, notices: false };
const SES = "ses_" + "a".repeat(20), TASK = "6f9d0c1e-2b3a-4c5d-8e7f-001122334455";
const id = (n: number, kind = "needs_you") => `ses_${"b".repeat(19)}${String(n % 10)}.${kind}.${String(1_763_380_800_000 + n)}`;
const item = (n: number, extra: Record<string, unknown> = {}) => ({ id: id(n), kind: "needs_you", title: `Task ${String(n)}`, status: "Waiting for you.", at: "2026-11-17T11:00:00.000Z", read: false, open: `/s/${SES}`, ...extra });
const PAGE = InboxPageSchema.parse({ items: [item(1), item(2, { kind: "failed", read: true, open: `/t/${TASK}`, title: "<img src=x onerror=alert(1)>" })], unread: 1 });
const ERROR = (status: number, code: string, message: string): ApiResponse => ({ status, body: { error: { code, message } } });

const NOTICE = (project: string, kind: "setup_broken" | "upkeep_paused" = "setup_broken", extra: Record<string, unknown> = {}) => ({ id: `${kind}.1763380800000.${project}`, kind, project, status: kind === "setup_broken" ? "Setup needs repair. Fix setup on the setup page." : "Nightly upkeep is paused: this month's upkeep limit is used up.", at: "2026-11-17T11:00:00.000Z", ...extra });
const NO_NOTICES = { items: [] };

function mount(options: { beforeMount?: (host: { kind: "web" | "desktop" }) => void; path?: string; theme?: "light" | "dark"; inbox?: (request: ApiRequest) => ApiResponse | Promise<ApiResponse>; notices?: (request: ApiRequest) => ApiResponse | Promise<ApiResponse> } = {}) {
 const nav = AppNavSchema.parse({ me: { developerId: "a".repeat(64), name: "Priya", orgRole: "member" }, org: { name: "Acme" }, homeCount: 0, projects: [], shared: { agents: [], sessions: [] }, features });
 let current = options.inbox ?? (() => ({ status: 200, body: PAGE }));
 const f = fakeHost(async r => {
  if (r.path === "/v1/app/inbox/project-notices") return (options.notices ?? (() => ({ status: 200, body: NO_NOTICES })))(r);
  if (r.path.startsWith("/v1/app/inbox")) return current(r);
  return { status: 200, body: r.path === "/v1/app/nav" ? nav : r.path === "/v1/app/home" ? { cards: [], total: 0 } : { notices: [], next: "settled" } };
 });
 options.beforeMount?.(f.host);const query = createQueryClient();query.setQueryData(["nav"], nav);f.storage.set("rovara.theme", options.theme ?? "light");
 const router = createMemoryRouter(appRoutes(nav.features), { initialEntries: [options.path ?? "/app/inbox"] });
 const view = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(ThemeProvider, { host: f.host, children: h(RouterProvider, { router }) }) }) }), { theme: options.theme ?? "light" });
 const inboxCalls = () => f.request.mock.calls.map(([r]) => r).filter(r => r.path.startsWith("/v1/app/inbox") && r.path !== "/v1/app/inbox/project-notices");
 const noticeCalls = () => f.request.mock.calls.map(([r]) => r).filter(r => r.path === "/v1/app/inbox/project-notices");
 return { ...f, ...view, query, router, inboxCalls, noticeCalls, answer(next: (request: ApiRequest) => ApiResponse | Promise<ApiResponse>) { current = next; }, close: () => { view.unmount();router.dispose();query.clear(); } };
}

it("draws the person's rows newest first as links to the task, with the kind, the status and the time, and shows titles as text", async () => {
 const f = mount();expect(await screen.findByRole("heading", { name: "Inbox", level: 1 })).toBeTruthy();await screen.findByText("1 unread");
 const rows = await screen.findAllByTestId("inbox-row");expect(rows).toHaveLength(2);
 const links = rows.map(row => row.querySelector("a")!);
 // A task Cloud has a session for opens on it; any other opens by the task's id.
 expect(links.map(link => link.getAttribute("href"))).toEqual([`/s/${SES}`, `/t/${TASK}`]);
 expect(rows[0]!.textContent).toContain("Needs you · Waiting for you.");expect(rows[1]!.textContent).toContain("Failed");
 expect(rows[0]!.getAttribute("data-read")).toBe("false");expect(rows[1]!.getAttribute("data-read")).toBe("true");
 expect(screen.getByText("<img src=x onerror=alert(1)>")).toBeTruthy();expect(f.container.querySelector("img")).toBeNull();
 expect(f.container.querySelector("time")?.getAttribute("datetime")).toBe("2026-11-17T11:00:00.000Z");
 // The first read asks for the default page and sends nothing about a person or a company.
 expect(f.inboxCalls().filter(call => call.path === "/v1/app/inbox")).toHaveLength(1);
 expect(f.request.mock.calls.every(([r]) => r.method === "GET")).toBe(true);f.close();
});

it("does not mark a row that is already read when it is opened", async () => {
 const f = mount();const rows = await screen.findAllByTestId("inbox-row");
 fireEvent.click(rows[1]!.querySelector("a")!);await new Promise(resolve => setTimeout(resolve, 30));
 expect(f.inboxCalls().some(call => call.method === "POST")).toBe(false);f.close();
});

it("marks a row read when it is opened, once, naming only the row", async () => {
 const f = mount({ inbox: request => request.method === "POST" ? { status: 200, body: { marked: 1 } } : { status: 200, body: PAGE } });const rows = await screen.findAllByTestId("inbox-row");
 fireEvent.click(rows[0]!.querySelector("a")!);
 await waitFor(() => expect(f.inboxCalls().filter(call => call.method === "POST")).toHaveLength(1));
 const post = f.inboxCalls().find(call => call.method === "POST")!;
 expect(post.path).toBe("/v1/app/inbox/read");expect(Object.keys(post.body as object).sort()).toEqual(["ids", "requestId"]);
 expect((post.body as { ids: string[] }).ids).toEqual([id(1)]);expect((post.body as { requestId: string }).requestId).toMatch(/^[0-9a-f-]{36}$/u);f.close();
});

it("marks every unread row at once, 50 ids at most per request, and refreshes", async () => {
 const many = InboxPageSchema.parse({ items: Array.from({ length: 50 }, (_, n) => item(n + 1)), nextCursor: "c3VyZQ", unread: 50 });
 const rest = InboxPageSchema.parse({ items: Array.from({ length: 10 }, (_, n) => item(n + 51)) });
 const f = mount({ inbox: request => ({ status: 200, body: request.path.includes("cursor=") ? rest : many }) });
 await screen.findAllByTestId("inbox-row");fireEvent.click(screen.getByRole("button", { name: "Show more" }));await waitFor(() => expect(screen.getAllByTestId("inbox-row")).toHaveLength(60));
 expect(f.inboxCalls().some(call => call.path === "/v1/app/inbox?cursor=c3VyZQ")).toBe(true);
 f.answer(request => request.method === "POST" ? { status: 200, body: { marked: 1 } } : { status: 200, body: many });
 fireEvent.click(screen.getByRole("button", { name: "Mark all as read" }));
 await waitFor(() => expect(f.inboxCalls().filter(call => call.method === "POST")).toHaveLength(2));
 const sizes = f.inboxCalls().filter(call => call.method === "POST").map(call => (call.body as { ids: string[] }).ids.length);expect(sizes).toEqual([50, 10]);f.close();
});

it("says what a failed mark-all was and keeps the rows", async () => {
 const f = mount();await screen.findAllByTestId("inbox-row");
 f.answer(request => request.method === "POST" ? ERROR(403, "FORBIDDEN", "Your access ended.") : { status: 200, body: PAGE });
 fireEvent.click(screen.getByRole("button", { name: "Mark all as read" }));expect(await screen.findByText("Your access ended.")).toBeTruthy();expect(screen.getAllByTestId("inbox-row")).toHaveLength(2);f.close();
});

it("shows a fixed empty state only after a successful empty read", async () => {
 const f = mount({ inbox: () => ({ status: 200, body: { items: [], unread: 0 } }) });
 expect(await screen.findByRole("heading", { name: "No updates shown" })).toBeTruthy();expect(screen.queryByRole("button", { name: "Mark all as read" })).toBeNull();expect(screen.queryByText(/Slack/u)).toBeNull();f.close();
});

it("says one fixed sentence when Code has no inbox on this install, with no retry, and never the cause", async () => {
 for (const status of [501, 404]) {
  const f = mount({ inbox: () => ERROR(status, "NOT_ON_CODE_YET", "/v1/app/inbox isn't connected to Rovara Code yet.") });
  expect((await screen.findByTestId("inbox-unavailable")).textContent).toBe(INBOX_NOT_AVAILABLE_TEXT);
  expect(screen.queryByText(/connected to Rovara Code/u)).toBeNull();expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();expect(screen.queryByTestId("inbox-empty")).toBeNull();f.close();
 }
});

it("passes any other refusal on as worded, with a real retry, and never shows an empty success for it", async () => {
 const f = mount({ inbox: () => ERROR(403, "FORBIDDEN", "Your access to the inbox ended.") });
 expect(await screen.findByText("Your access to the inbox ended.")).toBeTruthy();expect(screen.queryByTestId("inbox-empty")).toBeNull();expect(screen.queryByTestId("inbox-unavailable")).toBeNull();
 f.answer(() => ({ status: 200, body: PAGE }));fireEvent.click(screen.getByRole("button", { name: "Try again" }));await screen.findAllByTestId("inbox-row");f.close();
});

it("refuses a row whose link is not a path in this app, so a hostile address never becomes a link", async () => {
 const f = mount({ inbox: () => ({ status: 200, body: { items: [item(1, { open: "https://evil.example/x" })], unread: 1 } }) });
 expect(await screen.findByText("Rovara returned an unreadable response. Reload this page.")).toBeTruthy();expect(f.container.querySelector("a[href^='https://evil']")).toBeNull();f.close();
});

it("shows an Inbox link with the unread count in the nav when Code has an inbox", async () => {
 const f = mount({ path: "/app", inbox: () => ({ status: 200, body: { items: [item(1)], unread: 3 } }) });
 const link = await screen.findByRole("link", { name: "Inbox, 3 unread" });expect(link.getAttribute("href")).toBe("/app/inbox");expect(screen.getByTestId("inbox-badge").textContent).toBe("3");
 // The badge asks for one row, which is all the count needs.
 expect(f.inboxCalls().map(call => call.path)).toContain("/v1/app/inbox?limit=1");f.close();
});

it("shows the link with no number when nothing is unread", async () => {
 const f = mount({ path: "/app", inbox: () => ({ status: 200, body: { items: [], unread: 0 } }) });
 await screen.findByRole("link", { name: "Inbox, 0 unread" });expect(screen.getByTestId("inbox-badge").textContent).toBe("");f.close();
});

it("hides the Inbox link and the badge when Code has no inbox, and does not ask again", async () => {
 for (const status of [501, 404]) {
  const f = mount({ path: "/app", inbox: () => ERROR(status, "NOT_ON_CODE_YET", "nope") });
  await waitFor(() => expect(f.inboxCalls().length).toBeGreaterThan(0));await new Promise(resolve => setTimeout(resolve, 30));
  expect(screen.queryByRole("link", { name: /^Inbox/u })).toBeNull();expect(screen.queryByTestId("inbox-badge")).toBeNull();
  const badge = f.query.getQueryCache().find({ queryKey: ["inbox", "badge"] })!;
  const interval = badge.observers[0]!.options.refetchInterval as (query: unknown) => number | false;
  expect(interval({ state: { data: { available: false, unread: 0 } } })).toBe(false);f.close();
 }
});

it("shows no badge when the read fails for any other reason", async () => {
 const f = mount({ path: "/app", inbox: () => ERROR(500, "RUNTIME_UNAVAILABLE", "down") });
 await waitFor(() => expect(f.inboxCalls().length).toBeGreaterThan(0));await new Promise(resolve => setTimeout(resolve, 30));
 expect(screen.queryByRole("link", { name: /^Inbox/u })).toBeNull();f.close();
});

it("reads the badge and the screen again every 30 seconds while the inbox is available", async () => {
 const f = mount({ path: "/app/inbox" });await screen.findAllByTestId("inbox-row");
 const interval = (key: string[]) => f.query.getQueryCache().find({ queryKey: key })!.observers[0]!.options.refetchInterval as (query: unknown) => number | false;
 expect(interval(["inbox", "badge"])({ state: { data: { available: true, unread: 2 } } })).toBe(30_000);
 expect(interval(["inbox", "list"])({ state: { error: null } })).toBe(30_000);
 expect(interval(["inbox", "list"])({ state: { error: new ApiError(500, "RUNTIME_UNAVAILABLE", "down") } })).toBe(30_000);
 expect(interval(["inbox", "list"])({ state: { error: new ApiError(501, "NOT_ON_CODE_YET", "no") } })).toBe(false);f.close();
});

it("reads again when the interval passes", async () => {
 vi.useFakeTimers({ shouldAdvanceTime: true });
 try {
  const f = mount({ path: "/app/inbox" });await screen.findAllByTestId("inbox-row");
  const before = f.inboxCalls().length;
  await vi.advanceTimersByTimeAsync(31_000);
  await waitFor(() => expect(f.inboxCalls().length).toBeGreaterThan(before));f.close();
 } finally { vi.useRealTimers(); }
});

for (const theme of ["light", "dark"] as const) it("has an accessible inbox in " + theme, async () => {
 const f = mount({ theme });await screen.findAllByTestId("inbox-row");await expectNoAxeViolations(f.container);f.close();
});

it("asks nothing of Code's inbox in a desktop host", async () => {
 const f = mount({ path: "/app", beforeMount: host => { host.kind = "desktop"; } });
 await screen.findByRole("link", { name: "Work" });await new Promise(resolve => setTimeout(resolve, 30));
 expect(f.inboxCalls()).toEqual([]);expect(screen.queryByRole("link", { name: /^Inbox/u })).toBeNull();f.close();
});

it("refreshes the rows after a mark-all that failed part way", async () => {
 const f = mount();await screen.findAllByTestId("inbox-row");
 const before = f.inboxCalls().filter(call => call.method === "GET").length;
 f.answer(request => request.method === "POST" ? ERROR(403, "FORBIDDEN", "Your access ended.") : { status: 200, body: PAGE });
 fireEvent.click(screen.getByRole("button", { name: "Mark all as read" }));await screen.findByText("Your access ended.");
 await waitFor(() => expect(f.inboxCalls().filter(call => call.method === "GET").length).toBeGreaterThan(before));f.close();
});

it("draws a kind it does not know as a plain update", async () => {
 const f = mount({ inbox: () => ({ status: 200, body: { items: [item(1, { kind: "mentioned" })], unread: 1 } }) });
 expect((await screen.findByTestId("inbox-row")).textContent).toContain("Update · Waiting for you.");f.close();
});

// ---- L4-U5b: the notices about a project, for an admin told by neither chat nor email

it("shows the project notices above the tasks: the project's name, the kind in words, Code's sentence and the time, each opening the project's page", async () => {
 const f = mount({ notices: () => ({ status: 200, body: ProjectNoticesSchema.parse({ items: [NOTICE("payments"), NOTICE("beacon-api", "upkeep_paused", { id: "upkeep_paused.1763380800000.beacon-api" })] }) }) });
 const section = await screen.findByTestId("project-notices");
 expect(section.querySelector("h2")?.textContent).toBe("Projects that need an admin");
 const rows = await screen.findAllByTestId("project-notice-row");expect(rows).toHaveLength(2);
 expect(rows.map(row => row.querySelector("a")!.getAttribute("href"))).toEqual(["/projects/payments", "/projects/beacon-api"]);
 expect(rows[0]!.textContent).toContain("payments");expect(rows[0]!.textContent).toContain("Setup needs repair · Setup needs repair. Fix setup on the setup page.");
 expect(rows[1]!.textContent).toContain("Nightly upkeep paused · Nightly upkeep is paused: this month's upkeep limit is used up.");
 expect(rows[0]!.querySelector("time")?.getAttribute("datetime")).toBe("2026-11-17T11:00:00.000Z");
 // The tasks are still drawn below, and the notices were asked for once with no query (nothing about a person or a company is sent).
 expect(await screen.findAllByTestId("inbox-row")).toHaveLength(2);
 expect(f.noticeCalls()).toHaveLength(1);expect(f.noticeCalls()[0]).toMatchObject({ method: "GET", path: "/v1/app/inbox/project-notices" });
 f.close();
});

it("draws the project's name and Code's sentence as text, never as markup, and builds the link from the name alone", async () => {
 const f = mount({ notices: () => ({ status: 200, body: { items: [NOTICE("payments", "setup_broken", { status: "<img src=x onerror=alert(1)> Setup needs repair." })] } }) });
 expect(await screen.findByText(/<img src=x onerror=alert\(1\)> Setup needs repair\./u)).toBeTruthy();expect(f.container.querySelector("img")).toBeNull();
 expect(f.container.querySelector("[data-testid='project-notice-row'] a")!.getAttribute("href")).toBe("/projects/payments");f.close();
});

it("draws a notice kind it does not know as a plain update", async () => {
 const f = mount({ notices: () => ({ status: 200, body: { items: [NOTICE("payments", "setup_broken", { kind: "billing_paused", id: "billing_paused.1763380800000.payments" })] } }) });
 expect((await screen.findByTestId("project-notice-row")).textContent).toContain("Update · ");f.close();
});

it("shows no section when there is no notice, and the tasks are unchanged", async () => {
 const f = mount();await screen.findAllByTestId("inbox-row");
 expect(screen.queryByTestId("project-notices")).toBeNull();f.close();
});

it("a notices read that fails (or answers something Cloud rejects) shows no section and never breaks the tasks below", async () => {
 for (const answer of [ERROR(502, "RUNTIME_UNAVAILABLE", "Rovara Code sent an inbox answer Cloud couldn't read."), ERROR(403, "FORBIDDEN", "no"), { status: 200, body: { items: [{ id: "x" }] } } as ApiResponse]) {
  const f = mount({ notices: () => answer });
  expect(await screen.findAllByTestId("inbox-row")).toHaveLength(2);
  await waitFor(() => expect(f.noticeCalls().length).toBeGreaterThan(0));
  expect(screen.queryByTestId("project-notices")).toBeNull();expect(screen.queryByTestId("load-error")).toBeNull();f.close();
 }
});

it("reads the notices again every 30 seconds", async () => {
 const f = mount({ path: "/app/inbox" });await screen.findAllByTestId("inbox-row");
 const observer = f.query.getQueryCache().find({ queryKey: ["inbox", "project-notices"] })!.observers[0]!;
 expect(observer.options.refetchInterval).toBe(30_000);f.close();
});

for (const theme of ["light", "dark"] as const) it("has an accessible inbox with project notices in " + theme, async () => {
 const f = mount({ theme, notices: () => ({ status: 200, body: { items: [NOTICE("payments"), NOTICE("payments", "upkeep_paused", { id: "upkeep_paused.1763380800000.payments" })] } }) });
 await screen.findAllByTestId("project-notice-row");await screen.findAllByTestId("inbox-row");await expectNoAxeViolations(f.container);f.close();
});
