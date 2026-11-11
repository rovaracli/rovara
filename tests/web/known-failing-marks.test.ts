// @vitest-environment jsdom
// KF-1: the project page's marked tests with Undo. The section exists only when the server says the list exists (vx on, a maintainer); it names no mark's person or test as markup, undoes one mark per press, shows the
// server's answer as the new list, and says plainly when a mark changed meanwhile.
import { expect, it } from "vitest";
import { act, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { KnownFailingMarksAnswerSchema } from "@agentx/cloud-contracts/web";
import { ProjectScreen } from "../../packages/ui/src/screens/project/ProjectScreen.js";
import { KnownFailingMarks } from "../../packages/ui/src/screens/project/KnownFailingMarks.js";
import { AppHostProvider, type ApiRequest, type ApiResponse } from "../../packages/ui/src/host.js";
import { Announcer } from "../../packages/ui/src/design/Announcer.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { renderUi } from "./support/render.js";
import { expectNoAxeViolations } from "./support/axe.js";
import { fakeHost } from "./support/fake-host.js";
import { h } from "./support/h.js";
import { projectFixture } from "./support/project-fixture.js";

const PATH = "/v1/app/projects/payments/known-failing";
const ME = "a".repeat(64), OTHER = "b".repeat(64);
const mark = (name: string, over: Record<string, unknown> = {}) => ({ name, checkId: "unit", markedBy: OTHER, markedByName: "Maya", markedAt: "2026-11-01T10:00:00.000Z", epoch: 2, markedByYou: false, ...over });
const answer = (marks: Array<ReturnType<typeof mark>>, max = 500) => KnownFailingMarksAnswerSchema.parse({ max, marks });
type Handler = (request: ApiRequest) => Promise<ApiResponse | undefined> | ApiResponse | undefined;

function setup(options: { marks?: Array<ReturnType<typeof mark>>; max?: number; post?: Handler; page?: boolean; knownFailing?: boolean; theme?: "light" | "dark" } = {}) {
 let state = answer(options.marks ?? [mark("tests/a.py::one"), mark("tests/b.py::two", { checkId: "lint", markedBy: ME, markedByName: "Priya", markedByYou: true, epoch: 3 })], options.max);
 const f = fakeHost(async request => {
  const path = request.path.split("?")[0];
  if (path === "/v1/app/changes") return { status: 200, body: { notices: [], next: "settled" } };
  if (path === "/v1/app/projects/payments/overview") return { status: 200, body: options.knownFailing === false ? projectFixture() : { ...projectFixture(), knownFailing: { count: state.marks.length } } };
  if (path === PATH && request.method === "GET") return { status: 200, body: state };
  if (path === PATH && request.method === "POST") {
   const custom = await options.post?.(request);
   if (custom !== undefined) return custom;
   const sent = request.body as { name: string; checkId: string };
   state = answer(state.marks.filter(m => !(m.name === sent.name && m.checkId === sent.checkId)), state.max);
   return { status: 200, body: { status: "done", ...state } };
  }
  return { status: 404, body: { error: { code: "NOT_FOUND", message: "Not found." } } };
 });
 const query = createQueryClient();
 const element = options.page === true
  ? h(MemoryRouter, { initialEntries: ["/app/projects/payments"], children: h(Announcer, { children: h(Routes, { children: h(Route, { path: "/app/projects/:name", element: h(ProjectScreen, {}) }) }) }) })
  : h(KnownFailingMarks, { project: "payments" });
 const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: element }) }), { theme: options.theme ?? "light" });
 const posts = () => f.request.mock.calls.map(([request]) => request).filter(request => request.method === "POST");
 return { ...f, ...ui, query, posts, set(next: Array<ReturnType<typeof mark>>) { state = answer(next, state.max); } };
}
const region = async () => within(await screen.findByRole("region", { name: "Tests marked as already failing" }));

it("lists each mark with its test, check, who and when, and an Undo for each", async () => {
 setup();
 const section = await region();
 expect(await section.findByText("tests/a.py::one")).toBeTruthy();
 expect(section.getByText("tests/b.py::two")).toBeTruthy();
 expect(section.getByText("2 of 500 marked")).toBeTruthy();
 expect(section.getByText("Check unit · Marked by Maya on 2026-11-01")).toBeTruthy();
 expect(section.getByText("Check lint · Marked by you on 2026-11-01")).toBeTruthy();
 expect(section.getAllByRole("button", { name: /^Undo / })).toHaveLength(2);
 expect(section.getByText("Once nightly runs are on, a mark also goes away by itself after a nightly run shows the test passing.")).toBeTruthy();
});

it("undoes one mark per press, naming it by everything stored, and shows the answer as the list", async () => {
 const f = setup();
 const section = await region();
 fireEvent.click(await section.findByRole("button", { name: "Undo tests/a.py::one" }));
 await waitFor(() => expect(section.queryByText("tests/a.py::one")).toBeNull());
 expect(f.posts()).toHaveLength(1);
 expect(f.posts()[0]!.body).toMatchObject({ action: "undo", name: "tests/a.py::one", checkId: "unit", markedBy: OTHER, markedAt: "2026-11-01T10:00:00.000Z", epoch: 2 });
 expect(typeof (f.posts()[0]!.body as { requestId: string }).requestId).toBe("string");
 expect(section.getByText("Mark removed. That test counts again.")).toBeTruthy();
 expect(section.getByText("1 of 500 marked")).toBeTruthy();
});

it("sends one undo even when two presses land before the page has redrawn", async () => {
 let release: (() => void) | undefined;
 const f = setup({ post: () => new Promise<ApiResponse>(resolve => { release = () => resolve({ status: 200, body: { status: "done", ...answer([mark("tests/b.py::two", { checkId: "lint", markedBy: ME, markedByName: "Priya", markedByYou: true, epoch: 3 })]) } }); }) });
 const section = await region();
 const first = await section.findByRole("button", { name: "Undo tests/a.py::one" }), second = section.getByRole("button", { name: "Undo tests/b.py::two" });
 act(() => { first.click();second.click(); });
 await waitFor(() => expect(f.posts()).toHaveLength(1));
 release?.();
 await waitFor(() => expect(section.queryByText("tests/a.py::one")).toBeNull());
 expect(f.posts()).toHaveLength(1);
});

it("says a mark that changed meanwhile is gone, and reads the list again", async () => {
 const f = setup({ post: () => ({ status: 409, body: { error: { code: "CHANGE_STALE", message: "That mark was already removed or changed. Reload the list." } } }) });
 const section = await region();
 f.set([mark("tests/b.py::two", { checkId: "lint", markedBy: ME, markedByName: "Priya", markedByYou: true, epoch: 3 })]);
 fireEvent.click(await section.findByRole("button", { name: "Undo tests/a.py::one" }));
 expect((await screen.findByRole("alert")).textContent).toContain("That mark was already removed or changed. The list was read again.");
 await waitFor(() => expect(section.queryByText("tests/a.py::one")).toBeNull());
});

it("shows a refusal in the server's words and keeps the mark", async () => {
 setup({ post: () => ({ status: 403, body: { error: { code: "FORBIDDEN", message: "Use a live browser session to remove a known-failing mark." } } }) });
 const section = await region();
 fireEvent.click(await section.findByRole("button", { name: "Undo tests/a.py::one" }));
 expect((await screen.findByRole("alert")).textContent).toContain("Use a live browser session to remove a known-failing mark.");
 expect(section.getByText("tests/a.py::one")).toBeTruthy();
});

it("shows test names and people as text: markup and hidden characters are shown, not run", async () => {
 setup({ marks: [mark("t/<b>x</b>.py::a‮b", { markedByName: "<img src=x onerror=alert(1)>" })] });
 const section = await region();
 expect(await section.findByText(/t\/<b>x<\/b>\.py::a\[U\+202E\]b/u)).toBeTruthy();
 expect(document.querySelector("img")).toBeNull();
 expect(document.querySelector("b")).toBeNull();
});

it("says so when the list is empty", async () => {
 setup({ marks: [] });
 expect(await (await region()).findByText("No test is marked as already failing.")).toBeTruthy();
});

it("when the list is full it points to Undo", async () => {
 setup({ marks: [mark("tests/a.py::one"), mark("tests/b.py::two")], max: 2 });
 const section = await region();
 expect(await section.findByText("This list is full. Undo marks that are no longer needed before marking more.")).toBeTruthy();
});

it("shows the first twenty and the rest on request", async () => {
 setup({ marks: Array.from({ length: 25 }, (_, n) => mark(`tests/t${String(n).padStart(2, "0")}.py::x`)) });
 const section = await region();
 await section.findByText("tests/t00.py::x");
 expect(section.queryByText("tests/t24.py::x")).toBeNull();
 fireEvent.click(section.getByRole("button", { name: "Show all (25)" }));
 expect(section.getByText("tests/t24.py::x")).toBeTruthy();
});

it("the project page shows the Environment section only when the server sent the count, and asks for nothing otherwise", async () => {
 const off = setup({ page: true, knownFailing: false });
 await screen.findByRole("heading", { name: "payments" });
 expect(screen.queryByRole("heading", { name: "Environment" })).toBeNull();
 expect(off.request.mock.calls.map(([request]) => request.path).some(path => path.includes("known-failing"))).toBe(false);
 off.unmount();
 const on = setup({ page: true });
 expect(await screen.findByRole("heading", { name: "Environment" })).toBeTruthy();
 expect(await screen.findByRole("region", { name: "Tests marked as already failing" })).toBeTruthy();
 on.unmount();
});

for (const theme of ["light", "dark"] as const) it("has an accessible list in " + theme, async () => { const f = setup({ theme }); const section = await region(); await section.findByText("tests/a.py::one"); await expectNoAxeViolations(f.container); });
