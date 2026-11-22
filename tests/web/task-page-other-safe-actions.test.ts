// @vitest-environment jsdom
import { expect, it } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { AppHostProvider } from "../../packages/ui/src/host.js";
import { DesignActions } from "../../packages/ui/src/screens/session/DesignActions.js";
import { ShareDialog } from "../../packages/ui/src/screens/session/ShareDialog.js";
import { MakeAgentDialog } from "../../packages/ui/src/screens/agents/MakeAgentDialog.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { fakeHost } from "./support/fake-host.js";
import { meFixture } from "./support/fixtures.js";
import { workspaceFixture } from "./support/workspace-fixture.js";
import { renderUi } from "./support/render.js";
import { h } from "./support/h.js";

for (const operation of ["design-first", "design-skip", "share", "unshare", "make-agent"] as const) {
 for (const code of ["CSRF_INVALID", "CSRF_STALE", "UNRECOGNISED"]) it(`R3/R6a ${operation}: 500/${code} stays locked through remount and Check`, async () => {
  const session = workspaceFixture({}, { designActions: { designFirst: true, skip: { allowed: true } } }), task = session.body.kind === "task" ? session.body.task : undefined;
  if (task === undefined) throw new Error("Task fixture required");
  const me = meFixture(), principal = { kind: "member", developerId: me.developer.id };
  const f = fakeHost(async r => {
   if (r.path === "/v1/app/me") return { status: 200, body: me };
   if (r.method !== "GET") return { status: 500, body: { error: { code, message: "Unknown result" } } };
   if (r.path.endsWith("/shares")) return { status: 200, body: { shares: [{ principal, level: "view", sharedBy: { developerId: me.developer.id, name: me.developer.name }, sharedAt: "2026-11-20T12:00:00.000Z" }] } };
   if (r.path.endsWith("/members")) return { status: 200, body: { members: [{ developerId: me.developer.id, name: me.developer.name, role: "member" }] } };
   return { status: 200, body: { session: { ...session, you: { ...session.you, actions: ["share"] } } } };
  });
  const query = createQueryClient();
  const element = operation.startsWith("design") ? h(DesignActions, { task: { ...task, designActions: { designFirst: true, skip: { allowed: true } } }, sessionKey: ["session", session.sessionId] }) : operation === "make-agent" ? h(MakeAgentDialog, { id: session.sessionId, open: true, onOpenChange: () => undefined, onCloseAutoFocus: () => undefined, trigger: h("button", {}, "Make agent") }) : h(ShareDialog, { id: session.sessionId, orgName: "Example", open: true });
  const tree = () => h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(MemoryRouter, { children: element }) }) });
  let ui = renderUi(tree());
  // Wait for identity to settle before choosing the action.
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
  let label: string;
  if (operation === "design-first") label = "Design first";
  else if (operation === "design-skip") { label = "Skip design review";fireEvent.click(await screen.findByRole("button", { name: label })); }
  else if (operation === "make-agent") label = "Create draft";
  else if (operation === "unshare") label = "Remove " + me.developer.name;
  else { label = "Add share";fireEvent.click(await screen.findByRole("button", { name: me.developer.name })); }
  const button = operation === "design-skip" ? within(screen.getByRole("group", { name: "Confirm skipping design review" })).getByRole<HTMLButtonElement>("button", { name: label }) : await screen.findByRole<HTMLButtonElement>("button", { name: label });
  await waitFor(() => expect(button.disabled).toBe(false));fireEvent.click(button);
  await waitFor(() => expect(f.request.mock.calls.filter(([r]) => r.method !== "GET")).toHaveLength(1));
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
  expect(button.disabled).toBe(true);expect(screen.queryByText(/Nothing was sent\./)).toBeNull();
  ui.unmount();ui = renderUi(tree());
  await screen.findByText(/Rovara didn't confirm this yet/);
  // The public trigger itself must remain locked; unknown results cannot reopen confirmation.
  const after = screen.getByRole<HTMLButtonElement>("button", { name: operation === "design-skip" ? "Skip design review" : label });
  expect(after.disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Check" }));
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
  expect(f.request.mock.calls.filter(([r]) => r.method !== "GET")).toHaveLength(1);
  ui.unmount();query.clear();
 });
}
