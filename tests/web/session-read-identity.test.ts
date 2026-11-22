// @vitest-environment jsdom
import { expect, it } from "vitest";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { AppHostProvider } from "../../packages/ui/src/host.js";
import { SessionScreen } from "../../packages/ui/src/screens/session/SessionScreen.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { meFixture } from "./support/fixtures.js";
import { sessionFixture, SESSION_FIXTURE_ID } from "./support/session-fixture.js";
import { fakeHost } from "./support/fake-host.js";
import { renderUi } from "./support/render.js";
import { h } from "./support/h.js";
it("R6g: a new identity never inherits another person's higher-revision session content", async () => {
 let changed = false;
 const first = sessionFixture({ title: "Earlier person's private context", revision: 9, updatedAt: "2026-10-23T13:00:00.000Z" });
 const next = sessionFixture({ title: "Current person's readable context", revision: 1 });
 const f = fakeHost(async r => {
  if (r.path === "/v1/app/me") { const me = meFixture();return { status: 200, body: changed ? { ...me, developer: { ...me.developer, id: "b".repeat(64) } } : me }; }
  if (r.path.endsWith("/presence")) return { status: 200, body: { viewingNow: [] } };
  if (r.path.endsWith("/messages")) return { status: 200, body: { messages: [] } };
  if (r.path.endsWith("/events")) return { status: 200, body: { events: [] } };
  if (r.path.endsWith("/log")) return { status: 200, body: { entries: [] } };
  if (r.path === "/v1/app/sessions/" + SESSION_FIXTURE_ID) return { status: 200, body: { session: changed ? next : first } };
  return { status: 404, body: { error: { code: "NOT_FOUND", message: "Not served" } } };
 });
 const query = createQueryClient(), router = createMemoryRouter([{ path: "/s/:id", element: h(SessionScreen, {}) }], { initialEntries: ["/s/" + SESSION_FIXTURE_ID] });
 const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(RouterProvider, { router }) }) }));
 try {
  await screen.findByRole("heading", { name: first.title });
  changed = true;
  await act(async () => { await query.invalidateQueries({ queryKey: ["session-identity"] }); });
  await screen.findByRole("heading", { name: next.title });
  expect(screen.queryByText(first.title)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Talk to this session" }));
  await waitFor(() => expect(screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Comment" }).disabled).toBe(false));
  expect(f.request.mock.calls.filter(([r]) => r.method === "POST" && r.path.endsWith("/messages"))).toHaveLength(0);
 } finally { ui.unmount();router.dispose();query.clear(); }
});
