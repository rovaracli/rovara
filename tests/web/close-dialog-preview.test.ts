// @vitest-environment jsdom
// DEC 254zzz367 / CLOUD-CLOSE-DIALOG: the Close dialog reads Code's Close preview, then sends the BOUND close through the guarded shared handler.
import { afterEach, expect, it, vi } from "vitest";
import { createElement as h } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { AppHostProvider, type ApiRequest, type ApiResponse } from "../../packages/ui/src/host.js";
import { CloseTaskDialog } from "../../packages/ui/src/screens/session/CloseTaskDialog.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { renderUi } from "./support/render.js";
import { fakeHost, CLOSE_PREVIEW_NOT_SERVED } from "./support/fake-host.js";
import { meFixture } from "./support/fixtures.js";
import { sessionFixture, SESSION_FIXTURE_ID } from "./support/session-fixture.js";
import { workspaceFixture } from "./support/workspace-fixture.js";
import { CLOSE_DIGEST, closePreview, RETAINED_CLOSE_REFUSAL } from "./support/task-close-preview.js";
import { pressWhenEnabled } from "./support/close-dialog.js";
import { NOT_CHECKED_WORDS, CORE_NOT_YET_WORDS, previewNotServed } from "../../packages/ui/src/screens/session/close-preview.js";
import { ApiError } from "../../packages/ui/src/api/errors.js";
import { CORE_NOT_YET } from "../../packages/cloud-server/src/core-task-actions.js";

const SESSION_PATH = "/v1/app/sessions/" + SESSION_FIXTURE_ID;
const CLEAN_DIGEST = "c".repeat(64), DISCARD_DIGEST = "d".repeat(64), NEXT_DIGEST = "e".repeat(64);
const clean = (digest = CLEAN_DIGEST) => { const value = closePreview("close");value.preview.digest = digest;value.preview.unpublished = [];return value; };
const findings = () => closePreview("close");
const discard = (digest = DISCARD_DIGEST) => { const value = closePreview("discard");value.preview.digest = digest;return value; };
const ok = (body: unknown): ApiResponse => ({ status: 200, body });
const fail = (status: number, code: string, message = "x"): ApiResponse => ({ status, body: { error: { code, message } } });
const STALE = fail(409, "CHANGE_STALE", "the close preview has changed; review it again");
const WARNING = "Closing deletes this task's machine. Changes that aren't pushed to GitHub or in a pull request are lost and can't be recovered.";
const DELETE = "Close and delete the machine";
const base = sessionFixture();
const withClose = (extra: Record<string, unknown> = {}) => sessionFixture({ you: { ...base.you, actions: [...base.you.actions, "close"] }, ...extra });

interface Options {
 preview?: (action: "close" | "discard", call: number) => ApiResponse | Promise<ApiResponse>;
 close?: (call: number, request: ApiRequest) => ApiResponse | Promise<ApiResponse>;
 session?: () => ApiResponse;
 me?: (call: number) => ApiResponse;
 canClose?: boolean;
 onClosed?: () => Promise<unknown> | void;
}
function setup(options: Options = {}) {
 const counts = { close: 0, discard: 0, me: 0, closePosts: 0 };
 const f = fakeHost(async (request: ApiRequest) => {
  if (request.path === "/v1/app/me") return options.me?.(++counts.me) ?? ok(meFixture());
  if (request.method === "GET" && request.path === SESSION_PATH + "/close?action=close") return options.preview?.("close", ++counts.close) ?? ok(clean());
  if (request.method === "GET" && request.path === SESSION_PATH + "/close?action=discard") return options.preview?.("discard", ++counts.discard) ?? ok(discard());
  if (request.method === "GET" && request.path === SESSION_PATH) return options.session?.() ?? ok({ session: withClose() });
  if (request.method === "POST" && request.path === SESSION_PATH + "/close") return options.close?.(++counts.closePosts, request) ?? ok({ session: withClose({ status: "succeeded" }), closed: true });
  return fail(404, "NOT_FOUND");
 });
 const query = createQueryClient(), onClosed = vi.fn(options.onClosed ?? (() => undefined));
 const tree = () => h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(CloseTaskDialog, { id: SESSION_FIXTURE_ID, open: true, onOpenChange: () => undefined, onClosed, canClose: options.canClose ?? true }) }) });
 const ui = renderUi(tree());
 const calls = () => f.request.mock.calls.map(([request]) => request);
 return {
  ...f, ui, query, tree, onClosed, counts,
  posts: () => calls().filter(request => request.method === "POST"),
  previews: () => calls().filter(request => request.method === "GET" && request.path.includes("/close?action=")),
  stop() { this.ui.unmount();query.clear(); },
 };
}
const button = (name: string) => screen.findByRole<HTMLButtonElement>("button", { name });
const settle = async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 40)); }); };
afterEach(() => { vi.useRealTimers(); });

it("sends NOTHING while the preview is read: the Close button stays disabled and a press makes zero sends", async () => {
 let release!: (answer: ApiResponse) => void;
 const s = setup({ preview: () => new Promise(resolve => { release = resolve; }) });
 const press = await button("Close and delete the machine");
 expect(press.disabled).toBe(true);fireEvent.click(press);await settle();
 expect(s.posts()).toHaveLength(0);
 expect(await screen.findByText(/Reading what closing will keep and discard/)).toBeTruthy();
 await act(async () => { release(ok(clean())); });
 await waitFor(() => expect(press.disabled).toBe(false));
 expect(s.posts()).toHaveLength(0);s.stop();
});

it("a clean preview shows what stays, is freed and is discarded, and a press sends the bound close with exactly the digest shown and no discard flag", async () => {
 const s = setup();
 const group = await screen.findByRole("region", { name: "Close preview" });
 expect(within(group).getByText("Stays")).toBeTruthy();expect(within(group).getByText("Freed")).toBeTruthy();expect(within(group).getByText("Discarded")).toBeTruthy();
 expect(within(group).getByText(/Nothing\. No unpublished work was found/)).toBeTruthy();
 expect(screen.queryByRole("list", { name: "Unpublished work" })).toBeNull();
 await pressWhenEnabled(() => button("Close and delete the machine"));
 await waitFor(() => expect(s.onClosed).toHaveBeenCalledTimes(1));
 expect(s.posts()).toHaveLength(1);
 expect(s.posts()[0]!.body).toEqual({ requestId: expect.stringMatching(/^[0-9a-f-]{36}$/u) as string, expectedPreviewDigest: CLEAN_DIGEST });
 expect(Object.keys(s.posts()[0]!.body as object).sort()).toEqual(["expectedPreviewDigest", "requestId"]);
 s.stop();
});

it("unpublished work: the DISCARD preview's list and digest are shown and bound, with discard_unpublished true; the close preview's digest is never sent", async () => {
 const s = setup({ preview: action => ok(action === "close" ? findings() : discard()) });
 const list = await screen.findByRole("list", { name: "Unpublished work" });
 expect(list.textContent).toContain("demo");expect(list.textContent).toContain("changes not yet committed");expect(list.textContent).toContain("a branch not yet pushed");
 expect(screen.queryByRole("button", { name: "Close and delete the machine" })).toBeNull();
 expect(screen.getByRole("dialog", { name: "Discard unpublished work?" })).toBeTruthy();
 expect(s.previews().map(request => request.path.split("=")[1])).toEqual(["close", "discard"]);
 await pressWhenEnabled(() => button("Discard it and close"));
 await waitFor(() => expect(s.onClosed).toHaveBeenCalledTimes(1));
 expect(s.posts()).toHaveLength(1);
 expect(s.posts()[0]!.body).toEqual({ requestId: expect.any(String) as string, expectedPreviewDigest: DISCARD_DIGEST, discard_unpublished: true });
 expect(JSON.stringify(s.posts()[0]!.body)).not.toContain(CLOSE_DIGEST);s.stop();
});

it("the safe choice is first and filled, the destructive one second and red-outlined", async () => {
 const s = setup();await button("Close and delete the machine");
 const row = screen.getByRole("button", { name: "Cancel" }).closest(".rv-actions")!;
 const names = [...row.querySelectorAll("button")].map(node => node.textContent);
 expect(names).toEqual(["Cancel", "Close and delete the machine"]);
 expect(screen.getByRole("button", { name: "Cancel" }).className).toContain("rv-button-primary");
 expect(screen.getByRole("button", { name: "Close and delete the machine" }).className).toContain("rv-button-danger");s.stop();
});

it("a STALE digest is refused: nothing is closed, the refusal is final (unlocked), and the preview is read again before any new press", async () => {
 let reads = 0;
 const s = setup({ preview: () => ok(clean(++reads === 1 ? CLEAN_DIGEST : NEXT_DIGEST)), close: () => STALE });
 await pressWhenEnabled(() => button("Close and delete the machine"));
 expect((await screen.findByText(/the close preview has changed; review it again/)).textContent).toBeTruthy();
 await waitFor(() => expect(s.previews()).toHaveLength(2));
 expect(s.onClosed).not.toHaveBeenCalled();
 expect(screen.queryByRole("status", { name: "" })?.textContent ?? "").not.toMatch(/Closing/);
 await waitFor(() => expect(screen.getByRole<HTMLButtonElement>("button", { name: "Close and delete the machine" }).disabled).toBe(false));
 fireEvent.click(screen.getByRole("button", { name: "Close and delete the machine" }));
 await waitFor(() => expect(s.posts()).toHaveLength(2));
 expect(s.posts()[1]!.body).toMatchObject({ expectedPreviewDigest: NEXT_DIGEST });
 expect((s.posts()[1]!.body as { requestId: string }).requestId).not.toBe((s.posts()[0]!.body as { requestId: string }).requestId);s.stop();
});

it("a 503 on the bound close stays UNKNOWN: locked through remount, Check never sends again, and the DEC 285 exit appears after three unconfirmed Checks", async () => {
 const s = setup({ close: () => fail(503, "RUNTIME_UNAVAILABLE", "try later"), session: () => ok({ session: withClose() }) });
 await pressWhenEnabled(() => button("Close and delete the machine"));
 await screen.findByText(/Closing this task was not confirmed/);
 expect(s.posts()).toHaveLength(1);
 s.ui.unmount();const next = renderUi(s.tree());
 await screen.findByText(/Closing is waiting for confirmation/);
 expect(screen.getByRole<HTMLButtonElement>("button", { name: "Close and delete the machine" }).disabled).toBe(true);
 for (let i = 0; i < 3; i += 1) { fireEvent.click(screen.getByRole("button", { name: "Check" }));await settle(); }
 expect(await screen.findByRole("link", { name: "Open the task to check" })).toBeTruthy();
 expect(s.posts()).toHaveLength(1);next.unmount();s.query.clear();
});

it("an accepted-but-not-closed answer shows the CLOSING wording and stays locked: no second send, no onClosed", async () => {
 const s = setup({ close: () => ok({ session: withClose(), closed: false }) });
 await pressWhenEnabled(() => button("Close and delete the machine"));
 expect(await screen.findByText(/Closing this task\. Rovara accepted the close/)).toBeTruthy();
 expect(screen.getByRole<HTMLButtonElement>("button", { name: "Close and delete the machine" }).disabled).toBe(true);
 fireEvent.click(await screen.findByRole("button", { name: "Check" }));await settle();
 expect(s.onClosed).not.toHaveBeenCalled();expect(s.posts()).toHaveLength(1);
 s.stop();
});

it("an accepted bound close tells the page (onChecking) so it reads the served closing state", async () => {
 const onChecking = vi.fn();
 const s = setup({ close: () => ok({ session: withClose({ title: "Served after the close was accepted" }), closed: false }) });
 s.ui.unmount();
 const f2 = renderUi(h(AppHostProvider, { host: s.host, children: h(QueryClientProvider, { client: s.query, children: h(CloseTaskDialog, { id: SESSION_FIXTURE_ID, open: true, onOpenChange: () => undefined, onClosed: () => undefined, onChecking }) }) }));
 await pressWhenEnabled(() => button("Close and delete the machine"));
 await waitFor(() => expect(onChecking).toHaveBeenCalledTimes(1));
 expect((s.query.getQueryData(["session", SESSION_FIXTURE_ID]) as { title: string }).title).toBe("Served after the close was accepted");
 expect(s.posts()).toHaveLength(1);f2.unmount();s.query.clear();
});

it("a 202 answer is not a close: it stays locked and unconfirmed", async () => {
 const s = setup({ close: () => ({ status: 202, body: { status: "NEEDS_CONFIRMATION", changes: [] } }) });
 await pressWhenEnabled(() => button("Close and delete the machine"));
 await screen.findByRole("button", { name: "Check" });
 expect(s.onClosed).not.toHaveBeenCalled();expect(s.posts()).toHaveLength(1);
 expect(screen.getByRole<HTMLButtonElement>("button", { name: "Close and delete the machine" }).disabled).toBe(true);s.stop();
});

it("legacy fallback ONLY on the served 'route not on this Code' answer: an unbound close with no digest", async () => {
 const s = setup({ preview: () => CLOSE_PREVIEW_NOT_SERVED });
 await pressWhenEnabled(() => button("Close and delete the machine"));
 await waitFor(() => expect(s.onClosed).toHaveBeenCalledTimes(1));
 expect(s.posts()).toHaveLength(1);
 expect(s.posts()[0]!.body).toEqual({ requestId: expect.any(String) as string });
 expect(s.posts()[0]!.body).not.toHaveProperty("expectedPreviewDigest");s.stop();
});

it("legacy fallback also on the preview's own 'unsupported' answer", async () => {
 const s = setup({ preview: () => ok({ preview: null, unavailable: "unsupported" }) });
 await pressWhenEnabled(() => button("Close and delete the machine"));
 await waitFor(() => expect(s.posts()).toHaveLength(1));
 expect(s.posts()[0]!.body).not.toHaveProperty("expectedPreviewDigest");s.stop();
});

it.each([
 ["503", fail(503, "RUNTIME_UNAVAILABLE", "down")], ["a bare 500", fail(500, "INTERNAL", "boom")], ["a 404 NOT_FOUND from the task (not the route)", fail(404, "TASK_NOT_FOUND", "no such task")],
 ["an unreadable 200 (malformed preview)", ok({ preview: { nonsense: true } })], ["a 501 with another code", fail(501, "SOMETHING_ELSE", "nope")],
])("NEVER guesses the fallback: %s sends zero closes", async (_name, answer) => {
 const s = setup({ preview: () => answer });
 await settle();await settle();
 expect(screen.queryByRole("button", { name: "Close and delete the machine" })?.hasAttribute("disabled") ?? true).toBe(true);
 expect(s.posts()).toHaveLength(0);s.stop();
});

it("a preview whose action is not the one asked for is never bound", async () => {
 const wrong = closePreview("discard");
 const s = setup({ preview: () => ok(wrong) });
 expect(await screen.findByText(/Couldn't read the Close preview\. Nothing was closed\./)).toBeTruthy();
 expect(screen.queryByRole("button", { name: /Close and delete the machine|Discard it and close/ })).toBeNull();expect(s.posts()).toHaveLength(0);s.stop();
});

it("a discard preview that is not a discard preview is never bound", async () => {
 const s = setup({ preview: action => ok(action === "close" ? findings() : closePreview("close")) });
 expect(await screen.findByText(/Couldn't read the Close preview/)).toBeTruthy();
 expect(screen.queryByRole("button", { name: "Discard it and close" })).toBeNull();expect(s.posts()).toHaveLength(0);s.stop();
});

it("findings whose discard preview is not available offer NO destructive button and make zero sends", async () => {
 const s = setup({ preview: action => action === "close" ? ok(findings()) : ok({ preview: null, unavailable: "inspection_required" }) });
 expect(await screen.findByText(/can't show the full list to discard yet/)).toBeTruthy();
 expect(screen.queryByRole("button", { name: /Close and delete the machine|Discard it and close/ })).toBeNull();
 fireEvent.click(await button("Check again"));await settle();expect(s.posts()).toHaveLength(0);s.stop();
});

it("a discard preview that now shows NO unpublished work asks for a fresh review instead of binding it", async () => {
 const s = setup({ preview: action => ok(action === "close" ? findings() : (() => { const v = discard();v.preview.unpublished = [];return v; })()) });
 expect(await screen.findByText(/This task changed while you were reviewing it/)).toBeTruthy();
 expect(screen.queryByRole("button", { name: /Close and delete the machine|Discard it and close/ })).toBeNull();s.stop();
});

it("'busy' has no destructive button", async () => {
 const s = setup({ preview: () => ok({ preview: null, unavailable: "busy" }) });
 expect(await screen.findByText(/no preview yet/)).toBeTruthy();
 expect(screen.queryByRole("button", { name: /Close and delete the machine|Discard it and close/ })).toBeNull();expect(s.posts()).toHaveLength(0);s.stop();
});

it("'inspection_required': only the legacy first ask is offered; found work leads to the preview, never to a legacy discard", async () => {
 let inspected = false;
 const s = setup({
  preview: action => !inspected ? ok({ preview: null, unavailable: "inspection_required" }) : ok(action === "close" ? findings() : discard()),
  close: () => { inspected = true;return ok({ session: withClose(), closed: false, unpublished: [{ repository: "demo", reasons: ["worktree_changes"] }] }); },
 });
 expect(await screen.findByText(NOT_CHECKED_WORDS)).toBeTruthy();
 await pressWhenEnabled(() => button("Close and delete the machine"));
 await waitFor(() => expect(s.posts()).toHaveLength(1));
 expect(s.posts()[0]!.body).toEqual({ requestId: expect.any(String) as string });
 expect(await screen.findByText(/Rovara found unpublished work in this workspace/)).toBeTruthy();
 await pressWhenEnabled(() => button("Discard it and close"));
 await waitFor(() => expect(s.posts()).toHaveLength(2));
 expect(s.posts()[1]!.body).toEqual({ requestId: expect.any(String) as string, expectedPreviewDigest: DISCARD_DIGEST, discard_unpublished: true });
 expect(s.posts()[1]!.body).not.toHaveProperty("discardUnpublished");s.stop();
});

it("a legacy discard (unbound discardUnpublished) is NEVER sent when a preview is served", async () => {
 const s = setup({ preview: () => ok({ preview: null, unavailable: "inspection_required" }), close: () => ok({ session: withClose(), closed: false, unpublished: [{ repository: "demo", reasons: ["worktree_changes"] }] }) });
 await pressWhenEnabled(() => button("Close and delete the machine"));
 await screen.findByText(/Rovara found unpublished work in this workspace/);
 expect(screen.queryByRole("list", { name: "Unpublished work" })).toBeNull();
 expect(screen.queryByRole("button", { name: "Discard it and close" })).toBeNull();
 await settle();expect(s.posts()).toHaveLength(1);s.stop();
});

it("DEC 254zzz347: Code's retained-workspace refusal shows its words with the Cloud preview control, is FINAL (nothing closed, unlocked) and never shows the /v1/dev link", async () => {
 const s = setup({ preview: () => CLOSE_PREVIEW_NOT_SERVED, close: () => ({ status: 409, body: RETAINED_CLOSE_REFUSAL }) });
 await pressWhenEnabled(() => button("Close and delete the machine"));
 const alert = await screen.findByRole("alert");
 expect(alert.textContent).toBe("This workspace is retained. Review the Close preview before closing it.");
 expect(document.body.textContent).not.toContain("/v1/dev");
 expect(s.onClosed).not.toHaveBeenCalled();
 await waitFor(() => expect(screen.getByRole<HTMLButtonElement>("button", { name: "Close and delete the machine" }).disabled).toBe(false));
 await settle();expect(s.posts()).toHaveLength(1);
 expect(screen.queryByText(/not confirmed|waiting for confirmation/)).toBeNull();
 const before = s.previews().length;
 fireEvent.click(within(alert).getByRole("button", { name: "Review the Close preview" }));
 await waitFor(() => expect(s.previews().length).toBeGreaterThan(before));
 expect(s.previews().at(-1)!.path).toBe(SESSION_PATH + "/close?action=close");s.stop();
});

it("the retained refusal's link opens the Cloud preview, and a served preview then replaces the legacy ask", async () => {
 let served = false;
 const s = setup({ preview: () => served ? ok(clean()) : ok({ preview: null, unavailable: "inspection_required" }), close: () => { served = true;return { status: 409, body: RETAINED_CLOSE_REFUSAL }; } });
 await pressWhenEnabled(() => button("Close and delete the machine"));
 fireEvent.click(await screen.findByRole("button", { name: "Review the Close preview" }));
 expect(await screen.findByRole("region", { name: "Close preview" })).toBeTruthy();
 await pressWhenEnabled(() => button("Close and delete the machine"));
 await waitFor(() => expect(s.posts()).toHaveLength(2));
 expect(s.posts()[1]!.body).toMatchObject({ expectedPreviewDigest: CLEAN_DIGEST });s.stop();
});

it.each([
 ["another WORKSPACE_BUSY sentence", 409, "WORKSPACE_BUSY", "Rovara could not close the task just now; try again"],
 ["a different code with the retained sentence", 409, "RUNTIME_UNAVAILABLE", RETAINED_CLOSE_REFUSAL.error.message],
 ["another status with the retained sentence", 400, "WORKSPACE_BUSY", RETAINED_CLOSE_REFUSAL.error.message],
 ["a retained sentence with another tail", 409, "WORKSPACE_BUSY", RETAINED_CLOSE_REFUSAL.error.message + " Also deleted."],
 ["a non-uuid task link", 409, "WORKSPACE_BUSY", "This workspace is retained. Review the Close preview at /v1/dev/tasks/abc/close before closing it."],
])("only the EXACT retained refusal is final: %s stays unknown and locked", async (_name, status, code, message) => {
 const s = setup({ preview: () => CLOSE_PREVIEW_NOT_SERVED, close: () => fail(status, code, message) });
 await pressWhenEnabled(() => button("Close and delete the machine"));
 await screen.findByText(/Closing this task was not confirmed/);
 expect(screen.queryByRole("button", { name: "Review the Close preview" })).toBeNull();
 expect(screen.getByRole<HTMLButtonElement>("button", { name: "Close and delete the machine" }).disabled).toBe(true);
 expect(s.posts()).toHaveLength(1);s.stop();
});

it("no permission: a task that no longer offers close makes ZERO sends", async () => {
 const s = setup({ session: () => ok({ session: sessionFixture() }) });
 await pressWhenEnabled(() => button("Close and delete the machine"));
 expect(await screen.findByText(/Close task is no longer available/)).toBeTruthy();
 expect(s.posts()).toHaveLength(0);s.stop();
});

it("cross-company: an identity that changed between the preview and the press makes ZERO sends", async () => {
 const other = meFixture({ org: { ...meFixture().org, orgId: "o-bbbbbbbbbbbbbbbbbbbb" } });
 const s = setup({ me: call => ok(call === 1 ? meFixture() : other) });
 await pressWhenEnabled(() => button("Close and delete the machine"));
 expect(await screen.findByText(/Identity changed/)).toBeTruthy();
 expect(s.posts()).toHaveLength(0);s.stop();
});

it("a task the person cannot close (canClose false) reads no preview and sends nothing", async () => {
 const s = setup({ canClose: false });
 await settle();
 expect(s.previews()).toHaveLength(0);
 expect(screen.getByRole<HTMLButtonElement>("button", { name: "Close and delete the machine" }).disabled).toBe(true);
 fireEvent.click(screen.getByRole("button", { name: "Close and delete the machine" }));await settle();
 expect(s.posts()).toHaveLength(0);s.stop();
});

it.each([[401], [403], [404]])("access signal %s on the preview read shows no facts and no destructive button", async status => {
 const s = setup({ preview: () => fail(status, status === 404 ? "SESSION_NOT_FOUND" : status === 403 ? "FORBIDDEN" : "AUTH_REQUIRED") });
 expect(await screen.findByText("This task isn't available to you.")).toBeTruthy();
 expect(screen.queryByRole("region", { name: "Close preview" })).toBeNull();
 expect(screen.queryByRole("button", { name: /Close and delete the machine|Discard it and close/ })).toBeNull();expect(s.posts()).toHaveLength(0);s.stop();
});

it("an access signal on a RE-read wipes the kept preview and its buttons", async () => {
 let reads = 0;
 const s = setup({ preview: () => ++reads === 1 ? ok(clean()) : fail(403, "FORBIDDEN") });
 await screen.findByRole("region", { name: "Close preview" });
 act(() => { void s.query.refetchQueries({ queryKey: ["close-preview"] }); });
 expect(await screen.findByText("This task isn't available to you.")).toBeTruthy();
 expect(screen.queryByRole("region", { name: "Close preview" })).toBeNull();
 expect(screen.queryByRole("button", { name: "Close and delete the machine" })).toBeNull();expect(s.posts()).toHaveLength(0);s.stop();
});

it("a transient (503) failed RE-read KEEPS the facts with ONE 'Updated · Reconnecting' line and disables the destructive button", async () => {
 let reads = 0;
 const s = setup({ preview: () => ++reads === 1 ? ok(clean()) : fail(503, "RUNTIME_UNAVAILABLE", "down") });
 await screen.findByRole("region", { name: "Close preview" });await waitFor(() => expect(screen.getByRole<HTMLButtonElement>("button", { name: "Close and delete the machine" }).disabled).toBe(false));
 act(() => { void s.query.refetchQueries({ queryKey: ["close-preview"] }); });
 const line = await screen.findByText(/Updated \d\d:\d\d · Reconnecting/);
 expect(screen.getAllByText(/Reconnecting/)).toHaveLength(1);expect(line).toBeTruthy();
 expect(screen.getByRole("region", { name: "Close preview" })).toBeTruthy();
 expect(screen.getByRole<HTMLButtonElement>("button", { name: "Close and delete the machine" }).disabled).toBe(true);
 fireEvent.click(screen.getByRole("button", { name: "Close and delete the machine" }));await settle();expect(s.posts()).toHaveLength(0);s.stop();
});

it("a read that fails AFTER a successful bound close keeps the success: closed, no 'Nothing was changed'", async () => {
 let reads = 0;
 const s = setup({ session: () => ++reads === 1 ? ok({ session: withClose() }) : fail(503, "RUNTIME_UNAVAILABLE", "down") });
 await pressWhenEnabled(() => button("Close and delete the machine"));
 await waitFor(() => expect(s.onClosed).toHaveBeenCalledTimes(1));
 expect(document.body.textContent).not.toContain("Nothing was changed");s.stop();
});

it("a stalled onClosed refresh does not keep the dialog busy", async () => {
 const s = setup({ onClosed: () => new Promise(() => undefined) });
 await pressWhenEnabled(() => button("Close and delete the machine"));
 await waitFor(() => expect(s.onClosed).toHaveBeenCalledTimes(1));s.stop();
});

it("reopening reads the preview again and never reuses an older digest", async () => {
 let reads = 0;
 const s = setup({ preview: () => ok(clean(++reads === 1 ? CLEAN_DIGEST : NEXT_DIGEST)) });
 await screen.findByRole("region", { name: "Close preview" });
 s.ui.unmount();
 const again = renderUi(s.tree());
 await pressWhenEnabled(() => button("Close and delete the machine"));
 await waitFor(() => expect(s.posts()).toHaveLength(1));
 expect(s.posts()[0]!.body).toMatchObject({ expectedPreviewDigest: NEXT_DIGEST });again.unmount();s.query.clear();
});

it("two fast presses send ONE bound close", async () => {
 const s = setup();
 const press = await button("Close and delete the machine");await waitFor(() => expect(press.disabled).toBe(false));
 fireEvent.click(press);fireEvent.click(press);
 await waitFor(() => expect(s.onClosed).toHaveBeenCalled());await settle();
 expect(s.posts()).toHaveLength(1);s.stop();
});

it("'unsupported' is the legacy path: no inspection wording, and found work keeps the legacy list and its (unbound) discard", async () => {
 const shown = [{ repository: "demo", reasons: ["worktree_changes"] }];
 const s = setup({ preview: () => ok({ preview: null, unavailable: "unsupported" }), session: () => ok({ session: workspaceFixture({ you: { ...base.you, actions: [...base.you.actions, "close"] } }, { unpublished: shown }) }), close: call => call === 1 ? ok({ session: withClose(), closed: false, unpublished: shown }) : ok({ session: withClose({ status: "succeeded" }), closed: true }) });
 await pressWhenEnabled(() => button("Close and delete the machine"));
 expect(screen.queryByText(/hasn't checked this workspace/)).toBeNull();
 await screen.findByRole("list", { name: "Unpublished work" });
 await pressWhenEnabled(() => button("Discard it and close"));
 await waitFor(() => expect(s.posts()).toHaveLength(2));
 expect(s.posts()[1]!.body).toEqual({ requestId: expect.any(String) as string, discardUnpublished: true });s.stop();
});

it("NOT_ON_CODE_YET at any other status is not the 'route not served' answer", async () => {
 const s = setup({ preview: () => fail(409, "NOT_ON_CODE_YET", "nope") });
 await settle();await settle();
 expect(screen.queryByRole("button", { name: "Close and delete the machine" })?.hasAttribute("disabled") ?? true).toBe(true);expect(s.posts()).toHaveLength(0);s.stop();
});

it("a reopened dialog shows NO facts from the earlier open while it reads again", async () => {
 let reads = 0;
 const s = setup({ preview: () => ++reads === 1 ? ok(clean()) : new Promise(() => undefined) });
 await screen.findByRole("region", { name: "Close preview" });
 s.ui.unmount();
 const again = renderUi(s.tree());
 expect(await screen.findByText(/Reading what closing will keep and discard/)).toBeTruthy();
 expect(screen.queryByRole("region", { name: "Close preview" })).toBeNull();
 expect(screen.getByRole<HTMLButtonElement>("button", { name: "Close and delete the machine" }).disabled).toBe(true);again.unmount();s.query.clear();
});

it("the preview is not re-read behind the person's back when the window regains focus", async () => {
 const s = setup();
 await screen.findByRole("region", { name: "Close preview" });
 act(() => { window.dispatchEvent(new Event("visibilitychange"));window.dispatchEvent(new Event("focus")); });
 await settle();
 expect(s.previews()).toHaveLength(1);s.stop();
});

// P1 (Opus review b76e1eaa6): hosted Code does not serve the DEV preview path, so every hosted task gets Code's exact 404. The dialog must still offer a Close, honestly.
it("the mirrored sentence is Cloud's CORE_NOT_YET", () => { expect(CORE_NOT_YET_WORDS).toBe(CORE_NOT_YET); });

it.each([
 ["Code's exact 404 (hosted today)", new ApiError(404, "NOT_FOUND", "That is not on the core engine on this install yet."), true],
 ["Cloud's 501 for an older Code", new ApiError(501, "NOT_ON_CODE_YET", "x"), true],
 ["404 NOT_FOUND with another sentence", new ApiError(404, "NOT_FOUND", "no such task"), false],
 ["404 with the sentence under another code", new ApiError(404, "SESSION_NOT_FOUND", "That is not on the core engine on this install yet."), false],
 ["403 with the sentence", new ApiError(403, "NOT_FOUND", "That is not on the core engine on this install yet."), false],
 ["the sentence with a suffix", new ApiError(404, "NOT_FOUND", "That is not on the core engine on this install yet. Sorry."), false],
 ["409 NOT_ON_CODE_YET", new ApiError(409, "NOT_ON_CODE_YET", "x"), false], ["not an ApiError", new Error("That is not on the core engine on this install yet."), false],
])("previewNotServed: %s", (_name, failure, expected) => { expect(previewNotServed(failure)).toBe(expected); });

it("hosted Code's exact 404 offers an HONEST Close: the true wording, the data-loss warning, Cancel first and focused, and an unbound close only on the second button", async () => {
 const s = setup({ preview: () => CLOSE_PREVIEW_NOT_SERVED });
 expect(await screen.findByText(NOT_CHECKED_WORDS)).toBeTruthy();
 expect(NOT_CHECKED_WORDS).toBe("Rovara can't check this task for unpublished work yet. Closing may discard changes that aren't in a pull request.");
 expect(screen.getByRole("dialog").textContent).toContain(WARNING);
 expect(screen.queryByText("This task isn't available to you.")).toBeNull();
 const cancel = screen.getByRole<HTMLButtonElement>("button", { name: "Cancel" }), close = await button(DELETE);
 expect(cancel.compareDocumentPosition(close) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
 await waitFor(() => expect(document.activeElement).toBe(cancel));
 expect(cancel.className).toContain("rv-button-primary");expect(close.className).toContain("rv-button-danger");
 await settle();expect(s.posts()).toHaveLength(0);
 fireEvent.click(cancel);await settle();expect(s.posts()).toHaveLength(0);
 await pressWhenEnabled(() => button(DELETE));
 await waitFor(() => expect(s.posts()).toHaveLength(1));
 expect(s.posts()[0]!.body).toEqual({ requestId: expect.any(String) as string });s.stop();
});

it.each([
 ["another 404 sentence", fail(404, "NOT_FOUND", "no such task")], ["the sentence under SESSION_NOT_FOUND", fail(404, "SESSION_NOT_FOUND", "That is not on the core engine on this install yet.")],
 ["the sentence at 403", fail(403, "NOT_FOUND", "That is not on the core engine on this install yet.")],
])("a 404/403 that is NOT Code's exact answer is still an access signal: %s offers no Close", async (_name, answer) => {
 const s = setup({ preview: () => answer });
 expect(await screen.findByText("This task isn't available to you.")).toBeTruthy();
 expect(screen.queryByRole("button", { name: DELETE })).toBeNull();expect(s.posts()).toHaveLength(0);s.stop();
});

it("every path keeps a data-loss warning: the live warning on clean review, unchecked, inspect, locked, canClose false and reading; the discard wording with the list on discard", async () => {
 for (const [name, options] of [
  ["clean review", {}], ["unchecked (hosted 404)", { preview: () => CLOSE_PREVIEW_NOT_SERVED }],
  ["inspect", { preview: () => ok({ preview: null, unavailable: "inspection_required" }) }], ["cannot close", { canClose: false }],
  ["reading", { preview: () => new Promise<ApiResponse>(() => undefined) }],
 ] as const) {
  const s = setup(options);
  await screen.findByRole("dialog");
  expect(screen.getByRole("dialog").textContent, name).toContain(WARNING);s.stop();
 }
 const locked = setup({ preview: () => CLOSE_PREVIEW_NOT_SERVED, close: () => fail(503, "RUNTIME_UNAVAILABLE", "x") });
 await pressWhenEnabled(() => button(DELETE));await screen.findByText(/Closing this task was not confirmed/);
 expect(screen.getByRole("dialog").textContent).toContain(WARNING);locked.stop();
 const d = setup({ preview: action => ok(action === "close" ? findings() : discard()) });
 const list = await screen.findByRole("list", { name: "Unpublished work" });
 expect(screen.getByRole("dialog").textContent).toContain("Closing it now deletes that work.");expect(list.textContent).toContain("demo");d.stop();
});

it("'inspection_required' says what is true: it cannot check, never that a check happens", async () => {
 const s = setup({ preview: () => ok({ preview: null, unavailable: "inspection_required" }) });
 expect(await screen.findByText(NOT_CHECKED_WORDS)).toBeTruthy();
 expect(document.body.textContent).not.toMatch(/starts that check|hasn't checked|closes only if nothing unpublished/);
 expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();s.stop();
});

// P2-3 (Opus review): a KEPT (reconnecting) discard preview must disable the destructive button even though the close preview was read fresh.
it("a failed RE-read of ONLY the discard preview keeps it with 'Reconnecting' and DISABLES discard: zero sends", async () => {
 let discards = 0;
 const s = setup({ preview: action => action === "close" ? ok(findings()) : ++discards === 1 ? ok(discard()) : fail(503, "RUNTIME_UNAVAILABLE", "down") });
 const press = await button("Discard it and close");await waitFor(() => expect(press.disabled).toBe(false));
 act(() => { void s.query.refetchQueries({ queryKey: ["close-preview"] }); });
 expect(await screen.findByText(/Updated \d\d:\d\d · Reconnecting/)).toBeTruthy();
 expect(screen.getAllByText(/Reconnecting/)).toHaveLength(1);
 expect(screen.getByRole("list", { name: "Unpublished work" })).toBeTruthy();
 expect(screen.getByRole<HTMLButtonElement>("button", { name: "Discard it and close" }).disabled).toBe(true);
 fireEvent.click(screen.getByRole("button", { name: "Discard it and close" }));await settle();
 expect(s.posts()).toHaveLength(0);s.stop();
});

// Review test (lead 4 Opus, 3e1067f67): the always-on warning is checked once the served preview is ON SCREEN (the loop above can pass while still reading).
it("the data-loss warning stays on screen once a served clean preview is shown", async () => {
 const s = setup();
 expect(await screen.findByRole("region", { name: "Close preview" })).toBeTruthy();
 await waitFor(() => expect(screen.getByRole<HTMLButtonElement>("button", { name: DELETE }).disabled).toBe(false));
 expect(screen.getByRole("dialog").textContent).toContain(WARNING);
 expect(s.posts()).toHaveLength(0);s.stop();
});
