// Design review stage, DR7 slice C: the guards the routes and ports add, each with a test that fails without it. The routes themselves are driven end to end in tests/contract/design-review-e2e.test.ts.
import { describe, expect, it, vi } from "vitest";
import { type WorkflowSnapshot } from "../../packages/contracts/src/index.js";
import { commitDesignApproval, designApprovalItems, designDigestOfVersion, membershipFenceItem } from "../../packages/broker/src/aws/developer-tasks/design-decision.js";
import { designApproveHandler, type DesignApprovalWrite } from "../../packages/broker/src/design-review/approve-handler.js";
import { designClassificationNoteOf } from "../../packages/broker/src/design-review/mode.js";
import { spendEstimatesOf } from "../../packages/broker/src/design-review/spend-estimates.js";
import { readDesignTouches } from "../../packages/broker/src/design-review/route-facts.js";
import { parseDesignFirstPrefix } from "../../packages/broker/src/rovara-code/explicit-path.js";
import { designFirstRequestOf } from "../../packages/broker/src/design-review/design-first.js";
import { parseWorkflowStartRequest } from "../../packages/broker/src/aws/slack-workflow-choice.js";
import { dynamoDecisionStore } from "../../packages/broker/src/decisions/store.js";
import { routeDecisionCards, type DecisionRouteDependencies } from "../../packages/broker/src/decisions/routes.js";
import { secondPersonMembershipCondition } from "../../packages/broker/src/org/second-person-approval.js";
import { createHash } from "node:crypto";
import { TEST_ORG } from "../support/orgs.js";
import { capturingAuditDeps } from "../support/audit-capture.js";

const ORG = TEST_ORG;
const write = (extra: Partial<DesignApprovalWrite> = {}): DesignApprovalWrite => ({
  subjectId: "t", taskId: "11111111-1111-4111-8111-111111111111", requestId: "22222222-2222-4222-8222-222222222222", tab: undefined, approverId: "a".repeat(64), requesterId: "b".repeat(64), tier: "high", mode: "high_risk_approver",
  openBlockers: 1, proofReason: "Reviewed with the team.", proofLine: "Design approved with 1 open blocker: Reviewed with the team.", auditSoleOwnerException: false, fence: secondPersonMembershipCondition(3), contentVersion: `${"c".repeat(64)}:b1:abc`, ...extra,
});
const deps = { tableName: "state", orgId: ORG, learningAudit: capturingAuditDeps().audit };

describe("the approval's transaction items", () => {
  it("stores the approval under the design's digest with the approver's words as data, and pins the membership generation", () => {
    const { items } = designApprovalItems(deps, { taskId: write().taskId!, digest: "c".repeat(64), write: write(), approver: { developerId: "a".repeat(64), name: "Omar" }, now: "2026-11-03T12:00:00.000Z" });
    expect(items[0]).toMatchObject({ Put: { Item: { sk: `DESIGN_APPROVAL#${"c".repeat(64)}`, approverLabel: "Omar", tier: "high", openBlockers: 1, proofReason: "Reviewed with the team." } } });
    expect((items[0] as unknown as { Put: { Item: { proofLine: string } } }).Put.Item.proofLine).toContain("open blocker");
    expect(items[1]).toMatchObject({ ConditionCheck: { ExpressionAttributeValues: { ":approvalMembershipVersion": 3 } } });
    expect(JSON.stringify(items[1])).toContain("approvalMembershipVersion = :approvalMembershipVersion");
    expect(items).toHaveLength(2);
  });

  it("audits the sole-owner exception when it was one, and only then", () => {
    const base = { taskId: write().taskId!, digest: "c".repeat(64), approver: { developerId: "a".repeat(64), name: "Maya" }, now: "2026-11-03T12:00:00.000Z" };
    const exception = designApprovalItems(deps, { ...base, write: write({ auditSoleOwnerException: true, mode: "sole_owner_exception" }) });
    expect(exception.auditEvent).toMatchObject({ action: "task.design_sole_owner_exception", facts: { tier: "high", openBlockers: 1 }, target: { kind: "task", id: write().taskId } });
    expect(exception.items).toHaveLength(3);
    expect(designApprovalItems(deps, { ...base, write: write() }).auditEvent).toBeUndefined();
  });

  it("a company with no membership counter yet is pinned as having none, not as version 0 (which would refuse every approval)", () => {
    const item = membershipFenceItem("state", ORG, secondPersonMembershipCondition(0));
    expect(JSON.stringify(item)).toContain("attribute_not_exists(approvalMembershipVersion)");
    expect(JSON.stringify(membershipFenceItem("state", ORG, secondPersonMembershipCondition(2)))).not.toContain("attribute_not_exists(approvalMembershipVersion)");
  });

  it("is conditional on the design shown: another latest design, or a task not waiting on its design, is stale and decides nothing", async () => {
    const workflow = (design: string, stage = "PLAN_REVIEW"): WorkflowSnapshot => ({ stage, state: "WAITING", reviewPhase: "DESIGN", designReview: { rounds: [] }, artifacts: [{ type: "design", sha256: design }], revision: 1 } as never);
    const send = vi.fn(async () => ({ Item: { orgId: ORG, taskId: write().taskId, workflow: workflow("d".repeat(64)) } }));
    const taskDeps = { documentClient: { send }, tableName: "state", orgId: ORG, now: () => 1 } as never;
    expect(await commitDesignApproval(taskDeps, { developerId: "o".repeat(64) } as never, { developerId: "a".repeat(64), name: "A" }, write())).toBe("stale");
    // Only the read happened: nothing was decided.
    expect(send).toHaveBeenCalledTimes(1);
    expect(designDigestOfVersion(write().contentVersion)).toBe("c".repeat(64));
  });
});

describe("the approve handler's friction needs the route to pass what was shown", () => {
  it("the decisions route hands the card and the digest the person was shown to the performer", async () => {
    const approve = vi.fn(async () => ({ kind: "done" as const }));
    const item = { kind: "approve_design" as const, subjectId: "11111111-1111-4111-8111-111111111111", taskId: "11111111-1111-4111-8111-111111111111", project: "payments", title: "T", createdAt: "2026-11-03T12:00:00.000Z", openPath: "/app/x", contentVersion: "c".repeat(64), files: ["demo"] };
    const store = { findDecision: async () => undefined, recordDecision: async () => undefined, evidenceOpenedAt: async () => "2026-11-03T12:00:00.000Z", recordEvidenceOpened: async () => undefined };
    const routeDeps = { sources: { list: async () => [item], locks: async () => ({}) }, performer: { approve, reject: async () => ({ kind: "done" as const }) }, store, now: () => Date.parse("2026-11-03T12:01:00.000Z") } as unknown as DecisionRouteDependencies;
    const caller = { orgId: ORG, developerId: "a".repeat(64) };
    const list = await routeDecisionCards(routeDeps, caller, { method: "GET", pathname: "/v1/app/decisions", searchParams: new URLSearchParams(), body: undefined });
    const view = list!.body as { cards: Array<{ id: string }>; digests: Record<string, string> };
    const cardId = view.cards[0]!.id;
    await routeDecisionCards(routeDeps, caller, { method: "POST", pathname: `/v1/app/decisions/${cardId.replace(":", "/")}/approve`, searchParams: new URLSearchParams(), body: { requestId: "22222222-2222-4222-8222-222222222222", shownDigest: view.digests[cardId] } });
    expect(approve).toHaveBeenCalledWith(caller, expect.objectContaining({ shown: { cardId, digest: view.digests[cardId] } }));
    void designApproveHandler;
  });

  it("the decision store gives back the choice word a spend decision was recorded with (a repeat is recognised by it)", async () => {
    const items = new Map<string, Record<string, unknown>>();
    const client = { send: async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
      if (command.constructor.name === "PutCommand") { const item = command.input.Item as Record<string, unknown>; items.set(`${String(item.pk)}|${String(item.sk)}`, item); return {}; }
      const key = command.input.Key as Record<string, string>;
      return { Item: items.get(`${key.pk}|${key.sk}`) };
    } };
    const store = dynamoDecisionStore({ documentClient: client, tableName: "state", now: () => 1_700_000_000_000 });
    const who = { orgId: ORG, developerId: "a".repeat(64) };
    await store.recordDecision({ ...who, cardId: "approve_spend:t", kind: "approve_spend", risk: "low", outcome: "approved", reason: "raise_cap", requestId: "22222222-2222-4222-8222-222222222222", createdAt: "x", decidedAt: "y" });
    expect(await store.findDecision(who, "22222222-2222-4222-8222-222222222222")).toMatchObject({ reason: "raise_cap" });
  });
});

describe("the cost card's estimates", () => {
  const price = () => ({ inputUsdPerMTok: 3, outputUsdPerMTok: 15 });
  const model = { provider: "anthropic", modelId: "m" } as never;
  it("works the lower tier out at the packet size the hold was worked out for", () => {
    const { estimateDesignReviewUsd } = require_estimate();
    const held = estimateDesignReviewUsd({ tier: "standard", models: { reviewer: model, merge: model, planner: model }, price, packetTokens: 80_000, rounds: 2 });
    const usd = held.kind === "priced" ? held.usd : 0;
    const out = spendEstimatesOf({ review: { tier: "standard", estimateUsd: usd, rounds: [] }, reviewerModel: model, plannerModel: model, price });
    const lower = estimateDesignReviewUsd({ tier: "light", models: { reviewer: model, merge: model, planner: model }, price, packetTokens: 80_000, rounds: 2 });
    expect(out.lowerTier?.tier).toBe("light");
    expect(out.lowerTier?.estimate.kind === "priced" ? out.lowerTier.estimate.usd : 0).toBeCloseTo(lower.kind === "priced" ? lower.usd : -1, 1);
  });
  it("is cost unavailable with no stored estimate, and offers no lower tier with no price", () => {
    expect(spendEstimatesOf({ review: { tier: "standard", estimateUsd: undefined, rounds: [] }, reviewerModel: model, plannerModel: model, price }).estimate.kind).toBe("unavailable");
    expect(spendEstimatesOf({ review: { tier: "standard", estimateUsd: 2, rounds: [] }, reviewerModel: model, plannerModel: model, price: () => undefined }).lowerTier).toBeUndefined();
  });
});
// The estimate function, loaded once (a top-level import would reorder the module graph above).
import { estimateDesignReviewUsd } from "../../packages/broker/src/design-review/estimate.js";
function require_estimate() { return { estimateDesignReviewUsd }; }

describe("every design version's areas count", () => {
  const meta = (touches: string[]) => `# Design\n## §1 Problem and goal\nx\n\`\`\`rovara-design-meta\n${JSON.stringify({ touches, repositories: [], services: [], sources: [] })}\n\`\`\``;
  it("takes the union of the touches of all versions, so a rewrite cannot lower the risk, and ignores a version it cannot read", async () => {
    const texts = new Map([["k1", meta(["auth"])], ["k2", meta(["new_api"])], ["k3", "# Design without a block"]]);
    const artifacts = [["k1", "a"], ["k2", "b"], ["k3", "c"]].map(([key, id], index) => ({ id: id!, type: "design", version: index + 1, sha256: createHash("sha256").update(texts.get(key!)!, "utf8").digest("hex"), producer: "p", objectKey: key!, createdAt: "x", format: "markdown" }));
    const touches = await readDesignTouches({ artifacts } as never, async (key) => texts.get(key));
    expect(touches.sort()).toEqual(["auth", "new_api"]);
  });
});

describe("the intake and the first card", () => {
  it("reads `design first:` before a path or alone, and leaves every other request as it was", () => {
    expect(parseDesignFirstPrefix("Design first: add a retry")).toEqual({ designFirst: true, rest: "add a retry" });
    expect(parseDesignFirstPrefix("  design-first : x").designFirst).toBe(true);
    expect(parseDesignFirstPrefix("quick: design first notes")).toEqual({ designFirst: false, rest: "quick: design first notes" });
    // The Slack ingress cannot know whether the stage runs for the project, so it never reads the prefix (the broker does, `designFirstRequestOf`): the text is exactly what was typed.
    expect(parseWorkflowStartRequest("design first: quick: add a retry")).toEqual({ kind: "start", instructions: "design first: quick: add a retry" });
    expect(parseWorkflowStartRequest("quick: add a retry")).toEqual({ kind: "start", path: "QUICK", instructions: "add a retry" });
    expect(parseWorkflowStartRequest("design first: chat: hello").kind).toBe("start");
    const on = { DESIGN_REVIEW_ENABLED: "1", DESIGN_REVIEW_PROJECTS: "payments:web" };
    expect(designFirstRequestOf("payments", "Design first: add a retry", on)).toEqual({ designFirst: true, rest: "add a retry" });
    expect(designFirstRequestOf("other", "Design first: add a retry", on)).toEqual({ designFirst: false, rest: "Design first: add a retry" });
    expect(designFirstRequestOf("payments", "Design first: add a retry", { ...on, DESIGN_REVIEW_ENABLED: "0" })).toEqual({ designFirst: false, rest: "Design first: add a retry" });
  });

  it("ON-2: the model's note on the classification line is made inert for Slack and Linear threads: no @channel, no link, no mention, no tag", () => {
    const review = (note: string) => ({ stage: "PLAN_REVIEW", state: "WAITING", reviewPhase: "REQUIREMENTS", decisions: [], designReview: { decidedBy: "auto", reasons: ["auth"], status: "estimating", tier: "standard", spentUsd: 0, rounds: [], note } }) as never;
    // The reviewer's probe payloads: the first is the one that went through raw.
    for (const note of [
      "see <!channel> <https://evil.example|click> & <@U12345>", "<!here> <!subteam^S123> please", "[click me](https://evil.example/x) ![img](https://evil.example/p.png)", "<script>alert(1)</script> @everyone @here mail <mailto:a@b.example>",
      "https://evil.example/phish www.evil.example #123 GH-77 Fixes ENG-1", "a > b < c &amp; &lt;!channel&gt;",
    ]) {
      const line = designClassificationNoteOf(review(note))!;
      expect(line, note).toContain("Note from Rovara:");
      expect(line, note).not.toMatch(/<|>/u);
      expect(line, note).not.toMatch(/<!|<@|<https?:|\]\(|!\[/u);
      expect(line, note).not.toMatch(/@\w/u);
      // A scheme is broken up (a joiner or a space after the slashes), so no autolink forms.
      expect(line, note).not.toMatch(/https?:\/\/[^\s\u200d]/u);
      expect(line, note).not.toMatch(/\bwww\.[a-z]/iu);
    }
    // The words around the note are unchanged for a plain note.
    expect(designClassificationNoteOf(review("A bug fix in one module."))).toContain("Note from Rovara: A bug fix in one module.");
  });

  it("says why the design is reviewed on the first card of a reviewed task, and nothing for a task with no review or on a later card", () => {
    const review = { decidedBy: "person", reasons: ["auth"], status: "estimating", tier: "standard", spentUsd: 0, rounds: [] };
    const first = { stage: "PLAN_REVIEW", state: "WAITING", reviewPhase: "REQUIREMENTS", decisions: [], designReview: review } as never;
    expect(designClassificationNoteOf(first)).toContain("you asked for design first");
    expect(designClassificationNoteOf({ ...first as object, designReview: undefined } as never)).toBeUndefined();
    expect(designClassificationNoteOf({ ...first as object, decisions: [{}] } as never)).toBeUndefined();
  });
});
