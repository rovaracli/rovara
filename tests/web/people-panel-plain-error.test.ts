// @vitest-environment jsdom
// PEOPLE-PANEL-PLAIN-ERROR: the People panel never shows the server's own error text. Each failure has one fixed plain sentence, and the server's machine code is only a "Ref" detail.
import { describe, expect, it } from "vitest";
import { screen, fireEvent, act } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { PeoplePanel } from "../../packages/ui/src/screens/session/PeoplePanel.js";
import { panelError, peopleFailure } from "../../packages/ui/src/screens/session/people-failure.js";
import { ApiError } from "../../packages/ui/src/api/errors.js";
import { AppHostProvider } from "../../packages/ui/src/host.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { renderUi } from "./support/render.js";
import { meFixture } from "./support/fixtures.js";
import { fakeHost } from "./support/fake-host.js";
import { h } from "./support/h.js";
import { SESSION_FIXTURE_ID } from "./support/session-fixture.js";

const ADA = "22222222-2222-4222-8222-222222222222", CAL = "11111111-1111-4111-8111-111111111111";
const RAW = "task person identity could not be verified";
const person = (personId: string, name: string, role: string, extra: Record<string, unknown> = {}) => ({ personId, name, role, you: false, effectiveRole: role, ...extra });
const view = { revision: 3, orphaned: false, canManage: true, canTakeOwnership: false, people: [person(ADA, "Ada", "owner", { you: true }), person(CAL, "Cal", "commenter")] };
type Answer = { status: number; body: unknown } | "network";
const refusal = (status: number, code: string, message = RAW): Answer => ({ status, body: { error: { code, message } } });

function setup(read: () => Answer, write?: () => Answer) {
  const f = fakeHost(async request => {
    if (request.path === "/v1/app/me") return { status: 200, body: meFixture() };
    const answer = request.method === "GET" ? (request.path.endsWith("/candidates") ? { status: 200, body: { candidates: [], complete: true } } : read()) : write?.() ?? { status: 200, body: {} };
    if (answer === "network") throw new TypeError("Failed to fetch " + RAW);
    return answer;
  });
  const query = createQueryClient();
  renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(PeoplePanel, { id: SESSION_FIXTURE_ID }) }) }));
  const open = async () => { const panel = screen.getByTestId<HTMLDetailsElement>("people-panel"); await act(async () => { panel.open = true;panel.dispatchEvent(new Event("toggle")); }); };
  return { f, open };
}
const panelText = () => screen.getByTestId("people-panel").textContent ?? "";

describe("People panel: a failed read is said in plain words", () => {
  const cases: Array<{ name: string; answer: Answer; sentence: string; ref?: string }> = [
    { name: "403 PROJECT_ACCESS_DENIED (the live owner case)", answer: refusal(403, "PROJECT_ACCESS_DENIED"), sentence: "Rovara couldn't confirm your access to this task's people.", ref: "PROJECT_ACCESS_DENIED" },
    { name: "403 TASK_ACCESS_DENIED", answer: refusal(403, "TASK_ACCESS_DENIED"), sentence: "Rovara couldn't confirm your access to this task's people.", ref: "TASK_ACCESS_DENIED" },
    { name: "401 AUTH_REQUIRED", answer: refusal(401, "AUTH_REQUIRED"), sentence: "Sign in again to see who is on this task.", ref: "AUTH_REQUIRED" },
    { name: "404 TASK_NOT_FOUND", answer: refusal(404, "TASK_NOT_FOUND"), sentence: "This task wasn't found, or you no longer have access.", ref: "TASK_NOT_FOUND" },
    { name: "500", answer: refusal(500, "INTERNAL_ERROR"), sentence: "Couldn't load who is on this task. Try again in a moment.", ref: "INTERNAL_ERROR" },
    { name: "503", answer: refusal(503, "SERVICE_UNAVAILABLE"), sentence: "Couldn't load who is on this task. Try again in a moment.", ref: "SERVICE_UNAVAILABLE" },
    // The client retries a dropped connection, then raises its own NETWORK_ERROR (status 0).
    { name: "network failure", answer: "network", sentence: "Couldn't reach Rovara. Check your connection and try again." },
  ];
  it.each(cases)("$name", async ({ answer, sentence, ref }) => {
    const { open } = setup(() => answer);
    await open();
    const alert = await screen.findByRole("alert", {}, { timeout: 12_000 });
    expect(alert.textContent).toBe(sentence + "Try again");
    if (ref === undefined) expect(screen.queryByTestId("people-failure-ref")).toBeNull(); else expect(screen.getByTestId("people-failure-ref").textContent).toBe("Ref " + ref);
    // The server's words, and a network error's words, are never on screen.
    expect(panelText()).not.toContain(RAW);
    expect(panelText()).not.toMatch(/could not be verified|Failed to fetch/u);
    // The panel never claims the task state: it only knows its own read failed.
    expect(panelText()).not.toMatch(/still running|Nothing was changed/u);
  }, 20_000);

  it("keeps the Try again button, which reads again", async () => {
    let reads = 0;
    const { open } = setup(() => { reads += 1;return reads === 1 ? refusal(403, "PROJECT_ACCESS_DENIED") : { status: 200, body: { people: view } }; });
    await open();
    fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
    expect(await screen.findAllByTestId("people-row")).toHaveLength(2);
  });

  it("says the candidates failure in plain words too", async () => {
    const f = fakeHost(async request => request.path === "/v1/app/me" ? { status: 200, body: meFixture() } : request.path.endsWith("/candidates") ? refusal(403, "PROJECT_ACCESS_DENIED") as { status: number; body: unknown } : { status: 200, body: { people: view } });
    const query = createQueryClient();
    renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(PeoplePanel, { id: SESSION_FIXTURE_ID }) }) }));
    await act(async () => { const panel = screen.getByTestId<HTMLDetailsElement>("people-panel");panel.open = true;panel.dispatchEvent(new Event("toggle")); });
    const alerts = await screen.findAllByRole("alert");
    expect(alerts.map(alert => alert.textContent)).toContain("Rovara couldn't confirm your access to this task's people.");
    expect(panelText()).not.toContain(RAW);
  });
});

describe("People panel: a failed write is said in plain words", () => {
  const cases: Array<{ name: string; answer: Answer; sentence: string }> = [
    { name: "403", answer: refusal(403, "PROJECT_ACCESS_DENIED"), sentence: "Rovara couldn't confirm you can change who is on this task." },
    { name: "401", answer: refusal(401, "AUTH_REQUIRED"), sentence: "Sign in again to change who is on this task." },
    { name: "404", answer: refusal(404, "TASK_NOT_FOUND"), sentence: "This task wasn't found, or you no longer have access." },
    { name: "409", answer: refusal(409, "IDEMPOTENCY_CONFLICT"), sentence: "Who is on this task changed. Check the list, then try again." },
  ];
  it.each(cases)("$name", async ({ answer, sentence }) => {
    const { f, open } = setup(() => ({ status: 200, body: { people: view } }), () => answer);
    await open();
    fireEvent.click(await screen.findByRole("button", { name: "Remove Cal" }));
    expect((await screen.findByRole("alert")).textContent).toBe(sentence);
    expect(panelText()).not.toContain(RAW);
    // The write was sent once; nothing here changes what is sent or when.
    expect(f.request.mock.calls.map(([request]) => request).filter(request => request.method === "POST")).toHaveLength(1);
  });
});

describe("peopleFailure", () => {
  it("shows only the fixed sentence, never the error's own message", () => {
    for (const status of [400, 401, 403, 404, 409, 422, 429, 500, 502, 503, 504]) {
      for (const kind of ["read", "candidates", "write", "remove"] as const) expect(peopleFailure(new ApiError(status, "SOME_CODE", RAW), kind).text).not.toContain(RAW);
    }
    expect(peopleFailure(new Error(RAW), "read").text).not.toContain(RAW);
    expect(peopleFailure(new ApiError(0, "NETWORK_ERROR", RAW), "read").text).toBe("Couldn't reach Rovara. Check your connection and try again.");
    expect(peopleFailure(undefined, "write").text).toBe("Couldn't change who is on this task. Try again.");
  });
  it("reads only the words the panel wrote itself (a stale list, a change waiting for confirmation)", () => {
    expect(peopleFailure(panelError(403, "FORBIDDEN", "These people or your permissions changed. Check the current list."), "write").text).toBe("These people or your permissions changed. Check the current list.");
    expect(peopleFailure(new ApiError(403, "FORBIDDEN", "These people or your permissions changed. Check the current list."), "write").text).not.toContain("permissions changed");
  });
  it("keeps only a well-formed machine code as the Ref", () => {
    expect(peopleFailure(new ApiError(403, "PROJECT_ACCESS_DENIED", RAW), "read").ref).toBe("PROJECT_ACCESS_DENIED");
    expect(peopleFailure(new ApiError(500, "not a code", RAW), "read").ref).toBeUndefined();
    // The client's stand-in for an unreadable body is noise for support.
    expect(peopleFailure(new ApiError(500, "REQUEST_FAILED", "Rovara couldn't complete this request. Try again shortly."), "read").ref).toBeUndefined();
  });
  // Mutant: treating every status-0 error as the network failure (or dropping the NETWORK_ERROR check) gives these the "connection" sentence.
  const clientCodes = ["REQUEST_UNCONFIRMED", "PERSISTENCE_UNAVAILABLE", "ACTION_CLAIM_UNAVAILABLE", "READ_REQUIRED", "READ_SUPERSEDED", "READ_FAILED", "IDENTITY_CHANGED"];
  it.each(clientCodes)("%s (the action layer, status 0) is not a connection problem and keeps its own truthful sentence", code => {
    for (const kind of ["write", "remove"] as const) {
      const failure = peopleFailure(new ApiError(0, code, "Rovara didn't confirm this yet. Check before acting again. " + RAW), kind);
      expect(failure.text).not.toMatch(/connection|reach Rovara/iu);
      expect(failure.text).not.toContain(RAW);
      expect(failure.ref).toBe(code);
    }
    const unknownOutcome = ["REQUEST_UNCONFIRMED", "PERSISTENCE_UNAVAILABLE"].includes(code);
    const text = peopleFailure(new ApiError(0, code, RAW), "write").text;
    expect(/Check /u.test(text)).toBe(true);
    // A write whose outcome is unknown says to check before acting again, never to try again.
    if (unknownOutcome) expect(text).not.toMatch(/try again/iu);
  });
  it("uses the connection sentence only for NETWORK_ERROR, and a status-0 code it does not know gets the neutral line", () => {
    expect(peopleFailure(new ApiError(0, "NETWORK_ERROR", RAW), "read").text).toBe("Couldn't reach Rovara. Check your connection and try again.");
    expect(peopleFailure(new ApiError(0, "NETWORK_ERROR", RAW), "candidates").text).toBe("Couldn't reach Rovara. Check your connection and try again.");
    // On a write a dropped connection means the outcome is unknown: check, never "try again".
    for (const kind of ["write", "remove"] as const) {
      const text = peopleFailure(new ApiError(0, "NETWORK_ERROR", RAW), kind).text;
      expect(text).toMatch(/^Rovara didn't confirm this change yet\. Check who is on this task/u);
      expect(text).not.toMatch(/try again|connection/iu);
    }
    expect(peopleFailure(new ApiError(0, "SOMETHING_ELSE", RAW), "write").text).toBe("Couldn't change who is on this task. Try again.");
  });
});

describe("People panel: an action-layer failure and the panel's own words reach the screen", () => {
  it("a write whose answer never arrives says to check before acting again, never that the connection failed", async () => {
    const { f, open } = setup(() => ({ status: 200, body: { people: view } }), () => "network");
    await open();
    fireEvent.click(await screen.findByRole("button", { name: "Remove Cal" }));
    await screen.findAllByRole("alert", {}, { timeout: 5_000 });
    expect(panelText()).not.toContain(RAW);
    expect(panelText()).not.toMatch(/reach Rovara|your connection/iu);
    expect(f.request.mock.calls.map(([request]) => request).filter(request => request.method === "POST")).toHaveLength(1);
  });
  it("a refused send-time authority read shows the panel's own sentence, not a 403 'couldn't confirm' one", async () => {
    let reads = 0;
    const { f, open } = setup(() => { reads += 1;return { status: 200, body: { people: reads === 1 ? view : { ...view, revision: 4 } } }; });
    await open();
    fireEvent.click(await screen.findByRole("button", { name: "Remove Cal" }));
    expect((await screen.findByRole("alert")).textContent).toBe("These people or your permissions changed. Check the current list.");
    expect(f.request.mock.calls.map(([request]) => request).filter(request => request.method === "POST")).toHaveLength(0);
  });
  it("a status-0 code the panel does not know never shows its message", async () => {
    expect(peopleFailure(new ApiError(0, "UNHEARD_OF", RAW), "remove").text).toBe("Couldn't remove this person. Try again.");
  });
});
