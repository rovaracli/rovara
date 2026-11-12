// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, fireEvent, waitFor, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { WorkListScreen } from "../../packages/ui/src/screens/live/WorkListScreen.js";
import { FINISHED_AS_WORDS, WORK_VIEWS, finishedState, formatAge, liveFiltersFor, liveStatus, nextActor, rowFromFinished, rowFromLive, sortFinished, sortRows, workViewFor, type WorkRow } from "../../packages/ui/src/screens/live/work-list.js";
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
 it("says the plain state, updated age and You for a decision waiting on me", () => {
  const row = rowFromLive(liveFixture({ kind: "task", status: "needs_person", statusWords: "Needs you: the plan needs your decision", needsYou: true, updatedAt: ago(3 * HOUR + 120_000) }), NOW);
  expect(row.state).toEqual({ label: "Needs a decision", tone: "attention" });expect(row.attention).toBe(true);expect(row.age).toBe("updated 3 h ago");expect(row.next).toBe("You");
 });
 it("says updated for work that is not waiting on anyone, and Rovara works on its own states", () => {
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
 it("names You for a failed or stopped run only when the broker says it is mine (needsYou) or Close is offered: Retry alone says nothing about who must act", () => {
  const failed = { statusWords: "Failed: the run stopped with an error", status: "failed" as const };
  expect(rowFromLive(liveFixture({ kind: "task", ...failed, needsYou: true, actions: ["watch", "retry"] }), NOW)).toMatchObject({ next: "You", attention: true, state: { label: "Failed", tone: "danger" } });
  expect(rowFromLive(liveFixture({ kind: "task", ...failed, actions: ["watch", "close"] }), NOW).next).toBe("You");
  expect(rowFromLive(liveFixture({ kind: "task", ...failed, actions: ["watch", "retry"] }), NOW).next).toBeUndefined();
  expect(rowFromLive(liveFixture({ kind: "task", ...failed, actions: ["watch"] }), NOW).next).toBeUndefined();
  expect(nextActor({ needsYou: false, kind: "task", actions: ["watch", "retry"] }, "failed")).toBeUndefined();
 });
 it("never says waiting: the broker has no waiting-since time, so every live row counts from its last update", () => {
  for (const tile of [liveFixture({ kind: "task", status: "needs_person", statusWords: "Needs you: decide", needsYou: true }), liveFixture({ kind: "task", status: "failed", statusWords: "Failed: it stopped", actions: ["retry"] }), liveFixture({})]) expect(rowFromLive({ ...tile, updatedAt: ago(7 * HOUR) }, NOW).age).toBe("updated 7 h ago");
 });
 it("marks a row as needing attention only where the broker says the viewer is the one to act (needsYou), may dismiss it (canDismiss) or may approve it: Retry or Close alone do not", () => {
  const failed = { kind: "task" as const, status: "failed" as const, statusWords: "Failed: it stopped" };
  expect(rowFromLive(liveFixture({ ...failed, actions: ["watch"] }), NOW).attention).toBe(false);
  expect(rowFromLive(liveFixture({ ...failed, actions: ["watch", "retry"] }), NOW).attention).toBe(false);
  expect(rowFromLive(liveFixture({ ...failed, needsYou: true, actions: ["watch", "retry"] }), NOW).attention).toBe(true);
  expect(rowFromLive(liveFixture({ kind: "task", status: "needs_person", statusWords: "Ready to merge", actions: ["watch", "close"] }), NOW).attention).toBe(false);
  expect(rowFromLive(liveFixture({ kind: "task", status: "needs_person", statusWords: "Needs you: waiting on a reviewer", needsYou: false, actions: ["watch"] }), NOW).attention).toBe(false);
  expect(rowFromLive(liveFixture({ kind: "task", status: "needs_person", statusWords: "Needs you: decide", needsYou: true, actions: ["watch"] }), NOW).attention).toBe(true);
  expect(rowFromLive(liveFixture({ kind: "task", status: "needs_person", statusWords: "Needs you: decide", approvalUrl: "https://cell.example/v1/app/approve/apr_aaaaaaaaaaaaaaaaaaaa" }), NOW).attention).toBe(true);
 });
 it("says an ended failed session is Failed (ended), with Open and Dismiss to offer, and names nobody who acts next", () => {
  const ended = { kind: "task" as const, status: "failed" as const, statusWords: "Failed: it stopped", endedAt: ago(2 * HOUR), actions: ["watch", "comment", "share"] as never };
  expect(rowFromLive(liveFixture({ ...ended, canDismiss: true }), NOW)).toMatchObject({ state: { label: "Failed (ended)", tone: "danger" }, attention: true, next: undefined, ended: { endedAt: ago(2 * HOUR), canDismiss: true } });
  // A teammate's ended failure: it is listed, but it is not theirs to dismiss or to act on.
  expect(rowFromLive(liveFixture(ended), NOW)).toMatchObject({ state: { label: "Failed (ended)" }, attention: false, next: undefined, ended: { canDismiss: false } });
  // Even a tile that still said needsYou or offered Close names nobody for an ended session.
  expect(nextActor({ needsYou: true, kind: "task", actions: ["close"], endedAt: ago(HOUR) }, "failed")).toBeUndefined();
  // An open failed row has no `ended` and keeps "Failed".
  expect(rowFromLive(liveFixture({ kind: "task", status: "failed", statusWords: "Failed: it stopped" }), NOW)).toMatchObject({ state: { label: "Failed" }, ended: undefined });
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

describe("how a finished session ended", () => {
 it("has plain words for each finishedAs, and none for a session an older server sent without it", () => {
  expect(Object.fromEntries(Object.entries(FINISHED_AS_WORDS).map(([key, state]) => [key, state.label]))).toEqual({ merged: "Merged", closed: "Closed", finished_no_code: "Finished (no code)", finished: "Finished" });
  const own = { label: "Failed", tone: "danger" as const };
  // A failed run is never hidden by a word that reads as success or as a tidy ending; only a merged pull request outranks it.
  for (const word of ["closed", "finished_no_code", "finished", "unknown"]) expect(finishedState(word, own), word).toBe(own);
  expect(finishedState("merged", own)).toEqual({ label: "Merged", tone: "success" });
  expect(finishedState(undefined, own)).toBe(own);expect(finishedState("unknown", own)).toBe(own);expect(finishedState("finished", own)).toBe(own);expect(finishedState("merged", own)).toEqual({ label: "Merged", tone: "success" });
  expect(rowFromFinished(finishedFixture({ finishedAs: "finished_no_code" }), NOW).state).toEqual({ label: "Finished (no code)", tone: "success" });
  const failed = { ...finishedFixture().summary, status: "failed" as const };
  expect(rowFromFinished(finishedFixture({ finishedAs: "closed", summary: failed }), NOW).state).toEqual({ label: "Failed", tone: "danger" });
  expect(rowFromFinished(finishedFixture({ finishedAs: "finished_no_code", summary: failed }), NOW).state).toEqual({ label: "Failed", tone: "danger" });
  expect(rowFromFinished(finishedFixture({ finishedAs: "merged", summary: failed }), NOW).state).toEqual({ label: "Merged", tone: "success" });
 });
});

describe("the order", () => {
 const row = (id: string, attention: boolean, ageMs: number): WorkRow => ({ ...rowFromLive(liveFixture({ sessionId: id }), NOW), attention, ageMs });
 it("puts what needs attention first, then the rest, each most recently updated first", () => {
  const sorted = sortRows([row("ses_aaaaaaaaaaaaaaaaaaaa", false, 10), row(SESSION_B, true, 5), row(SESSION_C, true, 50), row("ses_dddddddddddddddddddd", false, 1)]);
  expect(sorted.map(item => item.sessionId)).toEqual([SESSION_B, SESSION_C, "ses_dddddddddddddddddddd", "ses_aaaaaaaaaaaaaaaaaaaa"]);
 });
 it("keeps the given order for rows that tie, and sorts finished work newest first", () => {
  expect(sortRows([row(SESSION_B, false, 5), row(SESSION_C, false, 5)]).map(item => item.sessionId)).toEqual([SESSION_B, SESSION_C]);
  expect(sortFinished([row(SESSION_B, false, 50), row(SESSION_C, false, 5)]).map(item => item.sessionId)).toEqual([SESSION_C, SESSION_B]);
 });
});

type Tile = ReturnType<typeof liveFixture>;
function setup(options: { path?: string; byFilter?: Record<string, Tile[]>; failFilter?: string; dismiss?: ApiResponse; ended?: ReturnType<typeof finishedFixture>[]; cut?: boolean; theme?: "light" | "dark" } = {}) {
 const f = fakeHost(async (request: ApiRequest): Promise<ApiResponse> => {
  if (request.path.startsWith("/v1/app/live")) { const filter = new URL(request.path, "https://x.example").searchParams.get("filter") ?? "all";if (filter === options.failFilter) return { status: 403, body: { error: { code: "FORBIDDEN", message: "Your access ended." } } };return { status: 200, body: { tiles: options.byFilter?.[filter] ?? [] } }; }
  if (request.method === "POST" && request.path.startsWith("/v1/app/home/cards/")) {
   if (options.dismiss !== undefined) return options.dismiss;
   // As the broker does: the dismissed failure leaves Needs attention's Failed list.
   const cardId = decodeURIComponent(request.path.slice("/v1/app/home/cards/".length).split("/")[0]!);
   for (const [filter, tiles] of Object.entries(options.byFilter ?? {})) (options.byFilter as Record<string, Tile[]>)[filter] = tiles.filter(entry => "failure:" + entry.sessionId !== cardId);
   return { status: 200, body: { cardId, dismissed: true } };
  }
  if (request.path.startsWith("/v1/app/sessions?")) return { status: 200, body: { sessions: options.ended ?? [], ...(options.cut === true ? { projectsCut: true } : {}) } };
  if (request.path === "/v1/app/nav") return { status: 200, body: navFixture() };
  return { status: 200, body: { notices: [], next: "settled" } };
 });
 const query = createQueryClient(), router = createMemoryRouter([{ path: "/app/live", element: h(WorkListScreen, {}) }], { initialEntries: [options.path ?? "/app/live"] });
 const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(Announcer, { children: h(RouterProvider, { router }) }) }) }), { theme: options.theme ?? "light" });
 const calls = () => f.request.mock.calls.map(([request]) => request.path);
 return { ...f, ...ui, query, router, calls, close() { ui.unmount();router.dispose();query.clear(); } };
}
const tile = (overrides: Partial<Tile>) => liveFixture({ updatedAt: new Date(Date.now() - 3 * HOUR - 60_000).toISOString(), ...overrides });

describe("the screen", () => {
 it("shows the four views and a project filter (the only list since decision 125)", async () => {
  const f = setup({ byFilter: { mine: [tile({})] } });await screen.findByRole("heading", { name: "Fix duplicate refunds" });
  expect(screen.getByRole("heading", { name: "Work", level: 1 })).toBeTruthy();expect(screen.getAllByRole("tab").map(item => item.textContent)).toEqual(["Mine", "Team", "Needs attention", "Finished"]);
  expect(screen.getByRole("tab", { name: "Mine" }).getAttribute("aria-selected")).toBe("true");expect(screen.getByRole("combobox", { name: "Project" })).toBeTruthy();expect(f.calls()).toContain("/v1/app/live?filter=mine");f.close();
 });
 it("shows one row with state, age, next actor and place, and no raw words", async () => {
  const f = setup({ byFilter: { mine: [tile({ kind: "task", status: "needs_person", statusWords: "Needs you: the plan needs your decision", needsYou: true, peek: "Worker status: RUNNING", step: "RUNNING", where: { kind: "mac", label: "Priya's MacBook", offline: false } })] } });
  const row = (await screen.findByRole("heading", { name: "Fix duplicate refunds" })).closest("li")!;
  expect(within(row).getByText("Needs a decision")).toBeTruthy();expect(within(row).getByText("updated 3 h ago")).toBeTruthy();expect(within(row).getByText("You")).toBeTruthy();expect(within(row).getByText("On Priya's MacBook")).toBeTruthy();expect(within(row).getByRole("link", { name: "payments" })).toBeTruthy();
  expect(row.textContent).not.toMatch(/RUNNING|Worker status|needs_person|claude-|anthropic\./u);f.close();
 });
 it("leaves the next actor out when the data does not say", async () => {
  const f = setup({ byFilter: { mine: [tile({ kind: "task", status: "needs_person", statusWords: "Needs you: waiting on a reviewer", needsYou: false })] } });
  const row = (await screen.findByRole("heading", { name: "Fix duplicate refunds" })).closest("li")!;expect(within(row).getByText("Needs a decision")).toBeTruthy();expect(row.textContent).not.toContain("Next:");f.close();
 });
 it("lists Needs attention from both today's needs-me and failed filters, once each, most recently updated first", async () => {
  const waiting = tile({ sessionId: SESSION_B, title: "Review the plan", kind: "task", status: "needs_person", statusWords: "Needs you: decide", needsYou: true, updatedAt: new Date(Date.now() - 5 * HOUR).toISOString() });
  const failed = tile({ sessionId: SESSION_C, title: "Retry the build", kind: "task", status: "failed", statusWords: "Failed: the run stopped with an error", actions: ["watch", "retry"], updatedAt: new Date(Date.now() - 9 * HOUR).toISOString() });
  const f = setup({ path: "/app/live?view=attention", byFilter: { needs_me: [waiting, failed], failed: [failed] } });await screen.findByRole("heading", { name: "Review the plan" });
  expect(f.calls()).toEqual(expect.arrayContaining(["/v1/app/live?filter=needs_me", "/v1/app/live?filter=failed"]));
  expect(screen.getAllByRole("heading", { level: 2 }).map(item => item.textContent)).toEqual(["Review the plan", "Retry the build"]);f.close();
 });
 describe("an ended failed session in Needs attention", () => {
  const endedAt = new Date(Date.now() - 2 * HOUR).toISOString();
  const ended = () => tile({ sessionId: SESSION_C, title: "Draft the setup", kind: "task", status: "failed", statusWords: "Failed: it stopped", endedAt, canDismiss: true, actions: ["watch", "comment", "share"] });
  it("reads Failed (ended) with Open and Dismiss, and none of Stop, Retry, Follow or Take over", async () => {
   const f = setup({ path: "/app/live?view=attention", byFilter: { failed: [ended()] } });
   const row = (await screen.findByRole("heading", { name: "Draft the setup" })).closest("li")!;
   expect(within(row).getByText("Failed (ended)")).toBeTruthy();expect(row.getAttribute("data-attention")).toBe("true");expect(row.textContent).not.toContain("Next:");
   expect(within(row).getAllByRole("button").map(button => button.textContent)).toEqual(["Open", "Dismiss"]);
   for (const name of ["Stop", "Retry", "Follow", "Take over"]) expect(within(row).queryByRole("button", { name })).toBeNull();
   const navigate = vi.spyOn(f.host, "navigate");fireEvent.click(within(row).getByRole("button", { name: "Open" }));expect(navigate).toHaveBeenCalledWith("/app/sessions/" + SESSION_C);f.close();
  });
  it("offers a teammate's ended failure only Open", async () => {
   const f = setup({ path: "/app/live?view=attention", byFilter: { failed: [{ ...ended(), canDismiss: undefined }] } });
   const row = (await screen.findByRole("heading", { name: "Draft the setup" })).closest("li")!;
   expect(within(row).getAllByRole("button").map(button => button.textContent)).toEqual(["Open"]);expect(row.getAttribute("data-attention")).toBeNull();f.close();
  });
  it("dismisses with Home's own dismissal (the failure's card id and the happening that ended) and the row leaves the list", async () => {
   const f = setup({ path: "/app/live?view=attention", byFilter: { failed: [ended()] } });
   const row = (await screen.findByRole("heading", { name: "Draft the setup" })).closest("li")!;
   fireEvent.click(within(row).getByRole("button", { name: "Dismiss" }));
   await waitFor(() => expect(f.request.mock.calls.map(([request]) => request.method + " " + request.path)).toContain("POST /v1/app/home/cards/failure%3A" + SESSION_C + "/dismiss?occurrence=" + encodeURIComponent("ended:" + endedAt)));
   await screen.findByText("Nothing needs attention");expect(screen.queryByRole("heading", { name: "Draft the setup" })).toBeNull();f.close();
  });
  it("says so when the dismissal fails and keeps the row, with no stale message once it works", async () => {
   const f = setup({ path: "/app/live?view=attention", byFilter: { failed: [ended()] }, dismiss: { status: 500, body: { error: { code: "INTERNAL", message: "Couldn't dismiss right now." } } } });
   const row = (await screen.findByRole("heading", { name: "Draft the setup" })).closest("li")!;
   fireEvent.click(within(row).getByRole("button", { name: "Dismiss" }));
   expect((await within(row).findByRole("alert")).textContent).toContain("dismiss");expect(screen.getByRole("heading", { name: "Draft the setup" })).toBeTruthy();f.close();
  });
 });
 it("reads Finished from the ended-sessions list: everything the reader may open (company scope) with no project, the project's with one", async () => {
  const f = setup({ path: "/app/live?view=finished", ended: [finishedFixture({ endedAt: new Date(Date.now() - 2 * 24 * HOUR).toISOString() })] });
  const row = (await screen.findByRole("heading", { name: "Fix duplicate refunds" })).closest("li")!;
  expect(within(row).getByText("finished 2 d ago")).toBeTruthy();expect(within(row).getByText("Closed")).toBeTruthy();expect(within(row).queryByRole("button")).toBeNull();expect(f.calls()).toContain("/v1/app/sessions?scope=company&status=ended");expect(f.calls().some(path => path.includes("owner=me"))).toBe(false);expect(screen.getByText(/Finished work you can open/u)).toBeTruthy();
  f.close();
  const withProject = setup({ path: "/app/live?view=finished&project=payments", ended: [] });await screen.findByText("No finished work yet");expect(withProject.calls()).toContain("/v1/app/sessions?project=payments&status=ended");expect(screen.getByText("Finished work in payments")).toBeTruthy();withProject.close();
 });
 it("says how each finished session ended, in plain words, from finishedAs; a failed run that the server calls plain finished keeps Failed", async () => {
  const ended = [
   finishedFixture({ sessionId: "ses_aaaaaaaaaaaaaaaaaaaa", title: "Merged one", finishedAs: "merged" }), finishedFixture({ sessionId: SESSION_B, title: "Closed one", finishedAs: "closed" }),
   finishedFixture({ sessionId: SESSION_C, title: "Answered one", finishedAs: "finished_no_code" }), finishedFixture({ sessionId: "ses_dddddddddddddddddddd", title: "Plain one", finishedAs: "finished" }),
   finishedFixture({ sessionId: "ses_eeeeeeeeeeeeeeeeeeee", title: "Failed one", finishedAs: "finished", summary: { ...finishedFixture().summary, status: "failed" } }), finishedFixture({ sessionId: "ses_ffffffffffffffffffff", title: "Older server" }),
  ];
  const f = setup({ path: "/app/live?view=finished", ended });await screen.findByRole("heading", { name: "Merged one" });
  const word = (title: string) => within((screen.getByRole("heading", { name: title }).closest("li")) as HTMLElement).getByText(/^(Merged|Closed|Finished \(no code\)|Finished|Failed)$/u).textContent;
  expect([word("Merged one"), word("Closed one"), word("Answered one"), word("Plain one"), word("Failed one"), word("Older server")]).toEqual(["Merged", "Closed", "Finished (no code)", "Finished", "Failed", "Closed"]);
  f.close();
 });
 it("keeps the company-wide Finished list and a project that is literally named company apart in the cache", async () => {
  const keys = (f: ReturnType<typeof setup>) => f.query.getQueryCache().findAll({ queryKey: ["live", "finished"] }).map(entry => entry.queryKey[2]);
  const project = setup({ path: "/app/live?view=finished&project=company", ended: [finishedFixture()] });await screen.findByRole("heading", { name: "Fix duplicate refunds" });
  expect(keys(project)).toEqual([{ project: "company" }]);expect(project.calls()).toContain("/v1/app/sessions?project=company&status=ended");expect(project.calls().some(path => path.includes("scope=company"))).toBe(false);project.close();
  const whole = setup({ path: "/app/live?view=finished", ended: [finishedFixture()] });await screen.findByRole("heading", { name: "Fix duplicate refunds" });
  expect(keys(whole)).toEqual([{ scope: "company" }]);expect(whole.calls()).toContain("/v1/app/sessions?scope=company&status=ended");
  // A realtime notice that refreshes Live (the ["live"] prefix) still refreshes it.
  const before = whole.calls().filter(path => path.startsWith("/v1/app/sessions?")).length;await whole.query.invalidateQueries({ queryKey: ["live"] });
  await waitFor(() => expect(whole.calls().filter(path => path.startsWith("/v1/app/sessions?")).length).toBeGreaterThan(before));whole.close();
 });
 it("says some projects are left out when the answer says so, and only on the all-projects Finished list", async () => {
  const f = setup({ path: "/app/live?view=finished", ended: [finishedFixture()], cut: true });await screen.findByRole("heading", { name: "Fix duplicate refunds" });
  expect(screen.getByText("Some projects aren't included; filter by project to see them.")).toBeTruthy();f.close();
  const whole = setup({ path: "/app/live?view=finished", ended: [finishedFixture()] });await screen.findByRole("heading", { name: "Fix duplicate refunds" });
  expect(screen.queryByText(/Some projects aren't included/u)).toBeNull();whole.close();
  const one = setup({ path: "/app/live?view=finished&project=payments", ended: [finishedFixture()], cut: true });await screen.findByRole("heading", { name: "Fix duplicate refunds" });
  expect(screen.queryByText(/Some projects aren't included/u)).toBeNull();one.close();
 });
 it("keeps what loaded when one of the two Needs attention reads fails, with a notice; the empty state still carries the notice", async () => {
  const plan = tile({ sessionId: SESSION_B, title: "Review the plan", kind: "task", status: "needs_person", statusWords: "Needs you: decide", needsYou: true });
  const f = setup({ path: "/app/live?view=attention", byFilter: { needs_me: [plan] }, failFilter: "failed" });await screen.findByRole("heading", { name: "Review the plan" });
  expect(await screen.findByText("Some work couldn't be loaded, so this list may be incomplete.")).toBeTruthy();expect(screen.getAllByRole("button", { name: "Try again" })).toHaveLength(1);f.close();
  const empty = setup({ path: "/app/live?view=attention", failFilter: "failed", byFilter: {} });await screen.findByText("Nothing needs attention");expect(await screen.findByText(/may be incomplete/u)).toBeTruthy();empty.close();
 });
 it("refreshes the Finished list when a notice refreshes Live", async () => {
  const f = setup({ path: "/app/live?view=finished", ended: [] });await screen.findByText("No finished work yet");const before = f.calls().filter(path => path.startsWith("/v1/app/sessions?")).length;
  await f.query.invalidateQueries({ queryKey: ["live"] });await waitFor(() => expect(f.calls().filter(path => path.startsWith("/v1/app/sessions?")).length).toBeGreaterThan(before));f.close();
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
