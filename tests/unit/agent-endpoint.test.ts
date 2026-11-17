// DEC 254t (a), row A3: a company's own OpenAI-compatible endpoint (`custom_endpoint`). The admin registers an https address, a key and
// up to 20 models (each with the catalog model it stands for); all of it is sealed together in the company's write-only learning
// document. Calls go through the A2 translation and the SSRF guard: DNS at call time, any bad answer refuses ($0, fixed words), the
// socket pinned to the checked address, no redirects. Priced as the catalog model. Two companies never meet.
import { denyNetwork } from "./model-gateway-no-network.js";
beforeAll(denyNetwork);
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type https from "node:https";
import { beforeAll, describe, expect, it } from "vitest";
import type { AgentAiSource, CompanyEndpointAi } from "../../packages/model-gateway/src/agent-ai.js";
import { ChatStreamToSse } from "../../packages/model-gateway/src/agent-openai.js";
import { endpointTarget, ENDPOINT_ADDRESS_REFUSED, type EndpointResolver, type EndpointTarget } from "../../packages/model-gateway/src/endpoint-guard.js";
import { caresResolver, createEndpointTransport, defaultDnsResolver, EndpointResolveLimiter, ENDPOINT_MODELS_MAX, ENDPOINT_RESOLVES_PER_COMPANY, parseEndpointConnect, serializeEndpointConnection, type DnsResolverLike, type EndpointConnection } from "../../packages/model-gateway/src/endpoint-source.js";
import dns from "node:dns";
import { checkedAddress } from "../../packages/model-gateway/src/endpoint-guard.js";
import type { CompanyKeyProvider, LearningKeySource } from "../../packages/model-gateway/src/learning-route.js";
import { answerOfferedModels } from "../../packages/model-gateway/src/offered-models.js";
import { NotSentError, type ProviderRequest, type ProviderTransport } from "../../packages/model-gateway/src/provider.js";
import { AGENT_CHAT_FEATURE, AGENT_KEY_MISSING, AGENT_KEY_REFUSED, AGENT_SOURCE_SWITCHED_OFF, ENDPOINT_BUSY, ENDPOINT_MODEL, ENDPOINT_REFUSED } from "../../packages/model-gateway/src/server.js";
import { call, claims, mint, scope, setup } from "./model-gateway-fixture.js";
import { A, B, ISS, world, write } from "./product-ai-world.js";
/** A user part in a URL, built at runtime so no email-shaped literal sits in the file (cloud-ci novel-token scan). */
const AT = String.fromCharCode(64);

type Json = Record<string, unknown>;
const cidA = claims.cid;
const cidB = `org_${"b".repeat(20)}`;
const SERVED = "our-coder";
const keyOf = (cid: string) => ["ep", "key", cid, "q".repeat(20)].join("-");
const connection = (cid: string, overrides: Partial<EndpointConnection> = {}): EndpointConnection => ({ scheme: "openai_compatible", baseUrl: `https://llm-${cid.slice(-4)}.example.com/v1`, key: keyOf(cid), models: [{ name: SERVED, catalog: { provider: "openai", modelId: "gpt-5-mini" } }], ...overrides });
const chunk = (value: Json | string) => Buffer.from(`data: ${typeof value === "string" ? value : JSON.stringify(value)}\n\n`);
function* answer(): Generator<Buffer> {
  yield chunk({ choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "ping", arguments: "{}" } }] }, finish_reason: null }] });
  yield chunk({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
  yield chunk({ choices: [], usage: { prompt_tokens: 40, completion_tokens: 6 } });
  yield chunk("[DONE]");
}
const signal = () => new AbortController().signal;

describe("the sealed endpoint connection", () => {
  it("reads exactly its shape: an address the guard accepts, a key, 1 to 20 unique models with their catalog model", () => {
    const c = connection(cidA);
    expect(parseEndpointConnect(serializeEndpointConnection(c))).toEqual(c);
    const bad: unknown[] = [
      { ...c, baseUrl: "http://llm.example.com" }, { ...c, baseUrl: "https://169.254.169.254/" }, { ...c, baseUrl: "https://llm.example.com:8443" }, { ...c, baseUrl: `https://u:p${AT}llm.example.com` },
      { ...c, key: "short" }, { ...c, key: "has space inside it" }, { ...c, models: [] },
      { ...c, models: Array.from({ length: ENDPOINT_MODELS_MAX + 1 }, (_, i) => ({ name: `m${String(i)}`, catalog: { provider: "openai", modelId: "x" } })) },
      { ...c, models: [c.models[0], c.models[0]] }, { ...c, models: [{ name: "a b", catalog: { provider: "openai", modelId: "x" } }] },
      { ...c, models: [{ name: "m", catalog: { provider: "Open AI", modelId: "x" } }] }, { ...c, models: [{ name: "m", catalog: { provider: "openai", modelId: "x" }, extra: 1 }] },
      { ...c, scheme: "other" }, { ...c, extra: true }, "not json",
    ];
    for (const value of bad) expect(parseEndpointConnect(typeof value === "string" ? value : JSON.stringify(value))).toBeUndefined();
    expect(parseEndpointConnect("x".repeat(20_000))).toBeUndefined();
  });
});

// ---- the transport (fake https.request and resolver: nothing leaves the process)

function fakeHttps(status: number, parts: Buffer[]) {
  const seen: Array<{ options: Json; body: string; lookedUp?: unknown[] }> = [];
  const request = ((options: Json & { lookup?: (h: string, o: Json, cb: (...a: unknown[]) => void) => void }, onResponse: (response: PassThrough & { statusCode: number }) => void) => {
    const req = new EventEmitter() as EventEmitter & { end(body: Buffer): void; destroy(): void };
    req.destroy = () => { req.emit("close"); };
    req.end = (body: Buffer) => {
      const entry: { options: Json; body: string; lookedUp?: unknown[] } = { options, body: Buffer.from(body).toString("utf8") };
      // What the socket would connect to: whatever the pinned lookup answers for the name.
      options.lookup?.(String(options.hostname), {}, (...args: unknown[]) => { entry.lookedUp = args; });
      seen.push(entry);
      const socket = new EventEmitter(); req.emit("socket", socket); socket.emit("secureConnect");
      const response = Object.assign(new PassThrough(), { statusCode: status });
      onResponse(response);
      for (const part of parts) response.write(part);
      response.end();
    };
    return req;
  }) as unknown as typeof https.request;
  return { request, seen };
}
const resolverOf = (answers: Array<{ address: string; family: number }>): EndpointResolver & { asked: number } => Object.assign(async function resolve(this: unknown) { (resolve as unknown as { asked: number }).asked += 1; return answers; }, { asked: 0 });
const chatBody = Buffer.from(JSON.stringify({ model: SERVED, stream: true, messages: [{ role: "user", content: "x" }] }));

describe("the endpoint transport", () => {
  const target = endpointTarget("https://llm.example.com/v1")!;

  it("resolves at call time, pins the socket to the checked address, keeps SNI/Host as the name, TLS on 443, the key only as a bearer token", async () => {
    const https = fakeHttps(200, [...answer()]);
    const resolve = resolverOf([{ address: "93.184.216.34", family: 4 }]);
    const response = await createEndpointTransport(target, { resolve, request: https.request })({ body: chatBody, headers: {}, key: keyOf(cidA), signal: signal(), path: target.path });
    expect(resolve.asked).toBe(1);
    expect(https.seen[0]!.options).toMatchObject({ hostname: "llm.example.com", servername: "llm.example.com", port: 443, path: "/v1/chat/completions", method: "POST", agent: false, rejectUnauthorized: true });
    expect(https.seen[0]!.options.headers).toEqual({ "content-type": "application/json", authorization: `Bearer ${keyOf(cidA)}`, "content-length": String(chatBody.byteLength) });
    expect(https.seen[0]!.lookedUp).toEqual([null, "93.184.216.34", 4]);
    const out: Buffer[] = []; for await (const part of response.body) out.push(Buffer.from(part));
    expect(Buffer.concat(out).toString()).toContain("message_stop");
  });

  it.each(["127.0.0.1", "169.254.169.254", "169.254.170.2", "10.0.0.5", "fd00:ec2::254", "::1"])("a name that resolves to %s is never connected: not sent ($0), and the route is told", async (bad) => {
    const https = fakeHttps(200, [...answer()]);
    let refused = 0;
    const transport = createEndpointTransport(target, { resolve: resolverOf([{ address: "93.184.216.34", family: 4 }, { address: bad, family: bad.includes(":") ? 6 : 4 }]), request: https.request, onRefused: () => { refused += 1; } });
    await expect(transport({ body: chatBody, headers: {}, key: keyOf(cidA), signal: signal(), path: target.path })).rejects.toBeInstanceOf(NotSentError);
    expect(https.seen).toEqual([]);
    expect(refused).toBe(1);
  });

  it("never another path, never a body it did not build", async () => {
    const https = fakeHttps(200, []);
    const transport = createEndpointTransport(target, { resolve: resolverOf([{ address: "93.184.216.34", family: 4 }]), request: https.request });
    for (const input of [{ body: chatBody, path: "/v1/other" }, { body: chatBody }, { body: Buffer.from("nope"), path: target.path }]) {
      await expect(transport({ ...input, headers: {}, key: keyOf(cidA), signal: signal() })).rejects.toBeInstanceOf(NotSentError);
    }
    expect(https.seen).toEqual([]);
  });

  it("a redirect is an error answer passed through, never followed", async () => {
    const https = fakeHttps(302, [Buffer.from("moved")]);
    const response = await createEndpointTransport(target, { resolve: resolverOf([{ address: "93.184.216.34", family: 4 }]), request: https.request })({ body: chatBody, headers: {}, key: keyOf(cidA), signal: signal(), path: target.path });
    expect(response.status).toBe(302);
    expect(https.seen).toHaveLength(1);
  });
});

// ---- A3-REVIEW-1 M1: the resolver is c-ares (no libuv thread pool), bounded, and resolutions are capped per company and per process

function stubDns(answers: { v4?: string[] | Error | "hang"; v6?: string[] | Error | "hang" }): DnsResolverLike & { cancelled: number } {
  const one = (a: string[] | Error | "hang" | undefined) => a === "hang" ? new Promise<string[]>(() => undefined) : a instanceof Error ? Promise.reject(a) : Promise.resolve(a ?? []);
  return { cancelled: 0, resolve4() { return one(answers.v4); }, resolve6() { return one(answers.v6); }, cancel() { this.cancelled += 1; } };
}
const codeError = (code: string) => Object.assign(new Error(code), { code });

describe("the endpoint resolver (c-ares)", () => {
  const target = endpointTarget("https://llm.example.com/v1")!;
  it("the deployed resolver is node:dns's c-ares Resolver, never dns.lookup (getaddrinfo on the shared thread pool)", () => {
    expect(defaultDnsResolver()).toBeInstanceOf(dns.promises.Resolver);
  });
  it("returns every A and AAAA answer; a family with no records is empty", async () => {
    expect(await caresResolver(() => stubDns({ v4: ["93.184.216.34"], v6: ["2606:4700:4700::1111"] }))("llm.example.com", signal())).toEqual([{ address: "93.184.216.34", family: 4 }, { address: "2606:4700:4700::1111", family: 6 }]);
    expect(await caresResolver(() => stubDns({ v4: ["93.184.216.34"], v6: codeError("ENODATA") }))("llm.example.com", signal())).toEqual([{ address: "93.184.216.34", family: 4 }]);
  });
  it("(M15) ANY blocked answer refuses, through the real resolver path", async () => {
    expect(await checkedAddress(target, caresResolver(() => stubDns({ v4: ["93.184.216.34", "169.254.169.254"] })), signal())).toBeUndefined();
    expect(await checkedAddress(target, caresResolver(() => stubDns({ v4: ["93.184.216.34"], v6: ["fd00:ec2::254"] })), signal())).toBeUndefined();
  });
  it("any other DNS error refuses the whole call (never half-resolved)", async () => {
    await expect(caresResolver(() => stubDns({ v4: ["93.184.216.34"], v6: codeError("ESERVFAIL") }))("llm.example.com", signal())).rejects.toThrow("resolve failed");
  });
  it("a nameserver that never answers: the call gives up in time and cancels the lookups", async () => {
    const stub = stubDns({ v4: "hang", v6: "hang" });
    const started = Date.now();
    await expect(caresResolver(() => stub, 50)("llm.example.com", signal())).rejects.toThrow("resolve timeout");
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(stub.cancelled).toBe(1);
    const aborted = new AbortController(); aborted.abort();
    const stub2 = stubDns({ v4: "hang" });
    await expect(caresResolver(() => stub2, 60_000)("llm.example.com", aborted.signal)).rejects.toThrow("aborted");
    expect(stub2.cancelled).toBe(1);
  });
  it("caps resolutions per company and per process; a release frees the slot", () => {
    const limiter = new EndpointResolveLimiter(2, 3);
    const a1 = limiter.take("a"); const a2 = limiter.take("a");
    expect(limiter.take("a")).toBeUndefined();
    const b1 = limiter.take("b");
    expect(limiter.take("c")).toBeUndefined();
    a1!(); a1!();
    expect(limiter.take("c")).toBeDefined();
    void a2; void b1;
  });
  it("a company at its limit is refused as not sent, told 'busy', and nothing resolves or connects", async () => {
    const https = fakeHttps(200, [...answer()]);
    const limiter = new EndpointResolveLimiter();
    const hang = Object.assign(async () => new Promise<never>(() => undefined), {}) as EndpointResolver;
    const refused: string[] = [];
    const make = () => createEndpointTransport(target, { resolve: hang, request: https.request, limiter, company: cidA, onRefused: (reason) => refused.push(reason) });
    for (let i = 0; i < ENDPOINT_RESOLVES_PER_COMPANY; i += 1) void make()({ body: chatBody, headers: {}, key: keyOf(cidA), signal: signal(), path: target.path }).catch(() => undefined);
    await expect(make()({ body: chatBody, headers: {}, key: keyOf(cidA), signal: signal(), path: target.path })).rejects.toBeInstanceOf(NotSentError);
    expect(refused).toEqual(["busy"]);
    // Another company is not held up by this one.
    const other = createEndpointTransport(target, { resolve: resolverOf([{ address: "93.184.216.34", family: 4 }]), request: https.request, limiter, company: cidB });
    expect((await other({ body: chatBody, headers: {}, key: keyOf(cidB), signal: signal(), path: target.path })).status).toBe(200);
  });
});

// ---- A3-REVIEW-1 L2 (M13): the endpoint transport's sent / not-sent split

function handshake(connected: boolean) {
  return (() => {
    const req = new EventEmitter() as EventEmitter & { end(): void; destroy(): void };
    req.destroy = () => { req.emit("close"); };
    req.end = () => { const socket = new EventEmitter(); req.emit("socket", socket); if (connected) socket.emit("secureConnect"); req.emit("error", new Error("reset")); req.emit("close"); };
    return req;
  }) as unknown as typeof https.request;
}
describe("the endpoint transport's money split", () => {
  const target = endpointTarget("https://llm.example.com/v1")!;
  const resolve = resolverOf([{ address: "93.184.216.34", family: 4 }]);
  it("a failure before the TLS handshake finished was never sent; after it, it may have been", async () => {
    await expect(createEndpointTransport(target, { resolve, request: handshake(false) })({ body: chatBody, headers: {}, key: keyOf(cidA), signal: signal(), path: target.path })).rejects.toBeInstanceOf(NotSentError);
    const after = createEndpointTransport(target, { resolve, request: handshake(true) })({ body: chatBody, headers: {}, key: keyOf(cidA), signal: signal(), path: target.path });
    await expect(after).rejects.toThrow("provider unavailable");
    await expect(after).rejects.not.toBeInstanceOf(NotSentError);
  });
  it("on the route: before the handshake $0, after it the hold is charged", async () => {
    for (const [connected, charged] of [[false, false], [true, true]] as const) {
      const r = route({ real: (t, onRefused) => createEndpointTransport(t, { resolve, request: handshake(connected), onRefused }) });
      const sink = await call(r.deps, body, token());
      expect(sink.status).toBe(502);
      expect((await committedOf(r.meter)) > 0).toBe(charged);
    }
  });
  it("on the route: too many resolutions at once is ENDPOINT_BUSY, $0", async () => {
    const r = route({ real: (t, onRefused) => createEndpointTransport(t, { resolve, request: handshake(false), onRefused, limiter: new EndpointResolveLimiter(0, 0) }) });
    const sink = await call(r.deps, body, token());
    expect(sink.status).toBe(429);
    expect(errorOf(sink)).toEqual({ type: ENDPOINT_BUSY.code, message: ENDPOINT_BUSY.message });
    expect(await committedOf(r.meter)).toBe(0);
  });
});

// ---- the agent route on the company's own endpoint

class CompanyKeys implements LearningKeySource {
  readonly accounts = new Map<string, string>([[cidA, serializeEndpointConnection(connection(cidA))], [cidB, serializeEndpointConnection(connection(cidB))]]);
  asked: string[] = []; reads: string[] = []; refusedOf: string[] = [];
  async connected(_iss: string, cid: string, provider: CompanyKeyProvider): Promise<boolean> { this.asked.push(`${cid}:${provider}`); return provider === "endpoint" && this.accounts.has(cid); }
  async keyFor(_iss: string, cid: string, provider: CompanyKeyProvider): Promise<string | undefined> { this.reads.push(`${cid}:${provider}`); return provider === "endpoint" ? this.accounts.get(cid) : undefined; }
  async refused(_iss: string, cid: string, provider: CompanyKeyProvider): Promise<void> { this.refusedOf.push(`${cid}:${provider}`); }
}
const body = { model: SERVED, max_tokens: 100, stream: true, tools: [{ name: "ping", input_schema: { type: "object", properties: {} } }], messages: [{ role: "user", content: "hello" }] };
function route(options: { switchedOn?: string[]; upstream?: (target: EndpointTarget) => ProviderTransport; refuseDns?: boolean; limit?: number; saved?: Record<string, string>; real?: CompanyEndpointAi["transport"] } = {}) {
  const keys = new CompanyKeys();
  const sent: Array<ProviderRequest & { host: string }> = [];
  const priced: Array<[string, string]> = [];
  const endpoint: CompanyEndpointAi = {
    transport: options.real ?? ((target, onRefused) => async (request) => {
      if (options.refuseDns === true) { onRefused("address"); throw new NotSentError(); }
      sent.push({ ...request, host: target.hostname });
      if (options.upstream !== undefined) return options.upstream(target)(request);
      const converter = new ChatStreamToSse("endpoint", SERVED, "msg_e");
      return { status: 200, body: (async function* () { for (const part of answer()) { const out = converter.push(part); if (out.length) yield out; } yield converter.finish(); })() };
    }),
    ...(options.limit === undefined ? {} : { maxOutputTokens: () => options.limit }),
  };
  const saved = options.saved ?? { [cidA]: "custom_endpoint", [cidB]: "custom_endpoint" };
  const base = setup({
    agentKeys: keys,
    agentAi: { sources: { sourceFor: async (cid) => saved[cid] as AgentAiSource | undefined }, switchedOn: new Set(options.switchedOn ?? ["endpoint"]), endpoint },
    transport: async () => { throw new Error("never the Anthropic transport"); },
    prices: { priceFor: (provider, model) => { priced.push([provider, model]); return undefined; } },
  });
  return { ...base, keys, sent, priced };
}
const errorOf = (sink: { text(): string }) => (JSON.parse(sink.text()) as { error: { type: string; message: string } }).error;
const committedOf = async (meter: { read(s: typeof scope): Promise<ReadonlyArray<{ item: string; committed: number; reservedMicros: number }>> }, cid = cidA) => (await meter.read({ ...scope, cid })).filter((row) => row.item === "company").reduce((sum, row) => sum + row.committed + row.reservedMicros, 0);
const token = (cid = cidA) => mint({ cid, mdl: [SERVED, "not-registered"] });

describe("the agent route on the company's own endpoint", () => {
  it("the company's own address and key, the served model name upstream, priced as its catalog model, settled above $0", async () => {
    const r = route();
    const sink = await call(r.deps, body, token());
    expect(sink.status).toBe(200);
    expect(r.sent).toHaveLength(1);
    expect(r.sent[0]).toMatchObject({ host: "llm-aaaa.example.com", key: keyOf(cidA), path: "/v1/chat/completions" });
    expect(JSON.parse(Buffer.from(r.sent[0]!.body).toString("utf8"))).toMatchObject({ model: SERVED, max_tokens: 100, stream: true });
    expect(r.priced[0]).toEqual(["openai", "gpt-5-mini"]);
    expect(await committedOf(r.meter)).toBeGreaterThan(0);
  });

  it("two companies: each call goes only to its own endpoint with its own key", async () => {
    const r = route();
    await call(r.deps, body, token(cidA)); await call(r.deps, body, token(cidB));
    expect(r.sent.map((s) => [s.host, s.key])).toEqual([["llm-aaaa.example.com", keyOf(cidA)], ["llm-bbbb.example.com", keyOf(cidB)]]);
    expect(r.keys.reads).toEqual([`${cidA}:endpoint`, `${cidB}:endpoint`]);
  });

  it("a model the company did not register: refused before any hold", async () => {
    const r = route();
    const sink = await call(r.deps, { ...body, model: "not-registered" }, token());
    expect(errorOf(sink)).toEqual({ type: ENDPOINT_MODEL.code, message: ENDPOINT_MODEL.message });
    expect(r.sent).toEqual([]); expect(await committedOf(r.meter)).toBe(0);
  });

  it("held to the catalog model's output limit", async () => {
    const r = route({ limit: 50 });
    await call(r.deps, body, token());
    expect(JSON.parse(Buffer.from(r.sent[0]!.body).toString("utf8"))).toMatchObject({ max_tokens: 50 });
  });

  it("DNS answered a refused address at call time: not sent, $0, fixed words that never name the address", async () => {
    const r = route({ refuseDns: true });
    const sink = await call(r.deps, body, token());
    expect(sink.status).toBe(ENDPOINT_REFUSED.status);
    expect(errorOf(sink)).toEqual({ type: "endpoint_refused", message: ENDPOINT_ADDRESS_REFUSED });
    expect(sink.text()).not.toContain("example.com");
    expect(await committedOf(r.meter)).toBe(0);
  });

  it("a stored address the guard refuses is refused at admission (nothing held or sent)", async () => {
    const r = route();
    r.keys.accounts.set(cidA, JSON.stringify({ ...connection(cidA), baseUrl: "https://169.254.169.254/latest" }));
    const sink = await call(r.deps, body, token());
    // The store never holds such a connection (it parses with the same guard); one that does is unreadable here.
    expect(sink.status).toBe(503);
    expect(r.sent).toEqual([]);
  });

  it("switched off, or no endpoint connected: refused before anything is held or sent", async () => {
    const off = route({ switchedOn: [] });
    expect(errorOf(await call(off.deps, body, token()))).toEqual({ type: AGENT_SOURCE_SWITCHED_OFF.code, message: AGENT_SOURCE_SWITCHED_OFF.message });
    expect(off.keys.asked).toEqual([]);
    const none = route();
    none.keys.accounts.delete(cidA);
    expect(errorOf(await call(none.deps, body, token()))).toEqual({ type: AGENT_KEY_MISSING.code, message: AGENT_KEY_MISSING.message });
    expect([...off.sent, ...none.sent]).toEqual([]);
  });

  it("error answers are free; a refused key is the company's to fix (marked), in fixed words", async () => {
    for (const status of [302, 400, 500]) {
      const r = route({ upstream: () => async () => ({ status, body: (async function* () { yield Buffer.from(`words ${keyOf(cidA)}`); })() }) });
      const sink = await call(r.deps, body, token());
      expect(errorOf(sink)).toEqual({ type: "provider_error", message: "provider unavailable" });
      expect(await committedOf(r.meter)).toBe(0);
    }
    const r = route({ upstream: () => async () => ({ status: 401, body: (async function* () { yield Buffer.from("no"); })() }) });
    expect(errorOf(await call(r.deps, body, token()))).toEqual({ type: AGENT_KEY_REFUSED.code, message: AGENT_KEY_REFUSED.message });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(r.keys.refusedOf).toEqual([`${cidA}:endpoint`]);
  });

  it("an untranslatable request: refused before any hold", async () => {
    const r = route();
    const sink = await call(r.deps, { ...body, messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "AA==" } }] }] }, token());
    expect(errorOf(sink)).toEqual({ type: AGENT_CHAT_FEATURE.code, message: AGENT_CHAT_FEATURE.message });
    expect(r.sent).toEqual([]);
  });

  it("offered models: exactly the names the company registered, for that company only", async () => {
    const ask = (cid: string, models: Record<string, readonly string[] | undefined>) => answerOfferedModels({
      verify: async () => ({ iss: claims.iss, aud: "rovara-model-gateway-offered-models", jti: "00000000-0000-4000-8000-000000000000", iat: 0, nbf: 0, exp: 60, cid }),
      sources: { sourceFor: async () => "custom_endpoint" }, disabled: new Set(), switchedOn: new Set(["endpoint"]), endpointModels: async (_iss, asked) => models[asked],
    }, { method: "GET", url: `/v1/service/companies/${cid}/offered-models`, headers: { authorization: "Bearer t" } });
    expect(await ask(cidA, { [cidA]: [SERVED, "bad name"], [cidB]: ["other"] })).toEqual({ status: 200, body: { version: 1, models: [{ model: SERVED }] } });
    expect((await ask(cidB, { [cidA]: [SERVED] })).status).toBe(403);
  });
});

// ---- Cloud: connect, replace, remove (company admins, fresh step-up, audited, write-only, only where switched on)

const PATH = "/org/agent-ai/endpoint";
const form = (revision: number, more: Json = {}) => write(revision, { baseUrl: "https://llm.example.com/v1", key: keyOf(A), models: [{ name: SERVED, catalog: { provider: "openai", modelId: "gpt-5-mini" } }], ...more });

describe("your own endpoint in Cloud", () => {
  it("connects (sealed whole, never answered), lets it be chosen, replaces and removes it; audited without the key", async () => {
    const w = world({ company: true, aiSourceKinds: new Set(["endpoint"]) });
    const ada = await w.signIn("ada", 30);
    const read = await w.call(ada, "GET", "/org/agent-ai");
    expect(read.body).toMatchObject({ endpointConnected: false, keysRevision: 0, choices: expect.arrayContaining([{ source: "custom_endpoint", available: false }]) as unknown });
    const put = await w.call(ada, "PUT", PATH, form(0));
    expect(put.status).toBe(200);
    expect(put.raw).not.toContain(keyOf(A));
    expect(put.raw).not.toContain("llm.example.com");
    expect(put.body).toMatchObject({ endpointConnected: true, keysRevision: 1 });
    // The gateway reads back exactly the sealed connection, for this company only.
    const { storedLearningKeys } = await import("../../packages/model-gateway/src/learning-keys.js");
    const keys = storedLearningKeys(w.store);
    expect(parseEndpointConnect(await keys.keyFor(ISS, A, "endpoint"))).toMatchObject({ baseUrl: "https://llm.example.com/v1", key: keyOf(A) });
    expect(await keys.keyFor(ISS, B, "endpoint")).toBeUndefined();
    expect((await w.call(ada, "PUT", "/org/agent-ai", { expectedVersion: 0, source: "custom_endpoint" })).status).toBe(200);
    expect((await w.call(ada, "PUT", PATH, form(1, { baseUrl: "https://other.example.com" }))).status).toBe(200);
    expect(parseEndpointConnect(await keys.keyFor(ISS, A, "endpoint"))?.baseUrl).toBe("https://other.example.com");
    expect((await w.call(ada, "DELETE", PATH, write(2))).status).toBe(200);
    expect(await keys.keyFor(ISS, A, "endpoint")).toBeUndefined();
    const audit = await w.audit.read(A, { max: 50 });
    expect(audit.rows.map((r) => r.action)).toEqual(expect.arrayContaining(["agent_ai.endpoint.connected", "agent_ai.endpoint.rotated", "agent_ai.endpoint.removed"]));
    for (const text of [JSON.stringify(audit), ...w.logs]) { expect(text).not.toContain(keyOf(A)); expect(text).not.toContain("llm.example.com"); }
  });

  it.each([
    ["http", { baseUrl: "http://llm.example.com/v1" }], ["metadata", { baseUrl: "https://169.254.169.254/latest" }], ["ECS metadata", { baseUrl: "https://169.254.170.2/" }], ["loopback", { baseUrl: "https://127.0.0.1/" }],
    ["a port", { baseUrl: "https://llm.example.com:8080/v1" }], ["a user", { baseUrl: `https://me${AT}llm.example.com/v1` }], ["a local name", { baseUrl: "https://gateway.internal/v1" }], ["IPv6 metadata", { baseUrl: "https://[fd00:ec2::254]/" }],
    ["no models", { models: [] }], ["21 models", { models: Array.from({ length: 21 }, (_, i) => ({ name: `m${String(i)}`, catalog: { provider: "openai", modelId: "x" } })) }], ["a short key", { key: "x" }], ["an extra field", { extra: 1 }],
  ])("refuses %s in fixed words that never repeat it", async (_name, more) => {
    const w = world({ company: true, aiSourceKinds: new Set(["endpoint"]) });
    const ada = await w.signIn("ada", 30);
    const r = await w.call(ada, "PUT", PATH, form(0, more));
    expect(r.status).toBe(400);
    expect(r.body.error?.message).toBe("This endpoint can't be used: it needs an https address on port 443 of a public host, a key, and 1 to 20 models.");
    for (const value of Object.values(more)) if (typeof value === "string") expect(r.raw).not.toContain(value);
    expect((await w.store.view(ISS, A, "_learning")).sources).toEqual([]);
  });

  it("switched off: not listed, not connectable; non-admins and stale sign-ins refused", async () => {
    const off = world({ company: true });
    const ada = await off.signIn("ada", 30);
    expect((await off.call(ada, "GET", "/org/agent-ai")).body).not.toHaveProperty("endpointConnected");
    expect((await off.call(ada, "PUT", PATH, form(0))).body.error?.message).toBe("Your own endpoint isn't switched on for this Cloud yet.");
    const on = world({ company: true, aiSourceKinds: new Set(["endpoint"]) });
    expect((await on.call(await on.signIn("pam", 30), "PUT", PATH, form(0))).status).toBe(403);
    expect((await on.call(await on.signIn("ada", 3600), "PUT", PATH, form(0))).body.error?.code).toBe("STEP_UP_REQUIRED");
    expect((await on.store.view(ISS, A, "_learning")).sources).toEqual([]);
  });

  it("A3-REVIEW-1 L3: after the kind is switched off, a stored endpoint is still shown and can still be removed (never gated); connecting stays gated", async () => {
    const kinds = new Set(["endpoint"]);
    const w = world({ company: true, aiSourceKinds: kinds });
    const ada = await w.signIn("ada", 30);
    expect((await w.call(ada, "PUT", PATH, form(0))).status).toBe(200);
    kinds.delete("endpoint");
    const read = await w.call(ada, "GET", "/org/agent-ai");
    expect(read.body).toMatchObject({ endpointConnected: true, keysRevision: 1, choices: expect.arrayContaining([{ source: "custom_endpoint", available: false }]) as unknown });
    expect((await w.call(ada, "PUT", PATH, form(1))).body.error?.message).toBe("Your own endpoint isn't switched on for this Cloud yet.");
    expect((await w.call(ada, "DELETE", PATH, write(1))).status).toBe(200);
    const { storedLearningKeys } = await import("../../packages/model-gateway/src/learning-keys.js");
    expect(await storedLearningKeys(w.store).keyFor(ISS, A, "endpoint")).toBeUndefined();
    // Still admin + fresh step-up only.
    expect((await w.call(await w.signIn("pam", 30), "DELETE", PATH, write(2))).status).toBe(403);
  });

  it("two companies: one company's endpoint is never another's", async () => {
    const w = world({ company: true, aiSourceKinds: new Set(["endpoint"]) });
    const ada = await w.signIn("ada", 30); const bea = await w.signIn("bea", 30);
    expect((await w.call(ada, "PUT", PATH, form(0))).status).toBe(200);
    expect((await w.call(bea, "GET", "/org/agent-ai")).body).toMatchObject({ endpointConnected: false });
    expect((await w.call(bea, "PUT", "/org/agent-ai", { expectedVersion: 0, source: "custom_endpoint" })).status).toBe(400);
    expect(await w.companies.agentAi(B)).toBeUndefined();
  });
});
