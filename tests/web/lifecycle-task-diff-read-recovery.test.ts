// @vitest-environment jsdom
import { createElement } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { AppHostProvider, type ApiResponse } from "../../packages/ui/src/host.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { ChangesTab } from "../../packages/ui/src/screens/session/ChangesTab.js";
import { workspaceFixture } from "./support/workspace-fixture.js";
import { workspaceTask } from "../../packages/ui/src/screens/session/workspace-types.js";
import { fakeHost } from "./support/fake-host.js";
import { taskDiffReadRecoveryCachedDiff } from "./support/task-diff-read-recovery-fixture.js";
import { h } from "./support/h.js";
import { proofIdentity } from "./support/page-task-proof-fixture.js";

afterEach(cleanup);
import { TaskDiffReadRecoveryView } from "../../packages/ui/src/screens/session/TaskDiffReadRecoveryView.js";

it("shows the approved account-unavailable state without rendering cached diff content", () => {
 const retry = vi.fn();
 render(createElement(TaskDiffReadRecoveryView, { state: "unavailable", onRetry: retry }));
 expect(screen.getByText("This diff is unavailable to this account. No code was changed by this read. Ask your project admin to check access.")).toBeTruthy();
 expect(screen.queryByRole("link", { name: "Open on GitHub" })).toBeNull();
 expect(screen.queryByRole("button", { name: "Load diff again" })).toBeNull();
});

it("shows the approved recoverable load-failure state and retries the same read", () => {
 const retry = vi.fn();
 render(createElement(TaskDiffReadRecoveryView, { state: "load-failed", onRetry: retry }));
 expect(screen.getByRole("status").textContent).toBe("The diff could not be loaded. This does not change the branch. Load diff again");
 fireEvent.click(screen.getByRole("button", { name: "Load diff again" }));
 expect(retry).toHaveBeenCalledTimes(1);
});

it.each([403, 404])("drops cached diff text and links after a %i read refusal", async status => {
 const session = workspaceFixture(), task = workspaceTask(session)!;
 const query = createQueryClient(), cached = taskDiffReadRecoveryCachedDiff();
 query.setQueryData(["session", session.sessionId, "diff", "acme/payments", 42, proofIdentity.org.orgId, proofIdentity.developer.id], {
  pages: [{ ...cached, files: [...cached.files, { ...cached.files[0], path: "cached-link-only.ts", patch: undefined, patchOmitted: "too_large" }] }], pageParams: [1],
 }, { updatedAt: Date.now() - 60_000 });
 let refuse!: (answer: ApiResponse) => void;
 const { host } = fakeHost(async request => request.path === "/v1/app/me" ? { status: 200, body: proofIdentity } : new Promise(resolve => { refuse = resolve; }));
 render(h(AppHostProvider, { host, children: h(QueryClientProvider, { client: query, children: h(ChangesTab, { session, task }) }) }));
 fireEvent.click(screen.getByRole("button", { name: "View diff for acme/payments #42" }));
 await screen.findByText("cached-secret.ts");
 expect(screen.getByText(/cached text/u)).toBeTruthy();
 expect(screen.getByRole("link", { name: "Open on GitHub" })).toBeTruthy();
 await act(async () => { refuse({ status, body: { error: { code: "FORBIDDEN", message: "not available" } } }); });
 await screen.findByText("This diff is unavailable to this account. No code was changed by this read. Ask your project admin to check access.");
 expect(screen.queryByText("cached-secret.ts")).toBeNull();
 expect(screen.queryByText("cached-link-only.ts")).toBeNull();
 expect(screen.queryByText(/cached text/u)).toBeNull();
 expect(screen.queryByRole("link", { name: "Open on GitHub" })).toBeNull();
 expect(screen.queryByRole("link")).toBeNull();
 expect(screen.getByRole("button", { name: "View diff for acme/payments #42" })).toBeTruthy();
 query.clear();
});

it("retries the selected task, repository, and PR after a recoverable read failure", async () => {
 const session = workspaceFixture(), task = workspaceTask(session)!;
 const requests: string[] = [];
 const { host } = fakeHost(async request => {
  if (request.path === "/v1/app/me") return { status: 200, body: proofIdentity };
  requests.push(request.path);
  return requests.length === 1
   ? { status: 501, body: { error: { code: "NOT_ON_CODE_YET", message: "unavailable" } } }
   : { status: 200, body: taskDiffReadRecoveryCachedDiff() };
 });
 const query = createQueryClient();
 render(h(AppHostProvider, { host, children: h(QueryClientProvider, { client: query, children: h(ChangesTab, { session, task }) }) }));
 fireEvent.click(screen.getByRole("button", { name: "View diff for acme/payments #42" }));
 await screen.findByRole("button", { name: "Load diff again" });
 fireEvent.click(screen.getByRole("button", { name: "Load diff again" }));
 await screen.findByText("cached-secret.ts");
 expect(requests).toHaveLength(2);
 expect(requests[0]).toBe(requests[1]);
 expect(requests[0]).toContain(encodeURIComponent(session.sessionId));
 expect(requests[0]).toContain("repository=acme%2Fpayments");
 expect(requests[0]).toContain("number=42");
 query.clear();
});

// F7/R6e: a refused read remains visible while a later read is pending after remount.
it("F7 retains the last refusal across remount while the same subject is read again", async () => {
 const session = workspaceFixture(), task = workspaceTask(session)!, query = createQueryClient();
 let reads = 0;
 const { host } = fakeHost(async request => {
  if (request.path === "/v1/app/me") return { status: 200, body: proofIdentity };
  reads++;
  return reads === 1 ? { status: 403, body: { error: { code: "FORBIDDEN", message: "no access" } } } : new Promise(() => undefined);
 });
 const element = h(AppHostProvider, { host, children: h(QueryClientProvider, { client: query, children: h(ChangesTab, { session, task }) }) });
 const first = render(element);
 fireEvent.click(screen.getByRole("button", { name: "View diff for acme/payments #42" }));
 await screen.findByText(/This diff is unavailable to this account/u);
 first.unmount();
 render(element);
 fireEvent.click(screen.getByRole("button", { name: "View diff for acme/payments #42" }));
 await screen.findByText(/This diff is unavailable to this account/u);
 expect(screen.queryByText("cached-secret.ts")).toBeNull();query.clear();
});

it.each(["company", "person"])("F7/R6g never carries another %s's refusal into a pending read", async changed => {
 const session = workspaceFixture(), task = workspaceTask(session)!, query = createQueryClient();
 let identity = proofIdentity, reads = 0;
 const { host } = fakeHost(async request => {
  if (request.path === "/v1/app/me") return { status: 200, body: identity };
  reads++;
  return reads === 1 ? { status: 403, body: { error: { code: "FORBIDDEN", message: "no access" } } } : new Promise(() => undefined);
 });
 const element = h(AppHostProvider, { host, children: h(QueryClientProvider, { client: query, children: h(ChangesTab, { session, task }) }) });
 const first = render(element);
 fireEvent.click(screen.getByRole("button", { name: "View diff for acme/payments #42" }));
 await screen.findByText(/This diff is unavailable to this account/u);first.unmount();
 identity = changed === "company" ? { ...proofIdentity, org: { ...proofIdentity.org, orgId: "org-another" } } : { ...proofIdentity, developer: { ...proofIdentity.developer, id: "b".repeat(64) } };
 render(element);fireEvent.click(screen.getByRole("button", { name: "View diff for acme/payments #42" }));
 await screen.findByText("Loading diff…");
 expect(screen.queryByText(/This diff is unavailable to this account/u)).toBeNull();query.clear();
});
it("F7/R6g offers no cached code or diff request while identity is unread", async () => {
 const session = workspaceFixture(), task = workspaceTask(session)!, query = createQueryClient();
 query.setQueryData(["session", session.sessionId, "diff", "acme/payments", 42, proofIdentity.org.orgId, proofIdentity.developer.id], { pages: [taskDiffReadRecoveryCachedDiff()], pageParams: [1] });
 const { host, request } = fakeHost(async () => new Promise(() => undefined));
 render(h(AppHostProvider, { host, children: h(QueryClientProvider, { client: query, children: h(ChangesTab, { session, task }) }) }));
 fireEvent.click(screen.getByRole("button", { name: "View diff for acme/payments #42" }));
 await screen.findByText("Reading the account for this diff…");
 expect(screen.queryByText("cached-secret.ts")).toBeNull();
 expect(request.mock.calls.map(([input]) => input.path)).toEqual(["/v1/app/me"]);query.clear();
});
it("F7/R6e an older unmounted read cannot retire a later refusal", async () => {
 const session = workspaceFixture(), task = workspaceTask(session)!, query = createQueryClient();
 let resolveOld!: (response: { status: number; body: unknown }) => void;
 let reads = 0;
 const { host } = fakeHost(async request => {
  if (request.path === "/v1/app/me") return { status: 200, body: proofIdentity };
  reads++;
  return reads === 1 ? new Promise(resolve => { resolveOld = resolve; }) : { status: 403, body: { error: { code: "FORBIDDEN", message: "no access" } } };
 });
 const element = h(AppHostProvider, { host, children: h(QueryClientProvider, { client: query, children: h(ChangesTab, { session, task }) }) });
 const first = render(element);
 fireEvent.click(screen.getByRole("button", { name: "View diff for acme/payments #42" }));
 await waitFor(() => expect(reads).toBe(1));first.unmount();
 query.removeQueries({ queryKey: ["session", session.sessionId, "diff"], exact: false });
 render(element);fireEvent.click(screen.getByRole("button", { name: "View diff for acme/payments #42" }));
 await screen.findByText(/This diff is unavailable to this account/u);
 await act(async () => { resolveOld({ status: 200, body: taskDiffReadRecoveryCachedDiff() }); });
 expect(screen.getByText(/This diff is unavailable to this account/u)).toBeTruthy();
 expect(screen.queryByText("cached-secret.ts")).toBeNull();
 expect(query.getQueryData(["task-diff-read-fence", proofIdentity.org.orgId, proofIdentity.developer.id, session.sessionId, "acme/payments", 42])).toEqual({ issued: 2, failure: "unavailable" });query.clear();
});
