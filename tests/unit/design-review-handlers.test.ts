// Design review stage, fix round (H1, M7): the design-approval handler and the spend-choice handler. Every permission and friction check lives INSIDE the handlers, so these tests call them directly with the
// broker's own records faked: the refusals are pinned as hard as the grants, and each test names the wiring-free rule it proves (reason on an open blocker, requester and fresh sign-in on high, evidence first
// on medium, who may raise the cap, run unpriced or skip, the digest the person saw).
import { describe, expect, it } from "vitest";
import { DESIGN_REVIEW_DEFAULT_SETTING, DecisionApproveBodySchema, DecisionCardSchema, type DecisionCard } from "@rovara-code/contracts";
import { editionPolicy } from "@agentx/cloud-contracts";
import { cardOfItem, projectDecisionCards, type DecisionItem } from "../../packages/broker/src/decisions/project.js";
import { inMemoryDecisionStore } from "../../packages/broker/src/decisions/store.js";
import type { PerformOutcome } from "../../packages/broker/src/decisions/routes.js";
import { openBlockerWords } from "../../packages/broker/src/design-review/proof-line.js";
import { DESIGN_REASON_NOT_ALLOWED_MESSAGE, DESIGN_REASON_REQUIRED_MESSAGE, designApprovalProofLine, designApproveHandler, type DesignApprovalContext, type DesignApprovalWrite, type DesignApproveInput } from "../../packages/broker/src/design-review/approve-handler.js";
import { DESIGN_APPROVER_GROUP_WORDS, DESIGN_APPROVER_NONE_WORDS, type DesignApproverDirectory } from "../../packages/broker/src/design-review/approval.js";
import { designApproveItem, designContentVersion } from "../../packages/broker/src/design-review/card-source.js";
import { markEffective } from "../../packages/broker/src/design-review/effective-setting.js";
import { estimateDesignReviewUsd, type DesignReviewEstimate } from "../../packages/broker/src/design-review/estimate.js";
import { DESIGN_CHOICE_REAUTH_MESSAGE, designSpendChoiceHandler, designSpendGateFor, designSpendItemFor, mayChooseDesignSpend, type DesignSpendContext, type DesignSpendRequest, type DesignSpendWrite } from "../../packages/broker/src/design-review/spend-choice.js";
import type { DesignCardFacts } from "../../packages/broker/src/design-review/risk.js";

const TASK = "11111111-1111-4111-8111-111111111111";
const NOW = Date.parse("2026-11-03T12:00:00Z");
const caller = (developerId: string) => ({ orgId: "org-a", developerId });
const failure = (promise: Promise<unknown>) => promise.then(() => undefined, (error: { code?: string; message: string }) => ({ code: error.code, message: error.message.replace(`${String(error.code)}: `, "") }));

const people = (change: Partial<DesignApproverDirectory["people"]> = {}): DesignApproverDirectory["people"] => ({ complete: true, membershipVersion: 4, ownerIds: ["own", "max"], eligibleIds: ["own", "max"], lastEligibleLossAtMs: null, ...change });
const directory = (change: Partial<DesignApproverDirectory> = {}): DesignApproverDirectory => ({ people: people(), projectMemberIds: ["own", "max", "priya", "arjun"], notApproverIds: [], ...change });
const facts = (change: Partial<DesignCardFacts> = {}): DesignCardFacts => ({ reasons: [], touches: [], reviewers: { planned: 3, verified: 3 }, blockers: [], majors: 0, disagreements: [], ...change });

describe("the design approval handler (H1)", () => {
  const base = { subjectId: "des1", taskId: TASK, project: "payments", title: "Partner ranking", createdAt: "2026-11-03T10:00:00.000Z", openPath: `/app/sessions/ses_${"a".repeat(20)}`, contentVersion: "v1" };
  const itemOf = (review: DesignCardFacts, files = ["src/retry.ts"]): Extract<DecisionItem, { kind: "approve_design" }> => designApproveItem({ ...base, files, review, confirmPath: `/v1/app/approve/${"b".repeat(20)}` }) as Extract<DecisionItem, { kind: "approve_design" }>;
  const blocked = facts({ blockers: [{ section: "§5", text: "No rollback is described." }] });

  function rig(contextChange: Partial<DesignApprovalContext> = {}) {
    const store = inMemoryDecisionStore(() => NOW);
    const writes: DesignApprovalWrite[] = [];
    const state = { commit: "done" as "done" | "stale" };
    const context: DesignApprovalContext = { requesterId: "priya", setting: markEffective(DESIGN_REVIEW_DEFAULT_SETTING), edition: editionPolicy("enterprise"), directory: directory(), freshSignIn: true, ...contextChange };
    const handler = designApproveHandler({
      context: async () => context, locks: async () => ({}), store, nowMs: () => NOW, confirmUrl: () => "https://rovara.example/v1/app/approve/confirm",
      commit: async (_caller, write) => { writes.push(write); return state.commit; },
    });
    /** What the route would pass: the card, the item, the digest it showed, and (in tests) that the evidence was opened or not. */
    async function press(who: string, item: Extract<DecisionItem, { kind: "approve_design" }>, extra: Partial<DesignApproveInput> & { open?: boolean | "other" } = {}): Promise<PerformOutcome> {
      const projection = projectDecisionCards([item], { pairFullCards: false });
      const card = projection.cards[0] as DecisionCard;
      const digest = projection.digests[card.id]!;
      if (extra.open === true) await store.recordEvidenceOpened({ ...caller(who), cardId: card.id }, digest, new Date(NOW).toISOString());
      if (extra.open === "other") await store.recordEvidenceOpened({ ...caller(who), cardId: card.id }, "f".repeat(64), new Date(NOW).toISOString());
      const { reason, shown, tab } = extra;
      const input: DesignApproveInput = { card, item, requestId: "22222222-2222-4222-8222-222222222222", shown: shown ?? { cardId: card.id, digest }, reason, tab };
      return handler.approve(caller(who), input);
    }
    return { press, writes, state, store };
  }

  it("a medium design with an open blocker is not a one-tap approve: no reason, no approval, and nothing is committed", async () => {
    const r = rig();
    const item = itemOf(blocked);
    expect(cardOfItem(item)!.card.risk).toBe("medium");
    const none = await failure(r.press("priya", item, { open: true }));
    expect(none).toEqual({ code: "CONFIG_INVALID", message: DESIGN_REASON_REQUIRED_MESSAGE });
    for (const bad of ["   ", "x".repeat(201), "line one\nline two", "hidden‮text"]) {
      expect(await failure(r.press("priya", item, { open: true, reason: bad })), JSON.stringify(bad)).toMatchObject({ code: "CONFIG_INVALID" });
    }
    expect(r.writes).toEqual([]);
  });

  it("with a reason it is approved, and the reason, the Proof words and the fence are in the commit", async () => {
    const r = rig();
    const item = itemOf(blocked);
    expect(await r.press("priya", item, { open: true, reason: "  Rollback is covered by the feature flag.  " })).toEqual({ kind: "done" });
    expect(r.writes).toHaveLength(1);
    expect(r.writes[0]).toMatchObject({
      approverId: "priya", requesterId: "priya", tier: "medium", mode: "requester", openBlockers: 1, proofReason: "Rollback is covered by the feature flag.",
      proofLine: "Design approved with 1 open blocker: Rollback is covered by the feature flag.", auditSoleOwnerException: false,
    });
    expect(r.writes[0]!.fence.ExpressionAttributeValues).toEqual({ ":approvalMembershipVersion": 4 });
    expect(designApprovalProofLine(0, "x")).toBeUndefined();
    expect(designApprovalProofLine(2, "ok")).toBe("Design approved with 2 open blockers: ok");
  });

  it("a reason is taken only where a blocker is open: on a clean design it is refused, not stored", async () => {
    const r = rig();
    expect(await failure(r.press("priya", itemOf(facts()), { reason: "just because" }))).toEqual({ code: "CONFIG_INVALID", message: DESIGN_REASON_NOT_ALLOWED_MESSAGE });
    expect(r.writes).toEqual([]);
    expect(await r.press("priya", itemOf(facts()))).toEqual({ kind: "done" });
    expect(r.writes[0]).toMatchObject({ openBlockers: 0, proofReason: undefined, proofLine: undefined });
  });

  it("medium: the evidence of exactly the digest shown must have been opened, in the handler too", async () => {
    const r = rig();
    const item = itemOf(blocked);
    const reason = "Covered by the feature flag.";
    expect(await r.press("priya", item, { reason })).toMatchObject({ kind: "refused", reason: "stale" });
    expect(await r.press("priya", item, { reason, open: "other" })).toMatchObject({ kind: "refused", reason: "stale" });
    // The digest the client holds is not what the server shows now (the blocker set changed): stale, even if that old digest was opened.
    const old = rig();
    const stale = await old.press("priya", item, { reason, open: true, shown: { cardId: cardOfItem(item)!.card.id, digest: "e".repeat(64) } });
    expect(stale).toMatchObject({ kind: "refused", reason: "stale" });
    expect(r.writes).toEqual([]);
    expect(await rig().press("priya", item, { reason, open: true })).toEqual({ kind: "done" });
  });

  it("ON-12: a high-risk design whose approver is a group (no member store yet) is refused in plain words, and nothing is committed; with no approver at all it says so", async () => {
    const high = itemOf(facts({ touches: ["data_model"] }));
    const group = rig({ setting: markEffective({ ...DESIGN_REVIEW_DEFAULT_SETTING, highRiskApprover: { kind: "group", groupId: "g1" } }) });
    expect(await failure(group.press("own", high))).toEqual({ code: "CONFIG_INVALID", message: DESIGN_APPROVER_GROUP_WORDS });
    const nobody = rig({ setting: markEffective({ ...DESIGN_REVIEW_DEFAULT_SETTING, highRiskApprover: { kind: "people", memberIds: ["gone"] } }) });
    expect(await failure(nobody.press("own", high))).toEqual({ code: "CONFIG_INVALID", message: DESIGN_APPROVER_NONE_WORDS });
    expect(group.writes).toEqual([]);
    expect(nobody.writes).toEqual([]);
  });

  it("who may approve: the requester or a maintainer; a member who did not ask, an outsider and an Auditor are refused and nothing is committed", async () => {
    const r = rig();
    const item = itemOf(facts());
    expect(await r.press("max", item)).toEqual({ kind: "done" });
    expect(r.writes[0]).toMatchObject({ mode: "maintainer" });
    for (const who of ["arjun", "zed"]) expect(await r.press(who, item), who).toEqual({ kind: "refused", reason: "forbidden" });
    const auditor = rig({ requesterId: "aud", directory: directory({ projectMemberIds: ["own", "max", "aud"], notApproverIds: ["aud"] }) });
    expect(await auditor.press("aud", item)).toEqual({ kind: "refused", reason: "forbidden" });
    expect(auditor.writes).toEqual([]);
  });

  it("the tier comes from the broker's rules, not the card it is handed: a high design behind a low card still needs a high-risk approver, and a fresh sign-in", async () => {
    const high = itemOf(facts({ touches: ["money"] }));
    const lowCard: DecisionCard = { ...cardOfItem(itemOf(facts()))!.card, id: cardOfItem(high)!.card.id };
    const r = rig({ requesterId: "priya" });
    const run = async (rigged: ReturnType<typeof rig>, who: string) => {
      const handler = designApproveHandler({
        context: async () => ({ requesterId: "priya", setting: markEffective(DESIGN_REVIEW_DEFAULT_SETTING), edition: editionPolicy("enterprise"), directory: directory(), freshSignIn: true }), locks: async () => ({}), store: rigged.store, nowMs: () => NOW,
        confirmUrl: () => undefined, commit: async (_c, write) => { rigged.writes.push(write); return "done"; },
      });
      return handler.approve(caller(who), { card: lowCard, item: high, requestId: "22222222-2222-4222-8222-222222222222" });
    };
    expect(await run(r, "priya")).toEqual({ kind: "refused", reason: "forbidden" });
    expect(await run(r, "own")).toEqual({ kind: "done" });
    expect(r.writes[0]).toMatchObject({ tier: "high", mode: "high_risk_approver" });
  });

  it("high: the requester is refused even as a high-risk approver, a missing fresh sign-in goes to the confirmation page, and nothing is committed until it is fresh", async () => {
    const high = itemOf(facts({ touches: ["data_model"] }));
    const requesterIsMax = rig({ requesterId: "max" });
    expect(await requesterIsMax.press("max", high)).toEqual({ kind: "refused", reason: "second_person_required" });
    const stale = rig({ freshSignIn: false });
    expect(await stale.press("own", high)).toEqual({ kind: "needs_confirmation", confirmUrl: "https://rovara.example/v1/app/approve/confirm" });
    expect(stale.writes).toEqual([]);
    const fresh = rig({ freshSignIn: true });
    expect(await fresh.press("own", high)).toEqual({ kind: "done" });
    expect(fresh.writes[0]).toMatchObject({ tier: "high", mode: "high_risk_approver" });
  });

  it("the sole-owner exception is audited and only when nobody else could approve", async () => {
    const high = itemOf(facts({ touches: ["money"] }));
    const solo = rig({ requesterId: "own", directory: directory({ people: people({ ownerIds: ["own"], eligibleIds: ["own"] }), projectMemberIds: ["own"] }) });
    expect(await solo.press("own", high)).toEqual({ kind: "done" });
    expect(solo.writes[0]).toMatchObject({ mode: "sole_owner_exception", auditSoleOwnerException: true });
    const withOthers = rig({ requesterId: "own", directory: directory({ people: people({ ownerIds: ["own"], eligibleIds: ["own", "max"] }) }) });
    expect(await withOthers.press("own", high)).toEqual({ kind: "refused", reason: "second_person_required" });
  });

  it("an incomplete eligibility read, a gone task and a lost commit race are refused, never approved", async () => {
    const broken = rig({ directory: directory({ people: people({ complete: false }) }) });
    expect(await broken.press("priya", itemOf(facts()))).toEqual({ kind: "refused", reason: "not_ready" });
    const gone = designApproveHandler({ context: async () => undefined, locks: async () => ({}), store: inMemoryDecisionStore(), nowMs: () => NOW, confirmUrl: () => undefined, commit: async () => "done" });
    const item = itemOf(facts());
    expect(await gone.approve(caller("priya"), { card: cardOfItem(item)!.card, item, requestId: "22222222-2222-4222-8222-222222222222" })).toEqual({ kind: "refused", reason: "stale" });
    const raced = rig();
    raced.state.commit = "stale";
    expect(await raced.press("priya", itemOf(facts()))).toEqual({ kind: "refused", reason: "stale" });
    // Another kind of card is not this handler's.
    const requirements: DecisionItem = { ...base, subjectId: "req1", kind: "approve_requirements", claims: 1 };
    const wrongKind = designApproveHandler({ context: async () => undefined, locks: async () => ({}), store: inMemoryDecisionStore(), nowMs: () => NOW, confirmUrl: () => undefined, commit: async () => "done" });
    expect(await wrongKind.approve(caller("priya"), { card: cardOfItem(requirements)!.card, item: requirements, requestId: "22222222-2222-4222-8222-222222222222" })).toEqual({ kind: "refused", reason: "unsupported" });
  });

  it("the reason is in the approve body contract: one plain line, bounded", () => {
    const body = { requestId: "22222222-2222-4222-8222-222222222222", shownDigest: "a".repeat(64) };
    expect(DecisionApproveBodySchema.safeParse({ ...body, reason: "Rollback is covered." }).success).toBe(true);
    expect(DecisionApproveBodySchema.safeParse(body).success).toBe(true);
    for (const bad of ["", "x".repeat(201), "two\nlines", "hidden‮"]) expect(DecisionApproveBodySchema.safeParse({ ...body, reason: bad }).success, JSON.stringify(bad)).toBe(false);
    expect(DecisionApproveBodySchema.safeParse({ ...body, extra: 1 }).success).toBe(false);
  });

  it("the card with an open blocker says a reason goes with the approval and recommends looking first; a clean one stays a plain Approve", () => {
    const withBlocker = cardOfItem(itemOf(blocked))!.card;
    expect(DecisionCardSchema.safeParse(withBlocker).success).toBe(true);
    expect(withBlocker.actions.find((action) => action.kind === "approve")?.label).toBe("Approve with a reason");
    expect(withBlocker.recommended.action).toBe("open");
    const clean = cardOfItem(itemOf(facts()))!.card;
    expect(clean.actions.find((action) => action.kind === "approve")?.label).toBe("Approve");
    expect(clean.recommended.action).toBe("approve");
  });

  it("the version a look is bound to changes with the blockers, so a reason given for one blocker does not carry over to two", () => {
    const one = designContentVersion("v1", blocked);
    const two = designContentVersion("v1", facts({ blockers: [...blocked.blockers, { section: "§6", text: "No migration plan." }] }));
    expect(one).not.toBe(two);
    expect(designContentVersion("v1", blocked)).toBe(one);
    expect(one.length).toBeLessThanOrEqual(100);
    expect(designContentVersion("x".repeat(500), blocked).length).toBeLessThanOrEqual(100);
    const digestOf = (review: DesignCardFacts) => { const item = itemOf(review); return projectDecisionCards([item], { pairFullCards: false }).digests[cardOfItem(item)!.card.id]; };
    expect(digestOf(blocked)).not.toBe(digestOf(facts({ blockers: [...blocked.blockers, { section: "§6", text: "No migration plan." }] })));
  });
});

describe("the spend choice handler (M7)", () => {
  const MODELS = { reviewer: { provider: "anthropic", modelId: "strong" }, planner: { provider: "anthropic", modelId: "strong" } };
  const priced = (usd: number, tier: "light" | "standard" | "thorough" = "standard"): DesignReviewEstimate => ({ kind: "priced", usd, breakdown: { reviewersUsd: usd, mergeUsd: 0, plannerUsd: 0 }, tier, reviewers: 3, rounds: 2 });
  const unpriced = estimateDesignReviewUsd({ tier: "standard", models: MODELS, price: () => undefined, packetTokens: 60_000 });

  function contextOf(change: Partial<DesignSpendContext> = {}): DesignSpendContext {
    return {
      taskId: TASK, requesterId: "priya", tier: "standard", setting: markEffective(DESIGN_REVIEW_DEFAULT_SETTING), taskCapUsd: 10, spentUsd: 0, estimate: priced(40), lowerTier: { tier: "light", estimate: priced(6, "light") },
      reasons: ["new_api"], touches: [], directory: directory(), edition: editionPolicy("enterprise"), freshSignIn: true, browserSession: true, revision: "rev-1",
      card: { subjectId: "dr-spend-1", project: "payments", title: "Partner ranking", createdAt: "2026-11-03T10:00:00.000Z", openPath: `/app/sessions/ses_${"a".repeat(20)}`, contentVersion: "v1" }, ...change,
    };
  }

  function rig(change: Partial<DesignSpendContext> = {}) {
    const store = inMemoryDecisionStore(() => NOW);
    const writes: DesignSpendWrite[] = [];
    const state = { commit: "done" as "done" | "stale", context: contextOf(change) };
    const handle = designSpendChoiceHandler({ context: async () => state.context, locks: async () => ({}), store, now: () => NOW, commit: async (_c, write) => { writes.push(write); return state.commit; } });
    /** The digest this caller would have been shown, and (optionally) the evidence opened for it. */
    async function shown(who: string, open: boolean): Promise<string> {
      const { gate } = designSpendGateFor(state.context, who);
      if (gate.kind !== "ask") throw new Error("expected an ask");
      const item = designSpendItemFor(state.context, gate);
      const projection = projectDecisionCards([item], { pairFullCards: false });
      const cardId = projection.cards[0]!.id;
      const digest = projection.digests[cardId]!;
      if (open) await store.recordEvidenceOpened({ ...caller(who), cardId }, digest, new Date(NOW).toISOString());
      return digest;
    }
    async function choose(who: string, choice: DesignSpendRequest["choice"], options: { open?: boolean; digest?: string; requestId?: string } = {}) {
      const digest = options.digest ?? await shown(who, options.open ?? true);
      return handler(who, { taskId: TASK, choice, requestId: options.requestId ?? "33333333-3333-4333-8333-333333333333", shownDigest: digest });
    }
    const handler = (who: string, request: DesignSpendRequest) => handle(caller(who), request);
    return { choose, shown, writes, state, store, handler };
  }

  it("the requester may run a lower tier; the tier applied is the gate's, not the request's, and the commit is conditional on the task record", async () => {
    const r = rig();
    const result = await r.choose("priya", "lower_tier");
    expect(result).toMatchObject({ kind: "done", choice: "lower_tier", replay: false, applied: { choice: "lower_tier", tier: "light" } });
    expect(r.writes).toEqual([expect.objectContaining({ taskId: TASK, actorId: "priya", revision: "rev-1", applied: { choice: "lower_tier", tier: "light" } })]);
    expect(r.writes[0]!.fence.ExpressionAttributeValues).toEqual({ ":approvalMembershipVersion": 4 });
    expect(r.store.decisions).toEqual([expect.objectContaining({ kind: "approve_spend", outcome: "approved", reason: "lower_tier", developerId: "priya" })]);
  });

  it("raise the cap: the requester only up to the low amount, a maintainer above it, and never above the ceiling", async () => {
    // $40 is over the low amount: the requester is refused, a maintainer may.
    const refused = rig();
    expect(await failure(refused.choose("priya", "raise_cap"))).toEqual({ code: "FORBIDDEN", message: "A project maintainer has to raise the limit this far." });
    expect(refused.writes).toEqual([]);
    const maintainer = rig();
    expect(await maintainer.choose("max", "raise_cap")).toMatchObject({ kind: "done", applied: { choice: "raise_cap", newCapUsd: 40 } });
    // A raise to $8 (cap 5, estimate 8): the requester may.
    const small = rig({ taskCapUsd: 5, estimate: priced(8), lowerTier: undefined });
    expect(await small.choose("priya", "raise_cap")).toMatchObject({ applied: { choice: "raise_cap", newCapUsd: 8 } });
    // The company ceiling: a raise above it is not offered at all, so it cannot be chosen.
    const ceiling = rig({ capCeilingUsd: 20 });
    expect(await failure(ceiling.choose("max", "raise_cap"))).toMatchObject({ code: "CHANGE_STALE" });
    // The pure rule, directly.
    expect(mayChooseDesignSpend({ choice: "raise_cap", callerId: "max", requesterId: "priya", newCapUsd: 40, ceilingUsd: 20, directory: directory() })).toEqual({ ok: false, code: "above_ceiling" });
  });

  it("run unpriced is the requester's alone, and it is bounded by measured spend at the cap (M5)", async () => {
    const r = rig({ estimate: unpriced, lowerTier: undefined, taskCapUsd: 12 });
    expect(await failure(r.choose("max", "run_unpriced"))).toEqual({ code: "FORBIDDEN", message: "Only the person who asked for this task can choose this." });
    expect(r.writes).toEqual([]);
    expect(await r.choose("priya", "run_unpriced")).toMatchObject({ kind: "done", applied: { choice: "run_unpriced", stopAtMeasuredUsd: 12 } });
    expect(r.writes[0]!.applied).toEqual({ choice: "run_unpriced", stopAtMeasuredUsd: 12 });
  });

  it("skip goes through the skip rules for the caller: not allowed when the setting says no, and a high-risk design only by its approver", async () => {
    const noSkip = rig({ setting: markEffective({ ...DESIGN_REVIEW_DEFAULT_SETTING, allowSkip: false }) });
    expect(await failure(noSkip.choose("priya", "skip"))).toEqual({ code: "FORBIDDEN", message: "This project doesn't allow skipping design review." });
    const highRisk = rig({ reasons: ["money"] });
    expect(await failure(highRisk.choose("priya", "skip"))).toEqual({ code: "FORBIDDEN", message: "Only the design approver can skip a high-risk design review." });
    expect(await highRisk.choose("own", "skip")).toMatchObject({ kind: "done", applied: { choice: "skip" } });
    const outsider = rig();
    expect(await failure(outsider.choose("zed", "skip"))).toMatchObject({ code: "FORBIDDEN" });
    expect(await rig().choose("priya", "skip")).toMatchObject({ applied: { choice: "skip" } });
  });

  it("an outsider, an Auditor and a viewer choose nothing", async () => {
    for (const who of ["zed", "aud"]) {
      const r = rig({ directory: directory({ projectMemberIds: ["own", "max", "priya", "aud"], notApproverIds: ["aud"] }) });
      expect(await failure(r.choose(who, "lower_tier")), who).toEqual({ code: "FORBIDDEN", message: "You can't decide this." });
      expect(r.writes).toEqual([]);
    }
  });

  it("friction by tier: a medium card needs the evidence of the digest shown opened; a changed card makes the old digest worthless", async () => {
    const r = rig();
    expect(await failure(r.choose("max", "raise_cap", { open: false }))).toMatchObject({ code: "CHANGE_STALE" });
    expect(await failure(r.choose("max", "raise_cap", { digest: "d".repeat(64) }))).toMatchObject({ code: "CHANGE_STALE" });
    expect(r.writes).toEqual([]);
    // The estimate changed after the person looked: their digest is for the old card.
    const digest = await r.shown("max", true);
    r.state.context = contextOf({ estimate: priced(41) });
    expect(await failure(r.choose("max", "raise_cap", { digest }))).toMatchObject({ code: "CHANGE_STALE" });
    // A low card (estimate within the low amount) needs no evidence but still the digest.
    const low = rig({ taskCapUsd: 5, estimate: priced(8), lowerTier: undefined });
    expect(await low.choose("priya", "raise_cap", { open: false })).toMatchObject({ kind: "done" });
    // A high card (above the admin amount) needs a fresh sign-in: REAUTH_REQUIRED, so the page offers "Sign in again" (slice 1), never a refusal.
    const high = rig({ estimate: priced(250), lowerTier: { tier: "light", estimate: priced(6, "light") }, freshSignIn: false });
    expect(await failure(high.choose("priya", "lower_tier", { open: true }))).toEqual({ code: "REAUTH_REQUIRED", message: DESIGN_CHOICE_REAUTH_MESSAGE });
    expect(high.writes).toEqual([]);
    // A choice this person may not make is refused as such, even with a stale sign-in: REAUTH never hides a refusal (review fix).
    const staleOutsider = rig({ estimate: priced(250), lowerTier: { tier: "light", estimate: priced(6, "light") }, freshSignIn: false, directory: directory({ projectMemberIds: ["own", "max", "priya", "aud"], notApproverIds: ["aud"] }) });
    expect(await failure(staleOutsider.choose("aud", "lower_tier", { open: true }))).toEqual({ code: "FORBIDDEN", message: "You can't decide this." });
    expect(staleOutsider.writes).toEqual([]);
    const fresh = rig({ estimate: priced(250), lowerTier: { tier: "light", estimate: priced(6, "light") }, freshSignIn: true });
    expect(await fresh.choose("priya", "lower_tier", { open: true })).toMatchObject({ kind: "done" });
    // ... and a browser: a token (an AI tool) never decides a high card, as the decisions route refuses high entirely (ON-9).
    const token = rig({ estimate: priced(250), lowerTier: { tier: "light", estimate: priced(6, "light") }, freshSignIn: true, browserSession: false });
    expect(await failure(token.choose("priya", "lower_tier", { open: true }))).toEqual({ code: "FORBIDDEN", message: "Decide this in the Rovara app." });
    expect(token.writes).toEqual([]);
  });

  it("ON-12: skipping a high-risk design review when the approver is a group says so plainly", async () => {
    const r = rig({ reasons: ["money"], setting: markEffective({ ...DESIGN_REVIEW_DEFAULT_SETTING, highRiskApprover: { kind: "group", groupId: "g1" } }) });
    expect(await failure(r.choose("own", "skip"))).toEqual({ code: "FORBIDDEN", message: DESIGN_APPROVER_GROUP_WORDS });
  });

  it("ON-9: running unpriced is tiered by the room left under the cap, not as free: medium needs the evidence opened, and the card says so", async () => {
    const noPrice = { taskCapUsd: 40, spentUsd: 5, estimate: unpriced, lowerTier: undefined };
    const r = rig(noPrice);
    const { gate } = designSpendGateFor(r.state.context, "priya");
    if (gate.kind !== "ask") throw new Error("expected an ask");
    const card = projectDecisionCards([designSpendItemFor(r.state.context, gate)], { pairFullCards: false }).cards[0]!;
    expect(card.risk).toBe("medium");
    expect(await failure(r.choose("priya", "run_unpriced", { open: false }))).toMatchObject({ code: "CHANGE_STALE" });
    expect(r.writes).toEqual([]);
    expect(await r.choose("priya", "run_unpriced", { open: true })).toMatchObject({ kind: "done", applied: { choice: "run_unpriced" } });
    // Within the low amount of room it is a low card and needs none.
    const small = rig({ taskCapUsd: 8, spentUsd: 0, estimate: unpriced, lowerTier: undefined });
    expect(await small.choose("priya", "run_unpriced", { open: false })).toMatchObject({ kind: "done" });
  });

  it("a choice the gate does not offer is refused: a gate that no longer asks, and a lower tier that does not fit", async () => {
    const r = rig();
    r.state.context = contextOf({ taskCapUsd: 50 });
    expect(await failure(r.handler("max", { taskId: TASK, choice: "raise_cap", requestId: "33333333-3333-4333-8333-333333333333", shownDigest: "a".repeat(64) }))).toMatchObject({ code: "CHANGE_STALE" });
    const noLower = rig({ lowerTier: undefined });
    expect(await failure(noLower.choose("priya", "lower_tier"))).toMatchObject({ code: "CHANGE_STALE" });
    const gone = designSpendChoiceHandler({ context: async () => undefined, locks: async () => ({}), store: inMemoryDecisionStore(), now: () => NOW, commit: async () => "done" });
    expect(await failure(gone(caller("priya"), { taskId: TASK, choice: "skip", requestId: "33333333-3333-4333-8333-333333333333", shownDigest: "a".repeat(64) }))).toMatchObject({ code: "NOT_FOUND" });
  });

  it("a replay returns the earlier outcome and writes nothing; the same request id for another choice is refused; a lost race is a conflict", async () => {
    const r = rig();
    await r.choose("priya", "lower_tier");
    const again = await r.handler("priya", { taskId: TASK, choice: "lower_tier", requestId: "33333333-3333-4333-8333-333333333333", shownDigest: "0".repeat(64) });
    expect(again).toMatchObject({ kind: "done", replay: true });
    expect(r.writes).toHaveLength(1);
    expect(await failure(r.handler("priya", { taskId: TASK, choice: "skip", requestId: "33333333-3333-4333-8333-333333333333", shownDigest: "0".repeat(64) }))).toMatchObject({ code: "CONFIG_INVALID" });
    const raced = rig();
    raced.state.commit = "stale";
    expect(await failure(raced.choose("priya", "lower_tier"))).toMatchObject({ code: "CHANGE_STALE" });
    expect(raced.store.decisions).toEqual([]);
  });
});

describe("a no-skip setting and the spend card", () => {
  it("gives no skip choice to a caller the rules refuse, so the card they are shown never offers it", () => {
    const base = { taskId: TASK, requesterId: "priya", tier: "standard" as const, setting: markEffective({ ...DESIGN_REVIEW_DEFAULT_SETTING }), taskCapUsd: 10, spentUsd: 0, estimate: { kind: "priced", usd: 40, breakdown: { reviewersUsd: 40, mergeUsd: 0, plannerUsd: 0 }, tier: "standard", reviewers: 3, rounds: 2 } as DesignReviewEstimate, reasons: ["money" as const], touches: [], directory: directory(), edition: editionPolicy("enterprise"), freshSignIn: true, revision: "r", card: { subjectId: "s1", project: "p", title: "t", createdAt: "2026-11-03T10:00:00.000Z", openPath: `/app/sessions/ses_${"a".repeat(20)}`, contentVersion: "v1" } };
    const forRequester = designSpendGateFor(base, "priya").gate;
    const forApprover = designSpendGateFor(base, "own").gate;
    expect(forRequester.kind === "ask" && forRequester.choices.map((c) => c.choice)).toEqual(["raise_cap"]);
    expect(forApprover.kind === "ask" && forApprover.choices.map((c) => c.choice)).toEqual(["raise_cap", "skip"]);
  });
});


describe("money fix round 2: the reason on the Proof line is inert", () => {
  it("N11: @mentions, links, issue references and markup in an approver's reason do not survive on the Proof line", () => {
    const hostile = "@everyone fixes #123, see [here](http://evil.example/x) and ![i](http://evil.example/i.png) <!-- hide --> https://evil.example/y &#x40;admin";
    const line = designApprovalProofLine(1, hostile)!;
    expect(line).toBe(openBlockerWords(1, hostile));
    expect(line).toContain("Design approved with 1 open blocker: ");
    expect(line).not.toMatch(/@(?!\u200d)/u);
    expect(line).not.toContain("](");
    expect(line).not.toContain("<!--");
    expect(line).not.toContain("://evil");
    expect(line).not.toMatch(/#(?=\d)/u);
    // control: an ordinary reason reads as it was written
    expect(designApprovalProofLine(2, "The rollback is tracked in the follow-up.")).toBe("Design approved with 2 open blockers: The rollback is tracked in the follow-up.");
  });
});
