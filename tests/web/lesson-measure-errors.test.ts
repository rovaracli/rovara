// @vitest-environment jsdom
import { expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import type { ApiResponse } from "../../packages/ui/src/host.js";
import { AppHostProvider } from "../../packages/ui/src/host.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { LearningMeasure } from "../../packages/ui/src/screens/project/LearningMeasure.js";
import { fakeHost } from "./support/fake-host.js";
import { h } from "./support/h.js";
import { renderUi } from "./support/render.js";

it("shows Cloud's fixed not available yet words", async () => {
  const unavailable: ApiResponse = { status: 501, body: { error: { code: "NOT_ON_CODE_YET", message: "Lessons measure isn't available on this Rovara yet." } } };
  const host = fakeHost(async () => unavailable);
  const query = createQueryClient();
  const ui = renderUi(h(AppHostProvider, { host: host.host, children: h(QueryClientProvider, { client: query, children: h(MemoryRouter, { initialEntries: ["/app/projects/web"], children: h(Routes, {}, h(Route, { path: "/app/projects/web", element: h(LearningMeasure, { project: "web" }) })) }) }) }));
  expect(await screen.findByText("Lessons measure isn't available on this Rovara yet.")).toBeTruthy();
  ui.unmount();
  query.clear();
});
