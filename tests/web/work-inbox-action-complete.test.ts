// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { AppNavReaderSchema } from "@agentx/contracts/web";
import { AppHostProvider, type ApiResponse } from "../../packages/ui/src/host.js";
import { appRoutes } from "../../packages/ui/src/routes.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { Announcer } from "../../packages/ui/src/design/Announcer.js";
import { fakeHost } from "./support/fake-host.js";
import { renderUi } from "./support/render.js";
import { h } from "./support/h.js";
import { meFixture } from "./support/fixtures.js";
import { sceneReplies, unitScenes } from "./support/work-inbox-scenes.js";
import { CARDS, decisionsView, ID, QUESTION_SESSION, task } from "./support/work-fixture.js";
import { understandSession } from "./support/understand-fixture.js";
const closes: Array<() => void> = [];
afterEach(() => { closes.splice(0).forEach(close => close());localStorage.clear(); });
function mount(route: string, scene = "work-all", outcome: ApiResponse = { status: 200, body: { cardId: "approve_plan:" + ID.plan, outcome: "approved", remainingTabs: [] } }, setup?: (replies: Record<string, ApiResponse>) => void) {
 const replies: Record<string, ApiResponse> = { ...sceneReplies(unitScenes.find(item => item.id === scene)!), "/v1/app/me": { status: 200, body: meFixture() } };
 setup?.(replies);
 const f = fakeHost(async input => {
  if (input.method !== "GET") return outcome;
  return replies[input.path.split("?")[0]!] ?? { status: 404, body: { error: { code: "NOT_FOUND", message: "route not found" } } };
 });
 const query = createQueryClient(), nav = AppNavReaderSchema.parse(replies["/v1/app/nav"]!.body);
 const router = createMemoryRouter(appRoutes(nav.features), { initialEntries: [route] });
 const view = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(Announcer, { children: h(RouterProvider, { router }) }) }) }));
 closes.push(() => { view.unmount();router.dispose();query.clear(); });
 return { ...f, replies, query, router, view, writes: () => f.request.mock.calls.map(([input]) => input).filter(input => input.method !== "GET") };
}
it.each(["/app/live", "/app/previews/work"])("LIVE-ROUTE PARITY %s offers the same spec/decision and lesson-feedback composition", async route => {
 const f = mount(route + "?task=" + ID.plan);
 await screen.findByRole("button", { name: "Approve plan v1" });
 expect(await screen.findByRole("button", { name: "Yes, behind a flag" })).toBeTruthy();
 expect(screen.getByTestId("lessons-used")).toBeTruthy();
 fireEvent.click(screen.getByRole("button", { name: "Approve plan v1" }));
 await waitFor(() => expect(f.writes()).toHaveLength(1));
 expect(f.writes()[0]?.method).toBe("POST");expect(f.writes()[0]?.path).toContain("/approve");
 const body = f.writes()[0]?.body as Record<string, unknown>;expect(typeof body["shownDigest"]).toBe("string");expect(typeof body["requestId"]).toBe("string");
});
it.each(["/app/live", "/app/previews/work"])("LIVE-ROUTE PARITY %s keeps lesson choice/edit/undo/bulk-send", async route => {
 const f = mount(route + "?task=lessons%3Aweb", "work-lessons-batch", { status: 200, body: { results: [{ lessonId: "les_pend0001", ok: true, status: "active" }] } });
 const batch = await screen.findByTestId("lesson-batch");
 fireEvent.click(await within(batch).findByRole("radio", { name: /Edit/u }));
 expect(within(batch).getByRole("textbox", { name: "Title" })).toBeTruthy();
 fireEvent.click(within(batch).getByRole("button", { name: "Undo" }));
 fireEvent.click(within(batch).getByRole("button", { name: "Keep the rest" }));
 fireEvent.click(within(batch).getByRole("button", { name: "Send decision" }));
 await waitFor(() => expect(f.writes()).toHaveLength(1));
 expect(f.writes()[0]).toMatchObject({ path: "/v1/app/projects/web/lessons/decisions", body: { decisions: [{ lessonId: "les_pend0001", version: 1, decision: "keep" }] } });
});
it.each(["/app/inbox", "/app/previews/inbox"])("LIVE-ROUTE PARITY %s marks read with the same ids", async route => {
 const f = mount(route, "inbox-updates-populated", { status: 200, body: { marked: 1 } });
 fireEvent.click(await screen.findByRole("button", { name: "Mark all as read" }));
 await waitFor(() => expect(f.writes()).toHaveLength(1));
 expect(f.writes()[0]).toMatchObject({ path: "/v1/app/inbox/read", body: { ids: ["ses_aaaaaaaaaaaaaaaaaaaa.needs_you.1763208000000"] } });
});

// The shared TaskPane answer (WIRING-2) re-reads the task's session and sends only while its Understand round and revision still match what the row showed.
function questionRound(revision: number, rounds: number): ApiResponse {
 const session = understandSession({ revision });session.sessionId = QUESTION_SESSION;
 if (session.body.kind !== "task" || session.body.task.workflow?.intent === undefined) throw new Error("Expected a question round");
 session.body.task.taskId = ID.plan;session.body.task.workflow.taskId = ID.plan;session.body.task.workflow.intent.rounds = rounds;
 return { status: 200, body: { session } };
}
type Replies = Record<string, ApiResponse>;
const goodDecision = { status: 200, body: { cardId: CARDS[0]!.id, outcome: "approved", remainingTabs: [] } };
const lessonResult = { status: 200, body: { results: [{ lessonId: "les_pend0001", ok: true, status: "active" }] } };
const matrix = [
 { name: "Open evidence", source: "/v1/app/decisions", setup: (replies: Replies) => { replies["/v1/app/decisions"] = { status: 200, body: decisionsView([{ ...CARDS[0]!, risk: "medium", friction: { ...CARDS[0]!.friction, expandEvidenceFirst: true } }]) }; }, prepare: async () => { await screen.findByText("Open the evidence to approve", { selector: "summary" }); }, press: () => { const details = screen.getByText("Open the evidence to approve", { selector: "summary" }).parentElement as HTMLDetailsElement;details.open = true;fireEvent(details, new Event("toggle", { bubbles: true })); }, path: "/v1/app/decisions/approve_plan/" + ID.plan + "/evidence-opened", answer: { status: 200, body: { cardId: CARDS[0]!.id, opened: true, recorded: true } } },
 { name: "Approve", source: "/v1/app/decisions", setup: () => undefined, prepare: async () => { await screen.findByRole("button", { name: "Approve plan v1" }); }, press: () => fireEvent.click(screen.getByRole("button", { name: "Approve plan v1" })), path: "/v1/app/decisions/approve_plan/" + ID.plan + "/approve", answer: goodDecision },
 { name: "Request changes", source: "/v1/app/decisions", setup: (replies: Replies) => { replies["/v1/app/decisions"] = { status: 200, body: { ...decisionsView([CARDS[0]!]), cards: [{ ...CARDS[0]!, actions: [...CARDS[0]!.actions, { kind: "request_changes", label: "Request changes", method: "POST", href: "/v1/app/decisions/approve_plan/" + ID.plan + "/request-changes" }] }] } }; }, prepare: async () => { fireEvent.click(await screen.findByText("Request changes", { selector: "summary" }));fireEvent.change(screen.getByRole("textbox", { name: "What should change?" }), { target: { value: "Add the missing test." } }); }, press: () => fireEvent.click(screen.getByRole("button", { name: "Send back for changes" })), path: "/v1/app/decisions/approve_plan/" + ID.plan + "/request-changes", answer: goodDecision },
 { name: "Reject", source: "/v1/app/decisions", setup: () => undefined, prepare: async () => { fireEvent.click(await screen.findByText("Not now", { selector: "summary" })); }, press: () => fireEvent.click(screen.getByRole("button", { name: "Not now" })), path: "/v1/app/decisions/approve_plan/" + ID.plan + "/reject", answer: { status: 200, body: { ...goodDecision.body, outcome: "rejected" } } },
 ...["keep", "edit", "drop"].map(choice => ({ name: "Lesson " + choice, scene: "work-lessons-batch", selection: "lessons%3Aweb", source: "/v1/app/lessons/inbox", setup: () => undefined, prepare: async () => {
  const batch = await screen.findByTestId("lesson-batch");fireEvent.click(await within(batch).findByRole("radio", { name: new RegExp(choice, "iu") }));
  if (choice === "edit") { fireEvent.change(within(batch).getByRole("textbox", { name: "Title" }), { target: { value: "Edited title" } });fireEvent.change(within(batch).getByRole("textbox", { name: "What Rovara should do" }), { target: { value: "Use safe retries." } }); }
  if (choice === "drop") fireEvent.change(within(batch).getByRole("combobox", { name: "Why drop it" }), { target: { value: "too_narrow" } });
 }, press: () => fireEvent.click(screen.getByRole("button", { name: "Send decision" })), path: "/v1/app/projects/web/lessons/decisions", answer: lessonResult })),
 { name: "Criterion answer", source: "/v1/app/sessions", setup: (replies: Replies) => { replies["/v1/app/sessions/" + QUESTION_SESSION] = questionRound(4, 2);replies["/v1/app/sessions"] = { status: 200, body: { tasks: [task(ID.plan, "Answerable spec", { sessionId: QUESTION_SESSION, workflow: { stage: "PLAN_REVIEW", state: "WAITING", revision: 4, round: 2, path: "QUICK" } })] } }; }, prepare: async () => { await within(await screen.findByRole("region", { name: "Spec" })).findByRole("button", { name: "Yes, behind a flag" }); }, press: () => fireEvent.click(within(screen.getByRole("region", { name: "Spec" })).getByRole("button", { name: "Yes, behind a flag" })), path: "/v1/app/sessions/" + QUESTION_SESSION + "/answers", answer: { status: 200, body: { ok: true } } },
 { name: "Decision answer", source: "/v1/app/sessions", setup: (replies: Replies) => { replies["/v1/app/sessions/" + QUESTION_SESSION] = questionRound(4, 2);replies["/v1/app/decisions"] = { status: 200, body: decisionsView([{ ...CARDS[2]!, id: "answer_question:" + ID.plan + "_Q1", taskId: ID.plan }]) };replies["/v1/app/sessions"] = { status: 200, body: { tasks: [task(ID.plan, "Answerable spec", { sessionId: QUESTION_SESSION, workflow: { stage: "PLAN_REVIEW", state: "WAITING", revision: 4, round: 2, path: "QUICK" } })] } }; }, prepare: async () => { await within(await screen.findByRole("region", { name: "Question for you" })).findByRole("button", { name: "Yes, behind a flag" }); }, press: () => fireEvent.click(within(screen.getByRole("region", { name: "Question for you" })).getByRole("button", { name: "Yes, behind a flag" })), path: "/v1/app/sessions/" + QUESTION_SESSION + "/answers", answer: { status: 200, body: { ok: true } } },
 { name: "Understand answer", scene: "work-inline-round", selection: ID.question, source: "/v1/app/sessions", setup: () => undefined, prepare: async () => { fireEvent.click(await screen.findByRole("radio", { name: "Block" })); }, press: () => fireEvent.click(screen.getByRole("button", { name: "Send answers" })), path: "/v1/app/tasks/" + ID.question + "/answers", answer: { status: 200, body: { ok: true } } },
 { name: "Not helpful", source: "/v1/app/projects/web/tasks/" + ID.plan + "/lessons", setup: (replies: Replies) => { replies["/v1/app/projects/web/tasks/" + ID.plan + "/lessons"] = { status: 200, body: { lessons: [{ stage: "IMPLEMENT", round: 1, lessonId: "les_logs0001", version: 1, why: "scope", citation: "valid", visible: true, title: "Log request ids", canMark: true }] } }; }, prepare: async () => { await screen.findByRole("button", { name: "Not helpful: Log request ids" }); }, press: () => fireEvent.click(screen.getByRole("button", { name: "Not helpful: Log request ids" })), path: "/v1/app/projects/web/tasks/" + ID.plan + "/lessons/les_logs0001/not-helpful", answer: { status: 200, body: { ok: true } } },
 { name: "Mark all read", inbox: true, scene: "inbox-updates-populated", source: "/v1/app/inbox", setup: () => undefined, prepare: async () => { await screen.findByRole("button", { name: "Mark all as read" }); }, press: () => fireEvent.click(screen.getByRole("button", { name: "Mark all as read" })), path: "/v1/app/inbox/read", answer: { status: 200, body: { marked: 1 } } },
 { name: "Open unread update", inbox: true, scene: "inbox-updates-populated", source: "/v1/app/inbox", setup: () => undefined, prepare: async () => { await screen.findByTestId("inbox-row"); }, press: () => fireEvent.click(within(screen.getByTestId("inbox-row")).getByRole("link"), { ctrlKey: true }), path: "/v1/app/inbox/read", answer: { status: 200, body: { marked: 1 } } },
];
for (const action of matrix) {
 for (const preview of [false, true]) it(`LIVE-ROUTE PARITY ${action.name} ${preview ? "via the old preview address" : "on the real route"} sends once with the exact target`, async () => {
  const route = (preview ? "/app/previews/" : "/app/") + ("inbox" in action ? "inbox" : preview ? "work" : "live"); // the real route, and the old preview address that now redirects to it
  const f = mount(route + ("inbox" in action ? "" : "?task=" + ("selection" in action ? action.selection : ID.plan)), "scene" in action ? action.scene : "work-all", action.answer, action.setup);
  await action.prepare();action.press();await waitFor(() => expect(f.writes()).toHaveLength(1));
  expect(f.writes()[0]?.path).toBe(action.path);
  if (action.name === "Approve") await waitFor(() => expect(new URLSearchParams(f.router.state.location.search).get("task")).not.toBe(ID.plan));
  if (action.name === "Criterion answer") { await waitFor(() => expect(f.query.isFetching()).toBe(0));await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });expect(new URLSearchParams(f.router.state.location.search).get("task")).toBe(ID.plan); }
  const body = f.writes()[0]?.body as Record<string, unknown>;
  if (action.name === "Criterion answer") expect(body).toMatchObject({ round: 2, revision: 4, answers: [{ questionId: "Q1", optionId: "yes" }] });
  if (action.name === "Understand answer") expect(body).toMatchObject({ round: 2, revision: 2, answers: [{ questionId: "q1", optionId: "a" }] });
  if (action.name === "Request changes") expect(body["reason"]).toBe("Add the missing test.");
  if (action.name === "Reject") expect(body["reason"]).toBe("not_now");
 });
 for (const state of ["refused", "stale", "no permission"] as const) it(`${action.name} ${state} at send time sends zero`, async () => {
  const f = mount("/app/" + ("inbox" in action ? "inbox" : "live?task=" + ("selection" in action ? action.selection : ID.plan)), "scene" in action ? action.scene : "work-all", action.answer, action.setup);
  await action.prepare();await waitFor(() => expect(f.query.isFetching()).toBe(0));
  if (state === "refused") f.replies[action.source] = { status: 403, body: { error: { code: "FORBIDDEN", message: "Your access ended." } } };
  else if (state === "stale") f.replies[action.source] = { status: 200, body: { ...f.replies[action.source]!.body as object, tasks: [], cards: [], batches: [], lessons: [], items: [] } };
  else f.replies["/v1/app/me"] = { status: 403, body: { error: { code: "FORBIDDEN", message: "You no longer belong to this company." } } };
  action.press();await waitFor(() => expect(f.view.container.textContent).toMatch(/changed|access|couldn't|confirm|longer/iu));
  expect(f.writes()).toHaveLength(0);
 });
}
for (const action of matrix) for (const status of [409, 503]) it(`${action.name} ${status === 409 ? "unlisted 4xx keeps" : "unknown outcome keeps"} the send lock`, async () => {
 const outcome = { status, body: { error: { code: "REFUSED", message: "The server refused this request." } } };
 const f = mount("/app/" + ("inbox" in action ? "inbox" : "live?task=" + ("selection" in action ? action.selection : ID.plan)), "scene" in action ? action.scene : "work-all", outcome, action.setup);
 await action.prepare();action.press();
 await waitFor(() => expect(f.writes()).toHaveLength(1));
 await waitFor(() => expect(f.view.container.textContent).toContain("Rovara didn't confirm this yet."));
 await waitFor(() => expect(f.query.isFetching()).toBe(0));
 // The shared decision card (WIRING-2) takes its sender away or disables it while the outcome is unknown and offers Check instead, so a second press finds no live sender.
 try { action.press(); } catch { /* the sender is gone: that is the lock */ }
 await waitFor(() => expect(f.view.container.textContent).toMatch(/Check its outcome|Check this decision before trying again/u));expect(f.writes()).toHaveLength(1);
});

// Cloud has no design-spend route: advertised choices stay hidden on Work, including its old address.
// Keep all four choices and all seven prior matrix scenarios as no-send regressions.
for (const choice of ["lower-tier", "raise-cap", "run-unpriced", "skip"]) for (const state of ["ready", "preview", "refused", "stale", "no permission", 409, 503] as const) it(`Spend ${choice} ${state}: Work hides the unsupported choice and sends nothing`, async () => {
 const f = mount((state === "preview" ? "/app/previews/work" : "/app/live") + "?task=" + ID.plan, "work-all", { status: typeof state === "number" ? state : 200, body: { ok: true } }, replies => {
  replies["/v1/app/org/spend"] = { status: 200, body: { remainingUsd: 100 } };
  replies["/v1/app/decisions"] = { status: 200, body: decisionsView([{ ...CARDS[0]!, id: "approve_spend:" + ID.plan, kind: "approve_spend", actions: [{ kind: "choose", label: "Choose " + choice, method: "POST", href: "/v1/app/tasks/" + ID.plan + "/design-review/spend/" + choice }] }]) };
 });
 await screen.findByRole("region", { name: "Spend request" });
 await waitFor(() => expect(f.query.isFetching()).toBe(0));
 expect(screen.queryByRole("button", { name: "Choose " + choice, hidden: true })).toBeNull();
 if (state === "refused") f.replies["/v1/app/decisions"] = { status: 403, body: { error: { code: "FORBIDDEN", message: "Your access ended." } } };
 else if (state === "stale") f.replies["/v1/app/decisions"] = { status: 200, body: decisionsView([]) };
 else if (state === "no permission") f.replies["/v1/app/me"] = { status: 403, body: { error: { code: "FORBIDDEN", message: "You no longer belong to this company." } } };
 if (state === "refused" || state === "stale" || state === "no permission") await act(async () => { await f.query.invalidateQueries(); });
 expect(screen.queryByRole("button", { name: "Choose " + choice, hidden: true })).toBeNull();
 expect(f.writes()).toHaveLength(0);
});

it("identity refetch failure cannot reuse the earlier identity for a send", async () => {
 const f = mount("/app/live?task=" + ID.plan);await screen.findByRole("button", { name: "Approve plan v1" });
 await waitFor(() => expect(f.query.getQueryState(["queue", "identity"])?.status).toBe("success"));
 await act(async () => { f.query.getQueryCache().find({ queryKey: ["queue", "identity"] })!.setState({ status: "error", fetchFailureCount: 1 }); });
 fireEvent.click(screen.getByRole("button", { name: "Approve plan v1" }));await screen.findByText("The information or your access changed. Load again before making a change.");expect(f.writes()).toHaveLength(0);
});
it("pending outcomes are scoped to the current company and person and react to storage events", async () => {
 const me = meFixture(), prefix = "rovara:queue-action:";
 localStorage.setItem(prefix + JSON.stringify([me.org.orgId, "b".repeat(64), "inbox"]), "unknown");
 const f = mount("/app/inbox");await waitFor(() => expect(f.query.getQueryState(["queue", "identity"])?.status).toBe("success"));
 expect(screen.queryByRole("button", { name: "Check current state" })).toBeNull();
 act(() => { localStorage.setItem(prefix + JSON.stringify([me.org.orgId, me.developer.id, "inbox"]), "unknown");window.dispatchEvent(new StorageEvent("storage")); });
 expect(await screen.findByRole("button", { name: "Check current state" })).toBeTruthy();expect(f.writes()).toHaveLength(0);
 act(() => { f.query.getQueryCache().find({ queryKey: ["queue", "identity"] })!.setState({ status: "error", fetchFailureCount: 1 }); });
 await waitFor(() => expect(screen.queryByRole("button", { name: "Check current state" })).toBeNull());
});

it("a failed lesson-batch refresh retains the proposed text and disables its existing controls", async () => {
 const f = mount("/app/live?task=lessons%3Aweb", "work-lessons-batch", lessonResult);
 const batch = await screen.findByTestId("lesson-batch");await within(batch).findByRole("radio", { name: /Keep/u });
 await waitFor(() => expect(batch.closest("fieldset")?.disabled).toBe(false));
 f.request.mockImplementation(async input => { if (input.path === "/v1/app/lessons/inbox") throw new (await import("../../packages/ui/src/api/errors.js")).ApiError(503, "INTERNAL_ERROR", "Lesson refresh failed.");return f.replies[input.path.split("?")[0]!] ?? { status: 404, body: { error: { code: "NOT_FOUND", message: "route not found" } } }; });
 await act(async () => { await f.query.invalidateQueries({ queryKey: ["learned", "inbox"] }); });
 await waitFor(() => expect(batch.closest("fieldset")?.disabled).toBe(true));expect(batch.textContent).toContain("Retry only idempotent calls");expect(f.writes()).toHaveLength(0);
});
it("Mark all as read preserves every fifty-id batch after the preceding batch changes the list", async () => {
 const items = Array.from({ length: 51 }, (_, index) => ({ id: "ses_aaaaaaaaaaaaaaaaaaaa.needs_you." + String(1763208000000 + index), kind: "needs_you", title: "Update " + String(index), status: "Waiting.", at: "2026-11-15T11:00:00.000Z", read: false, open: "/s/ses_aaaaaaaaaaaaaaaaaaaa" }));
 const f = mount("/app/inbox", "inbox-updates-populated", { status: 200, body: { marked: 1 } }, replies => { replies["/v1/app/inbox"] = { status: 200, body: { items, unread: 51 } }; });
 f.request.mockImplementation(async input => {
  if (input.method === "POST") { const ids = (input.body as { ids: string[] }).ids;for (const item of items) if (ids.includes(item.id)) item.read = true;f.replies["/v1/app/inbox"] = { status: 200, body: { items: items.map(item => ({ ...item })), unread: items.filter(item => !item.read).length } };return { status: 200, body: { marked: ids.length } }; }
  return f.replies[input.path.split("?")[0]!] ?? { status: 404, body: { error: { code: "NOT_FOUND", message: "route not found" } } };
 });
 fireEvent.click(await screen.findByRole("button", { name: "Mark all as read" }));
 await waitFor(() => expect(f.writes()).toHaveLength(2));
 expect(f.writes().map(input => (input.body as { ids: string[] }).ids.length)).toEqual([50, 1]);
 await waitFor(() => expect(screen.getByTestId("inbox-badge").textContent).toBe(""));
 await waitFor(() => expect(screen.queryByRole("button", { name: "Mark all as read" })).toBeNull());
});

for (const route of ["/app/live", "/app/previews/work"]) for (const merging of [false, true]) it(`confirmation-page parity ${route} merge=${String(merging)}`, async () => {
 const card = merging ? { ...CARDS[1]!, risk: "low" as const, friction: { expandEvidenceFirst: false, freshSignIn: false, secondPerson: false } } : CARDS[0]!;
 const confirmUrl = "https://cell.example/v1/app/approve/apr_aaaaaaaaaaaaaaaaaaaa";
 const f = mount(route + "?task=" + card.taskId, "work-all", { status: 200, body: { cardId: card.id, outcome: "needs_confirmation", confirmUrl, ...(merging ? { merging: [{ repositoryId: "repo", number: 42, baseBranch: "main" }] } : {}) } }, replies => { replies["/v1/app/decisions"] = { status: 200, body: decisionsView([card]) }; });
 fireEvent.click(await screen.findByRole("button", { name: merging ? "Merge" : "Approve plan v1" }));
 if (merging) await screen.findByText(/Merge #42 into main\?/u);
 else await screen.findByRole("button", { name: "Confirm on the next page" });
 expect(f.writes()).toHaveLength(1);
});
// A 202 needs_confirmation passes through to the live handler with its request id (controller Opus F1 on Work+Inbox, PASS 8d8c364c4): the merge prompt or the confirm link shows, the lock stays.
for (const route of ["/app/live", "/app/previews/work"]) for (const merging of [false, true]) it(`202 confirmation parity ${route} merge=${String(merging)}`, async () => {
 const card = merging ? { ...CARDS[1]!, risk: "low" as const, friction: { expandEvidenceFirst: false, freshSignIn: false, secondPerson: false } } : CARDS[0]!;
 const confirmUrl = "https://cell.example/v1/app/approve/apr_aaaaaaaaaaaaaaaaaaaa";
 const f = mount(route + "?task=" + card.taskId, "work-all", { status: 202, body: { cardId: card.id, outcome: "needs_confirmation", confirmUrl, ...(merging ? { merging: [{ repositoryId: "repo", number: 42, baseBranch: "main" }] } : {}) } }, replies => { replies["/v1/app/decisions"] = { status: 200, body: decisionsView([card]) }; });
 fireEvent.click(await screen.findByRole("button", { name: merging ? "Merge" : "Approve plan v1" }));
 if (merging) await screen.findByText(/Merge #42 into main\?/u);
 else await screen.findByRole("button", { name: "Confirm on the next page" });
 expect(f.writes()).toHaveLength(1);
 const record = JSON.parse(localStorage.getItem(Object.keys(localStorage).find(key => key.startsWith("rovara:queue-action:"))!)!) as { request: { body: { requestId: string } } };
 expect(record.request.body.requestId).toBe((f.writes()[0]!.body as { requestId: string }).requestId);
});
// Only a genuinely unknown 202 (not a confirmation request for this card) shows Check and offers no second send.
for (const [name, body] of [["an approved-shaped body", (id: string) => ({ cardId: id, outcome: "approved", remainingTabs: [] })], ["another card's confirmation", () => ({ cardId: "approve_plan:99999999-9999-4999-8999-999999999999", outcome: "needs_confirmation", confirmUrl: "https://cell.example/v1/app/approve/apr_aaaaaaaaaaaaaaaaaaaa" })]] as const) it(`a 202 with ${name} is unknown: Check, no second send`, async () => {
 const card = CARDS[0]!;
 const f = mount("/app/live?task=" + card.taskId, "work-all", { status: 202, body: body(card.id) }, replies => { replies["/v1/app/decisions"] = { status: 200, body: decisionsView([card]) }; });
 fireEvent.click(await screen.findByRole("button", { name: "Approve plan v1" }));
 await screen.findByRole("button", { name: "Check" });
 await waitFor(() => expect(f.view.container.textContent).toContain("Rovara didn't confirm this yet."));
 expect(screen.queryByRole("button", { name: "Confirm on the next page" })).toBeNull();
 expect(screen.queryByRole("button", { name: "Approve plan v1" })).toBeNull();
 expect(f.writes()).toHaveLength(1);
});
// The peek shares WIRING-2's rules for what it may offer: an unconfirmed answer is said in the peek itself, and a plan decision is not offered while its plan cannot be read.
it("an unconfirmed spec answer is said in the peek itself, with its own Check", async () => {
 const action = matrix.find(entry => entry.name === "Criterion answer")!;
 const f = mount("/app/live?task=" + ID.plan, "work-all", { status: 503, body: { error: { code: "REFUSED", message: "The server refused this request." } } }, action.setup);
 await action.prepare();action.press();
 await waitFor(() => expect(f.writes()).toHaveLength(1));
 await waitFor(() => expect(f.view.container.textContent).toContain("Check its current state before acting again."));
 for (let check = 0; check < 3; check++) await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Check" })); });
 expect(screen.getByRole("link", { name: "Open the task to check" }).getAttribute("href")).toBe("/app/sessions/" + QUESTION_SESSION);
 expect(f.writes()).toHaveLength(1);
});
it.each([500, 403])("a plan decision is not offered in the peek while its plan read fails with %s", async status => {
 const f = mount("/app/live?task=" + ID.plan, "work-all", goodDecision, replies => { replies["/v1/app/tasks/" + ID.plan + "/documents/plan"] = { status, body: { error: { code: status === 403 ? "FORBIDDEN" : "RUNTIME_UNAVAILABLE", message: "The plan could not be read." } } }; });
 await screen.findByRole("region", { name: "Selected task" });
 await waitFor(() => expect(f.query.getQueryState(["work", "plan", ID.plan])?.status).toBe("error"), { timeout: 6000 });
 // The peek has settled on the failed plan (its own retry is drawn) before the absence is checked.
 await within(screen.getByRole("region", { name: "Selected task" })).findByRole("button", { name: "Read the plan again" });
 expect(screen.queryByRole("button", { name: /^Approve plan/u })).toBeNull();
 expect(f.writes()).toHaveLength(0);
});
it("a failed queue identity read is refetched and action authority recovers", async () => {
 const f = mount("/app/live?task=" + ID.plan);await screen.findByRole("button", { name: "Approve plan v1" });
 await act(async () => { f.query.getQueryCache().find({ queryKey: ["queue", "identity"] })!.setState({ status: "error", error: new Error("Transient identity failure"), fetchFailureCount: 1 }); });
 await waitFor(() => expect(f.query.getQueryState(["queue", "identity"])?.status).toBe("success"), { timeout: 6500 });
 fireEvent.click(screen.getByRole("button", { name: "Approve plan v1" }));await waitFor(() => expect(f.writes()).toHaveLength(1));
});
it.each(["ACCESS_ENDED", "FORBIDDEN"])("Inbox 404 %s describes access ending", async code => {
 mount("/app/inbox", "inbox-updates-populated", undefined, replies => { replies["/v1/app/inbox"] = { status: 404, body: { error: { code, message: "Your access ended." } } }; });
 await screen.findByText(/Your access ended/u);
 expect(screen.queryByText(/Inbox not available on this install/u)).toBeNull();
});
