import { beforeAll, expect, it, vi } from "vitest";
import { denyNetwork } from "./model-gateway-no-network.js";
import { call, caps, claims, MemorySink, mint, now, setup } from "./model-gateway-fixture.js";
import { handleGateway } from "../../packages/model-gateway/src/server.js";
import { createAnswersRoutes, ANSWERS_PATH, ANSWERS_STEP } from "../../packages/model-gateway/src/answers-route.js";
import { toChatCompletions } from "../../packages/model-gateway/src/agent-openai.js";
import { inlineImageBound } from "../../packages/model-gateway/src/inline-image.js";
import { guardBedrockProduct, parseBedrockProductPath } from "../../packages/model-gateway/src/product-bedrock.js";
import { parseBedrockConnect } from "../../packages/model-gateway/src/bedrock-byo.js";
import type { TaskClaims } from "../../packages/model-gateway/src/model-gateway-token.js";
import { guardRequest } from "../../packages/model-gateway/src/guard.js";
import { FixedCapsSource } from "../../packages/model-gateway/src/caps.js";
import { SnapshotPriceSource } from "../../packages/model-gateway/src/price-index.js";
import { answerRateQuote, RATE_QUOTE_AUDIENCE } from "../../packages/model-gateway/src/rate-quote.js";
import type { RunPrice } from "../../packages/model-gateway/src/model-gateway-token.js";

beforeAll(denyNetwork);
const model = "claude-sonnet-5-5";
const id = "us.anthropic.claude-sonnet-5-5";
type Format = "png" | "jpeg" | "gif" | "webp";
function header(format: Format, width: number, height: number): Buffer {
  if (format === "png") {
    const b = Buffer.alloc(33); Buffer.from("89504e470d0a1a0a0000000d49484452", "hex").copy(b);
    b.writeUInt32BE(width, 16); b.writeUInt32BE(height, 20); return b;
  }
  if (format === "gif") {
    const b = Buffer.alloc(13); b.write("GIF89a"); b.writeUInt16LE(width, 6); b.writeUInt16LE(height, 8); return b;
  }
  if (format === "jpeg") {
    const b = Buffer.from("ffd8ffe000040000ffc00011080001000103011100021100031100", "hex");
    b.writeUInt16BE(height, 13); b.writeUInt16BE(width, 15); return b;
  }
  const b = Buffer.alloc(30); b.write("RIFF"); b.writeUInt32LE(22, 4); b.write("WEBPVP8X", 8); b.writeUInt32LE(10, 16);
  b.writeUIntLE(width - 1, 24, 3); b.writeUIntLE(height - 1, 27, 3); return b;
}
const image = (data = header("png", 200, 200), format = "png") => ({ type: "image", source: { type: "base64", media_type: `image/${format}`, data: data.toString("base64") } });
const body = (blocks: unknown[], name = model) => ({ model: name, max_tokens: 64, stream: true, messages: [{ role: "user", content: blocks }] });
const guard = (blocks: unknown[]) => guardRequest(Buffer.from(JSON.stringify(body(blocks))), { "content-type": "application/json" }, [model], { maxOutputTokens: () => 64 });

for (const format of ["png", "jpeg", "gif", "webp"] as const) it.each([
  [1, 1, 1], [28, 28, 1], [29, 28, 2], [200, 200, 64], [1000, 1000, 1296], [8000, 8000, 4784], [9000, 1, 286], [1, 9000, 286],
])(`${format}: bounds %sx%s at %s patches plus margin`, (w, h, patches) => {
  const block = image(header(format, w, h), format);
  expect(guard([block])).toMatchObject({ ok: true, inputBounded: true, images: { tokens: patches + 256, dataBytes: block.source.data.length } });
});
it("clamps huge PNG dimensions without allocating pixels", () => {
  expect(guard([image(header("png", 0xffffffff, 0xffffffff))])).toMatchObject({ ok: true, inputBounded: true, images: { tokens: 4784 + 256 } });
});
for (const format of ["png", "jpeg", "gif", "webp"] as const) it(`${format}: every truncated dimension header remains unbounded`, () => {
  const b = header(format, 200, 200);
  for (let i = 0; i < b.length; i++) expect(guard([image(b.subarray(0, i), format)]), `prefix ${i}`).toMatchObject({ ok: true, inputBounded: false });
});
it.each(["png", "jpeg", "gif"] as const)("%s: zero dimensions refuse", format => {
  expect(guard([image(header(format, 0, 200), format)])).toMatchObject({ inputBounded: false });
  expect(guard([image(header(format, 200, 0), format)])).toMatchObject({ inputBounded: false });
});
it.each([
  { type: "image" }, image(Buffer.from("not an image")), image(undefined, "svg+xml"), image(header("png", 200, 200), "jpeg"),
  { type: "image", source: { type: "url", url: "https://example.test/image.png" } },
  { type: "image", source: { type: "file", file_id: "file_1" } },
  { ...image(), fileData: {} }, { ...image(), cachedContent: "external" },
  { ...image(), source: { ...image().source, data: "AA==!" } },
  { ...image(), source: { ...image().source, data: "" } },
  { ...image(), source: { ...image().source, data: 12 } },
  { ...image(), source: { ...image().source, data: "AB==" } },
])("refuses malformed or remote image %#", block => expect(guard([block])).toMatchObject({ ok: true, inputBounded: false }));
it("counts images across direct and nested tool-result content, with a 100-image ceiling", () => {
  const blocks = [image(), { type: "tool_result", tool_use_id: "read_1", content: Array.from({ length: 99 }, () => image()) }];
  expect(guard(blocks)).toMatchObject({ inputBounded: true, images: { tokens: 100 * (64 + 256) } });
  expect(guard([...blocks, image()])).toMatchObject({ inputBounded: false });
});
it("keeps opaque tool arguments/results outside image classification", () => {
  const opaque = { type: "image", source: { type: "url" } };
  expect(guard([{ type: "tool_use", id: "t", name: "read", input: opaque }, { type: "tool_result", tool_use_id: "t", content: opaque }])).toMatchObject({ inputBounded: true });
});
it.each(["document", "server_tool_use", "fileData", "cachedContent"])("keeps %s refused next to a valid image", type => {
  const block = type === "fileData" || type === "cachedContent" ? { type: "text", text: "x", [type]: {} } : { type };
  expect(guard([image(), block])).toMatchObject({ inputBounded: false });
});

async function world(name = model, cache = false, tier = false) {
  const catalog = name === model ? id : name;
  const prices = new SnapshotPriceSource({ load: async () => ({ version: 9, sources: { litellm: { fetchedAt: now - 100, count: 1, entries: [{ provider: "bedrock", model: catalog, kind: "chat", inputMicrosPerMTok: 1_000_000, outputMicrosPerMTok: 2_000_000, cacheReadMicrosPerMTok: 250_000, cacheWrite5mMicrosPerMTok: 4_000_000, cacheWrite1hMicrosPerMTok: 6_000_000,
    ...(tier ? { longContext: [{ aboveTokens: 32_000, inputMicrosPerMTok: 2_000_000, outputMicrosPerMTok: 3_000_000, cacheReadMicrosPerMTok: 500_000, cacheWrite5mMicrosPerMTok: 8_000_000, cacheWrite1hMicrosPerMTok: 12_000_000 }] } : {}) }] } } }), save: async () => false }, { now: () => now, overrides: [] });
  await prices.reload();
  const rovara = { sourceId: "operator-account@region", models: new Map([[name, catalog]]), exempt: new Set<string>() };
  const sources = { sourceFor: async () => "rovara" as const }; const keys = { connected: async () => false, keyFor: async () => undefined };
  const quoted = await answerRateQuote({ prices, now: () => now, region: "us-west-2", switchedOn: new Set(), offeredProviders: new Set(["bedrock"]), sources, keys, rovara, verify: async () => ({ ...claims, aud: RATE_QUOTE_AUDIENCE }) }, { method: "GET", url: `/v1/service/companies/${claims.cid}/rate-quote?model=${name}&runPrice=1`, headers: { authorization: "Bearer fixture" } });
  const grant = (quoted.body as { runPrice: RunPrice }).runPrice; expect(grant).toBeDefined();
  const f = setup({ prices, agentKeys: keys, chargeReceipts: { source: (_c, _m, resolved) => resolved } });
  const sent: Buffer[] = [];
  f.deps.agentAi = { sources, rovara: { ...rovara, transport: async request => { sent.push(Buffer.from(request.body)); return f.deps.transport(request); } } };
  const blocks: unknown[] = [image()];
  if (cache) blocks.push({ type: "text", text: "cached", cache_control: { type: "ephemeral" } });
  return { ...f, sent, grant, body: body(blocks, name), token: mint({ mdl: [name], runPrice: grant }) };
}
it.each([false, true])("priced Claude accepts Pi nested inline images and settles actual usage (cached=%s)", async cache => {
  const f = await world(model, cache); const reserve = vi.spyOn(f.meter, "reserve"); const settle = vi.spyOn(f.meter, "settleV2");
  const block = image(); f.body.messages[0]!.content.push({ type: "tool_result", tool_use_id: "read_1", content: [block] });
  expect((await call(f.deps, f.body, f.token)).status).toBe(200); expect(f.sent).toHaveLength(1);
  expect(JSON.parse(f.sent[0]!.toString())).toMatchObject({ messages: f.body.messages });
  const tokens = f.sent[0]!.length - 2 * block.source.data.length + 2 * (64 + 256);
  expect(reserve.mock.calls[0]![0].estimateMicros).toBe(tokens * (cache ? 6 : 1) + 64 * 2);
  expect(settle.mock.calls[0]![0].receipt).toMatchObject({ status: "final", amountMicros: { value: 37 } });
});
it.each([false, true])("image tokens reach the long-context hold band (cached=%s)", async cache => {
  const f = await world(model, cache, true); const reserve = vi.spyOn(f.meter, "reserve");
  const block = image(header("png", 8000, 8000)); f.body.messages[0]!.content = Array.from({ length: 7 }, () => block);
  if (cache) f.body.messages[0]!.content.push({ type: "text", text: "cached", cache_control: { type: "ephemeral" } });
  expect((await call(f.deps, f.body, f.token)).status).toBe(200);
  const tokens = f.sent[0]!.length - 7 * block.source.data.length + 7 * (4784 + 256);
  expect(reserve.mock.calls[0]![0].estimateMicros).toBe(tokens * (cache ? 12 : 2) + 64 * 3);
});
it("non-Claude Converse still refuses valid inline images before reserve/send", async () => {
  const f = await world("zai.glm-5"); const reserve = vi.spyOn(f.meter, "reserve");
  expect((await call(f.deps, f.body, f.token)).status).toBe(400);
  expect(reserve).not.toHaveBeenCalled(); expect(f.sent).toHaveLength(0);
});
it("priced Claude refuses malformed images before reserve/send", async () => {
  const f = await world(); const reserve = vi.spyOn(f.meter, "reserve"); f.body.messages[0]!.content = [image(Buffer.from("bad"))];
  expect((await call(f.deps, f.body, f.token)).status).toBe(409);
  expect(reserve).not.toHaveBeenCalled(); expect(f.sent).toHaveLength(0);
});

it("enforces the 5 MiB base64 ceiling before decoding", () => {
  const source = image().source;
  const exact = Buffer.alloc(5 * 1024 * 1024 / 4 * 3); header("png", 200, 200).copy(exact);
  expect(inlineImageBound({ type: "image", source: { ...source, data: exact.toString("base64") } })).toEqual({ tokens: 320, dataBytes: 5 * 1024 * 1024 });
  const oversized = exact.toString("base64") + "AAAA";
  expect(inlineImageBound({ type: "image", source: { ...source, data: oversized } })).toBeUndefined();
});
it("refuses corrupt PNG/GIF signatures and mismatched PNG IHDR size", () => {
  for (const format of ["png", "gif"] as const) {
    const b = header(format, 200, 200); b[0] = 0;
    expect(guard([image(b, format)])).toMatchObject({ inputBounded: false });
  }
  const b = header("png", 200, 200); b.writeUInt32BE(12, 8);
  expect(guard([image(b)])).toMatchObject({ inputBounded: false });
});
it("supports GIF87a, JPEG fill markers and progressive SOF", () => {
  const gif = header("gif", 200, 200); gif.write("GIF87a");
  const jpeg = header("jpeg", 200, 200); jpeg[9] = 0xc2;
  for (const block of [image(gif, "gif"), image(jpeg, "jpeg"), image(Buffer.concat([jpeg.subarray(0, 8), Buffer.from([255]), jpeg.subarray(8)]), "jpeg"), image(Buffer.concat([jpeg.subarray(0, 8), Buffer.from([255, 255, 255]), jpeg.subarray(8)]), "jpeg")]) {
    expect(guard([block])).toMatchObject({ inputBounded: true, images: { tokens: 320 } });
  }
});
it("rejects malformed JPEG segments and caps JPEG header scanning at 64 KiB", () => {
  const original = header("jpeg", 200, 200);
  const corrupt: Buffer[] = [];
  for (const [offset, value] of [[0, 0], [2, 0], [5, 1], [5, 255], [9, 0xc4], [11, 7], [11, 16], [17, 4]] as const) {
    const b = Buffer.from(original); b[offset] = value; corrupt.push(b);
  }
  const large = Buffer.alloc(65535); large[0] = 255; large[1] = 0xe1; large.writeUInt16BE(65533, 2);
  corrupt.push(Buffer.concat([Buffer.from([255, 216]), large, original.subarray(8)]));
  for (const b of corrupt) expect(guard([image(b, "jpeg")])).toMatchObject({ inputBounded: false });
});
function webpChunk(kind: string, bytes: Buffer): Buffer {
  const b = Buffer.alloc(20 + bytes.length + bytes.length % 2); b.write("RIFF"); b.writeUInt32LE(b.length - 8, 4); b.write("WEBP", 8); b.write(kind, 12); b.writeUInt32LE(bytes.length, 16); bytes.copy(b, 20); return b;
}
it("supports VP8 and VP8L dimensions, including their size-bit masks", () => {
  const lossy = Buffer.alloc(10); Buffer.from("9d012a", "hex").copy(lossy, 3); lossy.writeUInt16LE(200 | 0xc000, 6); lossy.writeUInt16LE(200 | 0x8000, 8);
  const lossless = Buffer.alloc(5); lossless[0] = 0x2f; lossless.writeUInt32LE((199 | (199 << 14) | (1 << 28)) >>> 0, 1);
  for (const b of [webpChunk("VP8 ", lossy), webpChunk("VP8L", lossless)]) expect(guard([image(b, "webp")])).toMatchObject({ inputBounded: true, images: { tokens: 320 } });
});
it("rejects malformed WebP containers, chunks, signatures and zero VP8 dimensions", () => {
  const original = header("webp", 200, 200); const corrupt: Buffer[] = [];
  for (const [offset, value] of [[0, 0], [8, 0], [4, 21], [16, 11], [16, 9], [12, 0]] as const) {
    const b = Buffer.from(original); b[offset] = value; corrupt.push(b);
  }
  corrupt.push(webpChunk("VP8L", Buffer.alloc(4)), webpChunk("VP8L", Buffer.alloc(5)), webpChunk("VP8 ", Buffer.alloc(9)), webpChunk("VP8 ", Buffer.alloc(10)));
  const zero = Buffer.alloc(10); Buffer.from("9d012a", "hex").copy(zero, 3); corrupt.push(webpChunk("VP8 ", zero));
  for (const b of corrupt) expect(guard([image(b, "webp")])).toMatchObject({ inputBounded: false });
});
it("counts valid system images and deeply nested tool-result arrays", () => {
  const request = { ...body([{ type: "tool_result", tool_use_id: "t", content: [[[image()]]] }]), system: [image()] };
  expect(guardRequest(Buffer.from(JSON.stringify(request)), { "content-type": "application/json" }, [model], { maxOutputTokens: () => 64 })).toMatchObject({ inputBounded: true, images: { tokens: 640 } });
});
it("accepts a real inline PNG with the documented Messages source shape on the direct route", async () => {
  const block = image(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aB1sAAAAASUVORK5CYII=", "base64"));
  const f = setup(); const reserve = vi.spyOn(f.meter, "reserve");
  const result = await call(f.deps, body([block], claims.mdl[0]));
  expect(result.status).toBe(200); expect(f.calls).toHaveLength(1);
  const encoded = JSON.stringify(body([block], claims.mdl[0]));
  expect(reserve.mock.calls[0]![0].estimateMicros).toBe(Buffer.byteLength(encoded) - block.source.data.length + 257 + 128);
});

it("refuses URL or malformed images even without a signed run price", async () => {
  for (const block of [image(Buffer.from("bad")), { type: "image", source: { type: "url", url: "https://example.test/p.png" } }]) {
    const f = setup(); const reserve = vi.spyOn(f.meter, "reserve");
    const refused = await call(f.deps, body([block], claims.mdl[0]));
    expect(refused.status).toBe(409); expect(refused.text()).toContain("This image can't be priced (only inline png, jpeg, gif or webp up to the size limit can be sent). Send it inline or leave it out.");
    expect(reserve).not.toHaveBeenCalled(); expect(f.calls).toHaveLength(0);
  }
});

it("Bedrock's documented Claude InvokeModel body retains image bounds through its adapter", () => {
  const connection = parseBedrockConnect(JSON.stringify({ scheme: "assume_role", roleArn: "arn:aws:iam::111111111111:role/RovaraBedrockInvoke-org_aaaaaaaaaaaaaaaaaaaa", region: "us-west-2", models: { [model]: id }, allowGlobal: false }));
  const path = parseBedrockProductPath(`/v1/product/bedrock/model/${encodeURIComponent(id)}/invoke`, "");
  expect(connection).toBeDefined(); expect(path).toBeDefined();
  const block = image(header("png", 8000, 8000));
  const checked = guardBedrockProduct({ bytes: Buffer.from(JSON.stringify({ anthropic_version: "bedrock-2023-05-31", max_tokens: 64, messages: [{ role: "user", content: [block] }] })), headers: { "content-type": "application/json" }, path: path!, connection: connection!, claims: claims as TaskClaims, modelLimits: { maxOutputTokens: () => 64 } });
  expect(checked).toMatchObject({ ok: true, inputBounded: true, images: { tokens: 5040, dataBytes: block.source.data.length } });
});

it("rejects a remote source even when it also carries valid inline data", () => {
  expect(guard([{ ...image(), source: { ...image().source, type: "url", url: "https://example.test/i.png" } }])).toMatchObject({ inputBounded: false });
});
it("checks WebP chunk extents independently of the readable dimension prefix", () => {
  const bytes = Buffer.alloc(5); bytes[0] = 0x2f; bytes.writeUInt32LE(199 | (199 << 14), 1);
  for (const declared of [7, 100]) {
    const b = webpChunk("VP8L", bytes); b.writeUInt32LE(declared, 16);
    expect(guard([image(b, "webp")])).toMatchObject({ inputBounded: false });
  }
});
it("rejects high-bit aliases for GIF signatures and WebP chunk names", () => {
  const gif = header("gif", 200, 200); gif[0] = 0xc7;
  const webp = header("webp", 200, 200); webp[12] = 0xd6;
  expect(guard([image(gif, "gif")])).toMatchObject({ inputBounded: false });
  expect(guard([image(webp, "webp")])).toMatchObject({ inputBounded: false });
});

it("rejects a VP8 frame tag with positive readable dimensions but a wrong signature", () => {
  const bytes = Buffer.alloc(10); bytes.writeUInt16LE(200, 6); bytes.writeUInt16LE(200, 8);
  expect(guard([image(webpChunk("VP8 ", bytes), "webp")])).toMatchObject({ inputBounded: false });
});
it("includes image tokens in the atomic budget hold before any provider send", async () => {
  const f = await world(); const reserve = vi.spyOn(f.meter, "reserve");
  f.deps.caps = new FixedCapsSource({ ...caps, task: 500 });
  expect((await call(f.deps, f.body, f.token)).status).toBe(422);
  expect(reserve).toHaveBeenCalledOnce(); expect(reserve.mock.calls[0]![0].estimateMicros).toBeGreaterThan(500);
  expect(f.sent).toHaveLength(0);
});
it("checks cache-write evidence in bands reached only by image tokens", async () => {
  const f = await world(model, true, true); const reserve = vi.spyOn(f.meter, "reserve");
  const prices = f.deps.prices!; const effective = prices.effectiveFor!.bind(prices);
  f.deps.prices = { priceFor: prices.priceFor.bind(prices), quoteBasis: prices.quoteBasis!.bind(prices), effectiveFor: async (...args) => {
    const p = await effective(...args);
    return { ...p, derived: [{ aboveTokens: 32000, keys: ["cacheWrite1hMicrosPerMTok"] }] };
  } };
  const block = image(header("png", 8000, 8000));
  f.body.messages[0]!.content.push(...Array.from({ length: 7 }, () => block));
  const result = await call(f.deps, f.body, f.token);
  expect(result.status).toBe(409); expect(result.text()).toMatch(/cache.write price/iu);
  expect(reserve).not.toHaveBeenCalled(); expect(f.sent).toHaveLength(0);
});

it("rejects otherwise valid image data with a noncanonical base64 suffix", () => {
  for (const suffix of ["!", "\n"]) expect(guard([{ ...image(), source: { ...image().source, data: image().source.data + suffix } }])).toMatchObject({ inputBounded: false });
});
it("includes the tool allowance when checking image-reached cache bands", async () => {
  const f = await world(model, true, true); const reserve = vi.spyOn(f.meter, "reserve");
  const prices = f.deps.prices!; const effective = prices.effectiveFor!.bind(prices);
  f.deps.prices = { priceFor: prices.priceFor.bind(prices), quoteBasis: prices.quoteBasis!.bind(prices), effectiveFor: async (...args) => ({ ...await effective(...args), derived: [{ aboveTokens: 32000, keys: ["cacheWrite1hMicrosPerMTok"] }] }) };
  const block = image(header("png", 8000, 8000));
  f.body.messages[0]!.content.push(...Array.from({ length: 5 }, () => block));
  const padding = { type: "text", text: "" }; f.body.messages[0]!.content.push(padding);
  const request = { ...f.body, tools: [{ name: "read", input_schema: { type: "object" } }] };
  const forwardedBytes = Buffer.byteLength(JSON.stringify({ anthropic_version: "bedrock-2023-05-31", max_tokens: 64, messages: request.messages, tools: request.tools }));
  const imageInput = forwardedBytes - 6 * block.source.data.length + 5 * 5040 + 320;
  padding.text = "x".repeat(32001 - 4096 - imageInput);
  const result = await call(f.deps, request, f.token);
  expect(result.status).toBe(409); expect(result.text()).toMatch(/cache.write price/iu);
  expect(reserve).not.toHaveBeenCalled(); expect(f.sent).toHaveLength(0);
});

it.each(["openai", "openrouter", "endpoint"] as const)("%s still refuses valid inline images while accepting plain text", provider => {
  expect(toChatCompletions(body([{ type: "text", text: "hello" }]), "gpt-5", 64, provider)).toBeDefined();
  expect(toChatCompletions(body([image()]), "gpt-5", 64, provider)).toBeUndefined();
});
it("keeps the image bound in an unsigned call's provisional input floor", async () => {
  const f = await world(); const reserve = vi.spyOn(f.meter, "reserve");
  expect((await call(f.deps, f.body, mint({ mdl: [model] }))).status).toBe(200);
  expect(reserve.mock.calls[0]![0].provisional).toMatchObject({ requestBytes: f.sent[0]!.length - image().source.data.length + 320, toolInputAllowanceTokens: 0, maxOutputTokens: 64 });
});

it("keeps the shared stale-authorization sentence for a non-image unbounded block, not the image sentence", async () => {
  const f = await world(); const reserve = vi.spyOn(f.meter, "reserve");
  f.body.messages[0]!.content = [{ type: "document", source: { type: "url", url: "https://example.test/p.pdf" } }];
  const result = await call(f.deps, f.body, f.token);
  expect(result.status).toBe(409); expect(result.text()).toContain("AI source or price changed; pause this run for fresh authorization.");
  expect(result.text()).not.toContain("can't be priced"); expect(reserve).not.toHaveBeenCalled(); expect(f.sent).toHaveLength(0);
});
it("hosted answers with images require a signed price before any hold or send", async () => {
  const f = await world(); const reserve = vi.spyOn(f.meter, "reserve");
  f.deps.answers = createAnswersRoutes({ keys: f.deps.agentKeys!, meter: f.meter, companyCaps: f.deps.caps, limits: { limitFor: async () => undefined }, modelLimits: f.deps.modelLimits, transport: f.deps.transport,
    rovaraDefault: { ai: f.deps.agentAi!.rovara!, sources: f.deps.agentAi!.sources } });
  const sink = new MemorySink();
  await handleGateway(f.deps, { method: "POST", url: ANSWERS_PATH, headers: { "content-type": "application/json", "x-api-key": mint({ mdl: [model], stp: ANSWERS_STEP }) }, body: (async function* () { yield Buffer.from(JSON.stringify(f.body)); })() }, sink);
  expect(sink.status).toBe(409); expect(reserve).not.toHaveBeenCalled(); expect(f.sent).toHaveLength(0);
});
it("fails closed when a truncated JPEG fill-marker run cannot supply a dimension segment", () => {
  expect(guard([image(Buffer.from("ffd8ffffffff", "hex"), "jpeg")])).toMatchObject({ inputBounded: false });
});
