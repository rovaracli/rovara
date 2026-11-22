// @vitest-environment jsdom
import { expect, it } from "vitest";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { errorRefKey } from "@agentx/contracts/web";
import { AppHostProvider, type ApiResponse } from "../../packages/ui/src/host.js";
import { FixWithAgentPanel } from "../../packages/ui/src/screens/session/FixWithAgentPanel.js";
import { MoneyBanners } from "../../packages/ui/src/screens/session/MoneyBanners.js";
import { TaskActions } from "../../packages/ui/src/screens/session/TaskActions.js";
import { UnderstandQuestions } from "../../packages/ui/src/screens/session/UnderstandQuestions.js";
import { readSessionIdentity, readFrozenSessionRequest, sessionScope } from "../../packages/ui/src/api/session-safety.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { fakeHost } from "./support/fake-host.js";
import { meFixture } from "./support/fixtures.js";
import { workspaceFixture, workspaceWorkflow } from "./support/workspace-fixture.js";
import { understandSession } from "./support/understand-fixture.js";
import { renderUi } from "./support/render.js";
import { h } from "./support/h.js";
const errorRef = { kind: "operation_failed" as const, code: "CHECK_FAILED", subject: { taskId: "11111111-1111-4111-8111-111111111111" }, at: "2026-10-23T12:00:00.000Z" };
it.each(["diagnosis", "normal", "tool", "answers"] as const)("R6g: %s retains the old person's pending request when identity changes before its response", async operation => {
 const session = operation === "answers" ? understandSession() : workspaceFixture({}, { testOffer: { capUsd: 1 }, workflow: { ...workspaceWorkflow(), state: "RUNNING", stage: "IMPLEMENT" } });
 if (session.body.kind !== "task") throw new Error("Task required");const task = session.body.task;
 let me = meFixture();const oldIdentity = { companyId: me.org.orgId, personId: me.developer.id };
 let finish!: (response: ApiResponse) => void;
 const f = fakeHost(async r => r.path === "/v1/app/me" ? { status: 200, body: me } : r.method === "GET" ? { status: 200, body: r.path === "/v1/app/sessions" ? { tasks: [task] } : { session: operation === "diagnosis" ? { ...session, errorRef, you: { ...session.you, live: { fix: true } } } : session } } : new Promise<ApiResponse>(resolve => { finish = resolve; }));
 const query = createQueryClient();
 const element = operation === "diagnosis" ? h(FixWithAgentPanel, { sessionId: session.sessionId, errorRef }) : operation === "normal" ? h(MoneyBanners, { session }) : operation === "tool" ? h(TaskActions, { taskId: task.taskId, sessionId: session.sessionId, canContinue: true, showNote: false }) : h(UnderstandQuestions, { session, task });
 const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: element }) }));
 if (operation === "answers") { fireEvent.click(await screen.findByRole("radio", { name: /The payments table/ }));fireEvent.change(screen.getByRole("textbox", { name: /Should old refunds be migrated/ }), { target: { value: "Keep history" } }); }
 const label = operation === "diagnosis" ? "Fix with agent" : operation === "normal" ? "Continue as a normal task" : operation === "tool" ? "Continue in my tool" : "Send answers";
 const button = await screen.findByRole<HTMLButtonElement>("button", { name: label });await waitFor(() => expect(button.disabled).toBe(false));fireEvent.click(button);
 await waitFor(() => expect(f.request.mock.calls.filter(([r]) => r.method === "POST")).toHaveLength(1));
 const subject = operation === "diagnosis" ? "diagnosis:" + errorRefKey(errorRef) : operation === "normal" ? "normal-task:" + session.sessionId : operation === "tool" ? "continue:" + task.taskId : session.sessionId + ":answers:1";
 const scope = sessionScope(oldIdentity, subject), pending = readFrozenSessionRequest(f.host, scope);expect(pending).toBeDefined();
 me = { ...me, developer: { ...me.developer, id: "b".repeat(64) } };
 await act(async () => {
  await readSessionIdentity(f.host);
  finish({ status: 200, body: operation === "diagnosis" ? { diagnosisId: "dgn_aaaaaaaaaaaaaaaaaaaa", tier: "light", state: "queued", errorRef } : operation === "normal" ? { task } : operation === "answers" ? { session } : {} });
  await new Promise(resolve => setTimeout(resolve, 20));
 });
 expect(readFrozenSessionRequest(f.host, scope)?.requestId).toBe(pending!.requestId);
 ui.unmount();query.clear();
});
