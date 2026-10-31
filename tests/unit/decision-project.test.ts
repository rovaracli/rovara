// Decisions D1: the pure card projector and the deterministic risk tiers. Every touchpoint row of the design becomes a card; tiers only go up; friction follows the tier; links are same-origin.
import { describe, expect, it } from "vitest";
import { DecisionCardSchema, DecisionTabsSchema, DECISION_KIND_FLOOR_RISK, DECISION_KINDS, type DecisionKind, type DecisionRisk } from "@agentx/contracts";
import { projectDecisionCards, cardOfItem, decisionCardPath, type DecisionItem, type ItemBase } from "../../packages/broker/src/decisions/project.js";
import { isInfraPath, riskTierOf } from "../../packages/broker/src/decisions/risk-tier.js";
import { isSafeRelativePath } from "../../packages/broker/src/decisions/text.js";

const TASK = "11111111-1111-4111-8111-111111111111";
const base = (id: string, extra: Partial<ItemBase> = {}): ItemBase => ({ subjectId: id, taskId: TASK, project: "payments", title: "Retry failed payments", createdAt: "2026-10-30T10:00:00.000Z", openPath: `/app/sessions/ses_${"a".repeat(20)}`, ...extra });
const proof = { proven: 3, passed: 1, failed: 0, notTested: 0 };

const ITEMS: Record<DecisionKind, DecisionItem> = {
  approve_plan: { ...base("plan1"), kind: "approve_plan", path: "quick", files: ["src/retry.ts"], claims: 3, untestedClaims: 0, cost: { lowUsd: 1.2, highUsd: 3.1, minutes: { low: 12, high: 25 } } },
  approve_requirements: { ...base("req1"), kind: "approve_requirements", claims: 4 },
  approve_design: { ...base("des1"), kind: "approve_design", files: ["src/retry.ts"] },
  merge: { ...base("pr1"), kind: "merge", prRisk: "low", prReasons: [], proof, reviewVerdict: "approved", ci: "passing", securityFindingsHigh: 0, fullSuitePending: false },
  answer_question: { ...base("q1"), kind: "answer_question", question: "Which gateway do refunds use?", index: 1, of: 2 },
  choose_checks: { ...base("ck1"), kind: "choose_checks", defaultLabels: ["unit"] },
  approve_dependency: { ...base("dep1"), kind: "approve_dependency", packages: 1, newInstallScripts: false },
  approve_e2e_plan: { ...base("e2e1"), kind: "approve_e2e_plan", scenarios: 3, usesAiNavigation: false },
  review_feedback: { ...base("fb1"), kind: "review_feedback", comments: 2, touchesSensitivePaths: false },
  autofix_ask: { ...base("af1"), kind: "autofix_ask", reasonWords: "the same check failed twice", attempts: 2 },
  approve_setting: { ...base("set1"), kind: "approve_setting", settingLabel: "Allow video capture", secondPerson: true },
  approve_spend: { ...base("spr1"), kind: "approve_spend", amountUsd: 5, scopeLabel: "this task" },
  approve_test_env: { ...base("env1"), kind: "approve_test_env", risk: "medium", riskReasons: [], tier: "sandbox" },
  confirm_env_change: { ...base("chg1"), kind: "confirm_env_change", what: "accounts" },
};
const DEFAULT_RISK: Record<DecisionKind, DecisionRisk> = {
  approve_plan: "low", approve_requirements: "low", approve_design: "low", merge: "low", answer_question: "low", choose_checks: "low", approve_dependency: "medium", approve_e2e_plan: "medium",
  review_feedback: "low", autofix_ask: "medium", approve_setting: "high", approve_spend: "low", approve_test_env: "medium", confirm_env_change: "medium",
};
const cardOf = (item: DecisionItem, locks = {}) => {
  const result = cardOfItem(item, locks);
  if (result === undefined) throw new Error("no card");
  return result.card;
};

describe("every touchpoint becomes a card", () => {
  for (const kind of DECISION_KINDS) {
    it(`${kind}: valid card, default tier ${DEFAULT_RISK[kind]}, id and friction as the tier says`, () => {
      const card = cardOf(ITEMS[kind]);
      expect(DecisionCardSchema.safeParse(card).success).toBe(true);
      expect(card.kind).toBe(kind);
      expect(card.id).toBe(`${kind}:${ITEMS[kind].subjectId}`);
      expect(card.risk).toBe(DEFAULT_RISK[kind]);
      expect(card.status).toBe("pending");
      expect(card.friction.expandEvidenceFirst).toBe(card.risk !== "low");
      expect(card.friction.freshSignIn).toBe(card.risk === "high");
    });
  }
  it("projects them all in one pass without dropping any", () => {
    const projection = projectDecisionCards(Object.values(ITEMS));
    expect(projection.dropped).toBe(0);
    expect(projection.cards).toHaveLength(DECISION_KINDS.length - 1); // requirements + design of one task are one card
  });
});

describe("risk tiers are deterministic and only go up", () => {
  it("never starts a kind below its floor, even for the smallest input", () => {
    const rank = { low: 0, medium: 1, high: 2 };
    for (const kind of DECISION_KINDS) expect(rank[cardOf(ITEMS[kind]).risk]).toBeGreaterThanOrEqual(rank[DECISION_KIND_FLOOR_RISK[kind]]);
    expect(cardOf(ITEMS.approve_setting).risk).toBe("high");
    expect(cardOf({ ...ITEMS.approve_setting, secondPerson: false } as DecisionItem).risk).toBe("high");
    expect(riskTierOf("approve_setting", {}).risk).toBe("high");
  });
  it("raises a plan that touches infrastructure to high and a sensitive path or an unproven claim to medium", () => {
    const plan = ITEMS.approve_plan as Extract<DecisionItem, { kind: "approve_plan" }>;
    expect(cardOf({ ...plan, files: ["infra/stack.ts"] }).risk).toBe("high");
    expect(cardOf({ ...plan, files: ["db/migrations/001.sql"] }).risk).toBe("high");
    expect(cardOf({ ...plan, files: ["src/auth/login.ts"] }).risk).toBe("medium");
    expect(cardOf({ ...plan, untestedClaims: 1 }).risk).toBe("medium");
    expect(cardOf({ ...plan, cost: { highUsd: 30 } }).risk).toBe("medium");
    expect(cardOf({ ...plan, cost: { highUsd: 150 } }).risk).toBe("high");
    expect(cardOf({ ...plan, files: Array.from({ length: 26 }, (_, i) => `src/f${String(i)}.ts`) }).risk).toBe("medium");
  });
  it("takes a merge's tier from the pull request, then raises it for failures, untested requirements, high findings and a pending full suite", () => {
    const merge = ITEMS.merge as Extract<DecisionItem, { kind: "merge" }>;
    expect(cardOf({ ...merge, prRisk: "medium" }).risk).toBe("medium");
    expect(cardOf({ ...merge, prRisk: "high" }).risk).toBe("high");
    expect(cardOf({ ...merge, proof: { ...proof, notTested: 1 } }).risk).toBe("medium");
    expect(cardOf({ ...merge, ci: "failing" }).risk).toBe("medium");
    expect(cardOf({ ...merge, securityFindingsHigh: 1 }).risk).toBe("high");
    expect(cardOf({ ...merge, fullSuitePending: true }).risk).toBe("medium");
  });
  it("tiers a spend by amount and a dependency by install scripts", () => {
    const spend = ITEMS.approve_spend as Extract<DecisionItem, { kind: "approve_spend" }>;
    expect([5, 10.01, 100, 100.01].map((amountUsd) => cardOf({ ...spend, amountUsd }).risk)).toEqual(["low", "medium", "medium", "high"]);
    expect(cardOf({ ...(ITEMS.approve_dependency), newInstallScripts: true } as DecisionItem).risk).toBe("high");
  });
  it("uses the test environment's own tier and a company lock can raise a tier but never lower it", () => {
    expect(cardOf({ ...(ITEMS.approve_test_env), risk: "high" } as DecisionItem).risk).toBe("high");
    expect(cardOf(ITEMS.approve_plan, { approve_plan: "high" }).risk).toBe("high");
    expect(cardOf(ITEMS.approve_plan, { approve_plan: "medium" }).risk).toBe("medium");
    expect(cardOf(ITEMS.approve_setting, { approve_setting: "low" }).risk).toBe("high");
    expect(cardOf({ ...(ITEMS.merge), prRisk: "high" } as DecisionItem, { merge: "low" }).risk).toBe("high");
    expect(cardOf(ITEMS.approve_dependency, { approve_dependency: "low" }).risk).toBe("medium");
  });
  it("fails closed when an input a kind needs is missing: no tier is guessed", () => {
    expect(() => riskTierOf("merge", {})).toThrow();
    expect(() => riskTierOf("approve_plan", {})).toThrow();
    expect(() => riskTierOf("approve_spend", { spend: { amountUsd: Number.NaN } })).toThrow();
  });
  it("recognises infrastructure paths on the whole segment", () => {
    expect(["infra/a.ts", "x/terraform/main.tf", "db/schema.sql", "Dockerfile", "cdk.json", "src/iam/roles.ts"].every(isInfraPath)).toBe(true);
    expect(["src/miami.ts", "src/author.ts", "src/cdkish.ts"].some(isInfraPath)).toBe(false);
  });
});

describe("friction on the card", () => {
  it("low is one tap: approve is a POST to this server's card route, first", () => {
    const card = cardOf(ITEMS.approve_plan);
    expect(card.actions[0]).toEqual({ kind: "approve", label: "Approve", href: `${decisionCardPath("approve_plan:plan1")}/approve`, method: "POST" });
    expect(card.recommended.action).toBe("approve");
    expect(card.rejectReasons.length).toBeGreaterThan(0);
  });
  it("medium keeps the evidence-first flag and still offers approve (the server enforces the open)", () => {
    const card = cardOf(ITEMS.approve_dependency);
    expect(card.friction).toEqual({ expandEvidenceFirst: true, freshSignIn: false, secondPerson: false });
    expect(card.actions.some((action) => action.kind === "approve")).toBe(true);
  });
  it("high has NO approve action: only 'Open to decide', and a fresh sign-in is flagged (second person where asked)", () => {
    const card = cardOf(ITEMS.approve_setting);
    expect(card.actions.map((action) => action.kind)).toEqual(["open"]);
    expect(card.actions[0]?.label).toBe("Open to decide");
    expect(card.recommended.action).toBe("open");
    expect(card.friction).toEqual({ expandEvidenceFirst: true, freshSignIn: true, secondPerson: true });
    expect(cardOf({ ...(ITEMS.approve_plan), files: ["infra/x.ts"] } as DecisionItem).friction.secondPerson).toBe(false);
  });
  it("recommends looking first when the merge's evidence is bad", () => {
    const card = cardOf({ ...(ITEMS.merge), proof: { ...proof, failed: 1 } } as DecisionItem);
    expect(card.recommended.action).toBe("open");
    expect(card.actions[0]?.kind).toBe("open");
  });
  it("a question or a checks choice is answered on its own page: the card only opens it", () => {
    for (const kind of ["answer_question", "choose_checks"] as const) {
      const card = cardOf(ITEMS[kind]);
      expect(card.actions.map((action) => [action.kind, action.method])).toEqual([["open", "GET"]]);
    }
  });
  it("no card has more than one approve and no action is bulk", () => {
    for (const card of projectDecisionCards(Object.values(ITEMS)).cards) {
      expect(card.actions.filter((action) => action.kind === "approve").length).toBeLessThanOrEqual(1);
      expect(card.actions.filter((action) => action.kind === "approve").every((action) => action.method === "POST")).toBe(true);
      expect(JSON.stringify(card)).not.toMatch(/bulk|approve-all|approveAll/iu);
    }
  });
});

describe("links are same-origin relative paths only", () => {
  it("accepts the contract's paths and refuses absolute, protocol-relative, backslash, dot-dot, spaced, encoded, colon and control forms", () => {
    expect(isSafeRelativePath("/app/sessions/ses_abc")).toBe(true);
    expect(isSafeRelativePath("/v1/app/approve/apr_abc?x=1")).toBe(true);
    for (const bad of ["https://evil.example/x", "//evil.example", "/\\evil.example", "/app/a\\b", "/app/a/../b", "/app/a b", "/app/a\nb", "/app/\u202Eevil", "javascript:alert(1)", "evil", "", "/s/ses_abc", "/other/x", "/app//x", "/app/a:b", "/app/a%2Fb", "/app/x@y"]) expect(isSafeRelativePath(bad), bad).toBe(false);
  });
  it("drops a card whose open path is unsafe, counted and never shown", () => {
    const unsafe = ["//evil.example/x", "/\\evil.example", "https://evil.example/x", "/app/a/../b", "/s/ses_x"];
    const projection = projectDecisionCards([...unsafe.map((openPath, index) => ({ ...ITEMS.approve_plan, subjectId: `p${String(index)}`, openPath })), ITEMS.merge]);
    expect(projection.cards.map((card) => card.kind)).toEqual(["merge"]);
    expect(projection.dropped).toBe(unsafe.length);
  });
  it("every link on every card is a safe relative path", () => {
    for (const card of projectDecisionCards(Object.values(ITEMS)).cards) for (const action of card.actions) expect(isSafeRelativePath(action.href), action.href).toBe(true);
  });
  it("drops an item with a bad id and a duplicate card", () => {
    const projection = projectDecisionCards([{ ...ITEMS.merge, subjectId: "has space" }, ITEMS.approve_plan, ITEMS.approve_plan]);
    expect(projection.cards).toHaveLength(1);
    expect(projection.dropped).toBe(2);
  });
});

describe("standing rules", () => {
  const rule = { ruleId: "docs-only", at: "2026-10-30T11:00:00.000Z" };
  it("record a rule's answer on a low or medium card: answered_by_rule, no actions", () => {
    const card = cardOf({ ...(ITEMS.approve_plan), answeredByRule: rule });
    expect(card.status).toBe("answered_by_rule");
    expect(card.answeredByRule).toEqual(rule);
    expect(card.actions).toEqual([]);
  });
  it("never answer a high card: the rule is ignored and the card stays pending with 'open to decide'", () => {
    const card = cardOf({ ...(ITEMS.approve_setting), answeredByRule: rule });
    expect(card.status).toBe("pending");
    expect(card.answeredByRule).toBeUndefined();
    expect(card.actions.map((action) => action.kind)).toEqual(["open"]);
  });
  it("a lock that raises a card to high also stops a rule from answering it", () => {
    const card = cardOf({ ...(ITEMS.approve_plan), answeredByRule: rule }, { approve_plan: "high" });
    expect(card.status).toBe("pending");
  });
  it("a finished item is history: its outcome, no actions", () => {
    const card = cardOf({ ...(ITEMS.merge), outcome: "approved" });
    expect(card.status).toBe("approved");
    expect(card.actions).toEqual([]);
  });
});

describe("Full path: requirements and design are one card with two tabs", () => {
  it("merges the pair for one task into one card at the higher tier, with two tabs that each stay an approval", () => {
    const projection = projectDecisionCards([ITEMS.approve_requirements, { ...(ITEMS.approve_design), files: ["infra/stack.ts", "src/auth/login.ts"] } as DecisionItem]);
    expect(projection.cards).toHaveLength(1);
    const [card] = projection.cards;
    expect(card?.kind).toBe("approve_requirements");
    const tabs = projection.tabs[card?.id ?? ""];
    expect(DecisionTabsSchema.safeParse(tabs).success).toBe(true);
    expect(tabs?.map((tab) => tab.id)).toEqual(["requirements", "design"]);
    expect(tabs?.every((tab) => !tab.approved)).toBe(true);
  });
  it("keeps the pair at the higher tier: a medium design makes the card medium", () => {
    const projection = projectDecisionCards([ITEMS.approve_requirements, { ...(ITEMS.approve_design), files: ["src/auth/login.ts"] } as DecisionItem]);
    expect(projection.cards[0]?.risk).toBe("medium");
    expect(projection.cards[0]?.friction.expandEvidenceFirst).toBe(true);
  });
  it("a high pair has no approve on the card", () => {
    const projection = projectDecisionCards([ITEMS.approve_requirements, ITEMS.approve_design], { locks: { approve_design: "high" } });
    expect(projection.cards[0]?.risk).toBe("high");
    expect(projection.cards[0]?.actions.map((action) => action.kind)).toEqual(["open"]);
  });
  it("does not merge different tasks, or when pairing is off (two separate cards)", () => {
    const other = { ...(ITEMS.approve_design), taskId: "22222222-2222-4222-8222-222222222222" } as DecisionItem;
    expect(projectDecisionCards([ITEMS.approve_requirements, other]).cards).toHaveLength(2);
    expect(projectDecisionCards([ITEMS.approve_requirements, ITEMS.approve_design], { pairFullCards: false }).cards).toHaveLength(2);
  });
});

describe("text and order", () => {
  it("flattens a hostile title and question to plain text", () => {
    const card = cardOf({ ...(ITEMS.answer_question), question: "Pick one‮\nnow <script>alert(1)</script>", title: "a\u0000b\n\nc" } as DecisionItem);
    expect(card.question).not.toMatch(/[\p{Cc}\p{Cf}]/u);
    expect(card.title).toBe("a b c");
  });
  it("cuts long text to the card's limits", () => {
    const card = cardOf({ ...(ITEMS.answer_question), question: "word ".repeat(200), title: "t".repeat(500) } as DecisionItem);
    expect([...card.question].length).toBeLessThanOrEqual(160);
    expect([...card.title].length).toBeLessThanOrEqual(80);
  });
  it("orders high first, then newer first, and gives the same answer every time", () => {
    const items = [ITEMS.approve_plan, { ...ITEMS.merge, createdAt: "2026-10-30T12:00:00.000Z" }, ITEMS.approve_setting, ITEMS.approve_dependency];
    const first = projectDecisionCards(items).cards.map((card) => card.id);
    expect(first).toEqual(["approve_setting:set1", "approve_dependency:dep1", "merge:pr1", "approve_plan:plan1"]);
    expect(projectDecisionCards([...items].reverse()).cards.map((card) => card.id)).toEqual(first);
  });
});
