// @vitest-environment jsdom
// STOP-KEEPS-FILES-WORDING: hosted Stop pauses the task and keeps its files (Code STOP-NON-DESTRUCTIVE), so the Stop dialog says exactly that,
// in a neutral (not danger) style. Text only: the Stop request itself is the same one as before. The Close warning still says Close deletes.
import { expect, it, vi } from "vitest";
import { createElement as h } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { AppHostProvider, type ApiRequest } from "../../packages/ui/src/host.js";
import { CloseTaskDialog } from "../../packages/ui/src/screens/session/CloseTaskDialog.js";
import { SessionControls } from "../../packages/ui/src/screens/session/SessionControls.js";
import { TaskPageBoundary } from "../../packages/ui/src/screens/session/task-page-policy.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { renderUi } from "./support/render.js";
import { fakeHost } from "./support/fake-host.js";
import { meFixture } from "./support/fixtures.js";
import { sessionFixture, SESSION_FIXTURE_ID } from "./support/session-fixture.js";

const STOP_NOTE = "Stop pauses this task. Its files are kept; Retry continues from them.";
const OLD_WARNING = /ends this task's machine|are lost|can't be recovered/u;
const STOP_BUTTON = "Stop this task";
type Where = { kind: "cloud" } | { kind: "mac"; label: string; offline: boolean };

function setup({ where, status, page = true, withProps = true }: { where?: Where; status?: string; page?: boolean; withProps?: boolean } = {}) {
 const base = sessionFixture(), session = sessionFixture({ you: { ...base.you, actions: ["stop"] } });
 const f = fakeHost(async (request: ApiRequest) => {
  if (request.path === "/v1/app/me") return { status: 200, body: meFixture() };
  if (request.method === "GET" && request.path === "/v1/app/sessions/" + SESSION_FIXTURE_ID) return { status: 200, body: { session } };
  if (request.method === "POST" && request.path.endsWith("/stop")) return { status: 200, body: { session: sessionFixture({ status: "cancelled", revision: 2 }) } };
  return { status: 404, body: {} };
 });
 const query = createQueryClient(), onChanged = vi.fn(async () => undefined);
 const controls = h(SessionControls, { id: SESSION_FIXTURE_ID, agent: "Payments expert", actions: ["stop"], following: false, onChanged, ...(withProps ? { where, status } : {}) } as never);
 const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: page ? h(TaskPageBoundary, { children: controls }) : controls }) }));
 return { ...f, ...ui, query, posts: () => f.request.mock.calls.map(([request]) => request).filter(request => request.method !== "GET") };
}
async function openStop() {
 const trigger = await screen.findByRole<HTMLButtonElement>("button", { name: "Stop" });
 await waitFor(() => expect(trigger.disabled).toBe(false));
 fireEvent.click(trigger);
 return screen.findByRole("dialog", { name: "Stop this session?" });
}
const done = (f: ReturnType<typeof setup>) => { f.unmount();f.query.clear(); };

const hostedRunning: ReadonlyArray<readonly [string, Parameters<typeof setup>[0]]> = [
 ["hosted, running", { where: { kind: "cloud" }, status: "running" }],
 ["hosted, starting", { where: { kind: "cloud" }, status: "starting" }],
 ["hosted, paused for budget", { where: { kind: "cloud" }, status: "paused" }],
 ["hosted, old page", { where: { kind: "cloud" }, status: "running", page: false }],
 ["status unknown (fail safe)", { where: { kind: "cloud" } }],
 ["where and status unknown (fail safe)", {}],
 ["no props at all (fail safe)", { withProps: false }],
];

it.each(hostedRunning)("says Stop pauses the task and keeps its files (%s)", async (_name, options) => {
 const f = setup(options);
 const dialog = await openStop();
 expect(dialog.textContent).toContain(STOP_NOTE);expect(screen.getByText(STOP_NOTE)).toBeTruthy();
 expect(dialog.textContent).not.toMatch(OLD_WARNING);expect(document.body.textContent).not.toMatch(OLD_WARNING);
 expect(f.posts()).toHaveLength(0);
 done(f);
});

it("puts Cancel first, focused by default, before a neutral (not danger) Stop button", async () => {
 const f = setup({ where: { kind: "cloud" }, status: "running" });
 const dialog = await openStop();
 const cancel = within(dialog).getByRole<HTMLButtonElement>("button", { name: "Cancel" }), stop = within(dialog).getByRole<HTMLButtonElement>("button", { name: STOP_BUTTON });
 expect(cancel.compareDocumentPosition(stop) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
 expect(stop.classList.contains("rv-button-danger")).toBe(false);
 await waitFor(() => expect(document.activeElement).toBe(cancel));
 done(f);
});

it("Cancel sends nothing", async () => {
 const f = setup({ where: { kind: "cloud" }, status: "running" });
 const dialog = await openStop();
 fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
 await waitFor(() => expect(screen.queryByRole("dialog", { name: "Stop this session?" })).toBeNull());
 await new Promise(resolve => setTimeout(resolve, 50));
 expect(f.posts()).toHaveLength(0);
 done(f);
});

it("the confirm button sends exactly the Stop request sent before", async () => {
 const f = setup({ where: { kind: "cloud" }, status: "running" });
 const dialog = await openStop();
 fireEvent.click(within(dialog).getByRole("button", { name: STOP_BUTTON }));
 await waitFor(() => expect(f.posts()).toHaveLength(1));
 const sent = f.posts()[0]!;
 expect(sent.method).toBe("POST");expect(sent.path).toBe("/v1/app/sessions/" + SESSION_FIXTURE_ID + "/stop");
 expect(Object.keys(sent.body as object)).toEqual(["requestId"]);expect(typeof (sent.body as { requestId: unknown }).requestId).toBe("string");
 done(f);
});

const hostedIdle: ReadonlyArray<readonly [string, string]> = [["needs a person", "needs_person"], ["waiting for you", "waiting"], ["stopped", "stopped"]];
it.each(hostedIdle)("hosted with no running step says the same true sentence (%s)", async (_name, status) => {
 const f = setup({ where: { kind: "cloud" }, status });
 const dialog = await openStop();
 expect(dialog.textContent).toContain(STOP_NOTE);
 expect(dialog.textContent).not.toMatch(OLD_WARNING);expect(dialog.textContent).not.toContain("Nothing is running right now.");
 expect(within(dialog).getByRole("button", { name: "Keep running" })).toBeTruthy();
 const stop = within(dialog).getByRole("button", { name: "Stop session" });
 expect(stop.classList.contains("rv-button-danger")).toBe(false);
 expect(f.posts()).toHaveLength(0);
 done(f);
});

it("on a laptop (a Mac session) the dialog keeps its own true wording, never the hosted sentence", async () => {
 const f = setup({ where: { kind: "mac", label: "Priya's MacBook", offline: false }, status: "running" });
 const dialog = await openStop();
 expect(dialog.textContent).toContain("Files are kept. Rovara stops after its current step.");
 expect(dialog.textContent).not.toContain(STOP_NOTE);expect(dialog.textContent).not.toMatch(OLD_WARNING);
 expect(within(dialog).getByRole("button", { name: "Keep running" })).toBeTruthy();expect(within(dialog).getByRole("button", { name: "Stop session" })).toBeTruthy();
 done(f);
});

it("the Close warning is unchanged: closing still deletes the machine", async () => {
 const base = sessionFixture(), session = sessionFixture({ you: { ...base.you, actions: ["stop", "close"] } });
 const f = fakeHost(async (request: ApiRequest) => request.path === "/v1/app/me" ? { status: 200, body: meFixture() } : request.method === "GET" ? { status: 200, body: { session } } : { status: 404, body: {} });
 const query = createQueryClient();
 const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(CloseTaskDialog, { id: SESSION_FIXTURE_ID, open: true, onOpenChange: vi.fn(), onClosed: vi.fn(), canClose: true }) }) }));
 const dialog = await screen.findByRole("dialog", { name: "Close this task?" });
 expect(dialog.textContent).toContain("Closing deletes this task's machine. Changes that aren't pushed to GitHub or in a pull request are lost and can't be recovered.");
 expect(dialog.textContent).not.toContain(STOP_NOTE);
 expect(within(dialog).getByRole("button", { name: "Close and delete the machine" }).classList.contains("rv-button-danger")).toBe(true);
 ui.unmount();query.clear();
});
