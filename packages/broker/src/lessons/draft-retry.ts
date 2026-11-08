// LP-13 C3: one bounded retry of a draft's curate-and-settle step (`processDraft`) for a passing store fault. Before this, a draft whose step failed was lost: the reflection that made it is final (its model call was
// paid for and is never repeated), so nothing ever tried the draft again.
//
// The money rule comes first. The curate step can make a paid judge call of its own, and the customer pays for every call. So a draft is tried again only when ALL of these hold:
//   - the failed try started no paid judge call: the judge model handed to it is counted, and a call that was started (whatever came of it: an answer, a refusal, an error) means no retry. That is stricter than the
//     worker's lease rule on purpose: here a call that failed early cannot be told from one that reached the provider. (Our own embedder is not a paid call and may be asked again.);
//   - the fault is a passing one of the store: throttling, a 5xx, a transaction conflict, a timeout. A refused write, a validation fault or a bug is final;
//   - inside a worker attempt, the deadline has not passed (the signal is not aborted) and at least `DRAFT_RETRY_MIN_LEFT_MS` is left.
// Only one retry.
//
// A retry must not do again what the failed try already did. The two steps are kept apart, so a retry resumes where the failure was:
//   - a fault in the SETTLE step (the lesson was already added or merged by the curate step): only settle runs again, with the curate step's answer; the lesson is not curated (merged into itself) a second time;
//   - a fault in the CURATE step: the curate step runs again (its last write is its own commit, so a fault in it means nothing of the draft was kept; the steps after the commit never throw);
//   - audit lines the failed try already wrote (same action, same lesson) are not written again by the retry;
//   - the draft's sources and the project's volume are counted once: a retry of the curate step skips the count when the failed try already made it.
import { curateDraft, type CurateOutcome } from "./curate.js";
import { currentLearningAttempt } from "./learning-deadline.js";
import type { LessonAuditEvent, LessonAuditSink, PipelineModel } from "./ports.js";
import { settleLesson, settleOptionsOf, type ProcessDeps, type ProcessResult } from "./process.js";
import type { LessonDraft } from "./reflect.js";
import type { ScopeKey } from "./store.js";

/** In a worker attempt, a retry needs at least this much of the deadline left (a curate step with a judge call can take several seconds). */
export const DRAFT_RETRY_MIN_LEFT_MS = 5_000;
/** The wait before the retry: a throttled table is given a moment. */
export const DRAFT_RETRY_WAIT_MS = 250;

const PASSING_FAULTS: ReadonlySet<string> = new Set([
  "ThrottlingException", "ProvisionedThroughputExceededException", "RequestLimitExceeded", "TooManyRequestsException", "InternalServerError", "InternalFailure",
  "ServiceUnavailable", "ServiceUnavailableException", "TransactionConflictException", "TimeoutError", "RequestTimeout", "RequestTimeoutException",
]);

/** Whether a store fault is a passing one worth a second try. Names and statuses only: the fault's own words are never read. */
export function isPassingStoreFault(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const fault = error as { name?: unknown; $metadata?: { httpStatusCode?: unknown } };
  if (typeof fault.name === "string" && PASSING_FAULTS.has(fault.name)) return true;
  const status = fault.$metadata?.httpStatusCode;
  return typeof status === "number" && status >= 500;
}

export interface DraftRetryOptions {
  log?: ((event: string, fields: Record<string, string | number>) => void) | undefined;
  /** The wait before the retry (default: a timer of `DRAFT_RETRY_WAIT_MS`). */
  sleep?: ((ms: number) => Promise<void>) | undefined;
  now?: (() => number) | undefined;
}

/** The key an audit line is told apart by: what happened to which lesson. */
const auditKey = (event: LessonAuditEvent): string => `${event.action}|${event.lessonId ?? ""}`;

/** `processDraft`, with the one bounded retry above. Throws the last fault, as `processDraft` does. */
export async function processDraftRetrying(deps: ProcessDeps, key: ScopeKey, draft: LessonDraft, options: DraftRetryOptions = {}): Promise<ProcessResult> {
  let modelCalls = 0, noted = false;
  const written = new Set<string>();
  const judge: PipelineModel = deps.judgeModel;
  const store = new Proxy(deps.store, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver) as unknown;
      if (typeof value !== "function") return value;
      const method = (value as (...args: unknown[]) => unknown).bind(target);
      if (property === "recordSourceEvent") return (...args: unknown[]) => { noted = true; return method(...args); };
      return method;
    },
  });
  const audit: LessonAuditSink = {
    emit: async (event, emitOptions) => { await deps.audit.emit(event, emitOptions); written.add(auditKey(event)); },
    ...(deps.audit.stage === undefined ? {} : { stage: (event: LessonAuditEvent) => deps.audit.stage!(event) }),
  };
  const first: ProcessDeps = {
    ...deps, store, audit,
    judgeModel: {
      ...(judge.quote === undefined ? {} : { quote: (request) => judge.quote!(request) }),
      complete: (request) => { modelCalls += 1; return judge.complete(request); },
    },
  };
  let step: "curate" | "settle" = "curate";
  let outcome: CurateOutcome | undefined;
  const settle = async (using: ProcessDeps): Promise<ProcessResult> => {
    step = "settle";
    if (outcome === undefined || outcome.outcome === "dropped") return { outcome: outcome! };
    const lesson = await settleLesson(using, key, outcome.lesson.id, settleOptionsOf(outcome));
    return lesson === undefined ? { outcome } : { outcome, lesson };
  };
  try {
    outcome = await curateDraft(first, key, draft);
    step = "settle";
    return await settle(first);
  } catch (error) {
    if (modelCalls > 0 || !isPassingStoreFault(error)) throw error;
    const attempt = currentLearningAttempt();
    if (attempt !== undefined && (attempt.signal?.aborted === true || (attempt.deadlineAt - (options.now ?? Date.now)()) < DRAFT_RETRY_MIN_LEFT_MS)) throw error;
    options.log?.("learning.draft_retried", {});
    await (options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms))))(DRAFT_RETRY_WAIT_MS);
    if (attempt?.signal?.aborted === true) throw error;
    const again: ProcessDeps = {
      ...deps, ...(noted ? { noSourceNote: true } : {}),
      // A line the failed try wrote is not written again (the retry is told it succeeded).
      audit: { emit: async (event, emitOptions) => { if (!written.has(auditKey(event))) await deps.audit.emit(event, emitOptions); }, ...(deps.audit.stage === undefined ? {} : { stage: (event: LessonAuditEvent) => deps.audit.stage!(event) }) },
    };
    if (step === "curate") {
      outcome = await curateDraft(again, key, draft);
      step = "settle";
    }
    return settle(again);
  }
}
