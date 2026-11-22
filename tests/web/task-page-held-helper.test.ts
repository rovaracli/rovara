// @vitest-environment jsdom
import { expect, it } from "vitest";
import { act, fireEvent, screen } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { createApiClient } from "../../packages/ui/src/api/client.js";
import { runTaskAction, useTaskAction } from "../../packages/ui/src/api/task-action.js";
import { TaskActionNotice } from "../../packages/ui/src/screens/session/TaskActionNotice.js";
import { fenceFor } from "../../packages/ui/src/safe-action.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { readSessionIdentity, sessionScope } from "../../packages/ui/src/api/session-safety.js";
import { AppHostProvider } from "../../packages/ui/src/host.js";
import { meFixture } from "./support/fixtures.js";
import { fakeHost } from "./support/fake-host.js";
import { renderUi } from "./support/render.js";
import { h } from "./support/h.js";

const retry = "/v1/app/sessions/ses_aaaaaaaaaaaaaaaaaaaa/retry";
for (const method of ["send", "sendAnswer"] as const) for (const [route, status, code, message, held] of [
 [retry, 400, "CONFIG_INVALID", "post-commit projection failed", true],
 [retry, 400, "CONFIG_INVALID", "The displayed revision and candidate digest are required.", true],
 [retry, 403, "FORBIDDEN", "Only Ada can retry this session.", false],
 [retry, 404, "NOT_FOUND", "No session", true],
 ["/v1/app/sessions/ses_aaaaaaaaaaaaaaaaaaaa/send-back", 409, "IDEMPOTENCY_CONFLICT", "People changed; refresh the task and try again", true],
 ["/v1/app/unreviewed", 409, "CHANGE_STALE", "Changed", true],
 ["/v1/web/decisions/approve_plan/plan1/reject", 409, "CHANGE_STALE", "This changed since you loaded it. Reload to see the current version.", false],
] as const) it(`default refusal binds ${method} to the dispatched route: ${route} ${status}/${code} ${message}`, async () => {
 const f = fakeHost(async () => ({ status, body: { error: { code, message } } }));
 const send = () => runTaskAction(f.host, "scope", "retry", { requestId: "same-request" }, request => createApiClient(f.host)[method]("POST", route, request.body, { parse: (v: unknown) => v }, { retry: "never" }), null);
 await expect(send()).rejects.toBeTruthy();
 expect(JSON.parse(f.storage.get("scope:request")! ) !== null).toBe(held);
 if (held) { await expect(send()).rejects.toBeTruthy();expect(f.request).toHaveBeenCalledTimes(1); }
});

it("TaskActionNotice uses the subject fence for three checks across remount and leaves Check live", async () => {
 const query = createQueryClient(), fence = fenceFor(query, "identity:task", "task-action");
 const recovery = { fence, entry: { requestId: "held", startedAt: new Date().toISOString() } };
 const mount = () => renderUi(h(QueryClientProvider, { client: query, children: h(TaskActionNotice, { pending: true, recovery, taskHref: "/app/sessions/ses_aaaaaaaaaaaaaaaaaaaa", check: async () => false }) }));
 let ui = mount();
 for (let i = 0; i < 2; i++) { await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Check" })); }); }
 expect(screen.queryByRole("link")).toBeNull();ui.unmount();ui = mount();
 await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Check" })); });
 expect(screen.getByRole("link", { name: "Open the task to check" }).getAttribute("href")).toBe("/app/sessions/ses_aaaaaaaaaaaaaaaaaaaa");
 expect(screen.getByRole<HTMLButtonElement>("button", { name: "Check" }).disabled).toBe(false);
 ui.unmount();query.clear();
});
it("TaskActionNotice uses the saved ten-minute deadline after reload, including failed Checks", async () => {
 const query = createQueryClient(), fence = fenceFor(query, "identity:task", "task-action");
 const recovery = { fence, entry: { requestId: "held", startedAt: new Date(Date.now() - 600_001).toISOString() } };
 const ui = renderUi(h(QueryClientProvider, { client: query, children: h(TaskActionNotice, { pending: true, recovery, taskHref: "/app/sessions/ses_aaaaaaaaaaaaaaaaaaaa", check: async () => { throw new Error("offline"); } }) }));
 expect(screen.getByRole("link", { name: "Open the task to check" })).toBeTruthy();
 await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Check" })); });
 expect(screen.getByText(/Couldn't check this task/)).toBeTruthy();
 expect(screen.getByRole("link", { name: "Open the task to check" })).toBeTruthy();ui.unmount();query.clear();
});

it("TaskActionNotice receives the persisted identity-scoped request deadline from useTaskAction after reload", async () => {
 const f = fakeHost(async () => ({ status: 200, body: meFixture() }));const identity = await readSessionIdentity(f.host);
 f.storage.set(sessionScope(identity, "held-task") + ":request", JSON.stringify({ requestId: "original", action: "role", startedAt: Date.now() - 600_001, fence: 0, body: { requestId: "original" } }));
 const query = createQueryClient();
 function Probe() { const action = useTaskAction(f.host, "held-task");return h(TaskActionNotice, { pending: action.pending, recovery: action.recovery, taskHref: "/app/sessions/ses_aaaaaaaaaaaaaaaaaaaa", check: async () => false }); }
 const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(Probe, {}) }) }));
 expect(await screen.findByRole("link", { name: "Open the task to check" })).toBeTruthy();
 expect(f.request.mock.calls.filter(([r]) => r.method !== "GET")).toHaveLength(0);ui.unmount();query.clear();
});

for (const operation of ["changes", "approve"] as const) for (const held of [false, true]) it(`decision ${operation} catch uses the route classifier (unknown ${held})`, async () => {
 const { readFileSync } = await import("node:fs");
 const { DecisionCardsViewReaderSchema } = await import("@agentx/contracts/web");
 const { createDecisionsApi, readDecisions } = await import("../../packages/ui/src/api/decisions.js");
 const fixture = JSON.parse(readFileSync("tests/fixtures/code-decision-cards.json", "utf8")) as { views: Record<string, unknown> };
 const decision = readDecisions(DecisionCardsViewReaderSchema.parse(fixture.views["approve_plan_with_choices"]))[0]!;
 const me = meFixture(), identity = { orgId: me.org.orgId, developerId: me.developer.id };
 const f = fakeHost(async r => r.path === "/v1/app/me" ? { status: 200, body: me } : { status: held ? 503 : 409, body: { error: { code: held ? "UPSTREAM" : "CHANGE_STALE", message: "Changed" } } });
 const api = createDecisionsApi(f.host);
 const press = operation === "approve" ? api.approve(decision, undefined, undefined, undefined, identity) : api.requestChanges(decision, "Add a regression");
 await expect(press).rejects.toMatchObject({ code: held ? "APPROVAL_UNKNOWN" : "CHANGE_STALE" });
 expect(await api.hasUnknownApproval(decision, identity)).toBe(held);
});
