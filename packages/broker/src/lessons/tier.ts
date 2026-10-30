// Learning v2 L3a: risk tiers (design §4.5.3). Evaluated by code. The classifier flags (escalation words, the judge's escalate flag, reviewer stages)
// can only raise a tier, never lower it. A lesson that asks for a capability change, or comes from an outsider or an ineligible task, is "never".
import { hasEscalationWords, requestsCapabilityChange } from "./guards.js";
import { isRestricted, trustAtLeast, type Lesson, type LessonCitation, type LessonProvenance, type LessonScope, type LessonStage, type LessonType, type Tier } from "./types.js";

export interface TierInput {
  type: LessonType; stages: readonly LessonStage[]; scope: LessonScope; citations: readonly LessonCitation[];
  citationChecks?: Lesson["citationChecks"]; title: string; description: string; body: string; provenance: Pick<LessonProvenance, "minTrust" | "audience">;
}
export interface TierContext {
  /** The lesson contradicts another; always goes to a person. */
  contradiction?: boolean;
  /** The curator judge's escalate-only flag. */
  judgeEscalate?: boolean;
  /** The task the lesson came from is ineligible (outsider-initiated or steered). */
  ineligibleTask?: boolean;
}
export type TierDecision =
  | { tier: Tier; reasons: string[] }
  | { tier: "never"; reasons: string[]; refused: boolean };

const SAFE_STAGES: ReadonlySet<LessonStage> = new Set(["UNDERSTAND", "PLAN", "IMPLEMENT"]);

function validCodeCitations(input: TierInput): boolean {
  if (input.citations.length === 0) return false;
  return input.citations.every((citation, index) => citation.kind === "code" && input.citationChecks?.some((check) => check.index === index && check.result === "valid") === true);
}

export function classifyTier(input: TierInput, context: TierContext = {}): TierDecision {
  if (requestsCapabilityChange(input.title, input.description, input.body)) return { tier: "never", reasons: ["capability_request"], refused: true };
  if (input.provenance.minTrust === "outsider") return { tier: "never", reasons: ["outsider_source"], refused: false };
  if (context.ineligibleTask === true) return { tier: "never", reasons: ["ineligible_task"], refused: false };

  // Escalation: any of these puts the lesson in front of two people, whatever the structural rules say.
  const escalation: string[] = [];
  if (input.stages.includes("PLAN_CRITIQUE") || input.stages.includes("REVIEW")) escalation.push("reviewer_stage");
  if (input.type === "review_check") escalation.push("review_check");
  if (hasEscalationWords(input.title, input.description, input.body)) escalation.push("escalation_words");
  if (context.judgeEscalate === true) escalation.push("judge_escalate");
  if (escalation.length > 0) return { tier: 2, reasons: escalation };

  // Tier 0: a cited, factual lesson from a trusted source, small in scope. Everything else needs one person.
  const why: string[] = [];
  if (input.type !== "fact") why.push("not_a_fact");
  if (!validCodeCitations(input)) why.push("citations_not_verified");
  if (!trustAtLeast(input.provenance.minTrust, "rovara")) why.push("source_not_trusted");
  const repos = input.scope.repos ?? [];
  const cited = new Set(input.citations.flatMap((c) => (c.kind === "code" ? [c.repo] : [])));
  if (repos.length !== 1 || [...cited].some((repo) => repo !== repos[0])) why.push("scope_not_one_repo");
  if (!input.stages.every((stage) => SAFE_STAGES.has(stage))) why.push("stage_not_allowed");
  if (context.contradiction === true) why.push("contradiction");
  if (isRestricted({ provenance: input.provenance as LessonProvenance })) why.push("restricted_source");
  return why.length === 0 ? { tier: 0, reasons: ["cited_fact"] } : { tier: 1, reasons: why };
}
