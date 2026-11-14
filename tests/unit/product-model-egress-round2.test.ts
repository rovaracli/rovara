// TE-F1e fix round 1 (REVIEW-1): the redactor holds a key only for its call (M-1); an answer cut off mid-body is a provider error, never a 2xx "ok" (M-2, all three causes); a fault after the request left keeps
// its reservation and one before anything left releases it (L-1, L-3); the secret read is pinned to its version (L-2); the call deadline sits under the Lambda timeout and covers the body (L-4); an unexpected
// throw still ends the stream with a fixed answer (L-9).
import { EventEmitter } from "node:events";
import type https from "node:https";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { PRODUCT_MODEL_CALL_DEADLINE_MS, PRODUCT_MODEL_FUNCTION_TIMEOUT_SECONDS, createProductModelRecordDecoder } from "@agentx/cloud-contracts";
import { egressRedactorNeedlesHeld, handleProductModelEgress } from "../../packages/broker/src/product-ai/egress-handler.js";
import { streamProductModelEgress } from "../../packages/broker/src/product-ai/egress-lambda.js";
import { meterMonthOf, productAiMeterKeys } from "../../packages/broker/src/product-ai/meter.js";
import { EgressNotSentError, EgressUnreachableError, createCloudProviderTransport } from "../../packages/broker/src/product-ai/provider-transport.js";
import { COMPANY_A, WORLD_NOW, cloudEgressWorld, collectHandler, type CloudEgressWorld } from "../support/product-model-egress-world.js";

const PUBLIC = "34.117.59.200";
const geminiFrame = (prompt = "hello") => ({ row: "gemini", method: "POST", path: "/v1beta/models/fixture-small:generateContent", query: "", headers: [["content-type", "application/json"]] as Array<[string, string]>, body: Buffer.from(JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })).toString("base64") });
const call = async (world: CloudEgressWorld) => collectHandler(world.deps, { v: 1, op: "forward", capability: await world.capability(COMPANY_A, "gemini"), frame: geminiFrame() });
const meterKeys = (world: CloudEgressWorld) => {
  const task = world.table.find((item) => String(item.pk).startsWith("product-ai-meter#task#"))[0];
  return [task === undefined ? undefined : { pk: String(task.pk), sk: "meter" }, productAiMeterKeys.project(COMPANY_A.orgId, "p-gemini", meterMonthOf(WORLD_NOW)), productAiMeterKeys.company(COMPANY_A.orgId, meterMonthOf(WORLD_NOW))];
};

type Mode = { kind: "chunks"; status?: number; headers?: Record<string, string>; chunks: string[]; then?: "error" | "hang" } | { kind: "connect-error" } | { kind: "error-after-send" };
/** An https.request stub: emits `socket` and `secureConnect` like a real TLS request (unless the connection fails first), then answers per `mode`. */
function stub(mode: Mode): typeof https.request {
  return ((_options: unknown, onResponse: (response: unknown) => void) => {
    const request = new EventEmitter() as EventEmitter & { end(body: Buffer): void; destroy(): void };
    let destroyed = false;
    request.destroy = () => { destroyed = true; request.emit("close"); };
    request.end = () => queueMicrotask(() => {
      const socket = new EventEmitter();
      request.emit("socket", socket);
      if (mode.kind === "connect-error") { request.emit("error", new Error("ECONNREFUSED")); request.emit("close"); return; }
      socket.emit("secureConnect");
      request.emit("finish");
      if (mode.kind === "error-after-send") { request.emit("error", new Error("socket hang up")); request.emit("close"); return; }
      const body = new Readable({ read() { /* pushed below */ } }) as Readable & { statusCode?: number; headers?: Record<string, string> };
      body.statusCode = mode.status ?? 200;
      body.headers = mode.headers ?? { "content-type": "application/json" };
      onResponse(body);
      for (const chunk of mode.chunks) body.push(Buffer.from(chunk));
      if (mode.then === "error") queueMicrotask(() => body.destroy(new Error("ECONNRESET")));
      else if (mode.then !== "hang") body.push(null);
      void destroyed;
    });
    return request;
  }) as unknown as typeof https.request;
}
const transportFor = (mode: Mode, over: { responseBytesMax?: number; totalMs?: number } = {}) => createCloudProviderTransport({ lookup: async () => [PUBLIC], request: stub(mode), ...over });

describe("fix round 1", () => {
  it("M-1: the redactor holds a key's spellings only during its call, and drops them when the call ends or is abandoned", async () => {
    const world = await cloudEgressWorld();
    world.provider.script({ chunks: ["data: {\"a\":1}\n\n", "data: {\"b\":2}\n\n"], headers: [["content-type", "text/event-stream"]] });
    expect(egressRedactorNeedlesHeld()).toBe(0);
    const events = handleProductModelEgress(world.deps, { v: 1, op: "forward", capability: await world.capability(COMPANY_A, "gemini"), frame: geminiFrame() });
    const first = await events.next();
    expect(first.value).toMatchObject({ kind: "head", status: 200 });
    expect(egressRedactorNeedlesHeld()).toBeGreaterThan(0);
    await events.return(undefined);
    expect(egressRedactorNeedlesHeld()).toBe(0);
    await call(world);
    await call(world);
    expect(egressRedactorNeedlesHeld()).toBe(0);
  });

  for (const [cause, mode, over] of [
    ["the 10 MiB cap (here 64 bytes)", { kind: "chunks", chunks: ["{\"candidates\":[", "x".repeat(80)] }, { responseBytesMax: 64 }],
    ["a connection reset", { kind: "chunks", chunks: ["{\"candidates\":["], then: "error" }, {}],
    ["the call deadline", { kind: "chunks", chunks: ["{\"candidates\":["], then: "hang" }, { totalMs: 60 }],
  ] as const) {
    it(`M-2: a buffered answer cut off by ${cause} is a 502 provider error with the fixed body, never the provider's 2xx with half a body`, async () => {
      const world = await cloudEgressWorld();
      world.setTransport(transportFor(mode as unknown as Mode, over));
      const answer = await call(world);
      expect(answer.status).toBe(502);
      expect(answer.body).toContain("The provider could not be reached.");
      expect(answer.body).not.toContain("candidates");
      expect(answer.settle).toMatchObject({ status: 502, class: "provider_error", estimated: true });
      expect(answer.settle?.costMicros as number).toBeGreaterThan(0);
    });
  }

  it("M-2: a streamed answer cut off after its head settles as a provider error, not ok", async () => {
    const world = await cloudEgressWorld();
    world.setTransport(transportFor({ kind: "chunks", headers: { "content-type": "text/event-stream" }, chunks: ["data: {\"a\":1}\n\n"], then: "error" }));
    const answer = await call(world);
    expect(answer.status).toBe(200);
    expect(answer.settle).toMatchObject({ class: "provider_error", estimated: true });
  });

  it("L-1: a fault after the request left keeps the reservation on the task, project and company items (estimated)", async () => {
    const world = await cloudEgressWorld();
    world.setTransport(transportFor({ kind: "error-after-send" }));
    const answer = await call(world);
    expect(answer.settle).toMatchObject({ status: 502, class: "provider_error", estimated: true });
    const cost = answer.settle?.costMicros as number;
    expect(cost).toBeGreaterThan(0);
    for (const key of meterKeys(world)) expect(world.table.get(key!)).toMatchObject({ committed: cost, spentMicros: cost, reservedMicros: 0 });
  });

  it("L-3: a failure before anything left the process (lookup, connection, TLS) releases the reservation: nothing is charged", async () => {
    for (const transport of [transportFor({ kind: "connect-error" }), createCloudProviderTransport({ lookup: async () => { throw new Error("ENOTFOUND"); }, request: stub({ kind: "connect-error" }) })]) {
      const world = await cloudEgressWorld();
      world.setTransport(transport);
      const answer = await call(world);
      expect(answer.settle).toMatchObject({ status: 502, class: "provider_error", costMicros: 0 });
      for (const key of meterKeys(world)) expect(world.table.get(key!)).toMatchObject({ committed: 0, reservedMicros: 0 });
    }
  });

  it("L-3: the transport tells a failure before the TLS handshake apart from one after the request was written", async () => {
    await expect(transportFor({ kind: "connect-error" })({ host: "api.openai.com", method: "POST", path: "/v1/chat/completions", query: "", headers: [], body: new Uint8Array(2) })).rejects.toBeInstanceOf(EgressNotSentError);
    await expect(transportFor({ kind: "error-after-send" })({ host: "api.openai.com", method: "POST", path: "/v1/chat/completions", query: "", headers: [], body: new Uint8Array(2) })).rejects.toBeInstanceOf(EgressUnreachableError);
    await expect(createCloudProviderTransport({ lookup: async () => { throw new Error("ENOTFOUND"); } })({ host: "api.openai.com", method: "POST", path: "/v1/chat/completions", query: "", headers: [], body: new Uint8Array(2) })).rejects.toBeInstanceOf(EgressNotSentError);
  });

  it("L-2: the secret read is pinned to the source's version: after a rotation the cached old version still reads the old key", async () => {
    const world = await cloudEgressWorld();
    const source = world.sources.get(`${COMPANY_A.orgId}|p-gemini`)!;
    const stored = world.secrets.stored(source.secretName)!;
    const oldKey = stored.value;
    const newKey = ["rotated", "key", "0123456789".concat("abcdefghijklmnopqrstuvwxyz").repeat(4).slice(0, 16)].join("-");
    const oldVersion = source.secretVersionId;
    stored.history.push({ id: "00000000-0000-4000-8000-00000000ffff", value: newKey });
    stored.stages[oldVersion] = ["AWSPREVIOUS"];
    stored.stages["00000000-0000-4000-8000-00000000ffff"] = ["AWSCURRENT"];
    stored.value = newKey;
    expect(await world.deps.keys.keyFor(COMPANY_A.orgId as never, source)).toBe(oldKey);
    expect(await world.deps.keys.keyFor(COMPANY_A.orgId as never, { ...source, secretVersionId: "00000000-0000-4000-8000-00000000ffff" })).toBe(newKey);
  });

  it("L-4: the call deadline is at least 30 s under the function's timeout, so the settle always runs", () => {
    expect(PRODUCT_MODEL_FUNCTION_TIMEOUT_SECONDS * 1000 - PRODUCT_MODEL_CALL_DEADLINE_MS).toBeGreaterThanOrEqual(30_000);
  });

  it("L-9: an unexpected throw inside the function still ends the stream with a fixed 502 and a provider-error settle, in valid records", async () => {
    const world = await cloudEgressWorld({ override: (deps) => ({ ...deps, rowFor: () => { throw new Error(`boom ${["leak", "detail"].join("-")}`); } }) });
    const written: Uint8Array[] = [];
    let ended = false;
    await streamProductModelEgress(world.deps, { v: 1, op: "forward", capability: await world.capability(COMPANY_A, "gemini"), frame: geminiFrame() }, { write: (chunk) => written.push(chunk), end: () => { ended = true; } });
    expect(ended).toBe(true);
    const decoder = createProductModelRecordDecoder();
    const records = decoder.push(Buffer.concat(written));
    decoder.finish();
    expect(records.map((record) => record.kind)).toEqual(["head", "chunk", "settle"]);
    expect(records[0]).toMatchObject({ head: { status: 502 } });
    expect(records[2]).toMatchObject({ settle: { class: "provider_error", costMicros: 0 } });
    expect(Buffer.concat(written).toString("utf8")).not.toContain("leak-detail");
  });
});
