// @vitest-environment jsdom
// Live buttons on the session page: "Ask about this task" (`you.live.ask`) and "Fix with agent" (`you.live.fix` with the session's errorRef).
// Hidden when the server does not offer them (the rendered page is byte-identical to one that never knew about them) and no request is made just by opening the page.
import { expect, it } from "vitest";
import { useState } from "react";
import { screen, fireEvent, waitFor, act } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { DIAGNOSIS_ANSWER_LABEL, DIAGNOSIS_NO_PROVIDER_MESSAGE, ASK_ANSWER_LABEL, SessionViewReaderSchema } from "@agentx/contracts/web";
import { workspaceFixture as fixture } from "./support/workspace-fixture.js";
import { Workspace } from "../../packages/ui/src/screens/session/Workspace.js";
import { SessionControls } from "../../packages/ui/src/screens/session/SessionControls.js";
import { AppHostProvider } from "../../packages/ui/src/host.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { renderUi } from "./support/render.js";
import { fakeHost } from "./support/fake-host.js";
import { h } from "./support/h.js";
import { expectNoAxeViolations } from "./support/axe.js";
import { SESSION_FIXTURE_ID } from "./support/session-fixture.js";
import type { ApiRequest, ApiResponse } from "../../packages/ui/src/host.js";

const ERROR_REF = { kind: "operation_failed", code: "CHECK_FAILED", subject: { taskId: "11111111-1111-4111-8111-111111111111" }, at: "2026-10-23T12:00:00.000Z" };
const DIAGNOSIS_ID = "dgn_aaaaaaaaaaaaaaaaaaaa", ASK_ID = "ask_aaaaaaaaaaaaaaaaaaaa";
const refusal = (status: number, code: string, message: string): ApiResponse => ({ status, body: { error: { code, message } } });

function sessionWith(live: { ask?: true; fix?: true } | undefined, errorRef: boolean) {
 const base = fixture();
 return SessionViewReaderSchema.parse({ ...base, ...(errorRef ? { errorRef: ERROR_REF } : {}), you: { ...base.you, ...(live === undefined ? {} : { live }) } });
}
function mount(element: ReturnType<typeof h>, respond: (request: ApiRequest) => Promise<ApiResponse>) {
 const f = fakeHost(respond), query = createQueryClient();
 const router = createMemoryRouter([{ path: "*", element }], { initialEntries: ["/app/sessions/" + SESSION_FIXTURE_ID] });
 const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(RouterProvider, { router }) }) }));
 return { ...ui, f, close() { ui.unmount(); router.dispose(); query.clear(); } };
}
const workspace = (session: ReturnType<typeof sessionWith>, respond: (request: ApiRequest) => Promise<ApiResponse> = async () => ({ status: 404, body: {} })) =>
 mount(h("main", {}, h(Workspace, { session, onComment: () => undefined })), respond);
const controls = (ask: boolean | undefined, respond: (request: ApiRequest) => Promise<ApiResponse> = async () => ({ status: 404, body: {} })) =>
 mount(h("main", {}, h(SessionControls, { id: SESSION_FIXTURE_ID, agent: "Payments expert", actions: ["watch", "comment", "steer"], following: false, onChanged: async () => undefined, ...(ask === undefined ? {} : { ask }) })), respond);
const calls = (f: { request: { mock: { calls: Array<[ApiRequest]> } } }) => f.request.mock.calls.map(([request]) => request.method + " " + request.path);
const idle = () => new Promise(resolve => setTimeout(resolve, 60));

it("renders the page byte-identically unless the server offers Fix with agent for the error it shows", async () => {
 const html = async (session: ReturnType<typeof sessionWith>) => { const s = workspace(session);await screen.findByRole("region", { name: "Work progress" }).catch(() => undefined);await idle();const out = s.container.innerHTML.replace(/_r_[0-9a-z]+_/g, "_r_N_");s.close();return out; };
 const plain = await html(sessionWith(undefined, false));
 expect(await html(sessionWith(undefined, true))).toBe(plain);
 expect(await html(sessionWith({ fix: true }, false))).toBe(plain);
 expect(await html(sessionWith({ ask: true }, true))).toBe(plain);
 const offered = workspace(sessionWith({ fix: true }, true));
 await screen.findByRole("button", { name: "Fix with agent" });
 expect(offered.container.innerHTML.replace(/_r_[0-9a-z]+_/g, "_r_N_")).not.toBe(plain);
 offered.close();
});

it("renders the session controls byte-identically unless the server offers Ask", async () => {
 const html = async (ask: boolean | undefined) => { const s = controls(ask);await idle();const out = s.container.innerHTML;s.close();return out; };
 const plain = await html(undefined);
 expect(await html(false)).toBe(plain);
 const offered = controls(true);
 await screen.findByText("Ask about this task");
 expect(offered.container.innerHTML).not.toBe(plain);
 offered.close();
});

it("makes no request to ask or diagnose just by opening the page", async () => {
 const a = workspace(sessionWith({ ask: true, fix: true }, true));
 await screen.findByRole("button", { name: "Fix with agent" });
 const b = controls(true);
 await screen.findByText("Ask about this task");
 await idle();
 for (const s of [a, b]) expect(calls(s.f).filter(call => /\/ask|\/asks\/|\/diagnoses/.test(call))).toEqual([]);
 a.close();b.close();
});

it("asks a question, polls until it is answered and shows the answer as plain text with its label", async () => {
 let reads = 0, posted: unknown;
 const hostile = "Refunds failed on retry. <img src=x onerror=alert(1)> **not bold**";
 const s = controls(true, async request => {
  if (request.method === "POST" && request.path === "/v1/app/sessions/" + SESSION_FIXTURE_ID + "/ask") { posted = request.body;return { status: 202, body: { askId: ASK_ID, state: "queued" } }; }
  if (request.path === "/v1/app/sessions/" + SESSION_FIXTURE_ID + "/asks/" + ASK_ID) return { status: 200, body: ++reads < 2 ? { askId: ASK_ID, state: "queued" } : { askId: ASK_ID, state: "answered", answer: hostile } };
  return { status: 404, body: {} };
 });
 fireEvent.click(await screen.findByText("Ask about this task"));
 fireEvent.change(await screen.findByLabelText("Your question"), { target: { value: "  Why did it fail?  " } });
 fireEvent.click(screen.getByRole("button", { name: "Ask" }));
 await screen.findByText("Working on an answer");
 const answer = await screen.findByText(/Refunds failed on retry/, undefined, { timeout: 6000 });
 expect(answer.textContent).toBe(hostile);
 expect(s.container.querySelector("img")).toBeNull();
 expect(s.container.querySelector("strong")).toBeNull();
 expect(screen.getByText(ASK_ANSWER_LABEL)).toBeTruthy();
 expect(posted).toMatchObject({ question: "Why did it fail?" });
 expect((posted as { requestId: string }).requestId).toMatch(/^[0-9a-f-]{36}$/);
 await expectNoAxeViolations(s.container);
 s.close();
}, 15000);

it("shows the server's refusal of an Ask plainly and no answer", async () => {
 const message = "You need to be able to use this task to ask about it.";
 const s = controls(true, async () => refusal(403, "SESSION_LEVEL_REQUIRED", message));
 fireEvent.click(await screen.findByText("Ask about this task"));
 fireEvent.change(await screen.findByLabelText("Your question"), { target: { value: "Why?" } });
 fireEvent.click(screen.getByRole("button", { name: "Ask" }));
 expect((await screen.findByRole("alert")).textContent).toBe(message);
 expect(screen.queryByText(ASK_ANSWER_LABEL)).toBeNull();
 s.close();
});

it("asks for a diagnosis of the error the session shows, then shows the explanation and proposals with no apply button", async () => {
 let reads = 0, posted: unknown;
 const proposals = [{ kind: "explain", text: "The check failed because the lockfile is stale." }, { kind: "settings_change", target: "code_settings", path: "install.command", from: "npm install", to: "npm ci", citations: ["package-lock.json"] }, { kind: "admin_steps", steps: ["Open Settings.", "Re-run setup."] }];
 const s = workspace(sessionWith({ fix: true }, true), async request => {
  if (request.method === "POST" && request.path === "/v1/app/diagnoses") { posted = request.body;return { status: 202, body: { diagnosisId: DIAGNOSIS_ID, tier: "light", state: "queued", errorRef: ERROR_REF } }; }
  if (request.path === "/v1/app/diagnoses/" + DIAGNOSIS_ID) return { status: 200, body: ++reads < 2 ? { diagnosisId: DIAGNOSIS_ID, tier: "light", state: "queued", errorRef: ERROR_REF } : { diagnosisId: DIAGNOSIS_ID, tier: "light", state: "ready", errorRef: ERROR_REF, proposals, droppedProposals: 0 } };
  return { status: 404, body: {} };
 });
 fireEvent.click(await screen.findByRole("button", { name: "Fix with agent" }));
 await screen.findByText("Looking into this error");
 expect(await screen.findByText("The check failed because the lockfile is stale.", undefined, { timeout: 8000 })).toBeTruthy();
 expect(posted).toMatchObject({ errorRef: ERROR_REF });
 expect((posted as { requestId: string }).requestId).toMatch(/^[0-9a-f-]{36}$/);
 const text = s.container.textContent ?? "";
 expect(text).toContain("npm install");
 expect(text).toContain("npm ci");
 expect(text).toContain("Re-run setup.");
 expect(screen.getByText(DIAGNOSIS_ANSWER_LABEL)).toBeTruthy();
 expect(screen.queryByRole("button", { name: /apply/i })).toBeNull();
 await expectNoAxeViolations(s.container);
 s.close();
}, 15000);

it("shows the server's no-provider sentence exactly, and its other refusals plainly", async () => {
 const none = workspace(sessionWith({ fix: true }, true), async () => refusal(403, "MODEL_NOT_ALLOWED", DIAGNOSIS_NO_PROVIDER_MESSAGE));
 fireEvent.click(await screen.findByRole("button", { name: "Fix with agent" }));
 expect((await screen.findByRole("alert")).textContent).toBe("Diagnosis uses your company's AI provider. Connect one in Settings to turn it on.");
 none.close();
 const refused = workspace(sessionWith({ fix: true }, true), async () => refusal(403, "FORBIDDEN", "You can't ask for a diagnosis of this error."));
 fireEvent.click(await screen.findByRole("button", { name: "Fix with agent" }));
 await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("You can't ask for a diagnosis of this error."));
 refused.close();
});

const askPath = "/v1/app/sessions/" + SESSION_FIXTURE_ID + "/ask", askStatusPath = askPath.replace(/ask$/, "asks/" + ASK_ID);
const diagnosisStatusPath = "/v1/app/diagnoses/" + DIAGNOSIS_ID;
const bodies = (f: { request: { mock: { calls: Array<[ApiRequest]> } } }, method: string, path: string) => f.request.mock.calls.map(([request]) => request).filter(request => request.method === method && request.path === path).map(request => request.body as { requestId: string; question?: string });
const openAsk = async (question: string) => {
 const summary = screen.queryByLabelText("Your question") === null ? await screen.findByText("Ask about this task") : undefined;
 if (summary !== undefined) fireEvent.click(summary);
 fireEvent.change(await screen.findByLabelText("Your question"), { target: { value: question } });
 fireEvent.click(screen.getByRole("button", { name: "Ask" }));
};

it("stops polling an Ask when reading it fails, says so plainly, and reads once more on Try again", async () => {
 const s = controls(true, async request => request.method === "POST" ? { status: 202, body: { askId: ASK_ID, state: "queued" } } : refusal(404, "NOT_FOUND", "This item wasn't found, or you no longer have access."));
 await openAsk("Why?");
 expect((await screen.findByRole("alert")).textContent).toContain("no longer have access");
 const count = () => calls(s.f).filter(call => call === "GET " + askStatusPath).length;
 expect(count()).toBe(1);
 await new Promise(resolve => setTimeout(resolve, 4500));
 expect(count()).toBe(1);
 fireEvent.click(screen.getByRole("button", { name: "Try again" }));
 await waitFor(() => expect(count()).toBe(2));
 s.close();
}, 15000);

it("stops polling a diagnosis when reading it fails or its state is not one this page knows, and reads once more on Try again", async () => {
 for (const answer of [refusal(404, "NOT_FOUND", "This item wasn't found, or you no longer have access."), { status: 200, body: { diagnosisId: DIAGNOSIS_ID, tier: "light", state: "paused", errorRef: ERROR_REF } } as ApiResponse]) {
  const s = workspace(sessionWith({ fix: true }, true), async request => request.method === "POST" ? { status: 202, body: { diagnosisId: DIAGNOSIS_ID, tier: "light", state: "queued", errorRef: ERROR_REF } } : answer);
  fireEvent.click(await screen.findByRole("button", { name: "Fix with agent" }));
  await screen.findByRole("button", { name: "Try again" });
  const count = () => calls(s.f).filter(call => call === "GET " + diagnosisStatusPath).length;
  expect(count()).toBe(1);
  await new Promise(resolve => setTimeout(resolve, 3500));
  expect(count()).toBe(1);
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  await waitFor(() => expect(count()).toBe(2));
  s.close();
 }
}, 20000);

it("sends a new request id for each new question and after a failed Ask, and keeps it only after a lost reply", async () => {
 let outcome: "answered" | "failed" = "answered", lost = false, n = 0;
 const idOf = (count: number) => "ask_" + String(count).padStart(20, "a");
 const s = controls(true, async request => {
  if (request.method === "POST") return lost ? refusal(503, "RUNTIME_UNAVAILABLE", "Couldn't answer that just now.") : { status: 202, body: { askId: idOf(++n), state: "queued" } };
  const askId = request.path.split("/").pop()!;
  return { status: 200, body: outcome === "answered" ? { askId, state: "answered", answer: "Because." } : { askId, state: "failed" } };
 });
 await openAsk("First?");
 await screen.findByText("Because.");
 await openAsk("Second?");
 await waitFor(() => expect(bodies(s.f, "POST", askPath)).toHaveLength(2));
 await screen.findByText("Because.");
 const [first, second] = bodies(s.f, "POST", askPath);
 expect(second!.requestId).not.toBe(first!.requestId);
 // The same question again after an answer is the same Ask.
 await openAsk("Second?");
 await waitFor(() => expect(bodies(s.f, "POST", askPath)).toHaveLength(3));
 await screen.findByText("Because.");
 expect(bodies(s.f, "POST", askPath)[2]!.requestId).toBe(second!.requestId);
 // A lost reply keeps the id, so the retry cannot ask twice.
 lost = true;
 await openAsk("Third?");
 await waitFor(() => expect(bodies(s.f, "POST", askPath)).toHaveLength(4));
 await screen.findByRole("alert");
 await openAsk("Third?");
 await waitFor(() => expect(bodies(s.f, "POST", askPath)).toHaveLength(5));
 const [, , , third, thirdAgain] = bodies(s.f, "POST", askPath);
 expect(thirdAgain!.requestId).toBe(third!.requestId);
 // A failed Ask is replayed by the server for its id, so asking again needs a new one.
 lost = false;outcome = "failed";
 await openAsk("Fourth?");
 await screen.findByText("Couldn't answer that just now.");
 await openAsk("Fourth?");
 await waitFor(() => expect(bodies(s.f, "POST", askPath)).toHaveLength(7));
 const [, , , , , fourth, fourthAgain] = bodies(s.f, "POST", askPath);
 expect(fourthAgain!.requestId).not.toBe(fourth!.requestId);
 s.close();
}, 30000);

it("sends a new request id after a failed diagnosis, and keeps it after a lost reply", async () => {
 let lost = true;
 const s = workspace(sessionWith({ fix: true }, true), async request => {
  if (request.method === "POST") return lost ? refusal(503, "RUNTIME_UNAVAILABLE", "Couldn't diagnose this now.") : { status: 202, body: { diagnosisId: DIAGNOSIS_ID, tier: "light", state: "queued", errorRef: ERROR_REF } };
  return { status: 200, body: { diagnosisId: DIAGNOSIS_ID, tier: "light", state: "failed", errorRef: ERROR_REF, failure: "Couldn't diagnose this now." } };
 });
 const press = () => fireEvent.click(screen.getByRole("button", { name: "Fix with agent" }));
 press();await screen.findByRole("alert");
 await waitFor(() => expect(screen.getByRole("button", { name: "Fix with agent" }).hasAttribute("disabled")).toBe(false));
 press();await waitFor(() => expect(bodies(s.f, "POST", "/v1/app/diagnoses")).toHaveLength(2));
 const lostOnes = bodies(s.f, "POST", "/v1/app/diagnoses");
 expect(lostOnes[1]!.requestId).toBe(lostOnes[0]!.requestId);
 lost = false;
 await waitFor(() => expect(screen.getByRole("button", { name: "Fix with agent" }).hasAttribute("disabled")).toBe(false));
 press();
 await screen.findByText("Couldn't diagnose this now.");
 await waitFor(() => expect(screen.getByRole("button", { name: "Fix with agent" }).hasAttribute("disabled")).toBe(false));
 press();
 await waitFor(() => expect(bodies(s.f, "POST", "/v1/app/diagnoses")).toHaveLength(4));
 const all = bodies(s.f, "POST", "/v1/app/diagnoses");
 expect(all[3]!.requestId).not.toBe(all[2]!.requestId);
 s.close();
}, 20000);

it("gives a new error a fresh Fix with agent panel, and keeps the panel when only the error's time changes", async () => {
 const respond = async (request: ApiRequest): Promise<ApiResponse> => request.method === "POST"
  ? { status: 202, body: { diagnosisId: DIAGNOSIS_ID, tier: "light", state: "queued", errorRef: ERROR_REF } }
  : { status: 200, body: { diagnosisId: DIAGNOSIS_ID, tier: "light", state: "ready", errorRef: ERROR_REF, proposals: [{ kind: "explain", text: "Old error: stale lockfile." }] } };
 const a = sessionWith({ fix: true }, true);
 const later = SessionViewReaderSchema.parse({ ...a, errorRef: { ...ERROR_REF, at: "2026-10-23T13:00:00.000Z" } });
 const other = SessionViewReaderSchema.parse({ ...a, errorRef: { ...ERROR_REF, code: "TESTS_FAILED" } });
 let swap: (view: ReturnType<typeof sessionWith>) => void = () => undefined;
 function Host() { const [view, setView] = useState(a);swap = setView;return h(Workspace, { session: view, onComment: () => undefined }); }
 const s = mount(h("main", {}, h(Host, {})), respond);
 fireEvent.click(await screen.findByRole("button", { name: "Fix with agent" }));
 await screen.findByText("Old error: stale lockfile.", undefined, { timeout: 6000 });
 act(() => { swap(later); });
 expect(screen.getByText("Old error: stale lockfile.")).toBeTruthy();
 act(() => { swap(other); });
 await waitFor(() => expect(screen.queryByText("Old error: stale lockfile.")).toBeNull());
 fireEvent.click(await screen.findByRole("button", { name: "Fix with agent" }));
 await waitFor(() => expect(bodies(s.f, "POST", "/v1/app/diagnoses")).toHaveLength(2));
 const [one, two] = bodies(s.f, "POST", "/v1/app/diagnoses");
 expect(two!.requestId).not.toBe(one!.requestId);
 expect((two as unknown as { errorRef: { code: string } }).errorRef.code).toBe("TESTS_FAILED");
 s.close();
}, 20000);
