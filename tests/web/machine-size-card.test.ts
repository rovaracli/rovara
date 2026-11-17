// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { screen, fireEvent } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { MachineSizeCard } from "../../packages/ui/src/screens/project/MachineSizeCard.js";
import { AppHostProvider, type ApiResponse } from "../../packages/ui/src/host.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { fakeHost } from "./support/fake-host.js";
import { renderUi } from "./support/render.js";
import { h } from "./support/h.js";

const view = { measuredPeakMemoryMiB: 6144, testTimeMs: 120000, suggestedSize: "arm64-4-16", currentSize: null, storedOnlyLine: "Stored only: Rovara does not launch this size yet.", choices: [{ id: "arm64-4-16", label: "ARM, 4 vCPU, 16 GB" }] };
function setup(answer: ApiResponse, read?: ApiResponse) {
  const f = fakeHost(async (request) => request.method === "GET" ? read ?? { status: 200, body: view } : answer);
  const query = createQueryClient();
  const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(MachineSizeCard, { project: "payments", canEdit: true }) }) }));
  return { ...f, close: () => { ui.unmount(); query.clear(); } };
}
it("shows measured facts, suggestion and stored-only words and saves the selected choice", async () => {
  const f = setup({ status: 200, body: { ...view, currentSize: "arm64-4-16" } });
  await screen.findByText(/Measured peak memory: 6144 MiB/);
  expect(screen.getByText(/Suggested size: ARM, 4 vCPU, 16 GB/)).toBeTruthy();
  expect(screen.getByText(/Today's runs don't use this size yet/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Save machine size" }));
  await vi.waitFor(() => expect(f.request.mock.calls.some(([r]) => r.method === "POST" && r.path === "/v1/app/projects/payments/machine-size" && (r.body as { rowId: string }).rowId === "arm64-4-16")).toBe(true));
  f.close();
});
it.each(["FORBIDDEN", "REAUTH_REQUIRED"])("shows the distinct %s recovery", async (code) => {
  const f = setup({ status: 403, body: { error: { code, message: "Code fixed words" } } });
  fireEvent.click(await screen.findByRole("button", { name: "Save machine size" }));
  if (code === "FORBIDDEN") {
    await screen.findByText("Only a company owner or admin, or this project's administrator, can change this.");
    expect(screen.queryByRole("button", { name: "Confirm it's you" })).toBeNull();
  } else {
    fireEvent.click(await screen.findByRole("button", { name: "Confirm it's you" }));
    expect(f.host.signIn).toHaveBeenCalledWith("/app/live", { stepUp: true });
  }
  f.close();
});
it("shows a removed project without claiming setup is unavailable", async () => {
  const f = setup({ status: 200, body: view }, { status: 404, body: { error: { code: "PROJECT_NOT_FOUND", message: "missing" } } });
  await screen.findByText("That project doesn't exist, or you can't use it.");
  expect(screen.queryByText(/not set up/)).toBeNull(); f.close();
});
it("shows not-set-up when Code does not serve the feature", async () => {
  const f = setup({ status: 200, body: view }, { status: 501, body: { status: "not_set_up" } });
  await screen.findByText("Machine size suggestions are not set up on Rovara Code yet."); f.close();
});
