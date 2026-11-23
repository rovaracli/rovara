// @vitest-environment jsdom
import { expect, it } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { appRoutes } from "../../packages/ui/src/routes.js";
import { AppHostProvider } from "../../packages/ui/src/host.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { fakeHost } from "./support/fake-host.js";
import { meFixture, navFixture } from "./support/fixtures.js";
import { projectFixture } from "./support/project-fixture.js";
import { SESSION_FIXTURE_ID, sessionFixture, taskFixture } from "./support/session-fixture.js";
import { renderUi } from "./support/render.js";
import { h } from "./support/h.js";
const TASK = "11111111-1111-4111-8111-111111111111";
for (const path of ["/app/sessions/" + TASK, "/s/" + SESSION_FIXTURE_ID]) it(`a reader asks from the production task route ${path}`, async () => {
 const nav = navFixture({ features: { localAgents: false, usage: false, admin: false, chains: false, notices: false, describe: false, answers: true } });
 const session = sessionFixture({ body: { kind: "task", task: taskFixture() }, you: { level: "view", owner: false, following: false, actions: ["watch"] } });
 const f = fakeHost(async request => {
  const url = request.path.split("?")[0]!;
  if (url === "/v1/app/me") return { status: 200, body: meFixture() };
  if (url === "/v1/app/nav") return { status: 200, body: nav };
  if (url === "/v1/app/sessions") return { status: 200, body: { tasks: [taskFixture()] } };
  if (url === "/v1/app/sessions/" + SESSION_FIXTURE_ID) return { status: 200, body: { session } };
  if (url === "/v1/app/projects/payments/overview") return { status: 200, body: projectFixture({ you: { role: "viewer", canStartWork: false, canEditSettings: false, canViewSpend: false } }) };
  if (request.method === "GET" && url === `/v1/app/projects/payments/tasks/${TASK}/answers`) return { status: 200, body: { entries: [], more: false } };
  if (request.method === "POST" && url === "/v1/app/projects/payments/answers") return { status: 200, body: { answerId: "answer-1", threadId: "thread-1", outcome: "answered", text: "This reader can ask.", sources: [], wikiPages: [], unconfirmed: [] } };
  if (url === "/v1/app/decisions") return { status: 200, body: { tabs: [], cards: [] } };
  if (url.endsWith("/events")) return { status: 200, body: { events: [] } };
  if (url.endsWith("/messages")) return { status: 200, body: { messages: [], hasMore: false } };
  if (url.endsWith("/presence")) return { status: 200, body: { viewingNow: [] } };
  if (url.endsWith("/comments")) return { status: 200, body: { comments: [] } };
  return { status: 404, body: { error: { code: "NOT_FOUND", message: "Not served" } } };
 });
 const routes = appRoutes(nav.features), app = routes.find(route => route.path === "/app")!;
 const share = path.startsWith("/s/");
 const leaf = share ? routes.find(route => route.path === "/s/:id")!.children![0]! : app.children!.find(route => route.path === "sessions/:id")!;
 const router = createMemoryRouter([{ path: share ? "/s/:id" : "/app/sessions/:id", lazy: leaf.lazy! }], { initialEntries: [path] });
 const query = createQueryClient();query.setQueryData(["nav"], nav);
 const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(RouterProvider, { router }) }) }));
 try {
  await screen.findByTestId("session-title", {}, { timeout: 15_000 });
  if (share) fireEvent.click(await screen.findByTestId("session-conversation-trigger"));
  const fold = await screen.findByTestId("task-answers");fireEvent.click(within(fold).getByText("Ask about this task", { selector: "summary" }));
  fireEvent.change(await screen.findByRole("textbox", { name: "Ask about this task" }), { target: { value: "What is happening?" } });
  const button = screen.getByRole<HTMLButtonElement>("button", { name: "Ask" });await waitFor(() => expect(button.disabled).toBe(false));fireEvent.click(button);
  await waitFor(() => expect(f.request.mock.calls.filter(([r]) => r.method === "POST" && r.path.endsWith("/answers"))).toHaveLength(1));
  expect(f.request.mock.calls.find(([r]) => r.method === "POST" && r.path.endsWith("/answers"))![0].body).toMatchObject({ taskId: TASK, question: "What is happening?" });
 } finally { ui.unmount();router.dispose();query.clear(); }
});
