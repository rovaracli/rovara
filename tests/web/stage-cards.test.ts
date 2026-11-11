import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { STAGE_EDIT_GROUPS, STAGE_EDIT_RULES, STAGE_IDS, STAGE_REFERENCE, STAGE_MODEL_THINKING_LEVELS, ModelSelectionPolicyPutSchema, StepThinkingLevelSchema, type StageId } from "@agentx/cloud-contracts/web";
import { COMPANY_ROWS, cardStages, cardTitle, editBaseStage, referenceKind } from "../../packages/ui/src/api/stage-cards.js";
import { EFFORT_LABELS, EFFORT_OPTIONS, effortLabel } from "../../packages/ui/src/screens/project/stage-model-text.js";

describe("stage cards and company rows come from lane C's edit metadata", () => {
 it("gives each How we work card the stages of the edit group that owns its step kind", () => {
  expect(cardStages("plan")).toEqual(["understand", "plan"]);
  expect(cardStages("plan_critic")).toEqual(["plan_check"]);
  expect(cardStages("build")).toEqual(["build"]);
  expect(cardStages("review")).toEqual(["code_review", "security_review"]);
  expect(cardStages("pull_request")).toEqual(["pull_request"]);
  expect(cardStages("check")).toEqual([]);
  expect(cardStages("something_new")).toEqual([]);
 });
 it("covers every stage of every edit group: Understand shares the Plan card, so no stage is left without a card or shown twice", () => {
  const shown = ["plan", "plan_critic", "build", "review", "pull_request"].flatMap(kind => cardStages(kind));
  expect([...shown].sort()).toEqual([...STAGE_IDS].sort());
  expect(new Set(shown).size).toBe(shown.length);
  expect(STAGE_EDIT_RULES.understand.editGroup).toBe(STAGE_EDIT_RULES.plan.editGroup);
 });
 it("makes one company row per edit group, in lane C's order: Plan (and Understand) is one row for both stages, Review one row for both reviewers", () => {
  expect(COMPANY_ROWS.map(row => [...row.stages])).toEqual(STAGE_EDIT_GROUPS.map(group => [...group]));
  expect(COMPANY_ROWS.map(row => row.title)).toEqual(["Plan (and Understand)", "Plan check", "Build", "Review (code and security)", "Pull request"]);
  expect(COMPANY_ROWS.map(row => row.reference)).toEqual([undefined, "plan", undefined, "build", undefined]);
  expect(COMPANY_ROWS.some(row => row.title === "Understand")).toBe(false);
 });
 it("titles the Plan card for both stages and leaves every other card's own name", () => {
  expect(cardTitle("plan", "Plan")).toBe("Plan (and Understand)");
  expect(cardTitle("review", "Review")).toBe("Review");
  expect(cardTitle("build", "Build")).toBe("Build");
  expect(cardTitle("check", "Checks")).toBe("Checks");
 });
 it("edits a group through the stage that names the group (Plan), else its first stage", () => {
  expect(editBaseStage(["understand", "plan"])).toBe("plan");
  expect(editBaseStage(["code_review", "security_review"])).toBe("code_review");
  expect(editBaseStage(["build"])).toBe("build");
 });
 it("lane C's STAGE_REFERENCE names exactly the reference stage its policy schema accepts, and no other", () => {
  const put = (stage: StageId, reference: StageId) => ModelSelectionPolicyPutSchema.safeParse({ version: 1, requestId: "11111111-1111-4111-8111-111111111111", expectedRevision: 0, stepOverrides: { [stage]: { differentFrom: { stage: reference, level: "vendor" }, locked: false } } }).success;
  for (const stage of STAGE_IDS) {
   const wanted = (STAGE_REFERENCE as Partial<Record<StageId, StageId>>)[stage];
   for (const reference of STAGE_IDS) expect(put(stage, reference), stage + " vs " + reference).toBe(wanted !== undefined && reference === wanted);
  }
 });
 it("compares a checking card with the plan or build card by step kind", () => {
  expect(referenceKind("plan_critic")).toBe("plan");
  expect(referenceKind("review")).toBe("build");
  expect(referenceKind("build")).toBeUndefined();
  expect(referenceKind("plan")).toBeUndefined();
 });
 it("offers the effort choices lane C lists, plus Rovara's default and Model default, and nothing else", () => {
  expect(EFFORT_OPTIONS.map(option => option.value)).toEqual(["inherit", "null", ...STAGE_MODEL_THINKING_LEVELS]);
  expect([...STAGE_MODEL_THINKING_LEVELS]).toEqual([...StepThinkingLevelSchema.options]);
 });
 it("labels exactly the effort levels lane C lists: a level outside its scale (xhigh) has no label of its own", () => {
  expect(Object.keys(EFFORT_LABELS).sort()).toEqual([...STAGE_MODEL_THINKING_LEVELS].sort());
  expect(effortLabel("xhigh")).toBe("Model default");
 });
 it("keeps no local reference map: the reference pairs are lane C's STAGE_REFERENCE", () => {
  expect(readFileSync(new URL("../../packages/ui/src/api/stage-cards.ts", import.meta.url), "utf8")).not.toContain("REFERENCE_STAGE");
 });
});
