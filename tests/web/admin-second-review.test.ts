// @vitest-environment jsdom
// Lane cr-settings: the company's settings screen for the second opinion, and the task page's "I've seen it".
import { expect, it } from "vitest";
import { screen, waitFor, fireEvent, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { AppNavSchema, AppMeResponseSchema, SecondReviewStateReaderSchema } from "@agentx/contracts/web";
import { appRoutes } from "../../packages/ui/src/routes.js";
import { AppHostProvider } from "../../packages/ui/src/host.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { ThemeProvider } from "../../packages/ui/src/theme.js";
import { SecondReviewAck } from "../../packages/ui/src/screens/session/SecondReviewAck.js";
import { fakeHost } from "./support/fake-host.js";
import { renderUi } from "./support/render.js";
import { h } from "./support/h.js";
import type { ApiRequest, ApiResponse } from "../../packages/ui/src/host.js";

const PATH = "/v1/app/org/second-review";
const features = { localAgents: false, admin: true, usage: false, chains: false, describe: false, notices: false };
const GPT = { provider: "openrouter", modelId: "openai/gpt-5.5" }, GEMINI = { provider: "openrouter", modelId: "google/gemini-3" }, CLAUDE = { provider: "amazon-bedrock", modelId: "anthropic.claude-opus-4-1" };
const entry = (model: { provider: string; modelId: string }, over: Record<string, unknown> = {}) => ({ model, company: "openai", costUsd: 0.2, eligible: true, notes: [], suggested: false, ...over });
const base = () => ({
  mode: "shadow", modes: { company: "shadow", project: null, effective: "shadow" }, fitKnown: false, pendingLowering: false, evidence: null, trackRecord: null, notice: null,
  context: "change_only", alsoSees: null,
  models: [entry(GPT, { suggested: true, suggestionReason: "top-tier strength; a different AI company than the one that wrote the code; medium cost (about $0.20 a review)" }), entry(GEMINI, { company: "google", costUsd: undefined, notes: ["the provider may train on the code sent to a free model"] }), entry(CLAUDE, { company: "anthropic", eligible: false, ineligibleWhy: "same-company" })],
  suggested: [GPT], typicalReview: { input: 60000, output: 4000 }, choice: null, projectNarrowing: null,
  current: { source: "default", models: [GPT], line: "Using default: openai/gpt-5.5 (change)" },
});
type State = ReturnType<typeof base> & Record<string, unknown>;
function mount(options: { state?: Partial<State>; respond?: (request: ApiRequest) => Promise<ApiResponse | undefined>; role?: "owner" | "admin" } = {}) {
  const role = options.role ?? "owner", current: { state: State } = { state: { ...base(), ...options.state } as State };
  const nav = AppNavSchema.parse({ me: { developerId: "a".repeat(64), name: "Omar", orgRole: role }, org: { name: "Acme" }, homeCount: 0, projects: [], shared: { agents: [], sessions: [] }, features });
  const me = AppMeResponseSchema.parse({ developer: { id: "a".repeat(64), name: "Omar", orgRole: role }, org: { orgId: "org_aaaaaaaaaaaaaaaaaaaa", name: "Acme", plan: "team" }, identities: [] });
  const f = fakeHost(async request => (await options.respond?.(request)) ?? { status: 200, body: request.path === "/v1/app/nav" ? nav : request.path === "/v1/app/me" ? me : request.path === PATH && request.method === "GET" ? current.state : { status: "applied" } });
  f.host.kind = "web";
  f.host.viewport = { width: () => 1280, subscribe: () => () => undefined };
  const query = createQueryClient();
  query.setQueryData(["nav"], nav);
  const router = createMemoryRouter(appRoutes(nav.features), { initialEntries: ["/app/admin/second-review"] });
  const view = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(ThemeProvider, { host: f.host, children: h(RouterProvider, { router }) }) }) }));
  return { ...f, ...view, current, close: () => { view.unmount();router.dispose();query.clear(); } };
}
const posts = (f: ReturnType<typeof mount>) => f.request.mock.calls.map(([request]) => request).filter(request => request.method === "POST");

it("the test fixture is a state the reader accepts", () => {
  expect(SecondReviewStateReaderSchema.safeParse(base()).success).toBe(true);
});

it("shows the mode, the 'Using default' line, and the models with maker, cost, fit and notes; suggestions are marked and a same-maker model is greyed with the reason; the nav links to it", async () => {
  const f = mount();
  await screen.findByRole("heading", { name: "Second opinion" });
  await screen.findByText("Using default: openai/gpt-5.5 (change)");
  const table = screen.getByRole("table");
  const rows = within(table).getAllByRole("row");
  expect(rows).toHaveLength(4);
  expect(within(rows[1]!).getByText("Suggested")).toBeTruthy();
  expect(rows[1]!.textContent).toContain("about $0.20");
  expect(rows[1]!.textContent).toContain("Can be used");
  expect(rows[2]!.textContent).toContain("price unknown");
  expect(rows[2]!.textContent).toContain("may train on the code");
  expect(rows[3]!.textContent).toContain("Not used: same maker as the model that wrote the code");
  expect(rows[3]!.className).toContain("rv-muted");
  expect(screen.getByText(/depends on the model that wrote each task's code/u)).toBeTruthy();
  expect(screen.getByRole("link", { name: "Second opinion" })).toBeTruthy();
  expect(f.request.mock.calls.filter(([request]) => request.path === PATH).every(([request]) => request.method === "GET")).toBe(true);
  f.close();
});

it("shows what a model's name holds as plain text: markup is not markup and control characters are visible", async () => {
  const f = mount({ state: { models: [entry({ provider: "openrouter", modelId: "evil/<b>bold</b>‮id" }, { notes: ["<img src=x onerror=alert(1)>"] })] } });
  const table = await screen.findByRole("table");
  expect(f.container.querySelector("b")).toBeNull();
  expect(f.container.querySelector("img")).toBeNull();
  // In the table itself, not only in the choice lists.
  expect(table.textContent).toContain("evil/<b>bold</b>[U+202E]id");
  expect(table.textContent).toContain("<img src=x onerror=alert(1)>");
  f.close();
});

it("raises the mode with one request, and cannot pick On without evidence that holds", async () => {
  const f = mount({ state: { mode: "off", modes: { company: "off", project: null, effective: "off" } } });
  await screen.findByRole("heading", { name: "Mode" });
  const select = screen.getByLabelText("Second opinion mode") as HTMLSelectElement;
  expect((within(select).getByRole("option", { name: "On (can block)" }) as HTMLOptionElement).disabled).toBe(true);
  expect(screen.getByText(/On needs a model with a trial record that holds/u)).toBeTruthy();
  const save = screen.getByRole("button", { name: "Save mode" }) as HTMLButtonElement;
  expect(save.disabled).toBe(true);
  fireEvent.change(select, { target: { value: "shadow" } });
  fireEvent.click(save);
  await waitFor(() => expect(posts(f)).toHaveLength(1));
  expect(posts(f)[0]).toMatchObject({ path: PATH, body: { action: "mode", scope: "company", mode: "shadow" }, retry: "never" });
  await screen.findByText("Saved.");
  f.close();
});

it("On can be picked once the evidence holds; lowering is asked for and says it waits for a different admin", async () => {
  const evidence = { model: GPT, holds: true, verdict: { recordedAt: "2026-10-21T00:00:00.000Z", withdrawn: false, shadowDays: 18, shadowFindings: 10, shadowAgreed: 5, shadowPassed: true }, replay: { tasks: 50, knownDefects: 30, plantedBugs: 20, baselineCaught: 20, bothCaught: 20, extraCatches: 6, dismissedBlocking: 0, passed: true, failures: [] } };
  const f = mount({ state: { mode: "on", modes: { company: "on", project: null, effective: "on" }, evidence }, respond: async request => (request.method === "POST" ? { status: 202, body: { status: "needs_approval", changeId: "chg_1" } } : undefined) });
  await screen.findByRole("heading", { name: "Mode" });
  const select = screen.getByLabelText("Second opinion mode") as HTMLSelectElement;
  expect((within(select).getByRole("option", { name: "On (can block)" }) as HTMLOptionElement).disabled).toBe(false);
  fireEvent.change(select, { target: { value: "shadow" } });
  fireEvent.click(screen.getByRole("button", { name: "Save mode" }));
  await screen.findByText(/needs a different admin to approve it/u);
  expect(posts(f)[0]!.body).toMatchObject({ action: "mode", scope: "company", mode: "shadow" });
  f.close();
});

it("a request to lower that another admin made can be approved, and one of your own can only be withdrawn", async () => {
  const pending = (mine: boolean) => [{ changeId: "chg_1", scope: "company", from: "on", to: "shadow", proposedByYou: mine, expiresAt: "2026-11-09T00:00:00.000Z" }];
  const other = mount({ state: { pendingLowering: true, pending: pending(false) } });
  await screen.findByText(/Another admin asked to lower the mode/u);
  expect(screen.queryByRole("button", { name: "Approve lowering" })).not.toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Approve lowering" }));
  await waitFor(() => expect(posts(other)).toHaveLength(1));
  expect(posts(other)[0]!.body).toEqual({ action: "approve-mode", changeId: "chg_1" });
  other.close();
  const mine = mount({ state: { pendingLowering: true, pending: pending(true) } });
  await screen.findByText(/You asked to lower the mode/u);
  expect(screen.queryByRole("button", { name: "Approve lowering" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Withdraw the request" }));
  await waitFor(() => expect(posts(mine)).toHaveLength(1));
  expect(posts(mine)[0]!.body).toEqual({ action: "cancel-mode", changeId: "chg_1" });
  mine.close();
});

it("asks to sign in again when the approval is refused for an old sign-in", async () => {
  const f = mount({ state: { pendingLowering: true, pending: [{ changeId: "chg_1", scope: "company", from: "on", to: "off", proposedByYou: false, expiresAt: "2026-11-09T00:00:00.000Z" }] }, respond: async request => (request.method === "POST" ? { status: 403, body: { error: { code: "REAUTH_REQUIRED", message: "Sign in again to do this." } } } : undefined) });
  fireEvent.click(await screen.findByRole("button", { name: "Approve lowering" }));
  await screen.findByText("Sign in again to do this.");
  fireEvent.click(screen.getByRole("button", { name: "Sign in again" }));
  expect(f.host.signIn).toHaveBeenCalled();
  f.close();
});

it("chooses a primary and a backup in order, and goes back to the default", async () => {
  const f = mount();
  await screen.findByRole("table");
  expect((screen.getByRole("button", { name: "Save choice" }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.queryByRole("button", { name: "Use the default" })).toBeNull();
  const key = (model: { provider: string; modelId: string }) => model.provider + "\u0000" + model.modelId;
  fireEvent.change(screen.getByLabelText("First choice"), { target: { value: key(GPT) } });
  fireEvent.change(screen.getByLabelText("Backup (optional)"), { target: { value: key(GEMINI) } });
  fireEvent.click(screen.getByRole("button", { name: "Save choice" }));
  await waitFor(() => expect(posts(f)).toHaveLength(1));
  expect(posts(f)[0]!.body).toEqual({ action: "choose", primary: GPT, backup: GEMINI });
  f.close();
  const chosen = mount({ state: { choice: { models: [GPT, GEMINI] }, current: { source: "company", models: [GPT, GEMINI], line: "Reviewed by openai/gpt-5.5 (company choice)" } } });
  await screen.findByText("Reviewed by openai/gpt-5.5 (company choice)");
  expect((screen.getByLabelText("First choice") as HTMLSelectElement).value).toBe(key(GPT));
  fireEvent.click(screen.getByRole("button", { name: "Use the default" }));
  await waitFor(() => expect(posts(chosen)).toHaveLength(1));
  expect(posts(chosen)[0]!.body).toEqual({ action: "clear" });
  chosen.close();
});

it("only usable models can be chosen: the same-maker model is not in the choice lists", async () => {
  const f = mount();
  await screen.findByRole("table");
  const options = within(screen.getByLabelText("First choice")).getAllByRole("option").map(option => option.textContent);
  expect(options.some(text => text?.includes("claude"))).toBe(false);
  expect(options.some(text => text?.includes("gpt-5.5 (suggested)"))).toBe(true);
  f.close();
});

it("what the second reviewer sees: the change only by default; 'also sees' is shown when widened, and widening says what it sends", async () => {
  const f = mount();
  await screen.findByRole("heading", { name: "What the second reviewer sees" });
  fireEvent.change(screen.getByLabelText("Second reviewer sees"), { target: { value: "same_as_first" } });
  await screen.findByText(/sends more of your connected context/u);
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(posts(f)).toHaveLength(1));
  expect(posts(f)[0]!.body).toEqual({ action: "context", context: "same_as_first" });
  f.close();
  const widened = mount({ state: { context: "same_as_first", alsoSees: "Second reviewer also sees what the first reviewer sees: the connected sources, lessons and step instructions." } });
  await screen.findByText(/the connected sources, lessons and step instructions/u);
  widened.close();
});

it("shows the track record and the evidence for turning it on, and an admin can only withdraw", async () => {
  const trackRecord = { model: "openrouter:openai/gpt-5.5", days: 18, reviews: 12, findings: 10, agreed: 5, wrong: 4, open: 1, caughtMissedByFirst: 3 };
  const evidence = { model: GPT, holds: true, verdict: { recordedAt: "2026-10-21T00:00:00.000Z", withdrawn: false, shadowDays: 18, shadowFindings: 10, shadowAgreed: 5, shadowPassed: true }, replay: { tasks: 50, knownDefects: 30, plantedBugs: 20, baselineCaught: 20, bothCaught: 20, extraCatches: 6, dismissedBlocking: 0, passed: true, failures: [] } };
  const f = mount({ state: { trackRecord, evidence } });
  await screen.findByRole("heading", { name: "Track record" });
  const dl = screen.getByText("Days in the trial").closest("dl")!;
  const cells = Object.fromEntries([...dl.querySelectorAll("div")].map(row => [row.querySelector("dt")!.textContent, row.querySelector("dd")!.textContent]));
  expect(cells).toEqual({ "Days in the trial": "18", "Second opinions": "12", "Findings raised": "10", "Agreed or fixed": "5", "Wrong": "4", "Not decided yet": "1", "Caught what the first review missed": "3" });
  expect(screen.getByText("The evidence holds. This model can block.")).toBeTruthy();
  expect(screen.getByText(/Replay check: passed \(50 cases\)/u)).toBeTruthy();
  expect(screen.queryByRole("button", { name: /Record|Create|Add/u })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Withdraw the evidence" }));
  await waitFor(() => expect(posts(f)).toHaveLength(1));
  expect(posts(f)[0]!.body).toEqual({ action: "withdraw", model: GPT });
  f.close();
});

it("says when there is no record or no evidence yet, and when the evidence was withdrawn", async () => {
  const none = mount({ state: { evidence: { model: GPT, holds: false, verdict: null, replay: null } } });
  await screen.findByText(/No second opinions from this model yet/u);
  expect(screen.getByText(/No evidence has been recorded for this model yet/u)).toBeTruthy();
  none.close();
  const gone = mount({ state: { trackRecord: { model: "m", days: 3, reviews: 2, findings: 1, agreed: 0, wrong: 0, open: 1, caughtMissedByFirst: 0 }, evidence: { model: GPT, holds: false, verdict: { recordedAt: "2026-10-21T00:00:00.000Z", withdrawn: true, shadowDays: 18, shadowFindings: 10, shadowAgreed: 5, shadowPassed: true }, replay: null } } });
  await screen.findByText("The evidence was withdrawn.");
  expect(screen.queryByRole("button", { name: "Withdraw the evidence" })).toBeNull();
  gone.close();
});

it("tells the admin when the model stopped qualifying, with the server's fixed words, and 'I've seen it' sends the notice's key", async () => {
  const key = "a".repeat(32);
  const notice = { key, code: "choice-not-qualifying", seen: false, lines: ["The second-opinion model your company chose no longer qualifies.", "mistral/large-9: no connected source serves it"], createdAt: "2026-11-02T10:00:00.000Z" };
  const f = mount({ state: { notice } });
  await screen.findByText("The second opinion model needs attention");
  expect(screen.getByText("mistral/large-9: no connected source serves it")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "I've seen it" }));
  await waitFor(() => expect(posts(f)).toHaveLength(1));
  expect(posts(f)[0]!.body).toEqual({ action: "notice-seen", key });
  f.close();
  const seen = mount({ state: { notice: { ...notice, seen: true } } });
  await screen.findByText("The second opinion model needs attention");
  expect(screen.queryByRole("button", { name: "I've seen it" })).toBeNull();
  seen.close();
});

it("is absent while the switch is off, and a failed load can be retried", async () => {
  const off = mount({ respond: async request => (request.path === PATH ? { status: 404, body: { error: { code: "NOT_FOUND", message: "Not found." } } } : undefined) });
  await screen.findByText("The second opinion is not switched on for your company yet.");
  off.close();
  let calls = 0;
  const failing = mount({ respond: async request => (request.path === PATH ? (++calls === 1 ? { status: 400, body: { error: { code: "CONFIG_INVALID", message: "x" } } } : { status: 200, body: base() }) : undefined) });
  fireEvent.click(await screen.findByRole("button", { name: "Try again" }, ));
  await screen.findByRole("table");
  failing.close();
});

// ---- the task page

function ack(canAcknowledge: boolean, respond?: (request: ApiRequest) => Promise<ApiResponse>) {
  const f = fakeHost(respond ?? (async () => ({ status: 200, body: { task: {} } })));
  const query = createQueryClient();
  const view = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(SecondReviewAck, { taskId: "00000000-0000-4000-8000-000000000001", candidateDigest: "d".repeat(64), sessionId: "s1", canAcknowledge }) }) }));
  return { ...f, ...view };
}
it("the task owner sees 'I've seen it' and one press sends the candidate digest once; anyone else only reads that the owner is asked", async () => {
  const owner = ack(true);
  fireEvent.click(screen.getByRole("button", { name: "I've seen it" }));
  fireEvent.click(screen.getByRole("button", { name: "I've seen it" }));
  await waitFor(() => expect(owner.request).toHaveBeenCalled());
  const sent = owner.request.mock.calls.map(([request]) => request);
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({ method: "POST", path: "/v1/app/tasks/00000000-0000-4000-8000-000000000001/second-review-acknowledge", body: { candidateDigest: "d".repeat(64) }, retry: "never" });
  await screen.findByText("Noted. The pull request can be merged.");
  owner.unmount();
  const viewer = ack(false);
  expect(screen.queryByRole("button", { name: "I've seen it" })).toBeNull();
  expect(screen.getByText(/The task owner is asked to acknowledge this/u)).toBeTruthy();
  viewer.unmount();
});

it("says so when the code changed meanwhile, and shows the server's words when it refuses", async () => {
  const stale = ack(true, async () => ({ status: 409, body: { error: { code: "IDEMPOTENCY_CONFLICT", message: "this is out of date" } } }));
  fireEvent.click(screen.getByRole("button", { name: "I've seen it" }));
  await screen.findByText("The code changed. The page now shows the current state.");
  stale.unmount();
  const refused = ack(true, async () => ({ status: 403, body: { error: { code: "FORBIDDEN", message: "Only the task owner can decide this." } } }));
  fireEvent.click(screen.getByRole("button", { name: "I've seen it" }));
  await screen.findByText("Only the task owner can decide this.");
  refused.unmount();
});
