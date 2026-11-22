// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { SessionMessageReaderSchema } from "@agentx/contracts/web";
import { AppHostProvider } from "../../packages/ui/src/host.js";
import { SessionScreen } from "../../packages/ui/src/screens/session/SessionScreen.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { sessionScope } from "../../packages/ui/src/api/session-safety.js";
import { workspaceFixture } from "./support/workspace-fixture.js";
import { meFixture } from "./support/fixtures.js";
import { messageFixture, SESSION_FIXTURE_ID } from "./support/session-fixture.js";
import { fakeHost } from "./support/fake-host.js";
import { renderUi } from "./support/render.js";
import { h } from "./support/h.js";

afterEach(cleanup);

it.each([200, 201])("R2: a confirmed draft stays Sent after its request lock clears and does not restore sent text (HTTP %s)", async status => {
 const session = workspaceFixture(), me = meFixture();
 const message = SessionMessageReaderSchema.parse(messageFixture({ text: "Retained unsent note" }));
 let sent = false;
 const f = fakeHost(async r => {
  if (r.path === "/v1/app/me") return { status: 200, body: me };
  if (r.path.endsWith("/presence")) return { status: 200, body: { viewingNow: [] } };
  if (r.path.endsWith("/messages")) {
   if (r.method === "POST") { sent = true;return { status, body: message }; }
   return { status: 200, body: { messages: sent ? [message] : [] } };
  }
  if (r.path.endsWith("/events")) return { status: 200, body: { events: [] } };
  if (r.path === "/v1/app/sessions/" + SESSION_FIXTURE_ID) return { status: 200, body: { session } };
  return { status: 404, body: { error: { code: "NOT_FOUND", message: "Not served" } } };
 });
 const draftKey = sessionScope({ companyId: me.org.orgId, personId: me.developer.id }, SESSION_FIXTURE_ID + ":talk:all") + ":draft";
 f.storage.set(draftKey, JSON.stringify({ comment: "Retained unsent note", steer: "" }));
 const query = createQueryClient(), router = createMemoryRouter([{ path: "/app/sessions/:id", element: h(SessionScreen, {}) }], { initialEntries: ["/app/sessions/" + SESSION_FIXTURE_ID] });
 const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(RouterProvider, { router }) }) }));
 try {
  fireEvent.click(await screen.findByRole("button", { name: "Talk to this session" }));
  const input = await screen.findByRole<HTMLTextAreaElement>("textbox", { name: "Comment" });
  const submit = screen.getByRole<HTMLButtonElement>("button", { name: "Send comment" });
  await waitFor(() => { expect(input.value).toBe("Retained unsent note");expect(submit.disabled).toBe(false); });
  fireEvent.click(submit);
  await waitFor(() => expect(f.request.mock.calls.filter(([r]) => r.method === "POST" && r.path.endsWith("/messages"))).toHaveLength(1));
  // Flush the restoration timer scheduled when the durable request is cleared.
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 60)); });
  expect(screen.getByLabelText("Draft status").textContent).toBe("Sent");
  expect(input.value).toBe("");
  expect(JSON.parse(f.storage.get(draftKey)!) as unknown).toEqual({ comment: "", steer: "" });
  expect(submit.disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Close dialog" }));
  fireEvent.click(screen.getByRole("button", { name: "Talk to this session" }));
  expect(screen.getByLabelText("Draft status").textContent).toBe("Sent");
  expect(screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Comment" }).value).toBe("");
 } finally { ui.unmount();router.dispose();query.clear(); }
});
