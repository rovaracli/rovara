// Which stages a How we work card or a company row covers. Lane C's metadata decides it (`STAGE_EDIT_GROUPS`, `STAGE_EDIT_RULES`); this file only reads it and adds the words of a row title.
import { STAGE_EDIT_GROUPS, STAGE_EDIT_RULES, STAGE_REFERENCE, type StageId } from "@agentx/contracts/web";

type Group = readonly [StageId, ...StageId[]];
const groups: readonly Group[] = STAGE_EDIT_GROUPS;
const ruleOf = (stage: StageId) => STAGE_EDIT_RULES[stage];
const referenceOf: Readonly<Partial<Record<StageId, StageId>>> = STAGE_REFERENCE;
/** The stages a How we work card of this step kind shows, in order: the edit group that owns the kind (Plan hosts Understand, Review hosts both reviewers). A kind with no model (checks) has none. */
export function cardStages(kind: string): readonly StageId[] {
 return groups.find(group => group.every(stage => ruleOf(stage).stepKind === kind)) ?? [];
}
/** The stage of a group whose setting the card or row shows and edits first: the one that names the group (Plan, for Plan and Understand), else the first. */
export const editBaseStage = (stages: readonly StageId[]): StageId => stages.find(stage => ruleOf(stage).editGroup === stage) ?? stages[0]!;
/** Whether `stage` has no setting of its own in its group but uses the one of `base` (Understand, which is edited through Plan): its edit group is named by the base stage. */
export const usesBaseSetting = (stage: StageId, base: StageId): boolean => stage !== base && ruleOf(stage).editGroup === base;

/** The step kind of the card a checking card is compared with ("plan" or "build"), if any. */
export function referenceKind(kind: string): string | undefined {
 const first = cardStages(kind)[0], reference = first === undefined ? undefined : referenceOf[first];
 return reference === undefined ? undefined : ruleOf(reference).stepKind;
}

const ROW_TITLES: Readonly<Record<StageId, string>> = { understand: "Plan (and Understand)", plan: "Plan", plan_check: "Plan check", build: "Build", code_review: "Review (code and security)", security_review: "Security review", pull_request: "Pull request" };
export interface CompanyRow { readonly id: StageId; readonly stages: Group; readonly title: string; readonly reference: StageId | undefined; /** The stage whose saved setting the row shows. */ readonly base: StageId }
/** The rows of the company page, one per edit group in lane C's order; Review is one row that writes both reviewers. */
export const COMPANY_ROWS: readonly CompanyRow[] = groups.map(stages => ({ id: stages[0], stages, title: ROW_TITLES[stages[0]], reference: referenceOf[stages[0]], base: editBaseStage(stages) }));

/** The title of a How we work card: the group's row title when the card hosts Plan and Understand, else the step's own name. */
export function cardTitle(kind: string, name: string): string {
 const stages = cardStages(kind);
 return stages.length > 1 && stages[0] === "understand" ? ROW_TITLES.understand : name;
}
