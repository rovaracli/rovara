// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { createElement as h } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { AppHostProvider, type ApiRequest } from "../../packages/ui/src/host.js";
import { CloseTaskDialog } from "../../packages/ui/src/screens/session/CloseTaskDialog.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { renderUi } from "./support/render.js";
import { fakeHost } from "./support/fake-host.js";
import { meFixture } from "./support/fixtures.js";
import { sessionFixture, taskFixture, SESSION_FIXTURE_ID } from "./support/session-fixture.js";

const WARNING = "Closing deletes this task's machine. Changes that aren't pushed to GitHub or in a pull request are lost and can't be recovered.";
const CLOSE_BUTTON = "Close and delete the machine";

function setup(overrides: Parameters<typeof sessionFixture>[0] = {}, canClose = true) {
 const base = sessionFixture(overrides), session = sessionFixture({ ...overrides, you: { ...base.you, actions: [...base.you.actions, "close"] } });
 const f = fakeHost(async (request: ApiRequest) => {
  if (request.path === "/v1/app/me") return { status: 200, body: meFixture() };
  if (request.method === "GET" && request.path === "/v1/app/sessions/" + SESSION_FIXTURE_ID) return { status: 200, body: { session } };
  if (request.method === "POST" && request.path.endsWith("/close")) return { status: 200, body: { session: sessionFixture({ status: "succeeded", revision: 2 }), closed: true } };
  return { status: 404, body: {} };
 });
 const query = createQueryClient(), onClosed = vi.fn(), onOpenChange = vi.fn();
 const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(CloseTaskDialog, { id: SESSION_FIXTURE_ID, open: true, onOpenChange, onClosed, canClose }) }) }));
 return { ...f, ...ui, query, onClosed, onOpenChange, posts: () => f.request.mock.calls.map(([request]) => request).filter(request => request.method !== "GET") };
}

const kinds: ReadonlyArray<readonly [string, Parameters<typeof sessionFixture>[0]]> = [
 ["local session", {}],
 ["running task", { kind: "task", body: { kind: "task", task: taskFixture({ status: "RUNNING" }) } }],
 ["interrupted task", { kind: "task", body: { kind: "task", task: taskFixture({ status: "INTERRUPTED" }) } }],
 ["succeeded task", { kind: "task", status: "succeeded", body: { kind: "task", task: taskFixture({ status: "SUCCEEDED" }) } }],
];

it.each(kinds)("always shows the data-loss warning before Close can be pressed (%s)", async (_name, overrides) => {
 const f = setup(overrides);
 const dialog = await screen.findByRole("dialog", { name: "Close this task?" });
 expect(dialog.textContent).toContain(WARNING);expect(screen.getByText(WARNING)).toBeTruthy();
 expect(f.posts()).toHaveLength(0);
 f.unmount();f.query.clear();
});

it("shows the warning even when Close is unavailable", async () => {
 const f = setup({}, false);
 expect((await screen.findByRole("dialog", { name: "Close this task?" })).textContent).toContain(WARNING);
 f.unmount();f.query.clear();
});

it("puts Cancel first, focused by default, before the danger button", async () => {
 const f = setup();
 const cancel = await screen.findByRole<HTMLButtonElement>("button", { name: "Cancel" }), close = screen.getByRole<HTMLButtonElement>("button", { name: CLOSE_BUTTON });
 expect(cancel.compareDocumentPosition(close) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
 await waitFor(() => expect(document.activeElement).toBe(cancel));
 f.unmount();f.query.clear();
});

it("Cancel sends nothing", async () => {
 const f = setup();
 fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
 expect(f.onOpenChange).toHaveBeenCalledWith(false);
 await new Promise(resolve => setTimeout(resolve, 50));
 expect(f.request.mock.calls.filter(([request]) => request.method !== "GET")).toHaveLength(0);
 expect(f.posts()).toHaveLength(0);
 f.unmount();f.query.clear();
});

it("Close and delete the machine sends the same close request as before", async () => {
 const f = setup();
 const button = await screen.findByRole<HTMLButtonElement>("button", { name: CLOSE_BUTTON });
 await waitFor(() => expect(button.disabled).toBe(false));
 fireEvent.click(button);
 await waitFor(() => expect(f.onClosed).toHaveBeenCalledTimes(1));
 expect(f.posts()).toHaveLength(1);
 const sent = f.posts()[0]!;
 expect(sent.method).toBe("POST");expect(sent.path).toBe("/v1/app/sessions/" + SESSION_FIXTURE_ID + "/close");
 expect(Object.keys(sent.body as object)).toEqual(["requestId"]);expect(typeof (sent.body as { requestId: unknown }).requestId).toBe("string");
 expect(sent.body).not.toHaveProperty("discardUnpublished");
 f.unmount();f.query.clear();
});
