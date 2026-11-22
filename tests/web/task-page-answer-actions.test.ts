// @vitest-environment jsdom
import { expect, it } from "vitest";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { AnswerResponseSchema, ANSWER_WORDS, NOT_RIGHT_WORDS } from "@agentx/contracts/web";
import { AppHostProvider } from "../../packages/ui/src/host.js";
import { AnswerBox } from "../../packages/ui/src/screens/answers/AnswerBox.js";
import { AnswerView } from "../../packages/ui/src/screens/answers/AnswerView.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { fakeHost } from "./support/fake-host.js";
import { meFixture } from "./support/fixtures.js";
import { renderUi } from "./support/render.js";
import { h } from "./support/h.js";
const answer = AnswerResponseSchema.parse({ answerId: "a1234567890", threadId: "t-1234", outcome: "answered", text: "Refunds last thirty days. They go out by webhook.", unconfirmed: [], honesty: "I checked the code.", wikiPages: [], sources: [], action: { kind: "quick_task", label: "Start a Quick task", title: "Change the refund window" } });
for (const operation of ["question", "start", "feedback"] as const) for (const code of ["CSRF_INVALID", "CSRF_STALE", "UNRECOGNISED", "RUNTIME_UNAVAILABLE"]) it(`R3/R6a answer ${operation}: ${code === "RUNTIME_UNAVAILABLE" ? 503 : 500}/${code} cannot unlock another write`, async () => {
 const suffix = operation === "question" ? "/answers" : operation === "start" ? "/code" : "/not-right";
 const f = fakeHost(async r => r.path === "/v1/app/me" ? { status: 200, body: meFixture() } : r.method === "GET" ? { status: 200, body: {} } : r.path.endsWith(suffix) ? { status: code === "RUNTIME_UNAVAILABLE" ? 503 : 500, body: { error: { code, message: "Unknown result" } } } : { status: 200, body: answer });
 const query = createQueryClient();
 const element = operation === "feedback" ? h(AnswerView, { project: "payments", answer, repositories: [] }) : h(AnswerBox, { project: "payments", repositories: [], canStart: true, heading: "Ask about this task", presentation: "talk" });
 const tree = () => h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(MemoryRouter, { children: element }) }) });
 let ui = renderUi(tree());
 if (operation !== "feedback") {
  fireEvent.change(await screen.findByRole("textbox", { name: "Ask about this task" }), { target: { value: "Why did this fail?" } });
  const ask = screen.getByRole<HTMLButtonElement>("button", { name: "Ask" });await waitFor(() => expect(ask.disabled).toBe(false));
  if (operation === "start") { fireEvent.click(ask);await screen.findByText(answer.text); }
 }
 const label = operation === "question" ? "Ask" : operation === "start" ? ANSWER_WORDS.taskButton : NOT_RIGHT_WORDS.button;
 const button = await screen.findByRole<HTMLButtonElement>("button", { name: label });await waitFor(() => expect(button.disabled).toBe(false));fireEvent.click(button);
 const posts = () => f.request.mock.calls.filter(([r]) => r.method === "POST" && r.path.endsWith(suffix));
 await waitFor(() => expect(posts()).toHaveLength(1));await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
 expect(button.disabled).toBe(true);
 ui.unmount();ui = renderUi(tree());await screen.findByText(/Rovara didn't confirm this yet/);
 if (operation !== "start") expect(screen.getByRole<HTMLButtonElement>("button", { name: label }).disabled).toBe(true);
 fireEvent.click(screen.getByRole("button", { name: "Check" }));await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
 expect(posts()).toHaveLength(1);ui.unmount();query.clear();
});
