import { describe, expect, it } from "vitest";
import { EmbedUnavailableError, createEmbedder, embeddingFamily } from "../../../packages/broker/src/team-record/embed.js";

const vec = (n: number) => Array.from({ length: n }, (_, i) => i / n);
const err = (code: string) => Object.assign(new Error("secret detail"), { code });
const base = { sleep: async () => undefined, baseDelayMs: 1 };

describe("embedding model", () => {
  it("accepts Titan V2 and Cohere Embed (with or without a region prefix) and nothing else", () => {
    expect(embeddingFamily("amazon.titan-embed-text-v2:0")).toBe("titan-v2");
    expect(embeddingFamily("us.amazon.titan-embed-text-v2:0")).toBe("titan-v2");
    expect(embeddingFamily("cohere.embed-english-v3")).toBe("cohere");
    expect(() => embeddingFamily("anthropic.claude-3")).toThrow(/not supported/);
    expect(() => embeddingFamily("amazon.titan-embed-text-v1")).toThrow(/not supported/);
  });
  it("refuses a dimension the model cannot return", () => {
    expect(() => createEmbedder({ modelId: "amazon.titan-embed-text-v2:0", dimension: 999, invoke: async () => "" })).toThrow(/dimension/);
    expect(() => createEmbedder({ modelId: "cohere.embed-english-v3", dimension: 512, invoke: async () => "" })).toThrow(/dimension/);
  });
});

describe("Titan V2 embedding", () => {
  it("sends the configured model id with normalize and dimensions, and returns the vector", async () => {
    const seen: Array<{ modelId: string; body: string }> = [];
    const embedder = createEmbedder({ ...base, modelId: "amazon.titan-embed-text-v2:0", dimension: 256, invoke: async (r) => { seen.push(r); return JSON.stringify({ embedding: vec(256), inputTextTokenCount: 3 }); } });
    expect(await embedder.embed("  hello  ")).toHaveLength(256);
    expect(seen[0]!.modelId).toBe("amazon.titan-embed-text-v2:0");
    expect(JSON.parse(seen[0]!.body)).toEqual({ inputText: "hello", dimensions: 256, normalize: true });
  });
  it("cuts very long text before the call", async () => {
    let sent = "";
    const embedder = createEmbedder({ ...base, maxChars: 50, modelId: "amazon.titan-embed-text-v2:0", dimension: 256, invoke: async (r) => { sent = (JSON.parse(r.body) as { inputText: string }).inputText; return JSON.stringify({ embedding: vec(256) }); } });
    await embedder.embed("x".repeat(500));
    expect(sent).toHaveLength(50);
  });
  it("refuses empty text without calling the model", async () => {
    let calls = 0;
    const embedder = createEmbedder({ ...base, modelId: "amazon.titan-embed-text-v2:0", dimension: 256, invoke: async () => { calls += 1; return ""; } });
    await expect(embedder.embed("   ")).rejects.toThrow(/nothing to embed/);
    expect(calls).toBe(0);
  });
  it("retries throttling with backoff, then gives up with a fixed error that carries no model text", async () => {
    const delays: number[] = [];
    let calls = 0;
    const embedder = createEmbedder({ modelId: "amazon.titan-embed-text-v2:0", dimension: 256, baseDelayMs: 10, sleep: async (ms) => { delays.push(ms); }, invoke: async () => { calls += 1; throw err("ThrottlingException"); } });
    const failure = await embedder.embed("hi").catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(EmbedUnavailableError);
    expect((failure as Error).message).not.toContain("secret detail");
    expect(calls).toBe(3);
    expect(delays).toEqual([10, 20]);
  });
  it("does not retry a deterministic error", async () => {
    let calls = 0;
    const embedder = createEmbedder({ ...base, modelId: "amazon.titan-embed-text-v2:0", dimension: 256, invoke: async () => { calls += 1; throw err("AccessDeniedException"); } });
    await expect(embedder.embed("hi")).rejects.toBeInstanceOf(EmbedUnavailableError);
    expect(calls).toBe(1);
  });
  it("refuses a wrong-size, non-numeric or malformed answer", async () => {
    for (const body of [JSON.stringify({ embedding: vec(10) }), JSON.stringify({ embedding: ["a"] }), "not json", JSON.stringify({})]) {
      const embedder = createEmbedder({ ...base, modelId: "amazon.titan-embed-text-v2:0", dimension: 256, invoke: async () => body });
      await expect(embedder.embed("hi")).rejects.toBeInstanceOf(EmbedUnavailableError);
    }
  });
  it("recovers after one throttle", async () => {
    let calls = 0;
    const embedder = createEmbedder({ ...base, modelId: "amazon.titan-embed-text-v2:0", dimension: 256, invoke: async () => { calls += 1; if (calls === 1) throw err("ThrottlingException"); return JSON.stringify({ embedding: vec(256) }); } });
    expect(await embedder.embed("hi")).toHaveLength(256);
  });
});

describe("Cohere Embed", () => {
  it("sends document or query input types and reads both v3 and v4 response shapes", async () => {
    const seen: Array<{ input_type: string }> = [];
    let shape = 0;
    const embedder = createEmbedder({ ...base, modelId: "cohere.embed-english-v3", dimension: 1024, invoke: async (r) => {
      seen.push(JSON.parse(r.body) as { input_type: string });
      return JSON.stringify({ embeddings: shape++ === 0 ? [vec(1024)] : { float: [vec(1024)] } });
    } });
    expect(await embedder.embed("a", "query")).toHaveLength(1024);
    expect(await embedder.embed("b")).toHaveLength(1024);
    expect(seen[0]!.input_type).toBe("search_query");
    expect(seen[1]!.input_type).toBe("search_document");
  });
});
