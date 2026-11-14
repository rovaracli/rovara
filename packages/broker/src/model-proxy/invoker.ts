// The broker-side ModelAccess (ruling R28): each call is one synchronous Invoke of ModelAccessFunction.
// The broker Lambdas are not in the VPC and never hold the master key. Any failure to invoke, to get
// an answer in time, or to read the answer is MODEL_PROXY_UNAVAILABLE; an `ok: false` answer becomes
// an AgentXError with the same code.
import { InvokeCommand, LambdaClient, type InvokeCommandOutput, type LambdaClientConfig } from "@aws-sdk/client-lambda";
import { AgentXErrorCodeSchema, agentXError, type AgentXError, type OrgId } from "@rovara-code/contracts";
import { z } from "zod";
import { LearningNotForwarded, type KeyAudit, type LearningCompletion, type LearningCompletionInput, type MemberSpend, type MintKeyInput, type MintedKey, type ModelAccess, type ReviewCompletionInput, type SourceCheck, type SpendFigures, type UpsertSourceInput } from "./access.js";
import { learnedLessonsOn } from "../lessons/switch.js";
import { KeyAuditResultSchema, KeySpendResultSchema, LearningCompletionResultSchema, MintedKeyResultSchema, RegisteredSourcesResultSchema, SourceCheckResultSchema, SpendFiguresSchema, SpendResultSchema, type ModelAccessRequest } from "./protocol.js";

const DEFAULT_TIMEOUT_MS = 25_000;
/**
 * A learning call is one model reply of up to two thousand tokens. The function gives the provider `LEARNING_CALL_TIMEOUT_MS` (100 s) and has nothing else to do, and its own timeout is 120 s, so its worst case is 120 s:
 * the broker waits longer than that (130 s), so a call is never given up on while the function may still be running it. The key is the ledger's by then and is settled and finalized by the sweep either way.
 */
export const LEARNING_INVOKE_TIMEOUT_MS = 130_000;

/**
 * A Lambda client that sends each command ONCE. The SDK's default retries (three attempts) would re-run a learning call after a network or 5xx fault that came after the function had started it: the key's cap does not
 * bind a second run (the first run's spend is not flushed yet), so the call could spend twice what its key holds. Every other model-access call is idempotent and keeps the ordinary client.
 */
export const singleAttemptLambda = (configuration: LambdaClientConfig = {}): LambdaClient => new LambdaClient({ ...configuration, maxAttempts: 1 });

/** What a learning call is refused with when the invoker was built without a single-attempt client (fixed words). Nothing was sent, so it is a `LearningNotForwarded`. */
export const LEARNING_NEEDS_SINGLE_ATTEMPT = "learning calls need a Lambda client that sends once";

/** What a reviewer call is refused with when the invoker was built without a single-attempt client (fixed words; nothing was sent). */
export const REVIEW_NEEDS_SINGLE_ATTEMPT = "reviewer calls need a Lambda client that sends once";
/** What a learning call is refused with while the install's lessons switch is off or unreadable (owner decision 47; fixed words). Nothing was sent, so it is a `LearningNotForwarded`. */
export const LEARNING_SWITCHED_OFF = "lessons are switched off for this install, so no learning call is made";

export interface ModelAccessInvokerInput {
  /** Tests: whether the install's lessons switch is on. Default: the switch itself (LEARNED_LESSONS_ENABLED), failing closed. */
  lessonsSwitchOn?: () => boolean;
  /** The function's name or ARN (env MODEL_ACCESS_FUNCTION_NAME). */
  functionName: string;
  lambda: { send(command: InvokeCommand, options?: { abortSignal?: AbortSignal }): Promise<InvokeCommandOutput> };
  /** The client the learning call goes through: one attempt only (`singleAttemptLambda`). REQUIRED for `learningCompletion`: without it the call is refused (fail closed), never sent through the retrying `lambda`. */
  learningLambda?: { send(command: InvokeCommand, options?: { abortSignal?: AbortSignal }): Promise<InvokeCommandOutput> };
  timeoutMs?: number;
}

const FailureSchema = z.object({ ok: z.literal(false), code: AgentXErrorCodeSchema, message: z.string(), notForwarded: z.literal(true).optional() });
const SuccessSchema = z.object({ ok: z.literal(true), result: z.unknown() });

const unavailable = (message: string): AgentXError => agentXError("MODEL_PROXY_UNAVAILABLE", message);

export class ModelAccessInvoker implements ModelAccess {
  constructor(private readonly input: ModelAccessInvokerInput) {}

  async upsertOrg(orgId: OrgId, monthlyBudgetUsd: number): Promise<void> {
    await this.invoke({ op: "upsertOrg", args: { orgId, monthlyBudgetUsd } });
  }

  async upsertMember(orgId: OrgId, developerId: string, monthlyBudgetUsd: number): Promise<void> {
    await this.invoke({ op: "upsertMember", args: { orgId, developerId, monthlyBudgetUsd } });
  }

  async spend(orgId: OrgId, developerId: string): Promise<MemberSpend> {
    return this.parseResult(await this.invoke({ op: "spend", args: { orgId, developerId } }), SpendResultSchema);
  }

  async orgSpend(orgId: OrgId): Promise<SpendFigures> {
    return this.parseResult(await this.invoke({ op: "orgSpend", args: { orgId } }), SpendFiguresSchema);
  }

  async keySpend(keyIds: readonly string[]): Promise<number> {
    if (keyIds.length === 0) return 0;
    return this.parseResult(await this.invoke({ op: "keySpend", args: { keyIds: [...keyIds] } }), KeySpendResultSchema);
  }

  async keyEstimatedSpend(keyIds: readonly string[]): Promise<number> {
    if (keyIds.length === 0) return 0;
    return this.parseResult(await this.invoke({ op: "keyEstimatedSpend", args: { keyIds: [...keyIds] } }), KeySpendResultSchema);
  }

  async mintKey(input: MintKeyInput): Promise<MintedKey> {
    const { orgId, developerId, purpose, refId, maxBudgetUsd, ttlSeconds, models, tags } = input;
    const args = {
      orgId, ...(developerId === undefined ? {} : { developerId }), purpose, refId, maxBudgetUsd, ttlSeconds,
      ...(models === undefined ? {} : { models: [...models] }),
      ...(tags === undefined ? {} : { tags: Object.fromEntries(Object.entries(tags).filter(([, value]) => value !== undefined)) as typeof tags }),
    };
    return this.parseResult(await this.invoke({ op: "mintKey", args }), MintedKeyResultSchema);
  }

  async auditKeys(options?: { budgetMs?: number }): Promise<KeyAudit> {
    return this.parseResult(await this.invoke({ op: "auditKeys", args: options?.budgetMs === undefined ? {} : { budgetMs: options.budgetMs } }), KeyAuditResultSchema);
  }

  async upsertSource(input: UpsertSourceInput): Promise<void> {
    await this.invoke({ op: "upsertSource", args: { orgId: input.orgId, source: input.source, ...(input.apiKey === undefined ? {} : { apiKey: input.apiKey }) } });
  }

  async removeSource(orgId: OrgId, sourceId: string): Promise<void> {
    await this.invoke({ op: "removeSource", args: { orgId, sourceId } });
  }

  async listSources(): Promise<Array<{ orgId: OrgId; sourceId: string; hosts?: string[] | undefined }>> {
    return this.parseResult(await this.invoke({ op: "listSources", args: {} }), RegisteredSourcesResultSchema);
  }

  async checkEndpoint(url: string): Promise<void> {
    await this.invoke({ op: "checkEndpoint", args: { url } });
  }

  async checkSource(orgId: OrgId, sourceId: string): Promise<SourceCheck> {
    return this.parseResult(await this.invoke({ op: "checkSource", args: { orgId, sourceId } }), SourceCheckResultSchema);
  }

  async revokeKey(key: string): Promise<void> {
    await this.invoke({ op: "revokeKey", args: { key } });
  }

  async blockKey(keyId: string): Promise<void> {
    await this.invoke({ op: "blockKey", args: { keyId } });
  }

  async learningCompletion(input: LearningCompletionInput): Promise<LearningCompletion> {
    const { key, purpose, system, user, maxOutputTokens, model, api, reasoningEffort, signal } = input;
    // Owner decision 47, the last lock before the wire: a switched-off (or unreadable) lessons switch sends nothing, on any path that reached here.
    const on = ((): boolean => { try { return (this.input.lessonsSwitchOn ?? (() => learnedLessonsOn(process.env)))() === true; } catch { return false; } })();
    if (!on) throw new LearningNotForwarded(LEARNING_SWITCHED_OFF);
    // F1: the retrying client would re-run a call the first attempt already started (two provider calls under one key). No single-attempt client: nothing is sent, on any construction path.
    if (this.input.learningLambda === undefined) throw new LearningNotForwarded(LEARNING_NEEDS_SINGLE_ATTEMPT);
    return this.parseResult(await this.invoke({ op: "learningCompletion", args: { key, purpose, system, user, maxOutputTokens, model, api, ...(reasoningEffort === undefined ? {} : { reasoningEffort }) } }, LEARNING_INVOKE_TIMEOUT_MS, this.input.learningLambda, signal), LearningCompletionResultSchema);
  }

  /** The lighter flow's reviewer call. Not a learning call, so the lessons switch does not gate it; it goes through the single-attempt client all the same (a retry would make two provider calls under one key). */
  async reviewCompletion(input: ReviewCompletionInput): Promise<LearningCompletion> {
    const { key, purpose, user, maxOutputTokens, model, api, signal } = input;
    if (this.input.learningLambda === undefined) throw unavailable(REVIEW_NEEDS_SINGLE_ATTEMPT);
    return this.parseResult(await this.invoke({ op: "reviewCompletion", args: { key, purpose, user, maxOutputTokens, model, api } }, LEARNING_INVOKE_TIMEOUT_MS, this.input.learningLambda, signal), LearningCompletionResultSchema);
  }

  private parseResult<T>(result: unknown, schema: z.ZodType<T>): T {
    const parsed = schema.safeParse(result);
    if (!parsed.success) throw unavailable("model access answered with an unexpected result");
    return parsed.data;
  }

  private async invoke(request: ModelAccessRequest, timeoutMs?: number, lambda: ModelAccessInvokerInput["lambda"] = this.input.lambda, signal?: AbortSignal): Promise<unknown> {
    let output: InvokeCommandOutput;
    try {
      output = await lambda.send(
        new InvokeCommand({ FunctionName: this.input.functionName, InvocationType: "RequestResponse", Payload: Buffer.from(JSON.stringify(request), "utf8") }),
        { abortSignal: signal === undefined ? AbortSignal.timeout(timeoutMs ?? this.input.timeoutMs ?? DEFAULT_TIMEOUT_MS) : AbortSignal.any([AbortSignal.timeout(timeoutMs ?? this.input.timeoutMs ?? DEFAULT_TIMEOUT_MS), signal]) },
      );
    } catch {
      throw unavailable("model access could not be invoked");
    }
    if (output.FunctionError !== undefined || output.Payload === undefined) throw unavailable("model access function failed");
    let decoded: unknown;
    try {
      decoded = JSON.parse(Buffer.from(output.Payload).toString("utf8"));
    } catch {
      throw unavailable("model access answered with a body that is not JSON");
    }
    const failure = FailureSchema.safeParse(decoded);
    if (failure.success) throw failure.data.notForwarded === true && request.op === "learningCompletion" ? new LearningNotForwarded(failure.data.message) : agentXError(failure.data.code, failure.data.message);
    const success = SuccessSchema.safeParse(decoded);
    if (!success.success) throw unavailable("model access answered with an unexpected body");
    return success.data.result;
  }
}
