// @vitest-environment jsdom
// R1b: a task Understand answered ends CLOSED with the outcome ANSWERED, and the Pipeline tab says so: "Rovara answered this. No code was changed.", the answer (plain text) and where it was
// read, and for people who can use the session one "Make a change anyway" button that starts the change once and opens the new session. Everyone else only reads. Other tasks show nothing new.
import { expect, it, vi } from "vitest";
import { screen, fireEvent, waitFor, act } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import type { ApiRequest, ApiResponse } from "../../packages/ui/src/host.js";
import { SessionScreen } from "../../packages/ui/src/screens/session/SessionScreen.js";
import { AppHostProvider } from "../../packages/ui/src/host.js";
import { Announcer } from "../../packages/ui/src/design/Announcer.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { renderUi } from "./support/render.js";
import { h } from "./support/h.js";
import { fakeHost } from "./support/fake-host.js";
import { SESSION_FIXTURE_ID } from "./support/session-fixture.js";
import { answeredSession } from "./support/answered-fixture.js";
import { expectNoAxeViolations } from "./support/axe.js";

const NEW_SESSION = "ses_bbbbbbbbbbbbbbbbbbbb";
const started = { task: { taskId: "22222222-2222-4222-8222-222222222222", title: "Fix duplicate refunds", project: "payments", status: "STARTING", startingRevision: 1, client: "app", shared: false, createdAt: "2026-10-23T12:00:00.000Z", updatedAt: "2026-10-23T12:00:00.000Z", events: [], sessionId: NEW_SESSION }, sessionId: NEW_SESSION };

function setup(initial: ReturnType<typeof answeredSession>, reply?: (request: ApiRequest) => Promise<ApiResponse>) {
  const f = fakeHost(async (request) => {
    const path = request.path.split("?", 1)[0]!;
    if (path.endsWith("/messages")) return { status: 200, body: { messages: [] } };
    if (path.endsWith("/events")) return { status: 200, body: { events: [] } };
    if (path.endsWith("/presence")) return { status: 200, body: { viewingNow: initial.viewingNow } };
    if (request.method === "POST" && path.endsWith("/change-anyway")) return reply === undefined ? { status: 202, body: started } : reply(request);
    return { status: 200, body: { session: initial } };
  });
  const query = createQueryClient(), router = createMemoryRouter([{ path: "/app/sessions/:id", element: h(SessionScreen, {}) }], { initialEntries: ["/app/sessions/" + SESSION_FIXTURE_ID] });
  const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(Announcer, { children: h(RouterProvider, { router }) }) }) }));
  const posts = () => f.request.mock.calls.filter(([request]) => request.method === "POST" && request.path.endsWith("/change-anyway"));
  const navigate = vi.spyOn(f.host, "navigate");
  return { ...f, ...ui, posts, navigate, close() { ui.unmount(); router.dispose(); query.clear(); } };
}

const region = async () => screen.findByRole("region", { name: "Rovara's answer" });

it("shows the heading, the answer as plain text and where it was read, for an Answered task", async () => {
  const f = setup(answeredSession());
  const section = await region();
  expect(screen.getByRole("heading", { name: "Rovara answered this. No code was changed." })).toBeTruthy();
  expect(section.querySelector("img")).toBeNull();
  expect(section.textContent).toContain("It turns retries on <img src=x onerror=window.__pwned=1> for the payment worker.");
  expect(section.textContent).not.toContain("\u202E");
  expect(section.textContent).toContain("Second line stays a line.");
  expect(section.textContent).toContain("payments/src/retry.ts:4");
  expect(section.textContent).toContain("payments/docs/flags.md");
  expect("__pwned" in window).toBe(false);
  f.close();
});

it("starts the change once however many times it is pressed, through change-anyway, and opens the new session", async () => {
  const f = setup(answeredSession());
  await region();
  const button = screen.getByRole("button", { name: "Make a change anyway" });
  act(() => { button.click(); button.click(); button.click(); });
  await waitFor(() => expect(f.posts()).toHaveLength(1));
  const request = f.posts()[0]![0];
  expect(request.path).toBe(`/v1/app/sessions/${SESSION_FIXTURE_ID}/change-anyway`);
  const sent = request.body as { requestId: string };
  expect(request.body).toEqual({ requestId: sent.requestId });
  expect(sent.requestId).toMatch(/^[0-9a-f-]{36}$/u);
  await waitFor(() => expect(f.navigate).toHaveBeenCalledWith("/s/" + NEW_SESSION));
  expect(f.posts()).toHaveLength(1);
  f.close();
});

it("says plainly when the server refuses, keeps the button for another try and reuses the request id", async () => {
  const refusals: Array<[number, string, string, RegExp]> = [
    [403, "SESSION_LEVEL_REQUIRED", "Server words one.", /can use/u],
    [403, "PROJECT_ACCESS_DENIED", "Server words two.", /permission to start work/u],
    [409, "SESSION_ON_MAC", "Server words three.", /runs on a Mac/u],
    [400, "CONFIG_INVALID", "Server words four.", /didn't end with an answer/u],
    [503, "RUNTIME_UNAVAILABLE", "Server words five.", /can't start work right now/u],
  ];
  for (const [status, code, message, words] of refusals) {
    const f = setup(answeredSession(), async () => ({ status, body: { error: { code, message } } }));
    await region();
    fireEvent.click(screen.getByRole("button", { name: "Make a change anyway" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent, code).toMatch(words);
    expect(alert.textContent, code).not.toContain("Server words");
    expect(f.navigate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Make a change anyway" }));
    await waitFor(() => expect(f.posts()).toHaveLength(2));
    expect((f.posts()[1]![0].body as { requestId: string }).requestId, code).toBe((f.posts()[0]![0].body as { requestId: string }).requestId);
    f.close();
  }
});

it("without a session id in the answer, says the change was accepted and starts nothing twice", async () => {
  const f = setup(answeredSession(), async () => ({ status: 202, body: { task: { ...started.task, sessionId: undefined } } }));
  await region();
  fireEvent.click(screen.getByRole("button", { name: "Make a change anyway" }));
  await screen.findByText(/The change was accepted/u);
  expect(f.navigate).not.toHaveBeenCalled();
  expect((screen.getByRole<HTMLButtonElement>("button", { name: "Make a change anyway" })).disabled).toBe(true);
  expect(f.posts()).toHaveLength(1);
  f.close();
});

it("shows a viewer the answer and no button", async () => {
  const f = setup(answeredSession({ level: "view" }));
  const section = await region();
  expect(section.textContent).toContain("Second line stays a line.");
  expect(screen.queryByRole("button", { name: "Make a change anyway" })).toBeNull();
  f.close();
});

it("shows no button when the session runs on a Mac now", async () => {
  const f = setup(answeredSession({ onMac: true }));
  await screen.findByRole("heading", { name: "Rovara answered this. No code was changed." });
  expect(screen.queryByRole("button", { name: "Make a change anyway" })).toBeNull();
  f.close();
});

it("shows nothing new for a task that was not answered", async () => {
  const f = setup(answeredSession({ answered: false }));
  await screen.findByText("Working");
  expect(screen.queryByRole("region", { name: "Rovara's answer" })).toBeNull();
  expect(screen.queryByText(/Rovara answered this/u)).toBeNull();
  expect(screen.queryByRole("button", { name: "Make a change anyway" })).toBeNull();
  f.close();
});

for (const theme of ["light", "dark"] as const) {
  it(`has no accessibility violations in the ${theme} theme`, async () => {
    const f = setup(answeredSession());
    await region();
    document.documentElement.setAttribute("data-theme", theme);
    await expectNoAxeViolations(f.container);
    f.close();
  });
}
