// Decisions I7: the performer calls the REAL endpoints (pressMerge, decideSpendRequest) through the card routes and reports what they answered. Authority, self-approval and the pull
// request's own risk are the endpoint's; the card adds none and takes none away.
/* eslint-disable @typescript-eslint/no-unsafe-assignment -- vitest's expect.* matchers are typed any */
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { BudgetScope } from "@agentx/contracts";
import { DecisionCardsViewSchema } from "@agentx/contracts";
import { pressMerge } from "../../packages/broker/src/rovara-code/merge.js";
import { createSpendRequest, decideSpendRequest, getSpendRequest } from "../../packages/broker/src/spend/requests.js";
import { effectiveLimits } from "../../packages/broker/src/spend/settings.js";
import { createDecisionPerformer, mergeHandler, spendHandler } from "../../packages/broker/src/decisions/performer.js";
import { routeDecisionCards, type DecisionCaller } from "../../packages/broker/src/decisions/routes.js";
import { decisionCardPath, type DecisionItem } from "../../packages/broker/src/decisions/project.js";
import { inMemoryDecisionStore } from "../../packages/broker/src/decisions/store.js";
import { mergeWorld, type MergeWorld } from "../support/rovara-code-merge-world.js";
import { ARJUN, PRIYA } from "../support/agent-session-world.js";
import { MAYA } from "../support/developer-task-broker.js";
import { TEST_ORG } from "../support/orgs.js";
import { ADA, BEN, month, setup } from "../support/spend-world.js";

const DIGEST = "e".repeat(64);
const NOW = Date.parse("2026-10-30T10:05:00.000Z");

// ---- merge

async function ready(): Promise<MergeWorld> {
  const w = mergeWorld({});
  await w.linkAll();
  w.seedTracking({});
  return w;
}
const risk = (level: "low" | "medium" | "high") => ({ level, reasons: ["A reason in words."], candidateDigest: "d".repeat(64) });

function mergeItem(w: MergeWorld, prRisk: "low" | "medium" | "high"): DecisionItem {
  return { kind: "merge", sessionId: w.sessionId, subjectId: "pr1", project: "web", title: "Fix refunds", createdAt: "2026-10-30T10:00:00.000Z", contentVersion: "head-a", openPath: `/app/sessions/${w.sessionId}`,
    prRisk, prReasons: ["A reason in words."], proof: { proven: 2, passed: 0, failed: 0, notTested: 0 }, reviewVerdict: "approved", ci: "passing", securityFindingsHigh: 0, fullSuitePending: false };
}

function mergeRoute(w: MergeWorld, items: DecisionItem[], browser: boolean, locks: Record<string, "low" | "medium" | "high"> = {}) {
  type Caller = DecisionCaller & { who: string };
  const performer = createDecisionPerformer<Caller>({
    merge: mergeHandler<Caller>((caller, sessionId, body) => pressMerge(w.shareDeps, { ...w.caller(caller.who), ...(browser ? { browserSession: true as const } : {}) }, sessionId, body, w.deps)),
  });
  const deps = { sources: { list: async () => items, locks: async () => locks }, performer, store: inMemoryDecisionStore(() => NOW), now: () => NOW };
  const run = async (who: string, action: "approve" | "reject", body: Record<string, unknown>) =>
    routeDecisionCards(deps, { orgId: "org", developerId: who, who }, { method: "POST", pathname: `${decisionCardPath("merge:pr1")}/${action}`, searchParams: new URLSearchParams(), body });
  const shown = async (who: string) => DecisionCardsViewSchema.parse((await routeDecisionCards(deps, { orgId: "org", developerId: who, who }, { method: "GET", pathname: "/v1/app/decisions", searchParams: new URLSearchParams(), body: undefined }))?.body);
  const open = async (who: string, digest: string) => routeDecisionCards(deps, { orgId: "org", developerId: who, who }, { method: "POST", pathname: `${decisionCardPath("merge:pr1")}/evidence-opened`, searchParams: new URLSearchParams(), body: { requestId: randomUUID(), shownDigest: digest } });
  return { run, shown, open, deps };
}

describe("merge card: the real pressMerge", () => {
  it("a low-risk browser press merges: 200, the pull request is merged, the decision is recorded", async () => {
    const w = await ready();
    w.setWorkflow({ risk: risk("low") });
    const t = mergeRoute(w, [mergeItem(w, "low")], true);
    const digest = (await t.shown(PRIYA)).digests["merge:pr1"]!;
    const reply = await t.run(PRIYA, "approve", { requestId: randomUUID(), shownDigest: digest });
    expect(reply?.statusCode).toBe(200);
    expect(reply?.body).toMatchObject({ outcome: "approved" });
    expect(w.github.mergeCalls).toHaveLength(1);
    expect(t.deps.store.decisions).toHaveLength(1);
  });

  it("a Slack-like (non-browser) press is NOT decided: 202 with the confirmation page, nothing merged, nothing recorded", async () => {
    const w = await ready();
    w.setWorkflow({ risk: risk("low") });
    const t = mergeRoute(w, [mergeItem(w, "low")], false);
    const digest = (await t.shown(PRIYA)).digests["merge:pr1"]!;
    const reply = await t.run(PRIYA, "approve", { requestId: randomUUID(), shownDigest: digest });
    expect(reply?.statusCode).toBe(202);
    expect(reply?.body).toMatchObject({ outcome: "needs_confirmation", confirmUrl: expect.stringMatching(/^https:\/\/.*\/v1\/app\/approve\//u) });
    expect(w.github.mergeCalls).toEqual([]);
    expect(t.deps.store.decisions).toHaveLength(0);
  });

  it("I5: a HIGH-risk pull request has no approve on its card at all (404), and a press that skips the card still cannot merge on a click", async () => {
    const w = await ready();
    w.setWorkflow({ risk: risk("high") });
    const t = mergeRoute(w, [mergeItem(w, "high")], true);
    const view = await t.shown(PRIYA);
    expect(view.cards[0]!.actions.map((action) => action.kind)).toEqual(["open"]);
    await expect(t.run(PRIYA, "approve", { requestId: randomUUID(), shownDigest: view.digests["merge:pr1"]! })).rejects.toMatchObject({ code: "NOT_FOUND" });
    const direct = await pressMerge(w.shareDeps, { ...w.caller(PRIYA), browserSession: true as const }, w.sessionId, { requestId: randomUUID(), risk: "high" }, w.deps);
    expect(direct.status).toBe(202);
    expect(w.github.mergeCalls).toEqual([]);
  });

  it("the endpoint gets the PULL REQUEST's risk, not the card's tier: a lock that raises a low-risk card to medium still merges (the person saw 'low' on the pull request)", async () => {
    const w = await ready();
    w.setWorkflow({ risk: risk("low") });
    const t = mergeRoute(w, [mergeItem(w, "low")], true, { merge: "medium" });
    const view = await t.shown(PRIYA);
    expect(view.cards[0]!.risk).toBe("medium");
    await t.open(PRIYA, view.digests["merge:pr1"]!);
    const reply = await t.run(PRIYA, "approve", { requestId: randomUUID(), shownDigest: view.digests["merge:pr1"]! });
    expect(reply?.statusCode).toBe(200);
    expect(w.github.mergeCalls).toHaveLength(1);
  });

  it("a pull request whose risk changed since the card was built is refused as changed, and nothing merges", async () => {
    const w = await ready();
    w.setWorkflow({ risk: risk("medium") });
    const t = mergeRoute(w, [mergeItem(w, "low")], true);
    const digest = (await t.shown(PRIYA)).digests["merge:pr1"]!;
    await expect(t.run(PRIYA, "approve", { requestId: randomUUID(), shownDigest: digest })).rejects.toMatchObject({ code: "CHANGE_STALE" });
    expect(w.github.mergeCalls).toEqual([]);
  });

  it("a person who may not press Merge (a contributor) is refused by the endpoint, not by the card", async () => {
    const w = await ready();
    w.setWorkflow({ risk: risk("low") });
    const t = mergeRoute(w, [mergeItem(w, "low")], true);
    const digest = (await t.shown(ARJUN)).digests["merge:pr1"]!;
    await expect(t.run(ARJUN, "approve", { requestId: randomUUID(), shownDigest: digest })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(w.github.mergeCalls).toEqual([]);
    expect(t.deps.store.decisions).toHaveLength(0);
  });

  it("a merge with no session on the item is refused as unsupported (decided on its page)", async () => {
    const w = await ready();
    const noSession = { ...mergeItem(w, "low"), sessionId: undefined };
    const t = mergeRoute(w, [noSession], true);
    const digest = (await t.shown(PRIYA)).digests["merge:pr1"]!;
    await expect(t.run(PRIYA, "approve", { requestId: randomUUID(), shownDigest: digest })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });
});

// ---- spend

const MEMBER: BudgetScope = { kind: "member", developerId: MAYA.developerId };
describe("spend card: the real decideSpendRequest", () => {
  async function world() {
    const t = await setup();
    const limit = (await effectiveLimits({ documentClient: t.db, tableName: "state", cloud: true }, { orgId: TEST_ORG, month: month(), scopes: [MEMBER] })).get(`MEMBER#${MAYA.developerId}`)!;
    const request = (await createSpendRequest(t.deps(), {
      orgId: TEST_ORG, kind: "month", scope: MEMBER, subject: `MONTH#${month()}#MEMBER#${MAYA.developerId}#system#${randomUUID()}`, amountUsd: 5, newLimitUsd: limit + 5, reason: "More please.", requestedBy: { kind: "system" },
    })).record;
    type Caller = DecisionCaller & { who: typeof ADA; role: "owner" | "admin" | "member" };
    const item: DecisionItem = { kind: "approve_spend", subjectId: request.spendRequestId, project: "payments", title: "More budget", createdAt: "2026-10-30T10:00:00.000Z", contentVersion: "r1", openPath: "/app/sessions/ses_x", amountUsd: 5, scopeLabel: "this member" };
    const performer = createDecisionPerformer<Caller>({ approve_spend: spendHandler<Caller>((caller, id, body) => decideSpendRequest(t.deps(), t.caller(caller.who, caller.role), id, body)) });
    const deps = { sources: { list: async () => [item], locks: async () => ({}) }, performer, store: inMemoryDecisionStore(() => NOW), now: () => NOW };
    const cardId = `approve_spend:${request.spendRequestId}`;
    const call = (caller: Caller, action: "approve" | "reject", body: Record<string, unknown>) =>
      routeDecisionCards(deps, caller, { method: "POST", pathname: `${decisionCardPath(cardId)}/${action}`, searchParams: new URLSearchParams(), body });
    const digest = async (caller: Caller) => DecisionCardsViewSchema.parse((await routeDecisionCards(deps, caller, { method: "GET", pathname: "/v1/app/decisions", searchParams: new URLSearchParams(), body: undefined }))?.body).digests[cardId]!;
    return { t, request, call, digest, deps, cardId, caller: (who: typeof ADA, role: "owner" | "admin" | "member" = "owner"): Caller => ({ orgId: TEST_ORG, developerId: who.developerId, who, role }) };
  }

  it("an approver approves a small request in one request; the spend request is APPROVED", async () => {
    const w = await world();
    const me = w.caller(ADA);
    const reply = await w.call(me, "approve", { requestId: randomUUID(), shownDigest: await w.digest(me) });
    expect(reply?.statusCode).toBe(200);
    expect((await getSpendRequest(w.t.deps(), TEST_ORG, w.request.spendRequestId))?.status).toBe("APPROVED");
  });

  it("someone who may not decide it is refused by the endpoint (forbidden); nothing is recorded and the request stays open", async () => {
    const w = await world();
    const stranger = w.caller(BEN, "member");
    await expect(w.call(stranger, "approve", { requestId: randomUUID(), shownDigest: await w.digest(stranger) })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(w.deps.store.decisions).toHaveLength(0);
    expect((await getSpendRequest(w.t.deps(), TEST_ORG, w.request.spendRequestId))?.status).toBe("PENDING");
  });

  it("reject denies the request", async () => {
    const w = await world();
    const me = w.caller(ADA);
    const reply = await w.call(me, "reject", { requestId: randomUUID(), reason: "not_now" });
    expect(reply?.statusCode).toBe(200);
    expect((await getSpendRequest(w.t.deps(), TEST_ORG, w.request.spendRequestId))?.status).toBe("DENIED");
  });

  it("two approves with different request ids make one decision: the second finds the request closed", async () => {
    const w = await world();
    const me = w.caller(ADA);
    const digest = await w.digest(me);
    await w.call(me, "approve", { requestId: randomUUID(), shownDigest: digest });
    await expect(w.call(me, "approve", { requestId: randomUUID(), shownDigest: digest })).rejects.toBeDefined();
    expect(w.deps.store.decisions).toHaveLength(1);
  });
});

describe("a kind with no handler is refused as unsupported", () => {
  it("answers CONFIG_INVALID (decided on its page) and records nothing", async () => {
    const performer = createDecisionPerformer<DecisionCaller>({});
    const item: DecisionItem = { kind: "approve_plan", subjectId: "plan1", project: "p", title: "t", createdAt: "2026-10-30T10:00:00.000Z", contentVersion: "v1", openPath: "/app/sessions/ses_x", path: "quick", files: [], claims: 1, untestedClaims: 0 };
    const deps = { sources: { list: async () => [item], locks: async () => ({}) }, performer, store: inMemoryDecisionStore(() => NOW), now: () => NOW };
    const who = { orgId: "o", developerId: "d" };
    const view = DecisionCardsViewSchema.parse((await routeDecisionCards(deps, who, { method: "GET", pathname: "/v1/app/decisions", searchParams: new URLSearchParams(), body: undefined }))?.body);
    await expect(routeDecisionCards(deps, who, { method: "POST", pathname: `${decisionCardPath("approve_plan:plan1")}/approve`, searchParams: new URLSearchParams(), body: { requestId: randomUUID(), shownDigest: view.digests["approve_plan:plan1"] ?? DIGEST } })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    expect(deps.store.decisions).toHaveLength(0);
  });
});
