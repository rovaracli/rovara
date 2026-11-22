// @vitest-environment jsdom
import { SessionResponseReaderSchema } from "@agentx/contracts/web";
import { expect, it } from "vitest";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { createTaskSessionApi } from "../../packages/ui/src/api/sessions.js";
import { TaskPane } from "../../packages/ui/src/screens/work/TaskPane.js";
import { readTask, workRows } from "../../packages/ui/src/api/work.js";
import { AppHostProvider } from "../../packages/ui/src/host.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { fakeHost } from "./support/fake-host.js";
import { meFixture } from "./support/fixtures.js";
import { understandSession } from "./support/understand-fixture.js";
import { PLAN } from "./support/work-fixture.js";
import { renderUi } from "./support/render.js";
import { h } from "./support/h.js";

for (const drift of ["round", "revision", "permission", "refused", "none"] as const) it(`R6 TaskPane plan answer checks ${drift} at send time`, async () => {
 const plan = { ...PLAN, questions: PLAN.questions.map(q => ({ ...q, questionId: "q1", options: q.options.map((o, i) => ({ ...o, optionId: i === 0 ? "a" : "b" })) })) };
 const session = understandSession({ revision: 8 });
 if (session.body.kind !== "task" || session.body.task.workflow?.intent === undefined) throw new Error("Expected a question round");
 session.body.task.workflow.intent.rounds = 1;
 session.body.task.workflow.intent.assessment = { kind: "questions", restatement: "Answer this plan question", questions: plan.questions.map(q => ({ id: q.questionId, text: q.text, options: q.options.map(o => ({ id: o.optionId, label: o.label })) })) };
 // Work's list projector exposes intent.rounds as workflow.round; the session read keeps Code's intent.
 const task = readTask({ ...session.body.task, workflow: { ...session.body.task.workflow, round: 1 }, sessionId: session.sessionId });expect(task).toBeDefined();
 const row = workRows([task!], [], new Date())[0]!;
 const fresh = { ...session, you: { ...session.you, level: drift === "permission" ? "view" : "edit" }, body: { kind: "task", task: { ...session.body.task, workflow: { ...session.body.task.workflow, intent: { ...session.body.task.workflow.intent, rounds: drift === "round" ? 2 : 1 }, revision: drift === "revision" ? 9 : 8 } } } };
 const authority = SessionResponseReaderSchema.parse({ session: fresh });
 const f = fakeHost(async r => r.path === "/v1/app/me" ? { status: 200, body: meFixture() } : r.path === "/v1/app/sessions/" + session.sessionId && r.method === "GET" ? drift === "refused" ? { status: 403, body: { error: { code: "FORBIDDEN", message: "Task access was removed." } } } : { status: 200, body: authority } : r.method === "POST" ? { status: 200, body: {} } : r.path.endsWith("/plan") ? { status: 200, body: plan } : { status: 404, body: { error: { code: "NOT_FOUND", message: "route not found" } } });
 const query = createQueryClient(), ui = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(MemoryRouter, { children: h(TaskPane, { row, decisionsError: undefined, onDecided: () => undefined }) }) }) }));
 try {
  fireEvent.click(await screen.findByRole("button", { name: /^Spec,/u }));
  const yes = await screen.findByRole<HTMLButtonElement>("button", { name: "Yes, behind a flag" });await waitFor(() => expect(yes.disabled).toBe(false));fireEvent.click(yes);
  if (drift !== "none") await screen.findByTestId("answer-error");
  await waitFor(() => expect(f.request.mock.calls.some(([r]) => r.method === "GET" && r.path === "/v1/app/sessions/" + session.sessionId)).toBe(true));
  if (drift === "none") await waitFor(() => expect(f.request.mock.calls.filter(([r]) => r.method === "POST")).toHaveLength(1));
  const writes = f.request.mock.calls.filter(([r]) => r.method === "POST");
  expect(writes).toHaveLength(drift === "none" ? 1 : 0);
  if (drift === "none") expect(writes[0]![0].body).toMatchObject({ round: 1, revision: 8, answers: [{ questionId: "q1", optionId: "a" }] });
 } finally { ui.unmount();query.clear(); }
});

for (const newer of ["403", "503", "permission", "round", "revision", "same", "pending", "none"] as const) it(`R7-1 queued plan answer refuses a newer ${newer} session read`, async () => {
 const plan = { ...PLAN, questions: PLAN.questions.map(q => ({ ...q, questionId: "q1", options: q.options.map((o, i) => ({ ...o, optionId: i === 0 ? "a" : "b" })) })) };
 const session = understandSession({ revision: 8 });
 if (session.body.kind !== "task" || session.body.task.workflow?.intent === undefined) throw new Error("Expected a question round");
 session.you.level = "edit";
 session.body.task.workflow.intent.rounds = 1;
 session.body.task.workflow.intent.assessment = { kind: "questions", restatement: "Answer this plan question", questions: plan.questions.map(q => ({ id: q.questionId, text: q.text, options: q.options.map(o => ({ id: o.optionId, label: o.label })) })) };
 const authority = SessionResponseReaderSchema.parse({ session });
 const task = readTask({ ...session.body.task, workflow: { ...session.body.task.workflow, round: 1 }, sessionId: session.sessionId });expect(task).toBeDefined();
 const row = workRows([task!], [], new Date())[0]!, path = "/v1/app/sessions/" + session.sessionId;
 const later = SessionResponseReaderSchema.parse({ session: { ...session, you: { ...session.you, level: newer === "permission" ? "view" : "edit" }, body: { kind: "task", task: { ...session.body.task, workflow: { ...session.body.task.workflow, revision: newer === "revision" ? 9 : 8, intent: { ...session.body.task.workflow.intent, rounds: newer === "round" ? 2 : 1 } } } } } });
 let sessionReads = 0, finishRead: (() => void) | undefined;
 const f = fakeHost(async r => {
  if (r.path === "/v1/app/me") return { status: 200, body: meFixture() };
  if (r.method === "GET" && r.path === path) {
   sessionReads++;
   if (sessionReads === 1) return { status: 200, body: authority };
   if (newer === "403" || newer === "503") return { status: Number(newer), body: { error: { code: newer === "403" ? "FORBIDDEN" : "UPSTREAM", message: "The newer session read failed." } } };
   if (newer === "pending") await new Promise<void>(resolve => { finishRead = resolve; });
   return { status: 200, body: later };
  }
  if (r.path === path + "/answers" && r.method === "POST") return { status: 200, body: {} };
  if (r.path.endsWith("/plan")) return { status: 200, body: plan };
  return { status: 404, body: { error: { code: "NOT_FOUND", message: "route not found" } } };
 });
 const query = createQueryClient(), ui = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(MemoryRouter, { children: h(TaskPane, { row, decisionsError: undefined, onDecided: () => undefined }) }) }) }));
 const descriptor = Object.getOwnPropertyDescriptor(navigator, "locks")!;
 let claim: (() => Promise<unknown>) | undefined, laterRead: Promise<unknown> | undefined;
 Object.defineProperty(navigator, "locks", { configurable: true, value: { request: (_name: string, _options: unknown, callback: (lock: unknown) => Promise<unknown>) => new Promise((resolve, reject) => { claim = async () => { try { const result = await callback({ name: "plan-answer-r7", mode: "exclusive" });resolve(result);return result; } catch (error) { reject(error instanceof Error ? error : new Error(String(error)));throw error; } }; }) } });
 try {
  fireEvent.click(await screen.findByRole("button", { name: /^Spec,/u }));
  const yes = await screen.findByRole<HTMLButtonElement>("button", { name: "Yes, behind a flag" });await waitFor(() => expect(yes.disabled).toBe(false));fireEvent.click(yes);
  await waitFor(() => expect(claim).toBeTypeOf("function"));expect(sessionReads).toBe(1);
  const cached = query.getQueryState(["session", session.sessionId]);
  if (newer !== "none") {
   laterRead = createTaskSessionApi(f.host).read(session.sessionId);
   if (newer === "403" || newer === "503") await expect(laterRead).rejects.toMatchObject({ status: Number(newer) });
   else if (newer === "pending") await waitFor(() => expect(finishRead).toBeTypeOf("function"));
   else expect(await laterRead).toEqual(later.session);
  }
  // Direct readers update the shared session fence, without changing this query.
  expect(query.getQueryState(["session", session.sessionId])).toBe(cached);
  await act(async () => { await claim!(); });
  const writes = f.request.mock.calls.filter(([r]) => r.method === "POST");
  expect(writes).toHaveLength(newer === "none" ? 1 : 0);
  if (newer !== "none") await screen.findByTestId("answer-error");
  if (newer === "none") expect(writes[0]![0]).toMatchObject({ path: path + "/answers", body: { round: 1, revision: 8, answers: [{ questionId: "q1", optionId: "a" }] } });
  expect(sessionReads).toBe(newer === "none" ? 1 : 2);
 } finally { finishRead?.();await laterRead?.catch(() => undefined);Object.defineProperty(navigator, "locks", descriptor);ui.unmount();query.clear(); }
});
