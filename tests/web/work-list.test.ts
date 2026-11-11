// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, fireEvent, waitFor, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { LiveScreen } from "../../packages/ui/src/screens/live/LiveScreen.js";
import { isWorkListOn, WORK_STORAGE_KEY } from "../../packages/ui/src/screens/live/work-list-flags.js";
import { WORK_VIEWS, formatAge, liveFiltersFor, liveStatus, nextActor, rowFromFinished, rowFromLive, sortFinished, sortRows, workViewFor, type WorkRow } from "../../packages/ui/src/screens/live/work-list.js";
import { AppHostProvider, type ApiRequest, type ApiResponse } from "../../packages/ui/src/host.js";
import { Announcer } from "../../packages/ui/src/design/Announcer.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { renderUi } from "./support/render.js";
import { expectNoAxeViolations } from "./support/axe.js";
import { fakeHost } from "./support/fake-host.js";
import { h } from "./support/h.js";
import { liveFixture } from "./support/live-fixture.js";
import { finishedFixture } from "./support/finished-fixture.js";
import { navFixture } from "./support/fixtures.js";
afterEach(() => { vi.useRealTimers(); });
const NOW = Date.parse("2026-10-23T15:00:00.000Z"), HOUR = 3_600_000;
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const SESSION_B = "ses_bbbbbbbbbbbbbbbbbbbb", SESSION_C = "ses_cccccccccccccccccccc";

describe("the switch", () => {
 const host = (value: string | undefined) => ({ storage: { get: () => value, set: () => undefined } });
 it("is off unless the device key says v2", () => {
  expect(WORK_STORAGE_KEY).toBe("rovara.work");
  expect(isWorkListOn(host(undefined))).toBe(false);expect(isWorkListOn(host("v1"))).toBe(false);expect(isWorkListOn(host("true"))).toBe(false);expect(isWorkListOn(host("v2"))).toBe(true);
 });
 it("is off when storage is blocked", () => { expect(isWorkListOn({ storage: { get() { throw new Error("blocked"); }, set: () => undefined } })).toBe(false); });
});

describe("the views", () => {
 it("are Mine, Team, Needs attention and Finished, each reading today's data", () => {
  expect(WORK_VIEWS).toEqual(["mine", "team", "attention", "finished"]);
  expect(liveFiltersFor("mine")).toEqual(["mine"]);expect(liveFiltersFor("team")).toEqual(["team"]);expect(liveFiltersFor("attention")).toEqual(["needs_me", "failed"]);expect(liveFiltersFor("finished")).toEqual([]);
 });
 it("take ?view= first, then an old Live link's ?filter=", () => {
  expect(workViewFor("finished", "needs_me")).toBe("finished");
  expect(workViewFor(null, "needs_me")).toBe("attention");expect(workViewFor(null, "failed")).toBe("attention");expect(workViewFor(null, "team")).toBe("team");expect(workViewFor(null, "mine")).toBe("mine");
  expect(workViewFor(null, "all")).toBe("mine");expect(workViewFor(null, null)).toBe("mine");expect(workViewFor("bogus", undefined)).toBe("mine");
 });
});

describe("age", () => {
 it("reads <1 min, minutes, hours and days", () => {
  expect(formatAge(0)).toBe("<1 min");expect(formatAge(59_999)).toBe("<1 min");expect(formatAge(60_000)).toBe("1 min");expect(formatAge(59 * 60_000)).toBe("59 min");
  expect(formatAge(HOUR)).toBe("1 h");expect(formatAge(3 * HOUR + 59 * 60_000)).toBe("3 h");expect(formatAge(24 * HOUR)).toBe("1 d");expect(formatAge(49 * HOUR)).toBe("2 d");
 });
 it("treats a time from the future as no time at all", () => { expect(formatAge(-5 * HOUR)).toBe("<1 min"); });
});

describe("a live row", () => {
 it("says the plain state, waiting age and You for a decision waiting on me", () => {
  const row = rowFromLive(liveFixture({ kind: "task", status: "needs_person", statusWords: "Needs you: the plan needs your decision", needsYou: true, updatedAt: ago(3 * HOUR + 120_000) }), NOW);
  expect(row.state).toEqual({ label: "Needs a decision", tone: "attention" });expect(row.attention).toBe(true);expect(row.age).toBe("waiting 3 h");expect(row.next).toBe("You");
 });
 it("says updated, not waiting, for work that is not waiting on anyone, and Rovara works on its own states", () => {
  const row = rowFromLive(liveFixture({ kind: "task", status: "running", statusWords: "Checking", updatedAt: ago(5 * 60_000) }), NOW);
  expect(row.state.label).toBe("Checking");expect(row.attention).toBe(false);expect(row.age).toBe("updated 5 min ago");expect(row.next).toBe("Rovara");
  expect(rowFromLive(liveFixture({ updatedAt: ago(10_000) }), NOW).age).toBe("updated just now");
 });
 it("names no next actor when the data does not say", () => {
  // Someone else's decision: needsYou is false, so nobody is named.
  expect(rowFromLive(liveFixture({ kind: "task", status: "needs_person", statusWords: "Needs you: waiting on a reviewer", needsYou: false, actions: ["watch"] }), NOW).next).toBeUndefined();
  // A session on someone's own machine: Rovara is not the one working.
  expect(rowFromLive(liveFixture({ kind: "local", status: "running", statusWords: "Building", where: { kind: "mac", label: "Priya's MacBook", offline: false } }), NOW).next).toBeUndefined();
  // Paused for budget with no decision of mine, merged work, a failed run I am not offered Retry or Close on.
  expect(nextActor({ needsYou: false, kind: "task", actions: ["watch"] }, "paused_budget")).toBeUndefined();
  expect(nextActor({ needsYou: false, kind: "task", actions: ["watch"] }, "merged")).toBeUndefined();
  expect(nextActor({ needsYou: false, kind: "task", actions: ["watch"] }, "failed")).toBeUndefined();
  // An unknown state.
  expect(nextActor({ needsYou: false, kind: "task", actions: ["retry"] }, "something_new")).toBeUndefined();
 });
 it("names You for a failed or stopped run only when Retry or Close is offered", () => {
  const failed = { statusWords: "Failed: the run stopped with an error", status: "failed" as const };
  expect(rowFromLive(liveFixture({ kind: "task", ...failed, actions: ["watch", "retry"] }), NOW)).toMatchObject({ next: "You", attention: true, state: { label: "Failed", tone: "danger" } });
  expect(rowFromLive(liveFixture({ kind: "task", ...failed, actions: ["watch"] }), NOW).next).toBeUndefined();
 });
 it("says where it runs: Cloud or a person's machine, and whether that machine is offline", () => {
  expect(rowFromLive(liveFixture({ where: { kind: "cloud" } }), NOW).place).toEqual({ text: "Cloud", offline: false });
  expect(rowFromLive(liveFixture({ where: { kind: "mac", label: "Priya's MacBook", offline: true } }), NOW).place).toEqual({ text: "On Priya's MacBook", offline: true });
 });
 it("never shows a raw status or model id: a word this build does not know falls back to the session status", () => {
  expect(liveStatus({ status: "needs_person", statusWords: "Something new", lastRunFailed: undefined })).toEqual({ state: "needs_you" });
  expect(liveStatus({ status: "waiting", statusWords: "Something new", lastRunFailed: true })).toEqual({ state: "failed" });
  expect(liveStatus({ status: "running", statusWords: "Paused: needs more budget", lastRunFailed: undefined })).toEqual({ state: "paused_budget" });
  const row = rowFromLive(liveFixture({ status: "starting", statusWords: "Starting" }), NOW);expect(row.state.label).toBe("Understanding");
 });
 it("has no age when the time is unreadable", () => {
  const row = rowFromLive({ ...liveFixture(), updatedAt: "not a time" }, NOW);expect(row.age).toBeUndefined();expect(row.since).toBeUndefined();
 });
});

describe("a finished row", () => {
 it("says finished, how long ago, the plain state and where it ran, and never asks for attention or names who acts", () => {
  const row = rowFromFinished(finishedFixture({ endedAt: ago(2 * 24 * HOUR), summary: { ...finishedFixture().summary, status: "failed" } }), NOW);
  expect(row).toMatchObject({ age: "finished 2 d ago", attention: false, next: undefined, live: undefined, place: { text: "Cloud", offline: false }, state: { label: "Failed" } });
  expect(rowFromFinished(finishedFixture({ summary: { ...finishedFixture().summary, display: { state: "merged" } } }), NOW).state.label).toBe("Merged");
  expect(rowFromFinished(finishedFixture({ where: { kind: "mac", deviceId: "dvc_aaaaaaaaaaaaaaaaaaaa", label: "Priya's MacBook" } }), NOW).place?.text).toBe("On Priya's MacBook");
 });
});

describe("the order", () => {
 const row = (id: string, attention: boolean, ageMs: number): WorkRow => ({ ...rowFromLive(liveFixture({ sessionId: id }), NOW), attention, ageMs });
 it("puts what needs attention first, longest waiting at the top, then the rest, most recently changed first", () => {
  const sorted = sortRows([row("ses_aaaaaaaaaaaaaaaaaaaa", false, 10), row(SESSION_B, true, 5), row(SESSION_C, true, 50), row("ses_dddddddddddddddddddd", false, 1)]);
  expect(sorted.map(item => item.sessionId)).toEqual([SESSION_C, SESSION_B, "ses_dddddddddddddddddddd", "ses_aaaaaaaaaaaaaaaaaaaa"]);
 });
 it("keeps the given order for rows that tie, and sorts finished work newest first", () => {
  expect(sortRows([row(SESSION_B, false, 5), row(SESSION_C, false, 5)]).map(item => item.sessionId)).toEqual([SESSION_B, SESSION_C]);
  expect(sortFinished([row(SESSION_B, false, 50), row(SESSION_C, false, 5)]).map(item => item.sessionId)).toEqual([SESSION_C, SESSION_B]);
 });
});

type Tile = ReturnType<typeof liveFixture>;
function setup(options: { work?: boolean; path?: string; byFilter?: Record<string, Tile[]>; ended?: ReturnType<typeof finishedFixture>[]; theme?: "light" | "dark" } = {}) {
 const f = fakeHost(async (request: ApiRequest): Promise<ApiResponse> => {
  if (request.path.startsWith("/v1/app/live")) { const filter = new URL(request.path, "https://x.example").searchParams.get("filter") ?? "all";return { status: 200, body: { tiles: options.byFilter?.[filter] ?? [] } }; }
  if (request.path.startsWith("/v1/app/sessions?")) return { status: 200, body: { sessions: options.ended ?? [] } };
  if (request.path === "/v1/app/nav") return { status: 200, body: navFixture() };
  return { status: 200, body: { notices: [], next: "settled" } };
 });
 if (options.work !== false) f.storage.set("rovara.work", "v2");
 const query = createQueryClient(), router = createMemoryRouter([{ path: "/app/live", element: h(LiveScreen, {}) }], { initialEntries: [options.path ?? "/app/live"] });
 const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(Announcer, { children: h(RouterProvider, { router }) }) }) }), { theme: options.theme ?? "light" });
 const calls = () => f.request.mock.calls.map(([request]) => request.path);
 return { ...f, ...ui, query, router, calls, close() { ui.unmount();router.dispose();query.clear(); } };
}
const tile = (overrides: Partial<Tile>) => liveFixture({ updatedAt: new Date(Date.now() - 3 * HOUR - 60_000).toISOString(), ...overrides });

describe("the screen", () => {
 it("is today's list with the switch off: Live heading, five filters, no Work views", async () => {
  const f = setup({ work: false, byFilter: { all: [tile({})] } });await screen.findByRole("heading", { name: "Fix duplicate refunds" });
  expect(screen.getByRole("heading", { name: "Live", level: 1 })).toBeTruthy();expect(screen.getByRole("tab", { name: "Needs me" })).toBeTruthy();expect(screen.getByRole("tab", { name: "Failed" })).toBeTruthy();expect(screen.queryByRole("tab", { name: "Finished" })).toBeNull();expect(f.container.querySelector(".rv-work-row")).toBeNull();f.close();
 });
 it("shows the four views and a project filter with the switch on", async () => {
  const f = setup({ byFilter: { mine: [tile({})] } });await screen.findByRole("heading", { name: "Fix duplicate refunds" });
  expect(screen.getByRole("heading", { name: "Work", level: 1 })).toBeTruthy();expect(screen.getAllByRole("tab").map(item => item.textContent)).toEqual(["Mine", "Team", "Needs attention", "Finished"]);
  expect(screen.getByRole("tab", { name: "Mine" }).getAttribute("aria-selected")).toBe("true");expect(screen.getByRole("combobox", { name: "Project" })).toBeTruthy();expect(f.calls()).toContain("/v1/app/live?filter=mine");f.close();
 });
 it("shows one row with state, age, next actor and place, and no raw words", async () => {
  const f = setup({ byFilter: { mine: [tile({ kind: "task", status: "needs_person", statusWords: "Needs you: the plan needs your decision", needsYou: true, peek: "Worker status: RUNNING", step: "RUNNING", where: { kind: "mac", label: "Priya's MacBook", offline: false } })] } });
  const row = (await screen.findByRole("heading", { name: "Fix duplicate refunds" })).closest("li")!;
  expect(within(row).getByText("Needs a decision")).toBeTruthy();expect(within(row).getByText("waiting 3 h")).toBeTruthy();expect(within(row).getByText("You")).toBeTruthy();expect(within(row).getByText("On Priya's MacBook")).toBeTruthy();expect(within(row).getByRole("link", { name: "payments" })).toBeTruthy();
  expect(row.textContent).not.toMatch(/RUNNING|Worker status|needs_person|claude-|anthropic\./u);f.close();
 });
 it("leaves the next actor out when the data does not say", async () => {
  const f = setup({ byFilter: { mine: [tile({ kind: "task", status: "needs_person", statusWords: "Needs you: waiting on a reviewer", needsYou: false })] } });
  const row = (await screen.findByRole("heading", { name: "Fix duplicate refunds" })).closest("li")!;expect(within(row).getByText("Needs a decision")).toBeTruthy();expect(row.textContent).not.toContain("Next:");f.close();
 });
 it("lists Needs attention from both today's needs-me and failed filters, once each, needs-attention first and longest waiting first", async () => {
  const waiting = tile({ sessionId: SESSION_B, title: "Review the plan", kind: "task", status: "needs_person", statusWords: "Needs you: decide", needsYou: true, updatedAt: new Date(Date.now() - 5 * HOUR).toISOString() });
  const failed = tile({ sessionId: SESSION_C, title: "Retry the build", kind: "task", status: "failed", statusWords: "Failed: the run stopped with an error", actions: ["watch", "retry"], updatedAt: new Date(Date.now() - 9 * HOUR).toISOString() });
  const f = setup({ path: "/app/live?view=attention", byFilter: { needs_me: [waiting, failed], failed: [failed] } });await screen.findByRole("heading", { name: "Review the plan" });
  expect(f.calls()).toEqual(expect.arrayContaining(["/v1/app/live?filter=needs_me", "/v1/app/live?filter=failed"]));
  expect(screen.getAllByRole("heading", { level: 2 }).map(item => item.textContent)).toEqual(["Retry the build", "Review the plan"]);f.close();
 });
 it("reads Finished from the ended-sessions list: my own with no project, the project's with one", async () => {
  const f = setup({ path: "/app/live?view=finished", ended: [finishedFixture({ endedAt: new Date(Date.now() - 2 * 24 * HOUR).toISOString() })] });
  const row = (await screen.findByRole("heading", { name: "Fix duplicate refunds" })).closest("li")!;
  expect(within(row).getByText("finished 2 d ago")).toBeTruthy();expect(within(row).getByText("Closed")).toBeTruthy();expect(within(row).queryByRole("button")).toBeNull();expect(f.calls()).toContain("/v1/app/sessions?owner=me&status=ended");expect(screen.getByText(/Your finished work/u)).toBeTruthy();
  f.close();
  const withProject = setup({ path: "/app/live?view=finished&project=payments", ended: [] });await screen.findByText("No finished work yet");expect(withProject.calls()).toContain("/v1/app/sessions?project=payments&status=ended");expect(screen.getByText("Finished work in payments")).toBeTruthy();withProject.close();
 });
 it("shows an honest empty state per view", async () => {
  const f = setup({ path: "/app/live?view=attention" });await screen.findByText("Nothing needs attention");f.close();
 });
 it("takes an old Live link and writes the view and project back to the address", async () => {
  const f = setup({ path: "/app/live?filter=needs_me&project=payments", byFilter: { needs_me: [tile({})] } });await screen.findByRole("heading", { name: "Fix duplicate refunds" });
  expect(screen.getByRole("tab", { name: "Needs attention" }).getAttribute("aria-selected")).toBe("true");
  fireEvent.mouseDown(screen.getByRole("tab", { name: "Team" }), { button: 0, ctrlKey: false });await waitFor(() => expect(f.router.state.location.search).toContain("view=team"));expect(f.router.state.location.search).not.toContain("filter=");expect(f.router.state.location.search).toContain("project=payments");
  expect(f.calls()).toContain("/v1/app/live?filter=needs_me&project=payments");f.close();
 });
 it("keeps the person's own Approve button and session actions on a live row", async () => {
  const f = setup({ byFilter: { mine: [tile({ actions: ["watch", "stop"], approvalUrl: "https://cell.example/v1/app/approve/apr_aaaaaaaaaaaaaaaaaaaa" })] } });await screen.findByRole("heading", { name: "Fix duplicate refunds" });
  fireEvent.click(screen.getByRole("button", { name: "Approve" }));expect(f.host.openExternal).toHaveBeenCalledWith("https://cell.example/v1/app/approve/apr_aaaaaaaaaaaaaaaaaaaa");expect(screen.getByRole("button", { name: "Follow" })).toBeTruthy();f.close();
 });
 for (const theme of ["light", "dark"] as const) it("has no accessibility violations in " + theme, async () => {
  const f = setup({ theme, byFilter: { mine: [tile({ kind: "task", status: "needs_person", statusWords: "Needs you: decide", needsYou: true }), tile({ sessionId: SESSION_B, title: "Another task" })] } });await screen.findByRole("heading", { name: "Another task" });await expectNoAxeViolations(f.container);f.close();
 });
});
