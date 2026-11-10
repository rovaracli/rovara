// @vitest-environment jsdom
// Lessons in the repo, lane R2: the lessons file rows on the Lessons tab. Fixed sentences from the server shown as text; a maintainer switches a repository on or off, resumes it, answers the pointer; a reader sees the rows
// and no buttons; an installation without the route shows nothing; every body is parsed by the contract's own strict schema.
import { describe, expect, it } from "vitest";
import { screen, fireEvent, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { LessonsRepoFileBodySchema, LessonsRepoFileStatusSchema } from "@agentx/contracts/web";
import { ProjectScreen } from "../../packages/ui/src/screens/project/ProjectScreen.js";
import { AppHostProvider } from "../../packages/ui/src/host.js";
import { Announcer } from "../../packages/ui/src/design/Announcer.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { renderUi } from "./support/render.js";
import { expectNoAxeViolations } from "./support/axe.js";
import { h } from "./support/h.js";
import { LESSONS_PATH, lessonsHost, ok, refusal, view } from "./support/lessons-fixture.js";

const REPO_FILE_PATH = LESSONS_PATH + "/repo";
const row = (over: Record<string, unknown> = {}) => ({ repo: "api", enabled: true, fileDeleted: false, unmerged: 0, additionsPaused: false, removalsWaiting: 0, held: 0, pointer: "added", notices: [], ...over });
const status = (over: Record<string, unknown> = {}) => LessonsRepoFileStatusSchema.parse({ lessonsOff: false, canEnable: true, repos: [], available: [], ...over });

type Options = Parameters<typeof lessonsHost>[0];
function setup(options: Options = {}) {
 const cell = lessonsHost(options), query = createQueryClient();
 const ui = renderUi(h(AppHostProvider, { host: cell.host, children: h(QueryClientProvider, { client: query, children: h(MemoryRouter, { initialEntries: ["/app/projects/payments?tab=lessons"], children: h(Announcer, { children: h(Routes, { children: h(Route, { path: "/app/projects/:name", element: h(ProjectScreen) }) }) }) }) }) }));
 return { ...cell, ...ui, query };
}
const section = async () => within(await screen.findByRole("region", { name: "Lessons file in the repo" }));
const writes = (f: ReturnType<typeof setup>) => f.lessonWrites().filter(request => request.path.split("?")[0]!.endsWith("/repo"));
const serving = (body: unknown) => (request: { method: string }, url: URL) => (url.pathname === REPO_FILE_PATH && request.method === "GET" ? ok(body) : undefined);

describe("the lessons file rows", () => {
 it("shows nothing where the installation has no such route, and nothing when there is no repository to show", async () => {
  setup({});
  await screen.findByRole("heading", { name: /^Active lessons/u });
  expect(screen.queryByRole("region", { name: "Lessons file in the repo" })).toBeNull();
  setup({ lessons: serving(status()) });
  await screen.findAllByRole("heading", { name: /^Active lessons/u });
  expect(screen.queryByRole("region", { name: "Lessons file in the repo" })).toBeNull();
 });

 it("shows a row with its open pull request and its fixed notices as text, and the repositories that can be switched on", async () => {
  const f = setup({ lessons: serving(status({ repos: [row({ unmerged: 3, additionsPaused: true, removalsWaiting: 4, held: 1, pointer: "missing", pr: { number: "7", url: "https://github.com/acme/api/pull/7", removals: 4, edits: 0, adds: 0, openedAt: 1 },
   notices: ["Rovara has paused new lessons until a lessons PR is merged; 4 removals are waiting", "1 lesson your team edited is left as written", "Pointer missing: no agent file names .rovara/lessons.md"] })], available: ["web"] })) });
  const region = await section();
  expect(region.getByText(/paused new lessons until a lessons PR is merged; 4 removals are waiting/u)).toBeTruthy();
  expect(region.getByText(/1 lesson your team edited is left as written/u)).toBeTruthy();
  expect(region.getByRole("link", { name: "Open the pull request: api" }).getAttribute("href")).toBe("https://github.com/acme/api/pull/7");
  expect(region.getByRole("button", { name: "Turn on" })).toBeTruthy();
  expect(region.getByRole("button", { name: "Add the pointer back" })).toBeTruthy();
  expect(writes(f)).toHaveLength(0);
  await expectNoAxeViolations(document.body);
 });

 it("a maintainer's buttons send one strict body each; a reader sees the rows and no buttons", async () => {
  let current = status({ repos: [row({ fileDeleted: true, notices: ["The lessons file was deleted, so Rovara stopped proposing. Resume to start again."] })], available: ["web"] });
  const f = setup({ lessons: (request, url) => {
   if (url.pathname !== REPO_FILE_PATH) return undefined;
   if (request.method === "POST") { current = status({ repos: [row()], available: [] }); return ok(row()); }
   return ok(current);
  } });
  const region = await section();
  fireEvent.click(region.getByRole("button", { name: "Resume" }));
  await waitFor(() => expect(writes(f)).toHaveLength(1));
  expect(LessonsRepoFileBodySchema.parse(writes(f)[0]!.body)).toEqual({ action: "resume", repo: "api" });
  await waitFor(() => expect(region.queryByRole("button", { name: "Resume" })).toBeNull());
  fireEvent.click(region.getByRole("button", { name: "Turn off" }));
  await waitFor(() => expect(writes(f)).toHaveLength(2));
  expect(LessonsRepoFileBodySchema.parse(writes(f)[1]!.body)).toEqual({ action: "off", repo: "api" });
 });

 it("a refusal is said in fixed words", async () => {
  const f = setup({ lessons: (request, url) => (url.pathname === REPO_FILE_PATH ? (request.method === "POST" ? refusal("FORBIDDEN", "Only a maintainer of this project can change this.") : ok(status({ repos: [row()], available: ["web"] }))) : undefined) });
  const region = await section();
  fireEvent.click(region.getByRole("button", { name: "Turn off" }));
  expect((await region.findByRole("alert")).textContent).toContain("A maintainer of this project can change this.");
  expect(writes(f)).toHaveLength(1);
 });

 it("a reader (cannot decide) sees the rows and gets no buttons", async () => {
  setup({ state: { view: view({ canDecide: false }) }, lessons: serving(status({ repos: [row()], available: ["web"] })) });
  const readers = await section();
  expect(readers.getByText("api")).toBeTruthy();
  expect(readers.queryByRole("button", { name: "Turn off" })).toBeNull();
  expect(readers.queryByRole("button", { name: "Turn on" })).toBeNull();
 });

 it("says what a switched-on repository waits for while lessons are off, and nothing when they are on", async () => {
  setup({ lessons: serving(status({ repos: [row({ waitingFor: "install" }), row({ repo: "web", waitingFor: "project" })] })) });
  const region = await section();
  expect(region.getAllByTestId("lessons-repo-waiting").map(node => node.textContent)).toEqual([
   "The lessons file starts when lessons are switched on for this installation.", "The lessons file starts when lessons are switched on for this project."]);
 });

 it("shows no waiting note when lessons are on", async () => {
  setup({ lessons: serving(status({ repos: [row()] })) });
  const region = await section();
  expect(region.getByText("api")).toBeTruthy();
  expect(region.queryByTestId("lessons-repo-waiting")).toBeNull();
 });

 it("says when lessons are off", async () => {
  setup({ lessons: serving(status({ lessonsOff: true, repos: [row({ enabled: false })] })) });
  const region = await section();
  expect(region.getByText(/Lessons are off for this project/u)).toBeTruthy();
 });
});
