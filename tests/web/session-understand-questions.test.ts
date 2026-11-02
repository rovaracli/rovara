// @vitest-environment jsdom
// Understand's questions on the session page (playbook S3): the Pipeline tab shows each question (inert text) with an answer field and one "Send answers" button for people who can use the
// session, the questions read-only with "Waiting for <owner> to answer" for everyone else, posts once with the round and the workflow revision the page read, and tells a stale answer apart.
import { expect, it } from "vitest";
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
import { SESSION_FIXTURE_ID, type sessionFixture } from "./support/session-fixture.js";
import { understandSession } from "./support/understand-fixture.js";
import { expectNoAxeViolations } from "./support/axe.js";

function setup(initial: ReturnType<typeof sessionFixture>, reply?: (request: ApiRequest) => Promise<ApiResponse>) {
  let session = initial;
  const f = fakeHost(async (request) => {
    const path = request.path.split("?", 1)[0]!;
    // The decision cards are not switched on in this world (the route does not exist): "no cards".
    if (path === "/v1/app/decisions") return { status: 404, body: { error: { code: "NOT_FOUND", message: "route not found" } } };
    if (path.endsWith("/messages")) return { status: 200, body: { messages: [] } };
    if (path.endsWith("/events")) return { status: 200, body: { events: [] } };
    if (path.endsWith("/presence")) return { status: 200, body: { viewingNow: session.viewingNow } };
    if (request.method === "POST" && path.endsWith("/answers")) return reply === undefined ? { status: 200, body: { session } } : reply(request);
    return { status: 200, body: { session } };
  });
  const query = createQueryClient(), router = createMemoryRouter([{ path: "/app/sessions/:id", element: h(SessionScreen, {}) }], { initialEntries: ["/app/sessions/" + SESSION_FIXTURE_ID] });
  const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(Announcer, { children: h(RouterProvider, { router }) }) }) }));
  const posts = () => f.request.mock.calls.filter(([request]) => request.method === "POST" && request.path.endsWith("/answers"));
  const reads = () => f.request.mock.calls.filter(([request]) => request.method === "GET" && request.path.split("?", 1)[0]!.endsWith("/" + SESSION_FIXTURE_ID)).length;
  return { ...f, ...ui, query, router, posts, reads, setSession(next: ReturnType<typeof sessionFixture>) { session = next; }, close() { ui.unmount(); router.dispose(); query.clear(); } };
}

const form = async () => screen.findByRole("region", { name: "Questions from Rovara" });
const answerAll = () => {
  fireEvent.click(screen.getByRole("radio", { name: /The payments table/u }));
  fireEvent.change(screen.getByRole("textbox", { name: /Should old refunds be migrated\?/u }), { target: { value: "  Yes, the last year  " } });
};

it("shows each question as inert text with an answer field and one Send answers button", async () => {
  const f = setup(understandSession());
  const region = await form();
  expect(region.querySelector("img")).toBeNull();
  expect(region.textContent).toContain("Which <img src=x onerror=window.__pwned=1> table[U+202E]?");
  expect(region.textContent).toContain("Should old refunds be migrated?");
  expect(screen.getAllByRole("radio")).toHaveLength(2);
  expect(region.textContent).toContain("Recommended");
  expect(screen.getAllByRole("button", { name: "Send answers" })).toHaveLength(1);
  expect("__pwned" in window).toBe(false);
  f.close();
});

it("posts once with the round and the revision the page read, however many times it is clicked", async () => {
  const f = setup(understandSession({ revision: 4 }));
  await form();
  answerAll();
  const send = screen.getByRole("button", { name: "Send answers" });
  act(() => { send.click(); send.click(); send.click(); });
  await waitFor(() => expect(f.posts()).toHaveLength(1));
  const request = f.posts()[0]![0];
  expect(request.path).toBe(`/v1/app/sessions/${SESSION_FIXTURE_ID}/answers`);
  const sent = request.body as { requestId: string };
  expect(sent.requestId).toMatch(/^[0-9a-f-]{36}$/u);
  expect(request.body).toEqual({ requestId: sent.requestId, round: 1, revision: 4, answers: [{ questionId: "q1", optionId: "a" }, { questionId: "q2", text: "Yes, the last year" }] });
  f.close();
});

it("will not send until every question has an answer, and moves focus to the first unanswered field", async () => {
  const f = setup(understandSession());
  await form();
  fireEvent.click(screen.getByRole("button", { name: "Send answers" }));
  await waitFor(() => expect(document.activeElement).toBe(screen.getAllByRole("radio")[0]));
  expect(f.posts()).toHaveLength(0);
  expect(screen.getByRole("alert").textContent).toContain("Answer every question");
  fireEvent.click(screen.getByRole("radio", { name: /The refunds table/u }));
  fireEvent.click(screen.getByRole("button", { name: "Send answers" }));
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("textbox", { name: /Should old refunds be migrated\?/u })));
  expect(f.posts()).toHaveLength(0);
  f.close();
});

it("says the questions were already answered when the server refuses the revision, and refreshes", async () => {
  const f = setup(understandSession(), async () => ({ status: 409, body: { error: { code: "INTENT_NOT_WAITING", message: "This task isn't waiting for answers." } } }));
  await form();
  answerAll();
  const before = f.reads();
  f.setSession(understandSession({ waiting: false, revision: 6 }));
  fireEvent.click(screen.getByRole("button", { name: "Send answers" }));
  await screen.findByText("These questions were already answered.");
  await waitFor(() => expect(f.reads()).toBeGreaterThan(before));
  await waitFor(() => expect(screen.queryByRole("button", { name: "Send answers" })).toBeNull());
  expect(screen.getByText("These questions were already answered.")).toBeTruthy();
  f.close();
});

it("shows the next step after a successful send without a reload", async () => {
  const f = setup(understandSession());
  await form();
  answerAll();
  f.setSession(understandSession({ waiting: false, revision: 5 }));
  fireEvent.click(screen.getByRole("button", { name: "Send answers" }));
  await screen.findByText("Answers sent. Rovara is working on your request.");
  await waitFor(() => expect(screen.queryByRole("button", { name: "Send answers" })).toBeNull());
  expect(screen.getByText("Working")).toBeTruthy();
  expect(f.posts()).toHaveLength(1);
  f.close();
});

it("shows the questions read-only, and who they wait for, to someone who cannot answer", async () => {
  const f = setup(understandSession({ level: "view" }));
  const region = await form();
  expect(region.textContent).toContain("Should old refunds be migrated?");
  expect(region.textContent).toContain("Waiting for Priya to answer");
  expect(screen.queryByRole("button", { name: "Send answers" })).toBeNull();
  expect(screen.queryAllByRole("radio")).toHaveLength(0);
  expect(screen.queryAllByRole("textbox")).toHaveLength(0);
  f.close();
});

it("shows nothing when the task is not waiting on questions", async () => {
  const f = setup(understandSession({ waiting: false }));
  await screen.findByText("Working");
  expect(screen.queryByRole("region", { name: "Questions from Rovara" })).toBeNull();
  f.close();
});

for (const theme of ["light", "dark"] as const) {
  it(`has no accessibility violations in the ${theme} theme`, async () => {
    const f = setup(understandSession());
    await form();
    document.documentElement.setAttribute("data-theme", theme);
    await expectNoAxeViolations(f.container);
    f.close();
  });
}
