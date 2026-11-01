// Live interaction A3: an Ask about a task that did not come from a Slack thread (the web's, and Linear's), answered by the same read-only turn a thread question gets: no tools, no saved session, only
// what the broker says about the task for the asker's audience. The broker queued the question under its own route (a body an older service refuses); this asks the broker for the turn's context
// by the Ask's id, runs the turn, and writes the answer back. Nothing is posted in Slack and no Slack thread, member or channel is involved.
//
// The service never decides who may ask or what the turn may know: the broker built the context for the Ask's audience and the asker's level at this moment, or refused (then the Ask is failed, in
// fixed words, and nothing is retried in the background). The question's text is kept only in this process while it runs, and is never logged.
import { AskAnsweredRequestSchema, AskTurnResultSchema, ASK_ANSWER_MAX_CHARS, ASK_LIMITS, type AskAnsweredRequest, type AskQueueMessage, type AskRef, type AskTurnResult } from "@agentx/contracts";
import { NO_TEXT_RESPONSE } from "@agentx/orchestrator/orchestrator";
import type { ServiceLog } from "./processor.js";

/** The broker's side of an Ask, as the service calls it (the control plane's `/v1/service/asks/*`). */
export interface AskServiceApi {
  turn(ref: AskRef): Promise<AskTurnResult>;
  answered(request: AskAnsweredRequest): Promise<void>;
}

export interface AskDependencies {
  api: AskServiceApi;
  /** Runs the no-tools answer turn for the Ask and returns the model's text; throws when there is none. `context` is the broker's text for the turn (its rules, then the data). */
  runTurn(input: { ref: AskRef; question: string; eventId: string; turn: AskTurnResult }): Promise<string>;
  log: ServiceLog;
  now?: () => number;
}

/** The answer cut to what the broker takes, never through a character pair. */
function cutAnswer(answer: string): string {
  if (answer.length <= ASK_ANSWER_MAX_CHARS) return answer;
  const cut = answer.slice(0, ASK_ANSWER_MAX_CHARS);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

/**
 * Answers one queued Ask. Never throws and never posts: every failure is written back as FAILED (the asker is told "Couldn't answer that just now" and nothing is retried). When the broker did not
 * take even the failure, the Ask stays waiting until its lock and request expire on their own.
 */
export async function handleAsk(message: AskQueueMessage, deps: AskDependencies): Promise<void> {
  const now = deps.now ?? Date.now;
  const startedAt = now();
  const ref: AskRef = { orgId: message.ask.orgId, sessionId: message.ask.sessionId, askId: message.ask.askId };
  let result: AskAnsweredRequest;
  try {
    const turn = AskTurnResultSchema.parse(await deps.api.turn(ref));
    const answer = (await deps.runTurn({ ref, question: message.text, eventId: message.eventId, turn })).trim();
    if (answer === "" || answer === NO_TEXT_RESPONSE) throw Object.assign(new Error("the model gave no answer"), { name: "EmptyAnswerError" });
    result = AskAnsweredRequestSchema.parse({ ...ref, outcome: "ANSWERED", text: cutAnswer(answer), question: message.text, contextBytes: Math.min(Buffer.byteLength(turn.taskContext, "utf8"), ASK_LIMITS.contextMaxBytes) });
  } catch (error) {
    deps.log("ask.answer_failed", { askId: ref.askId, errorName: error instanceof Error ? error.name : "unknown" });
    result = { ...ref, outcome: "FAILED" };
  }
  try {
    await deps.api.answered(result);
    deps.log("ask.answered", { askId: ref.askId, outcome: result.outcome, latencyMs: Math.max(0, now() - startedAt) });
    return;
  } catch (error) {
    deps.log("ask.write_back_failed", { askId: ref.askId, outcome: result.outcome, errorName: error instanceof Error ? error.name : "unknown" });
  }
  if (result.outcome === "FAILED") return;
  // The broker did not take the answer: say once that there is none, so the Ask does not wait for ever.
  try {
    await deps.api.answered({ ...ref, outcome: "FAILED" });
  } catch (error) {
    deps.log("ask.write_back_failed", { askId: ref.askId, outcome: "FAILED", errorName: error instanceof Error ? error.name : "unknown" });
  }
}
