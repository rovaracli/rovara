// @vitest-environment jsdom
import { confirmUrlWithTicket } from "../../packages/broker/src/developer/decide-session.js";
import { afterEach, expect, it, vi } from "vitest";
import { act, screen, fireEvent } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { AppHostProvider } from "../../packages/ui/src/host.js";
import { ConfirmInBrowser } from "../../packages/ui/src/confirm/ConfirmInBrowser.js";
import { h } from "./support/h.js";
import { renderUi } from "./support/render.js";
import { fakeHost } from "./support/fake-host.js";
afterEach(() => { vi.useRealTimers(); });
const key = ["session", "ses_aaaaaaaaaaaaaaaaaaaa"];
const result = { kind: "needs_confirmation" as const, confirmUrl: "https://cell.example/v1/app/approve/apr_aaaaaaaaaaaaaaaaaaaa", changes: ["Transfer the session"] };
it("waits for a real refetch, never an optimistic cache change, before saying Done", async () => {
 vi.useFakeTimers();const query = createQueryClient(), f = fakeHost();let owner = false;const onApplied = vi.fn();await query.fetchQuery({ queryKey: key, queryFn: async () => ({ owner }) });
 const { unmount } = renderUi(h(QueryClientProvider, { client: query, children: h(AppHostProvider, { host: f.host, children: h(ConfirmInBrowser<{ owner: boolean }>, { result, subjectKey: key, isApplied: data => data.owner, onApplied }) }) }));
 expect(screen.queryByText("Done")).toBeNull();expect(screen.getByText("Waiting for you to confirm in your browser")).toBeTruthy();
 act(() => { query.setQueryData(key, { owner: true }); });expect(screen.queryByText("Done")).toBeNull();expect(onApplied).not.toHaveBeenCalled();
 owner = true;await act(async () => { await query.refetchQueries({ queryKey: key, exact: true }); });expect(screen.getByText("Done")).toBeTruthy();expect(onApplied).toHaveBeenCalledTimes(1);unmount();query.clear();
});
it("shows the exact ten-minute recovery copy and cleans its timers on exit", async () => {
 vi.useFakeTimers();const query = createQueryClient(), f = fakeHost();await query.fetchQuery({ queryKey: key, queryFn: async () => ({ owner: false }) });
 const { unmount } = renderUi(h(QueryClientProvider, { client: query, children: h(AppHostProvider, { host: f.host, children: h(ConfirmInBrowser<{ owner: boolean }>, { result, subjectKey: key, isApplied: data => data.owner }) }) }));
 await act(async () => { await vi.advanceTimersByTimeAsync(600_000); });expect(screen.getByText("Nothing changed yet. If you confirmed, reload this page.")).toBeTruthy();expect(screen.queryByText("Done")).toBeNull();unmount();query.clear();expect(vi.getTimerCount()).toBe(0);
});
it("shows no confirmation action for an unsafe or absent link", () => {
 const query = createQueryClient(), f = fakeHost();const { unmount } = renderUi(h(QueryClientProvider, { client: query, children: h(AppHostProvider, { host: f.host, children: h(ConfirmInBrowser, { result: { ...result, confirmUrl: "https://evil.example/v1/app/approve/a" }, subjectKey: key, isApplied: () => false }) }) }));
 expect(screen.queryByRole("button", { name: "Open confirmation" })).toBeNull();expect(f.host.openExternal).not.toHaveBeenCalled();unmount();query.clear();
});

it("opens the broker-minted ticket link unchanged without treating it as applied", () => {
 const query = createQueryClient(), f = fakeHost(), confirmUrl = confirmUrlWithTicket(f.host.origin, "apr_aaaaaaaaaaaaaaaaaaaa", "a".repeat(43));
 const ui = renderUi(h(QueryClientProvider, { client: query, children: h(AppHostProvider, { host: f.host, children: h(ConfirmInBrowser, { result: { ...result, confirmUrl }, subjectKey: key, isApplied: () => false }) }) }));fireEvent.click(screen.getByRole("button", { name: "Open confirmation" }));expect(f.host.openExternal).toHaveBeenCalledWith(confirmUrl);expect(screen.queryByText("Done")).toBeNull();ui.unmount();query.clear();
});
