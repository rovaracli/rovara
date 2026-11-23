// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { useState } from "react";
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

const shown = [{ repository: "acme/payments", reasons: ["worktree_changes", "unpushed_commits"] }];
const settle = async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); }); };
function setup() {
 let fresh: typeof shown | undefined = shown;
 const session = () => workspaceFixture({ you: { ...workspaceFixture().you, actions: ["close"] } }, fresh === undefined ? {} : { unpublished: fresh });
 const f = fakeHost(async r => r.path === "/v1/app/me" ? { status: 200, body: meFixture() } : r.method === "GET" ? { status: 200, body: { session: session() } } : { status: 200, body: { session: session(), closed: false, unpublished: shown } });
 const query = createQueryClient();
 function Host() { const [open, setOpen] = useState(true);return h(CloseTaskDialog, { id: session().sessionId, open, onOpenChange: setOpen, onClosed: vi.fn(), trigger: h("button", {}, "Open close") }); }
 const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(Host) }) }));
 return { ui, query, fresh: (value: typeof shown | undefined) => { fresh = value; }, writes: () => f.request.mock.calls.filter(([r]) => r.method === "POST") };
}
async function firstAsk() { const button = await screen.findByRole<HTMLButtonElement>("button", { name: "Close and delete the machine" });await waitFor(() => expect(button.disabled).toBe(false));fireEvent.click(button);return screen.findByRole<HTMLButtonElement>("button", { name: "Discard it and close" }); }

// Removing the fresh-body consent comparison permits an unseen repository/reason to be deleted.
it.each(["repository", "reason", "missing", "empty"])("Opus P1/R6c: changed %s blocks discard and presents the current facts", async change => {
 const f = setup(), discard = await firstAsk();
 f.fresh(change === "missing" ? undefined : change === "empty" ? [] : change === "reason" ? [{ ...shown[0]!, reasons: ["new_reason"] }] : [...shown, { repository: "acme/ledger", reasons: ["unpushed_commits"] }]);
 fireEvent.click(discard);await settle();
 expect(f.writes()).toHaveLength(1);
 expect((await screen.findByRole("alert")).textContent).toContain("unpublished work changed");
 if (change === "repository") expect(screen.getByRole("list", { name: "Unpublished work" }).textContent).toContain("acme/ledger");
 if (change === "reason") expect(screen.getByRole("list", { name: "Unpublished work" }).textContent).toContain("new_reason");
 f.ui.unmount();f.query.clear();
});
it("Opus P1: reopening forgets discard consent and sends only a fresh first ask", async () => {
 const f = setup();await firstAsk();fireEvent.click(screen.getByRole("button", { name: "Keep it open" }));
 fireEvent.click(await screen.findByRole("button", { name: "Open close" }));
 const first = await screen.findByRole("button", { name: "Close and delete the machine" });
 expect(screen.queryByRole("list", { name: "Unpublished work" })).toBeNull();
 fireEvent.click(first);await waitFor(() => expect(f.writes()).toHaveLength(2));
 expect(f.writes()[1]![0].body).not.toHaveProperty("discardUnpublished");f.ui.unmount();f.query.clear();
});
it("canonical repository/reason ordering preserves consent for exactly the shown work", async () => {
 const f = setup(), discard = await firstAsk();f.fresh([{ ...shown[0]!, reasons: ["unpushed_commits", "worktree_changes"] }]);fireEvent.click(discard);
 await waitFor(() => expect(f.writes()).toHaveLength(2));expect(f.writes()[1]![0].body).toMatchObject({ discardUnpublished: true });f.ui.unmount();f.query.clear();
});
