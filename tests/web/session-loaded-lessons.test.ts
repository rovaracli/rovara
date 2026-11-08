// @vitest-environment jsdom
// L3b: the lessons list inside "What the agent loaded": per step, why each lesson was chosen, whether its code reference held, no words for a lesson from a source the viewer can't see,
// and "Helpful" / "Wrong here" once per lesson.
import { expect, it } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { SessionViewReaderSchema, LessonFeedbackBodySchema } from "@agentx/contracts/web";
import { workspaceFixture as fixture } from "./support/workspace-fixture.js";
import { Workspace } from "../../packages/ui/src/screens/session/Workspace.js";
import { AppHostProvider } from "../../packages/ui/src/host.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { renderUi } from "./support/render.js";
import { fakeHost } from "./support/fake-host.js";
import { h } from "./support/h.js";
import { expectNoAxeViolations } from "./support/axe.js";
import { SESSION_FIXTURE_ID } from "./support/session-fixture.js";
import { loaded, loadedRow } from "./support/lessons-fixture.js";
import type { ApiRequest, ApiResponse } from "../../packages/ui/src/host.js";

function setup(respond: (request: ApiRequest) => Promise<ApiResponse>, entry = "/app/sessions/" + SESSION_FIXTURE_ID) {
 const session = SessionViewReaderSchema.parse(fixture()), f = fakeHost(respond), query = createQueryClient();
 const router = createMemoryRouter([{ path: "*", element: h("main", {}, h("h1", {}, session.title), h(Workspace, { session, onComment: () => undefined })) }], { initialEntries: [entry] });
 const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(RouterProvider, { router }) }) }));
 return { ...ui, f, close() { ui.unmount(); router.dispose(); query.clear(); } };
}
const open = async () => { const details = (await screen.findByText("What the agent loaded")).closest("details")!;details.open = true;fireEvent(details, new Event("toggle")); };
const rules = (request: ApiRequest): ApiResponse | undefined => request.path.endsWith("/loaded-knowledge") ? { status: 200, body: { stages: [], requestId: "r" } } : undefined;
const lessonsPath = (request: ApiRequest) => request.path.endsWith("/lessons");

it("reads no lessons until the panel is opened, then lists them per step with why each was chosen and whether its code reference held", async () => {
 const rows = [loadedRow(), loadedRow({ lessonId: "les_bbbb2222", title: "Avoid global state", citation: "stale_dropped", why: "similar", helpful: 0, harmful: 2 }), loadedRow({ stage: "PLAN", lessonId: "les_cccc3333", title: "Plan small", citation: "none", why: "path", type: "preference" })];
 const s = setup(async request => rules(request) ?? (lessonsPath(request) ? { status: 200, body: loaded(rows) } : { status: 404, body: {} }));
 await screen.findByText("What the agent loaded");
 expect(s.f.request.mock.calls.filter(([request]) => lessonsPath(request))).toHaveLength(0);
 await open();
 const section = await screen.findByRole("region", { name: "Lessons the agent loaded" });
 const text = section.textContent ?? "";
 expect(text).toContain("Build");
 expect(text).toContain("Plan");
 expect(text).toContain("Use the shared retry helper");
 expect(text).toContain("Chosen because it matched this project's scope");
 expect(text).toContain("Its code reference still holds");
 expect(text).toContain("Not used: the code it cites is gone");
 expect(text).toContain("Chosen because it matched a file the task touches");
 expect(text).toContain("It doesn't cite code");
 expect(text).toContain("Helpful 3, wrong 1");
 await expectNoAxeViolations(s.container);
 s.close();
});

it("a lesson from a source this person can't see is a row with no words and no buttons", async () => {
 const s = setup(async request => rules(request) ?? { status: 200, body: loaded([loadedRow({ visible: false, title: undefined, type: undefined, helpful: undefined, harmful: undefined, canMark: false, lessonId: "les_secret01" })]) });
 await open();
 const section = await screen.findByRole("region", { name: "Lessons the agent loaded" });
 expect(section.textContent).toContain("A lesson from a source you can't see");
 expect(section.querySelectorAll("button")).toHaveLength(0);
 s.close();
});

it("Helpful and Wrong here send one mark and say thanks; a refusal is shown in the server's words", async () => {
 const sent: Array<{ path: string; body: unknown }> = [];
 const s = setup(async request => {
  if (request.method === "POST") { sent.push({ path: request.path, body: request.body });return request.path.includes("les_bbbb2222") ? { status: 409, body: { error: { code: "CHANGE_STALE", message: "You already marked this lesson for this task." } } } : { status: 200, body: { done: true } }; }
  return rules(request) ?? { status: 200, body: loaded([loadedRow(), loadedRow({ lessonId: "les_bbbb2222", title: "Second" })]) };
 });
 await open();
 fireEvent.click(await screen.findByRole("button", { name: "Helpful: Use the shared retry helper" }));
 await screen.findByText(/Your mark is recorded/u);
 expect(sent).toHaveLength(1);
 expect(sent[0]!.path.endsWith("/lessons/les_aaaa1111/feedback")).toBe(true);
 expect(LessonFeedbackBodySchema.parse(sent[0]!.body)).toEqual({ kind: "helpful" });
 fireEvent.click(screen.getByRole("button", { name: "Wrong here: Second" }));
 expect((await screen.findByRole("alert")).textContent).toContain("You already marked this lesson for this task.");
 s.close();
});

it("says no lesson was loaded, says nothing where the lessons route is absent, and does not break the rules list when it fails", async () => {
 const none = setup(async request => rules(request) ?? { status: 200, body: loaded([]) });
 await open();
 expect(await screen.findByText("No lesson was loaded for this task.")).toBeTruthy();
 none.close();
 const absent = setup(async request => rules(request) ?? { status: 404, body: { error: { code: "NOT_FOUND", message: "Not found." } } });
 await open();
 await screen.findByText(/^Nothing was recorded for this task\./);
 await waitFor(() => { expect(absent.f.request.mock.calls.some(([request]) => lessonsPath(request))).toBe(true); });
 expect(screen.queryByText("Lessons the agent loaded")).toBeNull();
 absent.close();
});

it("a lesson on trial offers a one-tap thumbs-down (not Wrong here); it sends one thumbs_down mark and says the lesson was removed; a stable lesson says a maintainer will look", async () => {
 const sent: Array<{ path: string; body: unknown }> = [];
 const s = setup(async request => {
  if (request.method === "POST") { sent.push({ path: request.path, body: request.body });return { status: 200, body: { done: true } }; }
  return rules(request) ?? { status: 200, body: loaded([loadedRow({ trial: "trial" }), loadedRow({ lessonId: "les_bbbb2222", title: "Second", trial: "stable" }), loadedRow({ lessonId: "les_cccc3333", title: "Third" })]) };
 });
 await open();
 const section = await screen.findByRole("region", { name: "Lessons the agent loaded" });
 expect(section.textContent).toContain("On trial");
 expect(section.textContent).toContain("Stable");
 // Only a lesson without a trial keeps "Wrong here".
 expect(screen.queryByRole("button", { name: "Wrong here: Use the shared retry helper" })).toBeNull();
 expect(screen.getByRole("button", { name: "Wrong here: Third" })).toBeTruthy();
 fireEvent.click(screen.getByRole("button", { name: "Not helpful (thumbs down): Use the shared retry helper" }));
 await screen.findByText(/Rovara stopped using this lesson/u);
 expect(sent).toHaveLength(1);
 expect(sent[0]!.path.endsWith("/lessons/les_aaaa1111/feedback")).toBe(true);
 expect(LessonFeedbackBodySchema.parse(sent[0]!.body)).toEqual({ kind: "thumbs_down" });
 fireEvent.click(screen.getByRole("button", { name: "Not helpful (thumbs down): Second" }));
 await screen.findByText(/Rovara marked it for a maintainer to look at/u);
 await expectNoAxeViolations(s.container);
 s.close();
});

it("the pull request's link (?notHelpful=<lesson>) opens the page asking, and marks nothing by itself", async () => {
 const sent: unknown[] = [];
 const s = setup(async request => {
  if (request.method === "POST") { sent.push(request.body);return { status: 200, body: { done: true } }; }
  return rules(request) ?? { status: 200, body: loaded([loadedRow({ trial: "trial" }), loadedRow({ lessonId: "les_bbbb2222", title: "Second", trial: "trial" })]) };
 }, "/app/sessions/" + SESSION_FIXTURE_ID + "?notHelpful=les_aaaa1111");
 await open();
 expect(await screen.findAllByText(/You opened this from a pull request/u)).toHaveLength(1);
 expect(sent).toEqual([]);
 s.close();
});
