// Which stages a How we work card or a company row covers. Lane C's metadata decides it (`STAGE_EDIT_GROUPS`, `STAGE_EDIT_RULES`); this file only reads it and adds the two things the contract does not export: the words of a row title and which earlier stage a checking stage must differ from.
import { STAGE_EDIT_GROUPS, STAGE_EDIT_RULES, type StageId } from "@agentx/contracts/web";

type Group = readonly [StageId, ...StageId[]];
const groups: readonly Group[] = STAGE_EDIT_GROUPS;
const ruleOf = (stage: StageId) => STAGE_EDIT_RULES[stage];
/** The stages a How we work card of this step kind shows, in order: the edit group that owns the kind (Review hosts both reviewers). Understand is edited through the Plan card's setting (its edit group is "plan") and has no card of its own. A kind with no model (checks) has none. */
export function cardStages(kind: string): readonly StageId[] {
 return groups.find(group => group.every(stage => ruleOf(stage).stepKind === kind) && (group.length > 1 || ruleOf(group[0]).editGroup === group[0])) ?? [];
}

/** The earlier stage a checking stage's different-vendor rule names. Lane C's policy schema fixes the same pairs but exports no mapping; a test checks this one against that schema. */
export const REFERENCE_STAGE: Readonly<Partial<Record<StageId, StageId>>> = { plan_check: "plan", code_review: "build", security_review: "build" };
/** The step kind of the card a checking card is compared with ("plan" or "build"), if any. */
export function referenceKind(kind: string): string | undefined {
 const first = cardStages(kind)[0], reference = first === undefined ? undefined : REFERENCE_STAGE[first];
 return reference === undefined ? undefined : ruleOf(reference).stepKind;
}

const ROW_TITLES: Readonly<Record<StageId, string>> = { understand: "Understand", plan: "Plan", plan_check: "Plan check", build: "Build", code_review: "Review (code and security)", security_review: "Security review", pull_request: "Pull request" };
export interface CompanyRow { readonly id: StageId; readonly stages: Group; readonly title: string; readonly reference: StageId | undefined }
/** The rows of the company page, one per edit group in lane C's order; Review is one row that writes both reviewers. */
export const COMPANY_ROWS: readonly CompanyRow[] = groups.map(stages => ({ id: stages[0], stages, title: ROW_TITLES[stages[0]], reference: REFERENCE_STAGE[stages[0]] }));
