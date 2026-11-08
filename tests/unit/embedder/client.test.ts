// The broker's port to the self-hosted embedder: limits, batching, retries, error mapping, and the answer checks that keep a different model's vectors out of the record.
import { describe, expect, it } from "vitest";
import { LESSON_EMBEDDER, TEAM_RECORD_EMBEDDER } from "@agentx/contracts";
import { EMBEDDER_ERROR_CODES, EMBEDDER_LIMITS, EmbedderError, checkEmbedderReply, createEmbedderClient, embedderBatches, type EmbedderInvoke, type EmbedderRequest } from "../../../packages/broker/src/embedder/client.js";
import { lessonEmbedderFrom, lessonEmbedderOver, recordEmbedderClientFrom } from "../../../packages/broker/src/embedder/wiring.js";
import { lambdaEmbedderInvoke } from "../../../packages/broker/src/team-record/aws-adapters.js";

const unit = (dimension: number): number[] => Array.from({ length: dimension }, () => 1 / Math.sqrt(dimension));
const replyFor = (spec = TEAM_RECORD_EMBEDDER, count = 1, over: Record<string, unknown> = {}): unknown => ({
  ok: true, model: spec.model, modelId: spec.modelId, revision: spec.revision, spec: spec.spec, dimension: spec.dimension, vectors: Array.from({ length: count }, () => unit(spec.dimension)), ...over,
});
const awsError = (code: string) => Object.assign(new Error("secret request text"), { code });
const codeOf = async (run: () => Promise<unknown>): Promise<string> => { try { await run(); return "no error"; } catch (error) { return error instanceof EmbedderError ? error.code : `other: ${String(error)}`; } };
const fast = { sleep: async () => undefined, baseDelayMs: 1 };

describe("the embedder client", () => {
  it("sends the model, the kind and the cleaned text, and returns the vector", async () => {
    const seen: EmbedderRequest[] = [];
    const client = createEmbedderClient({ ...fast, spec: TEAM_RECORD_EMBEDDER, invoke: async (request) => { seen.push(request); return replyFor(TEAM_RECORD_EMBEDDER, request.texts.length); } });
    expect(await client.embed("  hello  ", "query")).toHaveLength(1024);
    expect(seen).toEqual([{ model: "record", kind: "query", texts: ["hello"] }]);
    const lesson = createEmbedderClient({ ...fast, spec: LESSON_EMBEDDER, invoke: async (request) => { seen.push(request); return replyFor(LESSON_EMBEDDER, request.texts.length); } });
    expect(await lesson.embed("x", "document")).toHaveLength(384);
    expect(seen[1]).toEqual({ model: "lesson", kind: "document", texts: ["x"] });
  });

  it("cuts a text at the function's limit, refuses an empty one, and never calls the function for either refusal", async () => {
    let calls = 0;
    const seen: string[][] = [];
    const client = createEmbedderClient({ ...fast, spec: TEAM_RECORD_EMBEDDER, invoke: async (request) => { calls += 1; seen.push(request.texts); return replyFor(TEAM_RECORD_EMBEDDER, request.texts.length); } });
    await client.embed("x".repeat(EMBEDDER_LIMITS.maxTextChars + 500), "document");
    expect(seen[0]![0]).toHaveLength(EMBEDDER_LIMITS.maxTextChars);
    calls = 0;
    expect(await codeOf(() => client.embed("   \n", "document"))).toBe("EMPTY_TEXT");
    expect(await codeOf(() => client.embedMany(["fine", ""], "document"))).toBe("EMPTY_TEXT");
    expect(await codeOf(() => client.embed("a", "search" as never))).toBe("UNKNOWN_KIND");
    expect(await codeOf(() => client.embedMany([3 as never], "document"))).toBe("BAD_REQUEST");
    expect(calls).toBe(0);
  });

  it("splits many texts into requests inside the count and size limits, in order", async () => {
    const batches = embedderBatches(Array.from({ length: 40 }, (_, i) => String(i)));
    expect(batches.map((batch) => batch.length)).toEqual([16, 16, 8]);
    expect(batches.flat()).toEqual(Array.from({ length: 40 }, (_, i) => String(i)));
    const big = "y".repeat(EMBEDDER_LIMITS.maxTextChars);
    const sized = embedderBatches([big, big, big, big, big, "tail"]);
    expect(sized.map((batch) => batch.length)).toEqual([4, 2]);
    for (const batch of sized) expect(batch.join("").length).toBeLessThanOrEqual(EMBEDDER_LIMITS.maxTotalChars);
    const requests: number[] = [];
    const client = createEmbedderClient({ ...fast, spec: LESSON_EMBEDDER, invoke: async (request) => { requests.push(request.texts.length); return replyFor(LESSON_EMBEDDER, request.texts.length); } });
    expect(await client.embedMany(Array.from({ length: 40 }, (_, i) => `lesson ${i}`), "document")).toHaveLength(40);
    expect(requests).toEqual([16, 16, 8]);
    expect(await client.embedMany([], "document")).toEqual([]);
  });

  it("retries a throttle with backoff and then gives up with one fixed code that carries no request text", async () => {
    const delays: number[] = [];
    let calls = 0;
    const client = createEmbedderClient({ spec: TEAM_RECORD_EMBEDDER, attempts: 3, baseDelayMs: 10, sleep: async (ms) => { delays.push(ms); }, invoke: async () => { calls += 1; throw awsError("TooManyRequestsException"); } });
    try { await client.embed("secret text", "document"); expect.unreachable(); } catch (error) {
      expect(error).toBeInstanceOf(EmbedderError);
      expect((error as EmbedderError).code).toBe("UNREACHABLE");
      expect(JSON.stringify(error) + (error as Error).message).not.toContain("secret");
    }
    expect(calls).toBe(3);
    expect(delays).toEqual([10, 20]);
  });

  it("recovers after one throttle, and does not retry a deterministic fault, a function error or a timeout", async () => {
    let calls = 0;
    const flaky = createEmbedderClient({ ...fast, spec: TEAM_RECORD_EMBEDDER, invoke: async () => { calls += 1; if (calls === 1) throw awsError("ServiceException"); return replyFor(); } });
    expect(await flaky.embed("a", "document")).toHaveLength(1024);
    expect(calls).toBe(2);
    for (const code of ["AccessDeniedException", "ResourceNotFoundException", "FunctionError", "AbortError", "BadReply"]) {
      calls = 0;
      const client = createEmbedderClient({ ...fast, spec: TEAM_RECORD_EMBEDDER, attempts: 5, invoke: async () => { calls += 1; throw awsError(code); } });
      expect(await codeOf(() => client.embed("a", "document")), code).toBe("UNREACHABLE");
      expect(calls, code).toBe(1);
    }
  });

  it("maps the function's own refusal codes, and anything it does not know is a bad response", async () => {
    for (const code of ["MODEL_UNAVAILABLE", "INTERNAL", "TOO_MANY_TEXTS", "TEXT_TOO_LONG"]) {
      const client = createEmbedderClient({ ...fast, spec: TEAM_RECORD_EMBEDDER, invoke: async () => ({ ok: false, code }) });
      expect(await codeOf(() => client.embed("a", "document")), code).toBe(code);
    }
    for (const reply of [{ ok: false, code: "SOMETHING_NEW" }, { ok: false, code: { detail: "secret" } }, { ok: false }, null, "text", [], {}]) {
      const client = createEmbedderClient({ ...fast, spec: TEAM_RECORD_EMBEDDER, invoke: async () => reply });
      expect(await codeOf(() => client.embed("a", "document"))).toBe("BAD_RESPONSE");
    }
    expect(EMBEDDER_ERROR_CODES).toContain("SPEC_MISMATCH");
  });

  it("refuses an answer from another model, revision or spec (a changed model must never put vectors beside the stored ones)", async () => {
    for (const over of [{ modelId: "Qwen/Qwen3-Embedding-4B" }, { revision: "0".repeat(40) }, { spec: "0123456789abcdef" }]) {
      const client = createEmbedderClient({ ...fast, spec: TEAM_RECORD_EMBEDDER, invoke: async () => replyFor(TEAM_RECORD_EMBEDDER, 1, over) });
      expect(await codeOf(() => client.embed("a", "document")), JSON.stringify(over)).toBe("SPEC_MISMATCH");
    }
    // The lessons' model answering the record's request is refused too.
    const crossed = createEmbedderClient({ ...fast, spec: TEAM_RECORD_EMBEDDER, invoke: async () => replyFor(LESSON_EMBEDDER) });
    expect(await codeOf(() => crossed.embed("a", "document"))).toBe("BAD_RESPONSE");
  });

  it("validates the dimension, the count, every number and the length of every vector", () => {
    const spec = TEAM_RECORD_EMBEDDER;
    expect(checkEmbedderReply(replyFor(spec, 2), spec, 2)).toHaveLength(2);
    const bad: Array<[string, unknown]> = [
      ["wrong dimension field", replyFor(spec, 1, { dimension: 768 })],
      ["too few vectors", replyFor(spec, 1)],
      ["short vector", replyFor(spec, 2, { vectors: [unit(1024), unit(1023)] })],
      ["not unit length", replyFor(spec, 2, { vectors: [unit(1024), unit(1024).map((v) => v * 2)] })],
      ["NaN", replyFor(spec, 2, { vectors: [unit(1024), [...unit(1023), Number.NaN]] })],
      ["string", replyFor(spec, 2, { vectors: [unit(1024), [...unit(1023), "0.1"]] })],
      ["vectors not a list", replyFor(spec, 2, { vectors: "x" })],
      ["wrong model", replyFor(spec, 2, { model: "lesson" })],
    ];
    for (const [label, reply] of bad) expect(() => checkEmbedderReply(reply, spec, 2), label).toThrow(EmbedderError);
  });
});

describe("the lessons' embedder (for lane lessons-prod)", () => {
  it("embeds one text as a document and many texts in either kind, 384 dimensions", async () => {
    const seen: EmbedderRequest[] = [];
    const invoke: EmbedderInvoke = async (request) => { seen.push(request); return replyFor(LESSON_EMBEDDER, request.texts.length); };
    const embedder = lessonEmbedderOver(createEmbedderClient({ ...fast, spec: LESSON_EMBEDDER, invoke }));
    expect(embedder.dimension).toBe(384);
    expect(embedder.spec).toBe(LESSON_EMBEDDER.spec);
    expect(await embedder.embed("never use var")).toHaveLength(384);
    expect(await embedder.embedMany(["a", "b"], "query")).toHaveLength(2);
    expect(seen.map((request) => [request.model, request.kind, request.texts.length])).toEqual([["lesson", "document", 1], ["lesson", "query", 2]]);
  });

  it("is built from the environment's derived function name, and is absent without one", () => {
    expect(lessonEmbedderFrom({}, { region: "us-west-2" })).toBeUndefined();
    expect(lessonEmbedderFrom({ EMBEDDER_FUNCTION_NAME: "" }, { region: "us-west-2" })).toBeUndefined();
    expect(recordEmbedderClientFrom({}, { region: "us-west-2" })).toBeUndefined();
    expect(recordEmbedderClientFrom({ EMBEDDER_FUNCTION_NAME: "agentx-staging-embedder" }, { region: "us-west-2" })?.spec).toBe(TEAM_RECORD_EMBEDDER);
    expect(lessonEmbedderFrom({ EMBEDDER_FUNCTION_NAME: "agentx-staging-embedder" }, { region: "us-west-2" })?.dimension).toBe(384);
  });
});

describe("the Lambda invoke port", () => {
  type Send = (command: { input: Record<string, unknown> }, options?: { abortSignal?: AbortSignal }) => Promise<unknown>;
  const portWith = (send: Send, timeoutMs = 1000) => lambdaEmbedderInvoke({
    region: "us-west-2", functionName: "agentx-staging-embedder", timeoutMs,
    load: async () => ({ LambdaClient: class { send = send; }, InvokeCommand: class { constructor(readonly input: Record<string, unknown>) {} } }),
  });
  const request: EmbedderRequest = { model: "record", kind: "document", texts: ["a"] };

  it("invokes the one named function, waiting for the answer, with the request as JSON", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const invoke = portWith(async (command) => { seen.push(command.input); return { StatusCode: 200, Payload: Buffer.from(JSON.stringify({ ok: true })) }; });
    expect(await invoke(request)).toEqual({ ok: true });
    expect(seen[0]).toMatchObject({ FunctionName: "agentx-staging-embedder", InvocationType: "RequestResponse" });
    expect(JSON.parse(Buffer.from(seen[0]!.Payload as Uint8Array).toString("utf8"))).toEqual(request);
  });

  it("turns a function error, a bad status, an unreadable payload and an SDK error into a named code without any message text", async () => {
    const cases: Array<[string, Send]> = [
      ["FunctionError", async () => ({ StatusCode: 200, FunctionError: "Unhandled", Payload: Buffer.from("{\"errorMessage\":\"secret request text\"}") })],
      ["BadReply", async () => ({ StatusCode: 202, Payload: Buffer.from("{}") })],
      ["SyntaxError", async () => ({ StatusCode: 200, Payload: Buffer.from("not json secret request text") })],
      ["TooManyRequestsException", async () => { throw Object.assign(new Error("secret request text"), { name: "TooManyRequestsException" }); }],
    ];
    for (const [expected, send] of cases) {
      try { await portWith(send)(request); expect.unreachable(); } catch (error) {
        expect((error as { code?: string }).code, expected).toBe(expected);
        expect((error as Error).message).not.toContain("secret");
      }
    }
  });

  it("gives up waiting after the timeout and abandons the call", async () => {
    let signal: AbortSignal | undefined;
    const invoke = portWith((_command, options) => { signal = options?.abortSignal; return new Promise((_resolve, reject) => { options?.abortSignal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }))); }); }, 20);
    await expect(invoke(request)).rejects.toMatchObject({ code: "AbortError" });
    expect(signal?.aborted).toBe(true);
  });

  it("fails with sdk_unavailable when the package cannot be loaded", async () => {
    const invoke = lambdaEmbedderInvoke({ region: "us-west-2", functionName: "f", timeoutMs: 100, load: async () => ({}) });
    await expect(invoke(request)).rejects.toMatchObject({ code: "sdk_unavailable" });
  });
});
