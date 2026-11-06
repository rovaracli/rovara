// @vitest-environment jsdom
// Decision journey, slice 2: the requirements and the coding plan are cards decided on the task page (Approve, Request changes), the plan's run limit is ticked inside its card, the design questions are
// answered on their card, a high plan is approved on its card with a recent sign-in, and the Plan tab's "Review and approve" goes to the card.
import { expect, it } from "vitest";
import { screen, fireEvent, waitFor, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { DecisionCardsViewSchema } from "@agentx/contracts/web";
import { SessionScreen } from "../../packages/ui/src/screens/session/SessionScreen.js";
import { AppHostProvider } from "../../packages/ui/src/host.js";
import { Announcer } from "../../packages/ui/src/design/Announcer.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { projectDecisionCards, type DecisionItem, type ItemBase } from "../../packages/broker/src/decisions/project.js";
import type { ApiRequest } from "../../packages/ui/src/host.js";
import { renderUi } from "./support/render.js";
import { fakeHost } from "./support/fake-host.js";
import { h } from "./support/h.js";
import { SESSION_FIXTURE_ID } from "./support/session-fixture.js";
import { designReviewFixture, designTaskSession } from "./support/design-review-fixture.js";

const TASK = "11111111-1111-4111-8111-111111111111";
const SESSION_PATH = "/app/sessions/" + SESSION_FIXTURE_ID;
const base = (extra: Partial<ItemBase> = {}): ItemBase => ({ subjectId: TASK, taskId: TASK, project: "payments", title: "Retry failed payments", createdAt: "2026-11-06T10:00:00.000Z", contentVersion: "v1", openPath: SESSION_PATH, ...extra });
const plan = (runLimit?: { currentUsd?: number; proposedUsd: number }, files: string[] = []): DecisionItem => ({ ...base(), kind: "approve_plan", path: "quick", files, claims: 2, untestedClaims: 0, ...(runLimit === undefined ? {} : { runLimit }) });
const viewOf = (items: DecisionItem[]) => { const p = projectDecisionCards(items); return DecisionCardsViewSchema.parse({ cards: p.cards, total: p.cards.length, tabs: p.tabs, details: p.details, digests: p.digests, dropped: p.dropped }); };
const decided = (cardId: string, outcome: "approved" | "rejected") => ({ status: 200, body: { cardId, outcome, remainingTabs: [] } });

function taskPage(items: DecisionItem[], answer: (request: ApiRequest) => { status: number; body: unknown } | undefined = () => undefined, session = designTaskSession(designReviewFixture())) {
 const f = fakeHost(async request => {
  const answered = answer(request);
  if (answered !== undefined) return answered;
  if (request.path === "/v1/app/decisions") return { status: 200, body: viewOf(items) };
  if (request.path.endsWith("/events")) return { status: 200, body: { events: [] } };
  if (request.path.endsWith("/presence")) return { status: 200, body: { viewingNow: [] } };
  if (request.method === "POST" && request.path.endsWith("/evidence-opened")) return { status: 200, body: { cardId: request.path.split("/").slice(-3, -1).join(":"), opened: true, recorded: true } };
  return { status: 200, body: { session } };
 });
 const query = createQueryClient(), router = createMemoryRouter([{ path: "/app/sessions/:id", element: h(SessionScreen, {}) }], { initialEntries: [SESSION_PATH] });
 const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(Announcer, { children: h(RouterProvider, { router }) }) }) }));
 const posts = () => f.request.mock.calls.map(([request]) => request).filter(request => request.method === "POST" && !request.path.endsWith("/presence"));
 return { ...f, posts, close() { ui.unmount();router.dispose();query.clear(); } };
}
const cardOn = () => screen.findByRole("article", { name: "Retry failed payments" });

it("S2a: a plan that raises the run limit shows current → proposed in its card and approves only after the tick, sending the ticked limit", async () => {
 const f = taskPage([plan({ currentUsd: 2, proposedUsd: 6 })], request => request.method === "POST" && request.path.endsWith("/approve") ? decided("approve_plan:" + TASK, "approved") : undefined);
 const card = await cardOn();
 const limit = within(card).getByRole("group", { name: "Run limit" });
 expect(limit.textContent).toContain("Current limit $2.00 → proposed limit $6.00");
 const approve = within(card).getByRole("button", { name: "Approve" });
 expect(approve.hasAttribute("disabled")).toBe(true);
 fireEvent.click(within(limit).getByRole("checkbox", { name: /raise this task's run limit/ }));
 await waitFor(() => expect(approve.hasAttribute("disabled")).toBe(false));
 fireEvent.click(approve);
 await waitFor(() => expect(f.posts().map(request => request.path)).toContain("/v1/app/decisions/approve_plan/" + TASK + "/approve"));
 expect(f.posts().find(request => request.path.endsWith("/approve"))!.body).toMatchObject({ acknowledgedRunLimitUsd: 6 });
 f.close();
});

it("S2a: a plan that does not raise the limit needs no tick, and still names the limit it sets", async () => {
 const f = taskPage([plan({ currentUsd: 10, proposedUsd: 6 })], request => request.method === "POST" && request.path.endsWith("/approve") ? decided("approve_plan:" + TASK, "approved") : undefined);
 const card = await cardOn();
 expect(within(card).queryByRole("checkbox")).toBeNull();
 fireEvent.click(within(card).getByRole("button", { name: "Approve" }));
 await waitFor(() => expect(f.posts().find(request => request.path.endsWith("/approve"))?.body).toMatchObject({ acknowledgedRunLimitUsd: 6 }));
 f.close();
});

it("S2b: Request changes on the card sends the reason (one line) to the card's own route, and the card says so", async () => {
 const f = taskPage([plan()], request => request.method === "POST" && request.path.endsWith("/request-changes") ? decided("approve_plan:" + TASK, "rejected") : undefined);
 const card = await cardOn();
 expect(within(card).queryByText("Not now")).toBeNull();
 fireEvent.click(within(card).getByText("Request changes", { selector: "summary" }));
 const send = within(card).getByRole("button", { name: "Request changes" });
 expect(send.hasAttribute("disabled")).toBe(true);
 fireEvent.change(within(card).getByLabelText("What should change?"), { target: { value: "Keep the old export\ntoo." } });
 fireEvent.click(send);
 await waitFor(() => expect(f.posts().map(request => request.path)).toEqual(["/v1/app/decisions/approve_plan/" + TASK + "/request-changes"]));
 expect(f.posts()[0]!.body).toMatchObject({ reason: "Keep the old export too.", shownDigest: expect.stringMatching(/^[a-f0-9]{64}$/u) as unknown });
 expect(await within(card).findByText("Sent back with your reason. Rovara revises it.")).toBeTruthy();
 f.close();
});

it("S2a (security review): a HIGH plan is approved on its card on the task page; without the decide-grade sign-in the same card says so, with the decide sign-in made for it", async () => {
 let signedIn = false;
 const high = plan(undefined, ["infra/main.tf", "iam/policy.json"]);
 const risk = projectDecisionCards([high]).cards[0]!.risk;
 expect(risk, "positive control: infrastructure files make the plan high").toBe("high");
 const f = taskPage([high], request => request.method === "POST" && request.path === "/v1/app/decisions/approve_plan/" + TASK + "/approve"
  ? signedIn ? decided("approve_plan:" + TASK, "approved") : { status: 403, body: { error: { code: "REAUTH_REQUIRED", reason: "decide_sign_in", signInUrl: "/v1/auth/decide/identify?return=" + encodeURIComponent("/v1/app/approve/apr_" + "a".repeat(20)), message: "Sign in again to decide this. A high-risk decision needs a sign-in with the email code within the last 10 minutes." } } } : undefined);
 const card = await cardOn();
 fireEvent.click(await within(card).findByRole("button", { name: "Approve" }));
 expect((await within(card).findByRole("alert")).textContent).toContain("Sign in again to decide this");
 expect(within(card).getByRole("link", { name: "Sign in again" }).getAttribute("href")).toBe("https://cell.example" + "/v1/auth/decide/identify?return=" + encodeURIComponent("/v1/app/approve/apr_" + "a".repeat(20)));
 expect(f.host.signIn).not.toHaveBeenCalled();
 signedIn = true;
 fireEvent.click(within(card).getByRole("button", { name: "Approve" }));
 expect(await within(card).findByText("Approved. Rovara goes on from here.")).toBeTruthy();
 f.close();
});

it("S2c: the design questions are answered on their card (an option per question), posted to the design review's answers route", async () => {
 const review = designReviewFixture({ status: "waiting_answers", waiting: { since: "2026-11-06T09:00:00.000Z" } });
 const session = designTaskSession(review, {}, { stage: "PLAN", state: "WAITING" });
 const questions: DecisionItem = { ...base(), kind: "answer_question", question: "Design questions (1)", index: 1, of: 1, batch: { count: 1 } };
 const f = taskPage([questions], request => request.method === "POST" && request.path === "/v1/app/tasks/" + TASK + "/design-review/answers" ? { status: 200, body: { kind: "done" } } : undefined, session);
 const card = await cardOn();
 const form = within(card).getByRole("form", { name: "Answer the design questions" });
 const answer = within(form).getByRole("button", { name: "Answer" });
 expect(answer.hasAttribute("disabled")).toBe(true);
 fireEvent.click(within(form).getByRole("radio", { name: /Default to global/ }));
 await waitFor(() => expect(answer.hasAttribute("disabled")).toBe(false));
 fireEvent.click(answer);
 await waitFor(() => expect(f.posts().map(request => request.path)).toEqual(["/v1/app/tasks/" + TASK + "/design-review/answers"]));
 expect(f.posts()[0]!.body).toMatchObject({ answers: [{ questionId: "q1", optionId: "b" }] });
 f.close();
});

it("S2e: the Plan tab's Review and approve goes to the plan's card on this page, not the plan review page", async () => {
 const session = designTaskSession(undefined, {}, { path: "QUICK", reviewPhase: undefined, stage: "PLAN_REVIEW", state: "WAITING", planContent: "# Plan\nRetry once." });
 const f = taskPage([plan()], undefined, session);
 const card = await cardOn();
 const tab = await screen.findByRole("tab", { name: "Plan" });
 fireEvent.mouseDown(tab, { button: 0 });fireEvent.click(tab);
 const button = await screen.findByRole("button", { name: "Review and approve the plan" });
 fireEvent.click(button);
 expect(document.activeElement).toBe(card);
 expect(f.host.openExternal).not.toHaveBeenCalled();
 f.close();
});

it("review fix: what Approve takes is said next to Approve on a requirements and a plan card, at low risk too", async () => {
 for (const item of [{ ...base(), kind: "approve_requirements", claims: 3 } as DecisionItem, plan()]) {
  expect(projectDecisionCards([item]).cards[0]!.risk, "positive control: low").toBe("low");
  const f = taskPage([item]);
  const card = await cardOn();
  expect(within(card).getByText(/takes Rovara's recommended answer to each decision/u)).toBeTruthy();
  f.close();
 }
});
