// @vitest-environment jsdom
// DECOUPLE T2 Sonnet pre-review (test-only): a merge readiness answer with no risk, or a risk word this page does not know, never offers the in-app Merge press and never posts.
import { afterEach, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { SessionViewReaderSchema } from "@agentx/contracts/web";
import { AppHostProvider } from "../../packages/ui/src/host.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { MergeSection } from "../../packages/ui/src/screens/session/MergeSection.js";
import { workspaceTask } from "../../packages/ui/src/screens/session/workspace-types.js";
import { workspaceFixture } from "./support/workspace-fixture.js";
import { fakeHost } from "./support/fake-host.js";
import { renderUi } from "./support/render.js";
import { h } from "./support/h.js";
const id = "ses_aaaaaaaaaaaaaaaaaaaa", org = "org_aaaaaaaaaaaaaaaaaaaa", person = "a1".repeat(32), sha = "a".repeat(40);
const success = { status: 200, body: { status: "MERGED", pullRequests: [{ repositoryId: "acme/payments", number: 42 }] } };
const tracked = { orgId: org, taskId: "11111111-1111-4111-8111-111111111111", repositoryId: "acme/payments", number: 42, version: 1, headSha: sha, draft: false, state: "open", baseBranch: "main", ci: "passing", ciBasis: "required", checksEverSeen: true, failingChecks: [], review: "approved", branch: "up_to_date", headByRovara: true, nudges: { count: 0 }, syncs: { day: "2026-10-23", count: 0 }, decisionDigest: "b".repeat(64), observedAt: "2026-10-23T12:00:00.000Z" };
// The fixture parses strictly, so a level this build does not know is put on the already-read view, as a newer Code's answer reaches the page after the reader.
function withTaskLevel<T>(view: T, level: string): T {
 const body = (view as unknown as { body: { kind: string; task?: { merge?: { risk?: { level: string } } } } }).body;
 if (body.kind === "task" && body.task?.merge?.risk !== undefined) body.task.merge.risk.level = level;
 return view;
}
function setup(readiness: Record<string, unknown>, post: () => Promise<typeof success> = async () => success, state: () => "open" | "closed" = () => "open", taskLevel = "low") {
 localStorage.clear();
 const session = () => withTaskLevel(SessionViewReaderSchema.parse(workspaceFixture({ sessionId: id }, { pullRequests: [{ repository: "acme/payments", number: 42, url: "https://github.com/acme/payments/pull/42", state: state() }], mergeTracking: [{ ...tracked, state: state() }], merge: { ready: true, risk: { level: "low", reasons: ["Touches billing code."] } } })), taskLevel);
 const f = fakeHost(async request => {
  if (request.path === "/v1/app/me") return { status: 200, body: { developer: { id: person, name: "Ana", orgRole: "owner" }, org: { orgId: org, name: "Acme", plan: "team" }, identities: [] } };
  if (request.path.endsWith("/merge") && request.method === "POST") return post();
 if (request.path.endsWith("/merge")) return { status: 200, body: readiness };
  return { status: 200, body: { session: session() } };
 });
 const mount = () => {
  const query = createQueryClient();
  const element = () => h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(MergeSection, { sessionId: id, task: workspaceTask(session())! }) }) });
  const ui = renderUi(element());
  return { ...ui, show: () => ui.rerender(h("div", { "data-theme": "light" }, element())) };
 };
 return { ...f, mount, posts: () => f.request.mock.calls.filter(([request]) => request.method === "POST") };
}

const base = { mayMerge: true, ready: true, heads: [{ repositoryId: "acme/payments", number: 42, headSha: sha }], pullRequests: [{ repositoryId: "acme/payments", number: 42 }] };
afterEach(() => { vi.useRealTimers();vi.restoreAllMocks();localStorage.clear(); });
it("a known risk offers the Merge press (control)", async () => {
 const f = setup({ ...base, risk: "low" }); f.mount();
 expect(await screen.findByRole("button", { name: /^Merge #42/u })).toBeTruthy();
});
it.each([["no risk", {}], ["a risk word a newer server sent", { risk: "critical" }], ["the word unknown", { risk: "unknown" }]])("%s: no Merge press is offered and nothing is posted", async (_name, extra) => {
 const f = setup({ ...base, ...extra }); f.mount();
 await waitFor(() => expect(f.request.mock.calls.some(([request]) => request.path.endsWith("/merge") && request.method !== "POST")).toBe(true));
 await act(async () => { await new Promise(resolve => setTimeout(resolve, 100)); });
 expect(screen.queryByRole("button", { name: /^Merge #42/u })).toBeNull();
 expect(f.posts()).toHaveLength(0);
});

// Pre-review S3: a risk LEVEL on the task's own merge view that this build cannot read draws no risk line (never "Medium risk": DEC 540) and never lets a press through, even when the readiness answer carries a known risk.
it("a task risk level this build does not know draws no risk line and sends no Merge", async () => {
 const f = setup({ ...base, risk: "medium" }, async () => success, () => "open", "critical"); f.mount();
 await waitFor(() => expect(f.request.mock.calls.some(([request]) => request.path.endsWith("/merge") && request.method !== "POST")).toBe(true));
 await act(async () => { await new Promise(resolve => setTimeout(resolve, 100)); });
 expect(screen.queryByText(/risk$/iu)).toBeNull(); expect(screen.queryByText("Medium risk")).toBeNull(); expect(screen.queryByText("Touches billing code.")).toBeNull();
 const press = screen.queryByRole("button", { name: /^Merge #42/u });
 if (press !== null) {
  fireEvent.click(press); await act(async () => { await new Promise(resolve => setTimeout(resolve, 100)); });
  const dialog = screen.queryByRole("dialog");
  if (dialog !== null) { const confirm = within(dialog).queryByRole("button", { name: "Press Merge" }); if (confirm !== null) fireEvent.click(confirm); await act(async () => { await new Promise(resolve => setTimeout(resolve, 100)); }); }
 }
 expect(f.posts()).toHaveLength(0);
});
it.each(["low", "medium", "high"])("a known task risk level %s still draws its own risk line (control)", async level => {
 const f = setup({ ...base, risk: level }, async () => success, () => "open", level); f.mount();
 expect(await screen.findByText(`${level[0]!.toUpperCase()}${level.slice(1)} risk`)).toBeTruthy();
});
