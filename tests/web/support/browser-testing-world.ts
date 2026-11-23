// A mounted Browser testing page on a fake host: the served read is whatever the test says, every write is recorded, and the next read after a write is the test's.
import { QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { screen, waitFor } from "@testing-library/react";
import { expect } from "vitest";
import type { ApiRequest, ApiResponse } from "../../../packages/ui/src/host.js";
import { AppHostProvider } from "../../../packages/ui/src/host.js";
import { createQueryClient } from "../../../packages/ui/src/api/query.js";
import { BrowserTestingPage } from "../../../packages/ui/src/screens/setup/browser-testing/BrowserTestingPage.js";
import { browserTestingKey } from "../../../packages/ui/src/api/browser-testing.js";
import { fakeHost } from "./fake-host.js";
import { renderUi } from "./render.js";
import { h } from "./h.js";

export const PATH = "/v1/app/projects/payments/browser-testing";
export const ok = (body: unknown): ApiResponse => ({ status: 200, body });
export const fail = (status: number, code: string, message: string): ApiResponse => ({ status, body: { error: { code, message } } });
export const UUID = expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u) as string;

export interface World { read?: () => ApiResponse; write?: (request: ApiRequest) => ApiResponse; theme?: "light" | "dark"; component?: unknown }
export function mountBt(view: Record<string, unknown>, options: World = {}) {
  let current: ApiResponse = ok(view);
  const world = {
    /** The next reads answer this. */
    serve(next: ApiResponse | Record<string, unknown>) { current = "status" in next && "body" in next ? next as ApiResponse : ok(next); },
    reads: 0,
  };
  const f = fakeHost(async (request) => {
    if (request.path !== PATH && !request.path.startsWith(PATH + "/")) return fail(404, "NOT_FOUND", "route not found");
    if (request.method === "GET") { world.reads += 1; return options.read?.() ?? current; }
    return options.write?.(request) ?? current;
  });
  const query = createQueryClient();
  const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(MemoryRouter, { initialEntries: ["/app/projects/payments/browser-testing"], children: h(BrowserTestingPage, { project: "payments" }) }) }) }), { theme: options.theme ?? "light" });
  const writes = () => f.request.mock.calls.map(([r]) => r).filter((r) => r.method !== "GET");
  const gets = () => f.request.mock.calls.map(([r]) => r).filter((r) => r.method === "GET");
  return { ...f, ...world, query, writes, gets, close() { ui.unmount(); query.clear(); },
    /** A transient failed re-read (the page keeps its facts), through the page's own query. */
    async refetch() { await query.refetchQueries({ queryKey: browserTestingKey("payments") }); } };
}
export type Bt = ReturnType<typeof mountBt>;
/** The page once it has read. */
export async function page() {
  await screen.findByTestId("bt-page");
  await waitFor(() => expect(screen.queryByText("Reading…")).toBeNull(), { timeout: 5000 });
  return screen.getByTestId("bt-page");
}
export const buttons = (root: HTMLElement) => [...root.querySelectorAll("button, a.rv-button")].map((one) => (one.textContent ?? "").trim()).filter((text) => text !== "");
