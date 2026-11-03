// Design review stage, DR6 (designs-2026-10-30/design-review-stage.md 3.2, 3.5, 3.7, 3.13): the workflow's moves while a design is reviewed by fresh-context reviewers.
//
// The design review runs in the existing plan-check stage (PLAN_CRITIQUE) on the DESIGN document of a Full task, with a `designReview` record beside `critique` on the snapshot:
//
//   enableDesignReview            PLAN/READY (no design yet)  ->  same place, path FULL, review "estimating"
//   submitWorkflowArtifact        a design document           ->  PLAN_CRITIQUE/READY            (task-workflow-node.ts: `planCritiqued`)
//   holdDesignReviewForCost       PLAN_CRITIQUE/READY         ->  PLAN_CRITIQUE/WAITING          "waiting_cost": a person decides the spend
//   startDesignReview             READY (or WAITING, approved) ->  PLAN_CRITIQUE/RUNNING         "running"
//   retryDesignReview             RUNNING                     ->  PLAN_CRITIQUE/READY            the model could not be used; try the next
//   submitDesignReview            RUNNING                     ->  PLAN/READY "resolving"         the planner resolves each finding
//                                                              or PLAN_REVIEW/WAITING            nothing left to resolve, cap reached, or no reviewer gave a result
//   askDesignQuestions            PLAN/RUNNING "resolving"    ->  PLAN/WAITING "waiting_answers" one card, at most 3 questions
//   answerDesignQuestions         PLAN/WAITING                ->  PLAN/READY "resolving"
//   resolveDesignReview           PLAN/RUNNING "resolving"    ->  PLAN_CRITIQUE/READY "estimating" (round 2 of the revised design)
//                                                              or PLAN_REVIEW/WAITING "done"
//   closeDesignReview             any step that is not waiting for a person's answer -> PLAN_REVIEW/WAITING (the approve_design card)
//
// Bounds: at most DESIGN_REVIEW_ROUNDS_MAX rounds and DESIGN_REVIEW_REVISIONS_MAX planner revisions, one question card per round with at most DESIGN_REVIEW_QUESTIONS_MAX questions.
// Nothing here approves anything: every path ends at PLAN_REVIEW/WAITING, where `decideWorkflow` needs a person. The reviewers' and the planner's words are untrusted data: they are
// parsed with the strict DR1 schemas, and code (never a model) decides the fingerprint of a finding, whether a resolution is settled, and where the workflow goes next.
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  DESIGN_REVIEW_NOT_RUN_REASONS, DESIGN_REVIEW_QUESTIONS_MAX, DESIGN_REVIEW_REVISIONS_MAX, DESIGN_REVIEW_ROUNDS_MAX, DESIGN_REASONS_MAX, DESIGN_NOTE_MAX, DesignAnswerSchema, DesignFindingSchema,
  DesignModelRefSchema, DesignQuestionSchema, DesignReasonSchema, DesignReviewRoundSchema, DesignReviewTierSchema, FindingResolutionSchema, ReviewerRunSchema, WorkflowDesignReviewSchema,
  type DesignFinding, type DesignReviewRound, type FindingResolution, type ReviewerRun, type WorkflowDesignReview,
} from "./design-review.js";
import { designRoundHasResult, designRoundResolved, designReviewRevisionsUsed, resolutionOf } from "./design-review-state.js";
import { redactText } from "./redaction.js";
import { ActorIdSchema, WorkflowArtifactSchema } from "./task-workflow.js";
import { WorkflowSnapshotSchema, WorkflowTransitionError, type WorkflowArtifact, type WorkflowSnapshot } from "./task-workflow-node.js";

const fail = (message: string): WorkflowTransitionError => new WorkflowTransitionError(message);

/** What a person's free-text answer to a design question may hold. */
const DESIGN_ANSWER_TEXT_MAX = 500;
/** The most the stored review may weigh as JSON. A task's whole record is limited to 400 KB, and the review shares it with everything else; an over-large review is refused, not trimmed. */
export const DESIGN_REVIEW_RECORD_MAX_BYTES = 150_000;
const SETTLED_NOTE = "Settled in an earlier round; raised again.";

/**
 * The identity of a finding across rounds: a hash of its section and its text with case, spacing and punctuation taken out. Code computes it; the one a reviewer or the merge step wrote
 * is replaced, so a model can neither hide a new finding behind an old fingerprint nor split an old one.
 */
export function designFindingFingerprint(finding: { section: string; text: string }): string {
  const text = finding.text.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  return createHash("sha256").update(JSON.stringify([finding.section, text])).digest("hex");
}

// ---- shared guards

interface Located { current: WorkflowSnapshot; review: WorkflowDesignReview }

function parsed(input: unknown): WorkflowSnapshot {
  const snapshot = WorkflowSnapshotSchema.safeParse(input);
  if (!snapshot.success) throw fail("workflow snapshot is invalid");
  return snapshot.data;
}

/** The workflow at the design review: at the revision that was read, in the DESIGN phase of a Full task, at this stage and state, with the review in one of these statuses. */
function located(input: unknown, expectedRevision: number, where: { stage: WorkflowSnapshot["stage"]; states: readonly WorkflowSnapshot["state"][]; statuses: readonly WorkflowDesignReview["status"][] }): Located {
  const current = parsed(input);
  if (current.revision !== expectedRevision) throw fail("workflow revision is stale");
  const review = current.designReview;
  if (review === undefined || current.reviewPhase !== "DESIGN" || current.path !== "FULL" || current.stage !== where.stage || !where.states.includes(current.state) || !where.statuses.includes(review.status)) {
    throw fail("the workflow is not at that step of the design review");
  }
  return { current, review };
}

function moved(current: WorkflowSnapshot, next: { stage: WorkflowSnapshot["stage"]; state: WorkflowSnapshot["state"]; review: WorkflowDesignReview; artifacts?: WorkflowArtifact[]; now: string }): WorkflowSnapshot {
  const record = WorkflowDesignReviewSchema.safeParse(next.review);
  if (!record.success) throw fail("the design review record is invalid");
  return WorkflowSnapshotSchema.parse({
    ...current, revision: current.revision + 1, stage: next.stage, state: next.state, designReview: record.data,
    ...(next.artifacts === undefined ? {} : { artifacts: next.artifacts }), updatedAt: next.now,
  });
}

const latestDesign = (workflow: WorkflowSnapshot): WorkflowArtifact | undefined => workflow.artifacts.filter((artifact) => artifact.type === "design").at(-1);
const lastRound = (review: WorkflowDesignReview): DesignReviewRound | undefined => review.rounds.at(-1);
const withLastRound = (review: WorkflowDesignReview, round: DesignReviewRound): DesignReviewRound[] => [...review.rounds.slice(0, -1), round];
/** Money is kept to the cent: no floating-point drift can push a total over a cap or under zero. */
const addUsd = (a: number, b: number): number => Math.round((a + b) * 1e6) / 1e6;

// ---- switching it on

const StartSchema = z.object({
  decidedBy: z.enum(["auto", "always", "person"]),
  reasons: z.array(DesignReasonSchema).max(DESIGN_REASONS_MAX),
  note: z.string().min(1).max(DESIGN_NOTE_MAX).refine((value) => !/[\p{Cc}\p{Cf}]/u.test(value), "must be plain text").optional(),
  tier: DesignReviewTierSchema,
}).strict();
export type DesignReviewStart = z.input<typeof StartSchema>;

/**
 * Design review is ON for this task. The caller has already resolved the mode (the person's words, the project setting, Understand's reading); this records it, and it forces the Full path
 * (a task that was Quick becomes Full and starts at the requirements, as the person is told). Allowed only while the task is planning, before any design document exists, in a version 2
 * workflow whose sequence has a plan check step (the design review runs in that step). With it OFF nothing changes anywhere: the snapshot has no `designReview`.
 */
export function enableDesignReview(currentInput: unknown, input: { expectedRevision: number; start: DesignReviewStart; now: string }): WorkflowSnapshot {
  const current = parsed(currentInput);
  if (current.revision !== input.expectedRevision) throw fail("workflow revision is stale");
  const start = StartSchema.safeParse(input.start);
  if (!start.success) throw fail("the design review start is invalid");
  if (current.designReview !== undefined) throw fail("design review is already on for this task");
  if (current.definitionVersion !== "1.1.0" || current.stage !== "PLAN" || current.state !== "READY"
    || current.artifacts.some((artifact) => artifact.type === "design" || artifact.type === "plan")) {
    throw fail("design review can be switched on only while the task is ready to plan, before any design exists");
  }
  if (current.program?.steps.some((step) => step.kind === "plan_critic") !== true) throw fail("this sequence has no plan check step to review the design in");
  const intent = current.intent;
  const assessment = intent?.assessment?.kind === "ready" ? { ...intent.assessment, path: "FULL" as const } : intent?.assessment;
  const review: WorkflowDesignReview = { ...start.data, status: "estimating", spentUsd: 0, rounds: [] };
  return WorkflowSnapshotSchema.parse({
    ...current, revision: current.revision + 1, path: "FULL", reviewPhase: current.path === "FULL" ? current.reviewPhase : "REQUIREMENTS", designReview: review,
    ...(intent === undefined || assessment === undefined ? {} : { intent: { ...intent, assessment } }), updatedAt: input.now,
  });
}

// ---- before the reviewers run

/** The estimate is over the cap, or there is no price: a person decides the spend (the approve_spend card). Nothing runs until they do. */
export function holdDesignReviewForCost(currentInput: unknown, input: { expectedRevision: number; estimateUsd?: number; now: string }): WorkflowSnapshot {
  const { current, review } = located(currentInput, input.expectedRevision, { stage: "PLAN_CRITIQUE", states: ["READY"], statuses: ["estimating"] });
  return moved(current, { stage: "PLAN_CRITIQUE", state: "WAITING", review: { ...review, status: "waiting_cost", ...(input.estimateUsd === undefined ? {} : { estimateUsd: input.estimateUsd }) }, now: input.now });
}

/**
 * The reviewers start: from READY, or from the cost hold once a person approved the spend (`costApproved`; without it the hold stays). Round 1 and round 2 start the same way.
 */
export function startDesignReview(currentInput: unknown, input: { expectedRevision: number; estimateUsd?: number; costApproved?: true; now: string }): WorkflowSnapshot {
  const { current, review } = located(currentInput, input.expectedRevision, { stage: "PLAN_CRITIQUE", states: ["READY", "WAITING"], statuses: ["estimating", "waiting_cost"] });
  if (review.status === "waiting_cost" && input.costApproved !== true) throw fail("the design review is waiting for the spend to be approved");
  if ((review.status === "estimating") !== (current.state === "READY")) throw fail("the workflow is not at that step of the design review");
  if (review.rounds.length >= DESIGN_REVIEW_ROUNDS_MAX) throw fail("the design review has used its rounds");
  const { notRunReason: _reason, ...kept } = review;
  void _reason;
  return moved(current, { stage: "PLAN_CRITIQUE", state: "RUNNING", review: { ...kept, status: "running", ...(input.estimateUsd === undefined ? {} : { estimateUsd: input.estimateUsd }) }, now: input.now });
}

/** The reviewers' model could not be used (the account has no access to it): the same round is tried again on the next model. The caller bounds the attempts; this only moves the workflow. */
export function retryDesignReview(currentInput: unknown, input: { expectedRevision: number; now: string }): WorkflowSnapshot {
  const { current, review } = located(currentInput, input.expectedRevision, { stage: "PLAN_CRITIQUE", states: ["RUNNING"], statuses: ["running"] });
  return moved(current, { stage: "PLAN_CRITIQUE", state: "READY", review: { ...review, status: "estimating" }, now: input.now });
}

// ---- a round's result

type NotRunReason = (typeof DESIGN_REVIEW_NOT_RUN_REASONS)[number];

/** Why no reviewer gave a result: an integrity failure outranks a timeout, which outranks a worker that failed. */
function whyNoResult(runs: readonly ReviewerRun[]): NotRunReason {
  if (runs.some((run) => run.verifyFailure !== undefined && run.verifyFailure !== "timeout" && run.verifyFailure !== "unreadable_output")) return "inputs_unverified";
  if (runs.some((run) => run.verifyFailure === "timeout")) return "timeout";
  return "worker_failed";
}

function sizeChecked(review: WorkflowDesignReview): WorkflowDesignReview {
  if (new TextEncoder().encode(JSON.stringify(review)).length > DESIGN_REVIEW_RECORD_MAX_BYTES) throw fail("the design review record is too large to keep");
  return review;
}

/**
 * One round's result: the reviewers' runs (with whether each was verified fresh and read-only), the merged findings, and what the round spent. Only verified reviewers count: a finding
 * from any other is refused. Where it goes next:
 * - no reviewer gave a result: the person decides (PLAN_REVIEW). The first round is `not_run` with the reason; a later round leaves the review `done` with `notRunReason` set;
 * - the cost cap was reached (`stoppedAtCap`, or the round overspent `capUsd`): `stopped_at_cap`, the findings go to the person unresolved;
 * - no findings, or the loop ended early (a finding of round 2 would undo an earlier fix: `undoesEarlierFix`): `done`, the person decides;
 * - otherwise the planner resolves each finding (PLAN/READY, "resolving"). A finding that an earlier round's contest or decline already settled stays settled (it is carried over, and the
 *   planner is not asked about it again); if that leaves nothing for the planner, the review is `done`.
 */
export function submitDesignReview(
  currentInput: unknown,
  input: {
    expectedRevision: number; designDigest: string; reviewers: readonly unknown[]; findings: readonly unknown[]; mergeModel?: unknown; mergeCostUsd?: number;
    undoesEarlierFix?: readonly string[]; stoppedAtCap?: true; capUsd?: number; now: string;
  },
): WorkflowSnapshot {
  const { current, review } = located(currentInput, input.expectedRevision, { stage: "PLAN_CRITIQUE", states: ["RUNNING"], statuses: ["running"] });
  if (review.rounds.length >= DESIGN_REVIEW_ROUNDS_MAX) throw fail("the design review has used its rounds");
  const design = latestDesign(current);
  if (design === undefined || design.sha256 !== input.designDigest) throw fail("the reviewers did not read the current design");
  const roundNumber = (review.rounds.length + 1) as 1 | 2;

  const runs = z.array(ReviewerRunSchema).safeParse(input.reviewers);
  const found = z.array(DesignFindingSchema).safeParse(input.findings);
  const mergeModel = input.mergeModel === undefined ? undefined : DesignModelRefSchema.safeParse(input.mergeModel);
  if (!runs.success || !found.success || (mergeModel !== undefined && !mergeModel.success)) throw fail("the design review result is invalid");
  if (new Set(runs.data.map((run) => run.role)).size !== runs.data.length) throw fail("a reviewer role ran twice in one round");
  const mergeCost = input.mergeCostUsd ?? 0;
  if (!Number.isFinite(mergeCost) || mergeCost < 0 || mergeCost > 10_000) throw fail("the design review result is invalid");

  const verifiedRoles = new Set(runs.data.filter((run) => run.verified).map((run) => run.role));
  const ids = new Set<string>();
  const rawIds = new Set<string>();
  const findings: DesignFinding[] = found.data.map((finding) => {
    if (ids.has(finding.id)) throw fail("two findings share an id");
    ids.add(finding.id);
    for (const raw of finding.rawIds) {
      if (rawIds.has(raw)) throw fail("a reviewer's finding was merged into two findings");
      rawIds.add(raw);
    }
    if (finding.fromReviewers.some((role) => !verifiedRoles.has(role))) throw fail("a finding came from a reviewer whose result does not count");
    return { ...finding, fingerprint: designFindingFingerprint(finding) };
  });
  const oscillation = [...new Set(input.undoesEarlierFix ?? [])];
  if (oscillation.length > 0 && (roundNumber === 1 || oscillation.some((id) => !ids.has(id)))) throw fail("only a finding of a later round can undo an earlier fix");

  // A contest or a decline from an earlier round stays settled when the same finding comes back (by fingerprint).
  const carried: FindingResolution[] = [];
  for (const finding of findings) {
    for (const earlier of review.rounds) {
      const before = earlier.findings.find((candidate) => candidate.fingerprint === finding.fingerprint);
      const resolution = before === undefined ? undefined : resolutionOf(earlier, before.id);
      if (resolution !== undefined && resolution.settled && (resolution.action === "contested" || resolution.action === "declined")) {
        carried.push({ findingId: finding.id, action: resolution.action, ...(resolution.evidence === undefined ? {} : { evidence: resolution.evidence }), note: SETTLED_NOTE, settled: true });
        break;
      }
    }
  }

  const round = DesignReviewRoundSchema.safeParse({
    round: roundNumber, designDigest: input.designDigest, reviewers: runs.data, findings, resolutions: carried,
    ...(oscillation.length === 0 ? {} : { oscillation }), ...(mergeModel?.success === true ? { mergeModel: mergeModel.data } : {}),
  });
  if (!round.success) throw fail("the design review result is invalid");
  const spentUsd = addUsd(addUsd(review.spentUsd, runs.data.reduce((sum, run) => addUsd(sum, run.costUsd), 0)), mergeCost);
  const base: WorkflowDesignReview = { ...review, spentUsd, rounds: [...review.rounds, round.data] };
  const end = (status: WorkflowDesignReview["status"], extra: Partial<WorkflowDesignReview> = {}): WorkflowSnapshot =>
    moved(current, { stage: "PLAN_REVIEW", state: "WAITING", review: sizeChecked({ ...base, status, ...extra }), now: input.now });

  if (!designRoundHasResult(round.data)) {
    const reason = whyNoResult(runs.data);
    return review.rounds.length === 0 ? end("not_run", { notRunReason: reason }) : end("done", { notRunReason: reason });
  }
  if (input.stoppedAtCap === true || (input.capUsd !== undefined && spentUsd > input.capUsd)) return end("stopped_at_cap");
  if (findings.length === 0 || oscillation.length > 0 || designRoundResolved(round.data)) return end("done");
  return moved(current, { stage: "PLAN", state: "READY", review: sizeChecked({ ...base, status: "resolving" }), now: input.now });
}

// ---- the planner's side

/**
 * The planner cannot resolve every finding without a person (it would otherwise guess): it asks. One question card per round, one to DESIGN_REVIEW_QUESTIONS_MAX questions. The workflow
 * waits (PLAN/WAITING, "waiting_answers") and nothing runs or spends until `answerDesignQuestions`. Nobody approves or answers for the person.
 */
export function askDesignQuestions(currentInput: unknown, input: { expectedRevision: number; questions: readonly unknown[]; now: string }): WorkflowSnapshot {
  const { current, review } = located(currentInput, input.expectedRevision, { stage: "PLAN", states: ["RUNNING"], statuses: ["resolving"] });
  const round = lastRound(review);
  if (round === undefined || round.questions !== undefined) throw fail("a round asks one question card");
  if (review.rounds.length >= DESIGN_REVIEW_ROUNDS_MAX) throw fail("the last round does not ask: it is fixed or contested only");
  const questions = z.array(DesignQuestionSchema).min(1).max(DESIGN_REVIEW_QUESTIONS_MAX).safeParse(input.questions);
  if (!questions.success || new Set(questions.data.map((question) => question.id)).size !== questions.data.length) throw fail("the design questions are invalid");
  return moved(current, { stage: "PLAN", state: "WAITING", review: { ...review, status: "waiting_answers", rounds: withLastRound(review, { ...round, questions: questions.data }) }, now: input.now });
}

function cleanText(text: string): string {
  return Array.from(redactText(text).replace(/\r\n?/gu, "\n").replace(/[\p{Cc}\p{Cf}]/gu, (character) => (character === "\n" ? "\n" : " ")).trim()).slice(0, DESIGN_ANSWER_TEXT_MAX).join("");
}

/**
 * A person answered the question card. Every question needs one answer (an option of that question, words, or both), the answers are cleaned (credentials redacted, control characters made
 * spaces) and kept with who gave them, and the planner runs again to resolve the findings (PLAN/READY). `by` is the person the broker authenticated and allowed (the requester, or the
 * high-risk approver for a high-risk question); nothing from the answer's own words says who they are.
 */
export function answerDesignQuestions(
  currentInput: unknown,
  input: { expectedRevision: number; answers: readonly unknown[]; by: { actorId: string }; now: string },
): WorkflowSnapshot {
  const { current, review } = located(currentInput, input.expectedRevision, { stage: "PLAN", states: ["WAITING"], statuses: ["waiting_answers"] });
  const round = lastRound(review);
  const questions = round?.questions;
  if (round === undefined || questions === undefined || round.answers !== undefined) throw fail("the workflow is not waiting for answers");
  const actor = ActorIdSchema.safeParse(input.by.actorId);
  const answers = z.array(DesignAnswerSchema).safeParse(input.answers);
  if (!actor.success || !answers.success) throw fail("the design answers are invalid");
  const byId = new Map(questions.map((question) => [question.id, question]));
  if (answers.data.length !== byId.size || new Set(answers.data.map((answer) => answer.questionId)).size !== answers.data.length || answers.data.some((answer) => !byId.has(answer.questionId))) {
    throw fail("every question needs exactly one answer");
  }
  const cleaned = answers.data.map((answer) => {
    if (answer.optionId !== undefined && byId.get(answer.questionId)?.options.some((option) => option.id === answer.optionId) !== true) throw fail("an answer is not one of the question's options");
    const text = answer.text === undefined ? undefined : cleanText(answer.text);
    if (answer.optionId === undefined && (text === undefined || text === "")) throw fail("each answer picks an option or says something");
    return { questionId: answer.questionId, ...(answer.optionId === undefined ? {} : { optionId: answer.optionId }), ...(text === undefined || text === "" ? {} : { text }) };
  });
  const ordered = questions.map((question) => cleaned.find((answer) => answer.questionId === question.id)!);
  const record = { ...round, answers: { by: { actorId: actor.data }, at: input.now, answers: ordered } };
  return moved(current, { stage: "PLAN", state: "READY", review: { ...review, status: "resolving", rounds: withLastRound(review, record) }, now: input.now });
}

/** Why a resolution is refused, or undefined when it may stand. Pure; the last round has only the two ways of answering a finding that cannot lose information: fix it or contest it with evidence. */
function resolutionProblem(resolution: FindingResolution, finding: DesignFinding, round: DesignReviewRound, lastRoundOfReview: boolean): string | undefined {
  const comprehension = finding.fromReviewers.includes("comprehension");
  if (resolution.action === "contested" && comprehension) return "a finding that the design was not understood cannot be contested";
  if (resolution.action === "declined" && (finding.severity !== "nit" || comprehension)) return "only a nit that is not about understanding may be declined";
  if (lastRoundOfReview && (resolution.action === "asked" || resolution.action === "declined")) return "the last round is fixed or contested only";
  if (resolution.action === "asked") {
    if (round.questions === undefined || round.answers === undefined) return "a finding can be asked about only after the question card was answered";
    if (resolution.questionId === undefined || !round.questions.some((question) => question.id === resolution.questionId)) return "an asked finding must name a question of this round";
  } else if (resolution.questionId !== undefined) return "only an asked finding names a question";
  return undefined;
}

/**
 * The planner's resolution of the round's findings (PLAN/RUNNING, "resolving"): exactly one for each finding the round did not already settle. Each is fixed (the design changed: a new design
 * document must come with it), contested (with evidence; never a comprehension finding), asked (after the question card was answered) or declined (a nit only). In the last round only fixed
 * or contested are allowed. Code sets `settled` (contested, declined and asked are settled; a fix is not, and stays open until a reviewer reads it again); the planner's value is ignored.
 * Where it goes next: a design-changing resolution of a blocker or major, with a round left, sends the revised design to its second round (PLAN_CRITIQUE/READY, "estimating"); anything
 * else ends at the person (PLAN_REVIEW). Disagreements are never resolved here: a contested blocker is listed for the approver (`designReviewDisagreements`).
 */
export function resolveDesignReview(
  currentInput: unknown,
  input: { expectedRevision: number; resolutions: readonly unknown[]; artifact?: unknown; now: string },
): WorkflowSnapshot {
  const { current, review } = located(currentInput, input.expectedRevision, { stage: "PLAN", states: ["RUNNING"], statuses: ["resolving"] });
  const round = lastRound(review);
  if (round === undefined || designReviewRevisionsUsed(review) >= DESIGN_REVIEW_REVISIONS_MAX || designRoundResolved(round)) throw fail("there is nothing for the planner to resolve");
  const resolutions = z.array(FindingResolutionSchema).safeParse(input.resolutions);
  if (!resolutions.success) throw fail("the resolutions are invalid");
  const pending = round.findings.filter((finding) => resolutionOf(round, finding.id) === undefined);
  const byFinding = new Map(resolutions.data.map((resolution) => [resolution.findingId, resolution]));
  if (byFinding.size !== resolutions.data.length || byFinding.size !== pending.length || pending.some((finding) => !byFinding.has(finding.id))) {
    throw fail("every open finding needs exactly one resolution");
  }
  const finalRound = review.rounds.length >= DESIGN_REVIEW_ROUNDS_MAX;
  const settled: FindingResolution[] = [];
  for (const finding of pending) {
    const resolution = byFinding.get(finding.id)!;
    const problem = resolutionProblem(resolution, finding, round, finalRound);
    if (problem !== undefined) throw fail(problem);
    settled.push({ ...resolution, settled: resolution.action !== "fixed" });
  }
  const changesDesign = settled.some((resolution) => resolution.action === "fixed" || resolution.action === "asked");
  const previous = latestDesign(current);
  let artifacts = current.artifacts;
  if (input.artifact !== undefined || changesDesign) {
    const artifact = WorkflowArtifactSchema.safeParse(input.artifact);
    if (!artifact.success || artifact.data.type !== "design" || previous === undefined || artifact.data.sha256 === previous.sha256) throw fail(changesDesign ? "a fixed finding needs a changed design document" : "the design document is invalid");
    artifacts = [...current.artifacts, artifact.data];
  }
  const resolved: DesignReviewRound = { ...round, resolutions: [...round.resolutions, ...settled] };
  const next: WorkflowDesignReview = { ...review, rounds: withLastRound(review, resolved) };
  const revisedForRound2 = !finalRound && round.findings.some((finding) => {
    const resolution = resolutionOf(resolved, finding.id);
    return finding.severity !== "nit" && (resolution?.action === "fixed" || resolution?.action === "asked");
  });
  return revisedForRound2
    ? moved(current, { stage: "PLAN_CRITIQUE", state: "READY", review: sizeChecked({ ...next, status: "estimating" }), artifacts, now: input.now })
    : moved(current, { stage: "PLAN_REVIEW", state: "WAITING", review: sizeChecked({ ...next, status: "done" }), artifacts, now: input.now });
}

// ---- ending it

/**
 * The review ends and the design goes to the person (PLAN_REVIEW/WAITING, the approve_design card) with whatever was found. Allowed from any step except while a person's answer is owed
 * (no answer, no approval: that wait is parked and closed by its own timers, never ended here) and from PLAN while the planner has not resolved (its revision failed: the design goes as
 * reviewed, findings unresolved).
 * - `not_run` needs a reason; with no round recorded the review is `not_run`, with one it stays `done` and `notRunReason` says the later round did not run;
 * - `stopped_at_cap` is the cost cap reached before or between rounds;
 * - `finished` ends a review that has at least one round.
 */
export function closeDesignReview(
  currentInput: unknown,
  input: { expectedRevision: number; outcome: "finished" | "stopped_at_cap" | "not_run"; notRunReason?: NotRunReason; now: string },
): WorkflowSnapshot {
  const current = parsed(currentInput);
  if (current.revision !== input.expectedRevision) throw fail("workflow revision is stale");
  const review = current.designReview;
  const at = current.stage === "PLAN_CRITIQUE" ? ["READY", "RUNNING", "WAITING"] : current.stage === "PLAN" ? ["READY", "RUNNING"] : [];
  const waitingForAnswers = review?.status === "waiting_answers";
  if (review === undefined || current.reviewPhase !== "DESIGN" || !at.includes(current.state) || waitingForAnswers
    || (current.stage === "PLAN" && review.status !== "resolving") || (current.stage === "PLAN_CRITIQUE" && review.status === "resolving")) {
    throw fail("the workflow is not at a step where the design review can end");
  }
  const reason = input.notRunReason === undefined ? undefined : z.enum(DESIGN_REVIEW_NOT_RUN_REASONS).safeParse(input.notRunReason);
  if (input.outcome === "not_run" ? reason?.success !== true : input.notRunReason !== undefined) throw fail("a review that did not run says why, and no other end does");
  if (input.outcome === "finished" && review.rounds.length === 0) throw fail("a review with no round did not finish");
  const { estimateUsd: _estimate, ...kept } = review;
  void _estimate;
  const later = review.rounds.length > 0;
  const next: WorkflowDesignReview = input.outcome === "stopped_at_cap" ? { ...kept, status: "stopped_at_cap" }
    : input.outcome === "finished" ? { ...kept, status: "done" }
      : { ...kept, status: later ? "done" : "not_run", notRunReason: reason!.data! };
  return moved(current, { stage: "PLAN_REVIEW", state: "WAITING", review: next, now: input.now });
}
