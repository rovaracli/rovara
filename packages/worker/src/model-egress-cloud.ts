// TE-F1e (te-f1e.md item 4; design 2.1, 4.2): the CLOUD plug-in of F1-a's `model-egress` port (`ports/model-egress.ts`), on the worker. Not a mirror of a Code file: Code's laptop adapter holds the key in
// process; this one holds NO key. It invokes the ProductModelEgress function (packages/broker/src/product-ai/egress-handler.ts) with `InvokeWithResponseStream`, from the worker's instance role, on ONE function ARN
// (the worker role's one statement, infra/lib/ec2-workers.ts), and turns the function's record stream back into the port's events.
//
// ONE attempt: the Lambda client must be built with `maxAttempts: 1` (`cloudInvokeFromLambdaClient` refuses any other), so neither a fault nor a read timeout re-sends a call (one approved invoke became two on a
// timeout once: memory note "aws lambda invoke retries on timeout"). A refusal decided here (a frame the core refuses, a scope it cannot read, a payload over Lambda's request limit) invokes nothing. The function
// host `lambda.<region>.amazonaws.com` is already on the hosted allow list ("Lambda API", packages/cloud-contracts/src/hosted-allow-domains.ts), which this lane does not edit.
//
// The scope is opaque: it holds the operation's model-egress capability, which this adapter passes on and never reads. A stream that breaks after the head is reported as a provider error, never as a silent
// short answer; the function's meter, not this adapter, holds what the call cost. Logs are fixed fields only (row, status, class, refusal word, cost); never the capability, a body, a header or a query.
import {
  builtinModelCatalog, classOfRefusal, familyErrorBody, parseModelEgressFrame, refusalResponse,
  type ModelEgress, type ModelEgressEvent, type ModelEgressFamily, type ModelEgressRefusal, type ModelEgressScheme, type ModelEgressScope,
} from "@rovara-code/contracts";
import {
  PRODUCT_MODEL_CAPABILITY_MAX_CHARS, PRODUCT_MODEL_CLOUD_BODY_MAX_BYTES, PRODUCT_MODEL_INVOKE_PAYLOAD_MAX_BYTES, createProductModelRecordDecoder, productModelWireFrame, type ProductModelEgressRequest,
} from "@agentx/cloud-contracts";

declare const cloudScopeBrand: unique symbol;
export type CloudModelEgressScope = ModelEgressScope & { readonly [cloudScopeBrand]: true };

/** The scope for a task's calls: its model-egress capability, as the model plan carried it. */
export const cloudModelEgressScope = (capability: string): ModelEgressScope => Object.freeze({ capability }) as unknown as ModelEgressScope;

/** One event of InvokeWithResponseStream's EventStream, as the SDK yields it. */
export interface CloudInvokeStreamEvent {
  readonly PayloadChunk?: { readonly Payload?: Uint8Array | undefined } | undefined;
  readonly InvokeComplete?: { readonly ErrorCode?: string | undefined } | undefined;
}
/** One single-attempt InvokeWithResponseStream. */
export type CloudInvoke = (input: { readonly FunctionName: string; readonly Payload: Uint8Array }, signal?: AbortSignal) => Promise<{ readonly StatusCode?: number | undefined; readonly EventStream?: AsyncIterable<CloudInvokeStreamEvent> | undefined }>;

/** What `cloudInvokeFromLambdaClient` needs of an SDK LambdaClient: its resolved `maxAttempts`, and `send`. */
export interface SingleAttemptLambdaClient {
  readonly config: { readonly maxAttempts: number | (() => Promise<number>) };
  send(command: unknown, options?: { abortSignal?: AbortSignal }): Promise<unknown>;
}

export class CloudInvokeRetriesError extends Error {
  constructor() {
    super("the product model egress invoke needs a Lambda client with maxAttempts 1");
    this.name = "CloudInvokeRetriesError";
  }
}

/** The invoke over an SDK client, refused unless the client makes exactly one attempt. `command` builds `new InvokeWithResponseStreamCommand(input)` (passed in, so this file needs no SDK package of its own). */
export async function cloudInvokeFromLambdaClient(client: SingleAttemptLambdaClient, command: (input: { FunctionName: string; Payload: Uint8Array }) => unknown): Promise<CloudInvoke> {
  const attempts = typeof client.config.maxAttempts === "function" ? await client.config.maxAttempts() : client.config.maxAttempts;
  if (attempts !== 1) throw new CloudInvokeRetriesError();
  return async (input, signal) => (await client.send(command({ FunctionName: input.FunctionName, Payload: input.Payload }), signal === undefined ? undefined : { abortSignal: signal })) as Awaited<ReturnType<CloudInvoke>>;
}

export interface CloudModelEgressOptions {
  /** The one function the worker may invoke (the model plan's). */
  readonly functionArn: string;
  readonly invoke: CloudInvoke;
  /** Fixed fields only. */
  readonly log?: (fields: Readonly<Record<string, string | number>>) => void;
}

/** Every scheme: the function decides which one a source uses and refuses what it cannot place. */
const SCHEMES: readonly ModelEgressScheme[] = ["bearer", "header:x-goog-api-key", "header:x-api-key", "header:api-key", "query:key", "gcp-oauth:federation", "gcp-oauth:key-file"];
const UNREACHABLE = "The provider could not be reached.";

function capabilityOf(scope: ModelEgressScope): string | undefined {
  try {
    const held = (scope as unknown as { capability?: unknown } | undefined)?.capability;
    return typeof held === "string" && held.length > 0 && held.length <= PRODUCT_MODEL_CAPABILITY_MAX_CHARS ? held : undefined;
  } catch {
    // A scope that cannot even be read is one nobody can be served under.
    return undefined;
  }
}

export function createCloudModelEgress(options: CloudModelEgressOptions): ModelEgress {
  const families = new Map(builtinModelCatalog().rows.map((row) => [row.id, row.family]));
  const log = (fields: Readonly<Record<string, string | number>>): void => {
    try {
      options.log?.(fields);
    } catch {
      // A log sink that throws is not the call's problem.
    }
  };
  function* refuse(family: ModelEgressFamily, word: ModelEgressRefusal, row: string): Generator<ModelEgressEvent> {
    const answer = refusalResponse(family, word);
    log({ event: "refused", row, status: answer.status, class: classOfRefusal(word), refusal: word });
    yield { kind: "head", status: answer.status, headers: answer.headers };
    yield { kind: "chunk", bytes: answer.body };
    yield { kind: "settle", status: answer.status, class: classOfRefusal(word), refusal: word, costMicros: 0, estimated: false };
  }
  function* unreachable(family: ModelEgressFamily, row: string): Generator<ModelEgressEvent> {
    log({ event: "call", row, status: 502, class: "provider_error", cost: 0 });
    yield { kind: "head", status: 502, headers: [["content-type", "application/json"]] };
    yield { kind: "chunk", bytes: familyErrorBody(family, 502, UNREACHABLE, "rovara_unreachable") };
    yield { kind: "settle", status: 502, class: "provider_error", costMicros: 0, estimated: true };
  }

  return {
    capabilities: { schemes: SCHEMES },
    async *forward(scope, input, forwardOptions) {
      const parsed = parseModelEgressFrame(input);
      const rowId = parsed.ok ? parsed.frame.row : undefined;
      const family: ModelEgressFamily = (rowId === undefined ? undefined : families.get(rowId)) ?? "openai_compatible";
      const rowName = rowId !== undefined && families.has(rowId) ? rowId : "unknown";
      if (!parsed.ok) {
        yield* refuse(family, parsed.refusal, rowName);
        return;
      }
      if (parsed.frame.body.byteLength > PRODUCT_MODEL_CLOUD_BODY_MAX_BYTES) {
        yield* refuse(family, "too_large", rowName);
        return;
      }
      const capability = capabilityOf(scope);
      if (capability === undefined) {
        yield* refuse(family, "not_found", rowName);
        return;
      }
      const request: ProductModelEgressRequest = { v: 1, op: "forward", capability, frame: productModelWireFrame(parsed.frame) };
      const payload = new TextEncoder().encode(JSON.stringify(request));
      // Over Lambda's synchronous request limit (less the headroom): refused here, never sent to be refused (or truncated) there.
      if (payload.byteLength > PRODUCT_MODEL_INVOKE_PAYLOAD_MAX_BYTES) {
        yield* refuse(family, "too_large", rowName);
        return;
      }

      let response: Awaited<ReturnType<CloudInvoke>>;
      try {
        // ONE attempt.
        response = await options.invoke({ FunctionName: options.functionArn, Payload: payload }, forwardOptions?.signal);
      } catch {
        yield* unreachable(family, rowName);
        return;
      }
      if (response.StatusCode !== 200 || response.EventStream === undefined) {
        yield* unreachable(family, rowName);
        return;
      }
      const decoder = createProductModelRecordDecoder();
      let headSent: number | undefined;
      let settled = false;
      try {
        for await (const event of response.EventStream) {
          if (event.InvokeComplete !== undefined) {
            if (event.InvokeComplete.ErrorCode !== undefined && event.InvokeComplete.ErrorCode !== "") throw new Error("the function failed");
            break;
          }
          const bytes = event.PayloadChunk?.Payload;
          if (bytes === undefined) continue;
          for (const record of decoder.push(bytes)) {
            if (record.kind === "head") {
              headSent = record.head.status;
              yield { kind: "head", status: record.head.status, headers: record.head.headers };
            } else if (record.kind === "chunk") {
              yield { kind: "chunk", bytes: record.bytes };
            } else {
              settled = true;
              const settle = record.settle;
              log({ event: "call", row: rowName, status: settle.status, class: settle.class, cost: settle.costMicros, ...(settle.refusal === undefined ? {} : { refusal: settle.refusal }) });
              yield {
                kind: "settle", status: settle.status, class: settle.class, costMicros: settle.costMicros, estimated: settle.estimated,
                ...(settle.refusal === undefined ? {} : { refusal: settle.refusal }),
                ...(settle.inputTokens === undefined ? {} : { inputTokens: settle.inputTokens }),
                ...(settle.outputTokens === undefined ? {} : { outputTokens: settle.outputTokens }),
                ...(settle.overrun === true ? { overrun: true } : {}),
              };
            }
          }
        }
        decoder.finish();
      } catch {
        if (settled) return;
        if (headSent === undefined) {
          yield* unreachable(family, rowName);
          return;
        }
        // Cut off after the head: said out loud (a provider error), never a silent short answer. What the call cost is on the function's meter (it errs high).
        log({ event: "cut_off", row: rowName, status: headSent, class: "provider_error" });
        yield { kind: "settle", status: headSent, class: "provider_error", costMicros: 0, estimated: true };
      }
    },
  };
}

/**
 * The production producer of the `model-egress` port for one CHECKS round (the 7a addition): the task's model plan (sent only to a worker that lists PRODUCT_MODELS_FEATURE, only with the company gate on) gives the
 * adapter and its opaque scope. No plan: undefined, so the round's real model checks read "Not run" with zero calls, exactly as before. The caller passes a one-attempt invoke (`cloudInvokeFromLambdaClient`).
 * NOT yet called by run-task: the F1-c bridge has no Cloud host and the eval/real-model consumers are not on this base (QUESTIONS.md, DEFERRED TE-F1E-RUNTASK-WIRING).
 */
export function cloudModelEgressForPlan(plan: { readonly capability: string; readonly functionArn: string } | undefined, invoke: CloudInvoke | undefined, log?: CloudModelEgressOptions["log"]): { readonly egress: ModelEgress; readonly scope: ModelEgressScope } | undefined {
  if (plan === undefined || invoke === undefined) return undefined;
  return { egress: createCloudModelEgress({ functionArn: plan.functionArn, invoke, ...(log === undefined ? {} : { log }) }), scope: cloudModelEgressScope(plan.capability) };
}
