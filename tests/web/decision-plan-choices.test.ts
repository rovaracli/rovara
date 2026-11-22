// @vitest-environment jsdom
// L4-DCS: the plan, requirements and design cards Code now sends with choices (questions, optional checks, open comments, a note), a run limit and Request changes, drawn from Code's own fixtures.
// What Approve sends is only what the person changed; Request changes sends the reason and the ticked comments; nothing is offered on a high card or where the card does not carry it.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { DecisionCardsViewReaderSchema } from "@agentx/contracts/web";
import type { ApiRequest, ApiResponse } from "../../packages/ui/src/host.js";
import { AppHostProvider } from "../../packages/ui/src/host.js";
import { Announcer } from "../../packages/ui/src/design/Announcer.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { createDecisionsApi, decisionActionPath, mayRequestChangesHere, readDecisions, type ReadDecision } from "../../packages/ui/src/api/decisions.js";
import { approveExtras, approveWaitsForLimit, cleanNote, extrasAllowedFor, initialPick, requestChangesCommentIds, runLimitOf } from "../../packages/ui/src/api/plan-pick.js";
import { DecisionCard } from "../../packages/ui/src/design/DecisionCard.js";
import { DecisionList } from "../../packages/ui/src/screens/home/NeedsYou.js";
import { renderUi } from "./support/render.js";
import { h } from "./support/h.js";
import { meFixture } from "./support/fixtures.js";
import { fakeHost } from "./support/fake-host.js";
import { expectNoAxeViolations } from "./support/axe.js";

const FIXTURE = JSON.parse(readFileSync("tests/fixtures/code-decision-cards.json", "utf8")) as { views: Record<string, Record<string, unknown> & { cards: Array<Record<string, unknown>> }> };
const view = (name: string) => structuredClone(FIXTURE.views[name]!);
const decisionsOf = (value: unknown): ReadDecision[] => readDecisions(DecisionCardsViewReaderSchema.parse(value));
const COMMENTS = ["33333333-3333-4333-8333-333333333333", "44444444-4444-4444-8444-444444444444"];
const answered = (cardId: string): ApiResponse => ({ status: 200, body: { cardId, outcome: "approved", remainingTabs: [] } });

function show(decisions: ReadDecision[], reply?: (request: ApiRequest) => ApiResponse, seed?: readonly [string, string]) {
  const currentView = {
    cards: decisions.map(item => item.card), total: decisions.length, dropped: 0,
    tabs: Object.fromEntries(decisions.flatMap(item => item.tabs === undefined ? [] : [[item.card.id, item.tabs]])),
    details: Object.fromEntries(decisions.flatMap(item => item.details.length === 0 ? [] : [[item.card.id, item.details]])),
    choices: Object.fromEntries(decisions.flatMap(item => item.choices === undefined ? [] : [[item.card.id, item.choices]])),
    digests: Object.fromEntries(decisions.map(item => [item.card.id, item.digest])),
  };
  const f = fakeHost(async request => {
    if (request.method === "GET" && request.path === "/v1/app/me") return { status: 200, body: { developer: { id: "a".repeat(64), name: "Member", orgRole: "owner" }, org: { orgId: "o-aaaaaaaaaaaaaaaaaaaa", name: "Example", plan: "starter" }, identities: [] } };
    if (request.method === "GET" && request.path === "/v1/app/decisions") return { status: 200, body: currentView };
    if (request.method === "GET") return { status: 200, body: {} };
    return reply?.(request) ?? answered(decisions[0]!.card.id);
  });
  if (seed !== undefined) f.storage.set(seed[0], seed[1]);
  const query = createQueryClient();
  const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(MemoryRouter, { children: h(Announcer, { children: h(DecisionList, { decisions, label: "Decisions" }) }) }) }) }));
  const posts = () => f.request.mock.calls.map(([request]) => request).filter(request => request.method === "POST");
  return { ...f, ...ui, posts };
}

describe("a plan card with choices and a run limit", () => {
  for (const code of ["CSRF_INVALID", "CSRF_STALE", "UNRECOGNISED"]) it(`R6a: a 500/${code} never releases the plan approval confirmation`, async () => {
    const decision = decisionsOf(view("approve_plan_with_choices"))[0]!;
    const f = fakeHost(async () => ({ status: 500, body: { error: { code, message: "Unknown result" } } }));
    const identity = { orgId: "o-aaaaaaaaaaaaaaaaaaaa", developerId: "a".repeat(64) };
    await expect(createDecisionsApi(f.host).approve(decision, undefined, undefined, undefined, identity)).rejects.toMatchObject({ code: "APPROVAL_UNKNOWN" });
    expect(await createDecisionsApi(f.host).hasUnknownApproval(decision, identity)).toBe(true);
    await expect(createDecisionsApi(f.host).approve(decision, undefined, undefined, undefined, identity)).rejects.toMatchObject({ code: "APPROVAL_UNKNOWN" });
    expect(f.request.mock.calls.filter(([r]) => r.method === "POST")).toHaveLength(1);
  });

  it("keeps an unknown approval locked across API recreation and does not post a second request", async () => {
    const decision = decisionsOf(view("approve_plan_with_choices"))[0]!;
    const f = fakeHost(async () => ({ status: 503, body: { error: { code: "UNAVAILABLE", message: "Try later." } } }));
    const scope = { orgId: "o-aaaaaaaaaaaaaaaaaaaa", developerId: "a".repeat(64) };
    await expect(createDecisionsApi(f.host).approve(decision, undefined, undefined, undefined, scope)).rejects.toBeTruthy();
    await expect(createDecisionsApi(f.host).approve(decision, undefined, undefined, undefined, scope)).rejects.toMatchObject({ code: "APPROVAL_UNKNOWN" });
    expect(f.request.mock.calls.filter(([request]) => request.method === "POST")).toHaveLength(1);
    expect([...f.storage.keys()].some(key => key.includes(decision.card.id) && key.includes(scope.orgId) && key.includes(scope.developerId))).toBe(true);
  });
  it("keeps the exact persisted request unknown when a 202 body looks like a final outcome", async () => {
    const decision = decisionsOf(view("approve_plan_with_choices"))[0]!, scope = { orgId: "o-aaaaaaaaaaaaaaaaaaaa", developerId: "a".repeat(64) };
    const f = fakeHost(async () => ({ status: 202, body: { cardId: decision.card.id, outcome: "approved", remainingTabs: [] } }));
    const lock = `rv:decision-approval:${scope.orgId}:${scope.developerId}:${decision.card.id}`;
    await expect(createDecisionsApi(f.host).approve(decision, undefined, undefined, undefined, scope)).rejects.toMatchObject({ code: "APPROVAL_UNKNOWN" });
    const frozen = f.host.storage.get(lock)!;
    const stored: unknown = JSON.parse(frozen) as unknown;
    expect(stored).toMatchObject({ body: { shownDigest: decision.digest } });
    expect(typeof (stored as { requestId?: unknown }).requestId).toBe("string");
    expect(f.request.mock.calls.filter(([request]) => request.method === "POST")).toHaveLength(1);
    expect(await createDecisionsApi(f.host).hasUnknownApproval(decision, scope)).toBe(true);
  });
  it("treats a stale CSRF refusal as a definite no-send and clears the pending lock", async () => {
    const decision = decisionsOf(view("approve_plan_with_choices"))[0]!;
    const scope = { orgId: "o-aaaaaaaaaaaaaaaaaaaa", developerId: "a".repeat(64) };
    const f = fakeHost(async request => request.method === "POST"
      ? { status: 403, body: { error: { code: "CSRF_INVALID", message: "Refresh the page and try again." } } }
      : { status: 200, body: {} });
    await expect(createDecisionsApi(f.host).approve(decision, undefined, undefined, undefined, scope)).rejects.toMatchObject({ code: "CSRF_INVALID", message: "Couldn't change that. Reload your identity before trying again." });
    expect([...f.storage.values()].every(value => value === "")).toBe(true);
    expect(f.request.mock.calls.filter(([request]) => request.method === "POST")).toHaveLength(1);
  });
  it("shows Check after an unknown write and checking does not resend it", async () => {
    const f = show(decisionsOf(view("approve_plan_with_choices")), () => ({ status: 503, body: { error: { code: "UNAVAILABLE", message: "Try later." } } }));
    fireEvent.click(screen.getByRole("checkbox", { name: /I agree Rovara may spend up to \$5.00/u }));
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    const check = await screen.findByRole("button", { name: "Check" });
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    fireEvent.click(check);
    expect((await screen.findByRole("alert")).textContent).toContain("earlier approval remains locked");
    expect(f.posts()).toHaveLength(1);
    f.unmount();
  });
  it("restores the unknown explanation and Check from storage before the task card mounts", async () => {
    const decision = decisionsOf(view("approve_plan_with_choices"))[0]!, scope = { orgId: "o-aaaaaaaaaaaaaaaaaaaa", developerId: "a".repeat(64) };
    const lock = `rv:decision-approval:${scope.orgId}:${scope.developerId}:${decision.card.id}`;
    const f = show([decision], undefined, [lock, JSON.stringify({ requestId: "request-1", body: { requestId: "request-1", shownDigest: decision.digest }, startedAt: Date.now() })]);
    expect(await screen.findByRole("button", { name: "Check" })).toBeTruthy();
    expect(await screen.findByText("Rovara didn't confirm this yet. Check this decision before trying again.")).toBeTruthy();
    expect(f.posts()).toHaveLength(0);
    f.unmount();
  });
  it("keeps a changed pending digest locked after Check", async () => {
    const decision = decisionsOf(view("approve_plan_with_choices"))[0]!, scope = { orgId: "o-aaaaaaaaaaaaaaaaaaaa", developerId: "a".repeat(64) };
    const next = view("approve_plan_with_choices"), digests = next["digests"] as Record<string, string>;digests[decision.card.id] = "b".repeat(64);
    const f = fakeHost(async request => request.method === "GET" ? { status: 200, body: next } : answered(decision.card.id));
    const lock = `rv:decision-approval:${scope.orgId}:${scope.developerId}:${decision.card.id}`;
    f.host.storage.set(lock, JSON.stringify({ requestId: "request-1", body: { shownDigest: decision.digest }, startedAt: Date.now() }));
    expect(await createDecisionsApi(f.host).checkApproval(decision, scope)).toBe("changed_pending");
    expect(f.host.storage.get(lock)).toContain("request-1");
    expect(f.request.mock.calls.some(([request]) => request.method === "POST")).toBe(false);
  });
  it("does not clear a replacement lock when Check finishes", async () => {
    const decision = decisionsOf(view("approve_plan_with_choices"))[0]!, scope = { orgId: "o-aaaaaaaaaaaaaaaaaaaa", developerId: "a".repeat(64) };
    let resolveRead!: (response: ApiResponse) => void;
    const finalView = view("approve_plan_with_choices");
    (finalView.cards[0] as Record<string, unknown>).status = "approved";
    const f = fakeHost(() => new Promise<ApiResponse>(resolve => { resolveRead = resolve; }));
    const lock = `rv:decision-approval:${scope.orgId}:${scope.developerId}:${decision.card.id}`;
    f.host.storage.set(lock, JSON.stringify({ requestId: "request-1", body: { shownDigest: decision.digest }, startedAt: Date.now() }));
    const checking = createDecisionsApi(f.host).checkApproval(decision, scope);
    await waitFor(() => expect(resolveRead).toBeTypeOf("function"));
    const replacement = JSON.stringify({ requestId: "request-2", body: { shownDigest: decision.digest }, startedAt: Date.now() });
    f.host.storage.set(lock, replacement);
    resolveRead({ status: 200, body: finalView });
    expect(await checking).toBe("unknown");
    expect(f.host.storage.get(lock)).toBe(replacement);
  });
  it("reads current state when the original lock vanished and never claims a decision without that read", async () => {
    const decision = decisionsOf(view("approve_plan_with_choices"))[0]!, scope = { orgId: "o-aaaaaaaaaaaaaaaaaaaa", developerId: "a".repeat(64) };
    let resolveRead!: (response: ApiResponse) => void;
    const f = fakeHost(() => new Promise<ApiResponse>(resolve => { resolveRead = resolve; }));
    const lock = `rv:decision-approval:${scope.orgId}:${scope.developerId}:${decision.card.id}`;
    f.host.storage.set(lock, JSON.stringify({ requestId: "request-1", body: { shownDigest: decision.digest }, startedAt: Date.now() }));
    const checking = createDecisionsApi(f.host).checkApproval(decision, scope);
    await waitFor(() => expect(resolveRead).toBeTypeOf("function"));
    f.host.storage.set(lock, "");
    const current = view("approve_plan_with_choices");
    resolveRead({ status: 200, body: current });
    expect(await checking).toBe("same_pending");
    expect(f.host.storage.get(lock)).toBe("");
    expect(f.request.mock.calls.some(([request]) => request.method === "POST")).toBe(false);
  });
  it("draws the key facts, each question with Rovara's recommendation and who suggested what, the checks, the comments, a note and the run limit", () => {
    show(decisionsOf(view("approve_plan_with_choices")));
    const plan = screen.getByTestId("plan-choices");
    expect(within(plan).getByRole("region", { name: "Key facts" }).textContent).toContain("Retries failed payments up to three times.");
    const q1 = within(plan).getByRole("group", { name: "Which gateway do refunds use?" });
    expect(within(q1).getByRole<HTMLInputElement>("radio", { name: /The existing gateway/u }).checked).toBe(true);
    expect(q1.textContent).toContain("(Rovara recommends this)");
    expect(q1.textContent).toContain("Suggested by Priya Shah: A new gateway");
    expect(within(plan).getByRole<HTMLInputElement>("checkbox", { name: "Run the load check" }).checked).toBe(false);
    expect(within(plan).getByRole<HTMLInputElement>("checkbox", { name: "Run the strict lint shard" }).checked).toBe(true);
    expect(within(plan).getByRole<HTMLInputElement>("checkbox", { name: "Please cover the refund path" }).checked).toBe(true);
    expect(within(plan).getByRole("textbox", { name: /Note for Rovara/u })).toBeTruthy();
    expect(plan.textContent).toContain("Task limit: $2.00 now, $5.00 once you approve.");
    expect(plan.textContent).toContain("A question left on Rovara's recommendation takes that answer");
  });
  it("keeps Approve off until the run limit raise is ticked, then sends the limit and nothing else the person did not change", async () => {
    const f = show(decisionsOf(view("approve_plan_with_choices")));
    const approve = screen.getByRole<HTMLButtonElement>("button", { name: "Approve" });
    expect(approve.disabled).toBe(true);
    fireEvent.click(screen.getByRole("checkbox", { name: /I agree Rovara may spend up to \$5.00/u }));
    const unlockedApprove = screen.getByRole<HTMLButtonElement>("button", { name: "Approve" });
    expect(unlockedApprove.disabled).toBe(false);
    fireEvent.click(unlockedApprove);
    await waitFor(() => expect(f.posts()).toHaveLength(1));
    const sent = f.posts()[0]!;
    expect(sent.path).toBe("/v1/app/decisions/approve_plan/plan2/approve");
    expect((sent.body as { shownDigest: string }).shownDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(sent.body).toMatchObject({ acknowledgedRunLimitUsd: 5 });
    expect(Object.keys(sent.body as object).sort()).toEqual(["acknowledgedRunLimitUsd", "requestId", "shownDigest"]);
  });
  it("sends a changed answer, a changed check selection, an unticked comment and the note", async () => {
    const f = show(decisionsOf(view("approve_plan_with_choices")));
    fireEvent.click(screen.getByRole("radio", { name: /A new gateway/u }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Run the load check" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "What about timeouts?" }));
    fireEvent.change(screen.getByRole("textbox", { name: /Note for Rovara/u }), { target: { value: "  Mind the refund path.  " } });
    fireEvent.click(screen.getByRole("checkbox", { name: /I agree Rovara may spend/u }));
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(f.posts()).toHaveLength(1));
    expect(f.posts()[0]!.body).toMatchObject({
      answers: [{ decisionId: "q1", optionId: "b", opened: true }], selectedOptionalCheckIds: ["load", "lint"], includedCommentIds: [COMMENTS[0]], note: "Mind the refund path.", acknowledgedRunLimitUsd: 5,
    });
  });
  it("starts again from Rovara's answers when the card changed (a new digest)", () => {
    const first = view("approve_plan_with_choices");
    const f = show(decisionsOf(first));
    fireEvent.click(screen.getByRole("radio", { name: /A new gateway/u }));
    const changed = view("approve_plan_with_choices");
    (changed["digests"] as Record<string, string>)["approve_plan:plan2"] = "b".repeat(64);
    const decisions = decisionsOf(changed);
    f.unmount();
    show(decisions);
    expect(screen.getByRole<HTMLInputElement>("radio", { name: /The existing gateway/u }).checked).toBe(true);
  });
  it("has no accessibility violations", async () => {
    const f = show(decisionsOf(view("approve_plan_with_choices")));
    await expectNoAxeViolations(f.container);
  });
});

describe("a swipe on a phone", () => {
  const swipe = (element: Element) => { fireEvent.touchStart(element, { touches: [{ clientX: 0, clientY: 0 }] });fireEvent.touchEnd(element, { changedTouches: [{ clientX: 300, clientY: 0 }] }); };
  it("does not approve a plan card that has choices or a run limit to look at", async () => {
    const f = show(decisionsOf(view("approve_plan_with_choices")));
    swipe(f.container.querySelector("article")!);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(f.posts()).toHaveLength(0);
  });
  it("still approves a low card that carries nothing to decide (the shortcut that always existed)", async () => {
    const f = show(decisionsOf(view("approve_spend")));
    swipe(f.container.querySelector("article")!);
    await waitFor(() => expect(f.posts()).toHaveLength(1));
  });
});

describe("requirements and design cards", () => {
  it("shows the questions and comments of a requirements card, with no optional checks and no run limit", () => {
    show(decisionsOf(view("approve_requirements_with_choices")));
    const plan = screen.getByTestId("plan-choices");
    expect(within(plan).getAllByRole("group").map(group => group.textContent?.slice(0, 20))).toHaveLength(3);
    expect(plan.textContent).not.toContain("Optional checks");
    expect(plan.textContent).not.toContain("Run limit");
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Approve" }).disabled).toBe(false);
  });
  it("shows only the comments of a design card, and sends the comments only when one is unticked", async () => {
    const f = show(decisionsOf(view("approve_design_with_choices")));
    expect(screen.queryByRole("group", { name: "Optional checks" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(f.posts()).toHaveLength(1));
    expect(Object.keys(f.posts()[0]!.body as object).sort()).toEqual(["requestId", "shownDigest"]);
  });
  it("sends the ticked comments and the note of a design card once one comment is unticked", async () => {
    const f = show(decisionsOf(view("approve_design_with_choices")));
    fireEvent.click(screen.getByRole("checkbox", { name: "Please cover the refund path" }));
    fireEvent.change(screen.getByRole("textbox", { name: /Note for Rovara/u }), { target: { value: "Fine otherwise." } });
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(f.posts()).toHaveLength(1));
    expect(f.posts()[0]!.body).toMatchObject({ includedCommentIds: [COMMENTS[1]], note: "Fine otherwise." });
    expect(Object.keys(f.posts()[0]!.body as object)).not.toContain("selectedOptionalCheckIds");
  });
  it("draws no choices where the card has none, and approves exactly as before", async () => {
    const f = show(decisionsOf(view("approve_plan")));
    expect(screen.queryByTestId("plan-choices")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(f.posts()).toHaveLength(1));
    expect(Object.keys(f.posts()[0]!.body as object).sort()).toEqual(["requestId", "shownDigest"]);
  });
  it("draws no choices when they cannot be read, and the card still approves with Rovara's answers", async () => {
    const value = view("approve_plan_with_choices");
    ((value["choices"] as Record<string, Record<string, unknown>>)["approve_plan:plan2"]!)["unknownThing"] = 1;
    value.cards[0]!["runLimit"] = undefined;
    const f = show(decisionsOf(value));
    expect(screen.queryByRole("group", { name: "Which gateway do refunds use?" })).toBeNull();expect(screen.getByTestId("plan-choices-unreadable")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(f.posts()).toHaveLength(1));
    expect(Object.keys(f.posts()[0]!.body as object).sort()).toEqual(["requestId", "shownDigest"]);
  });
  it("with unreadable choices and a valid run limit: says so, still needs the tick, still sends the limit, and offers no swipe", async () => {
    const value = view("approve_plan_with_choices");
    ((value["choices"] as Record<string, Record<string, unknown>>)["approve_plan:plan2"]!)["unknownThing"] = 1;
    const f = show(decisionsOf(value));
    expect(screen.getByTestId("plan-choices-unreadable").textContent).toContain("could not be shown");
    expect(screen.queryByRole("group", { name: "Which gateway do refunds use?" })).toBeNull();
    const approve = screen.getByRole<HTMLButtonElement>("button", { name: "Approve" });
    expect(approve.disabled).toBe(true);
    expect(approve.getAttribute("aria-describedby")).toBeTruthy();
    expect(approve.getAttribute("aria-describedby")!.split(/\s+/u).map(id => document.getElementById(id)?.textContent).join(" ")).toContain("Tick the box");
    fireEvent.touchStart(f.container.querySelector("article")!, { touches: [{ clientX: 0, clientY: 0 }] });fireEvent.touchEnd(f.container.querySelector("article")!, { changedTouches: [{ clientX: 300, clientY: 0 }] });
    fireEvent.click(screen.getByRole("checkbox", { name: /I agree Rovara may spend/u }));
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(f.posts()).toHaveLength(1));
    expect(Object.keys(f.posts()[0]!.body as object).sort()).toEqual(["acknowledgedRunLimitUsd", "requestId", "shownDigest"]);
  });
  it("offers no swipe for a requirements card whose choices could not be read", async () => {
    const value = view("approve_requirements_with_choices");
    ((value["choices"] as Record<string, Record<string, unknown>>)["approve_requirements:req2"]!)["unknownThing"] = 1;
    const f = show(decisionsOf(value));
    fireEvent.touchStart(f.container.querySelector("article")!, { touches: [{ clientX: 0, clientY: 0 }] });fireEvent.touchEnd(f.container.querySelector("article")!, { changedTouches: [{ clientX: 300, clientY: 0 }] });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(f.posts()).toHaveLength(0);
  });
  it("has no unreadable note, and no swipe change, when a card simply has no choices entry", () => {
    show(decisionsOf(view("approve_plan")));
    expect(screen.queryByTestId("plan-choices-unreadable")).toBeNull();
  });
  it("offers no choices on a Full pair with tabs, and approves a tab with only its tab", async () => {
    const f = show(decisionsOf(view("full_pair_with_tabs")), () => ({ status: 200, body: { cardId: "approve_requirements:req1", outcome: "approved", tab: "requirements", remainingTabs: ["design"] } }));
    expect(screen.queryByTestId("plan-choices")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Approve requirements" }));
    await waitFor(() => expect(f.posts()).toHaveLength(1));
    expect(Object.keys(f.posts()[0]!.body as object).sort()).toEqual(["requestId", "shownDigest", "tab"]);
    expect((f.posts()[0]!.body as { tab: string }).tab).toBe("requirements");
  });
  it("draws server words as visible text, never as markup", () => {
    const value = view("approve_requirements_with_choices");
    ((value["choices"] as Record<string, { openComments: Array<{ excerpt: string }> }>)["approve_requirements:req2"]!).openComments[0]!.excerpt = "<img src=x onerror=alert(1)>";
    const f = show(decisionsOf(value));
    expect(f.container.querySelector("img")).toBeNull();
    expect(screen.getByTestId("plan-choices").textContent).toContain("<img src=x onerror=alert(1)>");
  });
  it("lists comments read-only when the card says more are open than it lists", () => {
    const value = view("approve_requirements_with_choices");
    ((value["choices"] as Record<string, { openCommentCount: number }>)["approve_requirements:req2"]!).openCommentCount = 30;
    show(decisionsOf(value));
    expect(screen.queryByRole("checkbox", { name: "What about timeouts?" })).toBeNull();
    expect(screen.getByTestId("plan-choices").textContent).toContain("30 comments are open; Approve takes all of them.");
  });
});

describe("Request changes", () => {
  it("sends the reason and the ticked comments to the card's own request-changes route", async () => {
    const f = show(decisionsOf(view("approve_plan_with_choices")), () => ({ status: 200, body: { cardId: "approve_plan:plan2", outcome: "rejected", remainingTabs: [] } }));
    const send = within(screen.getByText("Request changes", { selector: "summary" }).closest("details")!).getByRole<HTMLButtonElement>("button", { name: "Send back for changes" });
    expect(send.disabled).toBe(true);
    fireEvent.change(screen.getByRole("textbox", { name: "What should change?" }), { target: { value: " Cover the refund path. " } });
    fireEvent.click(screen.getByRole("checkbox", { name: "What about timeouts?" }));
    fireEvent.click(send);
    await waitFor(() => expect(f.posts()).toHaveLength(1));
    expect(f.posts()[0]!.path).toBe("/v1/app/decisions/approve_plan/plan2/request-changes");
    expect((f.posts()[0]!.body as { shownDigest: string }).shownDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(f.posts()[0]!.body).toMatchObject({ reason: "Cover the refund path.", includedCommentIds: [COMMENTS[0]] });
    expect((await screen.findByRole("status")).textContent).toContain("Sent back for changes");
  });
  it("sends no comment list when the card has no open comments", async () => {
    const f = show(decisionsOf(view("approve_plan")), () => ({ status: 200, body: { cardId: "approve_plan:plan1", outcome: "rejected", remainingTabs: [] } }));
    fireEvent.change(screen.getByRole("textbox", { name: "What should change?" }), { target: { value: "Smaller." } });
    fireEvent.click(within(screen.getByText("Request changes", { selector: "summary" }).closest("details")!).getByRole("button", { name: "Send back for changes" }));
    await waitFor(() => expect(f.posts()).toHaveLength(1));
    expect(Object.keys(f.posts()[0]!.body as object).sort()).toEqual(["reason", "requestId", "shownDigest"]);
  });
  it("is not offered on a high-risk card, on a card without the action, or on a changed address", () => {
    const high = decisionsOf(view("approve_setting"))[0]!;
    expect(mayRequestChangesHere({ ...decisionsOf(view("approve_plan"))[0]!.card, risk: "high" })).toBe(false);
    expect(mayRequestChangesHere(high.card)).toBe(false);
    const plan = decisionsOf(view("approve_plan"))[0]!;
    expect(mayRequestChangesHere(plan.card)).toBe(true);
    const moved = { ...plan.card, actions: plan.card.actions.map(action => (action.kind === "request_changes" ? { ...action, href: "/v1/app/decisions/approve_plan/other/request-changes" } : action)) };
    expect(mayRequestChangesHere(moved)).toBe(false);
    expect(decisionActionPath(plan.card, "request_changes")).toBe("/v1/app/decisions/approve_plan/plan1/request-changes");
    expect(decisionActionPath(decisionsOf(view("merge"))[0]!.card, "request_changes")).toBeUndefined();
  });
  it("refuses an empty reason before anything is sent, and folds line breaks and hidden characters into one plain line", async () => {
    const f = fakeHost(async request => ({ status: 200, body: request.path === "/v1/app/me" ? meFixture() : { cardId: "approve_plan:plan1", outcome: "rejected", remainingTabs: [] } }));
    const api = createDecisionsApi(f.host);
    const plan = decisionsOf(view("approve_plan"))[0]!;
    await expect(api.requestChanges(plan, "   ")).rejects.toThrow(/plain text/u);
    await expect(api.requestChanges(plan, "\n\u202e\t")).rejects.toThrow(/plain text/u);
    expect(f.request).not.toHaveBeenCalled();
    await api.requestChanges(plan, "First line.\nSecond\u202e line.\r\n\r\nThird.");
    expect((f.request.mock.calls.filter(([r]) => r.method === "POST")[0]![0].body as { reason: string }).reason).toBe("First line. Second line. Third.");
    await api.requestChanges(plan, "x".repeat(600));
    expect((f.request.mock.calls.filter(([r]) => r.method === "POST")[1]![0].body as { reason: string }).reason).toHaveLength(500);
  });
  it("sends a reason typed over several lines as one line", async () => {
    const f = show(decisionsOf(view("approve_plan")), () => ({ status: 200, body: { cardId: "approve_plan:plan1", outcome: "rejected", remainingTabs: [] } }));
    fireEvent.change(screen.getByRole("textbox", { name: "What should change?" }), { target: { value: "Smaller.\nAnd add a test." } });
    fireEvent.click(screen.getByRole("button", { name: "Send back for changes" }));
    await waitFor(() => expect(f.posts()).toHaveLength(1));
    expect((f.posts()[0]!.body as { reason: string }).reason).toBe("Smaller. And add a test.");
  });
  it("is not shown where the page gives no handler", () => {
    const f = fakeHost(async () => ({ status: 200, body: {} }));
    renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: createQueryClient(), children: h(MemoryRouter, { children: h(DecisionCard, { decision: decisionsOf(view("approve_plan"))[0]!, actions: { onOpenEvidence: async () => undefined, onApprove: async () => ({ kind: "decided" as const, outcome: "approved" as const }), onReject: async () => ({ kind: "decided" as const, outcome: "rejected" as const }), onStale: () => undefined } }) }) }) }));
    expect(screen.getByRole("button", { name: "Approve" })).toBeTruthy();
    expect(screen.queryByText("Request changes")).toBeNull();
  });
  it("restores Check on remount, ignores a foreign identity event, reports a changed pending digest, and follows a clear event", async () => {
    const decision = decisionsOf(view("approve_plan_with_choices"))[0]!;
    let lockPresent = true;
    const lockKey = `rv:decision-approval:o-aaaaaaaaaaaaaaaaaaaa:${"a".repeat(64)}:${decision.card.id}`;
    const f = fakeHost(async () => ({ status: 200, body: {} }));
    renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: createQueryClient(), children: h(MemoryRouter, { children: h(DecisionCard, { decision, actions: { onOpenEvidence: async () => undefined, onApprove: async () => ({ kind: "decided" as const, outcome: "approved" as const }), onReject: async () => ({ kind: "decided" as const, outcome: "rejected" as const }), onStale: () => undefined, onHasUnknownApproval: async () => true, onApprovalStorageChange: async key => key === lockKey ? lockPresent : undefined, onCheckApproval: async () => "changed_pending" as const } }) }) }) }));
    expect(await screen.findByRole("button", { name: "Check" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    window.dispatchEvent(new StorageEvent("storage", { key: `rv:decision-approval:other-company:${"b".repeat(64)}:${decision.card.id}`, newValue: "foreign" }));
    expect(await screen.findByRole("button", { name: "Check" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Check" }));
    expect((await screen.findByRole("alert")).textContent).toContain("changed and still reads as pending");
    lockPresent = false;
    window.dispatchEvent(new StorageEvent("storage", { key: lockKey, newValue: null }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Check" })).toBeNull());
  });
});

describe("what an approve sends (pure)", () => {
  const plan = decisionsOf(view("approve_plan_with_choices"))[0]!, requirements = decisionsOf(view("approve_requirements_with_choices"))[0]!;
  it("sends nothing for untouched choices, and only changes otherwise", () => {
    expect(approveExtras(requirements.card, requirements.choices, initialPick(requirements.choices))).toEqual({});
    const pick = { ...initialPick(plan.choices), answers: { q1: "a", q2: "no" } };
    expect(approveExtras(plan.card, plan.choices, pick).answers).toEqual([{ decisionId: "q2", optionId: "no", opened: true }]);
  });
  it("ignores an answer that is not one of the question's options", () => {
    const pick = { ...initialPick(plan.choices), answers: { q1: "zzz" } };
    expect(approveExtras(plan.card, plan.choices, pick).answers).toBeUndefined();
  });
  it("sends the run limit only after a raise was ticked, and never on a kind that takes none", () => {
    const pick = initialPick(plan.choices);
    expect(approveWaitsForLimit(plan.card, pick)).toBe(true);
    expect(approveExtras(plan.card, plan.choices, pick).acknowledgedRunLimitUsd).toBeUndefined();
    expect(approveExtras(plan.card, plan.choices, { ...pick, limitAgreed: true }).acknowledgedRunLimitUsd).toBe(5);
    const lowered = { ...plan.card, runLimit: { currentUsd: 8, proposedUsd: 5 } };
    expect(runLimitOf(lowered)).toMatchObject({ raises: false });
    expect(approveWaitsForLimit(lowered, pick)).toBe(false);
    expect(approveExtras(lowered, plan.choices, pick).acknowledgedRunLimitUsd).toBe(5);
    expect(runLimitOf({ kind: "merge", runLimit: { proposedUsd: 5 } })).toBeUndefined();
    expect(runLimitOf({ kind: "approve_plan", runLimit: { proposedUsd: -1 } })).toBeUndefined();
    expect(runLimitOf({ kind: "approve_plan", runLimit: { proposedUsd: 5 } })).toMatchObject({ currentUsd: undefined, raises: true });
  });
  it("never builds optional checks for a requirements card, even when its choices list some", () => {
    const withChecks = { ...requirements.choices!, optionalChecks: [{ id: "load", label: "Run the load check", selected: false }] };
    const pick = { ...initialPick(withChecks), checks: new Set(["load"]) };
    expect(approveExtras(requirements.card, withChecks, pick).selectedOptionalCheckIds).toBeUndefined();
    expect(approveExtras(plan.card, withChecks, pick).selectedOptionalCheckIds).toEqual(["load"]);
  });
  it("drops every plan field a card kind does not take, whatever the caller built", () => {
    const all = { answers: [{ decisionId: "q1", optionId: "a", opened: true }], selectedOptionalCheckIds: ["x"], includedCommentIds: COMMENTS, note: "n", acknowledgedRunLimitUsd: 5 };
    expect(extrasAllowedFor("merge", all)).toEqual({});
    expect(extrasAllowedFor("approve_requirements", all)).toEqual({ answers: all.answers, includedCommentIds: COMMENTS, note: "n" });
    expect(extrasAllowedFor("approve_plan", all)).toEqual(all);
    expect(extrasAllowedFor("approve_plan", undefined)).toEqual({});
  });
  it("cleans a note the way the broker reads it", () => {
    expect(cleanNote("a‮b\u0007c\r\nd")).toBe("abc\nd");
    expect(cleanNote(" ‮ ")).toBeUndefined();
    expect(cleanNote("x".repeat(600))).toHaveLength(500);
  });
  it("sends the ticked comments back with Request changes, none when none are ticked", () => {
    const pick = initialPick(plan.choices);
    expect(requestChangesCommentIds(plan.choices, pick, plan.card)).toEqual(COMMENTS);
    expect(requestChangesCommentIds(plan.choices, { ...pick, comments: new Set() }, plan.card)).toBeUndefined();
    expect(requestChangesCommentIds(undefined, pick, plan.card)).toBeUndefined();
    expect(requestChangesCommentIds(plan.choices, pick, { kind: "merge" })).toBeUndefined();
  });
  it("carries the plan fields on the wire for a plan card, and never on a merge", async () => {
    const f = fakeHost(async () => answered(plan.card.id));
    const api = createDecisionsApi(f.host);
    const identity = { orgId: "o-aaaaaaaaaaaaaaaaaaaa", developerId: "a".repeat(64) };
    await api.approve(plan, undefined, undefined, { note: "n", answers: [{ decisionId: "q1", optionId: "b", opened: true }], acknowledgedRunLimitUsd: 5 }, identity);
    expect(f.request.mock.calls[0]![0].body).toMatchObject({ note: "n", acknowledgedRunLimitUsd: 5 });
    const merge = decisionsOf(view("merge"))[0]!;
    await api.approve(merge, undefined, undefined, { note: "n", acknowledgedRunLimitUsd: 5 }, identity);
    expect(Object.keys(f.request.mock.calls[1]![0].body as object).sort()).toEqual(["requestId", "shownDigest"]);
  });
});
