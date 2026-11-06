// Proof and evidence D1 (contract): one card holds one decision; the risk tier decides the friction; a high card has no approve action; nothing is bulk-approved; a lock only raises a tier.
import { describe, expect, it } from "vitest";
import * as cards from "../../packages/contracts/src/decision-cards.js";
import { HOME_CARD_KINDS } from "../../packages/contracts/src/home.js";

const at = "2026-10-30T12:00:00.000Z";
const action = (kind: cards.DecisionActionKind) => ({ kind, label: kind === "approve" ? "Approve" : kind === "reject" ? "Reject" : "Open to decide", href: `/v1/app/tasks/8b579b4b-eaa7-4bf2-87bc-6da86b97c9e6/${kind}`, method: kind === "open" ? "GET" : "POST" });
const card = (overrides: Record<string, unknown> = {}) => ({
  id: "approve_plan:8b579b4b-eaa7-4bf2-87bc-6da86b97c9e6", kind: "approve_plan", taskId: "8b579b4b-eaa7-4bf2-87bc-6da86b97c9e6", project: "payments",
  title: "Approve the plan for partner scoring", question: "Build this plan?",
  recommended: { action: "approve", why: "Every requirement has a planned proof." },
  next: { text: "Builds in about 25 minutes, about $2.10, then opens a pull request.", costUsd: 2.1, minutes: 25 },
  evidence: [{ kind: "risk", label: "Risk", value: "low", state: "good" }],
  risk: "low", riskReasons: [], friction: { expandEvidenceFirst: false, freshSignIn: false, secondPerson: false },
  actions: [action("approve"), action("reject")], rejectReasons: ["wrong_problem", "too_big", "not_now"], status: "pending", createdAt: at,
  ...overrides,
});
const medium = (overrides: Record<string, unknown> = {}) => card({ risk: "medium", riskReasons: ["touches a migration"], friction: cards.decisionFriction("medium"), ...overrides });
const high = (overrides: Record<string, unknown> = {}) => card({ risk: "high", riskReasons: ["touches IAM"], friction: cards.decisionFriction("high"), actions: [action("open"), action("reject")], recommended: { action: "open", why: "A person decides on the full page." }, ...overrides });
const ok = (value: unknown) => cards.DecisionCardSchema.safeParse(value).success;

describe("decision card", () => {
  it("accepts a low, a medium and a high card and round-trips them", () => {
    for (const value of [card(), medium(), high()]) expect(cards.DecisionCardSchema.parse(value)).toEqual(value);
  });
  it("covers every touchpoint of the design's table, 15 kinds, the Fix setup card, the setup host card and the second-review notice card, each with a floor tier", () => {
    expect([...cards.DECISION_KINDS]).toEqual(["approve_plan", "approve_requirements", "approve_design", "merge", "answer_question", "choose_checks", "approve_dependency", "approve_e2e_plan", "review_feedback", "autofix_ask", "approve_setting", "approve_spend", "approve_test_env", "confirm_env_change", "spec_choice", "fix_setup", "setup_host", "second_review_notice", "approve_fixture_set", "approve_request"]);
    // Slice 3b: an outside approval (apr_, spr_) decided on its card, always with a recent sign-in.
    expect(cards.DECISION_KIND_FLOOR_RISK.approve_request).toBe("high");
    expect(cards.DECISION_KIND_FLOOR_RISK.fix_setup).toBe("medium");
    expect(cards.DECISION_KIND_FLOOR_RISK.setup_host).toBe("medium");
    expect(cards.DECISION_KIND_FLOOR_RISK.second_review_notice).toBe("low");
    expect(cards.DECISION_KIND_FLOOR_RISK.approve_fixture_set).toBe("medium");
    expect(Object.keys(cards.DECISION_KIND_FLOOR_RISK).sort()).toEqual([...cards.DECISION_KINDS].sort());
    expect(cards.DECISION_KIND_FLOOR_RISK.approve_setting).toBe("high");
  });
  it("has an id that is `<kind>:<subject>` and starts with its own kind", () => {
    expect(ok(card({ id: "merge:abc" }))).toBe(false);
    expect(ok(card({ id: "approve_plan" }))).toBe(false);
    expect(ok(card({ id: "bogus:abc", kind: "approve_plan" }))).toBe(false);
    expect(cards.DecisionCardIdSchema.safeParse("merge:abc_1-2").success).toBe(true);
  });
  it("is strict: no bulk field, no unknown field", () => {
    for (const extra of [{ bulk: true }, { bulkApprove: true }, { approvedBy: "x" }]) expect(ok(card(extra))).toBe(false);
    expect(cards.DecisionCardsResponseSchema.safeParse({ cards: [], total: 0, bulk: true }).success).toBe(false);
  });
  it("makes friction follow the tier: low one tap, medium evidence first, high fresh sign-in", () => {
    expect(cards.decisionFriction("low")).toEqual({ expandEvidenceFirst: false, freshSignIn: false, secondPerson: false });
    expect(cards.decisionFriction("medium")).toEqual({ expandEvidenceFirst: true, freshSignIn: false, secondPerson: false });
    expect(cards.decisionFriction("high")).toEqual({ expandEvidenceFirst: true, freshSignIn: true, secondPerson: false });
    expect(cards.decisionFriction("high", true).secondPerson).toBe(true);
    expect(cards.decisionFriction("medium", true).secondPerson).toBe(false);
    expect(ok(medium({ friction: cards.decisionFriction("low") }))).toBe(false);
    expect(ok(high({ friction: cards.decisionFriction("medium") }))).toBe(false);
    expect(ok(card({ friction: cards.decisionFriction("medium") }))).toBe(false);
    expect(ok(high({ friction: cards.decisionFriction("high", true) }))).toBe(true);
    expect(ok(medium({ friction: { ...cards.decisionFriction("medium"), secondPerson: true } }))).toBe(false);
  });
  it("gives a high-risk card no approve action: it can only open the full page or reject", () => {
    expect(ok(high({ actions: [action("approve"), action("reject")], recommended: { action: "approve", why: "x" } }))).toBe(false);
    expect(ok(high())).toBe(true);
  });
  it("has at most one approve action, at most four actions, and a recommended action it offers", () => {
    expect(ok(card({ actions: [action("approve"), action("approve")] }))).toBe(false);
    expect(ok(card({ actions: [action("approve"), action("reject"), action("open"), action("answer"), action("choose")] }))).toBe(false);
    expect(ok(card({ recommended: { action: "choose", why: "x" } }))).toBe(false);
  });
  it("needs reject reasons when a card can be rejected, with fixed words and no repeats", () => {
    expect(ok(card({ rejectReasons: [] }))).toBe(false);
    expect(ok(card({ rejectReasons: ["wrong_problem", "wrong_problem"] }))).toBe(false);
    expect(ok(card({ rejectReasons: ["because I said so"] }))).toBe(false);
    expect([...cards.DECISION_REJECT_REASONS]).toEqual(["wrong_problem", "wrong_approach", "too_big", "missing_test", "not_now", "other"]);
  });
  it("is never answered by a rule when high, and answeredByRule matches the status", () => {
    const rule = { ruleId: "auto-docs", at };
    expect(ok(card({ status: "answered_by_rule", answeredByRule: rule, actions: [] }))).toBe(true);
    expect(ok(high({ status: "answered_by_rule", answeredByRule: rule, actions: [] }))).toBe(false);
    expect(ok(card({ answeredByRule: rule }))).toBe(false);
    expect(ok(card({ status: "answered_by_rule", actions: [] }))).toBe(false);
  });
  it("keeps an answered card free of actions", () => {
    expect(ok(card({ status: "approved", actions: [] }))).toBe(true);
    expect(ok(card({ status: "approved" }))).toBe(false);
  });
  it("takes a thumbnail chip only with a Rovara route, and no other chip with one", () => {
    const chip = (extra: Record<string, unknown>) => ({ kind: "thumbnail", label: "After", value: "login page", state: "good", ...extra });
    expect(ok(card({ evidence: [chip({ href: "/v1/app/tasks/t/evidence/abc" })] }))).toBe(true);
    expect(ok(card({ evidence: [chip({})] }))).toBe(false);
    expect(ok(card({ evidence: [{ kind: "risk", label: "R", value: "low", state: "good", href: "/v1/app/x" }] }))).toBe(false);
    expect(ok(card({ evidence: [chip({ href: "https://evil.example/x.png" })] }))).toBe(false);
    expect(ok(card({ evidence: Array.from({ length: 7 }, () => ({ kind: "risk", label: "R", value: "low", state: "good" })) }))).toBe(false);
  });
  it("takes only a path of this server as an action's href: no absolute, protocol-relative, backslash, dot-segment or credential form", () => {
    const bad = ["https://app.example.com/v1/app/x", "http://app.example.com/v1/app/x", "javascript:alert(1)", "//evil.example", "/\\evil.example/x", "/v1/app/..\\evil", "/v1/app/../admin", "/v1/app//x", "/v1/app/./x", "/admin/x", "/v1/app/x y", "/v1/app/x@evil.example", "/v1/app/x:80", "data:text/html,x", "ftp://x", "/v1/app/x?a=<b>", "/app/x#frag", ""];
    for (const href of bad) expect(ok(card({ actions: [{ ...action("approve"), href }, action("reject")] })), href).toBe(false);
    for (const href of ["/v1/app/tasks/8b579b4b/approve", "/app/projects/web/setup", "/app/review/x?tab=evidence&a=1"]) expect(ok(card({ actions: [{ ...action("approve"), href }, action("reject")] })), href).toBe(true);
  });
  it("makes every action but open a POST: an approve, reject, answer or choose by GET is refused", () => {
    for (const kind of ["approve", "reject", "answer", "choose"] as const) {
      expect(ok(card({ actions: [{ ...action(kind), method: "GET" }, ...(kind === "approve" ? [action("reject")] : [action("approve")])], recommended: { action: kind, why: "x" } })), kind).toBe(false);
    }
    expect(ok(high({ actions: [{ ...action("open"), method: "GET" }, action("reject")] }))).toBe(true);
    expect(ok(high({ actions: [{ ...action("open"), method: "POST" }, action("reject")] }))).toBe(true);
  });
  it("keeps each kind at or above its floor tier: a setting change cannot be a one-tap card", () => {
    for (const kind of cards.DECISION_KINDS) {
      const floor = cards.DECISION_KIND_FLOOR_RISK[kind];
      const at = (risk: cards.DecisionRisk) => ({ ...(risk === "low" ? card() : risk === "medium" ? medium() : high()), kind, id: `${kind}:x` });
      expect(ok(at(floor)), `${kind} at its floor`).toBe(true);
      expect(ok(at("high")), `${kind} high`).toBe(true);
      if (floor !== "low") expect(ok(at("low")), `${kind} below its floor`).toBe(false);
      if (floor === "high") expect(ok(at("medium")), `${kind} medium`).toBe(false);
    }
    expect(ok({ ...card(), kind: "approve_setting", id: "approve_setting:x" })).toBe(false);
  });
  it("refuses texts with hidden characters and over-long texts", () => {
    expect(ok(card({ title: "a\nb" }))).toBe(false);
    expect(ok(card({ title: "x".repeat(81) }))).toBe(false);
    expect(ok(card({ question: "x".repeat(161) }))).toBe(false);
    expect(ok(card({ riskReasons: Array.from({ length: 6 }, () => "r") }))).toBe(false);
  });
  it("reads forward-compatibly: an unknown kind or field in a newer server's card does not break an older client", () => {
    const read = cards.DecisionCardReaderSchema.parse({ ...card(), kind: "approve_something_new", id: "approve_plan:x", extra: 1 }) as Record<string, unknown>;
    expect(read["kind"]).toBe("unknown");
    expect(read["extra"]).toBe(1);
  });
});

describe("risk tiers", () => {
  it("only rise: a lock or a finding can raise a card's tier and nothing lowers it", () => {
    expect(cards.raiseRisk("low", "medium")).toBe("medium");
    expect(cards.raiseRisk("high", "low", "medium")).toBe("high");
    expect(cards.raiseRisk("medium", "low")).toBe("medium");
    expect(cards.raiseRisk()).toBe("low");
  });
});

describe("card routes' bodies", () => {
  it("take a request id and a fixed reject reason, and no bulk shape exists", () => {
    const id = "8b579b4b-eaa7-4bf2-87bc-6da86b97c9e6";
    expect(cards.DecisionEvidenceOpenedBodySchema.safeParse({ requestId: id }).success).toBe(true);
    expect(cards.DecisionRejectBodySchema.safeParse({ requestId: id, reason: "too_big" }).success).toBe(true);
    expect(cards.DecisionRejectBodySchema.safeParse({ requestId: id, reason: "free text" }).success).toBe(false);
    expect(cards.DecisionRejectBodySchema.safeParse({ requestId: id, reason: "too_big", cardIds: ["a", "b"] }).success).toBe(false);
    expect(Object.keys(cards).filter((name) => /bulk/i.test(name))).toEqual([]);
  });
});

describe("relation to Home cards", () => {
  it("does not reuse Home's kind names, so one card id never reads as the other", () => {
    for (const kind of cards.DECISION_KINDS) expect((HOME_CARD_KINDS as readonly string[]).includes(kind)).toBe(false);
  });
});
