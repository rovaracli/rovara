// The broker-side ModelAccess (ruling R28): each call is one synchronous Invoke of ModelAccessFunction.
// The broker Lambdas are not in the VPC and never hold the master key. Any failure to invoke, to get
// an answer in time, or to read the answer is MODEL_PROXY_UNAVAILABLE; an `ok: false` answer becomes
// an AgentXError with the same code.
import { InvokeCommand, type InvokeCommandOutput } from "@aws-sdk/client-lambda";
import { AgentXErrorCodeSchema, agentXError, type AgentXError, type OrgId } from "@agentx/contracts";
import { z } from "zod";
import type { MemberSpend, MintKeyInput, MintedKey, ModelAccess, SpendFigures } from "./access.js";
import { KeySpendResultSchema, MintedKeyResultSchema, SpendFiguresSchema, SpendResultSchema, type ModelAccessRequest } from "./protocol.js";

const DEFAULT_TIMEOUT_MS = 25_000;

export interface ModelAccessInvokerInput {
  /** The function's name or ARN (env MODEL_ACCESS_FUNCTION_NAME). */
  functionName: string;
  lambda: { send(command: InvokeCommand, options?: { abortSignal?: AbortSignal }): Promise<InvokeCommandOutput> };
  timeoutMs?: number;
}

const FailureSchema = z.object({ ok: z.literal(false), code: AgentXErrorCodeSchema, message: z.string() });
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

  async mintKey(input: MintKeyInput): Promise<MintedKey> {
    const { orgId, developerId, purpose, refId, maxBudgetUsd, ttlSeconds } = input;
    return this.parseResult(await this.invoke({ op: "mintKey", args: { orgId, ...(developerId === undefined ? {} : { developerId }), purpose, refId, maxBudgetUsd, ttlSeconds } }), MintedKeyResultSchema);
  }

  async revokeKey(key: string): Promise<void> {
    await this.invoke({ op: "revokeKey", args: { key } });
  }

  private parseResult<T>(result: unknown, schema: z.ZodType<T>): T {
    const parsed = schema.safeParse(result);
    if (!parsed.success) throw unavailable("model access answered with an unexpected result");
    return parsed.data;
  }

  private async invoke(request: ModelAccessRequest): Promise<unknown> {
    let output: InvokeCommandOutput;
    try {
      output = await this.input.lambda.send(
        new InvokeCommand({ FunctionName: this.input.functionName, InvocationType: "RequestResponse", Payload: Buffer.from(JSON.stringify(request), "utf8") }),
        { abortSignal: AbortSignal.timeout(this.input.timeoutMs ?? DEFAULT_TIMEOUT_MS) },
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
    if (failure.success) throw agentXError(failure.data.code, failure.data.message);
    const success = SuccessSchema.safeParse(decoded);
    if (!success.success) throw unavailable("model access answered with an unexpected body");
    return success.data.result;
  }
}
