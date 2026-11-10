// The broker's port to the self-hosted embedder: limits, batching, retries, error mapping, and the answer checks that keep a different model's vectors out of the record.
import { describe, expect, it } from "vitest";
import { LESSON_EMBEDDER, TEAM_RECORD_EMBEDDER } from "@agentx/contracts";
import { EMBEDDER_BLANK_CODE_POINTS, EMBEDDER_ERROR_CODES, EMBEDDER_LIMITS, EmbedderError, checkEmbedderReply, createEmbedderClient, embedderBatches, trimEmbedderText, type EmbedderInvoke, type EmbedderRequest } from "../../../packages/broker/src/embedder/client.js";
import { EMBEDDER_INGEST_WAIT_MS, EMBEDDER_JOB_WAIT_MS, EMBEDDER_SEARCH_COOLDOWN_MS, EMBEDDER_SEARCH_WAIT_MS, lessonEmbedderFrom, lessonEmbedderOver, recordEmbedderClientFrom, recordJobEmbedderClientFrom, recordSearchEmbedderClientFrom } from "../../../packages/broker/src/embedder/wiring.js";
import { lambdaEmbedderInvoke } from "../../../packages/broker/src/team-record/aws-adapters.js";

const unit = (dimension: number): number[] => Array.from({ length: dimension }, () => 1 / Math.sqrt(dimension));
const replyFor = (spec = TEAM_RECORD_EMBEDDER, count = 1, over: Record<string, unknown> = {}): unknown => ({
  ok: true, model: spec.model, modelId: spec.modelId, revision: spec.revision, spec: spec.spec, dimension: spec.dimension, vectors: Array.from({ length: count }, () => unit(spec.dimension)), truncated: Array.from({ length: count }, () => false), ...over,
});
const awsError = (code: string) => Object.assign(new Error("secret request text"), { code });
const codeOf = async (run: () => Promise<unknown>): Promise<string> => { try { await run(); return "no error"; } catch (error) { return error instanceof EmbedderError ? error.code : `other: ${String(error)}`; } };
const fast = { sleep: async () => undefined, baseDelayMs: 1 };

describe("why a call ended (the re-embed job tells a long text's timeout from a fault)", () => {
  const timingOf = async (run: () => Promise<unknown>): Promise<string | undefined> => { try { await run(); return "no error"; } catch (error) { return error instanceof EmbedderError ? (error.timing ?? "none") : "other"; } };
  const clientFailingWith = (code: string, extra: { now?: () => number } = {}) => createEmbedderClient({ ...fast, ...extra, spec: TEAM_RECORD_EMBEDDER, invoke: async () => { throw awsError(code); } });

  it("says timeout for the function's own wait, deadline for a run that had no time, and nothing for any other fault", async () => {
    expect(await timingOf(() => clientFailingWith("AbortError").embed("a", "document"))).toBe("timeout");
    expect(await timingOf(() => clientFailingWith("DeadlineAbort").embed("a", "document"))).toBe("deadline");
    expect(await timingOf(() => clientFailingWith("DeadlineElapsed").embed("a", "document"))).toBe("deadline");
    expect(await timingOf(() => clientFailingWith("AccessDeniedException").embed("a", "document"))).toBe("none");
    // A run already over before the call: nothing is sent, and it says deadline.
    expect(await timingOf(() => clientFailingWith("AbortError", { now: () => 1_000 }).embed("a", "document", { deadline: 1_000 }))).toBe("deadline");
  });
});

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

  it("says when a text was cut: the function's token flag, and this port's own character cut", async () => {
    const flags = [true, false];
    const client = createEmbedderClient({ ...fast, spec: TEAM_RECORD_EMBEDDER, invoke: async (request) => replyFor(TEAM_RECORD_EMBEDDER, request.texts.length, { truncated: flags.slice(0, request.texts.length) }) });
    expect((await client.embedManyDetailed(["long text", "short"], "document")).map((entry) => entry.truncated)).toEqual([true, false]);
    const plain = createEmbedderClient({ ...fast, spec: TEAM_RECORD_EMBEDDER, invoke: async (request) => replyFor(TEAM_RECORD_EMBEDDER, request.texts.length) });
    expect((await plain.embedDetailed("x".repeat(EMBEDDER_LIMITS.maxTextChars + 1), "document")).truncated).toBe(true);
    expect((await plain.embedDetailed("x".repeat(EMBEDDER_LIMITS.maxTextChars), "document")).truncated).toBe(false);
    // The vector-only forms still work and return the vectors.
    expect(await plain.embedMany(["a", "b"], "document")).toHaveLength(2);
  });

  it("treats exactly the characters the function treats as blank (JavaScript's trim() and Python's strip() disagree on some)", async () => {
    const calls: string[][] = [];
    const client = createEmbedderClient({ ...fast, spec: TEAM_RECORD_EMBEDDER, invoke: async (request) => { calls.push(request.texts); return replyFor(TEAM_RECORD_EMBEDDER, request.texts.length); } });
    // U+001C to U+001F and U+0085 are blank for Python only; U+FEFF for JavaScript only. A text made of them is refused here, before any call, as the function would refuse it.
    for (const blank of ["\u001c\u001f", "\u0085", "\ufeff", " \u00a0\u3000\n"]) expect(await codeOf(() => client.embed(blank, "document")), JSON.stringify(blank)).toBe("EMPTY_TEXT");
    expect(calls).toEqual([]);
    expect(trimEmbedderText("\u001c a b \ufeff\u0085")).toBe("a b");
    await client.embed("\u001ctext\u0085", "document");
    expect(calls).toEqual([["text"]]);
    for (const code of EMBEDDER_BLANK_CODE_POINTS) expect(trimEmbedderText(`x${String.fromCodePoint(code)}`)).toBe("x");
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

  it("never retries a timeout (review R4): the first call is still busy in its container, so a second one would start another cold container and take another reserved slot", async () => {
    let calls = 0;
    const client = createEmbedderClient({ ...fast, spec: TEAM_RECORD_EMBEDDER, attempts: 5, invoke: async () => { calls += 1; throw awsError("AbortError"); } });
    expect(await codeOf(() => client.embed("a", "query"))).toBe("UNREACHABLE");
    expect(calls).toBe(1);
    // and the option that used to ask for one no longer exists
    expect(Object.keys(createEmbedderClient({ spec: TEAM_RECORD_EMBEDDER, invoke: async () => replyFor() }))).not.toContain("retryOnTimeout");
  });

  it("after a timeout, this client makes no call at all for the pause (the pause is per broker container, so it stops that container from starting a second cold embedder, not a burst across containers), then calls again", async () => {
    let clock = 1_000;
    let calls = 0;
    let slow = true;
    const client = createEmbedderClient({ ...fast, spec: TEAM_RECORD_EMBEDDER, cooldownAfterTimeoutMs: 20_000, now: () => clock, invoke: async () => { calls += 1; if (slow) throw awsError("AbortError"); return replyFor(); } });
    expect(await codeOf(() => client.embed("a", "query"))).toBe("UNREACHABLE");
    expect(calls).toBe(1);
    for (let burst = 0; burst < 5; burst += 1) { clock += 1_000; expect(await codeOf(() => client.embed("a", "query"))).toBe("UNREACHABLE"); }
    expect(calls).toBe(1);
    slow = false;
    clock += 20_000;
    expect(await client.embed("a", "query")).toHaveLength(1024);
    expect(calls).toBe(2);
    // an error that is not a timeout starts no pause
    let other = 0;
    const flaky = createEmbedderClient({ ...fast, spec: TEAM_RECORD_EMBEDDER, cooldownAfterTimeoutMs: 20_000, now: () => clock, invoke: async () => { other += 1; throw awsError("AccessDeniedException"); } });
    await codeOf(() => flaky.embed("a", "query")); await codeOf(() => flaky.embed("a", "query"));
    expect(other).toBe(2);
  });

  it("a call with a deadline waits no longer than what is left of it, sends nothing when the run is over, and starts no retry that cannot finish in time (review R3)", async () => {
    let clock = 10_000;
    const limits: Array<number | undefined> = [];
    const delays: number[] = [];
    let fail = 0;
    const client = createEmbedderClient({ spec: TEAM_RECORD_EMBEDDER, now: () => clock, baseDelayMs: 100, sleep: async (ms) => { delays.push(ms); clock += ms; }, invoke: async (_request, limit) => { limits.push(limit?.timeoutMs); if (fail > 0) { fail -= 1; throw awsError("ServiceException"); } return replyFor(); } });
    await client.embed("a", "document", { deadline: 14_000 });
    expect(limits).toEqual([4_000]);
    await client.embed("a", "document");
    expect(limits.at(-1)).toBeUndefined();
    // past the deadline: not sent
    clock = 14_000;
    expect(await codeOf(() => client.embed("a", "document", { deadline: 14_000 }))).toBe("UNREACHABLE");
    expect(limits).toHaveLength(2);
    // a transient fault whose retry would leave under a second: not retried
    clock = 10_000; fail = 1;
    expect(await codeOf(() => client.embed("a", "document", { deadline: 10_900 }))).toBe("UNREACHABLE");
    expect(limits).toHaveLength(3);
    // with room it is retried, and the retry gets only what is left
    clock = 10_000; fail = 1; limits.length = 0;
    await client.embed("a", "document", { deadline: 20_000 });
    expect(limits).toEqual([10_000, 9_900]);
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
      ["no truncation flags", replyFor(spec, 2, { truncated: undefined })],
      ["too few flags", replyFor(spec, 2, { truncated: [false] })],
      ["a flag that is not a boolean", replyFor(spec, 2, { truncated: [false, "no"] })],
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

  it("has three clients of the one function that differ in how long they wait: search short (no retry, a pause after a timeout), ingest unchanged, the re-embed job longest", () => {
    expect([EMBEDDER_SEARCH_WAIT_MS, EMBEDDER_INGEST_WAIT_MS, EMBEDDER_JOB_WAIT_MS]).toEqual([9_000, 15_000, 20_000]);
    // the one search wait leaves most of the broker's 30 s for the vector query and the keyword fallback
    expect(EMBEDDER_SEARCH_WAIT_MS).toBeLessThan(15_000);
    expect(EMBEDDER_SEARCH_COOLDOWN_MS).toBeGreaterThan(EMBEDDER_SEARCH_WAIT_MS);
    const env = { EMBEDDER_FUNCTION_NAME: "agentx-staging-embedder" };
    for (const client of [recordSearchEmbedderClientFrom(env, { region: "us-west-2" }), recordEmbedderClientFrom(env, { region: "us-west-2" }), recordJobEmbedderClientFrom(env, { region: "us-west-2" })]) expect(client?.spec).toBe(TEAM_RECORD_EMBEDDER);
    expect(recordSearchEmbedderClientFrom({}, { region: "us-west-2" })).toBeUndefined();
    expect(recordJobEmbedderClientFrom({}, { region: "us-west-2" })).toBeUndefined();
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

  it("a call's own limit shortens the wait and never lengthens it (review R3)", async () => {
    const hang: Send = (_command, options) => new Promise((_resolve, reject) => { options?.abortSignal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }))); });
    // configured wait 60 s, the run has 30 ms left: NOTHING is sent (round 4, R3-2: under 200 ms left a call could only start a cold container for an answer nobody waits for). It says nothing about the function, so the code is
    // `DeadlineElapsed` (no pause), not `AbortError`.
    let sends = 0;
    const counting: Send = (command, options) => { sends += 1; return hang(command, options); };
    const startedShort = Date.now();
    await expect(portWith(counting, 60_000)(request, { timeoutMs: 30 })).rejects.toMatchObject({ code: "DeadlineElapsed" });
    await expect(portWith(counting, 60_000)(request, { timeoutMs: 199 })).rejects.toMatchObject({ code: "DeadlineElapsed" });
    expect(sends).toBe(0);
    expect(Date.now() - startedShort).toBeLessThan(5_000);
    // configured wait 60 s, the run has 250 ms left: the call is sent (positive control) and the caller's deadline shortens its wait to about 250 ms; it was in flight for a real wait, so it is an `AbortError`.
    const startedMid = Date.now();
    await expect(portWith(counting, 60_000)(request, { timeoutMs: 250 })).rejects.toMatchObject({ code: "AbortError" });
    expect(sends).toBe(1);
    expect(Date.now() - startedMid).toBeLessThan(5_000);
    // configured wait 30 ms, the run has 60 s left: still gives up at the configured wait
    const startedLong = Date.now();
    await expect(portWith(hang, 30)(request, { timeoutMs: 60_000 })).rejects.toMatchObject({ code: "AbortError" });
    expect(Date.now() - startedLong).toBeLessThan(5_000);
  });

  it("fails with sdk_unavailable when the package cannot be loaded", async () => {
    const invoke = lambdaEmbedderInvoke({ region: "us-west-2", functionName: "f", timeoutMs: 100, load: async () => ({}) });
    await expect(invoke(request)).rejects.toMatchObject({ code: "sdk_unavailable" });
  });
});
