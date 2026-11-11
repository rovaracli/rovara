// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { screen, fireEvent, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { PROCESS_START_REFUSED_MESSAGE } from "@agentx/cloud-contracts/web";
import { ProjectScreen } from "../../packages/ui/src/screens/project/ProjectScreen.js";
import { createRunApi } from "../../packages/ui/src/api/runs.js";
import { createCodeApi } from "../../packages/ui/src/api/code.js";
import { howWeWorkKey } from "../../packages/ui/src/api/how-we-work.js";
import { AppHostProvider, type ApiRequest, type ApiResponse } from "../../packages/ui/src/host.js";
import { Announcer } from "../../packages/ui/src/design/Announcer.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { renderUi } from "./support/render.js";
import { expectNoAxeViolations } from "./support/axe.js";
import { fakeHost } from "./support/fake-host.js";
import { h } from "./support/h.js";
import { projectFixture } from "./support/project-fixture.js";
import { taskFixture, sessionFixture } from "./support/session-fixture.js";
import { LAYER, howWeWorkView } from "./support/how-we-work-view.js";
import { liveFixture } from "./support/live-fixture.js";
// jsdom has no ResizeObserver, which the checkbox inside a form measures with.
globalThis.ResizeObserver ??= class { observe(): void { /* none */ } unobserve(): void { /* none */ } disconnect(): void { /* none */ } };
const id = "ses_bbbbbbbbbbbbbbbbbbbb", CODE = "/v1/app/projects/payments/code";
const started = () => ({ status: 202, body: { task: taskFixture({ sessionId: id }), sessionId: id, sessionUrl: "https://cell.example/s/" + id } });
// Match json-reply.ts, including gateway overwrite of a route's own requestId.
function gatewayHost(...args: Parameters<typeof fakeHost>) {
 const f = fakeHost(...args);
 f.host.transport.request = async input => {
  const response = await f.request(input), body = response.body;
  return response.status === 200 && body !== null && typeof body === "object" && !Array.isArray(body) ? { ...response, body: { ...body, requestId: "mock-gateway-request" } } : response;
 };
 return f;
}
// The project page also holds the Tickets section (slice 5), which reads the intake routes; this start box test answers them as an install without intake (404, one quiet line).
function setup(value = projectFixture(), options: { theme?: "light" | "dark"; send?: (request: ApiRequest) => Promise<ApiResponse>; seed?: unknown; preview?: () => Promise<ApiResponse>; get?: (request: ApiRequest) => ApiResponse | undefined } = {}) {
 const f = gatewayHost(async request => request.path.endsWith("/start-preview") ? options.preview?.() ?? { status: 200, body: { orgId: "org_aaaaaaaaaaaaaaaaaaaa", project: "payments", kind: "disabled" } } : request.path === "/v1/app/changes" ? { status: 200, body: { notices: [], next: "settled" } } : request.path.endsWith("/setup-agent/limits") || /\/intake(\/updates)?$/u.test(request.path) ? { status: 404, body: { error: { code: "NOT_FOUND", message: "Not found." } } } : request.method === "GET" ? (options.get?.(request) ?? { status: 200, body: value }) : options.send ? options.send(request) : started());
 const query = createQueryClient();
 if (options.seed !== undefined) query.setQueryData([...howWeWorkKey("payments"), "view"], options.seed);
 const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(MemoryRouter, { initialEntries: ["/app/projects/payments"], children: h(Announcer, { children: h(Routes, { children: h(Route, { path: "/app/projects/:name", element: h(ProjectScreen, {}) }) }) }) }) }) }), { theme: options.theme ?? "light" });
 return { ...f, ...ui, query, close() { ui.unmount();query.clear(); } };
}
const posts = (f: ReturnType<typeof setup>) => f.request.mock.calls.map(([request]) => request).filter(request => request.method === "POST" && !request.path.endsWith("/start-preview"));
const box = () => screen.findByRole("textbox", { name: "What do you need?" });
it("posts the text to the project's code route and opens the returned session", async () => {
 const f = setup(), navigate = vi.spyOn(f.host, "navigate");
 fireEvent.change(await box(), { target: { value: "Fix the duplicate refunds" } });fireEvent.click(screen.getByRole("button", { name: "Start" }));
 await waitFor(() => expect(navigate).toHaveBeenCalledWith("/app/sessions/" + id));
 expect(posts(f)).toHaveLength(1);expect(posts(f)[0]).toMatchObject({ path: CODE, body: { input: { text: "Fix the duplicate refunds" }, requestId: expect.stringMatching(/^[0-9a-f-]{36}$/u) as unknown } });
 expect(Object.keys(posts(f)[0]!.body as object).sort()).toEqual(["input", "requestId"]);f.close();
});
for (const modifier of ["metaKey", "ctrlKey"] as const) it("submits with " + modifier + "+Enter but not with a bare Enter", async () => {
 const f = setup(), navigate = vi.spyOn(f.host, "navigate"), input = await box();
 fireEvent.change(input, { target: { value: "Add a retry" } });fireEvent.keyDown(input, { key: "Enter" });expect(posts(f)).toHaveLength(0);
 fireEvent.keyDown(input, { key: "Enter", [modifier]: true });await waitFor(() => expect(navigate).toHaveBeenCalledWith("/app/sessions/" + id));expect(posts(f)).toHaveLength(1);f.close();
});
it("sends once while a start is in flight and disables the box", async () => {
 let finish: ((value: ApiResponse) => void) | undefined;const send = vi.fn(async () => new Promise<ApiResponse>(resolve => { finish = resolve; }));
 const f = setup(undefined, { send }), navigate = vi.spyOn(f.host, "navigate"), input = await box();fireEvent.change(input, { target: { value: "Add a retry" } });
 const start = screen.getByRole<HTMLButtonElement>("button", { name: "Start" });fireEvent.click(start);fireEvent.click(start);fireEvent.keyDown(input, { key: "Enter", metaKey: true });
 expect(send).toHaveBeenCalledTimes(1);expect((input as HTMLTextAreaElement).disabled).toBe(true);expect(start.disabled).toBe(true);
 finish?.(started());await waitFor(() => expect(navigate).toHaveBeenCalledWith("/app/sessions/" + id));f.close();
});
it("counts characters and cannot submit text over 4,000 characters or blank text", async () => {
 const f = setup(), input = await box(), start = screen.getByRole<HTMLButtonElement>("button", { name: "Start" });
 expect(start.disabled).toBe(true);expect(screen.getByText("0 / 4000")).toBeTruthy();
 fireEvent.change(input, { target: { value: "   " } });expect(start.disabled).toBe(true);
 fireEvent.change(input, { target: { value: "x".repeat(4000) } });expect(screen.getByText("4000 / 4000")).toBeTruthy();expect(start.disabled).toBe(false);
 fireEvent.change(input, { target: { value: "x".repeat(4001) } });expect(screen.getByText("4001 / 4000")).toBeTruthy();expect(start.disabled).toBe(true);
 fireEvent.click(start);fireEvent.keyDown(input, { key: "Enter", metaKey: true });expect(posts(f)).toHaveLength(0);f.close();
});
it("shows no box to a viewer", async () => {
 const f = setup(projectFixture({ you: { role: "viewer", canStartWork: false, canEditSettings: false, canViewSpend: false } }));await screen.findByRole("heading", { name: "payments" });
 expect(screen.queryByRole("textbox", { name: "What do you need?" })).toBeNull();expect(screen.queryByRole("button", { name: "Start" })).toBeNull();expect(screen.queryByText(/^Runs:/u)).toBeNull();f.close();
});
it("shows PROCESS_UNAVAILABLE's message and does not navigate", async () => {
 const f = setup(undefined, { send: async () => ({ status: 400, body: { error: { code: "PROCESS_UNAVAILABLE", message: PROCESS_START_REFUSED_MESSAGE } } }) }), navigate = vi.spyOn(f.host, "navigate");
 fireEvent.change(await box(), { target: { value: "Fix it" } });fireEvent.click(screen.getByRole("button", { name: "Start" }));
 expect((await screen.findByRole("alert")).textContent).toBe(PROCESS_START_REFUSED_MESSAGE);expect(navigate).not.toHaveBeenCalled();
 expect((await box() as HTMLTextAreaElement).value).toBe("Fix it");f.close();
});
it("maps the route's fixed codes to plain messages, whatever message came with them", async () => {
 const cases: Array<[number, string, string | RegExp]> = [[400, "PROCESS_UNAVAILABLE", PROCESS_START_REFUSED_MESSAGE], [404, "PROJECT_NOT_FOUND", /wasn't found/u], [403, "FORBIDDEN", /permission/u], [400, "CONFIG_INVALID", /4000/u], [409, "IDEMPOTENCY_CONFLICT", /different/u], [503, "RUNTIME_UNAVAILABLE", /right now/u]];
 for (const [status, code, expected] of cases) {
  const f = gatewayHost(async () => ({ status, body: { error: { code, message: "raw server words" } } })), api = createCodeApi(f.host);
  const failure = await api.startCode("payments", "Fix it").then(() => undefined, (error: unknown) => error as Error);
  expect(failure?.message, code).toMatch(expected instanceof RegExp ? expected : new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));expect(failure?.message).not.toContain("raw server words");
 }
});
it("startCode returns the session id and url from the route's answer", async () => {
 const f = gatewayHost(async () => started()), api = createCodeApi(f.host), result = await api.startCode("payments", "Fix it");
 expect(result).toMatchObject({ kind: "done", value: { sessionId: id } });expect(f.request.mock.calls[0]![0]).toMatchObject({ method: "POST", path: CODE });
});
it("lists Rovara Code first in New session and starts it through the code route", async () => {
 const f = setup(), navigate = vi.spyOn(f.host, "navigate");fireEvent.click(await screen.findByRole("button", { name: "New session" }));
 const dialog = screen.getByRole("dialog"), choices = within(dialog).getAllByRole("button").filter(button => button.closest(".rv-project-choices") !== null);
 expect(choices[0]!.textContent).toBe("Describe the work (Rovara Code)");expect(choices[1]!.textContent).toBe("Payments expert");expect(within(dialog).queryByRole("button", { name: "Rovara Code" })).toBeNull();
 fireEvent.click(choices[0]!);fireEvent.change(await screen.findByRole("textbox", { name: /^What should/u }), { target: { value: "Fix the refunds" } });fireEvent.click(screen.getByRole("button", { name: "Start session" }));
 await waitFor(() => expect(navigate).toHaveBeenCalledWith("/app/sessions/" + id));expect(posts(f).map(request => request.path)).toEqual([CODE]);f.close();
});
it("routes every Rovara Code call of the runs API to the code route", async () => {
 const f = gatewayHost(async () => started()), api = createRunApi(f.host);
 const result = await api.startWork("rovara-code", { project: "payments", text: "Fix it" });expect(result.kind).toBe("done");
 expect(f.request.mock.calls.map(([request]) => request.path)).toEqual([CODE]);expect(f.request.mock.calls[0]![0].body).toMatchObject({ input: { text: "Fix it" } });
 await expect(async () => api.startWork("rovara-code", { project: "payments", text: "   " })).rejects.toThrow();await expect(async () => api.startWork("rovara-code", { project: "../x", text: "Fix it" })).rejects.toThrow();expect(f.request).toHaveBeenCalledTimes(1);
});
it("says which process runs when How we work is already loaded, and does not ask for it again otherwise", async () => {
 // UX-4b: the project page's setup checklist reads How we work for its own row, so the page asks once; the start box adds no read of its own and names the process only from that shared answer.
 const bare = setup();await box();expect(screen.getByText("Runs: this project's process")).toBeTruthy();await waitFor(() => expect(bare.request.mock.calls.filter(([request]) => request.path.includes("how-we-work")).length).toBe(1));expect(screen.getByText("Runs: this project's process")).toBeTruthy();bare.close();
 const layer = projectFixture();layer.agents.push({ agentId: LAYER, name: "Payments process", description: "How payments work", running: 0 });
 const named = setup(layer, { seed: howWeWorkView() });expect(await screen.findByText("Runs: Payments process (Rovara Code)")).toBeTruthy();named.close();
 const builtin = setup(undefined, { seed: howWeWorkView({ process: { kind: "builtin", agentId: "rovara-code" } }) });expect(await screen.findByText("Runs: the built-in process (Rovara Code)")).toBeTruthy();builtin.close();
});
it("shows a process name safely and never as markup", async () => {
 const layer = projectFixture();layer.agents.push({ agentId: LAYER, name: "<b>Evil</b>‮", description: "x", running: 0 });
 const f = setup(layer, { seed: howWeWorkView() });const line = await screen.findByText(/^Runs: /u);expect(line.querySelector("b")).toBeNull();expect(line.textContent).toContain("[U+202E]");f.close();
});
for (const theme of ["light", "dark"] as const) it("has an accessible start box in " + theme, async () => { const f = setup(undefined, { theme });await box();await expectNoAxeViolations(f.container);f.close(); });

const LIMIT = { status: 409, body: { error: { code: "WORKSPACE_LIMIT", message: "you have reached the limit of 3 open workspaces per person; close a task with agentx_close_task." } } };
const OPEN = (...ids: string[]) => ids.map((sessionId, index) => liveFixture({ sessionId, title: "Open task " + String(index + 1), actions: ["watch", "close"] }));
it("answers a full workspace limit with the person's open tasks as links with a Close button, never the AI-tool command, and starts again once one is closed", async () => {
 const first = "ses_cccccccccccccccccccc", second = "ses_dddddddddddddddddddd";
 let open = OPEN(first, second), refuse = true;
 const send = vi.fn(async (request: ApiRequest): Promise<ApiResponse> => request.path === CODE ? (refuse ? LIMIT : started()) : request.path.endsWith("/close") ? { status: 200, body: { closed: true, session: { ...sessionFixture({ sessionId: first }) } } } : { status: 500, body: {} });
 const f = setup(undefined, { send, get: request => request.path.startsWith("/v1/app/live") ? { status: 200, body: { tiles: open } } : undefined }), navigate = vi.spyOn(f.host, "navigate");
 fireEvent.change(await box(), { target: { value: "Fix the duplicate refunds" } });fireEvent.click(screen.getByRole("button", { name: "Start" }));
 expect((await screen.findByRole("alert")).textContent).toBe("You have too many open tasks to start more work. Close one of these, then start again.");
 expect(document.body.textContent).not.toContain("agentx_close_task");
 const list = await screen.findByRole("list", { name: "Your open tasks" });
 expect(within(list).getAllByRole("link").map(link => [link.textContent, link.getAttribute("href")])).toEqual([["Open task 1", "/app/sessions/" + first], ["Open task 2", "/app/sessions/" + second]]);
 // Close the first: the dialog asks, and only its button closes.
 fireEvent.click(within(list).getAllByRole("button", { name: "Close" })[0]!);
 expect(await screen.findByRole("dialog", { name: "Close this task?" })).toBeTruthy();
 expect(send.mock.calls.some(([request]) => request.path.endsWith("/close"))).toBe(false);
 open = OPEN(second);refuse = false;
 fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Close task" }));
 await waitFor(() => expect(send.mock.calls.filter(([request]) => request.path === "/v1/app/sessions/" + first + "/close")).toHaveLength(1));
 expect(send.mock.calls.find(([request]) => request.path.endsWith("/close"))![0]).toMatchObject({ method: "POST", body: { requestId: expect.stringMatching(/^[0-9a-f-]{36}$/u) as unknown } });
 // The refusal is gone, so the same text can be started again.
 await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
 fireEvent.click(screen.getByRole("button", { name: "Start" }));await waitFor(() => expect(navigate).toHaveBeenCalledWith("/app/sessions/" + id));f.close();
});
it("offers no Close for a task the person does not own, and says so when none can be closed from here", async () => {
 const f = setup(undefined, { send: async () => LIMIT, get: request => request.path.startsWith("/v1/app/live") ? { status: 200, body: { tiles: [liveFixture({ actions: ["watch"] })] } } : undefined });
 fireEvent.change(await box(), { target: { value: "Fix it" } });fireEvent.click(screen.getByRole("button", { name: "Start" }));
 expect(await screen.findByText("No task of yours can be closed from here. Ask an admin to free a place.")).toBeTruthy();expect(screen.queryByRole("button", { name: "Close" })).toBeNull();f.close();
});

it("shows the confirmed effective spending stop before work starts", async () => {
 const f = setup(undefined, { preview: async () => ({ status: 200, body: { orgId: "org_aaaaaaaaaaaaaaaaaaaa", project: "payments", kind: "captured", effectiveStopMicrousd: 750000 } }) });
 try { await box();expect(await screen.findByText(/Effective spending stop: \$0.75/)).toBeTruthy();expect(posts(f)).toHaveLength(0); } finally { f.close(); }
});
for (const result of [{ status: 200, body: { orgId: "org_aaaaaaaaaaaaaaaaaaaa", project: "payments", kind: "disabled" } }, { status: 503, body: {} }, { status: 200, body: { kind: "captured", effectiveStopMicrousd: "bad" } }]) it(`unclear preview ${JSON.stringify(result)} never blocks Start`, async () => {
 const f = setup(undefined, { preview: async () => result });
 try { fireEvent.change(await box(), { target: { value: "Fix it" } });fireEvent.click(screen.getByRole("button", { name: "Start" }));await waitFor(() => expect(posts(f)).toHaveLength(1));expect(screen.queryByText(/Effective spending stop:/)).toBeNull(); } finally { f.close(); }
});
it("a pending preview never disables Start", async () => {
 const f = setup(undefined, { preview: async () => new Promise<ApiResponse>(() => undefined) });
 try { fireEvent.change(await box(), { target: { value: "Fix it" } });expect(screen.getByRole<HTMLButtonElement>("button", { name: "Start" }).disabled).toBe(false);fireEvent.click(screen.getByRole("button", { name: "Start" }));await waitFor(() => expect(posts(f)).toHaveLength(1)); } finally { f.close(); }
});

// DR-UX-3: the start box's "Design first" option. It is offered only where the playbook answer says design review exists for the company (`designReviewAllowed: true`, which means `dr` is on and the company allows it).
const PLAYBOOK = "/v1/app/projects/payments/playbook", DESIGN_FIRST = "Review the design before building (Design first)";
const playbookAnswer = (allowed: boolean | undefined, mode: "never" | "auto" | "always" = "auto") => ({ status: 200, body: { ...(allowed === undefined ? {} : { designReviewAllowed: allowed }), playbook: { revision: 2, defaultProcess: { kind: "builtin" }, ...(allowed === true ? { designReview: { mode, tier: "standard", allowSkip: true, capUsdPerTask: 10, highRiskApprover: { kind: "maintainers" } } } : {}) } } });
const withPlaybook = (answer: ApiResponse | undefined) => (request: ApiRequest): ApiResponse | undefined => request.path === PLAYBOOK ? answer : undefined;
describe("Design first in the start box", () => {
 it("is offered, with an accessible name, where design review is available for the company, whatever the project's own mode (Off included)", async () => {
  for (const mode of ["never", "auto", "always"] as const) {
   const f = setup(undefined, { get: withPlaybook(playbookAnswer(true, mode)) });
   const option = await screen.findByRole("checkbox", { name: DESIGN_FIRST });expect(option.getAttribute("aria-checked")).toBe("false");
   f.close();
  }
 });
 it("is not there where the company has not allowed it, where the stage is off (no company word), or where the setting cannot be read", async () => {
  for (const answer of [playbookAnswer(false), playbookAnswer(undefined), { status: 500, body: { error: { code: "RUNTIME_UNAVAILABLE", message: "x" } } }, { status: 404, body: { error: { code: "NOT_FOUND", message: "x" } } }] as ApiResponse[]) {
   const f = setup(undefined, { get: withPlaybook(answer) });
   await box();await waitFor(() => expect(f.request.mock.calls.some(([request]) => request.path === PLAYBOOK)).toBe(true));
   expect(screen.queryByRole("checkbox", { name: DESIGN_FIRST })).toBeNull();expect(screen.queryByText(/design first/iu)).toBeNull();
   f.close();
  }
 });
 it("is not there for a viewer, who has no start box", async () => {
  const f = setup(projectFixture({ you: { role: "viewer", canStartWork: false, canEditSettings: false, canViewSpend: false } }), { get: withPlaybook(playbookAnswer(true)) });await screen.findByRole("heading", { name: "payments" });
  expect(screen.queryByRole("checkbox", { name: DESIGN_FIRST })).toBeNull();f.close();
 });
 it("sends the flag only when ticked, and an unticked start has exactly the old body", async () => {
  const f = setup(undefined, { get: withPlaybook(playbookAnswer(true)) }), navigate = vi.spyOn(f.host, "navigate");
  fireEvent.change(await box(), { target: { value: "Add a retry" } });fireEvent.click(await screen.findByRole("checkbox", { name: DESIGN_FIRST }));fireEvent.click(screen.getByRole("button", { name: "Start" }));
  await waitFor(() => expect(navigate).toHaveBeenCalledWith("/app/sessions/" + id));
  expect(posts(f)[0]).toMatchObject({ path: CODE, body: { input: { text: "Add a retry" }, designFirst: true } });f.close();
  const plain = setup(undefined, { get: withPlaybook(playbookAnswer(true)) });
  fireEvent.change(await box(), { target: { value: "Add a retry" } });await screen.findByRole("checkbox", { name: DESIGN_FIRST });fireEvent.click(screen.getByRole("button", { name: "Start" }));
  await waitFor(() => expect(posts(plain)).toHaveLength(1));expect(Object.keys(posts(plain)[0]!.body as object).sort()).toEqual(["input", "requestId"]);plain.close();
 });
 it("a retry of the same text with the option changed is a new request (a lost answer never turns into a different start)", async () => {
  let attempt = 0;const send = vi.fn(async (): Promise<ApiResponse> => (attempt++ === 0 ? { status: 503, body: { error: { code: "RUNTIME_UNAVAILABLE", message: "x" } } } : started()));
  const f = setup(undefined, { send, get: withPlaybook(playbookAnswer(true)) });
  fireEvent.change(await box(), { target: { value: "Add a retry" } });fireEvent.click(screen.getByRole("button", { name: "Start" }));await screen.findByRole("alert");
  fireEvent.click(await screen.findByRole("checkbox", { name: DESIGN_FIRST }));fireEvent.click(screen.getByRole("button", { name: "Start" }));await waitFor(() => expect(send).toHaveBeenCalledTimes(2));
  const [first, second] = send.mock.calls.map(call => (call as unknown as [ApiRequest])[0].body as { requestId: string; designFirst?: boolean });
  expect(first!.designFirst).toBeUndefined();expect(second!.designFirst).toBe(true);expect(second!.requestId).not.toBe(first!.requestId);f.close();
 });
 it("when the broker refuses it (the company stopped allowing it while the page was open) the page says so plainly, keeps the text and reads the setting again", async () => {
  let allowed = true;const send = vi.fn(async (): Promise<ApiResponse> => { allowed = false;return { status: 400, body: { error: { code: "CONFIG_INVALID", message: "Design review isn't available right now." } } }; });
  const f = setup(undefined, { send, get: request => request.path === PLAYBOOK ? playbookAnswer(allowed) : undefined }), navigate = vi.spyOn(f.host, "navigate");
  fireEvent.change(await box(), { target: { value: "Add a retry" } });fireEvent.click(await screen.findByRole("checkbox", { name: DESIGN_FIRST }));fireEvent.click(screen.getByRole("button", { name: "Start" }));
  expect((await screen.findByRole("alert")).textContent).toMatch(/Design first/u);expect(navigate).not.toHaveBeenCalled();
  await waitFor(() => expect(screen.queryByRole("checkbox", { name: DESIGN_FIRST })).toBeNull());expect((await box() as HTMLTextAreaElement).value).toBe("Add a retry");f.close();
 });
 it("only the broker's fixed Design first refusal gets the Design first words and a re-read; any other refusal keeps its usual words", async () => {
  const send = vi.fn(async (): Promise<ApiResponse> => ({ status: 400, body: { error: { code: "CONFIG_INVALID", message: "input.text: request is empty" } } }));
  const f = setup(undefined, { send, get: withPlaybook(playbookAnswer(true)) });
  fireEvent.change(await box(), { target: { value: "Add a retry" } });fireEvent.click(await screen.findByRole("checkbox", { name: DESIGN_FIRST }));
  const reads = () => f.request.mock.calls.filter(([request]) => request.path === PLAYBOOK).length, before = reads();fireEvent.click(screen.getByRole("button", { name: "Start" }));
  const alert = await screen.findByRole("alert");expect(alert.textContent).toMatch(/4000/u);expect(alert.textContent).not.toMatch(/Design first/u);expect(reads()).toBe(before);
  expect(screen.getByRole("checkbox", { name: DESIGN_FIRST })).toBeTruthy();f.close();
 });
 it("sends no flag if the option was ticked and then stopped being offered", async () => {
  let allowed = true;const f = setup(undefined, { get: request => request.path === PLAYBOOK ? playbookAnswer(allowed) : undefined });
  fireEvent.click(await screen.findByRole("checkbox", { name: DESIGN_FIRST }));allowed = false;await f.query.refetchQueries({ queryKey: ["how-we-work", "payments", "design-review"] });
  await waitFor(() => expect(screen.queryByRole("checkbox", { name: DESIGN_FIRST })).toBeNull());
  fireEvent.change(await box(), { target: { value: "Add a retry" } });fireEvent.click(screen.getByRole("button", { name: "Start" }));
  await waitFor(() => expect(posts(f)).toHaveLength(1));expect(Object.keys(posts(f)[0]!.body as object).sort()).toEqual(["input", "requestId"]);f.close();
 });
 for (const theme of ["light", "dark"] as const) it("has no accessibility violations with the option shown in " + theme, async () => { const f = setup(undefined, { theme, get: withPlaybook(playbookAnswer(true)) });await screen.findByRole("checkbox", { name: DESIGN_FIRST });await expectNoAxeViolations(f.container);f.close(); });
});
