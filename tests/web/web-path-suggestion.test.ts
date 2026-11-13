// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { StartWorkBox } from "../../packages/ui/src/screens/project/StartWorkBox.js";
import { AppHostProvider, type ApiRequest, type ApiResponse } from "../../packages/ui/src/host.js";
import { createCodeApi } from "../../packages/ui/src/api/code.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { renderUi } from "./support/render.js";
import { expectNoAxeViolations } from "./support/axe.js";
import { fakeHost } from "./support/fake-host.js";
import { h } from "./support/h.js";
import { taskFixture } from "./support/session-fixture.js";

const CODE = "/v1/app/projects/payments/code", sessionId = "ses_bbbbbbbbbbbbbbbbbbbb";
const answer = (path: "answer" | "quick" | "full", reason = path === "quick" ? "small_change" : path === "full" ? "large_change" : "question"): ApiResponse => ({ status: 200, body: { path, reason, source: "wording", requestId: "gateway-id" } });
const started = (): ApiResponse => ({ status: 202, body: { task: taskFixture({ sessionId }), sessionId } });
const cleanups: Array<() => void> = [];
afterEach(() => { for (const close of cleanups.splice(0)) close();vi.useRealTimers(); });
function setup(suggest: (request: ApiRequest) => Promise<ApiResponse>, start: (request: ApiRequest) => Promise<ApiResponse> = async () => started()) {
 const f = fakeHost(async request => request.path === CODE + "/suggest" ? suggest(request) : request.path === CODE ? start(request) : { status: 404, body: {} });
 const query = createQueryClient();
 const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(MemoryRouter, { children: h(StartWorkBox, { project: "payments", agents: [] }) }) }) }));
 cleanups.push(() => { ui.unmount();query.clear(); });
 return { ...f, ...ui, posts: () => f.request.mock.calls.map(([request]) => request).filter(request => request.path === CODE) };
}
const type = (text = "Fix typo") => fireEvent.change(screen.getByRole("textbox", { name: "What do you need?" }), { target: { value: text } });
const startButton = () => screen.getByRole<HTMLButtonElement>("button", { name: "Start" });
async function ready() { await waitFor(() => expect(startButton().disabled).toBe(false)); }
for (const path of ["quick", "full"] as const) it("preselects " + path + " and sends the selected explicit path", async () => {
 const f = setup(async () => answer(path));type();expect(startButton().disabled).toBe(true);await ready();
 expect(screen.getByRole<HTMLInputElement>("radio", { name: path === "quick" ? "Quick" : "Full" }).checked).toBe(true);
 expect(screen.getByText(/Suggested from the wording/)).toBeTruthy();expect(screen.queryByRole("radio", { name: "Just answer" })).toBeNull();
 fireEvent.click(screen.getByRole("radio", { name: path === "quick" ? "Full" : "Quick" }));fireEvent.click(startButton());
 await waitFor(() => expect(f.posts()).toHaveLength(1));expect(f.posts()[0]?.body).toMatchObject({ path: path === "quick" ? "FULL" : "QUICK" });
});
it("a question defaults to Let Rovara decide and sends no explicit path", async () => {
 const f = setup(async () => answer("answer"));type("How does retry work?");
 expect(screen.getByRole<HTMLInputElement>("radio", { name: "Let Rovara decide" }).checked).toBe(true);
 await ready();fireEvent.click(startButton());await waitFor(() => expect(f.posts()).toHaveLength(1));
 expect(f.posts()[0]?.body).toMatchObject({ input: { text: "How does retry work?" } });expect(f.posts()[0]?.body).not.toHaveProperty("path");
 expect(document.body.textContent).not.toContain("Just answer isn't available");
});
it("unclear wording leaves choices unselected without claiming failure and still permits the default start", async () => {
 const f = setup(async () => answer("answer", "unclear"));type("Something with the widget");await ready();
 expect(screen.getAllByRole<HTMLInputElement>("radio").every(radio => !radio.checked)).toBe(true);
 expect(screen.queryByText(/No suggestion right now/)).toBeNull();
 fireEvent.click(startButton());await waitFor(() => expect(f.posts()).toHaveLength(1));expect(f.posts()[0]?.body).not.toHaveProperty("path");
});
it("failures keep the default route available and never display injected words", async () => {
 for (const response of [answer("answer", "unavailable"), { status: 503, body: { reason: "<img src=x>" } }, { status: 200, body: { path: "quick", reason: "injected", source: "wording" } }]) {
  const f = setup(async () => response);type();await ready();expect(screen.getByText("No suggestion right now")).toBeTruthy();
  expect(screen.getByRole<HTMLInputElement>("radio", { name: "Let Rovara decide" }).checked).toBe(true);
  expect(document.body.textContent).not.toContain("injected");expect(document.body.textContent).not.toContain("Just answer isn't available");
  fireEvent.click(startButton());await waitFor(() => expect(f.posts()).toHaveLength(1));expect(f.posts()[0]?.body).not.toHaveProperty("path");cleanups.pop()?.();
 }
});
it("a capped previous suggestion never preselects a coding path for new wording", async () => {
 const f = setup(async () => ({ status: 200, body: { path: "quick", reason: "small_change", source: "previous_wording" } }));type("How does retry work?");await ready();
 expect(screen.getByRole<HTMLInputElement>("radio", { name: "Let Rovara decide" }).checked).toBe(true);
 expect(screen.getByText(/Last suggestion, from earlier wording/)).toBeTruthy();
 fireEvent.click(startButton());await waitFor(() => expect(f.posts()).toHaveLength(1));expect(f.posts()[0]?.body).not.toHaveProperty("path");
});
it("waits for 800 ms of quiet typing and makes just one suggestion for the finished text", async () => {
 vi.useFakeTimers();const f = setup(async () => answer("quick"));type("Fix");
 await act(async () => { await vi.advanceTimersByTimeAsync(799); });
 expect(f.request.mock.calls.filter(([r]) => r.path.endsWith("/suggest"))).toHaveLength(0);
 type("Fix typo");await act(async () => { await vi.advanceTimersByTimeAsync(799); });
 expect(f.request.mock.calls.filter(([r]) => r.path.endsWith("/suggest"))).toHaveLength(0);
 await act(async () => { await vi.advanceTimersByTimeAsync(1); });
 const suggestions = f.request.mock.calls.filter(([r]) => r.path.endsWith("/suggest"));expect(suggestions).toHaveLength(1);expect(suggestions[0]?.[0].body).toMatchObject({ text: "Fix typo" });
});
it("a manual default choice survives a late suggestion and uses a new retry ID after an explicit path", async () => {
 let finish!: (value: ApiResponse) => void;const f = setup(async () => new Promise(resolve => { finish = resolve; }), async () => ({ status: 503, body: { error: { code: "RUNTIME_UNAVAILABLE" } } }));
 type();fireEvent.click(screen.getByRole("radio", { name: "Let Rovara decide" }));await waitFor(() => expect(finish).toBeDefined());
 await act(async () => { finish(answer("quick")); });await ready();
 expect(screen.getByRole<HTMLInputElement>("radio", { name: "Let Rovara decide" }).checked).toBe(true);
 fireEvent.click(startButton());await screen.findByRole("alert");expect(f.posts()[0]?.body).not.toHaveProperty("path");
 fireEvent.click(screen.getByRole("radio", { name: "Quick" }));fireEvent.click(startButton());await waitFor(() => expect(f.posts()).toHaveLength(2));await ready();
 fireEvent.click(screen.getByRole("radio", { name: "Let Rovara decide" }));fireEvent.click(startButton());await waitFor(() => expect(f.posts()).toHaveLength(3));
 const bodies = f.posts().map(r => r.body as { requestId: string; path?: string });expect(new Set(bodies.map(b => b.requestId)).size).toBe(3);expect(bodies[2]).not.toHaveProperty("path");
});
it("clears the old selection on edit, cancels its request, and ignores an old answer", async () => {
 let finish!: (response: ApiResponse) => void;const requests: ApiRequest[] = [];
 const f = setup(async request => { requests.push(request);return requests.length === 1 ? new Promise(resolve => { finish = resolve; }) : answer("full"); });
 type("Old text");await waitFor(() => expect(requests).toHaveLength(1));type("New text");expect(startButton().disabled).toBe(true);await ready();
 expect(requests[0]?.signal?.aborted).toBe(true);
 await act(async () => { finish(answer("quick")); });expect(screen.getByRole<HTMLInputElement>("radio", { name: "Full" }).checked).toBe(true);
 fireEvent.click(startButton());await waitFor(() => expect(f.posts()).toHaveLength(1));expect(f.posts()[0]?.body).toMatchObject({ input: { text: "New text" }, path: "FULL" });
});
it("an edit immediately clears an already displayed suggestion and manual choice", async () => {
 const f = setup(async () => answer("quick"));type();await ready();fireEvent.click(screen.getByRole("radio", { name: "Full" }));
 type("Changed text");expect(startButton().disabled).toBe(true);expect(screen.getByRole<HTMLInputElement>("radio", { name: "Let Rovara decide" }).checked).toBe(true);
 expect(screen.getByText("Checking the wording…")).toBeTruthy();await ready();expect(f.posts()).toHaveLength(0);
});
it("editing away and back to the same text still waits for a fresh suggestion", async () => {
 let calls = 0;setup(async () => ++calls === 1 ? answer("quick") : new Promise(() => undefined));type("Original text");await ready();
 type("Other text");type("Original text");expect(startButton().disabled).toBe(true);expect(screen.getByRole<HTMLInputElement>("radio", { name: "Let Rovara decide" }).checked).toBe(true);
});
it("a late suggestion cannot overwrite a hand choice made while waiting", async () => {
 let finish!: (response: ApiResponse) => void;const f = setup(async () => new Promise(resolve => { finish = resolve; }));type();
 await waitFor(() => expect(finish).toBeDefined());fireEvent.click(screen.getByRole("radio", { name: "Full" }));
 expect(startButton().disabled).toBe(true);
 await act(async () => { finish(answer("quick")); });await ready();expect(screen.getByRole<HTMLInputElement>("radio", { name: "Full" }).checked).toBe(true);
 fireEvent.click(startButton());await waitFor(() => expect(f.posts()).toHaveLength(1));expect(f.posts()[0]?.body).toMatchObject({ path: "FULL" });
});
it("cancelling old text cannot erase a new hand choice before the next suggestion", async () => {
 let calls = 0;setup(async () => ++calls === 1 ? new Promise(() => undefined) : answer("quick"));type("Old text");await waitFor(() => expect(calls).toBe(1));
 type("New text");fireEvent.click(screen.getByRole("radio", { name: "Full" }));await ready();expect(screen.getByRole<HTMLInputElement>("radio", { name: "Full" }).checked).toBe(true);
});
it("times out, aborts the transport, and allows a manual start", async () => {
 vi.useFakeTimers();let request: ApiRequest | undefined;const f = setup(async value => { request = value;return new Promise(() => undefined); });type();
 await act(async () => { await vi.advanceTimersByTimeAsync(5000); });expect(screen.getByText(/No suggestion right now/)).toBeTruthy();expect(request?.signal?.aborted).toBe(true);
 fireEvent.click(screen.getByRole("radio", { name: "Quick" }));fireEvent.click(startButton());await act(async () => undefined);expect(f.posts()).toHaveLength(1);
});
it("reuses a start id on retry but changes it for another path; double clicks send once", async () => {
 let attempts = 0;const f = setup(async () => answer("quick"), async () => ++attempts < 3 ? { status: 503, body: { error: { code: "RUNTIME_UNAVAILABLE", message: "x" } } } : started());type();await ready();
 fireEvent.click(startButton());fireEvent.click(startButton());fireEvent.submit(startButton().closest("form")!);await screen.findByRole("alert");expect(f.posts()).toHaveLength(1);
 fireEvent.click(startButton());await waitFor(() => expect(f.posts()).toHaveLength(2));await ready();
 const ids = () => f.posts().map(request => (request.body as { requestId: string }).requestId);expect(ids()[1]).toBe(ids()[0]);
 fireEvent.click(screen.getByRole("radio", { name: "Full" }));fireEvent.click(startButton());await waitFor(() => expect(f.posts()).toHaveLength(3));expect(ids()[2]).not.toBe(ids()[0]);
});
it("accepts 4000 characters and never sends oversized text for suggestion", async () => {
 const f = setup(async () => answer("full"));type("x".repeat(4000));await ready();fireEvent.click(startButton());await waitFor(() => expect(f.posts()).toHaveLength(1));
 cleanups.pop()?.();const g = setup(async () => answer("quick"));type("x".repeat(4001));expect(startButton().disabled).toBe(true);expect(g.request.mock.calls.some(([r]) => r.path.endsWith("/suggest"))).toBe(false);
});
it("labels the native radio group and connects its fixed reason for screen readers", async () => {
 const f = setup(async () => answer("quick"));type();await ready();const group = screen.getByRole("group", { name: "How should Rovara handle this?" });expect(document.getElementById(group.getAttribute("aria-describedby")!)).toBeTruthy();await expectNoAxeViolations(f.container);
});
it("aborted suggestions are never sent, and strict parsing drops free model words", async () => {
 const f = fakeHost(async () => ({ status: 200, body: { path: "quick", reason: "<script>bad</script>", source: "wording" } }));const api = createCodeApi(f.host), abort = new AbortController();abort.abort();
 await expect(api.suggestCode("payments", "Fix typo", crypto.randomUUID(), abort.signal)).resolves.toEqual({ path: "answer", reason: "unavailable", source: "wording" });expect(f.request).not.toHaveBeenCalled();
 await expect(api.suggestCode("payments", "Fix typo", crypto.randomUUID())).resolves.toEqual({ path: "answer", reason: "unavailable", source: "wording" });
});
