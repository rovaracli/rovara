// L4-DCS: Cloud's copy of Code's decision-card contract is a byte copy (packages/contracts/src/decision-cards.ts, decision-card-tabs.ts, decision-focus.ts), and the website reads what Code really answers.
// The fixtures are Code's own projector output for every card kind (tests/fixtures/code-decision-cards.json, Code origin/code/next 5b8f7f504). When Code changes these files, copy them again byte for byte,
// regenerate the fixtures, and update the three digests below in the same change: a hand edit of a copied file fails here.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  DECISION_KINDS, DecisionApproveBodySchema, DecisionCardReaderSchema, DecisionCardsViewReaderSchema, DecisionCardsViewSchema, DecisionPlanChoicesSchema, DecisionRequestChangesBodySchema,
  planChoicesProblem,
} from "../../packages/contracts/src/index.js";
import { readDecisions } from "../../packages/ui/src/api/decisions.js";

const sha = (name: string) => createHash("sha256").update(readFileSync(`packages/contracts/src/${name}.ts`)).digest("hex");
const FIXTURE = JSON.parse(readFileSync("tests/fixtures/code-decision-cards.json", "utf8")) as { codeSha: string; views: Record<string, Record<string, unknown> & { cards: Array<Record<string, unknown>> }> };
const view = (name: string): Record<string, unknown> & { cards: Array<Record<string, unknown>> } => structuredClone(FIXTURE.views[name]!);

describe("Code's decision-card contract copy", () => {
  it("is Code's file, byte for byte (digests of Code 5b8f7f504)", () => {
    expect(FIXTURE.codeSha).toBe("5b8f7f5046b269af433cf3758d9e9cf48951b4c7");
    expect(sha("decision-cards")).toBe("17d838b9cc4d1e07a6309d3cbab311687e4f6ff731c216e297e34802c3d2f3c6");
    expect(sha("decision-card-tabs")).toBe("a30003ca106d11c164bb99a0b28d5f10500f6b834eccd70dd5e816a6433dbe2a");
    expect(sha("decision-focus")).toBe("7393f3c37f0d26b6106e20c1232ac76d52ad728d1f93272bc6da4d3208a1c832");
  });
});

describe("real Code decision cards", () => {
  it("has a fixture for every card kind, and each parses strictly (the schema Code builds them with) and through the reader", () => {
    const kinds = new Set<string>();
    for (const kind of DECISION_KINDS) {
      const one = FIXTURE.views[kind];
      expect(one, kind).toBeDefined();
      expect(one!.cards[0]!["kind"]).toBe(kind);
      expect(DecisionCardsViewSchema.safeParse(one).success, `${kind} strict`).toBe(true);
      const read = DecisionCardsViewReaderSchema.parse(one);
      const [decision] = readDecisions(read);
      expect(decision?.card.id, `${kind} read`).toBe(one!.cards[0]!["id"]);
      kinds.add(kind);
    }
    expect(kinds.size).toBe(20);
  });
  it("reads the mixed list and the Full pair with its tabs", () => {
    const all = FIXTURE.views["all_kinds"]!;
    expect(DecisionCardsViewSchema.safeParse(all).success).toBe(true);
    expect(readDecisions(DecisionCardsViewReaderSchema.parse(all))).toHaveLength(20);
    const pair = readDecisions(DecisionCardsViewReaderSchema.parse(FIXTURE.views["full_pair_with_tabs"]));
    expect(pair).toHaveLength(1);
    expect(pair[0]!.tabs?.map((tab) => tab.id)).toEqual(["requirements", "design"]);
  });
  it("carries the new plan card fields: Request changes, the run limit and the plan choices", () => {
    const plan = FIXTURE.views["approve_plan_with_choices"]!;
    expect(DecisionCardsViewSchema.safeParse(plan).success).toBe(true);
    const [decision] = readDecisions(DecisionCardsViewReaderSchema.parse(plan));
    expect(decision!.card.actions.map((action) => action.kind)).toEqual(["approve", "request_changes", "open"]);
    expect(decision!.card).toMatchObject({ runLimit: { currentUsd: 2, proposedUsd: 5 } });
    expect(decision!.choices?.questions.map((question) => question.id)).toEqual(["q1", "q2"]);
    expect(decision!.choices?.optionalChecks).toHaveLength(2);
    expect(decision!.choices?.openComments).toHaveLength(2);
    for (const name of ["approve_requirements_with_choices", "approve_design_with_choices"]) expect(readDecisions(DecisionCardsViewReaderSchema.parse(FIXTURE.views[name]))[0]!.choices, name).toBeDefined();
  });
  it("reads a card with no choices as having none", () => {
    for (const kind of ["approve_plan", "approve_requirements", "approve_design", "merge"]) expect(readDecisions(DecisionCardsViewReaderSchema.parse(FIXTURE.views[kind]))[0]!.choices, kind).toBeUndefined();
  });
});

describe("a newer server's extra fields", () => {
  it("ignores an unknown field on the view, on a card and on an answer, and reads an unknown card kind as unknown", () => {
    const value = view("approve_plan_with_choices");
    value["newerField"] = { a: 1 };
    value.cards[0]!["newerCardField"] = true;
    expect(readDecisions(DecisionCardsViewReaderSchema.parse(value))).toHaveLength(1);
    const next = DecisionCardReaderSchema.parse({ ...value.cards[0], kind: "approve_something_new" }) as Record<string, unknown>;
    expect(next["kind"]).toBe("unknown");
    // The strict schema (what Code builds with) still refuses them: only the reader forgives.
    expect(DecisionCardsViewSchema.safeParse(value).success).toBe(false);
  });
  it("fails safe on plan choices it cannot read: the card still shows, without choices (the person can still approve with Rovara's answers)", () => {
    const choices = (value: ReturnType<typeof view>) => (value["choices"] as Record<string, Record<string, unknown>>)["approve_plan:plan2"]!;
    const extraField = view("approve_plan_with_choices");
    choices(extraField)["newerChoiceField"] = 1;
    const badOption = view("approve_plan_with_choices");
    (choices(badOption)["questions"] as Array<Record<string, unknown>>)[0]!["recommended"] = "";
    const notAnObject = view("approve_plan_with_choices");
    (notAnObject["choices"] as Record<string, unknown>)["approve_plan:plan2"] = "choices";
    for (const [name, value] of [["unknown field", extraField], ["empty recommendation", badOption], ["not an object", notAnObject]] as const) {
      const [decision] = readDecisions(DecisionCardsViewReaderSchema.parse(value));
      expect(decision, name).toBeDefined();
      expect(decision!.choices, name).toBeUndefined();
    }
  });
  it("reads choices only for the kinds that carry them, and only the card's own entry", () => {
    const merge = view("merge");
    merge["choices"] = { "merge:pr1": FIXTURE.views["approve_plan_with_choices"]!["choices"] && (FIXTURE.views["approve_plan_with_choices"]!["choices"] as Record<string, unknown>)["approve_plan:plan2"] };
    expect(readDecisions(DecisionCardsViewReaderSchema.parse(merge))[0]!.choices).toBeUndefined();
    const other = view("approve_plan_with_choices");
    other["choices"] = { "approve_plan:someone-else": (other["choices"] as Record<string, unknown>)["approve_plan:plan2"] };
    expect(readDecisions(DecisionCardsViewReaderSchema.parse(other))[0]!.choices).toBeUndefined();
  });
  it("shows no card whose digest is missing or malformed", () => {
    const missing = view("approve_plan_with_choices");
    missing["digests"] = {};
    expect(readDecisions(DecisionCardsViewReaderSchema.parse(missing))).toEqual([]);
    const bad = view("approve_plan_with_choices");
    bad["digests"] = { "approve_plan:plan2": "not-a-digest" };
    expect(readDecisions(DecisionCardsViewReaderSchema.parse(bad))).toEqual([]);
  });
});

describe("the approve and request-changes bodies the app sends", () => {
  const requestId = "8b579b4b-eaa7-4bf2-87bc-6da86b97c9e6", shownDigest = "a".repeat(64);
  it("takes the plan fields on approve, strictly", () => {
    const body = { requestId, shownDigest, acknowledgedRunLimitUsd: 5, answers: [{ decisionId: "q1", optionId: "b", opened: true }], selectedOptionalCheckIds: ["load"], includedCommentIds: ["33333333-3333-4333-8333-333333333333"], note: "Please be careful." };
    expect(DecisionApproveBodySchema.safeParse(body).success).toBe(true);
    expect(DecisionApproveBodySchema.safeParse({ ...body, bulk: true }).success).toBe(false);
    expect(DecisionApproveBodySchema.safeParse({ ...body, answers: [body.answers[0], body.answers[0]] }).success).toBe(false);
    expect(DecisionApproveBodySchema.safeParse({ ...body, note: "x".repeat(501) }).success).toBe(false);
  });
  it("takes a reason and the comments on request changes, and refuses hidden characters and over-long reasons", () => {
    expect(DecisionRequestChangesBodySchema.safeParse({ requestId, shownDigest, reason: "Cover the refund path.", includedCommentIds: ["33333333-3333-4333-8333-333333333333"] }).success).toBe(true);
    expect(DecisionRequestChangesBodySchema.safeParse({ requestId, shownDigest, reason: "a‮b" }).success).toBe(false);
    expect(DecisionRequestChangesBodySchema.safeParse({ requestId, shownDigest, reason: "x".repeat(501) }).success).toBe(false);
    expect(DecisionRequestChangesBodySchema.safeParse({ requestId, shownDigest, reason: "   " }).success).toBe(false);
  });
  it("refuses plan fields on a card kind that takes none (the rule Code's route applies)", () => {
    expect(planChoicesProblem("merge", { note: "x" })).toBe("note: this card takes no note");
    expect(planChoicesProblem("approve_requirements", { selectedOptionalCheckIds: ["a"] })).toBe("selectedOptionalCheckIds: only a coding plan has optional checks");
    expect(planChoicesProblem("approve_plan", { answers: [] })).toBeUndefined();
  });
  it("keeps the plan choices schema strict", () => {
    const choices = (FIXTURE.views["approve_plan_with_choices"]!["choices"] as Record<string, unknown>)["approve_plan:plan2"];
    expect(DecisionPlanChoicesSchema.safeParse(choices).success).toBe(true);
    expect(DecisionPlanChoicesSchema.safeParse({ ...(choices as object), extra: 1 }).success).toBe(false);
  });
});
