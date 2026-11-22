// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { act, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { useInboxReadActions } from "../../packages/ui/src/screens/inbox/useInboxReadActions.js";
import { AppHostProvider } from "../../packages/ui/src/host.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { fakeHost } from "./support/fake-host.js";
import { h } from "./support/h.js";
import { renderUi } from "./support/render.js";
let close: (() => void) | undefined;
afterEach(() => { close?.();close = undefined; });
function fixture(current = true, ids = ["id-1"]) {
 const f = fakeHost(async () => ({ status: 200, body: { marked: 1 } })), query = createQueryClient();
 let actions!: ReturnType<typeof useInboxReadActions>;
 function Harness() { actions = useInboxReadActions(ids, current);return null; }
 const view = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(Harness) }) }));
 close = () => { view.unmount();query.clear(); };return { ...f, actions: () => actions };
}
it("an unread update is marked once even before React commits", async () => {
 const f = fixture();act(() => { f.actions().markOne("id-1");f.actions().markOne("id-1"); });
 await waitFor(() => expect(f.request).toHaveBeenCalledTimes(1));
});
it("no current read permits neither single nor bulk mark", async () => {
 const f = fixture(false);await act(async () => { f.actions().markOne("id-1");await f.actions().markAll(); });expect(f.request).not.toHaveBeenCalled();
});
it("an empty unread list sends no bulk mark", async () => {
 const f = fixture(true, []);await act(async () => { await f.actions().markAll(); });expect(f.request).not.toHaveBeenCalled();
});
it("two bulk presses make exactly one send", async () => {
 const f = fixture();await act(async () => { await Promise.all([f.actions().markAll(), f.actions().markAll()]); });expect(f.request).toHaveBeenCalledTimes(1);
});
it("more than fifty unread ids use the exact existing batch size", async () => {
 const f = fixture(true, Array.from({ length: 51 }, (_, i) => "id-" + String(i)));
 await act(async () => { await f.actions().markAll(); });
 expect(f.request.mock.calls.map(([input]) => (input.body as { ids: string[] }).ids.length)).toEqual([50, 1]);
});
it.each([409, 503])("single-read %s only retries a definitive refusal", async status => {
 const f = fixture();f.request.mockImplementation(async () => { throw new (await import("../../packages/ui/src/api/errors.js")).ApiError(status, "REFUSED", "Server answer."); });
 act(() => f.actions().markOne("id-1"));await waitFor(() => expect(f.actions().failure).toBe("Server answer."));
 act(() => f.actions().markOne("id-1"));
 await waitFor(() => expect(f.request).toHaveBeenCalledTimes(status === 409 ? 2 : 1));
});
