// @vitest-environment jsdom
import { expect, it } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { AppHostProvider } from "../../packages/ui/src/host.js";
import { SessionControls } from "../../packages/ui/src/screens/session/SessionControls.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { fakeHost } from "./support/fake-host.js";
import { meFixture } from "./support/fixtures.js";
import { workspaceFixture } from "./support/workspace-fixture.js";
import { renderUi } from "./support/render.js";
import { h } from "./support/h.js";
import { pressWhenEnabled } from "./support/close-dialog.js";

for (const operation of ["stop", "close", "watch", "unwatch", "retry", "take_over"] as const) {
 const action = operation === "unwatch" ? "watch" : operation;
 for (const [status, code] of [[500, "CSRF_INVALID"], [500, "CSRF_STALE"], [403, "UNRECOGNISED"], [500, "UNRECOGNISED"]] as const) {
  it(`R3/R6a ${operation}: ${status}/${code} cannot unlock another confirmation or dispatch`, async () => {
   const base = workspaceFixture(), session = { ...base, you: { ...base.you, actions: [action], following: operation === "unwatch" } };
   const f = fakeHost(async r => r.path === "/v1/app/me" ? { status: 200, body: meFixture() } : r.path.endsWith("/people") ? { status: 200, body: { people: { revision: 3, orphaned: true, canManage: false, canTakeOwnership: true, people: [{ personId: "22222222-2222-4222-8222-222222222222", name: "Ada", role: "owner", you: false, effectiveRole: "owner" }] } } } : r.method === "GET" ? { status: 200, body: { session } } : { status, body: { error: { code, message: "Result unknown" } } });
   const query = createQueryClient();
   const tree = () => h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(SessionControls, { id: session.sessionId, agent: "Agent", actions: [action], following: operation === "unwatch", onChanged: async () => undefined }) }) });
   let ui = renderUi(tree());
   const label = action === "stop" ? "Stop" : action === "close" ? "Close task" : action === "watch" ? (operation === "unwatch" ? "Following" : "Follow") : action === "retry" ? "Retry" : "Take over";
   const trigger = await screen.findByRole<HTMLButtonElement>("button", { name: label });
   await waitFor(() => expect(trigger.disabled).toBe(false));fireEvent.click(trigger);
   if (action === "take_over") { const dialog = await screen.findByRole("dialog", { name: "Take over this task?" });await within(dialog).findByText("Ada · Owner");fireEvent.click(within(dialog).getByRole("button", { name: "Take over" })); }
   if (action === "stop" || action === "close") await pressWhenEnabled(async () => within(await screen.findByRole("dialog")).getByRole("button", { name: action === "stop" ? "Stop this task" : "Close and delete the machine" }));
   await waitFor(() => expect(f.request.mock.calls.filter(([r]) => r.method !== "GET")).toHaveLength(1));
   await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
   await waitFor(() => {
    const button = action === "stop" || action === "close" ? within(screen.getByRole("dialog")).getByRole<HTMLButtonElement>("button", { name: action === "stop" ? "Stop this task" : "Close and delete the machine" }) : screen.getByRole<HTMLButtonElement>("button", { name: label });
    expect(button.disabled).toBe(true);
    expect(screen.queryByText(/Nothing was sent\./)).toBeNull();
   });
   ui.unmount();ui = renderUi(tree());
   // A fresh unchanged read and remount cannot manufacture an answer.
   await waitFor(() => expect(screen.getByRole("button", { name: label })).toBeTruthy());
   const again = screen.getByRole<HTMLButtonElement>("button", { name: label });
   if (action === "close") { fireEvent.click(again);expect(within(await screen.findByRole("dialog")).getByRole<HTMLButtonElement>("button", { name: "Close and delete the machine" }).disabled).toBe(true); }
   else expect(again.disabled).toBe(true);
   fireEvent.click(screen.getByRole("button", { name: "Check" }));
   await waitFor(() => expect(f.request.mock.calls.filter(([r]) => r.method !== "GET")).toHaveLength(1));
   ui.unmount();query.clear();
  });
 }
}
