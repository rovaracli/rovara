// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { createElement as h } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { AppHostProvider, type ApiRequest, type ApiResponse } from "../../packages/ui/src/host.js";
import { CloseTaskDialog } from "../../packages/ui/src/screens/session/CloseTaskDialog.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { renderUi } from "./support/render.js";
import { fakeHost } from "./support/fake-host.js";
import { meFixture } from "./support/fixtures.js";
import { workspaceFixture } from "./support/workspace-fixture.js";
import { sessionFixture, SESSION_FIXTURE_ID } from "./support/session-fixture.js";
import { pressWhenEnabled } from "./support/close-dialog.js";
import { RETAINED_CLOSE_REFUSAL } from "./support/task-close-preview.js";

function setup(closeReply: ApiResponse) {
 const base = sessionFixture(), session = sessionFixture({ you: { ...base.you, actions: [...base.you.actions, "close"] } });
 const f = fakeHost(async (request: ApiRequest) => {
  if (request.path === "/v1/app/me") return { status: 200, body: meFixture() };
  if (request.method === "GET" && request.path === "/v1/app/sessions/" + SESSION_FIXTURE_ID) return { status: 200, body: { session } };
  if (request.method === "POST" && request.path.endsWith("/close")) return closeReply;
  return { status: 404, body: {} };
 });
 const query = createQueryClient(), onClosed = vi.fn();
 const tree = () => h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(CloseTaskDialog, { id: SESSION_FIXTURE_ID, open: true, onOpenChange: () => undefined, onClosed }) }) });
 const ui = renderUi(tree());
 return { ...f, ...ui, query, tree, onClosed, closeRequests: () => f.request.mock.calls.map(([request]) => request).filter(request => request.method === "POST" && request.path.endsWith("/close")) };
}

it("keeps a 503 close locked through remount and Check never sends another close", async () => {
 const f = setup({ status: 503, body: { error: { code: "UPSTREAM_FAILED", message: "try later" } } });
 await pressWhenEnabled(async () => await screen.findByRole("button", { name: "Close and delete the machine" }));
 await screen.findByText(/Closing this task was not confirmed/);
 expect(f.closeRequests()).toHaveLength(1);
 f.unmount();
 const next = renderUi(f.tree());
 await screen.findByText(/Closing is waiting for confirmation/);
 expect(screen.getByRole<HTMLButtonElement>("button", { name: "Close and delete the machine" }).disabled).toBe(true);
 fireEvent.click(screen.getByRole("button", { name: "Check" }));
 await waitFor(() => expect(f.request.mock.calls.some(([request]) => request.method === "GET" && request.path === "/v1/app/sessions/" + SESSION_FIXTURE_ID)).toBe(true));
 expect(f.closeRequests()).toHaveLength(1);
 next.unmount();f.query.clear();
});

it("does not dispatch a close when its identity-scoped request cannot be persisted", async () => {
 const f = setup({ status: 200, body: { session: sessionFixture(), closed: true } });
 f.host.storage.set = () => undefined;
 await pressWhenEnabled(async () => await screen.findByRole("button", { name: "Close and delete the machine" }));
 expect(await screen.findByText(/can't be made safely in this browser/)).toBeTruthy();
 expect(f.closeRequests()).toHaveLength(0);
 f.unmount();f.query.clear();
});

it("clears the frozen close only after a definitive closed response", async () => {
 const closed = sessionFixture({ status: "succeeded", revision: 2 });
 const f = setup({ status: 200, body: { session: closed, closed: true } });
 await pressWhenEnabled(async () => await screen.findByRole("button", { name: "Close and delete the machine" }));
 await waitFor(() => expect(f.onClosed).toHaveBeenCalledTimes(1));
 expect(f.closeRequests()).toHaveLength(1);
 f.unmount();f.query.clear();
});

it("keeps a 202 close frozen across remount, with only read-only Check", async () => {
 const f = setup({ status: 202, body: { status: "NEEDS_CONFIRMATION", changes: [] } });
 await waitFor(() => expect(screen.getByRole<HTMLButtonElement>("button", { name: "Close and delete the machine" }).disabled).toBe(false));
 fireEvent.click(screen.getByRole("button", { name: "Close and delete the machine" }));await screen.findByRole("button", { name: "Check" });
 const body = f.closeRequests()[0]!.body;f.unmount();const next = renderUi(f.tree());
 await screen.findByRole("button", { name: "Check" });expect(screen.getByRole<HTMLButtonElement>("button", { name: /Close task|Close and delete the machine/ }).disabled).toBe(true);
 fireEvent.click(screen.getByRole("button", { name: "Check" }));
 await waitFor(() => expect(f.request.mock.calls.filter(([r]) => r.method === "GET").length).toBeGreaterThan(2));
 expect(f.closeRequests()).toHaveLength(1);expect(f.closeRequests()[0]!.body).toEqual(body);next.unmount();f.query.clear();
});

it.each(["CSRF_INVALID", "CSRF_STALE", "UNRECOGNISED"])("R3/R6a: discard confirmation stays frozen after 500/%s", async code => {
 const base = sessionFixture(), session = workspaceFixture({ you: { ...base.you, actions: ["close"] } }, { unpublished: [{ repository: "demo", reasons: ["worktree_changes"] }] });
 let posts = 0;
 const f = fakeHost(async request => request.path === "/v1/app/me" ? { status: 200, body: meFixture() } : request.method === "GET" ? { status: 200, body: { session } } : ++posts === 1 ? { status: 200, body: { session, closed: false, unpublished: [{ repository: "demo", reasons: ["worktree_changes"] }] } } : { status: 500, body: { error: { code, message: "Unknown result" } } });
 const query = createQueryClient(), tree = () => h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(CloseTaskDialog, { id: SESSION_FIXTURE_ID, open: true, onOpenChange: () => undefined, onClosed: () => undefined }) }) });
 let ui = renderUi(tree());const first = await screen.findByRole<HTMLButtonElement>("button", { name: "Close and delete the machine" });await waitFor(() => expect(first.disabled).toBe(false));fireEvent.click(first);
 const discard = await screen.findByRole<HTMLButtonElement>("button", { name: "Discard it and close" });fireEvent.click(discard);
 await waitFor(() => expect(posts).toBe(2));await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
 expect(discard.disabled).toBe(true);
 expect(f.request.mock.calls.filter(([r]) => r.method === "POST")[1]![0].body).toMatchObject({ discardUnpublished: true });
 ui.unmount();ui = renderUi(tree());await screen.findByRole("button", { name: "Check" });expect(screen.getByRole<HTMLButtonElement>("button", { name: /Close task|Close and delete the machine/ }).disabled).toBe(true);
 fireEvent.click(screen.getByRole("button", { name: "Check" }));await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });expect(posts).toBe(2);ui.unmount();query.clear();
});

// DEC 254zzz347/367: the legacy press stays legacy (no preview digest) where no preview is served, and Code's retained-workspace refusal is shown
// (its /v1/dev link replaced by the Cloud preview control) and is final: nothing was closed, and the close poller never starts.
it("shows Code's retained-workspace refusal and stops the legacy close poller", async () => {
 const f = setup({ status: 409, body: RETAINED_CLOSE_REFUSAL });
 await pressWhenEnabled(() => screen.findByRole("button", { name: "Close and delete the machine" }));
 expect((await screen.findByRole("alert")).textContent).toBe("This workspace is retained. Review the Close preview before closing it.");
 expect(f.onClosed).not.toHaveBeenCalled();await act(async () => { await new Promise(resolve => setTimeout(resolve, 100)); });
 expect(f.closeRequests()).toHaveLength(1);
 expect(f.closeRequests()[0]!.body).not.toHaveProperty("expectedPreviewDigest");
 expect(screen.queryByText(/not confirmed|waiting for confirmation/)).toBeNull();f.unmount();f.query.clear();
});
