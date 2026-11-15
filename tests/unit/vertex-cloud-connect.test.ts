// PRODUCT-VERTEX-CLOUD-CONNECT: connecting Vertex AI from Cloud's "Product AI keys" screen. Cloud's settings route sends the
// federation form to the model gateway in a call signed with the product key store's KMS HMAC key (service-call.ts); the gateway
// runs the connection test (a token for the company, the canary company refused) and answers only its fixed result; Cloud seals
// the record only on "ok". Fresh step-up, project or company admin, audited, write-only, two companies never meet.
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { PRODUCT_AI_VERTEX_SOURCE_ID } from "../../packages/cloud-server/src/index.js";
import { PRODUCT_KEY_PURPOSE } from "../../packages/model-gateway/src/product-seal.js";
import type { VertexCredential } from "../../packages/model-gateway/src/product-vertex-credential.js";
import type { ProbeResult } from "../../packages/model-gateway/src/product-vertex-token.js";
import { answerVertexCheck, createVertexCheckHandler, gatewayVertexCheck, serviceCallLimiter, SERVICE_CALL_OPEN, SERVICE_CALL_PER_MINUTE, SERVICE_CALL_AT_HEADER, SERVICE_CALL_MAC_HEADER, SERVICE_CALL_SKEW_MS, serviceCallMessage, VERTEX_CHECK_PATH, type MacSigner, type MacVerifier } from "../../packages/model-gateway/src/service-call.js";
import { A, B, ISS, START, world, write } from "./product-ai-world.js";

const MAC_KEY = "arn:aws:kms:us-west-2:944937319445:key/00000000-0000-4000-8000-0000000000aa";
const GATEWAY = "https://gateway.example.test";
const FORM = { projectId: "acme-evals", location: "us-central1", audience: "//iam.googleapis.com/projects/123456789/locations/global/workloadIdentityPools/rovara-pool/providers/rovara-aws", serviceAccount: null as string | null };

/** A KMS HMAC key in memory: Cloud's side may only sign, the gateway's may only verify (as the key policy says). */
function hmacKms(secret = randomBytes(32)) {
  const calls: string[] = [];
  const mac = (message: Uint8Array) => createHmac("sha256", secret).update(message).digest();
  const signer: MacSigner = { async generateMac(input) { calls.push(`GenerateMac ${input.KeyId}`); return { Mac: new Uint8Array(mac(input.Message)) }; } };
  const verifier: MacVerifier & { down: boolean } = {
    down: false,
    async verifyMac(input) {
      calls.push(`VerifyMac ${input.KeyId}`);
      if (verifier.down) throw new Error("kms unreachable");
      if (input.KeyId !== MAC_KEY || input.Mac.length !== 32 || !timingSafeEqual(Buffer.from(input.Mac), mac(input.Message))) { const e = new Error("kms request refused"); e.name = "KMSInvalidMacException"; throw e; }
      return true;
    },
  };
  return { signer, verifier, calls };
}

/** The gateway's answer over a fake network: Cloud's fetch reaches answerVertexCheck; the probe is recorded per company. */
function gatewayKit(result: (cid: string) => ProbeResult = () => "ok") {
  const kms = hmacKms();
  const probes: Array<{ cid: string; credential: VertexCredential }> = [];
  const clock = { at: START };
  const gateway = { issuer: ISS, kms: kms.verifier, macKeyId: MAC_KEY, vertex: { probe: async (cid: string, credential: VertexCredential) => { probes.push({ cid, credential }); return result(cid); } }, now: () => clock.at };
  const sent: Array<{ url: string; headers: Record<string, string>; body: Buffer }> = [];
  const state = { reachable: true };
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    if (!state.reachable) throw new TypeError("fetch failed");
    const body = Buffer.from(init!.body as Uint8Array);
    const headers = init!.headers as Record<string, string>;
    sent.push({ url: input instanceof Request ? input.url : input.toString(), headers, body });
    const answer = await answerVertexCheck(gateway, { method: init!.method!, headers, body: (async function* () { yield body; })() });
    return new Response(JSON.stringify(answer.body), { status: answer.status });
  }) as typeof fetch;
  const check = gatewayVertexCheck({ address: GATEWAY, issuer: ISS, kms: kms.signer, macKeyId: MAC_KEY, fetch: fetchImpl, now: () => clock.at });
  return { kms, probes, sent, state, gateway, clock, check };
}
const VERTEX = "/projects/web/product-ai/vertex";

describe("Cloud's Vertex connect: the gateway tests, Cloud seals", () => {
  it("a project admin with a fresh step-up connects Vertex: tested for THIS company at the gateway, sealed, audited, the setup shown but never a secret", async () => {
    const g = gatewayKit();
    const w = world({ vertexCheck: g.check });
    const pam = await w.signIn("pam", 30);
    const r = await w.call(pam, "PUT", VERTEX, write(0, FORM));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ vertex: { connected: true, projectId: "acme-evals", location: "us-central1" }, key: { connected: false } });
    expect(g.probes).toEqual([{ cid: A, credential: { scheme: "federation", projectId: "acme-evals", location: "us-central1", audience: FORM.audience } }]);
    // The call went to the gateway's one path, signed; Cloud only signs, the gateway only verifies.
    expect(g.sent.map((s) => s.url)).toEqual([`${GATEWAY}${VERTEX_CHECK_PATH}`]);
    expect(g.kms.calls).toEqual([`GenerateMac ${MAC_KEY}`, `VerifyMac ${MAC_KEY}`]);
    // Sealed in the store as the project's Vertex source; the product route can resolve it.
    expect(await w.store.resolve(ISS, A, "web", "vertex")).toMatchObject({ sourceId: PRODUCT_AI_VERTEX_SOURCE_ID, owner: "web" });
    expect(await w.store.resolve(ISS, B, "web", "vertex")).toBeUndefined();
    const actions = (await w.audit.read(A, { max: 50 })).rows.map((each) => each.action);
    expect(actions).toContain("product_ai.vertex.connected");
    // A second save rotates (tested again), then removal.
    const again = await w.call(pam, "PUT", VERTEX, write(1, { ...FORM, serviceAccount: "evals-runner@acme-evals.iam.gserviceaccount.com" }));
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ vertex: { connected: true, serviceAccount: "evals-runner@acme-evals.iam.gserviceaccount.com" } });
    expect(g.probes).toHaveLength(2);
    const removed = await w.call(pam, "DELETE", VERTEX, write(2));
    expect(removed.status).toBe(200);
    expect(removed.body).toMatchObject({ vertex: { connected: false }, vertexRemovedUntil: expect.any(Number) as unknown });
    expect((await w.audit.read(A, { max: 50 })).rows.map((each) => each.action)).toEqual(expect.arrayContaining(["product_ai.vertex.rotated", "product_ai.vertex.removed"]));
  });

  it("saves nothing unless the gateway says ok: too open, refused, unreachable each have their own fixed answer", async () => {
    for (const [result, status, words] of [["too_open", 400, /other Rovara companies/u], ["refused", 400, /Google refused/u], ["unavailable", 503, /unavailable right now/u]] as const) {
      const g = gatewayKit(() => result);
      const w = world({ vertexCheck: g.check });
      const pam = await w.signIn("pam", 30);
      const r = await w.call(pam, "PUT", VERTEX, write(0, FORM));
      expect(r.status).toBe(status);
      expect(r.body.error?.message).toMatch(words);
      expect(await w.store.resolve(ISS, A, "web", "vertex")).toBeUndefined();
      expect((await w.store.view(ISS, A, "web")).revision).toBe(0);
    }
    const g = gatewayKit(); g.state.reachable = false;
    const w = world({ vertexCheck: g.check });
    const r = await w.call(await w.signIn("pam", 30), "PUT", VERTEX, write(0, FORM));
    expect(r.status).toBe(503);
    expect(await w.store.resolve(ISS, A, "web", "vertex")).toBeUndefined();
    // No gateway configured at all (no vertexCheck): unavailable, nothing saved.
    const none = world();
    expect((await none.call(await none.signIn("pam", 30), "PUT", VERTEX, write(0, FORM))).status).toBe(503);
  });

  it("needs a fresh step-up and an admin; refuses a bad form without calling the gateway; never echoes input", async () => {
    const g = gatewayKit();
    const w = world({ vertexCheck: g.check });
    expect((await w.call(await w.signIn("pam"), "PUT", VERTEX, write(0, FORM))).body.error?.code).toBe("STEP_UP_REQUIRED");
    expect((await w.call(await w.signIn("pam", 3600), "PUT", VERTEX, write(0, FORM))).body.error?.code).toBe("STEP_UP_REQUIRED");
    expect((await w.call(await w.signIn("cal", 30), "PUT", VERTEX, write(0, FORM))).status).toBe(403);
    const pam = await w.signIn("pam", 30);
    for (const bad of [{ ...FORM, projectId: "Bad Project<script>" }, { ...FORM, location: "us" }, { ...FORM, audience: "https://evil.example" }, { ...FORM, serviceAccount: "someone@gmail.com" }, { ...FORM, extra: 1 }, { projectId: FORM.projectId }]) {
      const r = await w.call(pam, "PUT", VERTEX, write(0, bad));
      expect(r.status).toBe(400);
      expect(r.raw).not.toContain("script");
      expect(r.raw).not.toContain("evil");
    }
    expect(g.probes).toHaveLength(0);
    expect(g.sent).toHaveLength(0);
  });

  it("two companies: Bob's project 'web' in company B is tested as B and stored as B, never touching A", async () => {
    const g = gatewayKit((cid) => (cid === A ? "ok" : "ok"));
    const w = world({ vertexCheck: g.check });
    expect((await w.call(await w.signIn("bob", 30), "PUT", VERTEX, write(0, FORM))).status).toBe(200);
    expect(g.probes.map((p) => p.cid)).toEqual([B]);
    expect(await w.store.resolve(ISS, B, "web", "vertex")).toBeDefined();
    expect(await w.store.resolve(ISS, A, "web", "vertex")).toBeUndefined();
  });
});

describe("the gateway's signed Vertex check (service-call.ts)", () => {
  const signedCall = async (g: ReturnType<typeof gatewayKit>, body: unknown, at = g.clock.at, path = VERTEX_CHECK_PATH) => {
    const bytes = Buffer.from(JSON.stringify(body));
    const mac = Buffer.from((await g.kms.signer.generateMac({ KeyId: MAC_KEY, Message: serviceCallMessage(path, at, bytes) })).Mac!).toString("base64url");
    return { bytes, headers: { [SERVICE_CALL_AT_HEADER]: String(at), [SERVICE_CALL_MAC_HEADER]: mac } };
  };
  const send = (g: ReturnType<typeof gatewayKit>, c: { bytes: Buffer; headers: Record<string, string> }, method = "POST") => answerVertexCheck(g.gateway, { method, headers: c.headers, body: (async function* () { yield c.bytes; })() });
  const good = { iss: ISS, cid: A, credential: { scheme: "federation", projectId: "acme-evals", location: "us-central1", audience: FORM.audience } };

  it("answers only the probe's fixed result to a correctly signed call", async () => {
    const g = gatewayKit(() => "too_open");
    expect(await send(g, await signedCall(g, good))).toEqual({ status: 200, body: { result: "too_open" } });
    expect(g.probes.map((p) => p.cid)).toEqual([A]);
  });

  it("refuses an unsigned, mis-signed, moved, late or early call before any probe", async () => {
    const g = gatewayKit();
    const ok = await signedCall(g, good);
    const cases: Array<{ bytes: Buffer; headers: Record<string, string> }> = [
      { bytes: ok.bytes, headers: {} },
      { bytes: ok.bytes, headers: { ...ok.headers, [SERVICE_CALL_MAC_HEADER]: Buffer.alloc(32).toString("base64url") } },
      // The body changed after signing (another company): the MAC no longer matches.
      { bytes: Buffer.from(JSON.stringify({ ...good, cid: B })), headers: ok.headers },
      // Signed for another path.
      await signedCall(g, good, g.clock.at, "/v1/product/eval/hold"),
      await signedCall(g, good, g.clock.at - SERVICE_CALL_SKEW_MS - 1),
      await signedCall(g, good, g.clock.at + SERVICE_CALL_SKEW_MS + 1),
      { bytes: ok.bytes, headers: { ...ok.headers, [SERVICE_CALL_AT_HEADER]: "soon" } },
    ];
    for (const c of cases) expect((await send(g, c)).status).toBe(401);
    expect(g.probes).toHaveLength(0);
  });

  it("signs exactly [its own purpose, path, time, sha256(body)]: never a key fingerprint's purpose", () => {
    const body = Buffer.from(JSON.stringify(good));
    const expected = createHash("sha256").update(JSON.stringify(["rovara-gateway-service-call/v1", VERTEX_CHECK_PATH, 1234, createHash("sha256").update(body).digest("hex")])).digest();
    expect(Buffer.from(serviceCallMessage(VERTEX_CHECK_PATH, 1234, body)).equals(expected)).toBe(true);
    expect(PRODUCT_KEY_PURPOSE).not.toBe("rovara-gateway-service-call/v1");
  });

  it("a KMS that answers MacValid false is a refusal, never a pass", async () => {
    const g = gatewayKit();
    const no = { ...g.gateway, kms: { verifyMac: async () => false } };
    const c = await signedCall(g, good);
    expect((await answerVertexCheck(no, { method: "POST", headers: c.headers, body: (async function* () { yield c.bytes; })() })).status).toBe(401);
    expect(g.probes).toHaveLength(0);
  });

  it("a fingerprint made with the same key never signs a call (its own purpose)", async () => {
    const g = gatewayKit();
    const body = Buffer.from(JSON.stringify(good));
    // What product-seal/aws-kms fingerprints hash: [PRODUCT_KEY_PURPOSE, ...]. It can never equal a call's message.
    const fingerprintMessage = createHash("sha256").update(JSON.stringify([PRODUCT_KEY_PURPOSE, A, "web", "src_vertex", body.toString()])).digest();
    const mac = Buffer.from((await g.kms.signer.generateMac({ KeyId: MAC_KEY, Message: fingerprintMessage })).Mac!).toString("base64url");
    expect((await send(g, { bytes: body, headers: { [SERVICE_CALL_AT_HEADER]: String(g.clock.at), [SERVICE_CALL_MAC_HEADER]: mac } })).status).toBe(401);
    expect(Buffer.from(serviceCallMessage(VERTEX_CHECK_PATH, g.clock.at, body)).equals(fingerprintMessage)).toBe(false);
  });

  it("refuses a signed call with another install, a bad company, a key file or extra fields; a KMS outage is 503; GET and oversized are refused", async () => {
    const g = gatewayKit();
    for (const body of [{ ...good, iss: "https://other.example/v1/auth" }, { ...good, cid: "org_bad" }, { ...good, credential: { ...good.credential, scheme: "service_account_key" } }, { ...good, credential: { ...good.credential, extra: 1 } }, { ...good, more: 1 }]) {
      const r = await send(g, await signedCall(g, body));
      expect(r.status).toBe(400);
      expect(JSON.stringify(r.body)).not.toContain("other.example");
    }
    expect(g.probes).toHaveLength(0);
    g.kms.verifier.down = true;
    expect((await send(g, await signedCall(g, good))).status).toBe(503);
    g.kms.verifier.down = false;
    expect((await send(g, await signedCall(g, good), "GET")).status).toBe(405);
    expect((await send(g, { bytes: Buffer.alloc(5000, 32), headers: {} })).status).toBe(413);
    expect(g.probes).toHaveLength(0);
  });

  it("limits checks per serving task before any KMS call: two at once, thirty a minute; over that 429 and nothing called", async () => {
    const clock = { at: START };
    const limit = serviceCallLimiter(() => clock.at);
    const held = [limit.take(), limit.take()];
    expect(held.every((r) => r !== undefined)).toBe(true);
    expect(SERVICE_CALL_OPEN).toBe(2);
    expect(limit.take()).toBeUndefined();
    held[0]!(); held[0]!();
    const third = limit.take(); expect(third).toBeDefined(); third!(); held[1]!();
    for (let i = 3; i < SERVICE_CALL_PER_MINUTE; i++) limit.take()!();
    expect(limit.take()).toBeUndefined();
    clock.at += 60_000;
    expect(limit.take()).toBeDefined();
    // Through the mounted handler: the third concurrent check is 429 and KMS is never asked for it.
    const g = gatewayKit();
    let open = 0; let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
    const slow = { ...g.gateway, kms: { verifyMac: async (input: Parameters<MacVerifier["verifyMac"]>[0]) => { open++; await gate; return g.kms.verifier.verifyMac(input); } } };
    const handler = createVertexCheckHandler(slow);
    const fire = () => {
      const req = Object.assign(Readable.from([Buffer.from("{}")]), { method: "POST", url: VERTEX_CHECK_PATH, headers: { [SERVICE_CALL_AT_HEADER]: String(START), [SERVICE_CALL_MAC_HEADER]: Buffer.alloc(32).toString("base64url") } });
      const res = Object.assign(new EventEmitter(), { statusCode: 0, headersSent: false, destroyed: false, writeHead(status: number) { res.statusCode = status; res.headersSent = true; return res; }, end() { res.emit("close"); return res; } });
      const done = handler(req as never, res as never).then(() => res.statusCode);
      return done;
    };
    const first = fire(); const second = fire();
    expect(await fire()).toBe(429);
    release();
    expect(await first).toBe(401); expect(await second).toBe(401);
    expect(open).toBe(2);
  });

  it("Cloud's client: only a federation setup is sent; any answer but the four results is unavailable", async () => {
    const g = gatewayKit();
    expect(await g.check(A, { scheme: "service_account_key", projectId: "acme-evals", location: "us-central1", clientEmail: "x@acme-evals.iam.gserviceaccount.com", privateKeyId: "a".repeat(40), privateKey: "k" })).toBe("unavailable");
    expect(g.sent).toHaveLength(0);
    const odd = gatewayVertexCheck({ address: GATEWAY, issuer: ISS, kms: g.kms.signer, macKeyId: MAC_KEY, fetch: async () => new Response(JSON.stringify({ result: "maybe" }), { status: 200 }) });
    expect(await odd(A, { scheme: "federation", projectId: "acme-evals", location: "us-central1", audience: FORM.audience })).toBe("unavailable");
    const failing = gatewayVertexCheck({ address: GATEWAY, issuer: ISS, kms: g.kms.signer, macKeyId: MAC_KEY, fetch: async () => new Response("{}", { status: 500 }) });
    expect(await failing(A, { scheme: "federation", projectId: "acme-evals", location: "us-central1", audience: FORM.audience })).toBe("unavailable");
  });
});
