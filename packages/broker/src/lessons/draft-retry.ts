// LP-13 C3: one bounded retry of a draft's curate-and-settle step (`processDraft`) for a passing store fault. Before this, a draft whose step failed was lost: the reflection that made it is final (its model call was
// paid for and is never repeated), so nothing ever tried the draft again.
//
// The money rule comes first. `processDraft` can make a model call of its own (the curator's judge), and the customer pays for every call. So the step is tried again only when ALL of these hold:
//   - the failed try made no model call: the judge model handed to it is counted, and a call that was started (whatever came of it: an answer, a refusal, an error) means no retry. That is stricter than the
//     worker's lease rule on purpose: here a call that failed early cannot be told from one that reached the provider;
//   - the fault is a passing one of the store: throttling, a 5xx, a transaction conflict, a timeout. A refused write, a validation fault or a bug is final;
//   - inside a worker attempt, the deadline has not passed (the signal is not aborted) and at least `DRAFT_RETRY_MIN_LEFT_MS` is left.
// Only one retry. The try that failed may have written part of its work (a candidate before the settle); a repeat finds that lesson and curates against it, so nothing is added twice.
import { currentLearningAttempt } from "./learning-deadline.js";
import type { PipelineModel } from "./ports.js";
import { processDraft, type ProcessDeps, type ProcessResult } from "./process.js";
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

/** `processDraft`, with the one bounded retry above. Throws the last fault, as `processDraft` does. */
export async function processDraftRetrying(deps: ProcessDeps, key: ScopeKey, draft: LessonDraft, options: DraftRetryOptions = {}): Promise<ProcessResult> {
  let modelCalls = 0;
  const judge: PipelineModel = deps.judgeModel;
  const counted: ProcessDeps = {
    ...deps,
    judgeModel: {
      ...(judge.quote === undefined ? {} : { quote: (request) => judge.quote!(request) }),
      complete: (request) => { modelCalls += 1; return judge.complete(request); },
    },
  };
  try {
    return await processDraft(counted, key, draft);
  } catch (error) {
    if (modelCalls > 0 || !isPassingStoreFault(error)) throw error;
    const attempt = currentLearningAttempt();
    if (attempt !== undefined && (attempt.signal?.aborted === true || (attempt.deadlineAt - (options.now ?? Date.now)()) < DRAFT_RETRY_MIN_LEFT_MS)) throw error;
    options.log?.("learning.draft_retried", {});
    await (options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms))))(DRAFT_RETRY_WAIT_MS);
    // The retry is the last try. Its own judge call, if it makes one, is the first one this draft makes (the failed try made none).
    if (attempt?.signal?.aborted === true) throw error;
    return processDraft(deps, key, draft);
  }
}
