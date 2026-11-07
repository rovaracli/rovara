// @vitest-environment jsdom
// UX-4b: how a project learns, from the project page: the Lessons tab with learning Off explains it and offers "Turn learning on", the mode control respects the company lock, the Sources tab
// offers the same control while learning is Off, a paused source can be resumed, and the team record that isn't set up says why.
import { describe, expect, it } from "vitest";
import { QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { LearningModeWriteBodySchema, LessonResumeSourceBodySchema } from "@agentx/contracts/web";
import { ProjectScreen } from "../../packages/ui/src/screens/project/ProjectScreen.js";
import { AppHostProvider, type ApiRequest } from "../../packages/ui/src/host.js";
import { Announcer } from "../../packages/ui/src/design/Announcer.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { renderUi } from "./support/render.js";
import { h } from "./support/h.js";
import { LESSONS_PATH, lessonsHost, ok, refusal } from "./support/lessons-fixture.js";
import { adminRow, adminView, flat } from "./support/sources-fixture.js";
import { openSources } from "./support/sources-render.js";

const MODE_PATH = "/v1/app/projects/payments/record/learning-mode";
type Mode = { mode: string; lock?: string; effective: string; canChange: boolean };

function world(options: { mode?: Mode | "absent" | "paused"; lessonsOff?: "LEARNING_OFF" | "LEARNING_LOCKED" | "NOT_FOUND"; write?: (body: Record<string, unknown>) => ReturnType<typeof ok> | undefined } = {}) {
 let mode: Mode | "absent" | "paused" = options.mode ?? { mode: "off", effective: "off", canChange: true };
 const posts: Array<Record<string, unknown>> = [];
 const cell = lessonsHost({
  lessons: (request: ApiRequest, url: URL) => url.pathname === LESSONS_PATH && request.method === "GET" && options.lessonsOff !== undefined && (mode === "absent" || mode === "paused" || mode.effective === "off") ? refusal(options.lessonsOff, "Learning is off for this project.", 404) : undefined,
  handle: (request, url) => {
   if (url.pathname !== MODE_PATH) return undefined;
   if (mode === "absent") return flat("PROJECT_NOT_FOUND", "No such project.", 404);
   if (mode === "paused") return flat("TEAM_RECORD_PAUSED", "The team record is paused in this installation.", 503);
   if (request.method === "GET") return ok(mode);
   const body = LearningModeWriteBodySchema.parse(request.body);
   posts.push(body);
   const custom = options.write?.(body);
   if (custom !== undefined) return custom;
   mode = { ...mode, mode: body.mode, effective: body.mode };
   return ok(mode);
  },
 });
 const query = createQueryClient();
 renderUi(h(AppHostProvider, { host: cell.host, children: h(QueryClientProvider, { client: query, children: h(MemoryRouter, { initialEntries: ["/app/projects/payments?tab=lessons"], children: h(Announcer, { children: h(Routes, { children: h(Route, { path: "/app/projects/:name", element: h(ProjectScreen, {}) }) }) }) }) }) }), { theme: "light" });
 return { cell, posts };
}

describe("the Lessons tab with learning off", () => {
 it("explains it and turns learning on in place, sending the value it read", async () => {
  const f = world({ lessonsOff: "LEARNING_OFF" });
  expect(await screen.findByText(/Learning is switched off/u)).toBeTruthy();
  const select = await screen.findByLabelText<HTMLSelectElement>("How this project learns");
  expect(select.value).toBe("off");
  fireEvent.change(select, { target: { value: "suggest" } });
  expect(screen.getByText(/each one waits for a maintainer/u)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Turn learning on" }));
  await waitFor(() => { expect(f.posts).toHaveLength(1); });
  expect(f.posts[0]).toMatchObject({ mode: "suggest", expectedMode: "off" });
  // The tab reads the lessons again, now that learning is on.
  await screen.findByRole("heading", { name: /^Active lessons/u });
 });

 it("disables a mode looser than the company lock and says why", async () => {
  world({ mode: { mode: "off", lock: "collect", effective: "off", canChange: true }, lessonsOff: "LEARNING_OFF" });
  const select = await screen.findByLabelText<HTMLSelectElement>("How this project learns");
  const options = [...select.options].filter(option => option.value !== "");
  expect(options.map(option => [option.value, option.disabled])).toEqual([["off", false], ["collect", false], ["suggest", true], ["on", true]]);
  expect(options[2]!.textContent).toContain("your company keeps it stricter");
 });

 it("shows a refusal in fixed words and reads the mode again when it moved", async () => {
  const f = world({ lessonsOff: "LEARNING_OFF", write: () => ({ status: 409, body: { code: "CHANGE_STALE", message: "x" } }) });
  fireEvent.change(await screen.findByLabelText("How this project learns"), { target: { value: "collect" } });
  fireEvent.click(screen.getByRole("button", { name: "Turn learning on" }));
  expect((await screen.findByRole("alert")).textContent).toContain("Someone changed how this project learns");
  expect(f.posts).toHaveLength(1);
 });

 it("for someone who can't change it, says who can", async () => {
  world({ mode: { mode: "off", effective: "off", canChange: false }, lessonsOff: "LEARNING_OFF" });
  expect(await screen.findByText("A maintainer of this project can change how it learns.")).toBeTruthy();
  expect(screen.queryByLabelText("How this project learns")).toBeNull();
 });

 it("says the team record isn't set up in this installation, with the cause, where the record route is absent", async () => {
  world({ mode: "absent", lessonsOff: "LEARNING_OFF" });
  expect(await screen.findByText(/this Rovara installation was built without it/u)).toBeTruthy();
  expect(screen.getByText(/agentx config set teamRecord.enabled 1/u)).toBeTruthy();
 });
});

describe("the Sources tab", () => {
 it("offers the learning control while learning is off", async () => {
  openSources({ lessonsSources: refusal("LEARNING_OFF", "Learning is off for this project.", 404) });
  expect((await screen.findAllByText(/Turn it on below/u)).length).toBeGreaterThan(0);
 });

 it("resumes a paused source with the row's kind and place", async () => {
  const resumes: unknown[] = [];
  const f = openSources({ view: adminView({ sources: [adminRow({ paused: true })] }) });
  const original = f.host.transport.request.bind(f.host.transport);
  f.host.transport.request = async (request: ApiRequest) => {
   if (request.path.endsWith("/lessons/sources/resume")) { resumes.push(LessonResumeSourceBodySchema.parse(request.body));return ok({ resumed: true, settled: 2 }); }
   return original(request);
  };
  const row = await screen.findByRole("region", { name: /GitHub github:repo\/9/u });
  fireEvent.click(within(row).getByRole("button", { name: "Resume this source" }));
  await waitFor(() => { expect(resumes).toEqual([{ source: "github", scope: "github:repo/9" }]); });
  expect(await screen.findByText(/Resumed\. 2 held lessons are waiting for a maintainer again\./u)).toBeTruthy();
 });
});

describe("UX-4b review M3: the record paused", () => {
 it("the Lessons tab says the record is paused, not that lessons aren't set up", async () => {
  world({ mode: "paused", lessonsOff: "NOT_FOUND" });
  expect(await screen.findByText(/The team record is paused in this installation, so no lesson is made/u)).toBeTruthy();
  expect(screen.queryByText(/aren't set up/u)).toBeNull();
 });
});
