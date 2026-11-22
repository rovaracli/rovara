// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { AppNavReaderSchema } from "@agentx/contracts/web";
import { AppHostProvider, type ApiResponse } from "../../packages/ui/src/host.js";
import { appRoutes } from "../../packages/ui/src/routes.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { Announcer } from "../../packages/ui/src/design/Announcer.js";
import { fakeHost } from "./support/fake-host.js";
import { renderUi } from "./support/render.js";
import { h } from "./support/h.js";
import { meFixture } from "./support/fixtures.js";
import { sceneReplies, unitScenes } from "./support/work-inbox-scenes.js";
import { ID, NOW } from "./support/work-fixture.js";

beforeEach(() => { vi.setSystemTime(NOW); });
afterEach(() => { vi.useRealTimers();localStorage.clear(); });
function mount(path: string, sceneId = "work-all") {
 const scene = unitScenes.find(item => item.id === sceneId)!;
 const replies: Record<string, ApiResponse> = { ...sceneReplies(scene), "/v1/app/me": { status: 200, body: meFixture() } };
 const f = fakeHost(async request => {
  if (request.method === "POST" && request.path === "/v1/app/inbox/read") {
   replies["/v1/app/inbox"] = { status: 200, body: { items: [], unread: 0 } };
   return { status: 200, body: { marked: 1 } };
  }
  return replies[request.path.split("?")[0]!] ?? { status: 404, body: { error: { code: "NOT_FOUND", message: "not served" } } };
 });
 const nav = AppNavReaderSchema.parse(replies["/v1/app/nav"]!.body), query = createQueryClient();
 const router = createMemoryRouter(appRoutes(nav.features), { initialEntries: [path] });
 const view = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(Announcer, { children: h(RouterProvider, { router }) }) }) }));
 return { ...f, router, close() { view.unmount();router.dispose();query.clear(); } };
}
it("the real Work route renders the rebuilt page: one table, the peek, spec answers and Open task", async () => {
 const f = mount("/app/live?task=" + ID.plan);
 try {
  // The rebuilt page, not the old grouped list: a search box, the one Work tasks table and the peek beside it.
  await screen.findByRole("searchbox", { name: "Search work" });
  expect(await screen.findByRole("table", { name: "Work tasks" })).toBeTruthy();
  expect(screen.queryByRole("region", { name: "Rovara is working" })).toBeNull();
  const peek = await screen.findByRole("region", { name: "Selected task" });
  const spec = await within(peek).findByRole("region", { name: "Spec" });
  const answer = await within(spec).findByRole("button", { name: "Yes, behind a flag" });
  fireEvent.click(answer);
  expect((await screen.findByTestId("answer-error")).textContent).toContain("Answer this question on the task's session page.");
  expect(within(peek).getByRole("link", { name: "Open task" }).getAttribute("href")).toBe("/app/sessions/" + ID.plan);
  expect(screen.getByRole("button", { name: "Approve plan v1" })).toBeTruthy();
 } finally { f.close(); }
});
it("the real Work route keeps lessons Keep, Edit, Drop and the batch send", async () => {
 const f = mount("/app/live?task=lessons%3Aweb", "work-lessons-batch");
 try {
  const batch = await screen.findByTestId("lesson-batch");
  expect(await within(batch).findByRole("radio", { name: /Keep/u })).toBeTruthy();
  fireEvent.click(within(batch).getByRole("radio", { name: /Edit/u }));
  expect(within(batch).getByRole("textbox", { name: "Title" })).toBeTruthy();
  fireEvent.click(within(batch).getByRole("radio", { name: /Drop/u }));
  fireEvent.change(within(batch).getByRole("combobox", { name: "Why drop it" }), { target: { value: "too_narrow" } });
  expect(within(batch).getByRole("button", { name: "Send decision" }).hasAttribute("disabled")).toBe(false);
 } finally { f.close(); }
});
it("the real Inbox route marks unread updates and refreshes the badge", async () => {
 const f = mount("/app/inbox", "inbox-updates-populated");
 try {
  const mark = await screen.findByRole("button", { name: "Mark all as read" });
  expect(screen.getByTestId("inbox-badge").textContent).toBe("1");
  fireEvent.click(mark);
  await waitFor(() => expect(screen.queryByRole("button", { name: "Mark all as read" })).toBeNull());
  await waitFor(() => expect(screen.getByTestId("inbox-badge").textContent).toBe(""));
  expect(f.request.mock.calls.filter(([request]) => request.method === "POST").map(([request]) => request.path)).toEqual(["/v1/app/inbox/read"]);
 } finally { f.close(); }
});
it.each([["work", "/app/live"], ["inbox", "/app/inbox"]])("the real %s route mounts the rebuilt page, and every nav link goes to the real route", async (name, route) => {
 const f = mount(route, name === "work" ? "work-all" : "inbox-updates-populated");
 try {
  if (name === "work") await screen.findByRole("searchbox", { name: "Search work" });
  else await screen.findByRole("region", { name: "Inbox attention" });
  expect(f.router.state.location.pathname).toBe(route);
  const nav = screen.getByRole("navigation", { name: "Workspace" });
  expect(nav.querySelectorAll('a[href^="/app/previews/"]')).toHaveLength(0);
  await waitFor(() => expect(nav.querySelector(`a[href="${route}"]`)).toBeTruthy());
  expect(document.querySelector(".rv-inbox-row")).toBeNull();
 } finally { f.close(); }
});
it.each([["work", "/app/live", "?task=lessons%3Aweb&filter=needs-someone#top"], ["inbox", "/app/inbox", "?tab=waiting"]])("the unlinked /app/previews/%s address redirects to %s and keeps its query and fragment", async (name, route, suffix) => {
 const f = mount("/app/previews/" + name + suffix);
 try {
  await waitFor(() => expect(f.router.state.location.pathname).toBe(route));
  expect(f.router.state.location.search + f.router.state.location.hash).toBe(suffix);
  if (name === "work") await screen.findByRole("searchbox", { name: "Search work" });
  else await screen.findByRole("region", { name: "Inbox attention" });
  expect(f.request.mock.calls.every(([request]) => request.method === "GET")).toBe(true);
 } finally { f.close(); }
});
