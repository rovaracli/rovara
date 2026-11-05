// Live interaction F2: a light diagnosis of an error Rovara showed, answered by the same read-only turn an Ask gets: no tools, no saved session, only what the broker says about the error. The broker
// queued the request under its own route (ids only, a body an older service refuses); this asks the broker for the turn's context by the diagnosis id, runs the turn, and writes the answer back.
// Nothing is posted in Slack and no Slack thread, member or channel is involved.
//
// The service never decides who may ask, what the turn may know or who pays: the broker built the context after reading the requester's right again, or refused (then the diagnosis is failed in
// fixed words and nothing is retried in the background), and the broker mints the key. The context is never logged.
import { DIAGNOSIS_ANSWER_MAX_CHARS, DIAGNOSIS_TURN_QUESTION, DiagnosisAnsweredRequestSchema, DiagnosisTurnResultSchema, type DiagnosisAnsweredRequest, type DiagnosisFailureReason, type DiagnosisQueueMessage, type DiagnosisRef, type DiagnosisTurnResult } from "@agentx/contracts";
import { NO_TEXT_RESPONSE } from "@agentx/orchestrator/orchestrator";
import type { ServiceLog } from "./processor.js";

/** The broker's side of a diagnosis, as the service calls it (the control plane's `/v1/service/diagnoses/*`). */
export interface DiagnosisServiceApi {
  turn(ref: DiagnosisRef): Promise<DiagnosisTurnResult>;
  answered(request: DiagnosisAnsweredRequest): Promise<void>;
}

export interface DiagnosisDependencies {
  api: DiagnosisServiceApi;
  /** Runs the no-tools answer turn and returns the model's text; throws when there is none. `turn.taskContext` is the broker's text (its rules, then the data). */
  runTurn(input: { ref: DiagnosisRef; question: string; eventId: string; turn: DiagnosisTurnResult; retry?: true }): Promise<string>;
  log: ServiceLog;
  now?: () => number;
}

/** The answer cut to what the broker takes, never through a character pair. */
function cutAnswer(answer: string): string {
  if (answer.length <= DIAGNOSIS_ANSWER_MAX_CHARS) return answer;
  const cut = answer.slice(0, DIAGNOSIS_ANSWER_MAX_CHARS);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

/**
 * QA6-14: what a failed turn shows about why, as a fixed reason. The runtime's own failure sentence (`safeError`: one fixed sentence chosen from the HTTP status alone, never the provider's text) is matched
 * whole at its end; nothing of the text is kept. A key the provider does not accept (401) is the connection's, not a model's, so it is not retried; a key refused for this call (403) or an unknown model (404) is the provider refusing the model; a credit or rate limit and an outage are told apart.
 */
export function diagnosisFailureReason(error: unknown): DiagnosisFailureReason | undefined {
  const text = error instanceof Error ? error.message : "";
  if (/request failed; the API key was refused; check that it is valid and has not expired$/u.test(text)) return "key_invalid";
  if (/request failed; (?:check the API key and its permissions|check the model ID and that the key's organization can use it|check model availability and the provider allowlist)$/u.test(text)) return "model_rejected";
  if (/request failed; (?:check the key's credit balance and spending limit|rate limited(?:;| or out of credits;)[^\n]{0,80})$/u.test(text)) return "limit_reached";
  if (/request failed; (?:upstream unavailable; check provider status before retrying|the provider is overloaded; wait before retrying)$/u.test(text)) return "provider_unavailable";
  return undefined;
}

/** The event id of the one retry turn: the diagnosis's own, with a letter, so the retry's key is asked for under an id of its own. */
const retryEventId = (eventId: string): string => `${eventId.slice(0, 60)}R`;

/**
 * Answers one queued light diagnosis. Never throws and never posts: every failure is written back as FAILED (the person is told "Couldn't diagnose this now" and nothing is retried). When the broker
 * did not take even the failure, the diagnosis stays waiting until its request expires on its own.
 */
export async function handleDiagnosis(message: DiagnosisQueueMessage, deps: DiagnosisDependencies): Promise<void> {
  const now = deps.now ?? Date.now;
  const startedAt = now();
  const ref: DiagnosisRef = { orgId: message.diagnosis.orgId, diagnosisId: message.diagnosis.diagnosisId };
  let result: DiagnosisAnsweredRequest;
  try {
    const turn = DiagnosisTurnResultSchema.parse(await deps.api.turn(ref));
    let raw: string;
    try {
      raw = await deps.runTurn({ ref, question: DIAGNOSIS_TURN_QUESTION, eventId: message.eventId, turn });
    } catch (first) {
      // QA6-14: the provider refused the model the broker chose (a model the account has not enabled). One more turn, on a model the broker picks without that one; it decides, and refuses a second retry.
      if (diagnosisFailureReason(first) !== "model_rejected") throw first;
      deps.log("diagnosis.model_refused_retrying", { diagnosisId: ref.diagnosisId });
      try {
        raw = await deps.runTurn({ ref, question: DIAGNOSIS_TURN_QUESTION, eventId: retryEventId(message.eventId), turn, retry: true });
      } catch (second) {
        // No other model could be keyed (the broker refused the retry): the first refusal is the reason.
        throw diagnosisFailureReason(second) === undefined ? first : second;
      }
    }
    const answer = raw.trim();
    if (answer === "" || answer === NO_TEXT_RESPONSE) throw Object.assign(new Error("the model gave no answer"), { name: "EmptyAnswerError" });
    result = DiagnosisAnsweredRequestSchema.parse({ ...ref, outcome: "ANSWERED", text: cutAnswer(answer), contextBytes: Math.min(Buffer.byteLength(turn.taskContext, "utf8"), 56_000) });
  } catch (error) {
    const reason = diagnosisFailureReason(error);
    deps.log("diagnosis.answer_failed", { diagnosisId: ref.diagnosisId, errorName: error instanceof Error ? error.name : "unknown", ...(reason === undefined ? {} : { reason }) });
    result = { ...ref, outcome: "FAILED", ...(reason === undefined ? {} : { reason }) };
  }
  try {
    await deps.api.answered(result);
    deps.log("diagnosis.answered", { diagnosisId: ref.diagnosisId, outcome: result.outcome, latencyMs: Math.max(0, now() - startedAt) });
    return;
  } catch (error) {
    deps.log("diagnosis.write_back_failed", { diagnosisId: ref.diagnosisId, outcome: result.outcome, errorName: error instanceof Error ? error.name : "unknown" });
  }
  if (result.outcome === "FAILED") return;
  // The broker did not take the answer: say once that there is none, so the diagnosis does not wait for ever.
  try {
    await deps.api.answered({ ...ref, outcome: "FAILED" });
  } catch (error) {
    deps.log("diagnosis.write_back_failed", { diagnosisId: ref.diagnosisId, outcome: "FAILED", errorName: error instanceof Error ? error.name : "unknown" });
  }
}
