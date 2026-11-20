// DEC 238 slice 1: connecting "your own Bedrock" from Cloud. Cloud asks the model gateway (a call signed with the product key store's
// KMS HMAC key, service-call.ts) for the company's external id and Rovara's broker role, builds the one CloudShell command, and on
// save asks the gateway to test the role for THIS company (canaries refused) before the store seals it. Company admins only (no
// step-up since owner DEC 254zzz73), audited; the agents use it only when the admin also picks it; two companies never meet.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { bedrockView, bedrockSetup, bedrockCommand } from "../../packages/ui/src/api/bedrock.js";
import { describe, expect, it } from "vitest";
import type { BedrockBackend } from "../../packages/cloud-server/src/index.js";
import { BEDROCK_NOT_ENABLED_STEPS } from "../../packages/cloud-server/src/index.js";
import { bedrockModelPresets, bedrockSetupCommand, type BedrockConnection } from "../../packages/model-gateway/src/bedrock-byo.js";
import type { BedrockProbe } from "../../packages/model-gateway/src/bedrock-byo-sessions.js";
import { ROVARA_AI_US_MODELS } from "../../packages/model-gateway/src/agent-ai.js";
import {
  answerBedrockCheck, answerBedrockSetup, BEDROCK_CHECK_PATH, BEDROCK_SETUP_PATH, gatewayBedrockCheck, gatewayBedrockSetup, SERVICE_CALL_AT_HEADER, SERVICE_CALL_MAC_HEADER, serviceCallMessage,
  type BedrockServiceOptions, type MacSigner, type MacVerifier,
} from "../../packages/model-gateway/src/service-call.js";
import { A, B, ISS, START, world, write } from "./product-ai-world.js";

const MAC_KEY = "arn:aws:kms:us-west-2:944937319445:key/00000000-0000-4000-8000-0000000000aa";
const GATEWAY = "https://gateway.example.test";
const BROKER = "arn:aws:iam::944937319445:role/RovaraBedrockBroker-staging";
const TEMPLATE = "https://docs.rovara.example/bedrock/rovara-bedrock-role.json";
const ROLE = (cid: string) => `arn:aws:iam::${cid === A ? "111111111111" : "222222222222"}:role/RovaraBedrockInvoke-${cid}`;
const SONNET = "us.anthropic.claude-sonnet-5-5";
const FORM = (cid: string, over: Record<string, unknown> = {}) => ({ roleArn: ROLE(cid), region: "us-west-2", models: { "claude-sonnet-5-5": SONNET }, allowGlobal: false, ...over });
const extOf = (cid: string) => `rvb-${createHmac("sha256", "ext").update(cid).digest("hex").slice(0, 40)}`;

function hmacKms(secret = randomBytes(32)) {
  const mac = (message: Uint8Array) => createHmac("sha256", secret).update(message).digest();
  const signer: MacSigner = { async generateMac(input) { return { Mac: new Uint8Array(mac(input.Message)) }; } };
  const verifier: MacVerifier = {
    async verifyMac(input) {
      if (input.KeyId !== MAC_KEY || input.Mac.length !== 32 || !timingSafeEqual(Buffer.from(input.Mac), mac(input.Message))) { const e = new Error("refused"); e.name = "KMSInvalidMacException"; throw e; }
      return true;
    },
  };
  return { signer, verifier };
}

/** The gateway over a fake network, and Cloud's side wired to it (as scripts/cloud-lambda.ts wires it). */
function kit(probe: (cid: string, c: BedrockConnection) => BedrockProbe = (_cid, c) => ({ result: "ok", models: Object.fromEntries(Object.values(c.models).map((id) => [id, "ready" as const])) })) {
  const kms = hmacKms();
  const clock = { at: START };
  const probes: Array<{ cid: string; roleArn: string }> = [];
  const gateway: BedrockServiceOptions = {
    issuer: ISS, kms: kms.verifier, macKeyId: MAC_KEY, now: () => clock.at, brokerRoleArn: BROKER,
    externalIds: { of: async (_iss, cid) => extOf(cid) },
    bedrock: { probe: async (cid, c) => { probes.push({ cid, roleArn: c.roleArn }); return probe(cid, c); } },
  };
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    const body = Buffer.from(init!.body as Uint8Array);
    const request = { method: init!.method!, headers: init!.headers as Record<string, string>, body: (async function* () { yield body; })() };
    const answer = url.pathname === BEDROCK_SETUP_PATH ? await answerBedrockSetup(gateway, request) : await answerBedrockCheck(gateway, request);
    return new Response(JSON.stringify(answer.body), { status: answer.status });
  }) as typeof fetch;
  const options = { address: GATEWAY, issuer: ISS, kms: kms.signer, macKeyId: MAC_KEY, fetch: fetchImpl, now: () => clock.at };
  const setup = gatewayBedrockSetup(options);
  const backend: BedrockBackend = {
    async setup(cid) { const got = await setup(cid); return got === undefined ? undefined : { ...got, templateUrl: TEMPLATE }; },
    command: (made, cid, choice) => bedrockSetupCommand({ ...made, cid, ...choice }),
    presets: (region) => bedrockModelPresets(region, ROVARA_AI_US_MODELS),
  };
  return { kms, clock, probes, gateway, backend, check: gatewayBedrockCheck(options), setup };
}
const signed = async (kms: { signer: MacSigner }, path: string, payload: unknown, at = START) => {
  const body = Buffer.from(JSON.stringify(payload));
  const mac = (await kms.signer.generateMac({ KeyId: MAC_KEY, Message: serviceCallMessage(path, at, body) })).Mac!;
  return { method: "POST", headers: { [SERVICE_CALL_AT_HEADER]: String(at), [SERVICE_CALL_MAC_HEADER]: Buffer.from(mac).toString("base64url") }, body: (async function* () { yield body; })() };
};

describe("the gateway's Bedrock service calls", () => {
  it("answers the asking company's own external id and the broker role (two companies differ)", async () => {
    const k = kit();
    expect(await k.setup(A)).toEqual({ externalId: extOf(A), brokerRoleArn: BROKER });
    expect(await k.setup(B)).toEqual({ externalId: extOf(B), brokerRoleArn: BROKER });
  });

  it("refuses an unsigned call, a call signed for the other path, another install, a stale time, or extra fields", async () => {
    const k = kit();
    const conn = { scheme: "assume_role", ...FORM(A) };
    // A MAC made for the set-up path does not open the check path (and the other way round).
    const setupMac = await signed(k.kms, BEDROCK_SETUP_PATH, { iss: ISS, cid: A, connection: conn });
    expect((await answerBedrockCheck(k.gateway, setupMac)).status).toBe(401);
    const checkMac = await signed(k.kms, BEDROCK_CHECK_PATH, { iss: ISS, cid: A });
    expect((await answerBedrockSetup(k.gateway, checkMac)).status).toBe(401);
    const other = await signed(hmacKms(), BEDROCK_SETUP_PATH, { iss: ISS, cid: A });
    expect((await answerBedrockSetup(k.gateway, other)).status).toBe(401);
    expect((await answerBedrockSetup(k.gateway, await signed(k.kms, BEDROCK_SETUP_PATH, { iss: "https://other.example/v1/auth", cid: A }))).status).toBe(400);
    expect((await answerBedrockSetup(k.gateway, await signed(k.kms, BEDROCK_SETUP_PATH, { iss: ISS, cid: A, more: 1 }))).status).toBe(400);
    expect((await answerBedrockSetup(k.gateway, await signed(k.kms, BEDROCK_SETUP_PATH, { iss: ISS, cid: A }, START - 120_000))).status).toBe(401);
    expect((await answerBedrockCheck(k.gateway, await signed(k.kms, BEDROCK_CHECK_PATH, { iss: ISS, cid: A, connection: { ...conn, roleArn: "arn:aws:iam::1:role/x" } }))).status).toBe(400);
    expect(k.probes).toEqual([]);
  });

  it("the check runs the probe for the signed company only and answers its fixed result; anything else is unavailable", async () => {
    const k = kit((cid) => cid === A ? { result: "ok", models: { [SONNET]: "not_enabled" } } : { result: "too_open" });
    const conn = (cid: string): BedrockConnection => ({ scheme: "assume_role", roleArn: ROLE(cid), region: "us-west-2", models: { "claude-sonnet-5-5": SONNET }, allowGlobal: false });
    expect(await k.check(A, conn(A))).toEqual({ result: "ok", models: { [SONNET]: "not_enabled" } });
    expect(await k.check(B, conn(B))).toEqual({ result: "too_open" });
    expect(k.probes).toEqual([{ cid: A, roleArn: ROLE(A) }, { cid: B, roleArn: ROLE(B) }]);
    const broken = kit(() => { throw new Error("boom"); });
    expect(await broken.check(A, conn(A))).toEqual({ result: "unavailable" });
  });
});

describe("Cloud: your own Bedrock settings", () => {
  const bedrockWorld = (probe?: Parameters<typeof kit>[0]) => { const k = kit(probe); return { k, w: world({ company: true, bedrock: k.backend, bedrockCheck: k.check }) }; };

  it("an admin gets the set-up (external id, broker, template, presets) and the one command, then connects; audited; agents can choose it", async () => {
    const { k, w } = bedrockWorld((_cid, c) => ({ result: "ok", models: { [Object.values(c.models)[0]!]: "not_enabled" } }));
    const ada = await w.signIn("ada", 30);
    const setup = await w.call(ada, "GET", "/org/bedrock/setup/eu-west-1");
    expect(setup.status).toBe(200);
    expect(bedrockSetup.safeParse(setup.body).success).toBe(true);
    expect(setup.body).toMatchObject({ externalId: extOf(A), brokerRoleArn: BROKER, templateUrl: TEMPLATE, companyId: A, region: "eu-west-1" });
    expect((setup.body.presets as Record<string, string>)["claude-sonnet-5-5"]).toBe("eu.anthropic.claude-sonnet-5-5");
    const command = await w.call(ada, "POST", "/org/bedrock/setup", { region: "us-west-2", models: { "claude-sonnet-5-5": SONNET }, allowGlobal: false });
    expect(command.status).toBe(200);
    expect(bedrockCommand.safeParse(command.body).success).toBe(true);
    expect(command.body.command).toContain(`ExternalId=${extOf(A)}`);
    expect(command.body.cloudShellUrl).toBe("https://us-west-2.console.aws.amazon.com/cloudshell/home?region=us-west-2");
    // Not chooseable before it is connected.
    expect((await w.call(ada, "PUT", "/org/agent-ai", { expectedVersion: 0, source: "bedrock_byo" })).status).toBe(400);
    const saved = await w.call(ada, "PUT", "/org/bedrock", write(0, FORM(A)));
    expect(saved.status).toBe(200);
    expect(bedrockView.safeParse(saved.body).success).toBe(true);
    expect(k.probes).toEqual([{ cid: A, roleArn: ROLE(A) }]);
    expect(saved.body.connection).toMatchObject({ connected: true, roleArn: ROLE(A), region: "us-west-2", models: [{ name: "claude-sonnet-5-5", id: SONNET, state: "not_enabled" }], notEnabledSteps: BEDROCK_NOT_ENABLED_STEPS });
    expect(saved.body.usage).toContain("your AWS bill is the record");
    expect((await w.call(ada, "GET", "/org/bedrock")).body.connection).toMatchObject({ roleArn: ROLE(A) });
    const agents = await w.call(ada, "GET", "/org/agent-ai");
    expect(agents.body).toMatchObject({ bedrockConnected: true });
    expect((agents.body.choices as Array<{ source: string; available: boolean }>).find((c) => c.source === "bedrock_byo")?.available).toBe(true);
    expect((await w.call(ada, "PUT", "/org/agent-ai", { expectedVersion: 0, source: "bedrock_byo" })).status).toBe(200);
    expect(await w.companies.agentAi(A)).toMatchObject({ source: "bedrock_byo" });
    const actions = (await w.audit.read(A, { max: 50 })).rows.map((r) => r.action).sort();
    expect(actions).toEqual(["agent_ai.bedrock.connected", "agent_ai.source.changed"]);
    // Changing it is a rotate (tested again), removing it leaves a recovery window.
    expect((await w.call(ada, "PUT", "/org/bedrock", write(1, FORM(A, { region: "us-east-2" })))).body.connection).toMatchObject({ region: "us-east-2" });
    expect(k.probes).toHaveLength(2);
    const removed = await w.call(ada, "DELETE", "/org/bedrock", write(2));
    expect(removed.body).toMatchObject({ connection: null });
    expect(bedrockView.safeParse(removed.body).success).toBe(true);
    expect(removed.body.removedUntil).toBeGreaterThan(START);
  });

  it("two companies: each gets its own external id; B can't connect A's role; B's view never shows A's", async () => {
    const { k, w } = bedrockWorld();
    const ada = await w.signIn("ada", 30); const bea = await w.signIn("bea", 30);
    expect((await w.call(bea, "GET", "/org/bedrock/setup/us-west-2")).body.externalId).toBe(extOf(B));
    expect((await w.call(ada, "PUT", "/org/bedrock", write(0, FORM(A)))).status).toBe(200);
    const taken = await w.call(bea, "PUT", "/org/bedrock", write(0, FORM(B, { roleArn: ROLE(A) })));
    expect(taken.status).toBe(409);
    expect(taken.body.error?.message).toBe("This AWS role is already connected to another Rovara company. Create a role for this company with the setup command.");
    expect(k.probes.map((p) => p.cid)).toEqual([A]);
    expect((await w.call(bea, "GET", "/org/bedrock")).body).toMatchObject({ connection: null });
    expect((await w.call(bea, "PUT", "/org/bedrock", write(0, FORM(B)))).status).toBe(200);
    expect((await w.call(bea, "GET", "/org/bedrock")).body.connection).toMatchObject({ roleArn: ROLE(B) });
    expect((await w.audit.read(B, { max: 50 })).rows.map((r) => r.action)).toEqual(["agent_ai.bedrock.connected"]);
  });

  it("a removal is undone by the company's admin inside its window (same role, still theirs); B can't take the role meanwhile", async () => {
    const { w } = bedrockWorld();
    const ada = await w.signIn("ada", 30); const bea = await w.signIn("bea", 30);
    expect((await w.call(ada, "PUT", "/org/bedrock", write(0, FORM(A)))).status).toBe(200);
    expect((await w.call(ada, "DELETE", "/org/bedrock", write(1))).body).toMatchObject({ connection: null });
    const again = await w.call(ada, "PUT", "/org/bedrock", write(2, FORM(A)));
    expect(again.status).toBe(409);
    expect(again.body.error?.message).toBe("This connection was removed less than 7 days ago. Recover it, or wait until the 7 days have passed.");
    expect((await w.call(bea, "PUT", "/org/bedrock", write(0, FORM(B, { roleArn: ROLE(A) })))).status).toBe(409);
    // Never B recovering A's (wrong company), never a plain member of A (wrong role); A's admin needs no step-up (owner DEC 254zzz73).
    expect((await w.call(bea, "POST", "/org/bedrock/recover", write(0))).status).toBe(404);
    expect((await w.call(await w.signIn("cal"), "POST", "/org/bedrock/recover", write(2))).status).toBe(403);
    const back = await w.call(await w.signIn("ada", 3600), "POST", "/org/bedrock/recover", write(2));
    expect(back.status).toBe(200);
    expect(back.body.connection).toMatchObject({ roleArn: ROLE(A), connected: true });
    expect((await w.audit.read(A, { max: 50 })).rows.map((r) => r.action).sort()).toEqual(["agent_ai.bedrock.connected", "agent_ai.bedrock.recovered", "agent_ai.bedrock.removed"]);
  });

  it("too open, refused and unavailable save nothing, each in its own words", async () => {
    for (const [result, status, words] of [
      ["too_open", 400, "This AWS role would also trust another Rovara company"],
      ["refused", 400, "AWS refused Rovara for this role"],
      ["unavailable", 503, "Nothing was saved"],
    ] as const) {
      const { w } = bedrockWorld(() => ({ result }));
      const ada = await w.signIn("ada", 30);
      const r = await w.call(ada, "PUT", "/org/bedrock", write(0, FORM(A)));
      expect(r.status, result).toBe(status);
      expect(r.body.error?.message).toContain(words);
      expect((await w.call(ada, "GET", "/org/bedrock")).body).toMatchObject({ connection: null });
    }
  });

  it("company admins only (reads too), with or without a step-up; bad input refused; off without the backend", async () => {
    const { w } = bedrockWorld();
    for (const who of ["pam", "cal"]) {
      const cookie = await w.signIn(who, 30);
      for (const [method, path, body] of [["GET", "/org/bedrock", undefined], ["GET", "/org/bedrock/setup/us-west-2", undefined], ["PUT", "/org/bedrock", write(0, FORM(A))]] as const) {
        expect((await w.call(cookie, method, path, body)).status, `${who} ${method} ${path}`).toBe(403);
      }
    }
    for (const who of ["pam", "cal"]) expect((await w.call(await w.signIn(who), "PUT", "/org/bedrock", write(0, FORM(A)))).status).toBe(403);
    // An admin with an old step-up (or none) gets past the role check: a bad body is the 400, never a step-up answer.
    expect((await w.call(await w.signIn("ada", 3600), "PUT", "/org/bedrock", write(0, { ...FORM(A), extra: 1 }))).status).toBe(400);
    const ada = await w.signIn("ada", 30);
    for (const body of [write(0, FORM(A, { roleArn: "arn:aws:iam::111111111111:role/Admin" })), write(0, FORM(A, { region: "us-gov-west-1" })), write(0, FORM(A, { models: { "claude-x": "meta.llama" } })), write(0, { ...FORM(A), extra: 1 }), { ...FORM(A) }]) {
      expect((await w.call(ada, "PUT", "/org/bedrock", body)).status).toBe(400);
    }
    expect((await w.call(ada, "GET", "/org/bedrock/setup/us-gov-west-1")).status).toBe(400);
    expect((await w.call(ada, "POST", "/org/bedrock/setup", { region: "us-west-2", models: { "claude-x": "us.anthropic.claude-x;rm" }, allowGlobal: false })).status).toBe(400);
    const off = world({ company: true });
    expect((await off.call(await off.signIn("ada", 30), "GET", "/org/bedrock")).status).toBe(501);
  });
});
