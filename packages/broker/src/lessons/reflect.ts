// Learning v2 L1: the reflector (design §4.5.1). One tool-less model call per finished task, and a nightly pass. Its output is schema-checked JSON that
// code turns into lesson drafts; the model never writes to a store. Any parse failure drops the whole output, with no retry loop.
import { randomUUID } from "node:crypto";
import { cleanForLearning, requestsCapabilityChange } from "./guards.js";
import { emitAudit, learningCaps, modeAllows, resolveLearning, type Edition, type LearningSettingsReader } from "./policy.js";
import type { Clock, LearningSpend, LessonAuditSink, Metrics, PipelineModel } from "./ports.js";
import { buildReflectorInput, type MarkedSpan, type ReflectSubject } from "./reflect-input.js";
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
  /** A fixed code: mode_off, spend_refused, night_cap, model_error, over_cap, parse_error, no_candidates, or an ineligible reason. */
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
}

const MAX_OUTPUT_TOKENS = 1800;
/** Kinds a person writes. Plans are agent text, and outcomes, CI output and loaded lessons are not people. */
const PERSON_KINDS: ReadonlySet<string> = new Set(["send_back", "remembered", "human_edit", "close_reason", "review_finding", "intent"]);

function parseJson(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/iu, "").replace(/\s*```$/u, "");
  return JSON.parse(trimmed);
}
const shaMatches = (cited: string, known: string | undefined): boolean => known !== undefined && cited.length >= 7 && (known === cited || known.startsWith(cited));

/**
 * Reflects on one finished task (or one set of recent facts). Never throws and never blocks the task: every failure is a fixed `reason`.
 * `budget`, when given, is the nightly budget this call draws from.
 */
export async function reflectSubject(deps: ReflectDeps, subject: ReflectSubject, budget?: NightlyBudget): Promise<ReflectResult> {
  const none = (status: ReflectStatus, reason: string, costUsd = 0): ReflectResult => ({ status, reason, drafts: [], costUsd });
  const resolved = await resolveLearning(deps.settings, subject.workspaceId, subject.project);
  if (!modeAllows(resolved.mode, "reflect")) return none("skipped", "mode_off");

  const input = buildReflectorInput(subject);
  if (!input.eligible) {
    deps.metrics?.count("learning.reflect_ineligible", { reason: input.reason });
    return none("ineligible", input.reason);
  }

  const caps = learningCaps(deps.edition, deps.capsOverride);
  const estimate = caps.perTaskUsd ?? 0.15;
  if (budget?.capUsd !== undefined && budget.spentUsd + estimate > budget.capUsd) return none("skipped", "night_cap");
  let admitted: boolean;
  try { admitted = await deps.spend.admit(subject.workspaceId, estimate); } catch { admitted = false; }
  if (!admitted) return none("skipped", "spend_refused");

  let reply: { text: string; costUsd: number; model: string };
  try {
    // The request has no field for tools: a pipeline model can only return text.
    reply = await deps.model.complete({ purpose: "reflect", system: input.system, user: input.user, maxOutputTokens: MAX_OUTPUT_TOKENS, workspaceId: subject.workspaceId, project: subject.project, budgetUsd: estimate });
  } catch {
    // The model's key held its cap in the company's spend ledger; whatever the failed call cost is settled from there. Nothing to give back here.
    deps.metrics?.count("learning.reflect_failed", { reason: "model_error" });
    return none("dropped", "model_error");
  }
  const cost = Number.isFinite(reply.costUsd) && reply.costUsd > 0 ? reply.costUsd : 0;
  // `cost` is the cap the call's key held (an upper bound): the nightly budget counts that, and the ledger books the real figure when the proxy has flushed it.
  if (budget !== undefined) budget.spentUsd += cost;
  if (caps.perTaskUsd !== undefined && cost > caps.perTaskUsd) {
    deps.metrics?.count("learning.reflect_failed", { reason: "over_cap" });
    return none("dropped", "over_cap", cost);
  }

  let output: { candidates: unknown[] };
  try { output = ReflectorOutputSchema.parse(parseJson(reply.text)); } catch {
    deps.metrics?.count("learning.reflect_failed", { reason: "parse_error" });
    return none("dropped", "parse_error", cost);
  }

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
  // C6: a lesson that asks for a change to tools, permissions, domains, budgets, models or approvals is refused and logged.
  if (requestsCapabilityChange(title, description, body)) {
    await emitAudit(deps.audit, { action: "lesson.refused", workspaceId: subject.workspaceId, project: subject.project, facts: { reason: "capability_request", run: runId, subject: subject.id } });
    return undefined;
  }

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
      ...everything.filter((s) => s.kind === "ci_failure" && s.trust === "rovara").map((s) => ({ kind: "ci_failure" as const, actor: s.authorId })),
    ],
  });
  return {
    type: candidate.type, title, description, body, scope: candidate.scope, stages: [...new Set(candidate.stages)], citations,
    provenance: {
      sourceEvents: [...events], sourceKinds: [...new Set(evidence.map((s) => s.kind))], authors, supportTasks: subject.kind === "task" ? [subject.id] : [], sources, inputSources, measured,
      minTrust: trust, audience, reflectorRun: runId, model: model.slice(0, 100),
      ...(sourceScopes.length === 0 ? {} : { sourceScopes }),
      memberSignal: evidence.some((s) => s.trust === "member" && (s.kind === "remembered" || s.kind === "human_edit")),
    },
  };
}
