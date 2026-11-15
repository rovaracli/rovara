import { randomBytes, randomUUID } from "node:crypto";
import { InMemoryMeter } from "../../packages/model-gateway/src/meter.js";
import { FixedCapsSource, type CapsSource } from "../../packages/model-gateway/src/caps.js";
import type { ModelLimitsSource } from "../../packages/model-gateway/src/guard.js";
import type { MediaPriceSource } from "../../packages/model-gateway/src/media-price.js";
import { InMemoryProductKeyTable, ProductKeyStore, PRODUCT_COMPANY_OWNER, type ProductActor, type TableWrite } from "../../packages/model-gateway/src/product-keys.js";
import { hmacFingerprinter, localProductKeyService, ProductKeySealer, type ProductKeyService } from "../../packages/model-gateway/src/product-seal.js";
import { createProductRoutes, InMemoryProductOverrunTasks } from "../../packages/model-gateway/src/product-route.js";
import type { ProviderRequest, ProviderTransport } from "../../packages/model-gateway/src/provider.js";
import type { GatewayDependencies } from "../../packages/model-gateway/src/server.js";
import { claims, now, setup } from "./model-gateway-fixture.js";

/** Built at runtime: no key-shaped literal in the repository. */
export const geminiKey = (): string => ["AI", "za"].join("") + randomBytes(24).toString("base64url").slice(0, 35);
export const admin: ProductActor = { id: "b".repeat(64), role: "company_admin" };
export const maintainer: ProductActor = { id: "c".repeat(64), role: "project_maintainer" };
export const iss = claims.iss;
export const cid = claims.cid;
export const pid = claims.pid;
export function geminiSse(parts: Array<Record<string, unknown>>): AsyncIterable<Uint8Array> {
  return (async function* () { for (const p of parts) yield Buffer.from(`data: ${JSON.stringify(p)}\r\n\r\n`); })();
}
export const geminiAnswer = (usage: Record<string, unknown> = { promptTokenCount: 10, candidatesTokenCount: 5 }) => geminiSse([
  { candidates: [{ content: { parts: [{ text: "hi" }], role: "model" } }] },
  { candidates: [{ content: { parts: [{ text: "!" }], role: "model" }, finishReason: "STOP" }], usageMetadata: usage },
]);
export function storeKit(options: { beforeCommit?: (writes: readonly TableWrite[]) => boolean | void; keyService?: ProductKeyService; clock?: () => number } = {}) {
  const table = new InMemoryProductKeyTable(options.beforeCommit);
  const keyService = options.keyService ?? localProductKeyService(randomBytes(32));
  const fingerprintSecret = randomBytes(32);
  let clock = now;
  const store = new ProductKeyStore({ table, sealer: new ProductKeySealer(keyService), fingerprint: hmacFingerprinter(fingerprintSecret), now: options.clock ?? (() => clock) });
  return { table, store, keyService, fingerprintSecret, advance: (ms: number) => { clock += ms; }, setClock: (ms: number) => { clock = ms; } };
}
export const change = (owner: string, expectedRevision: number, actor: ProductActor = admin) => ({ iss, cid, owner, requestId: randomUUID(), expectedRevision, actor });
export { PRODUCT_COMPANY_OWNER };
export async function connected(kit = storeKit(), key = geminiKey()) {
  await kit.store.connect({ ...change(pid, 0, maintainer), sourceId: "src_gem", provider: "gemini", key });
  return { ...kit, key };
}
/** A gateway with the agent route (R3a fixture) plus the product route on a store that holds `key` for project `web`. */
export async function productGateway(options: { transport?: ProviderTransport; overrides?: Partial<GatewayDependencies>; key?: string; connect?: boolean; kit?: ReturnType<typeof storeKit>; companyCaps?: CapsSource; modelLimits?: ModelLimitsSource; media?: MediaPriceSource } = {}) {
  const kit = options.kit ?? storeKit();
  const key = options.key ?? geminiKey();
  if (options.connect !== false) await kit.store.connect({ ...change(pid, 0, maintainer), sourceId: "src_gem", provider: "gemini", key });
  const productMeter = new InMemoryMeter(() => now);
  const productCalls: ProviderRequest[] = [];
  const overrun = new InMemoryProductOverrunTasks();
  const transport: ProviderTransport = options.transport ?? (async (request) => { productCalls.push(request); return { status: 200, body: geminiAnswer() }; });
  const product = createProductRoutes({ keys: kit.store, meter: productMeter, companyCaps: options.companyCaps ?? new FixedCapsSource({ task: 1_000_000_000, projectMonth: 1_000_000_000, companyMonth: 1_000_000_000 }), modelLimits: options.modelLimits ?? { maxOutputTokens: () => 8192 }, transports: { gemini: async (r) => { if (options.transport !== undefined) productCalls.push(r); return transport(r); } }, overrun, ...(options.media === undefined ? {} : { media: options.media }) });
  const base = setup({ product, ...options.overrides });
  return { ...base, kit, key, productMeter, productCalls, overrun };
}
export const productScope = { iss, cid, pid, tid: claims.tid };
export const geminiBody = { contents: [{ role: "user", parts: [{ text: "hello" }] }], generationConfig: { maxOutputTokens: 100 } };
export const streamPath = "/v1/product/gemini/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse";
export const wholePath = "/v1/product/gemini/v1beta/models/gemini-2.5-flash:generateContent";
export { PRODUCT_COMPANY_OWNER as COMPANY };
import { handleGateway } from "../../packages/model-gateway/src/server.js";
import { MemorySink, mint } from "./model-gateway-fixture.js";
export async function productCall(deps: GatewayDependencies, path = streamPath, body: unknown = geminiBody, token = mint(), headers: Record<string, string> = {}) {
  const sink = new MemorySink();
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
  await handleGateway(deps, { method: "POST", url: path, headers: { "content-type": "application/json", "x-api-key": token, ...headers }, body: (async function* () { yield bytes; })() }, sink);
  return sink;
}
