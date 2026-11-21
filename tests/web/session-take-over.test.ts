// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import type { ApiResponse } from "../../packages/ui/src/host.js";
import type { Button, ButtonProps } from "../../packages/ui/src/design/Button.js";
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

// Keep the real button/disabled behavior, and capture its current callback to exercise
// run() independently of the DOM's disabled gate (a queued/invoked callback).
const buttonBoundary = vi.hoisted(() => ({ takeOver: undefined as (() => void) | undefined }));
vi.mock("../../packages/ui/src/design/Button.js", async importOriginal => {
 const original = await importOriginal<{ Button: typeof Button }>();
 return { ...original, Button: (props: ButtonProps) => {
  const click = props.onClick;
  if (props.children === "Take over") buttonBoundary.takeOver = click === undefined ? undefined : () => { Reflect.apply(click, undefined, []); };
  return h(original.Button, props);
 } };
});

const shown = SessionPeopleResponseReaderSchema.parse({ people: { revision: 3, orphaned: true, canManage: false, canTakeOwnership: true, people: [{ personId: "22222222-2222-4222-8222-222222222222", name: "Ada", role: "owner", you: false, effectiveRole: "owner" }] } });
const refreshed = SessionPeopleResponseReaderSchema.parse({ people: { ...shown.people, revision: 4, people: [{ ...shown.people.people[0], name: "Grace" }] } });
function setup(read?: (count: number) => Promise<ApiResponse>) {
 let readStatus = 200, reads = 0;
 const f = fakeHost(async request => request.method === "GET"
  ? read ? read(++reads) : { status: readStatus, body: readStatus === 200 ? shown : { error: { code: "FORBIDDEN", message: "Access ended" } } }
  : { status: 409, body: { error: { code: "CONFLICT", message: "People changed. Review them again." } } });
 const query = createQueryClient();
 const view = (actions: readonly string[]) => h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(SessionControls, { id: SESSION_FIXTURE_ID, agent: "Agent", actions, following: false, onChanged: async () => undefined }) }) });
 const ui = renderUi(view(["take_over"]));
 return { ...f, query, setActions: (actions: readonly string[]) => ui.rerender(h("div", { "data-theme": "light" }, view(actions))), refuseRead: () => { readStatus = 403; }, close: () => { ui.unmount();query.clear(); } };
}
it("shows People before take-over and sends that revision unchanged when Code reports drift", async () => {
 let finishRead!: (value: ApiResponse) => void;
 const replacement = new Promise<ApiResponse>(resolve => { finishRead = resolve; });
 const f = setup(async count => count === 1 ? { status: 200, body: shown } : replacement);
 fireEvent.click(screen.getByRole("button", { name: "Take over" }));
 const dialog = await screen.findByRole("dialog", { name: "Take over this task?" });
 await within(dialog).findByText("Ada · Owner");
 expect(f.request.mock.calls.filter(([r]) => r.method === "POST")).toHaveLength(0);
 fireEvent.click(within(dialog).getByRole("button", { name: "Take over" }));
 await within(dialog).findByText("People changed. Review them again.");
 const sent = f.request.mock.calls.map(([r]) => r);
 await waitFor(() => expect(f.request.mock.calls.map(([r]) => r.method)).toEqual(["GET", "POST", "GET"]));
 expect(within(dialog).queryByText("Ada · Owner")).toBeNull();
 const confirm = within(dialog).getByRole<HTMLButtonElement>("button", { name: "Take over" });
 expect(confirm.disabled).toBe(true);
 fireEvent.click(confirm);
 expect(f.request.mock.calls.filter(([r]) => r.method === "POST")).toHaveLength(1);
 expect(sent[1]).toMatchObject({ path: `/v1/app/sessions/${SESSION_FIXTURE_ID}/take-over`, body: { expectedPeopleRevision: 3 } });
 expect((sent[1]!.body as { requestId: string }).requestId).toMatch(/^[0-9a-f-]{36}$/u);
 await act(async () => { finishRead({ status: 200, body: refreshed }); });
 await within(dialog).findByText("Grace · Owner");
 await waitFor(() => expect(confirm.disabled).toBe(false));
 expect(f.request.mock.calls.filter(([r]) => r.method === "POST")).toHaveLength(1);
 fireEvent.click(confirm);
 await waitFor(() => expect(f.request.mock.calls.filter(([r]) => r.method === "POST")).toHaveLength(2));
 expect(f.request.mock.calls.filter(([r]) => r.method === "POST").map(([r]) => (r.body as { expectedPeopleRevision: number }).expectedPeopleRevision)).toEqual([3, 4]);
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
it("hides cached People and disables take-over throughout a pending refetch", async () => {
 let finishRead!: (value: ApiResponse) => void;
 const replacement = new Promise<ApiResponse>(resolve => { finishRead = resolve; });
 const f = setup(async count => count === 1 ? { status: 200, body: shown } : replacement);
 fireEvent.click(screen.getByRole("button", { name: "Take over" }));
 const dialog = await screen.findByRole("dialog", { name: "Take over this task?" });
 await within(dialog).findByText("Ada · Owner");
 let reading!: Promise<void>;
 act(() => { reading = f.query.invalidateQueries({ queryKey: ["session", SESSION_FIXTURE_ID, "people"] }); });
 await within(dialog).findByText("Reading who is on this task…");
 expect(within(dialog).queryByText("Ada · Owner")).toBeNull();
 const confirm = within(dialog).getByRole<HTMLButtonElement>("button", { name: "Take over" });
 expect(confirm.disabled).toBe(true);
 fireEvent.click(confirm);
 expect(f.request.mock.calls.map(([r]) => r.method)).toEqual(["GET", "GET"]);
 await act(async () => { finishRead({ status: 200, body: refreshed });await reading; });
 await within(dialog).findByText("Grace · Owner");
 await waitFor(() => expect(confirm.disabled).toBe(false));
 f.close();
});
it("refuses the current take-over callback after its action is removed while the dialog is open", async () => {
 const f = setup();
 fireEvent.click(screen.getByRole("button", { name: "Take over" }));
 const dialog = await screen.findByRole("dialog", { name: "Take over this task?" });
 await within(dialog).findByText("Ada · Owner");
 f.setActions([]);
 expect(within(dialog).getByRole<HTMLButtonElement>("button", { name: "Take over" }).disabled).toBe(true);
 // Invoke the current callback past the independent disabled gate: run() must
 // re-check current actions, even when a caller reaches it without a DOM click.
 expect(buttonBoundary.takeOver).toBeTypeOf("function");
 await act(async () => { buttonBoundary.takeOver!(); });
 expect(f.request.mock.calls.map(([r]) => r.method)).toEqual(["GET"]);
 f.close();
});
it("the web API refuses an absent revision without sending a request", async () => {
 const f = fakeHost(async () => ({ status: 500, body: {} }));
 const api = createSessionActions(f.host);
 // A stale caller/runtime JavaScript cannot manufacture consent by leaving the revision out.
 await expect(async () => { await Reflect.apply(api.takeOver, api, [SESSION_FIXTURE_ID]); }).rejects.toThrow();
 expect(f.request).not.toHaveBeenCalled();
});
