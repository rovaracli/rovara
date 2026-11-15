// The deployed gateway process with the product route configured (B5, B6, B8, #57, #58): settings all-or-none, and a started
// process that serves a product call on the project's own key from the DynamoDB key table (sealed with the configured KMS key),
// holds and settles it on the product meter's own tables AND the agent meter's company row (one combined cap), and serves an eval
// stage from the shared stage table. Off unless configured: without the settings every product path is 404.
import { denyNetwork } from "./model-gateway-no-network.js";
beforeAll(denyNetwork);
import { randomBytes, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { FixedCapsSource } from "../../packages/model-gateway/src/caps.js";
import { GATEWAY_ENV, GATEWAY_LEARNING_ENV, GATEWAY_PRODUCT_ENV } from "../../packages/model-gateway/src/deploy.js";
import { Dynamo } from "../../packages/model-gateway/src/dynamo.js";
import { DynamoMeter } from "../../packages/model-gateway/src/dynamo-meter.js";
import { DynamoProductKeyTable } from "../../packages/model-gateway/src/dynamo-product-keys.js";
import { GatewayConfigError, readGatewayConfig, startServe, type RunningGateway, type ServeConfig } from "../../packages/model-gateway/src/process.js";
import { ProductKeyStore } from "../../packages/model-gateway/src/product-keys.js";
import { hmacFingerprinter, kmsProductKeyService, localProductKeyService, ProductKeySealer, type KmsLike } from "../../packages/model-gateway/src/product-seal.js";
import type { ProviderRequest } from "../../packages/model-gateway/src/provider.js";
import { caps, claims, jwk, kid, mint, now, scope as agentScope } from "./model-gateway-fixture.js";
import { geminiAnswer, geminiBody, geminiKey, maintainer, pid, productScope, streamPath } from "./model-gateway-product-fixture.js";
import { WireDynamo } from "./model-gateway-wire-dynamo.js";

const KEY_ARN = "arn:aws:kms:us-west-2:944937319445:key/00000000-0000-4000-8000-000000000000";
const VERTEX_ROLE = "arn:aws:iam::944937319445:role/rovara-cloud-staging-gateway-VertexFederationRole-ABC";
const TABLES = { meter: "gw-meter", ledger: "gw-ledger", markers: "gw-markers", prices: "gw-prices", companies: "cloud-companies" };
const PRODUCT = { keys: "gw-product-keys", meter: "gw-pmeter", ledger: "gw-pledger", markers: "gw-pmarkers", stages: "gw-stages" };
const LEARNING = { meter: "gw-lmeter", ledger: "gw-lledger", markers: "gw-lmarkers" };
const BASE = {
  [GATEWAY_ENV.mode]: "serve", AWS_REGION: "us-west-2", [GATEWAY_ENV.port]: "8080",
  [GATEWAY_ENV.installIssuer]: claims.iss, [GATEWAY_ENV.installJwksUrl]: `${claims.iss}/.well-known/jwks.json`, [GATEWAY_ENV.installTaskKids]: kid,
  [GATEWAY_ENV.meterTable]: TABLES.meter, [GATEWAY_ENV.ledgerTable]: TABLES.ledger, [GATEWAY_ENV.markersTable]: TABLES.markers, [GATEWAY_ENV.pricesTable]: TABLES.prices, [GATEWAY_ENV.companyTable]: TABLES.companies,
  [GATEWAY_ENV.anthropicKeySecret]: "arn:aws:secretsmanager:us-west-2:944937319445:secret:rovara-cloud/staging/model-gateway/provider/anthropic-AbCdEf",
};
const PRODUCT_ENV = {
  [GATEWAY_ENV.productKeysTable]: PRODUCT.keys, [GATEWAY_ENV.productKeysKey]: KEY_ARN, [GATEWAY_ENV.productMeterTable]: PRODUCT.meter,
  [GATEWAY_ENV.productLedgerTable]: PRODUCT.ledger, [GATEWAY_ENV.productMarkersTable]: PRODUCT.markers, [GATEWAY_ENV.evalStagesTable]: PRODUCT.stages,
};
const LEARNING_ENV = { [GATEWAY_ENV.learningMeterTable]: LEARNING.meter, [GATEWAY_ENV.learningLedgerTable]: LEARNING.ledger, [GATEWAY_ENV.learningMarkersTable]: LEARNING.markers };

/** A KMS that wraps data keys with an in-memory key, bound to the encryption context, and names the key it was given. */
function fakeKms(): KmsLike & { keyIds: string[] } {
  const local = localProductKeyService(randomBytes(32)); const keyIds: string[] = [];
  return {
    keyIds,
    async generateDataKey(input) { keyIds.push(input.KeyId); const made = await local.generateDataKey(input.EncryptionContext); return { Plaintext: made.plaintext, CiphertextBlob: made.wrapped }; },
    async decrypt(input) { keyIds.push(input.KeyId); return { Plaintext: await local.unwrapDataKey(input.CiphertextBlob, input.EncryptionContext) }; },
  };
}
class FakeResponse extends EventEmitter {
  statusCode = 0; headers: Record<string, string> = {}; chunks: Buffer[] = []; headersSent = false;
  writeHead(status: number, headers: Record<string, string>) { this.statusCode = status; this.headers = headers; this.headersSent = true; return this; }
  write(bytes: Uint8Array) { this.chunks.push(Buffer.from(bytes)); return true; }
  end(bytes?: Uint8Array | string) { if (bytes !== undefined) this.chunks.push(Buffer.from(bytes)); this.emit("close"); return this; }
  destroy() { this.emit("close"); return this; }
  text() { return Buffer.concat(this.chunks).toString(); }
}
function request(server: RunningGateway["server"], url: string, body: unknown, headers: Record<string, string> = {}): Promise<FakeResponse> {
  const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), { method: "POST", url, headers: { "content-type": "application/json", "x-api-key": mint(), ...headers } });
  const res = new FakeResponse();
  const done = new Promise<FakeResponse>((resolve) => res.once("close", () => resolve(res)));
  server.emit("request", req, res);
  return done;
}
const running: RunningGateway[] = [];
afterEach(async () => { for (const g of running.splice(0)) await g.drain(); });

describe("deployed product settings: off unless configured, all or none", () => {
  it("reads the product, learning and Vertex settings only together, refusing a partial set by the missing name", () => {
    expect(readGatewayConfig(BASE)).not.toHaveProperty("product");
    const config = readGatewayConfig({ ...BASE, ...PRODUCT_ENV, ...LEARNING_ENV, [GATEWAY_ENV.vertexFederationRole]: VERTEX_ROLE }) as ServeConfig;
    expect(config.product).toEqual({ keysTable: PRODUCT.keys, keysKeyArn: KEY_ARN, meter: PRODUCT.meter, ledger: PRODUCT.ledger, markers: PRODUCT.markers, stages: PRODUCT.stages, vertexFederationRoleArn: VERTEX_ROLE });
    expect(config.learning).toEqual(LEARNING);
    const refusedBy = (env: Record<string, string | undefined>) => { try { readGatewayConfig(env); return undefined; } catch (e) { return e instanceof GatewayConfigError ? e.variable : "other"; } };
    for (const name of GATEWAY_PRODUCT_ENV) expect(refusedBy({ ...BASE, ...PRODUCT_ENV, [name]: undefined })).toBe(name);
    for (const name of GATEWAY_LEARNING_ENV) expect(refusedBy({ ...BASE, ...PRODUCT_ENV, ...LEARNING_ENV, [name]: undefined })).toBe(name);
    expect(refusedBy({ ...BASE, ...LEARNING_ENV })).toBe(GATEWAY_ENV.productKeysTable);
    expect(refusedBy({ ...BASE, [GATEWAY_ENV.vertexFederationRole]: VERTEX_ROLE })).toBe(GATEWAY_ENV.productKeysTable);
    expect(refusedBy({ ...BASE, ...PRODUCT_ENV, [GATEWAY_ENV.productKeysKey]: "alias/product" })).toBe(GATEWAY_ENV.productKeysKey);
    expect(refusedBy({ ...BASE, ...PRODUCT_ENV, [GATEWAY_ENV.vertexFederationRole]: "arn:aws:iam::944937319445:role/*" })).toBe(GATEWAY_ENV.vertexFederationRole);
    // No two settings may name the same table (two meters on one table would share rows).
    expect(refusedBy({ ...BASE, ...PRODUCT_ENV, [GATEWAY_ENV.productMeterTable]: TABLES.meter })).toBe(GATEWAY_ENV.productMeterTable);
    expect(refusedBy({ ...BASE, ...PRODUCT_ENV, ...LEARNING_ENV, [GATEWAY_ENV.learningMeterTable]: PRODUCT.meter })).toBe(GATEWAY_ENV.learningMeterTable);
  });
});

describe("deployed product route (started process)", () => {
  async function started(options: { product: boolean }) {
    const wire = new WireDynamo([...Object.values(TABLES), ...Object.values(PRODUCT), ...Object.values(LEARNING)], { namespaceTables: true });
    const db = new Dynamo({ region: "us-west-2", credentials: async () => ({ accessKeyId: "AKIDEXAMPLE", secretAccessKey: "test-secret-not-real" }), transport: wire.transport });
    const kms = fakeKms();
    const key = geminiKey();
    // Cloud's settings route connected the project's key (same table, same KMS key).
    const writer = new ProductKeyStore({ table: new DynamoProductKeyTable(db, PRODUCT.keys), sealer: new ProductKeySealer(kmsProductKeyService(kms, KEY_ARN)), fingerprint: hmacFingerprinter(randomBytes(32)), now: () => now });
    await writer.connect({ iss: claims.iss, cid: claims.cid, owner: pid, requestId: randomUUID(), expectedRevision: 0, actor: maintainer, sourceId: "src_gem", provider: "gemini", key });
    const sent: ProviderRequest[] = [];
    const config = { ...(readGatewayConfig({ ...BASE, ...(options.product ? { ...PRODUCT_ENV, ...LEARNING_ENV } : {}) }) as ServeConfig), port: 0 };
    const gateway = await startServe(config, {
      db, kms, now: () => now, listen: false, log: () => undefined, caps: new FixedCapsSource(caps),
      fetch: async () => new Response(JSON.stringify({ keys: [jwk] }), { status: 200 }), keys: { keyFor: async () => "fixture-provider-key" },
      geminiTransport: async (r) => { sent.push(r); return { status: 200, body: geminiAnswer() }; },
    });
    running.push(gateway);
    return { wire, db, kms, key, sent, gateway };
  }

  it("serves a product call on the project's own key, held and settled on the product tables and the one combined company row", async () => {
    const t = await started({ product: true });
    const res = await request(t.gateway.server, streamPath, geminiBody);
    expect(res.statusCode).toBe(200);
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0]!.key).toBe(t.key);
    expect(t.kms.keyIds.every((id) => id === KEY_ARN)).toBe(true);
    // The settle runs in the call's finally, after the answer ended: a drain waits for it.
    await t.gateway.drain();
    const product = new DynamoMeter({ db: t.db, tables: { meter: PRODUCT.meter, ledger: PRODUCT.ledger, markers: PRODUCT.markers }, now: () => now, combinedCompany: { meter: TABLES.meter, markers: TABLES.markers } });
    const projectRow = (await product.read(productScope)).find((r) => r.item === "project")!;
    expect(projectRow.reservedMicros).toBe(0); expect(projectRow.spentMicros).toBeGreaterThan(0);
    const agent = new DynamoMeter({ db: t.db, tables: TABLES, now: () => now });
    expect((await agent.read(agentScope)).find((r) => r.item === "company")).toMatchObject({ reservedMicros: 0, spentMicros: projectRow.spentMicros });
    // The product rows are on the product tables only; the agent meter table holds just the combined company row.
    expect(t.wire.items(PRODUCT.meter).length).toBeGreaterThan(0);
    expect(t.wire.items(TABLES.meter).filter((row) => String(row.sk).startsWith("ROW#")).map((row) => row.sk)).toEqual([`ROW#${JSON.stringify(["company", new Date(now).toISOString().slice(0, 7)])}`]);
  });

  it("is off without the settings: every product path is 404 and nothing is read from the key table", async () => {
    const t = await started({ product: false });
    const before = t.wire.calls.filter((c) => c.table === PRODUCT.keys).length;
    expect((await request(t.gateway.server, streamPath, geminiBody)).statusCode).toBe(404);
    expect((await request(t.gateway.server, "/v1/product/eval/hold", {})).statusCode).toBe(404);
    expect((await request(t.gateway.server, "/v1/learning/messages", {})).statusCode).toBe(404);
    expect(t.wire.calls.filter((c) => c.table === PRODUCT.keys).length).toBe(before);
    expect(t.sent).toHaveLength(0);
  });

  it("mounts the eval stage controls on the shared stage table: a hold without an approval holds nothing", async () => {
    const t = await started({ product: true });
    const grant = { company: claims.cid, project: pid, selection: "s", role: "maintainer", inputsDigest: "d".repeat(64), provider: "customer", connected: true, maxCalls: 1, maxCostMicros: 1 };
    const res = await request(t.gateway.server, "/v1/product/eval/hold", { grant, calls: 1, costMicros: 1 });
    expect(res.statusCode).toBe(422);
    expect(t.wire.items(PRODUCT.stages)).toEqual([]);
  });
});
