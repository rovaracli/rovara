// @vitest-environment jsdom
import { expect, it } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { AppHostProvider } from "../../packages/ui/src/host.js";
import { SessionScreen } from "../../packages/ui/src/screens/session/SessionScreen.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { fakeHost } from "./support/fake-host.js";
import { meFixture } from "./support/fixtures.js";
import { SESSION_FIXTURE_ID } from "./support/session-fixture.js";
import { workspaceFixture } from "./support/workspace-fixture.js";
import { renderUi } from "./support/render.js";
import { h } from "./support/h.js";

it("R3: an in-flight conversation draft becomes a frozen unknown after unmount and remount", async () => {
 let postStarted!: () => void;
 const started = new Promise<void>(resolve => { postStarted = resolve; });
 const f = fakeHost(async request => {
  if (request.path === "/v1/app/me") return { status: 200, body: meFixture() };
  if (request.path === "/v1/app/decisions") return { status: 404, body: { error: { code: "NOT_FOUND", message: "No decisions." } } };
  if (request.path.endsWith("/presence")) return { status: 200, body: { viewingNow: [] } };
  if (request.path.endsWith("/messages") && request.method === "POST") { postStarted();return new Promise(() => {}); }
  if (request.path.endsWith("/messages")) return { status: 200, body: { messages: [] } };
  if (request.path.endsWith("/events")) return { status: 200, body: { events: [] } };
  return { status: 200, body: { session: workspaceFixture() } };
 });
 const mount = () => {
  const router = createMemoryRouter([{ path: "/s/:id", element: h(SessionScreen, {}) }], { initialEntries: ["/s/" + SESSION_FIXTURE_ID] });
  const query = createQueryClient();
  const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(RouterProvider, { router }) }) }));
  return () => { ui.unmount();router.dispose();query.clear(); };
 };
 let close = mount();
 fireEvent.click(await screen.findByRole("button", { name: "Talk to this session" }));
 fireEvent.change(await screen.findByRole<HTMLTextAreaElement>("textbox", { name: "Comment" }), { target: { value: "Keep this note" } });
 fireEvent.click(screen.getByRole("button", { name: "Send comment" }));
 await screen.findByText("Sending");await started;close();
 close = mount();fireEvent.click(await screen.findByRole("button", { name: "Talk to this session" }));
 const draft = await screen.findByRole("region", { name: "Task draft" });
 expect(draft.textContent).toContain("Not confirmed");expect(draft.textContent).toContain("Keep this note");
 expect(screen.getByRole<HTMLButtonElement>("button", { name: "Send comment" }).disabled).toBe(true);
 expect(f.request.mock.calls.filter(([request]) => request.path.endsWith("/messages") && request.method === "POST")).toHaveLength(1);
 close();
});
