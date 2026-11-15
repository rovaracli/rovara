// No listener or network: the sandbox cannot bind loopback. Measures the same handler used by node:http.
import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { performance } from "node:perf_hooks";
import { FixedCapsSource, InMemoryEndedTasks, InMemoryMeter, StaticInstallRegistry, createTaskTokenVerifier, handleGateway, type GatewaySink, type ProviderTransport } from "../packages/model-gateway/src/index.js";

const now = Date.now();
const key = generateKeyPairSync("rsa", { modulusLength: 2048 });
const kid = createHash("sha256").update(key.publicKey.export({ type: "spki", format: "der" })).digest("base64url").slice(0, 16);
const issuer = "https://install-a.example/v1/auth";
const claims = { iss: issuer, aud: "rovara-model-gateway", jti: randomUUID(), iat: Math.floor(now / 1000), nbf: Math.floor(now / 1000) - 30, exp: Math.floor(now / 1000) + 900, cid: `org_${"a".repeat(20)}`, pid: "web", pay: { kind: "project", project: "web" }, tid: "measure", ws: randomUUID(), op: randomUUID(), stp: "build", src: "app", mdl: ["claude-sonnet-4-5"] };
const input = [JSON.stringify({ alg: "RS256", typ: "rovara-task+jwt", kid }), JSON.stringify(claims)].map((s) => Buffer.from(s).toString("base64url")).join(".");
const token = `${input}.${sign("RSA-SHA256", Buffer.from(input), key.privateKey).toString("base64url")}`;
const body = Buffer.from(JSON.stringify({ model: claims.mdl[0], messages: [{ role: "user", content: "hello" }], max_tokens: 100, stream: true }));
const frame = (type: string, rest: Record<string, unknown> = {}) => Buffer.from(`data: ${JSON.stringify({ type, ...rest })}\n\n`);
const provider: ProviderTransport = async () => ({ status: 200, body: (async function* () {
  for (const part of [frame("message_start", { message: { usage: { input_tokens: 2 } } }), frame("content_block_delta", { delta: { type: "text_delta", text: "x".repeat(2048) } }), frame("message_delta", { usage: { output_tokens: 5 } }), frame("message_stop")]) {
    await new Promise<void>((r) => setTimeout(r, 1)); yield part;
  }
})() });
const deps = {
  verifyToken: createTaskTokenVerifier({ registry: new StaticInstallRegistry([{ issuer, jwksUrl: `${issuer}/.well-known/jwks.json`, taskKids: [kid] }]), readJwks: async () => [{ ...key.publicKey.export({ format: "jwk" }), kid, rovara_purpose: "task" }], now: () => now }),
  metrics: { overrunBusy: () => undefined }, log: () => undefined,
  modelLimits: { maxOutputTokens: () => 128_000 },
  meter: new InMemoryMeter(), ended: new InMemoryEndedTasks(), caps: new FixedCapsSource({ task: 1_000_000_000, projectMonth: 1_000_000_000 }),
  prices: { priceFor: () => ({ inputMicrosPerMTok: 1_000_000, outputMicrosPerMTok: 2_000_000 }) },
  keys: { keyFor: async () => `fixture-${randomUUID()}` }, transport: provider,
};
interface Sample { first: number; total: number }
async function measure(gateway: boolean): Promise<Sample[]> {
  const rows: Sample[] = [];
  for (let i = 0; i < 300; i++) {
    const start = performance.now(); let first: number | undefined;
    const take = () => { first ??= performance.now() - start; };
    if (gateway) {
      const sink: GatewaySink = { head: (status) => { if (status !== 200) throw new Error("measurement refused"); }, write: async () => { take(); }, end: () => undefined, destroy: () => { throw new Error("measurement incomplete"); } };
      await handleGateway(deps, { method: "POST", url: "/v1/messages", headers: { "content-type": "application/json", "x-api-key": token }, body: (async function* () { yield body; })() }, sink);
    } else {
      const response = await provider({ body, headers: {}, key: "fixture", signal: new AbortController().signal });
      for await (const _part of response.body) { void _part; take(); }
    }
    if (first === undefined) throw new Error("measurement had no bytes");
    rows.push({ first, total: performance.now() - start });
  }
  return rows;
}
function percentiles(rows: Sample[], field: keyof Sample) {
  const sorted = rows.map((r) => r[field]).sort((a, b) => a - b);
  return Object.fromEntries([50, 95, 99].map((p) => [`p${p}`, Number(sorted[Math.ceil(p * rows.length / 100) - 1]!.toFixed(3))]));
}
const direct = await measure(false); const gateway = await measure(true);
const summary = (rows: Sample[]) => ({ ttfbMs: percentiles(rows, "first"), totalMs: percentiles(rows, "total") });
const a = summary(direct), b = summary(gateway);
const difference = (field: keyof typeof a) => Object.fromEntries(Object.keys(a[field]).map((p) => [p, Number((b[field][p]! - a[field][p]!).toFixed(3))]));
console.log(JSON.stringify({ mode: "in-process; code overhead only; no loopback, TLS, network or database", callsPerPath: 300, direct: a, gateway: b, difference: { ttfbMs: difference("ttfbMs"), totalMs: difference("totalMs") } }, null, 2));
