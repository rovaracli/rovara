// Learning v2 L1: the reflector (design §4.5.1). One tool-less model call per finished task, and a nightly pass. Its output is schema-checked JSON that
// code turns into lesson drafts; the model never writes to a store. Any parse failure drops the whole output, with no retry loop.
import { randomUUID } from "node:crypto";
import { cleanForLearning } from "./guards.js";
import { currentLearningAttempt } from "./learning-deadline.js";
import { isLearningRefusal, noteModelFailure, notePause, noteRecovered, pauseOfLook, spendLook, type LessonsPauseStore } from "./pause.js";
import { learningCaps, modeAllows, resolveLearning, type Edition, type LearningSettingsReader } from "./policy.js";
import type { Clock, LearningSpend, LessonAuditSink, Metrics, PipelineModel } from "./ports.js";
import { buildReflectorInput, type MarkedSpan, type ReflectSubject } from "./reflect-input.js";
import { NO_REASON_TEXT } from "./task-subject.js";
import { lessonClaimsSupported } from "./trial.js";
import {
  LessonCandidateSchema, ReflectorOutputSchema, distinctIds, idIn, minTrust, narrowestAudience, normSource, sameId,
  type Audience, type LessonCitation, type LessonProvenance, type LessonScope, type LessonStage, type LessonType, type TrustClass,
} from "./types.js";

/** An outcome event and the person who caused it: whoever reverted, sent back, or pushed the revision that failed CI. */
export interface OutcomeEvent { kind: "revert" | "send_back" | "ci_failure"; actor: string | undefined }
/**
 * The one rule for a measured outcome, the same for every kind: a person stands behind the lesson, and the event's actor is KNOWN and is neither one of the
 * lesson's authors nor the task's initiator. Missing ids never count (fail closed): a revert, a send-back or a CI failure of someone's own making is not
 * independent evidence.
 */
export function isMeasured(input: { authors: readonly string[]; initiatorId: string | undefined; events: readonly OutcomeEvent[] }): boolean {
  if (input.authors.length === 0 || input.initiatorId === undefined) return false;
  // Ids are compared without case, so "Ann" and "ann" are one person.
  return input.events.some((e) => e.actor !== undefined && !idIn(input.authors, e.actor) && !sameId(e.actor, input.initiatorId!));
}

/** A lesson as the reflector proposes it, checked by code, with its provenance. It is not yet in any store. */
export interface LessonDraft {
  type: LessonType; title: string; description: string; body: string; scope: LessonScope; stages: LessonStage[]; citations: LessonCitation[];
  provenance: LessonProvenance;
}

export type ReflectStatus = "ok" | "skipped" | "ineligible" | "dropped";
export interface ReflectResult {
  status: ReflectStatus;
  /** A fixed code: mode_off, spend_refused, learning_paused, night_cap, model_error, over_cap, parse_error, no_candidates, or an ineligible reason. */
  reason: string;
  drafts: LessonDraft[];
  costUsd: number;
}

export interface NightlyBudget { spentUsd: number; capUsd?: number }
export interface ReflectDeps {
  model: PipelineModel; spend: LearningSpend; audit: LessonAuditSink; settings: LearningSettingsReader; edition: Edition;
  now: Clock; metrics?: Metrics; newId?: () => string;
  /** Overrides the edition's default caps (tests, and a Public workspace's own limits). */
  capsOverride?: { perTaskUsd?: number; perNightUsd?: number };
  /** Where "lessons paused" is recorded when learning cannot run, and cleared when a call succeeds. Absent: nothing is recorded. */
  pause?: LessonsPauseStore;
}

const MAX_OUTPUT_TOKENS = 1800;
/**
 * The kinds of cited span that are a member's own correction of Rovara's work (DECISIONS 24): a send-back, a human edit (including a member's review comment on the pull request), "remember this",
 * and a member's reason for closing. A plan, an agent's review finding, CI text and the task's own wording are not corrections.
 */
const CORRECTION_KINDS: ReadonlySet<string> = new Set(["send_back", "human_edit", "remembered", "close_reason", "review_finding"]);
/** Source keys that are not a member speaking to Rovara: Slack, trackers, MCP sources and code comments. A lesson that cites one never goes live on trial. */
const EXTERNAL_SOURCE = /^\s*(slack|linear|jira|mcp|code|comment)\b/iu;

/**
 * Whether a lesson counts as drafted from a project member's own correction. Worked out from the spans the lesson CITES (never from every span in the task, so a plan or finding that Rovara wrote
 * does not take it away, and uncited text cannot give it). An ALLOW-LIST: EVERY cited span must itself be a member's own correction (trust member, a known author, a correction kind, not a sentence
 * chosen by code such as the no-reason send-back, not from Slack, a tracker, an MCP source or a code comment, not restricted); a lesson that also cites a plan, an agent finding, CI text, the task's
 * wording or a loaded lesson goes to a person. Nothing the model read may be an outsider's (`everythingTrust`, the lowest trust of the whole input; outsiders are removed before the model call, this is the
 * second line). Whether the lesson's WORDS rest on those spans is the other half of the rule (`claimsSupported`).
 *
 * Integration rule (LT-1 / lane 1 capture): a span of kind `human_edit` or `review_finding` may carry trust `member` only when the code-host account that wrote it is resolved to a person with a role in this
 * project. Never from a git commit author or committer e-mail (anyone can set it), never from GitHub `author_association` alone, and a commenter on a public repository who has a Rovara account but no role in
 * the project is an outsider.
 */
export function memberCorrectionOf(cited: readonly MarkedSpan[], everythingTrust: TrustClass): boolean {
  if (everythingTrust === "outsider" || cited.length === 0) return false;
  return cited.every((s) => s.trust === "member" && s.authorId !== undefined && CORRECTION_KINDS.has(s.kind) && s.fixedText !== true && s.text !== NO_REASON_TEXT
    && s.audience?.kind !== "restricted" && !(s.sourceKey !== undefined && EXTERNAL_SOURCE.test(s.sourceKey)));
}

/** The source key of CI failures, as the subject source writes it. */
const CI_SOURCE_KEY = "ci";
/** Kinds a person writes. Plans are agent text, and outcomes, CI output and loaded lessons are not people. */
const PERSON_KINDS: ReadonlySet<string> = new Set(["send_back", "remembered", "human_edit", "close_reason", "review_finding", "intent"]);

function parseJson(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/iu, "").replace(/\s*```$/u, "");
  return JSON.parse(trimmed);
}
const shaMatches = (cited: string, known: string | undefined): boolean => known !== undefined && cited.length >= 7 && (known === cited || known.startsWith(cited));

/**
 * Counts a failed model call toward the project's `model_failed` pause, once per REFLECTION (re-check R3). Inside the worker a failure that came before the call and that the worker will try again is not counted
 * (`fault` is retryable and another attempt is left): one task's retries cannot trip the 3-in-a-row pause. The last attempt's retryable fault, and every final failure, are counted once.
 */
async function countFailure(deps: ReflectDeps, subject: ReflectSubject): Promise<void> {
  const attempt = currentLearningAttempt();
  if (attempt?.fault === "retryable" && attempt.lastAttempt !== true) return;
  await noteModelFailure(deps.pause, subject.workspaceId, subject.project);
}

/**
 * Reflects on one finished task (or one set of recent facts). Never throws and never blocks the task: every failure is a fixed `reason`.
 * `budget`, when given, is the nightly budget this call draws from.
 */
export async function reflectSubject(deps: ReflectDeps, subject: ReflectSubject, budget?: NightlyBudget): Promise<ReflectResult> {
  const none = (status: ReflectStatus, reason: string, costUsd = 0): ReflectResult => ({ status, reason, drafts: [], costUsd });
  const resolved = await resolveLearning(deps.settings, subject.workspaceId, subject.project);
  if (!modeAllows(resolved.mode, "reflect")) return none("skipped", "mode_off");

  // LV-1 M2: more inherited tasks than a lesson can name would be cut, and a cut list leaks: nothing is reflected (before any model call).
  const inherited = [...new Set(subject.inheritedTasks ?? [])].filter((id) => id !== subject.id);
  if (inherited.length > 50) { deps.metrics?.count("learning.reflect_ineligible", { reason: "inherited_overflow" }); return none("ineligible", "inherited_overflow"); }

  const input = buildReflectorInput(subject);
  if (!input.eligible) {
    deps.metrics?.count("learning.reflect_ineligible", { reason: input.reason });
    return none("ineligible", input.reason);
  }

  const caps = learningCaps(deps.edition, deps.capsOverride);
  const request = { purpose: "reflect" as const, system: input.system, user: input.user, maxOutputTokens: MAX_OUTPUT_TOKENS, workspaceId: subject.workspaceId, project: subject.project };
  // The hold is sized to the call by the model itself (the cheapest suitable model's worst-case price for this prompt). A model that cannot quote keeps the edition's fixed per-task figure.
  let estimate: number;
  const perTaskCap = caps.perTaskUsd;
  if (deps.model.quote !== undefined) {
    let quoted: Awaited<ReturnType<NonNullable<PipelineModel["quote"]>>>;
    try { quoted = await deps.model.quote(request); } catch { deps.metrics?.count("learning.reflect_failed", { reason: "model_error" }); await countFailure(deps, subject); return none("dropped", "model_error"); }
    if (!quoted.ok) { await notePause(deps.pause, subject.workspaceId, subject.project, quoted.code); return none("skipped", "learning_paused"); }
    estimate = quoted.usd;
    // Public keeps its per-task cap whatever the quote (owner rule "Public keeps the caps"): a call whose sized hold is above it is refused. Enterprise has none of its own (`learningCaps`).
    if (perTaskCap !== undefined && estimate > perTaskCap) { await notePause(deps.pause, subject.workspaceId, subject.project, "cost_too_high"); return none("skipped", "learning_paused"); }
  } else estimate = caps.perTaskUsd ?? 0.15;
  if (budget?.capUsd !== undefined && budget.spentUsd + estimate > budget.capUsd) return none("skipped", "night_cap");
  const look = await spendLook(deps.spend, subject.workspaceId, estimate);
  if (look !== "ok") {
    // The month is full (the company's), the call is larger than the month's whole cap (a cost problem), or the counter could not be read (a fault: nothing is recorded as a reason).
    const code = pauseOfLook(look);
    if (code !== undefined) await notePause(deps.pause, subject.workspaceId, subject.project, code);
    return none("skipped", "spend_refused");
  }

  let reply: { text: string; costUsd: number; model: string };
  try {
    // The request has no field for tools: a pipeline model can only return text.
    reply = await deps.model.complete({ ...request, budgetUsd: estimate });
  } catch (error) {
    if (isLearningRefusal(error)) {
      // Refused before the call: nothing was spent.
      await notePause(deps.pause, subject.workspaceId, subject.project, error.code);
      return none("skipped", "learning_paused");
    }
    // The model's key held its cap in the company's spend ledger; whatever the failed call cost is settled from there. A failed call may have spent money, so it counts toward the nightly budget (R6).
    if (budget !== undefined) budget.spentUsd += estimate;
    deps.metrics?.count("learning.reflect_failed", { reason: "model_error" });
    await countFailure(deps, subject);
    return none("dropped", "model_error");
  }
  const cost = Number.isFinite(reply.costUsd) && reply.costUsd > 0 ? reply.costUsd : 0;
  // `cost` is the cap the call's key held (an upper bound): the nightly budget counts that, and the ledger books the real figure when the proxy has flushed it.
  if (budget !== undefined) budget.spentUsd += cost;
  if (perTaskCap !== undefined && cost > perTaskCap) {
    deps.metrics?.count("learning.reflect_failed", { reason: "over_cap" });
    return none("dropped", "over_cap", cost);
  }

  let output: { candidates: unknown[] };
  try { output = ReflectorOutputSchema.parse(parseJson(reply.text)); } catch {
    // R3: a reply that cannot be used is a failed call (it was billed): it counts toward the project's model_failed pause, and clears nothing.
    deps.metrics?.count("learning.reflect_failed", { reason: "parse_error" });
    await noteModelFailure(deps.pause, subject.workspaceId, subject.project);
    return none("dropped", "parse_error", cost);
  }
  // Only a reply that parsed is a success: it clears the pause and the failure count.
  await noteRecovered(deps.pause, subject.workspaceId, subject.project);

  const runId = (deps.newId ?? randomUUID)();
  const drafts: LessonDraft[] = [];
  for (const raw of output.candidates) {
    // No flat cap: every valid candidate is collected (the prompt asks for at most 3; the output schema bounds a runaway reply at 20).
    const parsed = LessonCandidateSchema.safeParse(raw);
    if (!parsed.success) continue;
    const draft = await toDraft(deps, subject, input.spans, input.allowedTypes, parsed.data, runId, reply.model);
    if (draft !== undefined) drafts.push(draft);
  }
  return { status: "ok", reason: drafts.length === 0 ? "no_candidates" : "candidates", drafts, costUsd: cost };
}

async function toDraft(
  deps: ReflectDeps, subject: ReflectSubject, spans: Map<string, MarkedSpan>, allowedTypes: readonly LessonType[],
  candidate: ReturnType<typeof LessonCandidateSchema.parse>, runId: string, model: string,
): Promise<LessonDraft | undefined> {
  if (!allowedTypes.includes(candidate.type)) return undefined;
  // C1 again, in code: every cited span must exist and must not be an outsider's.
  const cited: MarkedSpan[] = [];
  for (const id of new Set(candidate.evidenceSpanIds)) {
    const span = spans.get(id);
    if (span === undefined || span.trust === "outsider") return undefined;
    cited.push(span);
  }
  // A lesson the model was shown can never be evidence for itself, whatever else is cited: loaded_lesson spans are dropped from the evidence, and a candidate
  // with nothing else behind it is dropped. They still count for trust and audience below (they were read).
  const evidence = cited.filter((s) => s.kind !== "loaded_lesson");
  if (evidence.length === 0) return undefined;
  const title = cleanForLearning(candidate.title, 80);
  const description = cleanForLearning(candidate.description, 160);
  const body = cleanForLearning(candidate.body, 600);
  if (title === "" || body === "") return undefined;
  // C6: a lesson that asks for a change to tools, permissions, domains, budgets, models or approvals is NOT dropped. It is kept as a person-approval lesson with a fixed reason
  // (`capability_request`, set by the tier step), so the approver sees it and decides; nothing is silently lost.

  const citations: LessonCitation[] = [];
  const events = new Set(evidence.flatMap((s) => (s.eventId === undefined ? [] : [s.eventId])));
  for (const citation of candidate.citations) {
    if (citation.kind === "code") {
      // C8: base or merged commit only, in the task's own repositories, never the pull request branch head.
      if (!subject.repositories.includes(citation.repo)) continue;
      if (!shaMatches(citation.commit, subject.baseCommit) && !shaMatches(citation.commit, subject.mergedCommit)) continue;
      citations.push(citation);
    } else if (citation.kind === "pr") {
      if (subject.links?.includes(citation.url) === true) citations.push(citation);
    } else if (citation.kind === "record") {
      if (events.has(citation.eventId)) citations.push(citation);
    } else if (subject.kind === "task" && citation.taskId === subject.id) {
      citations.push(citation);
    }
  }

  // LV-1 M2: also gated on the tasks behind the lessons loaded into the task (bounded by `reflectSubject` before it reaches here).
  const inheritedTasks = [...new Set(subject.inheritedTasks ?? [])].filter((id) => id !== subject.id).slice(0, 50);
  // Trust and audience come from EVERYTHING the model read, not what it chose to cite: the lowest trust and the narrowest audience of every span in the
  // prompt. Citations only decide what the lesson shows as its sources.
  const everything = [...spans.values()];
  const trust: TrustClass = minTrust(everything.map((s) => s.trust));
  if (trust === "outsider") return undefined;
  const audience: Audience = narrowestAudience([...everything.flatMap((s) => (s.audience === undefined ? [] : [s.audience])), ...(subject.audience === undefined ? [] : [subject.audience])]);
  // The places everything the model read came from: what the access records are asked about whenever the lesson is read.
  const sourceScopes = [...new Set([...everything.flatMap((s) => s.scopes ?? []), ...(subject.scopes ?? [])])].slice(0, 50);
  const sourceOf = (s: MarkedSpan): string => normSource(s.sourceKey ?? (s.authorId === undefined ? `kind:${s.kind}` : `member:${s.authorId}`));
  const sources = [...new Set(evidence.map(sourceOf))].slice(0, 20);
  // Spike detection counts every source the model read, so flood text it chose not to cite is still seen.
  const inputSources = [...new Set(everything.filter((s) => s.kind !== "loaded_lesson").map(sourceOf))].slice(0, 100);
  // Independence is counted in people: the canonical member ids of spans a PERSON wrote. Agent text (plan), system text, outcomes and channel or bucket keys
  // never make an author.
  const authors = distinctIds([...new Set(evidence.flatMap((s) => (s.trust === "member" && s.authorId !== undefined && PERSON_KINDS.has(s.kind) ? [s.authorId] : [])))]);
    // Measured outcomes come from structured facts in the input, never from which spans the model cited.
  // A send-back counts only when someone other than the lesson's own authors made it (a person cannot create a "measured outcome" by correcting their own task).
  // ONE function decides whether anything was measured, for every kind of outcome (a revert, a send-back, a CI failure).
  const measured = isMeasured({
    authors, initiatorId: subject.initiatorId,
    events: [
      ...(subject.outcome === "reverted" ? [{ kind: "revert" as const, actor: subject.revertedBy }] : []),
      ...everything.filter((s) => s.kind === "send_back" && s.trust === "member").map((s) => ({ kind: "send_back" as const, actor: s.authorId })),
      // A CI failure is a structured fact: it came through the source's CI path (`sourceKey` "ci", set by the broker's subject source, never by span text) whatever trust its text carries (worker-written text is
      // `system`); the older `rovara` trust still counts. It is a MEASURED outcome only when the failing revision was pushed by a person: the span's author is that known member, compared as for any outcome (not one of
      // the lesson's authors, not the task's initiator). A failure on a revision the agent pushed names no person, so it stays evidence in the prompt and measures nothing: the agent cannot corroborate its own lesson.
      ...everything.filter((s) => s.kind === "ci_failure" && (s.sourceKey === CI_SOURCE_KEY || s.trust === "rovara")).map((s) => ({ kind: "ci_failure" as const, actor: s.authorId })),
    ],
  });
  return {
    type: candidate.type, title, description, body, scope: candidate.scope, stages: [...new Set(candidate.stages)], citations,
    provenance: {
      sourceEvents: [...events], sourceKinds: [...new Set(evidence.map((s) => s.kind))], authors, supportTasks: subject.kind === "task" ? [subject.id] : [], ...(inheritedTasks.length === 0 ? {} : { inheritedTasks }), sources, inputSources, measured,
      minTrust: trust, audience, reflectorRun: runId, model: model.slice(0, 100),
      ...(sourceScopes.length === 0 ? {} : { sourceScopes }),
      memberSignal: evidence.some((s) => s.trust === "member" && (s.kind === "remembered" || s.kind === "human_edit")),
      memberCorrection: memberCorrectionOf(cited, trust),
      // The lesson's key words must appear in the cited correction or the cited code, and nowhere else: worked out here, where the correction text is in hand (it is never stored).
      claimsSupported: lessonClaimsSupported({ title, description, body, ...(candidate.scope.paths === undefined ? {} : { scopePaths: candidate.scope.paths }) }, {
        correctionTexts: cited.flatMap((s) => (s.text === undefined ? [] : [s.text])), code: citations.flatMap((c) => (c.kind === "code" ? [{ path: c.path, anchor: c.anchor }] : [])),
      }),
      ...(subject.sharedTask === true ? { fromSharedTask: true } : {}),
    },
  };
}
