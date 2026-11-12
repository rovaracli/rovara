import { describe, expect, it } from "vitest";
import { LESSON_EMBEDDER, TEAM_RECORD_EMBEDDER, VECTOR_DIMENSION_DEFAULT, teamRecordVectorIndexName } from "@agentx/cloud-contracts";
import { EmbedderError, createEmbedderClient, type EmbedderClient } from "../../../packages/broker/src/embedder/client.js";
import { EmbedUnavailableError, createEmbedder } from "../../../packages/broker/src/team-record/embed.js";

const unit = (dimension: number): number[] => Array.from({ length: dimension }, () => 1 / Math.sqrt(dimension));
const reply = (spec: typeof TEAM_RECORD_EMBEDDER, count: number, over: Record<string, unknown> = {}) => ({ ok: true, model: spec.model, modelId: spec.modelId, revision: spec.revision, spec: spec.spec, dimension: spec.dimension, vectors: Array.from({ length: count }, () => unit(spec.dimension)), truncated: Array.from({ length: count }, () => false), ...over });
const clientOver = (invoke: Parameters<typeof createEmbedderClient>[0]["invoke"]): EmbedderClient => createEmbedderClient({ spec: TEAM_RECORD_EMBEDDER, invoke, sleep: async () => undefined, baseDelayMs: 1 });

describe("the Team record's embedding model", () => {
  it("is bge-small-en-v1.5 (the lessons' model too) at the index dimension, pinned to a Hugging Face commit, and no Bedrock model", () => {
    expect(TEAM_RECORD_EMBEDDER).toMatchObject({ model: "record", modelId: "BAAI/bge-small-en-v1.5", dimension: 384 });
    expect(TEAM_RECORD_EMBEDDER.dimension).toBe(VECTOR_DIMENSION_DEFAULT);
    expect(TEAM_RECORD_EMBEDDER.revision).toMatch(/^[0-9a-f]{40}$/);
    expect(JSON.stringify(TEAM_RECORD_EMBEDDER)).not.toMatch(/titan|cohere|bedrock/i);
  });
  it("names the vector index by workspace AND spec, so a model change is a new index and two models never share one", () => {
    const current = teamRecordVectorIndexName("ws-a");
    expect(current).toMatch(/^ws-[0-9a-f]{32}$/);
    expect(teamRecordVectorIndexName("ws-a", TEAM_RECORD_EMBEDDER.spec)).toBe(current);
    expect(teamRecordVectorIndexName("ws-a", "0123456789abcdef")).not.toBe(current);
    expect(teamRecordVectorIndexName("ws-b")).not.toBe(current);
    expect(() => teamRecordVectorIndexName("ws-a", "x")).toThrow(/spec/);
  });
  it("refuses a client built for another model (the lessons' 384-d model must never write to the record's index)", () => {
    expect(() => createEmbedder({ client: createEmbedderClient({ spec: LESSON_EMBEDDER, invoke: async () => ({}) }) })).toThrow(/not the Team record's model/);
  });
});

describe("the Team record's embedder reports why a call ended", () => {
  it("carries the client's timing (timeout, deadline) to the caller, and none for any other fault", async () => {
    const through = async (code: string): Promise<EmbedUnavailableError> => createEmbedder({ client: clientOver(async () => { throw Object.assign(new Error("secret text"), { code }); }) }).embed("a").then(() => { throw new Error("expected a refusal"); }, (error: unknown) => error as EmbedUnavailableError);
    expect(await through("AbortError")).toMatchObject({ name: "EmbedUnavailableError", timing: "timeout" });
    expect(await through("DeadlineAbort")).toMatchObject({ timing: "deadline" });
    expect((await through("AccessDeniedException")).timing).toBeUndefined();
  });
});

describe("the Team record's embedder", () => {
  it("embeds a document or a query through the function and exposes the model, revision and spec", async () => {
    const seen: Array<{ kind: string; texts: string[] }> = [];
    const embedder = createEmbedder({ client: clientOver(async (request) => { seen.push({ kind: request.kind, texts: request.texts }); return reply(TEAM_RECORD_EMBEDDER, 1); }) });
    expect(embedder.dimension).toBe(384);
    expect([embedder.modelId, embedder.revision, embedder.spec]).toEqual([TEAM_RECORD_EMBEDDER.modelId, TEAM_RECORD_EMBEDDER.revision, TEAM_RECORD_EMBEDDER.spec]);
    expect(await embedder.embed("  hello  ")).toHaveLength(384);
    expect(await embedder.embed("what did we decide?", "query")).toHaveLength(384);
    expect(seen).toEqual([{ kind: "document", texts: ["hello"] }, { kind: "query", texts: ["what did we decide?"] }]);
  });
  it("cuts very long text before the call and refuses empty text without calling", async () => {
    let calls = 0;
    let sent = "";
    const embedder = createEmbedder({ maxChars: 50, client: clientOver(async (request) => { calls += 1; sent = request.texts[0]!; return reply(TEAM_RECORD_EMBEDDER, 1); }) });
    await embedder.embed("x".repeat(500));
    expect(sent).toHaveLength(50);
    calls = 0;
    await expect(embedder.embed("   ")).rejects.toThrow(/nothing to embed/);
    expect(calls).toBe(0);
  });
  it("says whether the text was cut: by the model's token budget, or by this embedder's own character limit", async () => {
    const tokens = createEmbedder({ client: clientOver(async () => reply(TEAM_RECORD_EMBEDDER, 1, { truncated: [true] })) });
    expect(await tokens.embedWithInfo("a long record")).toMatchObject({ truncated: true });
    const chars = createEmbedder({ maxChars: 50, client: clientOver(async () => reply(TEAM_RECORD_EMBEDDER, 1)) });
    expect((await chars.embedWithInfo("x".repeat(500))).truncated).toBe(true);
    expect((await chars.embedWithInfo("x".repeat(50))).truncated).toBe(false);
  });
  it("turns every failure into the one fixed outcome, with the embedder's code as the only detail and no request text", async () => {
    const failures: Array<[string, () => Promise<unknown>]> = [
      ["UNREACHABLE", async () => { throw Object.assign(new Error("secret detail"), { code: "AccessDeniedException" }); }],
      ["MODEL_UNAVAILABLE", async () => ({ ok: false, code: "MODEL_UNAVAILABLE" })],
      ["SPEC_MISMATCH", async () => reply(TEAM_RECORD_EMBEDDER, 1, { revision: "0".repeat(40) })],
      ["BAD_RESPONSE", async () => reply(TEAM_RECORD_EMBEDDER, 1, { vectors: [[1, 2]] })],
    ];
    for (const [reason, invoke] of failures) {
      const embedder = createEmbedder({ client: clientOver(invoke) });
      try { await embedder.embed("secret text"); expect.unreachable(); } catch (error) {
        expect(error).toBeInstanceOf(EmbedUnavailableError);
        expect((error as EmbedUnavailableError).reason).toBe(reason);
        expect((error as Error).message).toBe("team-record: embedding unavailable");
      }
    }
  });
  it("lets a different error through as the same fixed outcome without a reason", async () => {
    const stray: EmbedderClient = { ...clientOver(async () => ({})), embedDetailed: async () => { throw new TypeError("secret"); } };
    await expect(createEmbedder({ client: stray }).embed("a")).rejects.toMatchObject({ name: "EmbedUnavailableError", reason: undefined });
    expect(EmbedderError).toBeDefined();
  });
});
