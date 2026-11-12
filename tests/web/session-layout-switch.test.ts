// @vitest-environment jsdom
// Crossing 480px wide (a tablet turned, a window dragged) changes the layout of the task page, never its state (DEFERRED TASK-PAGE-REMOUNT-ACROSS-480PX): an open "What the agent loaded",
// the phone's "Work details and evidence", and answers typed but not yet sent all stay as the reader left them, both ways.
import { afterEach, expect, it, vi } from "vitest";
import { screen, waitFor, act, fireEvent } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { SessionScreen } from "../../packages/ui/src/screens/session/SessionScreen.js";
import { AppHostProvider } from "../../packages/ui/src/host.js";
import { Announcer } from "../../packages/ui/src/design/Announcer.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { renderUi } from "./support/render.js";
import { h } from "./support/h.js";
import { fakeHost } from "./support/fake-host.js";
import { workspaceFixture } from "./support/workspace-fixture.js";
import { understandSession } from "./support/understand-fixture.js";
import { SESSION_FIXTURE_ID, type sessionFixture } from "./support/session-fixture.js";

type Session = ReturnType<typeof sessionFixture>;
afterEach(() => { vi.unstubAllGlobals(); });
/** A window whose width the test sets: `matchMedia("(max-width: 480px)")` answers for it and tells its listeners when the answer changes. */
function windowOfWidth(start: number) {
 let width = start;const listeners = new Set<() => void>();
 vi.stubGlobal("matchMedia", (query: string) => ({ get matches() { return width <= 480; }, media: query, addEventListener: (_: string, listener: () => void) => listeners.add(listener), removeEventListener: (_: string, listener: () => void) => listeners.delete(listener) }));
 return async (next: number) => { width = next;await act(async () => { for (const listener of [...listeners]) listener(); }); };
}
function setup(session: Session) {
 const f = fakeHost(async request => {
  const path = request.path.split("?", 1)[0]!;
  if (path === "/v1/app/decisions") return { status: 404, body: { error: { code: "NOT_FOUND", message: "route not found" } } };
  if (path.endsWith("/messages")) return { status: 200, body: { messages: [] } };
  if (path.endsWith("/events")) return { status: 200, body: { events: [] } };
  if (path.endsWith("/presence")) return { status: 200, body: { viewingNow: session.viewingNow } };
  if (path.endsWith("/loaded-knowledge")) return { status: 200, body: { stages: [], requestId: "r" } };
  return { status: 200, body: { session } };
 });
 const query = createQueryClient(), router = createMemoryRouter([{ path: "/app/sessions/:id", element: h(SessionScreen, {}) }], { initialEntries: ["/app/sessions/" + SESSION_FIXTURE_ID] });
 const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(Announcer, { children: h(RouterProvider, { router }) }) }) }));
 return { ...ui, close() { ui.unmount();router.dispose();query.clear(); } };
}
const loaded = (root: HTMLElement) => root.querySelector<HTMLDetailsElement>("details.rv-loaded-knowledge")!;
const evidence = (root: HTMLElement) => root.querySelector<HTMLDetailsElement>("details.rv-session-evidence");
const open = (details: HTMLDetailsElement) => { details.open = true;details.dispatchEvent(new Event("toggle")); };

it("an open 'What the agent loaded' stays open, and the same element, across the phone width and back", async () => {
 const resize = windowOfWidth(1280);
 const f = setup(workspaceFixture());
 await screen.findByRole("region", { name: "Where this task stands" });
 const node = loaded(f.container);
 open(node);
 await waitFor(() => expect(node.children.length).toBeGreaterThan(1));
 await resize(390);
 expect(f.container.querySelector("section.rv-session")!.getAttribute("data-lead")).toBe("phone");
 expect(loaded(f.container)).toBe(node);expect(loaded(f.container).open).toBe(true);
 expect(evidence(f.container)!.contains(node)).toBe(true);
 await resize(1280);
 expect(f.container.querySelector("section.rv-session")!.getAttribute("data-lead")).toBe("wide");
 expect(evidence(f.container)).toBeNull();
 expect(loaded(f.container)).toBe(node);expect(loaded(f.container).open).toBe(true);
 f.close();
});
it("the phone's 'Work details and evidence', opened by hand, is still open after a trip to the wide layout", async () => {
 const resize = windowOfWidth(390);
 const f = setup(workspaceFixture());
 await screen.findByRole("region", { name: "Where this task stands" });
 expect(evidence(f.container)!.open).toBe(false);
 open(evidence(f.container)!);
 const node = loaded(f.container);open(node);
 await resize(1024);
 await resize(390);
 expect(evidence(f.container)!.open).toBe(true);
 expect(loaded(f.container)).toBe(node);expect(loaded(f.container).open).toBe(true);
 f.close();
});
it("answers typed into Understand's questions survive the phone width and back", async () => {
 const resize = windowOfWidth(1280);
 const f = setup(understandSession());
 const box = await screen.findByRole("textbox", { name: /Should old refunds be migrated\?/u });
 fireEvent.click(screen.getByRole("radio", { name: /The payments table/u }));
 fireEvent.change(box, { target: { value: "Yes, the last year" } });
 for (const width of [390, 1280, 390]) {
  await resize(width);
  await waitFor(() => expect(screen.getByRole("textbox", { name: /Should old refunds be migrated\?/u })).toHaveProperty("value", "Yes, the last year"));
  expect(screen.getByRole("radio", { name: /The payments table/u })).toHaveProperty("checked", true);
 }
 expect(screen.getByRole("textbox", { name: /Should old refunds be migrated\?/u })).toBe(box);
 f.close();
});
it("a conversation typed into the open tray is kept across the switch", async () => {
 const resize = windowOfWidth(1280);
 const f = setup(workspaceFixture({ you: { level: "edit", owner: true, following: false, actions: ["watch", "comment"] } } as never));
 await screen.findByRole("region", { name: "Where this task stands" });
 fireEvent.click(screen.getByRole("button", { name: "Conversation" }));
 const field = await screen.findByRole("textbox");
 fireEvent.change(field, { target: { value: "half a thought" } });
 await resize(390);
 await waitFor(() => expect(screen.getByRole("textbox")).toHaveProperty("value", "half a thought"));
 f.close();
});
