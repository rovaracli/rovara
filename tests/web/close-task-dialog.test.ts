// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { createElement as h, useState } from "react";
import { screen, fireEvent, act, within } from "@testing-library/react";
import { AppHostProvider, type ApiRequest, type ApiResponse } from "../../packages/ui/src/host.js";
import { CloseTaskDialog } from "../../packages/ui/src/screens/session/CloseTaskDialog.js";
import { renderUi } from "./support/render.js";
import { fakeHost } from "./support/fake-host.js";
import { sessionFixture, SESSION_FIXTURE_ID } from "./support/session-fixture.js";

const WAITING = "Checking this task for unpublished work… this usually takes 1–3 minutes";
const SLOW = "This is taking longer than usual. You can close this window; Rovara keeps checking. Try Close task again later.";
const notSettled = (): ApiResponse => ({ status: 200, body: { session: sessionFixture(), closed: false, message: "AgentX is checking the task's workspace for unpublished work before closing it; check back with agentx_get_task" } });
const settled = (): ApiResponse => ({ status: 200, body: { session: sessionFixture(), closed: true } });
const unpublished = (): ApiResponse => ({ status: 200, body: { session: sessionFixture(), closed: false, unpublished: [{ repository: "demo", reasons: ["worktree_changes"] }], message: "not closed" } });

function Harness({ onClosed, onOpenChange, onChecking }: { onClosed: () => void; onOpenChange: (open: boolean) => void; onChecking?: () => void }) {
 const [open, setOpen] = useState(true);
 return h(CloseTaskDialog, { id: SESSION_FIXTURE_ID, open, onOpenChange: value => { onOpenChange(value);setOpen(value); }, onClosed, ...(onChecking ? { onChecking } : {}) });
}
function setup(answer: (call: number, request: ApiRequest) => ApiResponse | Promise<ApiResponse>, extra: { onChecking?: () => void } = {}) {
 vi.useFakeTimers();
 let calls = 0;
 const f = fakeHost(async request => answer(++calls, request));
 const onClosed = vi.fn(), onOpenChange = vi.fn();
 const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(Harness, { onClosed, onOpenChange, ...extra }) }));
 const closes = () => f.request.mock.calls.map(([request]) => request).filter(request => request.path.endsWith("/close"));
 const bodies = () => closes().map(request => request.body as { requestId: string; discardUnpublished?: true });
 const press = () => { fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: /Close task|Discard it and close/ })); };
 const advance = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };
 return { ...f, ...ui, onClosed, onOpenChange, closes, bodies, press, advance };
}
afterEach(() => { vi.useRealTimers(); });

it("shows a busy line while the workspace is checked, polls by itself and closes the task once it settles", async () => {
 const f = setup(call => call < 3 ? notSettled() : settled());
 f.press();await f.advance(0);
 const status = screen.getByRole("status");expect(status.textContent).toContain(WAITING);
 expect(screen.queryByText(/Press the button again/)).toBeNull();expect(screen.queryByRole("alert")).toBeNull();
 expect(f.closes()).toHaveLength(1);
 await f.advance(4_900);expect(f.closes()).toHaveLength(1);
 await f.advance(200);expect(f.closes()).toHaveLength(2);expect(f.onClosed).not.toHaveBeenCalled();expect(screen.getByRole("status").textContent).toContain(WAITING);
 await f.advance(5_000);expect(f.closes()).toHaveLength(3);
 expect(f.onClosed).toHaveBeenCalledTimes(1);expect(f.onOpenChange).toHaveBeenLastCalledWith(false);expect(screen.queryByRole("dialog")).toBeNull();
 await f.advance(60_000);expect(f.closes()).toHaveLength(3);f.unmount();
});

it("sends the same request id on every poll", async () => {
 const f = setup(call => call < 4 ? notSettled() : settled());
 f.press();await f.advance(0);await f.advance(5_000);await f.advance(5_000);await f.advance(5_000);
 const ids = f.bodies().map(body => body.requestId);
 expect(ids).toHaveLength(4);expect(new Set(ids).size).toBe(1);expect(ids[0]).toMatch(/^[0-9a-f-]{36}$/);
 for (const body of f.bodies()) expect(body).not.toHaveProperty("discardUnpublished");f.unmount();
});

it("lists unpublished work found after some polls and stops polling", async () => {
 const f = setup(call => call < 3 ? notSettled() : unpublished());
 f.press();await f.advance(0);await f.advance(5_000);await f.advance(5_000);
 expect(screen.getByRole("dialog", { name: "Discard unpublished work?" })).toBeTruthy();
 expect(screen.getByText("demo: worktree_changes")).toBeTruthy();expect(screen.queryByText(WAITING)).toBeNull();expect(f.onClosed).not.toHaveBeenCalled();
 expect(f.closes()).toHaveLength(3);await f.advance(60_000);expect(f.closes()).toHaveLength(3);
 // The second, explicit press asks for the discard with a request id of its own.
 expect(f.bodies().every(body => !("discardUnpublished" in body))).toBe(true);f.unmount();
});

it("slows to 10 s after the first minute and gives up with plain words after six minutes", async () => {
 const f = setup(() => notSettled());
 f.press();await f.advance(0);
 await f.advance(60_000);const early = f.closes().length;expect(early).toBe(13);
 await f.advance(9_000);expect(f.closes()).toHaveLength(early);
 await f.advance(1_500);expect(f.closes()).toHaveLength(early + 1);
 await f.advance(360_000);
 const settledCount = f.closes().length;
 expect(screen.getByRole("status").textContent).toContain(SLOW);expect(screen.queryByText(WAITING)).toBeNull();
 expect(f.closes().length).toBeLessThanOrEqual(13 + 31);
 await f.advance(120_000);expect(f.closes()).toHaveLength(settledCount);expect(f.onClosed).not.toHaveBeenCalled();
 // The person can ask again later; that is a fresh ask with a new request id.
 const before = f.bodies()[0]!.requestId;f.press();await f.advance(0);
 expect(f.closes()).toHaveLength(settledCount + 1);expect(f.bodies().at(-1)!.requestId).not.toBe(before);
 expect(screen.getByRole("status").textContent).toContain(WAITING);f.unmount();
});

it("stops polling when the person closes the window while it checks", async () => {
 const f = setup(() => notSettled());
 f.press();await f.advance(0);await f.advance(5_000);expect(f.closes()).toHaveLength(2);
 const keep = within(screen.getByRole("dialog")).getByRole<HTMLButtonElement>("button", { name: "Close this window" });expect(keep.disabled).toBe(false);
 fireEvent.click(keep);await f.advance(0);
 expect(f.onOpenChange).toHaveBeenLastCalledWith(false);
 await f.advance(120_000);expect(f.closes()).toHaveLength(2);f.unmount();
});

it("stops polling when the dialog is unmounted", async () => {
 const f = setup(() => notSettled());
 f.press();await f.advance(0);expect(f.closes()).toHaveLength(1);
 f.unmount();await f.advance(120_000);expect(f.closes()).toHaveLength(1);expect(f.onClosed).not.toHaveBeenCalled();
});

it("ignores an answer that arrives after the window was closed", async () => {
 let release!: (answer: ApiResponse) => void;
 const f = setup(() => new Promise<ApiResponse>(resolve => { release = resolve; }));
 f.press();await f.advance(0);
 fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Close this window" }));await f.advance(0);
 await act(async () => { release(notSettled()); });await f.advance(120_000);
 expect(f.closes()).toHaveLength(1);f.unmount();
});

it("does not start a second poller on a second press", async () => {
 const f = setup(() => notSettled());
 const button = within(screen.getByRole("dialog")).getByRole<HTMLButtonElement>("button", { name: "Close task" });
 fireEvent.click(button);fireEvent.click(button);await f.advance(0);
 fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Close task" }));
 expect(f.closes()).toHaveLength(1);
 await f.advance(30_000);expect(f.closes()).toHaveLength(7);
 expect(new Set(f.bodies().map(body => body.requestId)).size).toBe(1);f.unmount();
});

it("keeps the broker's words and stops polling when a poll fails", async () => {
 const f = setup(call => call === 1 ? notSettled() : { status: 409, body: { error: { code: "TASK_BUSY", message: "This task is busy right now." } } });
 f.press();await f.advance(0);await f.advance(5_000);
 expect(screen.getByRole("alert").textContent).toContain("This task is busy right now.");expect(screen.queryByText(WAITING)).toBeNull();
 await f.advance(60_000);expect(f.closes()).toHaveLength(2);
 // Pressing again after an error keeps the request id, as before.
 f.press();await f.advance(0);expect(new Set(f.bodies().map(body => body.requestId)).size).toBe(1);f.unmount();
});

it("tells the page once the check is under way, so the task can say it is closing", async () => {
 const onChecking = vi.fn();
 const f = setup(call => call < 3 ? notSettled() : settled(), { onChecking });
 f.press();await f.advance(0);await f.advance(5_000);await f.advance(5_000);
 expect(onChecking).toHaveBeenCalledTimes(1);f.unmount();
});
