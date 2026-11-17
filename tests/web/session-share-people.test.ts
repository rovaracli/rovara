// @vitest-environment jsdom
// D8: Share folds into People. For a task whose People list Code serves, the Share button opens the People panel to add a viewer; for any other task Share is
// exactly what it was (its dialog, its requests). The people a Share made readers of show in the People list as viewers, and are removed with the share removal.
import { describe, expect, it } from "vitest";
import { useState } from "react";
import { screen, fireEvent, waitFor, within } from "@testing-library/react";
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
  const f = fakeHost(async request => respond(request)), query = createQueryClient();
  const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(Screen, { people }) }) }));
  return { f, ui, query };
}

describe("Share and the People panel", () => {
  it("opens the People panel to add a viewer when Code serves the task's People list, and does not open the Share dialog", async () => {
    const { f } = mount(request => request.path.endsWith("/candidates") ? { status: 200, body: { candidates: [{ developerId: EVE, name: "Eve" }], complete: true } } : { status: 200, body: { people: view } });
    fireEvent.click(screen.getByRole("button", { name: "Share" }));
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
    fireEvent.click(screen.getByRole("button", { name: "Share" }));
    expect(await screen.findByText("Share this session")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add share" })).toBeTruthy();
    await waitFor(() => expect(calls(f)).toContain("GET " + SHARES));
    expect(screen.getByTestId<HTMLDetailsElement>("people-panel").open).toBe(false);
    expect(calls(f)[0]).toBe("GET " + PEOPLE);
  });

  it("makes no People request at all and opens the same dialog when the page gives the controls no People path", async () => {
    const { f } = mount(request => request.path === SHARES ? { status: 200, body: { shares: [] } } : request.path.endsWith("/org/members") ? { status: 200, body: { members: [] } } : refusal(404, "NOT_FOUND", "x"), false);
    fireEvent.click(screen.getByRole("button", { name: "Share" }));
    expect(await screen.findByText("Share this session")).toBeTruthy();
    expect(calls(f).some(call => call.includes("/people"))).toBe(false);
  });

  it("falls back to the Share dialog when the probe is refused any other way too (here Code answers 403)", async () => {
    mount(request => request.path === PEOPLE ? refusal(403, "FORBIDDEN", "no") : request.path === SHARES ? { status: 200, body: { shares: [] } } : request.path.endsWith("/org/members") ? { status: 200, body: { members: [] } } : refusal(404, "NOT_FOUND", "x"));
    fireEvent.click(screen.getByRole("button", { name: "Share" }));
    expect(await screen.findByText("Share this session")).toBeTruthy();
  });

  it("shows the people a Share made readers in the same list, as viewers, and removes one with the share removal", async () => {
    let shared = [{ developerId: DAN, name: "Dan", role: "viewer" }];
    const { f } = mount(request => {
      if (request.method === "DELETE") { shared = []; return { status: 200, body: { removed: true } }; }
      return request.path.endsWith("/candidates") ? { status: 200, body: { candidates: [], complete: true } } : { status: 200, body: { people: view, ...(shared.length === 0 ? {} : { sharedWith: shared }) } };
    });
    fireEvent.click(screen.getByRole("button", { name: "Share" }));
    const rows = await screen.findAllByTestId("people-row");
    expect(rows).toHaveLength(2);
    expect(rows[1]!.textContent).toBe("DanCan viewRemove");
    fireEvent.click(within(rows[1]!).getByRole("button", { name: "Remove Dan" }));
    await waitFor(() => expect(screen.getAllByTestId("people-row")).toHaveLength(1));
    const removal = f.request.mock.calls.map(([request]) => request).find(request => request.method === "DELETE")!;
    expect(removal.path).toBe(SHARES + "/MEMBER%23" + DAN);
  });

  it("shows a share removal's refusal in Code's words and keeps the viewer listed", async () => {
    const { f } = mount(request => request.method === "DELETE" ? refusal(403, "FORBIDDEN", "only the task's owner can share it")
      : request.path.endsWith("/candidates") ? { status: 200, body: { candidates: [], complete: true } } : { status: 200, body: { people: view, sharedWith: [{ developerId: DAN, name: "Dan", role: "viewer" }] } });
    fireEvent.click(screen.getByRole("button", { name: "Share" }));
    fireEvent.click(await screen.findByRole("button", { name: "Remove Dan" }));
    expect((await screen.findByRole("alert")).textContent).toBe("only the task's owner can share it");
    expect(screen.getAllByTestId("people-row")).toHaveLength(2);
    expect(calls(f).filter(call => call.startsWith("DELETE"))).toHaveLength(1);
  });

  it("offers no removal of a shared viewer to a person who may not manage People", async () => {
    mount(() => ({ status: 200, body: { people: { ...view, canManage: false }, sharedWith: [{ developerId: DAN, name: "Dan", role: "viewer" }] } }));
    fireEvent.click(screen.getByRole("button", { name: "Share" }));
    await screen.findAllByTestId("people-row");
    expect(screen.queryByRole("button", { name: "Remove Dan" })).toBeNull();
  });
});
