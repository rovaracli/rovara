// @vitest-environment jsdom
import { expect, it } from "vitest";
import { act, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import type { ApiRequest, ApiResponse } from "../../packages/ui/src/host.js";
import { AppHostProvider } from "../../packages/ui/src/host.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { fakeHost } from "./support/fake-host.js";
import { renderUi } from "./support/render.js";
import { h } from "./support/h.js";
import { LearningMeasure } from "../../packages/ui/src/screens/project/LearningMeasure.js";

const MEASURE = {
  project: "web", windowDays: 30, floor: 0.35, loads: 7, lessonsInUse: 12, loadedLessons: 21, loadedBelowFloor: 3,
  loadsWithBelowFloor: 2, loadedNoMatch: 1, meanWordsLoaded: 0.42, meanWordsLeftOut: 0.3, loadsCapBound: 1,
  leftOutAtOrAboveFloor: 4, meanFitLoaded: 0.61, meanFitLeftOut: 0.39,
  cleanMerge: { merged: 5, reverted: 0, clean: 5, rate: 1 }, revertDetection: "not_wired", truncated: false, unreadable: 0,
};
const ok = (body: unknown): ApiResponse => ({ status: 200, body });
function mountLessonsScreen(element: ReturnType<typeof h>, answer: (request: ApiRequest) => ApiResponse) {
  const f = fakeHost(async request => answer(request));
  const query = createQueryClient();
  const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(MemoryRouter, { initialEntries: ["/app/projects/web"], children: h(Routes, {}, h(Route, { path: "/app/projects/web", element })) }) }) }));
  return { ...f, ...ui, close() { ui.unmount(); query.clear(); } };
}

it("shows Code's measure numbers to a person Code permits", async () => {
  const f = mountLessonsScreen(h(LearningMeasure, { project: "web" }), () => ok(MEASURE));
  expect(await screen.findByRole("heading", { name: "Lessons measure" })).toBeTruthy();
  expect(screen.getByText("3 loaded below the fit floor")).toBeTruthy();
  expect(screen.getByText("100% clean merges (5 of 5)")).toBeTruthy();
  expect(screen.getByText("Revert detection isn't wired yet.")).toBeTruthy();
  f.close();
});

it("keeps the panel hidden when Code denies a project member", async () => {
  const f = mountLessonsScreen(h(LearningMeasure, { project: "web" }), () => ({ status: 403, body: { error: { code: "FORBIDDEN", message: "Only maintainers can see this." } } }));
  await waitFor(() => expect(f.request.mock.calls.length).toBeGreaterThan(0));
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  expect(screen.queryByRole("heading", { name: "Lessons measure" })).toBeNull();
  f.close();
});

