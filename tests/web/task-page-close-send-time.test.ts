// @vitest-environment jsdom
import { expect, it } from "vitest";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { CloseTaskDialog } from "../../packages/ui/src/screens/session/CloseTaskDialog.js";
import { AppHostProvider } from "../../packages/ui/src/host.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { fakeHost } from "./support/fake-host.js";
import { meFixture } from "./support/fixtures.js";
import { workspaceFixture } from "./support/workspace-fixture.js";
import { renderUi } from "./support/render.js";
import { h } from "./support/h.js";

it.each(["changed", "missing"])("R6c: %s unpublished work during the discard claim cancels dispatch", async change => {
 const shown = [{ repository: "acme/payments", reasons: ["worktree_changes"] }], grown = [...shown, { repository: "acme/ledger", reasons: ["unpushed_commits"] }];
 const session = (unpublished: typeof shown | undefined) => workspaceFixture({ you: { ...workspaceFixture().you, actions: ["close"] } }, unpublished === undefined ? {} : { unpublished });
 const f = fakeHost(async r => r.path === "/v1/app/me" ? { status: 200, body: meFixture() } : r.method === "GET" ? { status: 200, body: { session: session(shown) } } : { status: 200, body: { session: session(shown), closed: false, unpublished: shown } });
 const query = createQueryClient(), ui = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(CloseTaskDialog, { id: session(shown).sessionId, open: true, onOpenChange: () => undefined, onClosed: () => undefined }) }) }));
 const first = await screen.findByRole<HTMLButtonElement>("button", { name: "Close task" });await waitFor(() => expect(first.disabled).toBe(false));fireEvent.click(first);
 const discard = await screen.findByRole<HTMLButtonElement>("button", { name: "Discard it and close" }), descriptor = Object.getOwnPropertyDescriptor(navigator, "locks")!;
 let claim: (() => Promise<unknown>) | undefined;
 Object.defineProperty(navigator, "locks", { configurable: true, value: { request: (_name: string, _options: unknown, callback: (lock: unknown) => Promise<unknown>) => new Promise((resolve, reject) => { claim = async () => { try { const result = await callback({ name: "discard-claim", mode: "exclusive" });resolve(result);return result; } catch (error) { reject(error instanceof Error ? error : new Error(String(error)));throw error; } }; }) } });
 try {
  fireEvent.click(discard);await waitFor(() => expect(claim).toBeTypeOf("function"));
  act(() => { query.setQueryData(["session", session(shown).sessionId], session(change === "missing" ? undefined : grown)); });
  await act(async () => { await claim!(); });await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); });
  expect(f.request.mock.calls.filter(([r]) => r.method === "POST")).toHaveLength(1);
  expect((await screen.findByRole("alert")).textContent).toContain("unpublished work changed");
  if (change === "changed") expect(screen.getByRole("list", { name: "Unpublished work" }).textContent).toContain("acme/ledger");
  else expect(screen.queryByRole("list", { name: "Unpublished work" })).toBeNull();
 } finally { Object.defineProperty(navigator, "locks", descriptor);ui.unmount();query.clear(); }
});
