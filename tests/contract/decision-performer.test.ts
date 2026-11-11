// Decisions I7: the performer calls the REAL endpoints (pressMerge, decideSpendRequest) through the card routes and reports what they answered. Authority, self-approval and the pull
// request's own risk are the endpoint's; the card adds none and takes none away.
/* eslint-disable @typescript-eslint/no-unsafe-assignment -- vitest's expect.* matchers are typed any */
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { BudgetScope } from "@agentx/cloud-contracts";
import { DecisionCardsViewSchema } from "@rovara-code/contracts";
import { pressMerge } from "../../packages/broker/src/rovara-code/merge.js";
import { withCardDecideGrade } from "../../packages/broker/src/aws/developer-routes/card-decide-grade.js";
import type { DeveloperRouteDependencies } from "../../packages/broker/src/aws/developer-routes/types.js";
import { createSpendRequest, decideSpendRequest, getSpendRequest } from "../../packages/broker/src/spend/requests.js";
import { effectiveLimits } from "../../packages/broker/src/spend/settings.js";
import { createDecisionPerformer, mergeHandler, spendHandler } from "../../packages/broker/src/decisions/performer.js";
import { routeDecisionCards, type DecisionCaller } from "../../packages/broker/src/decisions/routes.js";
import { decisionCardPath, type DecisionItem } from "../../packages/broker/src/decisions/project.js";
import { inMemoryDecisionStore } from "../../packages/broker/src/decisions/store.js";
import { HEAD_A, HEAD_B, mergeWorld, type MergeWorld } from "../support/rovara-code-merge-world.js";
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
    heads: [{ repositoryId: "payments", number: 7, headSha: HEAD_A }], targets: [{ repositoryId: "payments", number: 7, baseBranch: "main" }], prRisk, prReasons: ["A reason in words."], proof: { proven: 2, passed: 0, failed: 0, notTested: 0 }, reviewVerdict: "approved", ci: "passing", securityFindingsHigh: 0, fullSuitePending: false };
}

function mergeRoute(w: MergeWorld, items: DecisionItem[], browser: boolean, locks: Record<string, "low" | "medium" | "high"> = {}) {
  type Caller = DecisionCaller & { who: string };
  const performer = createDecisionPerformer<Caller>({
    merge: mergeHandler<Caller>((caller, sessionId, body, expectedHeads) => pressMerge(w.shareDeps, { ...w.caller(caller.who), ...(browser ? { browserSession: true as const } : {}) }, sessionId, body, w.deps, { expectedHeads })),
  });
  // Slice 3: a high merge card is approved on the card (the press asks for the recent sign-in), as the wiring sets it.
  const deps = { sources: { list: async () => items, locks: async () => locks }, performer, store: inMemoryDecisionStore(() => NOW), now: () => NOW, highOnCard: new Set(["merge"]) };
  const run = async (who: string, action: "approve" | "reject", body: Record<string, unknown>, search = "") =>
    routeDecisionCards(deps, { orgId: "org", developerId: who, who }, { method: "POST", pathname: `${decisionCardPath("merge:pr1")}/${action}`, searchParams: new URLSearchParams(search), body });
  const shown = async (who: string) => DecisionCardsViewSchema.parse((await routeDecisionCards(deps, { orgId: "org", developerId: who, who }, { method: "GET", pathname: "/v1/app/decisions", searchParams: new URLSearchParams(), body: undefined }))?.body);
  const open = async (who: string, digest: string) => routeDecisionCards(deps, { orgId: "org", developerId: who, who }, { method: "POST", pathname: `${decisionCardPath("merge:pr1")}/evidence-opened`, searchParams: new URLSearchParams(), body: { requestId: randomUUID(), shownDigest: digest } });
  return { run, shown, open, deps };
}

/** The merge card as the wiring builds it for a browser: a high merge runs under the card's decide-grade sign-in (`withCardDecideGrade`), with the browser's decide cookie. */
function gradedMergeRoute(w: MergeWorld, items: DecisionItem[], cookie: () => string | undefined) {
  type Caller = DecisionCaller & { who: string };
  const developer = { documentClient: w.db, tableName: "state", developer: { signInTableName: "signin" }, now: () => w.clock.now, agents: w.deps } as unknown as DeveloperRouteDependencies;
  const performer = createDecisionPerformer<Caller>({
    merge: mergeHandler<Caller>((caller, sessionId, body, expectedHeads, input) => {
      const who = { ...w.caller(caller.who), browserSession: true as const };
      return pressMerge(w.shareDeps, who, sessionId, body, w.deps, { expectedHeads, decideGrade: (apply) => withCardDecideGrade(developer, who, cookie(), { cardId: input.card.id, taskId: input.item.taskId!, contentVersion: input.item.contentVersion, openPath: input.item.openPath }, apply) });
    }),
  });
  const deps = { sources: { list: async () => items, locks: async () => ({}) }, performer, store: inMemoryDecisionStore(() => NOW), now: () => NOW, highOnCard: new Set(["merge"]) };
  const run = async (who: string, action: "approve" | "reject", body: Record<string, unknown>) =>
    routeDecisionCards(deps, { orgId: "org", developerId: who, who }, { method: "POST", pathname: `${decisionCardPath("merge:pr1")}/${action}`, searchParams: new URLSearchParams(), body });
  const shown = async (who: string) => DecisionCardsViewSchema.parse((await routeDecisionCards(deps, { orgId: "org", developerId: who, who }, { method: "GET", pathname: "/v1/app/decisions", searchParams: new URLSearchParams(), body: undefined }))?.body);
  return { run, shown };
}

describe("merge card: the real pressMerge", () => {
  it("slice 3 (owner: one merge control, no separate confirmation page; replaces WEB-1): a browser press on the card merges in place at low and medium risk, and is recorded", async () => {
    for (const level of ["low", "medium"] as const) {
      const w = await ready();
      w.setWorkflow({ risk: risk(level) });
      const t = mergeRoute(w, [mergeItem(w, level)], true);
      const view = await t.shown(PRIYA);
      const digest = view.digests["merge:pr1"]!;
      expect(view.cards[0]!.actions.find((action) => action.kind === "approve")?.label, level).toBe("Merge");
      if (level === "medium") await t.open(PRIYA, digest);
      const reply = await t.run(PRIYA, "approve", { requestId: randomUUID(), shownDigest: digest }, "merging=1");
      expect(reply?.statusCode, level).toBe(200);
      expect(reply?.body, level).toMatchObject({ cardId: "merge:pr1", outcome: "approved" });
      expect(w.github.mergeCalls, level).toHaveLength(1);
      expect(t.deps.store.decisions, level).toHaveLength(1);
    }
  });

  it("WEB-1 S2: `merging` is sent only to a client that asks for it (?merging=1); every other 202 keeps the earlier shape, which a strict older reader accepts (a press that is not a browser's)", async () => {
    const OldShape = z.object({ cardId: z.string(), outcome: z.literal("needs_confirmation"), confirmUrl: z.string().url() }).strict();
    const w = await ready();
    w.setWorkflow({ risk: risk("low") });
    const t = mergeRoute(w, [mergeItem(w, "low")], false);
    const digest = (await t.shown(PRIYA)).digests["merge:pr1"]!;
    const plain = await t.run(PRIYA, "approve", { requestId: randomUUID(), shownDigest: digest });
    expect(plain?.statusCode).toBe(202);
    expect(() => OldShape.parse(plain?.body)).not.toThrow();
    expect(plain?.body).not.toHaveProperty("merging");
    const asked = await t.run(PRIYA, "approve", { requestId: randomUUID(), shownDigest: digest }, "merging=1");
    expect(asked?.body).toHaveProperty("merging");
    for (const odd of ["merging=0", "merging=true", "merging="]) expect((await t.run(PRIYA, "approve", { requestId: randomUUID(), shownDigest: digest }, odd))?.body, odd).not.toHaveProperty("merging");
  });

  it("WEB-1 S1: the same requestId for the same card and heads makes ONE pending change (a press that is not a browser's)", async () => {
    const w = await ready();
    w.setWorkflow({ risk: risk("low") });
    const t = mergeRoute(w, [mergeItem(w, "low")], false);
    const digest = (await t.shown(PRIYA)).digests["merge:pr1"]!;
    const requestId = randomUUID();
    const first = await t.run(PRIYA, "approve", { requestId, shownDigest: digest }, "merging=1");
    const second = await t.run(PRIYA, "approve", { requestId, shownDigest: digest }, "merging=1");
    expect(second?.statusCode).toBe(202);
    expect({ ...(second?.body as object), confirmUrl: undefined }).toEqual({ ...(first?.body as object), confirmUrl: undefined });
    expect(w.db.find((item) => item.entityType === "APPROVAL")).toHaveLength(1);
    await t.run(PRIYA, "approve", { requestId: randomUUID(), shownDigest: digest }, "merging=1");
    expect(w.db.find((item) => item.entityType === "APPROVAL")).toHaveLength(2);
  });

  it("slice 3: a browser press that carries the heads the card showed merges in place at low risk (the card and the button are one control)", async () => {
    const w = await ready();
    w.setWorkflow({ risk: risk("low") });
    const reply = await pressMerge(w.shareDeps, { ...w.caller(PRIYA), browserSession: true as const }, w.sessionId, { requestId: randomUUID(), risk: "low" }, w.deps, { expectedHeads: [{ repositoryId: "payments", number: 7, headSha: HEAD_A }] });
    expect(reply.status).toBe(200);
    expect(w.github.mergeCalls).toHaveLength(1);
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

  it("final review: a browser's HIGH-risk merge is merged on its card under the decide-grade sign-in (email code) for that card and heads, with the session's proof on the merge; a token only gets the pending change", async () => {
    const w = await ready();
    w.setWorkflow({ risk: risk("high") });
    const item = { ...mergeItem(w, "high"), taskId: w.taskId };
    const jar: { cookie?: string } = {};
    const t = gradedMergeRoute(w, [item], () => jar.cookie);
    const view = await t.shown(PRIYA);
    const digest = view.digests["merge:pr1"]!;
    // A web session alone (signed in just now, with GitHub): REAUTH_REQUIRED with the decide sign-in made for this card; nothing merges and no pending merge change is made.
    const github = await t.run(PRIYA, "approve", { requestId: randomUUID(), shownDigest: digest }).then(() => undefined, (error: unknown) => error as { code?: string; reason?: string; signInUrl?: string });
    expect(github).toMatchObject({ code: "REAUTH_REQUIRED", reason: "decide_sign_in" });
    const approvalId = /apr_[0-9a-z]{20}/u.exec(decodeURIComponent(github!.signInUrl!))![0];
    // Pressing again before signing in reuses the same record (no pile-up).
    const again = await t.run(PRIYA, "approve", { requestId: randomUUID(), shownDigest: digest }).then(() => undefined, (error: unknown) => error as { signInUrl?: string });
    expect(decodeURIComponent(again!.signInUrl!)).toContain(approvalId);
    expect(w.db.find((record) => record.entityType === "APPROVAL").map((record) => (record.subject as { kind: string }).kind)).toEqual(["card_decision"]);
    expect(w.github.mergeCalls).toEqual([]);
    // A push after the card was shown: the heads pin refuses it even with the sign-in, and the session is given back.
    jar.cookie = await w.browser(PRIYA, approvalId);
    w.seedTracking({ headSha: HEAD_B });
    await expect(gradedMergeRoute(w, [item], () => jar.cookie).run(PRIYA, "approve", { requestId: randomUUID(), shownDigest: digest })).rejects.toMatchObject({ code: "CHANGE_STALE" });
    expect(w.github.mergeCalls).toEqual([]);
    w.seedTracking({});
    // With the email-code decide session for this card: merged, once, and the record carries the session's proof.
    const merged = await t.run(PRIYA, "approve", { requestId: randomUUID(), shownDigest: digest });
    expect(merged?.statusCode, JSON.stringify(merged?.body)).toBe(200);
    expect(w.github.mergeCalls).toHaveLength(1);
    const record = w.db.find((entry) => entry.entityType === "APPROVAL" && entry.approvalId === approvalId)[0];
    expect(record).toMatchObject({ status: "APPROVED_DONE", subject: { kind: "card_decision", cardId: "merge:pr1" }, decisionProof: { kind: "fresh_sign_in", method: "email_code" } });
    const sessionRef = (record!.decisionProof as { sessionRef: string }).sessionRef;
    const claims = w.audited().filter((event) => event.action === "pull_request.merge_requested");
    expect(claims.length).toBeGreaterThan(0);
    expect(claims.every((event) => (event.proof as { sessionRef?: string } | undefined)?.sessionRef === sessionRef), "the merge's audit claim carries the same proof").toBe(true);
    // A browser press from outside the card (the Merge button) is told where it is merged; a token gets the pending change and never merges.
    await expect(pressMerge(w.shareDeps, { ...w.caller(PRIYA), browserSession: true as const }, w.sessionId, { requestId: randomUUID(), risk: "high" }, w.deps)).rejects.toMatchObject({ code: "FORBIDDEN" });
    const before = w.github.mergeCalls.length;
    const token = await pressMerge(w.shareDeps, w.caller(PRIYA), w.sessionId, { requestId: randomUUID() }, w.deps);
    expect(token.status).toBe(202);
    expect(w.github.mergeCalls).toHaveLength(before);
  });

  it("the endpoint gets the PULL REQUEST's risk, not the card's tier: a lock that raises a low-risk card to medium is still pressed with the level the person saw ('low'), and merges in place", async () => {
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

  it("N3: a push between the card and the press (the head moved) is refused as changed and nothing merges, even at the same risk level", async () => {
    const w = await ready();
    w.setWorkflow({ risk: risk("low") });
    const shownBefore = mergeItem(w, "low");
    const t = mergeRoute(w, [shownBefore], true);
    const digest = (await t.shown(PRIYA)).digests["merge:pr1"]!;
    // A new push lands after the projection: tracking now holds another head.
    w.seedTracking({ headSha: HEAD_B });
    const stale = mergeRoute(w, [shownBefore], true);
    await expect(stale.run(PRIYA, "approve", { requestId: randomUUID(), shownDigest: digest })).rejects.toMatchObject({ code: "CHANGE_STALE" });
    expect(w.github.mergeCalls).toEqual([]);
    expect(stale.deps.store.decisions).toHaveLength(0);
  });

  it("a merge card with no shown heads is not pressed (unsupported)", async () => {
    const w = await ready();
    w.setWorkflow({ risk: risk("low") });
    const t = mergeRoute(w, [{ ...mergeItem(w, "low"), heads: undefined } as DecisionItem], true);
    const digest = (await t.shown(PRIYA)).digests["merge:pr1"]!;
    await expect(t.run(PRIYA, "approve", { requestId: randomUUID(), shownDigest: digest })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
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
