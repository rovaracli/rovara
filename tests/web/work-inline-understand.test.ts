// @vitest-environment jsdom
// Understand's questions answered from the Work list and Home (Code #1057's round on each `?detail=1` row). The rows are Code's REAL rows (tests/fixtures/code-inline-understand.json),
// which Cloud's list passes on with the same round, outcome and workflow fields (tests/unit/cloud-server-inline-understand.test.ts proves Cloud's answer for them): the questions show inline with option buttons (the recommended one marked) and free text, the answers go to
// `POST /v1/app/tasks/{taskId}/answers` with the row's workflow revision and round (the session page's body), the row is read again after, a row with no round sends the person to the
// task's page, and the workflow's outcome is a short label on the row.
import { afterEach, expect, it } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import type { ApiRequest, ApiResponse } from "../../packages/ui/src/host.js";
import { AppHostProvider } from "../../packages/ui/src/host.js";
import { Announcer } from "../../packages/ui/src/design/Announcer.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { asksOnItsPage, openRoundOf, readRound, readTaskList, workRow } from "../../packages/ui/src/api/work.js";
import { InboxRow, WorkList } from "../../packages/ui/src/screens/work/WorkList.js";
import { QuietCard } from "../../packages/ui/src/screens/work/TaskPane.js";
import { WorkScreen } from "../../packages/ui/src/screens/work/WorkScreen.js";
import { HomeScreen } from "../../packages/ui/src/screens/home/HomeScreen.js";
import { readFileSync } from "node:fs";
import { renderUi } from "./support/render.js";
import { expectNoAxeViolations } from "./support/axe.js";
import { fakeHost } from "./support/fake-host.js";
import { h } from "./support/h.js";
import { navFixture } from "./support/fixtures.js";
import { decisionsView } from "./support/work-fixture.js";

interface Answer { status: number; body: Record<string, unknown> }
const F = JSON.parse(readFileSync("tests/fixtures/code-inline-understand.json", "utf8")) as Record<"waitingList" | "answeredList" | "closedList" | "noAccessList" | "staleAnswer" | "noAccessAnswer", Answer> & { taskId: string; noAccessTaskId: string; round: number; revision: number };
/** Cloud's list answer for Code's detailed list: for these rows, Code's own fields (the server test checks Cloud passes them on). */
const cloudList = (code: Answer) => ({ status: 200, body: { tasks: code.body["tasks"] as Array<Record<string, unknown>> } });
const NOT_FOUND = { status: 404, body: { error: { code: "NOT_FOUND", message: "route not found" } } };
let close: (() => void) | undefined;
afterEach(() => { close?.();close = undefined; });

function mount(screenOf: "work" | "home", list: { current: ApiResponse }, post: (request: ApiRequest) => Promise<ApiResponse>) {
 const f = fakeHost(async request => {
  const path = request.path.split("?")[0]!;
  if (request.method === "POST" && path.endsWith("/answers")) return post(request);
  if (path === "/v1/app/sessions") return list.current;
  if (path === "/v1/app/involved") return { status: 200, body: { tasks: [] } };
  if (path === "/v1/app/decisions") return { status: 200, body: decisionsView([]) };
  if (path === "/v1/app/nav") return { status: 200, body: navFixture({ projects: [] }) };
  if (path === "/v1/app/home") return { status: 200, body: { cards: [], total: 0 } };
  if (path.endsWith("/documents/plan") || path.endsWith("/evidence") || path.endsWith("/events") || path.endsWith("/comments")) return NOT_FOUND;
  return { status: 200, body: { notices: [], next: "settled" } };
 });
 const query = createQueryClient();
 const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(MemoryRouter, { initialEntries: [screenOf === "work" ? "/app/live" : "/app"], children: h(Announcer, { children: h(screenOf === "work" ? WorkScreen : HomeScreen, {}) }) }) }) }));
 close = () => { ui.unmount();query.clear(); };
 const posts = () => f.request.mock.calls.filter(([request]) => request.method === "POST").map(([request]) => request);
 const listReads = () => f.request.mock.calls.filter(([request]) => request.method === "GET" && request.path.split("?")[0] === "/v1/app/sessions").length;
 return { ...f, ...ui, posts, listReads };
}
const questions = () => screen.findByRole("region", { name: "Questions from Rovara: Core work" });
function answerBoth(region: HTMLElement) {
 fireEvent.click(within(region).getByRole("radio", { name: /\/healthz/u }));
 fireEvent.change(within(region).getByLabelText("Anything the check must not touch?"), { target: { value: "Leave the database alone." } });
}

it("reads Cloud's round from Code's real rows; a row is answerable inline only while a question is unanswered and the row names its revision", () => {
 const [waiting] = readTaskList(cloudList(F.waitingList).body), [answered] = readTaskList(cloudList(F.answeredList).body), [refused] = readTaskList(cloudList(F.noAccessList).body), [closed] = readTaskList(cloudList(F.closedList).body);
 expect(openRoundOf(waiting!)).toEqual({ round: 1, revision: 3, questions: waiting!.round!.questions });
 expect(waiting!.round!.questions.map(question => question.recommended)).toEqual(["b", undefined]);
 expect(openRoundOf(answered!)).toBeUndefined();
 expect(openRoundOf({ ...waiting!, workflow: { stage: "UNDERSTAND", state: "WAITING" } })).toBeUndefined();
 // Only while Understand waits on a task that has not ended: a round a row still carries past that is not answerable.
 expect(openRoundOf({ ...waiting!, workflow: { ...waiting!.workflow!, stage: "PLAN" } })).toBeUndefined();
 expect(openRoundOf({ ...waiting!, workflow: { ...waiting!.workflow!, state: "RUNNING" } })).toBeUndefined();
 for (const status of ["CLOSED", "CANCELLED", "FAILED", "INTERRUPTED"] as const) expect(openRoundOf({ ...waiting!, status })).toBeUndefined();
 expect(refused!.round).toBeUndefined();
 expect(closed!.outcome).toBe("CLOSED");
 expect(readTaskList({ tasks: [{ ...(cloudList(F.closedList).body.tasks[0] as object), outcome: "SOMETHING" }] })[0]!.outcome).toBeUndefined();
 const real = cloudList(F.waitingList).body.tasks[0]!["round"];
 expect(readRound(real)).toEqual(waiting!.round);
 for (const bad of [{ round: 1, questions: [] }, { round: 0, questions: waiting!.round!.questions }, { round: 1, questions: [{ id: "q1", text: "x", answered: false, recommended: "a" }] }, { round: 1, questions: [{ id: "q1", text: "x" }] }]) expect(readRound(bad)).toBeUndefined();
 // The row asks the person, under Needs you, while a question waits; once answered it is Rovara's again.
 expect(workRow(waiting!, undefined, new Date("2026-11-15T12:00:00.000Z"))).toMatchObject({ group: "you", need: "Answer questions", tone: "wait" });
 expect(workRow(answered!, undefined, new Date("2026-11-15T12:00:00.000Z"))).toMatchObject({ group: "run" });
 expect(workRow(refused!, undefined, new Date("2026-11-15T12:00:00.000Z"))).toMatchObject({ group: "others" });
 // The side pane says where the questions are answered, not that a decision card is missing.
 const pane = renderUi(h(QuietCard, { row: workRow(waiting!, undefined, new Date("2026-11-15T12:00:00.000Z")), decisionsError: undefined }));
 expect(pane.container.textContent).toContain("Rovara has questions before it plans this. Answer them under this task in the list, or on the task's page.");
 expect(pane.container.textContent).not.toContain("decision card");
 pane.unmount();
});

it("Work: two tasks with questions on one page keep their fields apart", async () => {
 const OTHER = "0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f";
 const rows = readTaskList({ tasks: [...cloudList(F.waitingList).body.tasks, JSON.parse(JSON.stringify(cloudList(F.waitingList).body.tasks[0]).replaceAll(F.taskId, OTHER).replace("Core work", "Other work")) as Record<string, unknown>] }).map(task => workRow(task, undefined, new Date("2026-11-15T12:00:00.000Z")));
 const ui = renderUi(h(MemoryRouter, { children: h(AppHostProvider, { host: fakeHost().host, children: h(QueryClientProvider, { client: createQueryClient(), children: h(WorkList, { rows, selectedId: undefined, onSelect: () => undefined }) }) }) }));
 const ids = [...ui.container.querySelectorAll("[id]")].map(element => element.id);
 expect(new Set(ids).size).toBe(ids.length);
 const names = new Set([...ui.container.querySelectorAll<HTMLInputElement>("input[type=radio]")].map(radio => radio.name));
 expect(names.size).toBe(2);
 const first = screen.getByRole("region", { name: "Questions from Rovara: Core work" }), second = screen.getByRole("region", { name: "Questions from Rovara: Other work" });
 fireEvent.click(within(first).getByRole("radio", { name: /\/healthz/u }));
 expect(within(second).getByRole<HTMLInputElement>("radio", { name: /\/healthz/u }).checked).toBe(false);
 await expectNoAxeViolations(ui.container);
 ui.unmount();
});

it("Work: the questions show under the row, the recommended option marked; the answers go with the row's revision and round, and the list is read again", async () => {
 const list = { current: cloudList(F.waitingList) as ApiResponse };
 const f = mount("work", list, async request => { list.current = cloudList(F.answeredList);void request;return { status: 200, body: { taskId: F.taskId, answered: true } }; });
 const region = await questions();
 expect(within(region).getByRole("heading").textContent).toBe("Rovara has 2 questions before it plans this");
 expect(within(region).getByRole("group", { name: "Which path should the health check answer on?" }).textContent).toContain("/healthz Recommended");
 expect(within(region).getAllByRole("radio").map(radio => (radio as HTMLInputElement).value)).toEqual(["a", "b"]);
 // Nothing answered yet: the form asks for every answer and sends nothing.
 fireEvent.click(within(region).getByRole("button", { name: "Send answers" }));
 expect((await within(region).findByRole("alert")).textContent).toMatch(/every question/iu);
 expect(f.posts()).toHaveLength(0);
 await expectNoAxeViolations(f.container);
 answerBoth(region);
 const before = f.listReads();
 fireEvent.click(within(region).getByRole("button", { name: "Send answers" }));
 await waitFor(() => expect(f.posts()).toHaveLength(1));
 const sent = f.posts()[0]!;
 expect(sent.path).toBe(`/v1/app/tasks/${F.taskId}/answers`);
 expect(sent.body).toMatchObject({ round: F.round, revision: F.revision, answers: [{ questionId: "q1", optionId: "b" }, { questionId: "q2", text: "Leave the database alone." }] });
 expect((sent.body as { requestId: string }).requestId).toMatch(/^[0-9a-f-]{36}$/u);
 await waitFor(() => expect(f.listReads()).toBeGreaterThan(before));
 await waitFor(() => expect(screen.queryByRole("region", { name: "Questions from Rovara: Core work" })).toBeNull());
 // The row moved on with its note; the page says it (the announcer speaks after its own short delay).
 await waitFor(() => expect(document.querySelector("[aria-live=polite]")?.textContent).toBe("Core work: Answers sent. Rovara is working on your request."), { timeout: 3000 });
});

it("Work: keys typed in an answer are the field's; j and k still move the list from a row", async () => {
 const list = { current: cloudList(F.waitingList) as ApiResponse };
 mount("work", list, async () => ({ status: 200, body: {} }));
 const region = await questions(), field = within(region).getByLabelText("Anything the check must not touch?");
 const event = new KeyboardEvent("keydown", { key: "j", bubbles: true, cancelable: true });
 field.dispatchEvent(event);
 expect(event.defaultPrevented).toBe(false);
 const send = within(region).getByRole("button", { name: "Send answers" });
 const onButton = new KeyboardEvent("keydown", { key: "j", bubbles: true, cancelable: true });
 send.dispatchEvent(onButton);
 expect(onButton.defaultPrevented).toBe(false);
 const row = document.querySelector<HTMLElement>(`[data-task-id="${F.taskId}"].rv-inbox-row`)!;
 const onRow = new KeyboardEvent("keydown", { key: "j", bubbles: true, cancelable: true });
 row.dispatchEvent(onRow);
 expect(onRow.defaultPrevented).toBe(true);
});

it("Work: Code's 'not waiting' says the questions were already answered and reads the list again; any other refusal is shown as Code worded it", async () => {
 const list = { current: cloudList(F.waitingList) as ApiResponse };
 let reply: Answer = F.staleAnswer;
 const f = mount("work", list, async () => reply);
 let region = await questions();
 answerBoth(region);
 const before = f.listReads();
 fireEvent.click(within(region).getByRole("button", { name: "Send answers" }));
 expect((await within(region).findByRole("status")).textContent).toBe("These questions were already answered.");
 await waitFor(() => expect(f.listReads()).toBeGreaterThan(before));
 reply = F.noAccessAnswer;
 region = await questions();
 fireEvent.click(within(region).getByRole("button", { name: "Send answers" }));
 expect((await within(region).findByRole("alert")).textContent).toBe((F.noAccessAnswer.body["error"] as { message: string }).message);
});

it("Work: a row Understand waits on with no round sends the person to the task's page; a finished one shows its outcome as a label", async () => {
 const list = { current: cloudList(F.noAccessList) as ApiResponse };
 mount("work", list, async () => ({ status: 200, body: {} }));
 const fallback = await screen.findByTestId("questions-on-page");
 expect(within(fallback).getByRole("link", { name: "Answer them on the task's page" }).getAttribute("href")).toBe(`/app/sessions/${F.noAccessTaskId}`);
 expect(screen.queryByRole("radio")).toBeNull();
 const [refusedRow] = readTaskList(cloudList(F.noAccessList).body);
 expect(asksOnItsPage(refusedRow!)).toBe(true);
 for (const status of ["CLOSED", "CANCELLED", "FAILED", "INTERRUPTED"] as const) expect(asksOnItsPage({ ...refusedRow!, status })).toBe(false);
 close?.();close = undefined;
 const [closed] = readTaskList(cloudList(F.closedList).body);
 const ui = renderUi(h(MemoryRouter, { children: h(AppHostProvider, { host: fakeHost().host, children: h(QueryClientProvider, { client: createQueryClient(), children: h("ul", {}, h(InboxRow, { row: workRow(closed!, undefined, new Date("2026-11-15T12:00:00.000Z")), selected: false, onSelect: () => undefined })) }) }) }));
 expect(ui.container.querySelector("[data-outcome]")?.textContent).toBe("Closed");
 expect(ui.container.querySelector("[data-testid=inline-questions], [data-testid=questions-on-page]")).toBeNull();
 ui.unmount();
});

it("Home: 'Rovara has questions' answers them inline, and Home never says nothing needs you while they wait", async () => {
 const list = { current: cloudList(F.waitingList) as ApiResponse };
 const f = mount("home", list, async () => { list.current = cloudList(F.answeredList);return { status: 200, body: { taskId: F.taskId, answered: true } }; });
 const section = await screen.findByRole("region", { name: "Rovara has questions" });
 const region = within(section).getByRole("region", { name: "Questions from Rovara: Core work" });
 // Let Home's lazy parts and their reads settle (Home's cards and the decisions answer empty here), then check it still does not say nothing needs you.
 await act(async () => { await new Promise(resolve => setTimeout(resolve, 100)); });
 expect(screen.queryByTestId("home-empty")).toBeNull();
 await expectNoAxeViolations(f.container);
 answerBoth(region);
 fireEvent.click(within(region).getByRole("button", { name: "Send answers" }));
 await waitFor(() => expect(f.posts().map(request => request.path)).toEqual([`/v1/app/tasks/${F.taskId}/answers`]));
 expect(f.posts()[0]!.body).toMatchObject({ round: F.round, revision: F.revision });
 await waitFor(() => expect(screen.queryByRole("region", { name: "Rovara has questions" })).toBeNull());
 expect(await screen.findByTestId("home-empty")).toBeTruthy();
});

it("Home: a task with no round to answer here is not listed, and does not stop Home saying nothing needs you (the Work list links it to its page)", async () => {
 const list = { current: cloudList(F.noAccessList) as ApiResponse };
 mount("home", list, async () => ({ status: 200, body: {} }));
 expect(await screen.findByTestId("home-empty")).toBeTruthy();
 expect(screen.queryByRole("region", { name: "Rovara has questions" })).toBeNull();
});
