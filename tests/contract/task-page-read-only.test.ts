// Spec 061 slice 2, Task 7, and OWNER DECISION 7: the task page's scripts, run against the page the server renders, parsed into a small fake DOM inside a vm sandbox. With the decision cards on, the review page is read-only (with them off it decides as before: task-page-script.test.ts):
// the page carries only its reading script (no data island, no deciding script, nothing to press) for every reader, whatever they may do on the task; what it decided is on the task page in Rovara, whose
// own tests carry the authority checks (tests/contract/decision-plan-choices.test.ts, run-limits.test.ts, live-steer-revise.test.ts, spec-owner-choice-routes.test.ts). The one script left with a write
// is the People request's confirmation page that Slack's People flow links to.
import vm from "node:vm";
import { describe, expect, it } from "vitest";
import type { PlanDocument } from "@agentx/contracts";
import { createTaskWeb, type TaskDocumentEntry, type TaskDocumentView } from "../../packages/broker/src/aws/task-web.js";
import { TASK_PAGE_DECIDING_COPY, TASK_PAGE_DECIDING_SCRIPT } from "../../packages/broker/src/aws/task-page-assets.js";
import { renderTaskPeopleConfirmation, renderTaskPeoplePanel } from "../../packages/broker/src/aws/task-people-page-view.js";
import type { PageCommentView } from "../../packages/broker/src/aws/plan-page/comments.js";
import { fakeStorage, parseHtml, type FakeDocument } from "../support/fake-dom.js";
import { planDocument } from "../support/plan-documents.js";
import { TEST_ORG } from "../support/orgs.js";

const taskId = "11111111-1111-4111-8111-111111111111";
const caller = { orgId: TEST_ORG, orgRole: "member" as const, developerId: "d".repeat(64), sessionId: "s", amr: "slack", name: "Maya" } as const;
const SESSION = "__Host-agentx_review_session=11111111-1111-4111-8111-111111111111";
const digest = "f".repeat(64);
const owner = { role: "owner" as const, canComment: true, canSuggest: false, canDecide: true, canAsk: true };
const commenter = { role: "commenter" as const, canComment: true, canSuggest: true, canDecide: false, canAsk: true };

const option = (id: string, label: string) => ({ id, label, consequence: `${label} it is.` });
/** Six decisions: d1 sits on a folded child claim, d6 under "Show 1 more decision". */
function decisions(count = 6) {
  return Array.from({ length: count }, (_, index) => ({
    id: `d${index + 1}`, claimId: index === 0 ? "1.1" : "2", question: `Question ${index + 1}?`,
    options: [option("above", "Above"), option("below", "Below")], recommended: "below",
  }));
}
const plan = (extra: Partial<PlanDocument> = {}) => planDocument({ title: "Retry payments", why: [{ text: "Payments drop.", author: "Priya" }], decisions: decisions(), ...extra });
const doc = (version: number, body: PlanDocument, current = true): TaskDocumentEntry =>
  ({ kind: "coding plan", version, approved: false, current, format: "structured", plan: body });

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
function comment(n: number, extra: Partial<PageCommentView> = {}): PageCommentView {
  return {
    id: id(n), document: "plan", version: 1, target: { kind: "claim", id: "2" }, author: { kind: "person", name: "Sam", owner: false, you: false },
    text: `Comment ${n}`, createdAt: "2026-10-11T10:00:00.000Z", edited: false, deleted: false, sent: false, rev: 1, ...extra,
  };
}

interface PageOptions { applicationRetry?: { canRetry: boolean }; reviseOffer?: { canRevise: boolean }; specHold?: NonNullable<TaskDocumentView["specHold"]>; version?: number; body?: PlanDocument; comments?: PageCommentView[]; access?: NonNullable<TaskDocumentView["access"]>; extra?: Partial<TaskDocumentView>; waiting?: boolean; optionalChecks?: TaskDocumentView["optionalChecks"]; runLimit?: TaskDocumentView["runLimit"]; askAvailable?: boolean }
async function pageHtml(options: PageOptions = {}): Promise<string> {
  const version = options.version ?? 2;
  const documents = [doc(1, plan(), false), ...(version > 2 ? [doc(2, plan(), false)] : []), doc(version, options.body ?? plan())];
  const view: TaskDocumentView = {
    taskId, title: "Retry payments", status: "Waiting for your approval", nextStep: "Approve or request changes.", path: "QUICK", stage: "Coding plan", role: "owner",
    documents, checks: [], findings: [], pullRequests: [], history: [], revision: 7, commentSeq: 3, access: options.access ?? owner,
    pageComments: options.comments ?? [comment(1), comment(2, { author: { kind: "person", name: "Priya", owner: false, you: true }, version: 2, target: { kind: "document" } })],
    pageSuggestions: [],
    ...(options.waiting === false ? {} : { waiting: { kind: "coding plan", version, artifactDigest: digest } }),
    optionalChecks: options.optionalChecks ?? [{ id: "lint", label: "Lint", selected: false }],
    ...(options.runLimit === undefined ? {} : { runLimit: options.runLimit }),
    ...(options.askAvailable === undefined ? {} : { askAvailable: options.askAvailable }),
    ...(options.applicationRetry === undefined ? {} : { applicationRetry: options.applicationRetry }),
    ...(options.reviseOffer === undefined ? {} : { reviseOffer: options.reviseOffer }),
    ...(options.specHold === undefined ? {} : { specHold: options.specHold }),
    ...options.extra,
  };
  const web = createTaskWeb({ readOnly: true, authenticateSession: async () => caller, getTaskDocumentView: async () => view });
  const answer = await web({ method: "GET", path: `/review/${taskId}/task`, headers: { cookie: SESSION }, requestId: "r" }, new URL(`https://agentx.example.test/review/${taskId}/task`));
  expect(answer.statusCode).toBe(200);
  return answer.body;
}

interface Reply { status: number; body?: unknown }
interface Sent { url: string; method: string; headers: Record<string, string>; body: Record<string, string> }

/** Boots both of the page's scripts against the parsed page. Replies come from `respond`, or wait when it returns undefined. */
function boot(html: string, options: { storage?: ReturnType<typeof fakeStorage>; local?: ReturnType<typeof fakeStorage>; respond?: (sent: Sent) => Reply | Promise<Reply> | undefined } = {}) {
  const document: FakeDocument = parseHtml(html);
  const storage = options.storage ?? fakeStorage();
  const sent: Sent[] = [];
  const pending: Array<(reply: Reply) => void> = [];
  const timers: Array<{ fn: () => void; at: number; id: number }> = [];
  const clock = { now: 1_000_000 };
  const reloads: number[] = [];
  const navigations: string[] = [];
  let uuids = 0;
  let timerId = 0;
  const respond = options.respond ?? (() => ({ status: 200, body: {} }));
  const sandbox: Record<string, unknown> = {
    document,
    location: { hash: "", search: "", pathname: `/review/${taskId}/task`, reload: () => { reloads.push(clock.now); }, assign: (value: string) => { navigations.push(value); } },
    setTimeout: (fn: unknown, ms: number) => {
      if (typeof fn !== "function") throw new Error("string timers are not allowed");
      timerId += 1;
      timers.push({ fn: fn as () => void, at: clock.now + ms, id: timerId });
      return timerId;
    },
    clearTimeout: (handle: number) => { const index = timers.findIndex((timer) => timer.id === handle); if (index >= 0) timers.splice(index, 1); },
    setInterval: () => 0, clearInterval: () => undefined,
    Date: Object.assign(function FakeDate(...args: [string]) { return new Date(...args); }, { now: () => clock.now }),
    crypto: { randomUUID: () => { uuids += 1; return `aaaaaaaa-aaaa-4aaa-8aaa-${String(uuids).padStart(12, "0")}`; } },
    fetch: (url: string, init: { method?: string; headers?: Record<string, string>; body?: string }) => {
      const entry: Sent = { url, method: init.method ?? "GET", headers: init.headers ?? {}, body: init.body === undefined ? {} : JSON.parse(init.body) as Record<string, string> };
      sent.push(entry);
      const reply = respond(entry);
      const deliver = (value: Reply) => ({ status: value.status, ok: value.status >= 200 && value.status < 300, json: async () => value.body ?? {} });
      if (reply === undefined) return new Promise((resolve) => { pending.push((value) => resolve(deliver(value))); });
      return Promise.resolve(reply).then(deliver);
    },
    decodeURIComponent, encodeURIComponent,
  };
  // Drafts belong in the tab's sessionStorage; localStorage is there too, and must stay untouched.
  const local = options.local ?? fakeStorage();
  sandbox.window = { addEventListener: () => undefined, sessionStorage: storage, localStorage: local };
  sandbox.sessionStorage = storage;
  sandbox.localStorage = local;
  for (const script of document.querySelectorAll("script")) {
    if (script.getAttribute("nonce") !== null) vm.runInNewContext(script.textContent, sandbox);
  }
  const settle = async () => { for (let index = 0; index < 6; index += 1) await new Promise((resolve) => setImmediate(resolve)); };
  const advance = async (ms: number) => {
    const until = clock.now + ms;
    for (;;) {
      timers.sort((left, right) => left.at - right.at);
      const next = timers[0];
      if (next === undefined || next.at > until) break;
      timers.shift();
      clock.now = next.at;
      next.fn();
      await settle();
    }
    clock.now = until;
  };
  const byId = (name: string) => document.getElementById(name)!;
  return { document, storage, sent, pending, timers, clock, reloads, navigations, settle, advance, byId };
}
type Page = ReturnType<typeof boot>;

const posts = (page: Page, path: string) => page.sent.filter((entry) => entry.method === "POST" && entry.url.endsWith(path));

describe("the review page with the decision cards on (OWNER DECISION 7 and 17)", () => {
  const readers: Array<[string, NonNullable<TaskDocumentView["access"]>]> = [["an owner who may decide", owner], ["a teammate who may comment and suggest", commenter], ["a reader", { role: "viewer", canComment: false, canSuggest: false, canDecide: false, canAsk: false }]];
  for (const [who, access] of readers) {
    it(`OWNER DECISION 17: serves ${who} a page that decides nothing (no answer, Approve, retry, revise or spec control, the script told it may not decide) and, with the cards on, no comment controls either (OWNER DECISION 18, review M1)`, async () => {
      const html = await pageHtml({ access, applicationRetry: { canRetry: true }, reviseOffer: { canRevise: true }, specHold: { title: "Spec on hold", message: "The spec could not be written.", choices: ["retry", "continue"], canChoose: true } });
      const document = parseHtml(html);
      for (const id of ["decide-approve", "decide-request-changes", "decide-dialog", "retry-application", "revise-plan-button", "spec-choice-retry", "spec-choice-continue"]) expect(document.getElementById(id), id).toBeNull();
      expect(document.querySelectorAll('input[type="radio"]')).toEqual([]);
      const island = /<script type="application\/json" id="agentx-page-data">([\s\S]*?)<\/script>/u.exec(html);
      expect(island).not.toBeNull();
      const data = JSON.parse(island![1]!) as { canDecide: boolean; canComment: boolean; canRetry?: boolean; canRevise?: boolean; canSpecChoose?: boolean };
      expect(data).toMatchObject({ canDecide: false, canComment: false });
      expect(data.canRetry).toBeUndefined();
      expect(data.canRevise).toBeUndefined();
      expect(data.canSpecChoose).toBeUndefined();
      expect(document.querySelectorAll(".comment-open")).toHaveLength(0);
      // Booting the page's scripts sends no decision.
      const page = boot(html);
      await page.settle();
      expect(page.sent.filter((entry) => entry.method === "POST" && /\/api\/(decision|retry|revise-plan|spec\/)/u.test(entry.url))).toEqual([]);
    });
  }

  it("sends the owner to the task page for the decision, the checks retry, Revise the plan and the spec's choices; others are told who decides", async () => {
    const sessionView = { sessionId: "ses_0123456789abcdefghij" };
    const html = await pageHtml({ applicationRetry: { canRetry: true }, reviseOffer: { canRevise: true }, specHold: { title: "Spec on hold", message: "The spec could not be written.", choices: ["retry"], canChoose: true }, extra: sessionView });
    const document = parseHtml(html);
    for (const link of ["decide-on-task", "retry-on-task", "revise-on-task", "spec-on-task"]) expect(document.getElementById(link)?.getAttribute("href"), link).toBe("/app/sessions/ses_0123456789abcdefghij");
    const reader = parseHtml(await pageHtml({ access: commenter, applicationRetry: { canRetry: false }, extra: sessionView }));
    expect(reader.getElementById("decide-on-task")).toBeNull();
    expect(reader.querySelector(".decide-bar")!.textContent).toBe("Only owners decide.");
    expect(reader.querySelector("#application-retry")!.textContent).toContain("Only the task owner can retry these checks.");
  });

  it("the People request's confirmation page still confirms only the request named by its control", async () => {
    const requestId = id(83);
    const confirmation = renderTaskPeopleConfirmation({ taskId, requestId, expiresAt: "2026-10-12T12:10:00.000Z", kind: "takeOwnership" });
    const data = { taskId, csrf: "c".repeat(43), revision: 0, role: "reader", canRead: true, canComment: false, canSuggest: false, canDecide: false, canAsk: false, canManagePeople: false, canTakeOwnership: true, peopleRevision: 4, commentSeq: 0 };
    const html = `<!doctype html><html><body><main>${confirmation}</main><script type="application/json" id="agentx-page-data">${JSON.stringify(data)}</script><script nonce="n">${TASK_PAGE_DECIDING_SCRIPT}</script></body></html>`;
    const page = boot(html, { respond: (entry) => entry.url.endsWith(`/api/people/requests/${requestId}/confirm`)
      ? { status: 200, body: { status: "COMMITTED", view: {} } } : { status: 200, body: {} } });
    page.document.querySelector("[data-people-confirm]")!.click();
    await page.settle();
    expect(posts(page, `/api/people/requests/${requestId}/confirm`)[0]!.body).toEqual({ requestId });
    expect(page.reloads).toHaveLength(1);
  });

  it("keeps the fixed words the confirmation page uses", () => {
    expect(TASK_PAGE_DECIDING_COPY).toBeDefined();
    expect(renderTaskPeoplePanel(taskId, { revision: 1, people: [], canManage: false, canTakeOwnership: false } as never)).not.toContain("<form");
  });
});
