// @vitest-environment jsdom
// OWNER DECISION 7: what the old review page decided is on the task page. A requirements or coding plan card carries the document's questions (AgentX's answer chosen until the person picks another,
// with who suggested what), the optional checks, the open comments to send and a note, and sends only what the person set; a stopped task offers the checks retry, Revise the plan and a held spec's
// choices where the task view says so, each through its own route.
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
import { designTaskSession } from "./support/design-review-fixture.js";

const TASK = "11111111-1111-4111-8111-111111111111";
const SESSION_PATH = "/app/sessions/" + SESSION_FIXTURE_ID;
const KEPT = "22222222-2222-4222-8222-222222222222", LEFT = "33333333-3333-4333-8333-333333333333";
const base = (extra: Partial<ItemBase> = {}): ItemBase => ({ subjectId: TASK, taskId: TASK, project: "payments", title: "Retry failed payments", createdAt: "2026-11-06T10:00:00.000Z", contentVersion: "v1", openPath: SESSION_PATH, ...extra });
const choices = {
 questions: [{ id: "d1", question: "How many retries?", recommended: "three", options: [{ id: "three", label: "Three times" }, { id: "five", label: "Five times" }], suggested: [{ optionId: "five", name: "Omar" }] }],
 optionalChecks: [{ id: "lint", label: "Lint", selected: false }],
 openComments: [{ id: KEPT, excerpt: "Keep the old export." }, { id: LEFT, excerpt: "Rename the queue later." }],
};
const plan = (): DecisionItem => ({ ...base(), kind: "approve_plan", path: "quick", files: [], claims: 2, untestedClaims: 0, choices });
const viewOf = (items: DecisionItem[]) => { const p = projectDecisionCards(items); return DecisionCardsViewSchema.parse({ cards: p.cards, total: p.cards.length, tabs: p.tabs, details: p.details, digests: p.digests, dropped: p.dropped, choices: p.choices }); };
const decided = (cardId: string, outcome: "approved" | "rejected") => ({ status: 200, body: { cardId, outcome, remainingTabs: [] } });

function taskPage(items: DecisionItem[], answer: (request: ApiRequest) => { status: number; body: unknown } | undefined = () => undefined, session = designTaskSession(undefined, {}, { path: "QUICK", reviewPhase: undefined })) {
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

it("the plan card shows its questions, checks and open comments, and Approve sends only what the person set", async () => {
 const f = taskPage([plan()], request => request.method === "POST" && request.path.endsWith("/approve") ? decided("approve_plan:" + TASK, "approved") : undefined);
 const card = await cardOn();
 const recommended = within(card).getByRole("radio", { name: /Three times \(Rovara recommends this\)/ });
 expect((recommended as HTMLInputElement).checked).toBe(true);
 fireEvent.click(within(card).getByRole("radio", { name: /Five times · suggested by Omar/ }));
 fireEvent.click(within(card).getByRole("checkbox", { name: "Lint" }));
 fireEvent.click(within(card).getByRole("checkbox", { name: "Rename the queue later." }));
 fireEvent.change(within(card).getByLabelText("Note for Rovara (optional)"), { target: { value: "Support asked for five." } });
 const approve = within(card).getByRole("button", { name: "Approve" });
 if (approve.hasAttribute("disabled")) { fireEvent.click(within(card).getByText(/evidence/i, { selector: "summary" })); await waitFor(() => expect(approve.hasAttribute("disabled")).toBe(false)); }
 fireEvent.click(approve);
 await waitFor(() => expect(f.posts().some(request => request.path.endsWith("/approve"))).toBe(true));
 expect(f.posts().find(request => request.path.endsWith("/approve"))!.body).toMatchObject({
  answers: [{ decisionId: "d1", optionId: "five", opened: true }], selectedOptionalCheckIds: ["lint"], includedCommentIds: [KEPT], note: "Support asked for five.",
 });
 f.close();
});

it("a plain Approve on the card sends none of the plan fields but the open comments, as Slack's Approve takes them", async () => {
 const f = taskPage([plan()], request => request.method === "POST" && request.path.endsWith("/approve") ? decided("approve_plan:" + TASK, "approved") : undefined);
 const card = await cardOn();
 const approve = within(card).getByRole("button", { name: "Approve" });
 if (approve.hasAttribute("disabled")) { fireEvent.click(within(card).getByText(/evidence/i, { selector: "summary" })); await waitFor(() => expect(approve.hasAttribute("disabled")).toBe(false)); }
 fireEvent.click(approve);
 await waitFor(() => expect(f.posts().some(request => request.path.endsWith("/approve"))).toBe(true));
 const body = f.posts().find(request => request.path.endsWith("/approve"))!.body as Record<string, unknown>;
 expect(body.includedCommentIds).toEqual([KEPT, LEFT]);
 expect(body).not.toHaveProperty("answers");
 expect(body).not.toHaveProperty("selectedOptionalCheckIds");
 expect(body).not.toHaveProperty("note");
 f.close();
});

it("Request changes sends the reason with the comments the person kept", async () => {
 const f = taskPage([plan()], request => request.method === "POST" && request.path.endsWith("/request-changes") ? decided("approve_plan:" + TASK, "rejected") : undefined);
 const card = await cardOn();
 fireEvent.click(within(card).getByRole("checkbox", { name: "Keep the old export." }));
 fireEvent.click(within(card).getByText("Request changes", { selector: "summary" }));
 fireEvent.change(within(card).getByLabelText("What should change?"), { target: { value: "Handle the double charge." } });
 fireEvent.click(within(card).getByRole("button", { name: "Request changes" }));
 await waitFor(() => expect(f.posts().map(request => request.path)).toEqual(["/v1/app/decisions/approve_plan/" + TASK + "/request-changes"]));
 expect(f.posts()[0]!.body).toMatchObject({ reason: "Handle the double charge.", includedCommentIds: [LEFT] });
 f.close();
});

it("a stopped task offers the checks retry, Revise the plan and the spec's choices where the task view says so, each to its own route with the revision shown", async () => {
 const pageActions = { checksRetry: { canRetry: true }, revisePlan: { canRevise: true }, specHold: { title: "Spec on hold", message: "The spec could not be written.", choices: ["retry", "continue"], canChoose: true } };
 const session = designTaskSession(undefined, { pageActions }, { path: "QUICK", reviewPhase: undefined, stage: "IMPLEMENT", state: "BLOCKED", revision: 7 });
 const f = taskPage([], request => request.method === "POST" && request.path.startsWith("/v1/app/tasks/") ? { status: 200, body: { revision: 8 } } : undefined, session);
 const section = await screen.findByRole("region", { name: "What happens next" });
 fireEvent.click(within(section).getByRole("button", { name: "Retry the browser and API checks" }));
 await waitFor(() => expect(f.posts().map(request => request.path)).toContain("/v1/app/tasks/" + TASK + "/workflow/checks-retry"));
 expect(f.posts().find(request => request.path.endsWith("/checks-retry"))!.body).toMatchObject({ expectedRevision: 7, requestId: expect.stringMatching(/^[0-9a-f-]{36}$/u) as unknown });
 fireEvent.click(await within(section).findByRole("button", { name: "Revise the plan" }));
 await waitFor(() => expect(f.posts().map(request => request.path)).toContain("/v1/app/tasks/" + TASK + "/workflow/revise-plan"));
 fireEvent.click(await within(section).findByRole("button", { name: "Continue without the spec" }));
 await waitFor(() => expect(f.posts().map(request => request.path)).toContain("/v1/app/tasks/" + TASK + "/spec/continue"));
 f.close();
});

it("a reader who may not press is told who can, and no button is offered", async () => {
 const pageActions = { checksRetry: { canRetry: false }, specHold: { title: "Spec on hold", message: "The spec could not be written.", choices: ["retry"], canChoose: false } };
 const f = taskPage([], undefined, designTaskSession(undefined, { pageActions }, { path: "QUICK", reviewPhase: undefined, stage: "IMPLEMENT", state: "BLOCKED", revision: 7 }));
 const section = await screen.findByRole("region", { name: "What happens next" });
 expect(within(section).getByText("Only the task owner can retry these checks.")).toBeTruthy();
 expect(within(section).getByText("Only the task owner can choose what happens to the spec.")).toBeTruthy();
 expect(within(section).queryByRole("button")).toBeNull();
 f.close();
});

it("People and the review page's comments are on the task page: Remember posts to the comment's route, and a role change goes on to its confirmation page", async () => {
 const COMMENT = "44444444-4444-4444-8444-444444444444", PERSON = "55555555-5555-4555-8555-555555555555", REQUEST = "66666666-6666-4666-8666-666666666666";
 const f = taskPage([], request => {
  if (request.path === "/v1/app/tasks/" + TASK + "/comments") return { status: 200, body: { comments: [{ id: COMMENT, author: { kind: "person", name: "Sam" }, text: "Use the shared retry helper.", deleted: false, learning: { remembered: false } }], canRemember: true } };
  if (request.path === "/v1/app/tasks/" + TASK + "/people") return { status: 200, body: { view: { revision: 3, people: [{ personId: PERSON, name: "Lee", role: "commenter", you: false }], canManage: true, canTakeOwnership: false } } };
  if (request.method === "POST" && request.path.endsWith("/remember")) return { status: 200, body: { correction: { id: "c1" } } };
  if (request.method === "POST" && request.path.endsWith("/people/role")) return { status: 200, body: { change: { status: "PENDING", requestId: REQUEST, confirmationUrl: "/review/" + TASK + "/task/people/confirm/" + REQUEST } } };
  return undefined;
 });
 const region = await screen.findByRole("region", { name: "People and comments" });
 // OWNER DECISION 17: comments stay on the review page for now, and the task page links straight to them.
 expect(within(region).getByRole("link", { name: "Comment on the plan" }).getAttribute("href")).toBe("/review/" + TASK + "/task?doc=coding-plan");
 fireEvent.click(await within(region).findByRole("button", { name: "Remember this" }));
 await waitFor(() => expect(f.posts().map(request => request.path)).toContain("/v1/app/tasks/" + TASK + "/comments/" + COMMENT + "/remember"));
 expect(f.posts().find(request => request.path.endsWith("/remember"))!.body).toEqual({});
 fireEvent.change(within(region).getByLabelText("Access for Lee"), { target: { value: "viewer" } });
 fireEvent.click(within(region).getByRole("button", { name: "Review role change" }));
 await waitFor(() => expect(f.posts().map(request => request.path)).toContain("/v1/app/tasks/" + TASK + "/people/role"));
 expect(f.posts().find(request => request.path.endsWith("/people/role"))!.body).toMatchObject({ expectedPeopleRevision: 3, personId: PERSON, role: "viewer" });
 await waitFor(() => expect(f.host.openExternal).toHaveBeenCalledWith(expect.stringContaining("/review/" + TASK + "/task/people/confirm/" + REQUEST)));
 f.close();
});
