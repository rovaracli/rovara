// DR-KEY-1 (B): a model the ACCOUNT may not use, refused through the model proxy, is classified from the proxy's error class and Bedrock's shape for it, and carried from the worker to the broker as a
// structured code (`modelFailureCode`), which the broker's learning keys on. Staging's plan check on Haiku 5.5 read "key-rejected attempt 1" and taught nothing: the proxy's body was dropped and the transport
// sentence said only "check the API key and its permissions".
import { describe, expect, it } from "vitest";
import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { Context } from "@earendil-works/pi-ai";
import { MODEL_NOT_ENABLED_CODE, modelFailureCodeOf, type DesignReviewWorkerResult } from "../../packages/contracts/src/index.js";
import { createConfiguredModelRuntime, modelNotEnabledBody } from "../../packages/model-runtime/src/index.js";
import { describeModelCallNote, sanitizeModelCallEvent } from "../../packages/worker/src/model-call-monitor.js";
import { assistantOutcome, failedTurn } from "../../packages/worker/src/session-events.js";
import { modelUnusableRound } from "../../packages/worker/src/design-review-sessions.js";
import { learnModelNotEnabled, modelsNotEnabled } from "../../packages/broker/src/model-sources/learn-not-enabled.js";
import { createUsableModels } from "../../packages/broker/src/model-sources/usable-models.js";
import { servableModels } from "../../packages/broker/src/model-sources/routing.js";
import type { OrgId } from "../../packages/contracts/src/org.js";
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

// 0.5.13: the budget-reserve guard answers 403 `model_not_priced` for a model it has no price for (today only Haiku 5.5) on a budgeted key. That is read like Bedrock's refusal, so the broker learns it and the
// plan check, reviewers, second review, diagnosis and design review move on instead of losing one attempt (or a whole design-review round) on it every time.
describe("the guard's 403 model_not_priced is learned like a model the account may not use", () => {
  const org = "org_aaaaaaaaaaaaaaaaaaaa" as OrgId;
  const haiku = { provider: "amazon-bedrock", modelId: HAIKU };
  const NOT_PRICED = "this model has no price, so the task budget cannot be held";
  /** /v1/chat/completions and /v1/messages as LiteLLM answers the guard's ProxyException: the error type is the guard's own token. */
  const openAiShape = JSON.stringify({ error: { message: NOT_PRICED, type: "model_not_priced", param: null, code: "403" } });
  const anthropicShape = JSON.stringify({ error: { message: JSON.stringify({ type: "error", error: { type: "model_not_priced", message: NOT_PRICED } }), type: null, param: null, code: "403" } });
  const anthropicBare = JSON.stringify({ type: "error", error: { type: "model_not_priced", message: NOT_PRICED } });

  /** One-item DynamoDB stand-in for the usability record (the same shape usable-models.test.ts uses). */
  function usableModels() {
    const item: Record<string, unknown> = {};
    const writes: number[] = [];
    const client = {
      async send(command: unknown) {
        if (command instanceof GetCommand) return { Item: Object.keys(item).length === 0 ? undefined : { ...item } };
        if (command instanceof UpdateCommand) {
          writes.push(1);
          const names = command.input.ExpressionAttributeNames as Record<string, string>;
          const values = command.input.ExpressionAttributeValues as Record<string, unknown>;
          for (const part of String(command.input.UpdateExpression).replace(/^SET /u, "").split(", ")) { const [name, value] = part.split(" = ") as [string, string]; item[names[name]!] = values[value]; }
          return {};
        }
        throw new Error("unexpected command");
      },
    };
    const models = createUsableModels({ documentClient: client, tableName: "t", now: () => 1, geography: "us", probe: async () => ({ agreement: "AVAILABLE", authorization: "AUTHORIZED" }) });
    return { models, writes };
  }
  const canPick = async (models: ReturnType<typeof usableModels>["models"]) => (await servableModels({ usableModels: models }, org)).some((model) => model.modelId === HAIKU);

  it("is read as key-rejected ModelNotEnabled with the structured code, on every shape the proxy answers in, and the plan check still moves on", async () => {
    for (const body of [openAiShape, anthropicShape, anthropicBare]) {
      const { message, note, monitored, plain } = await refusedCall(body);
      expect(message.errorMessage, body).toMatch(/request failed; the model is not available for this account$/u);
      expect(note, body).toMatchObject({ outcome: "failed", class: "key-rejected", signal: MODEL_NOT_ENABLED_CODE, status: 403 });
      expect(modelFailureCodeOf(monitored), body).toBe(MODEL_NOT_ENABLED_CODE);
      expect(modelFailureCodeOf(plain), body).toBe(MODEL_NOT_ENABLED_CODE);
      expect(criticModelUnusable(monitored?.message), body).toBe(true);
      expect(modelsNotEnabled({ model: haiku }, "FAILED", monitored?.message, { modelFailureCode: modelFailureCodeOf(monitored) })).toEqual([haiku]);
    }
  });

  it("marks the model unusable through the usability record, so the next pick skips it", async () => {
    const { models, writes } = usableModels();
    expect(await canPick(models)).toBe(true);
    const before = writes.length;
    const { monitored } = await refusedCall(openAiShape);
    await learnModelNotEnabled(models, { model: haiku }, "FAILED", monitored?.message, { modelFailureCode: modelFailureCodeOf(monitored) });
    expect(writes.length).toBe(before + 1);
    expect(await canPick(models)).toBe(false);
  });

  it("keeps the scope of the existing learning: a company's own model source is another account and teaches nothing", async () => {
    const { monitored } = await refusedCall(openAiShape);
    const result = { modelFailureCode: modelFailureCodeOf(monitored) };
    expect(modelsNotEnabled({ model: haiku, modelRoute: { sourceId: "src_abcdefghijklmnopqrst" } }, "FAILED", monitored?.message, result)).toEqual([]);
    expect(modelsNotEnabled({ model: haiku, modelRoute: { sourceId: "rovara" } }, "FAILED", monitored?.message, result)).toEqual([haiku]);
  });

  it("an ordinary 403 (a budget, a refused key, a missing permission, or text that only mentions the token) does NOT mark the model unusable", async () => {
    const bodies = [
      JSON.stringify({ error: { message: "Budget has been exceeded! Key=task Max budget: 1.000000", type: "budget_exceeded", param: null, code: "403" } }),
      JSON.stringify({ error: { message: "Authentication Error, invalid api key", type: "auth_error", param: null, code: "403" } }),
      JSON.stringify({ error: { message: "key not allowed to access model", type: "key_model_access_denied", param: null, code: "403" } }),
      // The token appears only in a message, never as the error type: not read as the guard's refusal.
      proxyError("litellm.AuthenticationError: the caller said model_not_priced"),
      proxyError(IAM_TEXT),
    ];
    const { models, writes } = usableModels();
    expect(await canPick(models)).toBe(true);
    const before = writes.length;
    for (const body of bodies) {
      const { message, note, monitored, plain } = await refusedCall(body);
      expect(message.errorMessage, body).toMatch(/request failed; check the API key and its permissions$/u);
      expect(note, body).toMatchObject({ class: "key-rejected", signal: null });
      expect(modelFailureCodeOf(monitored), body).toBeUndefined();
      expect(modelFailureCodeOf(plain), body).toBeUndefined();
      expect(modelsNotEnabled({ model: haiku }, "FAILED", monitored?.message, { modelFailureCode: modelFailureCodeOf(monitored) }), body).toEqual([]);
      await learnModelNotEnabled(models, { model: haiku }, "FAILED", monitored?.message, { modelFailureCode: modelFailureCodeOf(monitored) });
    }
    expect(writes.length).toBe(before);
    expect(await canPick(models)).toBe(true);
    expect(modelNotEnabledBody(openAiShape)).toBe(true);
    expect(modelNotEnabledBody(bodies[0]!)).toBe(false);
  });
});
