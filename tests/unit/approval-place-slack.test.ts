// Approval place (U4, A-02, A-49): the Slack card and the card routes. A medium CODING PLAN gets Approve in Slack (the message shows its evidence; the server then asks the policy whether this person may); any other medium card still
// has no Approve there. "Not now" in a chat is a DISMISSAL: it goes to the dismiss route, which decides nothing, never to a performer's reject.
/* eslint-disable @typescript-eslint/no-unsafe-assignment -- vitest's expect.* matchers are typed any */
import { describe, expect, it, vi } from "vitest";
import type { DecisionCard } from "@agentx/contracts";
import { DecisionCardsViewSchema, DecisionDismissBodySchema, DecisionDismissedSchema } from "@agentx/contracts";
import { cardOfItem, decisionCardPath, projectDecisionCards, type DecisionItem, type ItemBase } from "../../packages/broker/src/decisions/project.js";
import { DECISION_SLACK_APPROVE_ACTION, DECISION_SLACK_OPEN_ACTION, DECISION_SLACK_REJECT_ACTION, slackCardMessage } from "../../packages/broker/src/decisions/slack-card.js";
import { DECISION_SLACK_TEXT, decisionSlackHandler, pressToRequest, refusalText } from "../../packages/broker/src/decisions/slack-actions.js";
import { routeDecisionCards, type DecisionCaller, type DecisionRequest, type PerformOutcome } from "../../packages/broker/src/decisions/routes.js";
import { inMemoryDecisionStore } from "../../packages/broker/src/decisions/store.js";
import { linkAccountWords, notAnApproverWords, signInAgainWords } from "../../packages/broker/src/approval-place/words.js";

const base = (id: string, extra: Partial<ItemBase> = {}): ItemBase => ({ subjectId: id, project: "payments", title: "Retry failed payments", createdAt: "2026-10-30T10:00:00.000Z", contentVersion: "v1", openPath: `/app/sessions/ses_${"a".repeat(20)}`, ...extra });
const planItem = (id: string, untestedClaims: number): DecisionItem => ({ ...base(id), kind: "approve_plan", path: "quick", files: ["src/retry.ts"], claims: 3, untestedClaims });
const lowPlan = planItem("plan-low", 0);
const mediumPlan = planItem("plan-med", 1);
const mediumOther: DecisionItem = { ...base("dep1"), kind: "approve_dependency", packages: 2, newInstallScripts: false };
const highPlan: DecisionItem = { ...base("plan-high"), kind: "approve_plan", path: "quick", files: ["infra/iam/payments-role.tf"], claims: 3, untestedClaims: 0 };
const card = (item: DecisionItem): DecisionCard => { const made = cardOfItem(item); if (made === undefined) throw new Error("no card"); return made.card; };
const DIGEST = "ab".repeat(32);
const URL_ = "https://app.example.com/s/ses_aaaaaaaaaaaaaaaaaaaa";
const ME: DecisionCaller = { orgId: "org1", developerId: "dev1" };
const NOW = Date.parse("2026-10-30T10:05:00.000Z");
const elementsOf = (item: DecisionItem) => ((slackCardMessage(card(item), { cardUrl: URL_, digest: DIGEST }).blocks.find((block) => block["type"] === "actions") as { elements: Array<Record<string, unknown>> }).elements);
const labels = (item: DecisionItem) => elementsOf(item).map((element) => (element["text"] as { text: string }).text);

describe("the Slack card", () => {
  it("positive controls: the plans really are the tiers the tests say", () => {
    expect([lowPlan, mediumPlan, highPlan, mediumOther].map((item) => card(item).risk)).toEqual(["low", "medium", "high", "medium"]);
  });
  it("a medium coding plan has Approve, Not now and Open; any other medium card has no Approve (its evidence is read on the web); a high card has only Open", () => {
    expect(labels(mediumPlan)).toContain("Approve");
    expect(elementsOf(mediumPlan).find((element) => element["action_id"] === DECISION_SLACK_APPROVE_ACTION)?.["value"]).toBe(`approve_plan:plan-med|${DIGEST}`);
    expect(labels(mediumOther)).not.toContain("Approve");
    expect(elementsOf(mediumOther)[0]).toMatchObject({ action_id: DECISION_SLACK_OPEN_ACTION, text: { text: "Show the evidence" } });
    expect(labels(highPlan)).toEqual(["Open"]);
    expect(labels(lowPlan)).toContain("Approve");
  });
});

describe("a press from a chat carries the chat surface; Not now goes to the dismiss route", () => {
  it("approve and Not now are chat requests, and no press ever reaches the reject route", () => {
    for (const actionId of [DECISION_SLACK_APPROVE_ACTION, DECISION_SLACK_REJECT_ACTION]) {
      const request = pressToRequest({ actionId, value: `approve_plan:plan-med|${DIGEST}`, actionTs: "1" });
      expect(request?.surface, actionId).toBe("chat");
      expect(request?.pathname.endsWith("/reject"), actionId).toBe(false);
    }
    expect(pressToRequest({ actionId: DECISION_SLACK_REJECT_ACTION, value: `approve_plan:plan-med|${DIGEST}`, actionTs: "1" })?.pathname).toBe("/v1/app/decisions/approve_plan/plan-med/dismiss");
  });
  it("says what Slack says for each outcome, and the refusals that tell the way forward as they are (and only those)", () => {
    expect(DECISION_SLACK_TEXT.dismissed).toBe("Noted. It stays waiting for you.");
    for (const words of [signInAgainWords("https://app.example.com/s/x"), signInAgainWords(undefined), linkAccountWords("https://app.example.com/s/x"), notAnApproverWords]) {
      expect(refusalText({ code: "FORBIDDEN", message: words })).toBe(words.replace(/&/gu, "&amp;"));
    }
    expect(refusalText({ code: "FORBIDDEN", message: "This plan is medium risk, so it is approved on its card in Rovara: https://app.example.com/s/x" })).toContain("approved on its card");
    // Anything else forbidden stays fixed, and text with markup is not repeated.
    expect(refusalText({ code: "FORBIDDEN", message: "Link your account to Rovara first, then try again: <!channel>" })).toBe(DECISION_SLACK_TEXT.forbidden);
    expect(refusalText({ code: "FORBIDDEN", message: "secret detail" })).toBe(DECISION_SLACK_TEXT.forbidden);
  });
});

describe("the routes", () => {
  function setup(items: DecisionItem[]) {
    const performer = { approve: vi.fn(async (): Promise<PerformOutcome> => ({ kind: "done" })), reject: vi.fn(async (): Promise<PerformOutcome> => ({ kind: "done" })) };
    const store = inMemoryDecisionStore(() => NOW);
    const deps = { sources: { list: async (caller: DecisionCaller) => (caller.developerId === "dev1" ? items : []), locks: async () => ({}) }, performer, store, now: () => NOW };
    const call = (caller: DecisionCaller, request: Partial<DecisionRequest> & { pathname: string }) => routeDecisionCards(deps, caller, { method: "POST", searchParams: new URLSearchParams(), body: undefined, ...request });
    const shown = async (cardId: string) => DecisionCardsViewSchema.parse((await routeDecisionCards(deps, ME, { method: "GET", pathname: "/v1/app/decisions", searchParams: new URLSearchParams(), body: undefined }))?.body).digests[cardId]!;
    const REQ = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
    return { performer, store, call, shown, REQ };
  }
  const path = (cardId: string, action: string) => `${decisionCardPath(cardId)}/${action}`;

  it("dismiss remembers the dismissal, answers `dismissed`, decides nothing and never calls a performer; the card is still waiting", async () => {
    const t = setup([mediumPlan, highPlan]);
    for (const cardId of ["approve_plan:plan-med", "approve_plan:plan-high"]) {
      const reply = await t.call(ME, { pathname: path(cardId, "dismiss"), surface: "chat", body: { requestId: t.REQ(cardId.length), shownDigest: await t.shown(cardId) } });
      expect(reply?.statusCode).toBe(200);
      expect(DecisionDismissedSchema.parse(reply?.body)).toEqual({ cardId, outcome: "dismissed" });
    }
    expect(t.performer.approve).not.toHaveBeenCalled();
    expect(t.performer.reject).not.toHaveBeenCalled();
    expect(t.store.decisions, "no decision is recorded").toEqual([]);
    expect(t.store.dismissals.map((entry) => [entry.cardId, entry.developerId])).toEqual([["approve_plan:plan-med", "dev1"], ["approve_plan:plan-high", "dev1"]]);
    // Still waiting: the list still holds both cards.
    expect(projectDecisionCards([mediumPlan, highPlan]).cards).toHaveLength(2);
  });

  it("dismiss of a changed card is stale, of someone else's card or one that is not waiting is gone, and a body with more than the two fields is refused; nothing is remembered", async () => {
    const t = setup([mediumPlan]);
    const cardId = "approve_plan:plan-med";
    const stale = await t.call(ME, { pathname: path(cardId, "dismiss"), body: { requestId: t.REQ(1), shownDigest: "cd".repeat(32) } }).catch((error: { code: string }) => error.code);
    expect(stale).toBe("CHANGE_STALE");
    const stranger = await t.call({ orgId: "org1", developerId: "dev2" }, { pathname: path(cardId, "dismiss"), body: { requestId: t.REQ(2), shownDigest: await t.shown(cardId) } }).catch((error: { code: string }) => error.code);
    expect(stranger).toBe("NOT_FOUND");
    const gone = await t.call(ME, { pathname: path("approve_plan:nope", "dismiss"), body: { requestId: t.REQ(3), shownDigest: DIGEST } }).catch((error: { code: string }) => error.code);
    expect(gone).toBe("NOT_FOUND");
    const extra = await t.call(ME, { pathname: path(cardId, "dismiss"), body: { requestId: t.REQ(4), shownDigest: await t.shown(cardId), reason: "not_now" } }).catch((error: { code: string }) => error.code);
    expect(extra).toBe("CONFIG_INVALID");
    expect(DecisionDismissBodySchema.safeParse({ requestId: t.REQ(5), shownDigest: DIGEST }).success).toBe(true);
    expect(t.store.dismissals).toEqual([]);
    expect(t.performer.reject).not.toHaveBeenCalled();
  });

  it("a repeat of the same press is remembered once", async () => {
    const t = setup([mediumPlan]);
    const body = { requestId: t.REQ(7), shownDigest: await t.shown("approve_plan:plan-med") };
    await t.call(ME, { pathname: path("approve_plan:plan-med", "dismiss"), body, surface: "chat" });
    await t.call(ME, { pathname: path("approve_plan:plan-med", "dismiss"), body, surface: "chat" });
    expect(t.store.dismissals).toHaveLength(1);
  });

  it("a chat press approves a medium coding plan with no evidence opened first; the same request from anywhere else still needs it", async () => {
    const t = setup([mediumPlan]);
    const cardId = "approve_plan:plan-med";
    const approve = async (n: number, surface?: "chat") => t.call(ME, { pathname: path(cardId, "approve"), ...(surface === undefined ? {} : { surface }), body: { requestId: t.REQ(n), shownDigest: await t.shown(cardId) } }).catch((error: { code: string; message: string }) => ({ code: error.code, message: error.message }));
    expect(await approve(1)).toMatchObject({ code: "CHANGE_STALE", message: expect.stringContaining("Open the evidence first") });
    expect(t.performer.approve).not.toHaveBeenCalled();
    const chat = await approve(2, "chat");
    expect(chat).toMatchObject({ statusCode: 200, body: { outcome: "approved" } });
    expect(t.performer.approve).toHaveBeenCalledTimes(1);
  });

  it("a chat press never approves any other medium card: it is told to read the evidence on the web, and nothing is performed", async () => {
    const t = setup([mediumOther]);
    const cardId = "approve_dependency:dep1";
    const refused = await t.call(ME, { pathname: path(cardId, "approve"), surface: "chat", body: { requestId: t.REQ(1), shownDigest: await t.shown(cardId) } }).catch((error: { code: string; message: string }) => ({ code: error.code, message: error.message }));
    expect(refused).toMatchObject({ code: "CHANGE_STALE", message: expect.stringContaining("Open the evidence first") });
    expect(t.performer.approve).not.toHaveBeenCalled();
  });

  it("opening a medium card's evidence on the web does not let a chat press approve it: the chat press is refused for every medium card but a coding plan, and the web press goes through", async () => {
    const t = setup([mediumOther]);
    const cardId = "approve_dependency:dep1";
    const digest = await t.shown(cardId);
    expect((await t.call(ME, { pathname: path(cardId, "evidence-opened"), body: { requestId: t.REQ(1), shownDigest: digest } }))?.statusCode).toBe(200);
    const chat = await t.call(ME, { pathname: path(cardId, "approve"), surface: "chat", body: { requestId: t.REQ(2), shownDigest: digest } }).catch((error: { code: string }) => error.code);
    expect(chat).toBe("CHANGE_STALE");
    expect(t.performer.approve).not.toHaveBeenCalled();
    const web = await t.call(ME, { pathname: path(cardId, "approve"), body: { requestId: t.REQ(3), shownDigest: digest } });
    expect(web).toMatchObject({ statusCode: 200, body: { outcome: "approved" } });
    expect(t.performer.approve).toHaveBeenCalledTimes(1);
  });

  it("a chat press still has no approve route for a high card (the surface opens nothing for it)", async () => {
    const t = setup([highPlan]);
    const cardId = "approve_plan:plan-high";
    const refused = await t.call(ME, { pathname: path(cardId, "approve"), surface: "chat", body: { requestId: t.REQ(1), shownDigest: await t.shown(cardId) } }).catch((error: { code: string }) => error.code);
    expect(refused).toBe("NOT_FOUND");
    expect(t.performer.approve).not.toHaveBeenCalled();
  });

  it("a client body cannot make a request a chat request: `surface` is not a body field", async () => {
    const t = setup([mediumPlan]);
    const cardId = "approve_plan:plan-med";
    const refused = await t.call(ME, { pathname: path(cardId, "approve"), body: { requestId: t.REQ(1), shownDigest: await t.shown(cardId), surface: "chat" } }).catch((error: { code: string }) => error.code);
    expect(refused).toBe("CONFIG_INVALID");
    expect(t.performer.approve).not.toHaveBeenCalled();
  });

  it("the Slack handler answers a Not now with the dismissal words, and the performer's reject is never called", async () => {
    const t = setup([mediumPlan]);
    const said: string[] = [];
    const handler = decisionSlackHandler({ resolveCaller: async () => ME, route: (caller, request) => routeDecisionCards({ sources: { list: async () => [mediumPlan], locks: async () => ({}) }, performer: t.performer, store: t.store, now: () => NOW }, caller, request), respondEphemeral: async (_url, text) => { said.push(text); } });
    await handler.handle({ actionId: DECISION_SLACK_REJECT_ACTION, value: `approve_plan:plan-med|${await t.shown("approve_plan:plan-med")}`, userId: "U1", actionTs: "1.1", messageTs: "1.0", responseUrl: "https://hooks.example/x", userTeamId: "T1", workspaceTeamId: "T1", enterpriseId: "", userEnterpriseId: "" });
    expect(said).toEqual([DECISION_SLACK_TEXT.dismissed]);
    expect(t.performer.reject).not.toHaveBeenCalled();
    expect(t.store.dismissals).toHaveLength(1);
  });
});
