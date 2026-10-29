import { describe, expect, it } from "vitest";
import { STAGE_EDIT_GROUPS, STAGE_EDIT_RULES, STAGE_IDS, STAGE_MODEL_THINKING_LEVELS, ModelSelectionPolicyPutSchema, StepThinkingLevelSchema, type StageId } from "@agentx/contracts/web";
import { COMPANY_ROWS, REFERENCE_STAGE, cardStages, referenceKind } from "../../packages/ui/src/api/stage-cards.js";
import { EFFORT_OPTIONS } from "../../packages/ui/src/screens/project/stage-model-text.js";

describe("stage cards and company rows come from lane C's edit metadata", () => {
 it("gives each How we work card the stages of the edit group that owns its step kind", () => {
  expect(cardStages("plan")).toEqual(["plan"]);
  expect(cardStages("plan_critic")).toEqual(["plan_check"]);
  expect(cardStages("build")).toEqual(["build"]);
  expect(cardStages("review")).toEqual(["code_review", "security_review"]);
  expect(cardStages("pull_request")).toEqual(["pull_request"]);
  expect(cardStages("check")).toEqual([]);
  expect(cardStages("something_new")).toEqual([]);
 });
 it("covers every stage of every edit group, with Understand edited through the Plan card and so on no card of its own", () => {
  const shown = new Set(["plan", "plan_critic", "build", "review", "pull_request"].flatMap(kind => cardStages(kind)));
  expect([...shown].sort()).toEqual(STAGE_IDS.filter(stage => stage !== "understand").sort());
  expect(STAGE_EDIT_RULES.understand.editGroup).toBe("plan");
 });
 it("makes one company row per edit group, in lane C's order, with Review as one row for both reviewers", () => {
  expect(COMPANY_ROWS.map(row => [...row.stages])).toEqual(STAGE_EDIT_GROUPS.map(group => [...group]));
  expect(COMPANY_ROWS.map(row => row.title)).toEqual(["Understand", "Plan", "Plan check", "Build", "Review (code and security)", "Pull request"]);
  expect(COMPANY_ROWS.map(row => row.reference)).toEqual([undefined, undefined, "plan", undefined, "build", undefined]);
 });
 it("names as the reference stage exactly the one lane C's policy schema accepts, and no other", () => {
  const put = (stage: StageId, reference: StageId) => ModelSelectionPolicyPutSchema.safeParse({ version: 1, requestId: "11111111-1111-4111-8111-111111111111", expectedRevision: 0, stepOverrides: { [stage]: { differentFrom: { stage: reference, level: "vendor" }, locked: false } } }).success;
  for (const stage of STAGE_IDS) {
   const wanted = REFERENCE_STAGE[stage];
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
});
