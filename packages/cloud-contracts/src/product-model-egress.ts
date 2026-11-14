// TE-F1e (DECISIONS 157, 163b; te-f1 design 2.1, 4.2, 7): the wire between the worker's Cloud model-egress adapter (packages/worker/src/model-egress-cloud.ts) and the ProductModelEgress function
// (packages/broker/src/product-ai/egress-handler.ts), the only place a customer's product key is held. Cloud only: Code's laptop adapter forwards in process and has no wire.
//
// The request is one JSON document, the Invoke payload: the operation's model-egress capability (opaque to the worker) and the frame. The frame NEVER names a company, a project or a source; the function takes
// them from the capability and its own records. The answer is the function's response stream: a sequence of records, each one byte of type, four bytes of length (big-endian) and the payload: a `head`
// (JSON), any number of `chunk`s (raw bytes) and one `settle` (JSON), the port's own event order (`ports/model-egress.ts`).
//
// Size limits (AWS Lambda quotas page, https://docs.aws.amazon.com/lambda/latest/dg/gettingstarted-limits.html, "Invocation payload (request and response)": 6 MB each for synchronous invocations, which is
// what InvokeWithResponseStream's REQUEST is held to; the service's own refusal names 6,291,456 bytes). The frame core allows a 5 MiB body, which base64 makes about 6.67 MiB: over the limit. So the Cloud
// adapter refuses (`too_large`, before any invoke) a body over 4 MiB and any encoded payload over 6,000,000 bytes (the decimal reading, the smaller one) less 64 KiB of headroom. A streamed RESPONSE may be
// larger than the buffered limit (the same page: 20 MB, raised by AWS for streaming in 2025; the first 6 MB stream at full speed, then at most 2 MB/s); the function stops reading a provider answer at
// 10 MiB, under either figure. These numbers are from the documentation as known on 2026-11-14 and were NOT read from the account: TE-F1E-LAMBDA-LIMITS-LIVE in DEFERRED-CHECKS.
import { MODEL_EGRESS_CLASSES, MODEL_EGRESS_REFUSALS } from "@rovara-code/contracts";
import { z } from "zod";

/** The function's fixed name: the worker role's one statement and the dispatcher build its ARN from it, so no stack refers to another. */
export const productModelEgressFunctionName = (env: string): string => `agentx-${env}-product-model-egress`;

/** The worker invocation feature: a worker that lists it parses `productModels` on a task invocation. The broker sends the plan only to a worker that lists it (DECISIONS 152: one release apart). */
export const PRODUCT_MODELS_FEATURE = "task.productModels.v1";

/** Lambda's synchronous request limit, read as decimal megabytes (the smaller reading of "6 MB"). */
export const LAMBDA_SYNC_REQUEST_LIMIT_BYTES = 6_000_000;
export const PRODUCT_MODEL_INVOKE_HEADROOM_BYTES = 64 * 1024;
/** The largest encoded Invoke payload the adapter sends. */
export const PRODUCT_MODEL_INVOKE_PAYLOAD_MAX_BYTES = LAMBDA_SYNC_REQUEST_LIMIT_BYTES - PRODUCT_MODEL_INVOKE_HEADROOM_BYTES;
/** The largest frame body Cloud carries (the laptop keeps the core's 5 MiB): base64 of 4 MiB is 5,592,408 bytes, under the payload limit with room for the headers. */
export const PRODUCT_MODEL_CLOUD_BODY_MAX_BYTES = 4 * 1024 * 1024;
/** The most provider answer bytes the function reads for one call (design 7's response limit), under Lambda's streamed response limit. */
export const PRODUCT_MODEL_RESPONSE_MAX_BYTES = 10 * 1024 * 1024;
export const PRODUCT_MODEL_CAPABILITY_MAX_CHARS = 2048;
/** The function's own Lambda timeout (design 7: a call lasts at most 10 minutes). */
export const PRODUCT_MODEL_FUNCTION_TIMEOUT_SECONDS = 600;
/** One call's deadline, request and whole answer included: 30 s under the function's timeout, so the meter's settle always runs before Lambda stops the function (REVIEW-1 L-4). */
export const PRODUCT_MODEL_CALL_DEADLINE_MS = (PRODUCT_MODEL_FUNCTION_TIMEOUT_SECONDS - 30) * 1000;

/** base64 (standard alphabet, padded). A linear check: a grouped regex over a 5.6 MB string exhausts the stack. */
const BASE64_CHARACTERS = /^[A-Za-z0-9+/]*={0,2}$/u;
export const isPaddedBase64 = (text: string): boolean => text.length % 4 === 0 && BASE64_CHARACTERS.test(text);
const BODY_BASE64_MAX_CHARS = Math.ceil(PRODUCT_MODEL_CLOUD_BODY_MAX_BYTES / 3) * 4;

/** The frame on the wire: the core's frame with the body as base64. The function parses the decoded frame again with the core (`parseModelEgressFrame`); this schema only bounds the envelope. */
export const ProductModelEgressWireFrameSchema = z
  .object({
    row: z.string().max(64),
    method: z.string().max(16),
    path: z.string().max(4096),
    query: z.string().max(4096),
    headers: z.array(z.tuple([z.string().max(256), z.string().max(8192)])).max(64),
    body: z.string().max(BODY_BASE64_MAX_CHARS).refine(isPaddedBase64, "base64"),
  })
  .strict();
export type ProductModelEgressWireFrame = z.infer<typeof ProductModelEgressWireFrameSchema>;

export const ProductModelEgressRequestSchema = z
  .object({
    v: z.literal(1),
    op: z.literal("forward"),
    capability: z.string().min(1).max(PRODUCT_MODEL_CAPABILITY_MAX_CHARS),
    frame: ProductModelEgressWireFrameSchema,
  })
  .strict();
export type ProductModelEgressRequest = z.infer<typeof ProductModelEgressRequestSchema>;

/** The model plan a task invocation carries (sent only to a worker that lists PRODUCT_MODELS_FEATURE): the capability for the operation and the one function the worker may invoke. */
export const ProductModelPlanSchema = z
  .object({
    capability: z.string().min(1).max(PRODUCT_MODEL_CAPABILITY_MAX_CHARS),
    functionArn: z.string().regex(/^arn:aws[a-z-]*:lambda:[a-z0-9-]+:\d{12}:function:[A-Za-z0-9_-]{1,64}$/u),
  })
  .strict();
export type ProductModelPlan = z.infer<typeof ProductModelPlanSchema>;

// ---- the response stream

export const PRODUCT_MODEL_RECORD_HEAD = 1;
export const PRODUCT_MODEL_RECORD_CHUNK = 2;
export const PRODUCT_MODEL_RECORD_SETTLE = 3;
/** The longest JSON record (a head or a settle). */
export const PRODUCT_MODEL_RECORD_JSON_MAX_BYTES = 64 * 1024;
/** The longest chunk record: one stream chunk is at most 1 MiB (the bridge's own limit). */
export const PRODUCT_MODEL_RECORD_CHUNK_MAX_BYTES = 1024 * 1024;

const HeaderValue = z.string().max(1024).regex(/^[\x20-\x7e]*$/u);
export const ProductModelHeadRecordSchema = z
  .object({ status: z.number().int().min(100).max(599), headers: z.array(z.tuple([z.string().min(1).max(64).regex(/^[a-z0-9-]+$/u), HeaderValue])).max(16) })
  .strict();
const Whole = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const ProductModelSettleRecordSchema = z
  .object({
    status: z.number().int().min(100).max(599),
    class: z.enum(MODEL_EGRESS_CLASSES),
    refusal: z.enum(MODEL_EGRESS_REFUSALS).optional(),
    inputTokens: Whole.optional(),
    outputTokens: Whole.optional(),
    costMicros: Whole,
    estimated: z.boolean(),
    overrun: z.literal(true).optional(),
  })
  .strict();
export type ProductModelHeadRecord = z.infer<typeof ProductModelHeadRecordSchema>;
export type ProductModelSettleRecord = z.infer<typeof ProductModelSettleRecordSchema>;

export type ProductModelRecord =
  | { readonly kind: "head"; readonly head: ProductModelHeadRecord }
  | { readonly kind: "chunk"; readonly bytes: Uint8Array }
  | { readonly kind: "settle"; readonly settle: ProductModelSettleRecord };

function record(type: number, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(5 + payload.byteLength);
  out[0] = type;
  new DataView(out.buffer).setUint32(1, payload.byteLength, false);
  out.set(payload, 5);
  return out;
}

/** One record as bytes. A chunk over the record limit is split into several; a JSON record over its limit throws (the function writes only its own small heads and settles). */
export function encodeProductModelRecord(value: ProductModelRecord): Uint8Array[] {
  if (value.kind === "chunk") {
    const parts: Uint8Array[] = [];
    for (let at = 0; at < value.bytes.byteLength; at += PRODUCT_MODEL_RECORD_CHUNK_MAX_BYTES) parts.push(record(PRODUCT_MODEL_RECORD_CHUNK, value.bytes.subarray(at, at + PRODUCT_MODEL_RECORD_CHUNK_MAX_BYTES)));
    return parts;
  }
  const json = new TextEncoder().encode(JSON.stringify(value.kind === "head" ? ProductModelHeadRecordSchema.parse(value.head) : ProductModelSettleRecordSchema.parse(value.settle)));
  if (json.byteLength > PRODUCT_MODEL_RECORD_JSON_MAX_BYTES) throw new RangeError("a model egress record is too large");
  return [record(value.kind === "head" ? PRODUCT_MODEL_RECORD_HEAD : PRODUCT_MODEL_RECORD_SETTLE, json)];
}

/** Thrown by the decoder for a stream that is not records in the port's order. Carries no byte of the stream. */
export class ProductModelStreamError extends Error {
  constructor() {
    super("the model egress answer stream is not valid");
    this.name = "ProductModelStreamError";
  }
}

export interface ProductModelRecordDecoder {
  /** The whole records the bytes complete, in order. Throws ProductModelStreamError on a bad type, an oversize record, a bad JSON record, or records out of order (head, chunks, settle). */
  push(bytes: Uint8Array): ProductModelRecord[];
  /** The end of the stream: throws when a record is cut off or the settle never came. */
  finish(): void;
}

/** A decoder that reads records across any split of the stream (a record may arrive in many payload chunks, and one payload chunk may hold many records). */
export function createProductModelRecordDecoder(): ProductModelRecordDecoder {
  // Pending bytes are kept as a list and joined only once a whole record is there, so a stream cut into tiny pieces costs linear time.
  let pending: Uint8Array[] = [];
  let pendingBytes = 0;
  let needed = 5;
  let phase: "head" | "body" | "done" = "head";
  const fail = (): never => {
    throw new ProductModelStreamError();
  };
  const parseJson = (payload: Uint8Array): unknown => {
    try {
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(payload));
    } catch {
      return fail();
    }
  };
  return {
    push(bytes) {
      if (phase === "done" && bytes.byteLength > 0) fail();
      if (bytes.byteLength > 0) {
        pending.push(bytes);
        pendingBytes += bytes.byteLength;
      }
      const out: ProductModelRecord[] = [];
      if (pendingBytes < needed) return out;
      const joined = pending.length === 1 ? (pending[0] as Uint8Array) : Buffer.concat(pending);
      let at = 0;
      needed = 5;
      while (joined.byteLength - at >= 5) {
        const type = joined[at] as number;
        const length = new DataView(joined.buffer, joined.byteOffset + at + 1, 4).getUint32(0, false);
        const limit = type === PRODUCT_MODEL_RECORD_CHUNK ? PRODUCT_MODEL_RECORD_CHUNK_MAX_BYTES : type === PRODUCT_MODEL_RECORD_HEAD || type === PRODUCT_MODEL_RECORD_SETTLE ? PRODUCT_MODEL_RECORD_JSON_MAX_BYTES : -1;
        if (limit < 0 || length > limit) fail();
        if (joined.byteLength - at - 5 < length) {
          needed = 5 + length;
          break;
        }
        const payload = joined.slice(at + 5, at + 5 + length);
        at += 5 + length;
        if (type === PRODUCT_MODEL_RECORD_HEAD) {
          if (phase !== "head") fail();
          const head = ProductModelHeadRecordSchema.safeParse(parseJson(payload));
          if (!head.success) fail();
          phase = "body";
          out.push({ kind: "head", head: head.data! });
        } else if (type === PRODUCT_MODEL_RECORD_CHUNK) {
          if (phase !== "body") fail();
          out.push({ kind: "chunk", bytes: payload });
        } else {
          if (phase !== "body") fail();
          const settle = ProductModelSettleRecordSchema.safeParse(parseJson(payload));
          if (!settle.success) fail();
          phase = "done";
          out.push({ kind: "settle", settle: settle.data! });
        }
      }
      const rest = joined.slice(at);
      pending = rest.byteLength === 0 ? [] : [rest];
      pendingBytes = rest.byteLength;
      if (phase === "done" && pendingBytes > 0) fail();
      return out;
    },
    finish() {
      if (pendingBytes > 0 || phase !== "done") fail();
    },
  };
}

/** The frame as the wire carries it (body as base64). */
export function productModelWireFrame(frame: { readonly row: string; readonly method: string; readonly path: string; readonly query: string; readonly headers: ReadonlyArray<readonly [string, string]>; readonly body: Uint8Array }): ProductModelEgressWireFrame {
  return { row: frame.row, method: frame.method, path: frame.path, query: frame.query, headers: frame.headers.map(([name, value]) => [name, value] as [string, string]), body: Buffer.from(frame.body.buffer, frame.body.byteOffset, frame.body.byteLength).toString("base64") };
}
