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
const ten = [
  ["arm64-2-8", "ARM, 2 vCPU, 8 GB", "The standard size, about $0.09 an hour."], ["arm64-4-16", "ARM, 4 vCPU, 16 GB", "About 2 times the cost of the standard size, about $0.17 an hour."],
  ["arm64-8-32", "ARM, 8 vCPU, 32 GB", "About 4 times the cost of the standard size, about $0.34 an hour."], ["arm64-16-64", "ARM, 16 vCPU, 64 GB", "About 8 times the cost of the standard size, about $0.68 an hour."],
  ["arm64-32-128", "ARM, 32 vCPU, 128 GB", "About 16 times the cost of the standard size, about $1.36 an hour."], ["x86_64-2-8", "x86, 2 vCPU, 8 GB", "About 1.2 times the cost of the standard size, about $0.11 an hour."],
  ["x86_64-4-16", "x86, 4 vCPU, 16 GB", "About 2.5 times the cost of the standard size, about $0.22 an hour."], ["x86_64-8-32", "x86, 8 vCPU, 32 GB", "About 5 times the cost of the standard size, about $0.43 an hour."],
  ["x86_64-16-64", "x86, 16 vCPU, 64 GB", "About 10 times the cost of the standard size, about $0.85 an hour."], ["x86_64-32-128", "x86, 32 vCPU, 128 GB", "About 20 times the cost of the standard size, about $1.69 an hour."],
].map(([id, label, costNote]) => ({ id: id!, label: label!, costNote: costNote! }));
it("shows all ten sizes and says the cost impact of the suggested and the selected size in words", async () => {
  const f = setup({ status: 200, body: view }, { status: 200, body: { ...view, suggestedSize: "arm64-16-64", currentSize: null, choices: ten } });
  await screen.findByText(/Suggested size: ARM, 16 vCPU, 64 GB\./);
  expect(screen.getAllByRole("option")).toHaveLength(10);
  expect(screen.getByText(/Suggested size: ARM, 16 vCPU, 64 GB\./).textContent).toContain("About 8 times the cost of the standard size, about $0.68 an hour.");
  expect(screen.getByLabelText("Cost of the selected size").textContent).toBe("Cost of this size: About 8 times the cost of the standard size, about $0.68 an hour.");
  fireEvent.change(screen.getByRole("combobox"), { target: { value: "x86_64-32-128" } });
  expect(screen.getByLabelText("Cost of the selected size").textContent).toBe("Cost of this size: About 20 times the cost of the standard size, about $1.69 an hour.");
  expect(screen.getByText(/Suggested size: ARM, 16 vCPU, 64 GB\./).textContent).toContain("About 8 times the cost of the standard size, about $0.68 an hour.");
  f.close();
});
it("shows no cost line, and still works, when Code sends no cost words (an older Code)", async () => {
  const f = setup({ status: 200, body: view });
  await screen.findByText(/Measured peak memory/);
  expect(screen.queryByLabelText("Cost of the selected size")).toBeNull();
  f.close();
});
it("treats a malformed size list or an over-long cost note as an unreadable answer", async () => {
  const f = setup({ status: 200, body: view }, { status: 200, body: { ...view, choices: [{ id: "arm64-4-16", label: "x", costNote: "n".repeat(201) }] } });
  await screen.findByText("Couldn't load machine measurements. Try again."); f.close();
  const g = setup({ status: 200, body: view }, { status: 200, body: { ...view, choices: [null] } });
  await screen.findByText("Couldn't load machine measurements. Try again."); g.close();
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
