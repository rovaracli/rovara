// @vitest-environment jsdom
// Web task channel K3: the People panel on the session screen, against a fake host that answers as Cloud's /people routes do.
import { describe, expect, it } from "vitest";
import { screen, fireEvent, waitFor, act, within } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { PeoplePanel } from "../../packages/ui/src/screens/session/PeoplePanel.js";
import { AppHostProvider } from "../../packages/ui/src/host.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { renderUi } from "./support/render.js";
import { meFixture } from "./support/fixtures.js";
import { fakeHost } from "./support/fake-host.js";
import { h } from "./support/h.js";
import { SESSION_FIXTURE_ID } from "./support/session-fixture.js";

const ADA = "22222222-2222-4222-8222-222222222222", CAL = "11111111-1111-4111-8111-111111111111", DAN_DEV = "d".repeat(64);
const PEOPLE = `/v1/app/sessions/${SESSION_FIXTURE_ID}/people`;
const person = (personId: string, name: string, role: string, extra: Record<string, unknown> = {}) => ({ personId, name, role, you: false, effectiveRole: role === "owner" || role === "commenter" || role === "viewer" ? role : null, ...extra });
const viewOf = (over: Record<string, unknown> = {}) => ({ revision: 3, orphaned: false, canManage: true, canTakeOwnership: false, people: [person(ADA, "Ada", "owner", { you: true, method: "github" }), person(CAL, "Cal", "commenter", { method: "slack" })], ...over });
const refusal = (status: number, code: string, message: string) => ({ status, body: { error: { code, message } } });

function setup(handle: (request: { method: string; path: string; body?: unknown }) => { status: number; body: unknown }) {
  const f = fakeHost(async request => request.path === "/v1/app/me" ? { status: 200, body: meFixture() } : handle(request));
  const query = createQueryClient();
  const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(PeoplePanel, { id: SESSION_FIXTURE_ID }) }) }));
  const open = async () => { const panel = screen.getByTestId<HTMLDetailsElement>("people-panel"); await act(async () => { panel.open = true;panel.dispatchEvent(new Event("toggle")); }); };
  const sent = (method: string, suffix = "") => f.request.mock.calls.map(([request]) => request).filter(request => request.method === method && request.path === PEOPLE + suffix);
  return { f, query, ui, open, sent };
}

describe("People panel", () => {
  it("asks for nothing until it is opened, then lists who is on the task with their roles and how they sign in", async () => {
    const { f, open } = setup(request => request.path === PEOPLE ? { status: 200, body: { people: viewOf({ canManage: false }) } } : refusal(404, "NOT_FOUND", "x"));
    expect(f.request).not.toHaveBeenCalled();
    await open();
    const rows = await screen.findAllByTestId("people-row");
    expect(rows).toHaveLength(2);
    expect(rows[0]!.textContent).toContain("Ada (you) · GitHub");
    expect(rows[0]!.textContent).toContain("Owner");
    expect(rows[1]!.textContent).toContain("Cal · Slack");
    expect(rows[1]!.textContent).toContain("Can comment");
    // A reader who may not manage People sees no controls and asks for no candidates.
    expect(screen.queryByRole("button", { name: /^Remove/u })).toBeNull();
    expect(screen.queryByRole("group", { name: "Add a person" })).toBeNull();
    expect(f.request.mock.calls.map(([request]) => request.path)).toEqual([PEOPLE]);
  });

  it("changes a role with the revision the page read and a fresh request id, and shows the list Code answers", async () => {
    const { sent, open } = setup(request => request.method === "GET" ? { status: 200, body: request.path.endsWith("/candidates") ? { candidates: [], complete: true } : { people: viewOf() } }
      : { status: 200, body: { status: "COMMITTED", people: viewOf({ revision: 4, people: [person(ADA, "Ada", "owner", { you: true }), person(CAL, "Cal", "viewer")] }) } });
    await open();
    fireEvent.change(await screen.findByRole("combobox", { name: "Role for Cal" }), { target: { value: "viewer" } });
    expect(await screen.findByTestId("people-message")).toHaveProperty("textContent", "Done");
    const body = sent("POST", "/role")[0]!.body as Record<string, unknown>;
    expect(body).toMatchObject({ expectedPeopleRevision: 3, personId: CAL, role: "viewer" });
    expect(body["requestId"]).toMatch(/^[0-9a-f-]{36}$/u);
    expect(Object.keys(body).sort()).toEqual(["expectedPeopleRevision", "personId", "requestId", "role"]);
    expect((screen.getByRole<HTMLSelectElement>("combobox", { name: "Role for Cal" })).value).toBe("viewer");
  });

  it("removes a person by setting the role to removed", async () => {
    const { sent, open } = setup(request => request.method === "GET" ? { status: 200, body: request.path.endsWith("/candidates") ? { candidates: [], complete: true } : { people: viewOf() } }
      : { status: 200, body: { status: "COMMITTED", people: viewOf({ revision: 4, people: [person(ADA, "Ada", "owner", { you: true }), person(CAL, "Cal", "denied")] }) } });
    await open();
    fireEvent.click(await screen.findByRole("button", { name: "Remove Cal" }));
    await screen.findByText("Removed");
    expect(sent("POST", "/role")[0]!.body).toMatchObject({ personId: CAL, role: "denied", expectedPeopleRevision: 3 });
    expect(screen.queryByRole("button", { name: "Remove Cal" })).toBeNull();
  });

  it("adds a person from the candidates and retains its lock when only Code's list revision moves", async () => {
    let revision = 3;
    const confirmUrl = "https://code.example/review/6f9d0c1e-2b3a-4c5d-8e7f-001122334455/task/people/confirm/33333333-3333-4333-8333-333333333333";
    const { f, sent, open, query } = setup(request => {
      if (request.method === "POST") return { status: 202, body: { status: "PENDING", requestId: "33333333-3333-4333-8333-333333333333", confirmUrl, expiresAt: new Date(Date.now() + 600_000).toISOString() } };
      return { status: 200, body: request.path.endsWith("/candidates") ? { candidates: [{ developerId: DAN_DEV, name: "Dan" }], complete: true } : { people: viewOf({ revision }) } };
    });
    await open();
    fireEvent.change(await screen.findByRole("combobox", { name: "Person" }), { target: { value: DAN_DEV } });
    fireEvent.change(screen.getByRole("combobox", { name: "Add as" }), { target: { value: "viewer" } });
    fireEvent.click(screen.getByRole("button", { name: "Add person" }));
    const waiting = await screen.findByTestId("people-waiting");
    expect(waiting.textContent).toContain("Waiting for you to confirm this change in Rovara Code.");
    expect(sent("POST", "/add")[0]!.body).toMatchObject({ developerId: DAN_DEV, role: "viewer", expectedPeopleRevision: 3 });
    expect(Object.keys(sent("POST", "/add")[0]!.body as object).sort()).toEqual(["developerId", "expectedPeopleRevision", "requestId", "role"]);
    fireEvent.click(within(waiting).getByRole("button", { name: "Open confirmation" }));
    expect(f.host.openExternal).toHaveBeenCalledWith(confirmUrl);
    // Nothing else can be changed while one change waits.
    expect((screen.getByRole<HTMLButtonElement>("button", { name: "Add person" })).disabled).toBe(true);
    expect((screen.getByRole<HTMLSelectElement>("combobox", { name: "Role for Cal" })).disabled).toBe(true);
    revision = 4;
    await act(async () => { await query.invalidateQueries({ queryKey: ["session", SESSION_FIXTURE_ID, "people"] }); });
    // The served personId list cannot bind this Cloud developerId addition.
    await screen.findByTestId("people-waiting");
    expect(screen.queryByText("Done")).toBeNull();
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Add person" }).disabled).toBe(true);
    expect(sent("POST", "/add")).toHaveLength(1);
  });

  it("offers Open confirmation only for a safe https address, and lets the person stop waiting", async () => {
    const { open } = setup(request => request.method === "POST" ? { status: 202, body: { status: "PENDING", requestId: "33333333-3333-4333-8333-333333333333", confirmUrl: "http://evil.example/x", expiresAt: new Date(Date.now() + 600_000).toISOString() } }
      : { status: 200, body: request.path.endsWith("/candidates") ? { candidates: [], complete: true } : { people: viewOf() } });
    await open();
    fireEvent.click(await screen.findByRole("button", { name: "Remove Cal" }));
    const waiting = await screen.findByTestId("people-waiting");
    expect(within(waiting).queryByRole("button", { name: "Open confirmation" })).toBeNull();
    fireEvent.click(within(waiting).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByTestId("people-waiting")).toBeNull();
  });

  it("says a change was not confirmed in time when its proposal has ended", async () => {
    const { open } = setup(request => request.method === "POST" ? { status: 202, body: { status: "PENDING", requestId: "33333333-3333-4333-8333-333333333333", confirmUrl: "https://code.example/review/x/task/people/confirm/y", expiresAt: new Date(Date.now() - 1000).toISOString() } }
      : { status: 200, body: request.path.endsWith("/candidates") ? { candidates: [], complete: true } : { people: viewOf() } });
    await open();
    fireEvent.click(await screen.findByRole("button", { name: "Remove Cal" }));
    expect((await screen.findByTestId("people-message")).textContent).toBe("This change wasn't confirmed in time. Check before making another change.");
    expect(screen.queryByTestId("people-waiting")).toBeNull();
  });

  it("takes ownership only when Code says the person may, with the revision shown", async () => {
    const { sent, open } = setup(request => request.method === "POST" ? { status: 200, body: { status: "COMMITTED", people: viewOf({ canTakeOwnership: false, revision: 4 }) } }
      : { status: 200, body: { people: viewOf({ canManage: false, canTakeOwnership: true }) } });
    await open();
    fireEvent.click(await screen.findByRole("button", { name: "Take ownership" }));
    await screen.findByTestId("people-message");
    expect(sent("POST", "/take-ownership")[0]!.body).toMatchObject({ expectedPeopleRevision: 3 });
    expect(Object.keys(sent("POST", "/take-ownership")[0]!.body as object).sort()).toEqual(["expectedPeopleRevision", "requestId"]);
    expect(screen.queryByRole("button", { name: "Take ownership" })).toBeNull();
  });

  it("shows no take-ownership button when Code does not offer it", async () => {
    const { open } = setup(() => ({ status: 200, body: { people: viewOf({ canManage: false, canTakeOwnership: false }) } }));
    await open();
    await screen.findAllByTestId("people-row");
    expect(screen.queryByRole("button", { name: "Take ownership" })).toBeNull();
  });

  it("says adding is not available on this install when Code answers 404 or 501 for the candidates, and the list still works", async () => {
    for (const status of [404, 501]) {
      const { open, ui } = setup(request => request.path.endsWith("/candidates") ? refusal(status, status === 404 ? "NOT_FOUND" : "NOT_ON_CORE_ENGINE", "from code") : { status: 200, body: { people: viewOf() } });
      await open();
      expect((await screen.findByTestId("people-add-unavailable")).textContent).toBe("Adding people from the web isn't available on this install yet.");
      expect(screen.getAllByTestId("people-row")).toHaveLength(2);
      expect(screen.getByRole<HTMLSelectElement>("combobox", { name: "Role for Cal" })).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Add person" })).toBeNull();
      ui.unmount();
    }
  });

  it("says the same when Code does not serve the list at all, with nothing else in the panel", async () => {
    const { open, f } = setup(() => refusal(501, "NOT_ON_CORE_ENGINE", "This isn't on the core engine"));
    await open();
    expect((await screen.findByTestId("people-unavailable")).textContent).toBe("Adding people from the web isn't available on this install yet.");
    expect(screen.queryByTestId("people-row")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(f.request).toHaveBeenCalledTimes(1);
  });

  it("keeps an unaudited People conflict locked, shows Code's words and refreshes the list", async () => {
    let reads = 0;
    const { open, sent, f } = setup(request => request.method === "POST" ? refusal(409, "IDEMPOTENCY_CONFLICT", "Task access changed before the role could be saved")
      : request.path.endsWith("/candidates") ? { status: 200, body: { candidates: [], complete: true } } : (reads += 1, { status: 200, body: { people: viewOf({ revision: reads >= 3 ? 4 : 3 }) } }));
    await open();
    fireEvent.click(await screen.findByRole("button", { name: "Remove Cal" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Task access changed before the role could be saved");
    // Initial authority, send-time authority, then the refusal recovery read.
    await waitFor(() => expect(reads).toBe(3));
    await waitFor(() => expect(screen.getByRole<HTMLButtonElement>("button", { name: "Remove Cal" }).disabled).toBe(true));
    expect(screen.getByRole<HTMLSelectElement>("combobox", { name: "Role for Cal" }).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Remove Cal" }));
    expect(sent("POST", "/role")).toHaveLength(1);
    expect([...f.storage.values()].some(raw => raw.includes('"action":"role"'))).toBe(true);
    expect(screen.getAllByTestId("people-row")).toHaveLength(2);
  });

  it("shows an unaudited People access failure without clearing its durable lock", async () => {
    const { open } = setup(request => request.method === "POST" ? refusal(403, "TASK_ACCESS_DENIED", "Only a task owner can change who is on this task")
      : request.path.endsWith("/candidates") ? { status: 200, body: { candidates: [], complete: true } } : { status: 200, body: { people: viewOf() } });
    await open();
    fireEvent.click(await screen.findByRole("button", { name: "Remove Cal" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Only a task owner can change who is on this task");
    expect((screen.getByRole<HTMLButtonElement>("button", { name: "Remove Cal" })).disabled).toBe(true);
  });

  it("uses Slack-free wording and shows an unknown role or sign-in word as a neutral one", async () => {
    const { open } = setup(request => request.path.endsWith("/candidates") ? { status: 200, body: { candidates: [{ developerId: DAN_DEV, name: "Dan" }], complete: false } }
      : { status: 200, body: { people: viewOf({ canManage: false, people: [person(ADA, "Ada", "owner", { you: true, method: "passkey" }), person(CAL, "Cal", "superuser")] }) } });
    await open();
    const rows = await screen.findAllByTestId("people-row");
    expect(rows[0]!.textContent).toBe("Ada (you)Owner");
    expect(rows[1]!.textContent).toBe("CalAccess unavailable");
    expect(screen.getByTestId("people-panel").textContent).not.toMatch(/slack|channel|invite/iu);
  });

  it("shows Code's own words when the session or task is not found, not the not-available line", async () => {
    const { open } = setup(() => refusal(404, "SESSION_NOT_FOUND", "That session doesn't exist, or you can't see it."));
    await open();
    expect((await screen.findByRole("alert")).textContent).toContain("That session doesn't exist, or you can't see it.");
    expect(screen.queryByTestId("people-unavailable")).toBeNull();
  });
});

for (const operation of ["role", "remove", "add", "ownership"] as const) for (const code of ["CSRF_INVALID", "CSRF_STALE", "UNRECOGNISED"]) it(`R3/R6a People ${operation}: 500/${code} cannot unlock another write`, async () => {
 const { f, open, ui, query } = setup(request => request.method === "GET" ? { status: 200, body: request.path.endsWith("/candidates") ? { candidates: [{ developerId: DAN_DEV, name: "Dan" }], complete: true } : { people: viewOf({ canTakeOwnership: true, people: [person(ADA, "Ada", "viewer", { you: true }), person(CAL, "Cal", "commenter")] }) } } : refusal(500, code, "Unknown result"));
 await open();
 const label = operation === "role" ? "Role for Cal" : operation === "remove" ? "Remove Cal" : operation === "add" ? "Add person" : "Take ownership";
 const role = operation === "role" ? "combobox" : "button";
 const control = await screen.findByRole<HTMLButtonElement | HTMLSelectElement>(role, { name: label });
 if (operation === "add") fireEvent.change(await screen.findByRole("combobox", { name: "Person" }), { target: { value: DAN_DEV } });
 await waitFor(() => expect(control.disabled).toBe(false));
 if (operation === "role") fireEvent.change(control, { target: { value: "viewer" } });else fireEvent.click(control);
 await waitFor(() => expect(f.request.mock.calls.filter(([r]) => r.method === "POST")).toHaveLength(1));
 await screen.findByText(/Rovara didn't confirm this yet/);
 expect(control.disabled).toBe(true);
 fireEvent.click(screen.getByRole("button", { name: "Check" }));
 await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
 expect(control.disabled).toBe(true);expect(f.request.mock.calls.filter(([r]) => r.method === "POST")).toHaveLength(1);
 ui.unmount();query.clear();
});

it("announces the returned committed add and its returned person list", async () => {
 const dan = person("33333333-3333-4333-8333-333333333333", "Dan", "viewer");
 const { f, open, sent } = setup(request => request.method === "POST" ? { status: 200, body: { status: "COMMITTED", people: viewOf({ revision: 4, people: [...viewOf().people, dan] }) } } : { status: 200, body: request.path.endsWith("/candidates") ? { candidates: [{ developerId: DAN_DEV, name: "Dan" }], complete: true } : { people: viewOf() } });
 await open();fireEvent.change(await screen.findByRole("combobox", { name: "Person" }), { target: { value: DAN_DEV } });
 const button = screen.getByRole<HTMLButtonElement>("button", { name: "Add person" });await waitFor(() => expect(button.disabled).toBe(false));fireEvent.click(button);
 expect((await screen.findByTestId("people-message")).textContent).toBe("Done");
 expect(sent("POST", "/add")).toHaveLength(1);expect(f.request.mock.calls.filter(([r]) => r.method === "POST")).toHaveLength(1);
});
