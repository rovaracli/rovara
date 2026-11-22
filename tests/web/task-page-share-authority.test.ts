// @vitest-environment jsdom
import { expect, it } from "vitest";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { ShareDialog } from "../../packages/ui/src/screens/session/ShareDialog.js";
import { AppHostProvider, type ApiResponse } from "../../packages/ui/src/host.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { sessionReadFailure, sessionScope } from "../../packages/ui/src/api/session-safety.js";
import { createTaskSessionApi } from "../../packages/ui/src/api/sessions.js";
import { fakeHost } from "./support/fake-host.js";
import { meFixture } from "./support/fixtures.js";
import { workspaceFixture } from "./support/workspace-fixture.js";
import { renderUi } from "./support/render.js";
import { h } from "./support/h.js";
const other = "f".repeat(64), me = meFixture(), base = workspaceFixture(), id = base.sessionId;
const share = { principal: { kind: "member", developerId: other }, level: "edit", sharedBy: { developerId: me.developer.id, name: me.developer.name }, sharedAt: "2026-11-20T12:00:00.000Z" };
const failure = (status: number): ApiResponse => ({ status, body: { error: { code: "TASK_ACCESS_DENIED", message: "Sharing read unavailable" } } });
const settle = async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); }); };
function setup() {
 let changed: "none" | "403" | "503" | "revoked" = "none", slow = false, sent = 0, finish: (() => void) | undefined;
 const f = fakeHost(async r => {
  if (r.path === "/v1/app/me") return { status: 200, body: me };
  if (r.method !== "GET") { sent++;return { status: 200, body: r.method === "DELETE" ? { removed: true } : { share } }; }
  if (r.path.endsWith("/members")) return { status: 200, body: { members: [{ developerId: other, name: "Olu", role: "member" }] } };
  if (changed === "403" || changed === "503") return failure(Number(changed));
  if (r.path.endsWith("/shares")) { if (slow && sent > 0) await new Promise<void>(resolve => { finish = resolve; });return { status: 200, body: { shares: [share] } }; }
  return { status: 200, body: { session: { ...base, you: { ...base.you, actions: changed === "revoked" ? [] : ["share"] } } } };
 });
 const query = createQueryClient(), tree = () => h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(ShareDialog, { id, orgName: "Example", open: true }) }) });
 const ui = renderUi(tree());
 return { f, ui, query, tree, change: (value: typeof changed) => { changed = value; }, slow: () => { slow = true; }, finish: () => finish?.(), writes: () => f.request.mock.calls.filter(([r]) => r.method !== "GET") };
}
async function press(operation: "add" | "remove") {
 const remove = await screen.findByRole<HTMLButtonElement>("button", { name: "Remove Olu" });await waitFor(() => expect(remove.disabled).toBe(false));
 if (operation === "add") fireEvent.click(await screen.findByRole("button", { name: "Olu" }));
 const button = screen.getByRole<HTMLButtonElement>("button", { name: operation === "add" ? "Add share" : "Remove Olu" });await waitFor(() => expect(button.disabled).toBe(false));return button;
}
for (const operation of ["add", "remove"] as const) {
 it.each(["403", "503", "revoked"] as const)(`Opus P2/R6c ${operation}: a fresh %s authority read sends nothing`, async change => {
  const f = setup(), button = await press(operation);f.change(change);fireEvent.click(button);await settle();
  expect(f.writes()).toHaveLength(0);expect((await screen.findAllByRole("alert")).length).toBeGreaterThan(0);f.ui.unmount();f.query.clear();
 });
 for (const source of ["shares", "session"] as const) it(`R6c ${operation}: newer ${source} refusal while claim is queued survives remount`, async () => {
  const f = setup(), button = await press(operation), descriptor = Object.getOwnPropertyDescriptor(navigator, "locks")!;
  let claim: (() => Promise<unknown>) | undefined;
  Object.defineProperty(navigator, "locks", { configurable: true, value: { request: (_name: string, _options: unknown, callback: (lock: unknown) => Promise<unknown>) => new Promise((resolve, reject) => { claim = async () => { try { const result = await callback({ name: "share-claim", mode: "exclusive" });resolve(result);return result; } catch (error) { reject(error instanceof Error ? error : new Error(String(error)));throw error; } }; }) } });
  try {
   fireEvent.click(button);await waitFor(() => expect(claim).toBeTypeOf("function"));f.change("403");
   await act(async () => { if (source === "shares") await f.query.refetchQueries({ queryKey: ["session", id, "shares"], exact: true });else await f.query.fetchQuery({ queryKey: ["session", id], queryFn: () => createTaskSessionApi(f.f.host).read(id), staleTime: 0, retry: false }).catch(() => undefined); });
   f.ui.unmount();const ui = renderUi(f.tree());await settle();await act(async () => { await claim!(); });await settle();
   expect(f.writes()).toHaveLength(0);ui.unmount();f.query.clear();
  } finally { Object.defineProperty(navigator, "locks", descriptor); }
 });
}
it("Low-1: a slow sharing refresh does not retain busy after a definitive DELETE", async () => {
 const f = setup(), remove = await press("remove");f.slow();
 // The authority read finishes; only the post-answer refresh is held.
 fireEvent.click(remove);await settle();
 expect(f.writes()).toHaveLength(1);expect(screen.getByRole<HTMLButtonElement>("button", { name: "Remove Olu" }).disabled).toBe(false);
 f.finish();f.ui.unmount();f.query.clear();
});

for (const operation of ["add", "remove"] as const) it(`R4-1/R6e ${operation}: a direct shared-session refusal inside the queued claim prevents dispatch`, async () => {
 const f = setup(), button = await press(operation), descriptor = Object.getOwnPropertyDescriptor(navigator, "locks")!;
 let claim: (() => Promise<unknown>) | undefined;
 Object.defineProperty(navigator, "locks", { configurable: true, value: { request: (_name: string, _options: unknown, callback: (lock: unknown) => Promise<unknown>) => new Promise((resolve, reject) => { claim = async () => { try { const result = await callback({ name: "share-claim", mode: "exclusive" });resolve(result);return result; } catch (error) { reject(error instanceof Error ? error : new Error(String(error)));throw error; } }; }) } });
 try {
  fireEvent.click(button);await waitFor(() => expect(claim).toBeTypeOf("function"));
  const sharesBasis = f.query.getQueryState(["session", id, "shares"]), sessionBasis = f.query.getQueryState(["session", id]);
  expect(sharesBasis?.status).toBe("success");expect(sessionBasis?.status).toBe("success");f.change("403");
  await act(async () => { await expect(createTaskSessionApi(f.f.host).read(id)).rejects.toMatchObject({ status: 403 }); });
  expect(sessionReadFailure(f.f.host, sessionScope({ companyId: me.org.orgId, personId: me.developer.id }, id))?.status).toBe(403);
  expect(f.query.getQueryState(["session", id])).toBe(sessionBasis);expect(f.query.getQueryState(["session", id, "shares"])).toBe(sharesBasis);
  await act(async () => { await claim!(); });await settle();
  expect(f.writes()).toHaveLength(0);expect((await screen.findAllByRole("alert")).length).toBeGreaterThan(0);
 } finally { Object.defineProperty(navigator, "locks", descriptor);f.ui.unmount();f.query.clear(); }
});
