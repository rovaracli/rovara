// @vitest-environment jsdom
import { expect, it } from "vitest";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { PeoplePanel } from "../../packages/ui/src/screens/session/PeoplePanel.js";
import { AppHostProvider, type ApiResponse } from "../../packages/ui/src/host.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { fakeHost } from "./support/fake-host.js";
import { meFixture } from "./support/fixtures.js";
import { h } from "./support/h.js";
import { renderUi } from "./support/render.js";
import { SESSION_FIXTURE_ID } from "./support/session-fixture.js";

const DAN = "d".repeat(64), EVE = "e".repeat(64);
const PEOPLE = `/v1/app/sessions/${SESSION_FIXTURE_ID}/people`, KEY = ["session", SESSION_FIXTURE_ID, "people"];
const view = { revision: 3, orphaned: false, canManage: true, canTakeOwnership: true, people: [
 { personId: "22222222-2222-4222-8222-222222222222", name: "Ada", role: "viewer", you: true, effectiveRole: "viewer" },
 { personId: "11111111-1111-4111-8111-111111111111", name: "Cal", role: "commenter", you: false, effectiveRole: "commenter" },
] };
const success = (people = view): ApiResponse => ({ status: 200, body: { people, sharedWith: [{ developerId: DAN, name: "Dan", role: "viewer" }] } });
const refused = (status = 403, code = "TASK_ACCESS_DENIED"): ApiResponse => ({ status, body: { error: { code, message: "People read refused" } } });
function mount(read: () => ApiResponse | Promise<ApiResponse>) {
 const f = fakeHost(async request => request.path === "/v1/app/me" ? { status: 200, body: meFixture() }
  : request.method !== "GET" ? { status: 403, body: { error: { code: "FORBIDDEN", message: "Write refused" } } }
  : request.path === PEOPLE ? read() : { status: 200, body: { candidates: [{ developerId: EVE, name: "Eve" }], complete: true } });
 const query = createQueryClient();
 const tree = () => h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(PeoplePanel, { id: SESSION_FIXTURE_ID }) }) });
 const ui = renderUi(tree());
 const open = async () => { await act(async () => { const panel = screen.getByTestId<HTMLDetailsElement>("people-panel");panel.open = true;panel.dispatchEvent(new Event("toggle")); }); };
 const writes = () => f.request.mock.calls.map(([request]) => request).filter(request => request.method !== "GET");
 return { f, query, ui, tree, open, writes };
}
const settled = async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); }); };
const enabledRemove = async () => {
 const remove = await screen.findByRole<HTMLButtonElement>("button", { name: "Remove Dan" });
 await waitFor(() => expect(remove.disabled).toBe(false));return remove;
};

// Mutant: skipping the shared access-code wipe leaks private names after refusal/remount.
function expectPeopleWiped() {
 for (const name of ["Ada", "Cal", "Dan", "Eve"]) expect(screen.queryByText(name, { exact: false })).toBeNull();
 expect(screen.queryByRole("button", { name: /^Remove /u })).toBeNull();
 expect(screen.queryByRole("combobox", { name: /^Role for /u })).toBeNull();
 expect(screen.queryByRole("button", { name: "Take ownership" })).toBeNull();
 expect(screen.queryByRole("button", { name: "Add person" })).toBeNull();
 expect(screen.queryByRole("combobox", { name: "Person" })).toBeNull();
 expect(screen.queryByText(/Reconnecting/u)).toBeNull();
}
const accessFailures = [
 ...[401, 403, 404].map(status => ({ status, code: "REQUEST_FAILED" })),
 ...[200, 503].map(status => ({ status, code: "TASK_ACCESS_DENIED" })),
];
it.each(accessFailures)("F4/R1: access refusal $status/$code wipes People and sends zero DELETEs after remount", async ({ status, code }) => {
 let failed = false;
 const { query, open, writes, ui, tree } = mount(() => failed ? refused(status, code) : success());
 await open();const remove = await enabledRemove();
 fireEvent.change(screen.getByRole("combobox", { name: "Person" }), { target: { value: EVE } });
 failed = true;
 await act(async () => { await query.refetchQueries({ queryKey: KEY, exact: true }); });
 await waitFor(() => expect(query.getQueryState(KEY)?.status).toBe("error"));
 if (status === 404) expect(screen.getByTestId("people-unavailable")).toBeTruthy();
 else expect((await screen.findByRole("alert")).textContent).toContain("People read refused");
 expect(query.getQueryState(KEY)?.status).toBe("error");
 expectPeopleWiped();expect(query.getQueryData(KEY)).toBeUndefined();
 fireEvent.click(remove);await settled();expect(writes()).toEqual([]);
 expect(writes().filter(request => request.method === "DELETE")).toHaveLength(0);
 ui.unmount();const remounted = renderUi(tree());await open();
 await waitFor(() => expect(query.getQueryState(KEY)?.status).toBe("error"));
 expectPeopleWiped();expect(query.getQueryData(KEY)).toBeUndefined();
 fireEvent.click(remove);await settled();expect(writes()).toEqual([]);
 expect(writes().filter(request => request.method === "DELETE")).toHaveLength(0);
 remounted.unmount();query.clear();
});

// Mutant: retained 503 data must never grant destructive authority.
it("F4/R1: pure 503 keeps People with one reconnecting line, disables every destructive control and sends zero DELETEs", async () => {
 let failed = false;
 const { query, open, writes } = mount(() => failed ? refused(503, "SERVICE_UNAVAILABLE") : success());
 await open();await enabledRemove();
 fireEvent.change(screen.getByRole("combobox", { name: "Person" }), { target: { value: EVE } });
 const lastRead = query.getQueryState(KEY)!.dataUpdatedAt;
 failed = true;
 await act(async () => { await query.refetchQueries({ queryKey: KEY, exact: true }); });
 expect(query.getQueryState(KEY)?.status).toBe("error");
 expect(query.getQueryState(KEY)?.dataUpdatedAt).toBe(lastRead);
 expect(query.getQueryData(KEY)).toEqual(success().body);
 expect(await screen.findAllByText(/^Updated \d{2}:\d{2} · Reconnecting$/u)).toHaveLength(1);
 expect(screen.queryByRole("alert")).toBeNull();
 const removes = screen.getAllByRole<HTMLButtonElement>("button", { name: /^Remove /u });
 expect(removes.map(button => button.getAttribute("aria-label"))).toEqual(["Remove Ada", "Remove Cal", "Remove Dan"]);
 for (const button of [...removes, screen.getByRole<HTMLButtonElement>("button", { name: "Take ownership" }), screen.getByRole<HTMLButtonElement>("button", { name: "Add person" })]) {
  expect(button.disabled).toBe(true);fireEvent.click(button);
 }
 const roles = screen.getAllByRole<HTMLSelectElement>("combobox");
 expect(roles).toHaveLength(4);
 for (const label of ["Role for Ada", "Role for Cal", "Person", "Add as"]) expect(screen.getByRole<HTMLSelectElement>("combobox", { name: label }).disabled).toBe(true);
 for (const select of roles) expect(select.disabled).toBe(true);
 await settled();expect(writes()).toEqual([]);
 expect(writes().filter(request => request.method === "DELETE")).toHaveLength(0);
 query.clear();
});

// Mutant: omitting the send-time authority read dispatches DELETE using the old list.
it.each(["refused", "cannot manage", "revision changed"])("F4/R6c: shared-reader removal rechecks People at send time (%s)", async change => {
 let changed = false;
 const { f, open, writes } = mount(() => !changed ? success() : change === "refused" ? refused() : success({ ...view, ...(change === "cannot manage" ? { canManage: false } : { revision: 4 }) }));
 await open();const remove = await enabledRemove();changed = true;
 fireEvent.click(remove);
 await screen.findAllByRole("alert");await settled();
 expect(writes()).toEqual([]);
 expect(f.request.mock.calls.filter(([request]) => request.path === PEOPLE)).toHaveLength(2);
});

it("F4: a current successful People read still permits the exact shared-reader DELETE", async () => {
 const { f, open, writes } = mount(() => success());
 await open();fireEvent.click(await enabledRemove());
 await screen.findAllByRole("alert");
 expect(writes()).toHaveLength(1);
 expect(writes()[0]).toMatchObject({ method: "DELETE", path: `/v1/app/sessions/${SESSION_FIXTURE_ID}/shares/MEMBER%23${DAN}` });
 const requests = f.request.mock.calls.map(([request]) => request);
 const index = requests.findIndex(request => request.method === "DELETE");
 expect(requests[index - 1]).toMatchObject({ method: "GET", path: PEOPLE });
});

it("F4/R6b: an older successful precheck cannot override a newer refused People refresh", async () => {
 let reads = 0, finish: ((answer: ApiResponse) => void) | undefined;
 const { query, open, writes } = mount(() => ++reads === 1 ? success() : reads === 2 ? new Promise(resolve => { finish = resolve; }) : refused());
 await open();fireEvent.click(await enabledRemove());
 await waitFor(() => expect(finish).toBeTypeOf("function"));
 await act(async () => { await query.refetchQueries({ queryKey: KEY, exact: true }); });
 await screen.findAllByRole("alert");
 await act(async () => { finish!(success()); });await settled();
 expect(query.getQueryState(KEY)?.status).toBe("error");expect(writes()).toEqual([]);
 expectPeopleWiped();
 expect(writes().filter(request => request.method === "DELETE")).toHaveLength(0);
});

it("F4/R6c: a newer refusal during the exclusive claim blocks DELETE even after remount", async () => {
 let failed = false, claim: (() => Promise<unknown>) | undefined;
 const { query, open, writes, ui, tree } = mount(() => failed ? refused() : success());
 await open();const remove = await enabledRemove();
 const saved = Object.getOwnPropertyDescriptor(navigator, "locks")!;
 Object.defineProperty(navigator, "locks", { configurable: true, value: {
  request: (_name: string, _options: unknown, callback: (lock: unknown) => Promise<unknown>) => new Promise<unknown>((resolve, reject) => {
   claim = async () => { try { const answer = await callback({ name: "people-claim", mode: "exclusive" });resolve(answer);return answer; } catch (error) { reject(error instanceof Error ? error : new Error(String(error)));throw error; } };
  }),
 } });
 try {
  fireEvent.click(remove);await waitFor(() => expect(claim).toBeTypeOf("function"));
  failed = true;await act(async () => { await query.refetchQueries({ queryKey: KEY, exact: true }); });
  await screen.findByRole("alert");expectPeopleWiped();expect(writes()).toEqual([]);ui.unmount();
  const remounted = renderUi(tree());await open();await screen.findByRole("alert");
  await act(async () => { await claim!(); });await settled();
  expect(writes()).toEqual([]);
  expectPeopleWiped();
  expect(writes().filter(request => request.method === "DELETE")).toHaveLength(0);
  remounted.unmount();query.clear();
 } finally { Object.defineProperty(navigator, "locks", saved); }
});
