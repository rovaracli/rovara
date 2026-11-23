// @vitest-environment jsdom
import { useEffect } from "react";
import { describe, expect, it, vi } from "vitest";
import { act, screen, within, waitFor } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { ApiError } from "../../../../packages/ui/src/api/errors.js";
import { ReadState } from "../../../../packages/ui/src/screens/rules-lessons-read/ReadState.js";
import { StaleScope, StaleSlot } from "../../../../packages/ui/src/screens/rules-lessons-read/stale.js";
import { renderUi } from "../../support/render.js";
import { h } from "../../support/h.js";
import { mount } from "./mount.js";
import { bodies, responder } from "./fixtures.js";

describe("G4 fixes A: shared served-read policy", () => {
 const at = Date.UTC(2026, 10, 22, 9, 15);
 for (const [name, error] of [
  ["network", new ApiError(0, "NETWORK_ERROR", "Offline")],
  ["timeout", new Error("Timed out")], ["server", new ApiError(503, "UNAVAILABLE", "Unavailable")],
  ["unreadable", new ApiError(502, "INVALID_RESPONSE", "Unreadable")], ["unknown", undefined],
 ] as const) {
  it("keeps facts and their original viewer-local time after " + name, async () => {
   renderUi(h(StaleScope, null, h(StaleSlot), h(ReadState<string>, { read: { data: "Private fact", dataUpdatedAt: at, isPending: false, isFetching: false, isError: true, failureCount: 1, error, refetch: vi.fn() }, children: data => h("p", null, data) })));
   expect(screen.getByText("Private fact")).toBeTruthy();
   expect((await screen.findByRole("status")).textContent).toBe(`Updated ${new Date(at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })} · Reconnecting`);
   expect(screen.queryByRole("alert")).toBeNull();
  });
 }
 it("does not remount the children when a fresh read turns stale (a write in flight keeps its state)", () => {
  let mounts = 0;
  const Probe = () => { useEffect(() => { mounts += 1; }, []);return h("p", null, "Private fact"); };
  const fresh = { data: "x", dataUpdatedAt: at, isPending: false, isFetching: false, isError: false, failureCount: 0, error: null, refetch: vi.fn() };
  const view = renderUi(h(StaleScope, null, h(ReadState<string>, { read: fresh, children: () => h(Probe) })));
  view.rerender(h("div", { "data-theme": "light" }, h(StaleScope, null, h(ReadState<string>, { read: { ...fresh, isError: true, failureCount: 1, error: new ApiError(503, "UNAVAILABLE", "x") }, children: () => h(Probe) }))));
  expect(mounts).toBe(1);
 });
 it("keeps the facts on screen while a re-read is in flight (a mounted write must not lose its outcome)", () => {
  renderUi(h(ReadState<string>, { read: { data: "Private fact", dataUpdatedAt: at, isPending: false, isFetching: true, isError: false, failureCount: 0, error: null, refetch: vi.fn() }, children: data => h("p", null, data) }));
  expect(screen.getByText("Private fact")).toBeTruthy();
  expect(screen.queryByText("Reading this section…")).toBeNull();
 });
 for (const error of [new ApiError(401, "AUTH_REQUIRED", "Ended"), new ApiError(403, "FORBIDDEN", "Ended"), new ApiError(404, "NOT_FOUND", "Ended"), new ApiError(200, "ACCESS_ENDED", "Ended")]) {
  for (const duringRetry of [false, true]) {
   it(`wipes facts and classifies ${error.status}/${error.code} access loss (retry=${duringRetry})`, () => {
    renderUi(h(ReadState<string>, { read: { data: "Private fact", dataUpdatedAt: at, isPending: false, isFetching: duringRetry, isError: !duringRetry, failureCount: 1, error: duringRetry ? null : error, failureReason: duringRetry ? error : null, refetch: vi.fn() }, children: data => h("p", null, data) }));
    expect(screen.queryByText("Private fact")).toBeNull();
    expect(screen.getByRole("alert").getAttribute("data-kind")).toBe("denied");
   });
  }
 }
 for (const [status, kind] of [[501, "unknown"], [400, "failed"], [404, "denied"]] as const) {
  it(`keeps the first-read ${status} state without inventing stale data`, () => {
   const view = renderUi(h(StaleScope, null, h(StaleSlot), h(ReadState<string>, { read: { data: undefined, dataUpdatedAt: 0, isPending: false, isFetching: false, isError: true, failureCount: 1, error: new ApiError(status, "READ_FAILED", "Failed"), refetch: vi.fn() }, children: data => h("p", null, data) })));
   expect(view.container.querySelector(`[data-kind=${kind}]`)).toBeTruthy();
   expect(screen.queryByRole("status")).toBeNull();
  });
 }
 for (const [route, target, fact] of [
  ["/app/admin/how-we-work/recipes", "/setup-recipes", "1 recipe"],
  ["/app/projects/payments?tab=how-we-work", "/playbook", "On for new tasks"],
 ] as const) {
  it("keeps metadata with retained facts, then wipes both on refusal: " + target, async () => {
   let failure: ApiError | undefined;const answer = responder();
   const view = mount(route, async request => { if (failure && new URL(request.path, "https://fixture.invalid").pathname.endsWith(target)) throw failure;return answer(request); });
   await screen.findByText(fact);
   failure = new ApiError(503, "UNAVAILABLE", "Unavailable");
   await act(async () => { await view.query.invalidateQueries(); });
   expect(screen.getByText(fact)).toBeTruthy();expect(await screen.findAllByText(/Updated .* · Reconnecting/)).toHaveLength(1);
   expect(screen.queryByText(/The current setting could not be read/)).toBeNull();
   failure = new ApiError(404, "NOT_FOUND", "Ended");
   await act(async () => { await view.query.invalidateQueries(); });
   await waitFor(() => expect(screen.queryByText(fact)).toBeNull());
   expect(screen.queryByText(/Reconnecting/)).toBeNull();
   expect(screen.getAllByRole("alert").some(node => node.getAttribute("data-kind") === "denied")).toBe(true);
   expect(view.query.getQueriesData({ predicate: query => query.state.status === "error" }).every(([, data]) => data === undefined)).toBe(true);
  });
 }
 it("retains weekly New badges alongside the retained weekly picks", async () => {
  const data = bodies();data.weekly.weekly.picks = [{ lessonId: data.page.lessons[0]!.id, title: "A new pick" }];
  let fail = false;const answer = responder(data);const view = mount("/app/projects/payments?tab=lessons", async request => { if (fail && request.path.endsWith("/weekly")) throw new ApiError(0, "NETWORK_ERROR", "Offline");return answer(request); });
  await screen.findByText("New");fail = true;
  await act(async () => { await view.query.invalidateQueries(); });
  expect(screen.getByText("New")).toBeTruthy();expect(screen.getByText(/A new pick/)).toBeTruthy();
 });
 it("retains one identity-backed header through repeated failures, replaces success, then erases identity on access loss and remount", async () => {
  let failure: ApiError | undefined;const data = bodies(), answer = responder(data);
  const view = mount("/app/admin/how-we-work/recipes", async request => { if (failure && request.path === "/v1/app/me") throw failure;return answer(request); });
  await screen.findByText("1 recipe");
  const identity = view.query.getQueryCache().getAll().find(query => query.queryKey.at(-1) === "identity")!;
  const original = identity.state.dataUpdatedAt;
  failure = new ApiError(0, "NETWORK_ERROR", "Offline");
  for (let attempt = 0; attempt < 2; attempt++) {
   await act(async () => { await view.query.invalidateQueries(); });
   expect(screen.getAllByRole("heading", { level: 1, name: "Setup recipes" })).toHaveLength(1);
   expect(await screen.findAllByText(/Updated .* · Reconnecting/)).toHaveLength(1);
   expect(identity.state.dataUpdatedAt).toBe(original);
  }
  failure = undefined;data.recipes.recipes[0]!.label = "Updated recipe";
  await act(async () => { await view.query.invalidateQueries(); });
  expect(await screen.findByRole("button", { name: "Open Updated recipe" })).toBeTruthy();expect(screen.queryByText(/Reconnecting/)).toBeNull();
  failure = new ApiError(200, "ACCESS_ENDED", "Ended");
  await act(async () => { await view.query.invalidateQueries(); });
  await waitFor(() => expect(screen.queryByText("1 recipe")).toBeNull());expect(identity.state.data).toBeUndefined();
  await act(async () => { await view.router.navigate("/app/admin/how-we-work");await view.router.navigate("/app/admin/how-we-work/recipes"); });
  expect(screen.queryByText("1 recipe")).toBeNull();expect(screen.getByRole("alert").getAttribute("data-kind")).toBe("denied");
 });
});

describe("G4 fixes A: served evidence", () => {
 it("labels named recipe projects as eligible while actual adoption stays unknown", async () => {
  const data = bodies();data.recipes.recipes[0]!.scope = { kind: "projects", projects: ["payments"] };
  mount("/app/admin/how-we-work/recipes", responder(data));
  const eligible = await screen.findByRole("region", { name: "Who can use it" });
  expect(within(eligible).getByText(/payments/)).toBeTruthy();
  const usage = screen.getByRole("region", { name: "Projects using it" });
  expect(within(usage).getByText("We can’t tell yet which projects use it.")).toBeTruthy();expect(within(usage).queryByText("payments")).toBeNull();
 });
 it("keeps the member-view scene on the held list, never as served member proof", () => {
  const held = JSON.parse(readFileSync("tests/web/read-only/rules-lessons-read/held-states.json", "utf8")) as Array<{ held: string[] }>;
  expect(held.some(row => row.held.includes("project-how-member-view"))).toBe(true);
 });
});
