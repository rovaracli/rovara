// @vitest-environment jsdom
import { expect, it } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { SessionPeopleResponseReaderSchema } from "@agentx/contracts/web";
import { AppHostProvider } from "../../packages/ui/src/host.js";
import { SessionControls } from "../../packages/ui/src/screens/session/SessionControls.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { createSessionActions } from "../../packages/ui/src/api/session-actions.js";
import { fakeHost } from "./support/fake-host.js";
import { renderUi } from "./support/render.js";
import { h } from "./support/h.js";
import { SESSION_FIXTURE_ID } from "./support/session-fixture.js";

const shown = SessionPeopleResponseReaderSchema.parse({ people: { revision: 3, orphaned: true, canManage: false, canTakeOwnership: true, people: [{ personId: "22222222-2222-4222-8222-222222222222", name: "Ada", role: "owner", you: false, effectiveRole: "owner" }] } });
function setup() {
 let readStatus = 200;
 const f = fakeHost(async request => request.method === "GET"
  ? { status: readStatus, body: readStatus === 200 ? shown : { error: { code: "FORBIDDEN", message: "Access ended" } } }
  : { status: 409, body: { error: { code: "CONFLICT", message: "People changed. Review them again." } } });
 const query = createQueryClient();
 const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(SessionControls, { id: SESSION_FIXTURE_ID, agent: "Agent", actions: ["take_over"], following: false, onChanged: async () => undefined }) }) }));
 return { ...f, query, refuseRead: () => { readStatus = 403; }, close: () => { ui.unmount();query.clear(); } };
}
it("shows People before take-over and sends that revision unchanged when Code reports drift", async () => {
 const f = setup();
 fireEvent.click(screen.getByRole("button", { name: "Take over" }));
 const dialog = await screen.findByRole("dialog", { name: "Take over this task?" });
 await within(dialog).findByText("Ada · Owner");
 expect(f.request.mock.calls.filter(([r]) => r.method === "POST")).toHaveLength(0);
 fireEvent.click(within(dialog).getByRole("button", { name: "Take over" }));
 await within(dialog).findByText("People changed. Review them again.");
 const sent = f.request.mock.calls.map(([r]) => r);
 expect(sent.map(r => r.method)).toEqual(["GET", "POST"]);
 expect(sent[1]).toMatchObject({ path: `/v1/app/sessions/${SESSION_FIXTURE_ID}/take-over`, body: { expectedPeopleRevision: 3 } });
 expect((sent[1]!.body as { requestId: string }).requestId).toMatch(/^[0-9a-f-]{36}$/u);
 f.close();
});
it("drops take-over authority when a People refetch fails despite cached People", async () => {
 const f = setup();
 fireEvent.click(screen.getByRole("button", { name: "Take over" }));
 const dialog = await screen.findByRole("dialog", { name: "Take over this task?" });
 await within(dialog).findByText("Ada · Owner");
 f.refuseRead();
 await act(async () => { await f.query.invalidateQueries({ queryKey: ["session", SESSION_FIXTURE_ID, "people"] }); });
 await within(dialog).findByText("Access ended");
 const confirm = within(dialog).queryByRole<HTMLButtonElement>("button", { name: "Take over" });
 expect(confirm === null || confirm.disabled).toBe(true);
 if (confirm) fireEvent.click(confirm);
 await waitFor(() => expect(f.request.mock.calls.filter(([r]) => r.method === "POST")).toHaveLength(0));
 f.close();
});
it("the web API refuses an absent revision without sending a request", async () => {
 const f = fakeHost(async () => ({ status: 500, body: {} }));
 const api = createSessionActions(f.host);
 // A stale caller/runtime JavaScript cannot manufacture consent by leaving the revision out.
 await expect(async () => { await Reflect.apply(api.takeOver, api, [SESSION_FIXTURE_ID]); }).rejects.toThrow();
 expect(f.request).not.toHaveBeenCalled();
});
