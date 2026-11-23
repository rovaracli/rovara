// @vitest-environment jsdom
// D8: Share folds into People. For a task whose People list Code serves, the Share button opens the People panel to add a viewer; for any other task Share is
// exactly what it was (its dialog, its requests). The people a Share made readers of show in the People list as viewers, and are removed with the share removal.
import { meFixture } from "./support/fixtures.js";
import { describe, expect, it } from "vitest";
import { useState } from "react";
import { act, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { PeoplePanel } from "../../packages/ui/src/screens/session/PeoplePanel.js";
import { SessionControls } from "../../packages/ui/src/screens/session/SessionControls.js";
import { AppHostProvider } from "../../packages/ui/src/host.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { renderUi } from "./support/render.js";
import { fakeHost } from "./support/fake-host.js";
import { h } from "./support/h.js";
import { SESSION_FIXTURE_ID } from "./support/session-fixture.js";
import type { ApiRequest, ApiResponse } from "../../packages/ui/src/host.js";

const ADA = "22222222-2222-4222-8222-222222222222", DAN = "d".repeat(64), EVE = "e".repeat(64);
const PEOPLE = `/v1/app/sessions/${SESSION_FIXTURE_ID}/people`, SHARES = `/v1/app/sessions/${SESSION_FIXTURE_ID}/shares`;
const view = { revision: 3, orphaned: false, canManage: true, canTakeOwnership: false, people: [{ personId: ADA, name: "Ada", role: "owner", you: true, effectiveRole: "owner" }] };
const refusal = (status: number, code: string, message: string): ApiResponse => ({ status, body: { error: { code, message } } });
const calls = (f: { request: { mock: { calls: Array<[ApiRequest]> } } }) => f.request.mock.calls.map(([request]) => request.method + " " + request.path);

/** The controls and the panel side by side, as the session screen wires them (Share asks the panel to open). */
function Screen({ people }: { people: boolean }) {
  const [request, setRequest] = useState(0);
  return h("main", {}, h(SessionControls, { id: SESSION_FIXTURE_ID, agent: "Payments expert", actions: ["watch", "share"], following: false, onChanged: async () => undefined, share: { orgName: "Acme" }, ...(people ? { onPeopleShare: () => { setRequest(count => count + 1); } } : {}) }),
    h(PeoplePanel, { id: SESSION_FIXTURE_ID, shareRequest: request }));
}
function mount(respond: (request: ApiRequest) => ApiResponse, people = true) {
  const f = fakeHost(async request => request.path === "/v1/app/me" ? { status: 200, body: meFixture() } : respond(request)), query = createQueryClient();
  const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(Screen, { people }) }) }));
  return { f, ui, query };
}

describe("Share and the People panel", () => {
  it("opens the People panel to add a viewer when Code serves the task's People list, and does not open the Share dialog", async () => {
    const { f } = mount(request => request.path.endsWith("/candidates") ? { status: 200, body: { candidates: [{ developerId: EVE, name: "Eve" }], complete: true } } : { status: 200, body: { people: view } });
    await waitFor(() => expect(screen.getByRole<HTMLButtonElement>("button", { name: "Share" }).disabled).toBe(false));fireEvent.click(screen.getByRole("button", { name: "Share" }));
    const panel = screen.getByTestId<HTMLDetailsElement>("people-panel");
    await waitFor(() => expect(panel.open).toBe(true));
    const person = await screen.findByRole<HTMLSelectElement>("combobox", { name: "Person" });
    expect(screen.getByRole<HTMLSelectElement>("combobox", { name: "Add as" }).value).toBe("viewer");
    await waitFor(() => expect(document.activeElement).toBe(person));
    expect(screen.queryByText("Share this session")).toBeNull();
    expect(calls(f).some(call => call.endsWith("/shares"))).toBe(false);
  });

  it("keeps Share exactly as it was for a task whose People list Code does not serve (golden): its dialog opens and reads the shares", async () => {
    const { f } = mount(request => request.path === PEOPLE ? refusal(404, "NOT_FOUND", "route not found")
      : request.path === SHARES ? { status: 200, body: { shares: [] } } : request.path.endsWith("/org/members") ? { status: 200, body: { members: [] } } : refusal(404, "NOT_FOUND", "x"));
    await waitFor(() => expect(screen.getByRole<HTMLButtonElement>("button", { name: "Share" }).disabled).toBe(false));fireEvent.click(screen.getByRole("button", { name: "Share" }));
    expect(await screen.findByText("Share this session")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add share" })).toBeTruthy();
    await waitFor(() => expect(calls(f)).toContain("GET " + SHARES));
    expect(screen.getByTestId<HTMLDetailsElement>("people-panel").open).toBe(false);
    expect(calls(f).filter(call => call !== "GET /v1/app/me")[0]).toBe("GET " + PEOPLE);
  });

  it("makes no People request at all and opens the same dialog when the page gives the controls no People path", async () => {
    const { f } = mount(request => request.path === SHARES ? { status: 200, body: { shares: [] } } : request.path.endsWith("/org/members") ? { status: 200, body: { members: [] } } : refusal(404, "NOT_FOUND", "x"), false);
    await waitFor(() => expect(screen.getByRole<HTMLButtonElement>("button", { name: "Share" }).disabled).toBe(false));fireEvent.click(screen.getByRole("button", { name: "Share" }));
    expect(await screen.findByText("Share this session")).toBeTruthy();
    expect(calls(f).some(call => call.includes("/people"))).toBe(false);
  });

  it("falls back to the Share dialog when the probe is refused any other way too (here Code answers 403)", async () => {
    mount(request => request.path === PEOPLE ? refusal(403, "FORBIDDEN", "no") : request.path === SHARES ? { status: 200, body: { shares: [] } } : request.path.endsWith("/org/members") ? { status: 200, body: { members: [] } } : refusal(404, "NOT_FOUND", "x"));
    await waitFor(() => expect(screen.getByRole<HTMLButtonElement>("button", { name: "Share" }).disabled).toBe(false));fireEvent.click(screen.getByRole("button", { name: "Share" }));
    expect(await screen.findByText("Share this session")).toBeTruthy();
  });

  it("shows the people a Share made readers in the same list, as viewers, and removes one with the share removal", async () => {
    let shared = [{ developerId: DAN, name: "Dan", role: "viewer" }];
    const { f } = mount(request => {
      if (request.method === "DELETE") { shared = []; return { status: 200, body: { removed: true } }; }
      return request.path.endsWith("/candidates") ? { status: 200, body: { candidates: [], complete: true } } : { status: 200, body: { people: view, ...(shared.length === 0 ? {} : { sharedWith: shared }) } };
    });
    await waitFor(() => expect(screen.getByRole<HTMLButtonElement>("button", { name: "Share" }).disabled).toBe(false));fireEvent.click(screen.getByRole("button", { name: "Share" }));
    const rows = await screen.findAllByTestId("people-row");
    expect(rows).toHaveLength(2);
    expect(rows[1]!.textContent).toBe("DanCan viewRemove");
    fireEvent.click(within(rows[1]!).getByRole("button", { name: "Remove Dan" }));
    await waitFor(() => expect(screen.getAllByTestId("people-row")).toHaveLength(1));
    const removal = f.request.mock.calls.map(([request]) => request).find(request => request.method === "DELETE")!;
    expect(removal.path).toBe(SHARES + "/MEMBER%23" + DAN);
  });

  it("shows a share removal's refusal in plain words (never Code's text) and keeps the viewer listed", async () => {
    const { f } = mount(request => request.method === "DELETE" ? refusal(403, "FORBIDDEN", "only the task's owner can share it")
      : request.path.endsWith("/candidates") ? { status: 200, body: { candidates: [], complete: true } } : { status: 200, body: { people: view, sharedWith: [{ developerId: DAN, name: "Dan", role: "viewer" }] } });
    await waitFor(() => expect(screen.getByRole<HTMLButtonElement>("button", { name: "Share" }).disabled).toBe(false));fireEvent.click(screen.getByRole("button", { name: "Share" }));
    fireEvent.click(await screen.findByRole("button", { name: "Remove Dan" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Rovara couldn't confirm you can remove this person.");
    expect(screen.queryByText(/only the task's owner/u)).toBeNull();
    expect(screen.getAllByTestId("people-row")).toHaveLength(2);
    expect(calls(f).filter(call => call.startsWith("DELETE"))).toHaveLength(1);
  });

  it("offers no removal of a shared viewer to a person who may not manage People", async () => {
    mount(() => ({ status: 200, body: { people: { ...view, canManage: false }, sharedWith: [{ developerId: DAN, name: "Dan", role: "viewer" }] } }));
    await waitFor(() => expect(screen.getByRole<HTMLButtonElement>("button", { name: "Share" }).disabled).toBe(false));fireEvent.click(screen.getByRole("button", { name: "Share" }));
    await screen.findAllByTestId("people-row");
    expect(screen.queryByRole("button", { name: "Remove Dan" })).toBeNull();
  });

  it("keeps the shared viewers listed after a change commits (the answer to a change carries only the People list)", async () => {
    const shared = [{ developerId: DAN, name: "Dan", role: "viewer" }];
    mount(request => {
      if (request.method === "POST") return { status: 200, body: { status: "COMMITTED", people: { ...view, revision: 4, people: [...view.people, { personId: "11111111-1111-4111-8111-111111111111", name: "Eve", role: "viewer", you: false, effectiveRole: "viewer" }] } } };
      if (request.path.endsWith("/candidates")) return { status: 200, body: { candidates: [{ developerId: EVE, name: "Eve" }], complete: true } };
      return { status: 200, body: { people: view, sharedWith: shared } };
    });
    await waitFor(() => expect(screen.getByRole<HTMLButtonElement>("button", { name: "Share" }).disabled).toBe(false));fireEvent.click(screen.getByRole("button", { name: "Share" }));
    fireEvent.change(await screen.findByRole("combobox", { name: "Person" }), { target: { value: EVE } });
    fireEvent.click(screen.getByRole("button", { name: "Add person" }));
    await screen.findByTestId("people-message");
    const names = screen.getAllByTestId("people-row").map(row => row.textContent);
    expect(names.some(text => text?.startsWith("Dan"))).toBe(true);
    expect(names.some(text => text?.startsWith("Eve"))).toBe(true);
  });
});

it.each(["CSRF_INVALID", "CSRF_STALE", "UNRECOGNISED"])("R3/R6a People share removal: 500/%s retains its exact target and only reads on Check", async code => {
 const { f, ui, query } = mount(request => request.method === "DELETE" ? refusal(500, code, "Unknown result") : request.path.endsWith("/candidates") ? { status: 200, body: { candidates: [], complete: true } } : request.path === SHARES ? { status: 200, body: { shares: [{ principal: { kind: "member", developerId: DAN }, level: "view", sharedBy: { developerId: meFixture().developer.id, name: "Ada" }, sharedAt: "2026-11-20T12:00:00.000Z" }] } } : { status: 200, body: { people: view, sharedWith: [{ developerId: DAN, name: "Dan", role: "viewer" }] } });
 const share = await screen.findByRole<HTMLButtonElement>("button", { name: "Share" });await waitFor(() => expect(share.disabled).toBe(false));fireEvent.click(share);
 const remove = await screen.findByRole<HTMLButtonElement>("button", { name: "Remove Dan" });await waitFor(() => expect(remove.disabled).toBe(false));fireEvent.click(remove);
 const deletes = () => f.request.mock.calls.filter(([r]) => r.method === "DELETE");await waitFor(() => expect(deletes()).toHaveLength(1));
 await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });expect(remove.disabled).toBe(true);
 expect(deletes()[0]![0].path).toBe(SHARES + "/MEMBER%23" + DAN);
 fireEvent.click(screen.getByRole("button", { name: "Check" }));await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
 expect(remove.disabled).toBe(true);expect(deletes()).toHaveLength(1);ui.unmount();query.clear();
});
