// DR-KEY-1 (B): a model the ACCOUNT may not use, refused through the model proxy, is classified from the proxy's error class and Bedrock's shape for it, and carried from the worker to the broker as a
// structured code (`modelFailureCode`), which the broker's learning keys on. Staging's plan check on Haiku 5.5 read "key-rejected attempt 1" and taught nothing: the proxy's body was dropped and the transport
// sentence said only "check the API key and its permissions".
import { describe, expect, it } from "vitest";
import type { Context } from "@earendil-works/pi-ai";
import { MODEL_NOT_ENABLED_CODE, modelFailureCodeOf, type DesignReviewWorkerResult } from "../../packages/contracts/src/index.js";
import { createConfiguredModelRuntime, modelNotEnabledBody } from "../../packages/model-runtime/src/index.js";
import { describeModelCallNote, sanitizeModelCallEvent } from "../../packages/worker/src/model-call-monitor.js";
import { assistantOutcome, failedTurn } from "../../packages/worker/src/session-events.js";
import { modelUnusableRound } from "../../packages/worker/src/design-review-sessions.js";
import { modelsNotEnabled } from "../../packages/broker/src/model-sources/learn-not-enabled.js";
import { criticModelUnusable } from "../../packages/broker/src/rovara-code/critic.js";

const PROXY_URL = "http://internal-proxy.example.test:4000";
const HAIKU = "us.anthropic.claude-haiku-5-5";
const context: Context = { messages: [{ role: "user", content: "hello", timestamp: 0 }] };
/** Exactly what staging's model proxy (LiteLLM) logged for the refused Haiku 5.5 call. */
const STAGING_TEXT = 'litellm.PermissionDeniedError: BedrockException - {"message":"anthropic.claude-haiku-5-5 is not available for this account. You can explore other available models on Amazon Bedrock. For additional access options, contact AWS Sales at https://aws.amazon.com/contact-us/sales-support/"}';
const proxyError = (message: string) => JSON.stringify({ error: { message, type: null, param: null, code: "403" } });
const IAM_TEXT = 'litellm.PermissionDeniedError: BedrockException - {"message":"User: arn:aws:sts::000000000000:assumed-role/proxy/i-0 is not authorized to perform: bedrock:InvokeModelWithResponseStream on resource: arn:aws:bedrock:us-west-2::foundation-model/anthropic.claude-haiku-5-5"}';

/** One call through the proxied runtime (the plan check's and a reviewer's), answered 403 with `body`; the message_end event Pi would emit, and what the worker makes of it. */
async function refusedCall(body: string, status = 403) {
  const runtime = await createConfiguredModelRuntime({ provider: "amazon-bedrock", modelId: HAIKU }, { fetch: async () => new Response(body, { status, headers: { "content-type": "application/json" } }), proxy: { baseUrl: PROXY_URL, apiKey: async () => "proxy-key-for-test" } });
  const model = runtime.getModel("amazon-bedrock", HAIKU)!;
  const message = await runtime.streamSimple(model, context, { maxTokens: 16, maxRetries: 0 }).result();
  const event = { type: "message_end", message };
  const note = sanitizeModelCallEvent(event)?.modelCall;
  return { message, note, monitored: failedTurn(assistantOutcome(event), { note }), plain: failedTurn(assistantOutcome(event)) };
}

describe("the proxy's 403 for a model the account may not use", () => {
  it("staging's exact LiteLLM body is key-rejected ModelNotEnabled HTTP 403, and both failure paths carry the structured code", async () => {
    const { message, note, monitored, plain } = await refusedCall(proxyError(STAGING_TEXT));
    expect(message.errorMessage).toMatch(/request failed; the model is not available for this account$/u);
    expect(note).toMatchObject({ outcome: "failed", class: "key-rejected", signal: MODEL_NOT_ENABLED_CODE, status: 403 });
    expect(describeModelCallNote(note!)).toBe("the model call failed: key-rejected ModelNotEnabled HTTP 403 attempt 1");
    expect(modelFailureCodeOf(monitored)).toBe(MODEL_NOT_ENABLED_CODE);
    expect(modelFailureCodeOf(plain)).toBe(MODEL_NOT_ENABLED_CODE);
    // Nothing of the provider's body reaches the error.
    for (const error of [monitored, plain]) expect(error?.message).not.toMatch(/litellm|BedrockException|aws\.amazon\.com|explore/u);
    // The plan check still moves on to the next model.
    expect(criticModelUnusable(monitored?.message)).toBe(true);
  });

  it("a refused key or a missing IAM permission stays a plain key-rejected, with no code", async () => {
    for (const body of [proxyError(IAM_TEXT), proxyError("litellm.AuthenticationError: invalid api key"), proxyError("haiku is not available for this account")]) {
      const { message, note, monitored, plain } = await refusedCall(body);
      expect(message.errorMessage, body).toMatch(/request failed; check the API key and its permissions$/u);
      expect(note, body).toMatchObject({ class: "key-rejected", signal: null });
      expect(modelFailureCodeOf(monitored)).toBeUndefined();
      expect(modelFailureCodeOf(plain)).toBeUndefined();
    }
  });

  it("only a 403 is read for it, and the class AND the shape must both be there", async () => {
    expect((await refusedCall(proxyError(STAGING_TEXT), 500)).note).toMatchObject({ class: "provider-outage" });
    expect(modelNotEnabledBody(STAGING_TEXT)).toBe(true);
    expect(modelNotEnabledBody("AccessDeniedException: You don't have access to the model with the specified model ID.")).toBe(true);
    expect(modelNotEnabledBody("You don't have access to the model with the specified model ID.")).toBe(false);
    expect(modelNotEnabledBody(IAM_TEXT)).toBe(false);
  });
});

describe("the broker learns from the code, not the words", () => {
  const haiku = { provider: "amazon-bedrock", modelId: HAIKU };
  it("a failed operation whose result carries ModelNotEnabled teaches its model, whatever its error says", () => {
    expect(modelsNotEnabled({ model: haiku }, "FAILED", "the model call failed: a wording no pattern knows", { modelFailureCode: MODEL_NOT_ENABLED_CODE })).toEqual([haiku]);
    expect(modelsNotEnabled({ model: haiku }, "FAILED", undefined, { modelFailureCode: MODEL_NOT_ENABLED_CODE })).toEqual([haiku]);
  });
  it("an older worker's result (no code) still teaches by its fixed sentence; nothing else does", () => {
    expect(modelsNotEnabled({ model: haiku }, "FAILED", "RUNTIME_UNAVAILABLE: the model call failed: key-rejected ModelNotEnabled HTTP 403 attempt 1; x", undefined)).toEqual([haiku]);
    expect(modelsNotEnabled({ model: haiku }, "FAILED", "RUNTIME_UNAVAILABLE: the model call failed: key-rejected attempt 1; check the model key and its permissions, then retry", undefined)).toEqual([]);
    expect(modelsNotEnabled({ model: haiku }, "FAILED", undefined, { modelFailureCode: "SomethingElse" })).toEqual([]);
    expect(modelsNotEnabled({ model: haiku }, "SUCCEEDED", undefined, { modelFailureCode: MODEL_NOT_ENABLED_CODE })).toEqual([]);
    expect(modelsNotEnabled({ model: haiku, modelRoute: { sourceId: "src_abcdefghijklmnopqrst" } }, "FAILED", undefined, { modelFailureCode: MODEL_NOT_ENABLED_CODE })).toEqual([]);
  });
});

describe("a design-review round whose reviewers' model cannot be used", () => {
  const round = (failures: Array<string | undefined>): DesignReviewWorkerResult => ({
    version: 1, round: 1, merge: { status: "skipped", tokensIn: 0, tokensOut: 0, costUsd: 0 }, findings: [], mergeSource: "code", omitted: 0, droppedCitations: [], droppedFindings: [], stageTimedOut: false,
    reviewers: failures.map((failure, index) => ({ role: (["comprehension", "critic", "codebase"] as const)[index]!, keySlot: `r1-${index}`, status: failure === undefined ? "answered" : "no_result", ...(failure === undefined ? {} : { failure }), retried: false, tokensIn: 0, tokensOut: 0, costUsd: 0, startedAt: "2026-11-03T12:00:00.000Z", endedAt: "2026-11-03T12:00:01.000Z" })),
  }) as DesignReviewWorkerResult;
  it("ends the operation with the coded failure when every reviewer's model was not enabled, or as MODEL_NOT_ALLOWED when a slot's model was refused", () => {
    const enabled = modelUnusableRound(round(["model_not_enabled", "model_not_enabled", "model_not_enabled"]));
    expect(modelFailureCodeOf(enabled)).toBe(MODEL_NOT_ENABLED_CODE);
    expect(criticModelUnusable(enabled?.message)).toBe(true);
    const allowed = modelUnusableRound(round(["model_not_allowed", "model_not_enabled", "model_not_allowed"]));
    expect(allowed?.message).toMatch(/^MODEL_NOT_ALLOWED: /u);
    expect(modelFailureCodeOf(allowed)).toBeUndefined();
    expect(criticModelUnusable(allowed?.message)).toBe(true);
  });
  it("leaves a round with any answer, or any other failure, to be recorded as it ran", () => {
    expect(modelUnusableRound(round(["model_not_enabled", undefined, "model_not_enabled"]))).toBeUndefined();
    expect(modelUnusableRound(round(["model_not_enabled", "timeout", "model_not_enabled"]))).toBeUndefined();
    expect(modelUnusableRound(round(["model_failed", "model_failed", "model_failed"]))).toBeUndefined();
    expect(modelUnusableRound(round([]))).toBeUndefined();
  });
});
