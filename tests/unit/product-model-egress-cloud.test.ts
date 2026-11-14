// TE-F1e item 4 and fork F7: the worker's Cloud adapter. One attempt (a client that retries is refused), refusals decided before any invoke (a payload over Lambda's request limit is refused, never truncated),
// a function fault or a cut stream said out loud, and nothing the adapter sends or logs holds a key. Plus the wire's record codec.
import { LambdaClient } from "@aws-sdk/client-lambda";
import { e2eSecretSpellings } from "@rovara-code/contracts";
import { describe, expect, it } from "vitest";
import {
  LAMBDA_SYNC_REQUEST_LIMIT_BYTES, PRODUCT_MODEL_CLOUD_BODY_MAX_BYTES, PRODUCT_MODEL_INVOKE_PAYLOAD_MAX_BYTES, PRODUCT_MODEL_RECORD_CHUNK_MAX_BYTES, ProductModelStreamError, createProductModelRecordDecoder,
  encodeProductModelRecord,
} from "../../packages/cloud-contracts/src/product-model-egress.js";
import { CloudInvokeRetriesError, cloudInvokeFromLambdaClient, cloudModelEgressScope, createCloudModelEgress, type CloudInvoke } from "../../packages/worker/src/model-egress-cloud.js";
import { COMPANY_A, COMPANY_B, TWO_COMPANIES, cloudEgressWorld } from "../support/product-model-egress-world.js";

const ARN = "arn:aws:lambda:us-west-2:111122223333:function:agentx-staging-product-model-egress";
const frame = (body: Uint8Array, headers: Array<[string, string]> = [["content-type", "application/json"]]) => ({ row: "openai", method: "POST", path: "/v1/chat/completions", query: "", headers, body });
async function collect(egress: ReturnType<typeof createCloudModelEgress>, scope: unknown, input: unknown) {
  const events = [];
  for await (const event of egress.forward(scope as never, input as never)) events.push(event);
  return events;
}
const counting = (answer: Awaited<ReturnType<CloudInvoke>> | Error = { StatusCode: 200, EventStream: (async function* () { yield { InvokeComplete: {} }; })() }) => {
  const calls: number[] = [];
  const invoke: CloudInvoke = async (input) => {
    calls.push(input.Payload.byteLength);
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return { invoke, calls };
};
const records = (...parts: Parameters<typeof encodeProductModelRecord>[0][]) => parts.flatMap((part) => encodeProductModelRecord(part));

describe("Cloud model-egress adapter", () => {
  it("is built only over a Lambda client that makes ONE attempt", async () => {
    const make = (input: unknown) => input;
    await expect(cloudInvokeFromLambdaClient(new LambdaClient({ region: "us-west-2" }) as never, make)).rejects.toBeInstanceOf(CloudInvokeRetriesError);
    await expect(cloudInvokeFromLambdaClient(new LambdaClient({ region: "us-west-2", maxAttempts: 2 }) as never, make)).rejects.toBeInstanceOf(CloudInvokeRetriesError);
    await expect(cloudInvokeFromLambdaClient(new LambdaClient({ region: "us-west-2", maxAttempts: 1 }) as never, make)).resolves.toBeTypeOf("function");
  });

  it("refuses a body over 4 MiB and a payload over Lambda's request limit less 64 KiB, before invoking; allows exactly 4 MiB", async () => {
    expect(PRODUCT_MODEL_INVOKE_PAYLOAD_MAX_BYTES).toBe(LAMBDA_SYNC_REQUEST_LIMIT_BYTES - 65_536);
    // The core's own 5 MiB body would not fit once base64-encoded: that is why Cloud's body limit is lower.
    expect(Math.ceil((5 * 1024 * 1024) / 3) * 4).toBeGreaterThan(LAMBDA_SYNC_REQUEST_LIMIT_BYTES);
    const scope = cloudModelEgressScope("pme-v1.x.y");
    const exact = counting();
    const atLimit = await collect(createCloudModelEgress({ functionArn: ARN, invoke: exact.invoke }), scope, frame(new Uint8Array(PRODUCT_MODEL_CLOUD_BODY_MAX_BYTES)));
    expect(exact.calls).toHaveLength(1);
    expect(exact.calls[0]!).toBeLessThanOrEqual(PRODUCT_MODEL_INVOKE_PAYLOAD_MAX_BYTES);
    expect(atLimit.at(-1)).toMatchObject({ kind: "settle", class: "provider_error" });
    for (const input of [frame(new Uint8Array(PRODUCT_MODEL_CLOUD_BODY_MAX_BYTES + 1)), frame(new Uint8Array(PRODUCT_MODEL_CLOUD_BODY_MAX_BYTES), Array.from({ length: 60 }, (_, index) => [`x-pad-${String(index)}`, "v".repeat(8000)] as [string, string]))]) {
      const none = counting();
      const events = await collect(createCloudModelEgress({ functionArn: ARN, invoke: none.invoke }), scope, input);
      expect(none.calls).toHaveLength(0);
      expect(events.at(-1)).toMatchObject({ kind: "settle", refusal: "too_large", costMicros: 0 });
    }
  });

  it("invokes once; a thrown invoke, a non-200, or a function error before the head is a fixed 502; a cut after the head is a provider error, never a silent short answer", async () => {
    const scope = cloudModelEgressScope("pme-v1.x.y");
    const body = new TextEncoder().encode("{}");
    for (const answer of [new Error("socket hang up with details"), { StatusCode: 500 }, { StatusCode: 200, EventStream: (async function* () { yield { InvokeComplete: { ErrorCode: "Unhandled" } }; })() }]) {
      const run = counting(answer);
      const events = await collect(createCloudModelEgress({ functionArn: ARN, invoke: run.invoke }), scope, frame(body));
      expect(run.calls).toHaveLength(1);
      expect(events[0]).toMatchObject({ kind: "head", status: 502 });
      expect(new TextDecoder().decode((events[1] as { bytes: Uint8Array }).bytes)).not.toContain("socket");
      expect(events.at(-1)).toMatchObject({ kind: "settle", status: 502, class: "provider_error" });
    }
    const head = records({ kind: "head", head: { status: 200, headers: [["content-type", "text/event-stream"]] } }, { kind: "chunk", bytes: new TextEncoder().encode("data: part") });
    const cut = counting({ StatusCode: 200, EventStream: (async function* () { for (const bytes of head) yield { PayloadChunk: { Payload: bytes } }; yield { InvokeComplete: { ErrorCode: "Function.ResponseSizeTooLarge" } }; })() });
    const events = await collect(createCloudModelEgress({ functionArn: ARN, invoke: cut.invoke }), scope, frame(body));
    expect(events.map((event) => event.kind)).toEqual(["head", "chunk", "settle"]);
    expect(events.at(-1)).toMatchObject({ status: 200, class: "provider_error", estimated: true });
  });

  it("decides a refusal for a frame the core refuses or a scope it cannot read without invoking", async () => {
    const run = counting();
    const egress = createCloudModelEgress({ functionArn: ARN, invoke: run.invoke });
    for (const [scope, input, word] of [[cloudModelEgressScope("pme-v1.x.y"), { not: "a frame" }, "bad_request"], [undefined, frame(new Uint8Array(2)), "not_found"], [{}, frame(new Uint8Array(2)), "not_found"], [cloudModelEgressScope("x".repeat(5000)), frame(new Uint8Array(2)), "not_found"]] as const) {
      const events = await collect(egress, scope, input);
      expect(events.at(-1)).toMatchObject({ kind: "settle", refusal: word, costMicros: 0 });
    }
    expect(run.calls).toHaveLength(0);
  });

  it("the worker never holds a key: no Invoke payload, adapter log or error carries any spelling of any company's key", async () => {
    const world = await cloudEgressWorld();
    for (const company of TWO_COMPANIES) {
      for (const row of world.rowsList.filter((candidate) => candidate.family !== "bedrock")) {
        world.provider.script({ echoCredential: true, status: 500 });
        const events = await collect(world.adapter, world.scope(company, row.id), { row: row.id, method: "POST", path: row.family === "anthropic_messages" ? "/v1/messages" : "/v1/chat/completions", query: "", headers: [["content-type", "application/json"]], body: new TextEncoder().encode("{\"model\":\"fixture-small\",\"messages\":[]}") });
        expect(events.at(-1)?.kind).toBe("settle");
      }
    }
    expect(world.payloads.length).toBeGreaterThan(0);
    const seen = [...world.payloads, ...world.logs()].join("\n");
    for (const company of [COMPANY_A, COMPANY_B]) for (const key of world.keysOf(company)) for (const spelling of e2eSecretSpellings(key)) expect(seen.includes(spelling)).toBe(false);
  });
});

describe("product model egress record stream", () => {
  it("decodes records split at every byte boundary, and a chunk over the record limit is split, not cut", () => {
    const big = new Uint8Array(PRODUCT_MODEL_RECORD_CHUNK_MAX_BYTES + 10).fill(7);
    const all = Buffer.concat(records({ kind: "head", head: { status: 200, headers: [] } }, { kind: "chunk", bytes: big }, { kind: "settle", settle: { status: 200, class: "ok", costMicros: 5, estimated: false } }));
    for (const step of [1, 2, 5, 4096, all.byteLength]) {
      const decoder = createProductModelRecordDecoder();
      const out = [];
      for (let at = 0; at < all.byteLength; at += step) out.push(...decoder.push(new Uint8Array(all.subarray(at, at + step))));
      decoder.finish();
      expect(out.map((record) => record.kind)).toEqual(["head", "chunk", "chunk", "settle"]);
      expect(out.filter((record) => record.kind === "chunk").reduce((total, record) => total + (record as { bytes: Uint8Array }).bytes.byteLength, 0)).toBe(big.byteLength);
    }
  });

  it("refuses a bad type, an oversize length, records out of order, bytes after the settle, and a stream with no settle", () => {
    const head = records({ kind: "head", head: { status: 200, headers: [] } })[0]!;
    const settle = records({ kind: "settle", settle: { status: 200, class: "ok", costMicros: 0, estimated: false } })[0]!;
    const bad = (bytes: Uint8Array[]) => () => { const decoder = createProductModelRecordDecoder(); for (const part of bytes) decoder.push(part); decoder.finish(); };
    expect(bad([new Uint8Array([9, 0, 0, 0, 0])])).toThrow(ProductModelStreamError);
    expect(bad([new Uint8Array([1, 0xff, 0xff, 0xff, 0xff])])).toThrow(ProductModelStreamError);
    expect(bad([settle])).toThrow(ProductModelStreamError);
    expect(bad([head, head])).toThrow(ProductModelStreamError);
    expect(bad([head, settle, new Uint8Array([2])])).toThrow(ProductModelStreamError);
    expect(bad([head])).toThrow(ProductModelStreamError);
    expect(bad([head, settle.subarray(0, 7)])).toThrow(ProductModelStreamError);
  });
});

describe("the worker's producer of the port", () => {
  it("gives nothing without a plan or an invoke (today's behaviour: Not run, zero calls), and the plan's function and scope with both", async () => {
    const { cloudModelEgressForPlan } = await import("../../packages/worker/src/model-egress-cloud.js");
    const run = counting();
    expect(cloudModelEgressForPlan(undefined, run.invoke)).toBeUndefined();
    expect(cloudModelEgressForPlan({ capability: "pme-v1.x.y", functionArn: ARN }, undefined)).toBeUndefined();
    const made = cloudModelEgressForPlan({ capability: "pme-v1.x.y", functionArn: ARN }, async (input) => { expect(input.FunctionName).toBe(ARN); return run.invoke(input); })!;
    await collect(made.egress, made.scope, frame(new TextEncoder().encode("{}")));
    expect(run.calls).toHaveLength(1);
  });
});
