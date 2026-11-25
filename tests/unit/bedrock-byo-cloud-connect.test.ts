// DEC 238 slice 1: connecting "your own Bedrock" from Cloud. Cloud asks the model gateway (a call signed with the product key store's
// KMS HMAC key, service-call.ts) for the company's external id and Rovara's broker role, builds the one CloudShell command, and on
// save asks the gateway to test the role for THIS company (canaries refused) before the store seals it. Company admins only (no
// step-up since owner DEC 254zzz73), audited; the agents use it only when the admin also picks it; two companies never meet.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { bedrockView, bedrockSetup, bedrockCommand } from "../../packages/ui/src/api/bedrock.js";
import { describe, expect, it } from "vitest";
import type { BedrockBackend } from "../../packages/cloud-server/src/index.js";
import { BEDROCK_NOT_ENABLED_STEPS, BEDROCK_NO_QUOTA_STEPS } from "../../packages/cloud-server/src/index.js";
import { bedrockConnectionIds, bedrockModelPresets, bedrockSetupCommand, type BedrockConnection } from "../../packages/model-gateway/src/bedrock-byo.js";
import type { BedrockProbe } from "../../packages/model-gateway/src/bedrock-byo-sessions.js";
import { ROVARA_AI_US_MODELS } from "../../packages/model-gateway/src/agent-ai.js";
import {
  answerBedrockCheck, answerBedrockSetup, BEDROCK_CHECK_PATH, BEDROCK_SETUP_PATH, gatewayBedrockCheck, gatewayBedrockSetup, SERVICE_CALL_AT_HEADER, SERVICE_CALL_MAC_HEADER, serviceCallMessage,
  type BedrockServiceOptions, type MacSigner, type MacVerifier,
} from "../../packages/model-gateway/src/service-call.js";
import { A, B, ISS, START, world, write } from "./product-ai-world.js";

const MAC_KEY = "arn:aws:kms:us-west-2:123456789012:key/00000000-0000-4000-8000-0000000000aa";
const GATEWAY = "https://gateway.example.test";
const BROKER = "arn:aws:iam::123456789012:role/RovaraBedrockBroker-staging";
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
  const probes: Array<{ cid: string; roleArn: string; productModels?: readonly string[] }> = [];
  const gateway: BedrockServiceOptions = {
    issuer: ISS, kms: kms.verifier, macKeyId: MAC_KEY, now: () => clock.at, brokerRoleArn: BROKER,
    externalIds: { of: async (_iss, cid) => extOf(cid) },
    bedrock: { probe: async (cid, c) => { probes.push({ cid, roleArn: c.roleArn, ...(c.productModels === undefined ? {} : { productModels: c.productModels }) }); return probe(cid, c); } },
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

describe("the gateway's per-company limit on the Bedrock check", () => {
  it("one probe at a time and 6 a minute per company, so one company can't use up another's room (connect, rotate and Check again all pass here)", async () => {
    const k = kit();
    let hold: Promise<void> | undefined; const asked: string[] = [];
    const gateway: BedrockServiceOptions = { ...k.gateway, bedrock: { probe: async (cid, c) => { asked.push(cid); if (hold !== undefined) await hold; return { result: "ok", models: Object.fromEntries(Object.values(c.models).map((id) => [id, "ready" as const])) }; } } };
    const conn = (cid: string) => ({ scheme: "assume_role", ...FORM(cid) });
    const check = async (cid: string) => answerBedrockCheck(gateway, await signed(k.kms, BEDROCK_CHECK_PATH, { iss: ISS, cid, connection: conn(cid) }, k.clock.at));
    let release!: () => void; hold = new Promise<void>((resolve) => { release = resolve; });
    const first = check(A);
    await new Promise((resolve) => setTimeout(resolve, 20));
    // A is busy: a second A is refused at once (429, nothing probed); B is unaffected.
    const second = await Promise.race([check(A), new Promise<{ status: number }>((resolve) => setTimeout(() => resolve({ status: -1 }), 300))]);
    expect(second.status).toBe(429);
    const other = check(B);
    await new Promise((resolve) => setTimeout(resolve, 20));
    release();
    expect((await first).status).toBe(200);
    expect((await other).status).toBe(200);
    expect(asked).toEqual([A, B]);
    hold = undefined;
    // Six started this minute for A (one is done): five more pass, the seventh is refused; B still has all its room; a minute later A may again.
    for (let i = 0; i < 5; i += 1) expect((await check(A)).status, `A ${String(i)}`).toBe(200);
    expect((await check(A)).status).toBe(429);
    expect((await check(B)).status).toBe(200);
    k.clock.at += 61_000;
    expect((await check(A)).status).toBe(200);
    expect(asked.filter((cid) => cid === A)).toHaveLength(7);
  });

  it("Cloud's side reads a company over its limit as unavailable, nothing saved (never as a model state)", async () => {
    const k = kit();
    const conn: BedrockConnection = { scheme: "assume_role", roleArn: ROLE(A), region: "us-west-2", models: { "claude-sonnet-5-5": SONNET }, allowGlobal: false };
    const refusing = gatewayBedrockCheck({ address: GATEWAY, issuer: ISS, kms: k.kms.signer, macKeyId: MAC_KEY, now: () => k.clock.at, fetch: async () => new Response(JSON.stringify({ error: { type: "busy" } }), { status: 429 }) });
    expect(await refusing(A, conn)).toEqual({ result: "unavailable" });
  });
});

describe("Cloud: your own Bedrock settings", () => {
  const bedrockWorld = (probe?: Parameters<typeof kit>[0]) => { const k = kit(probe); return { k, w: world({ company: true, bedrock: k.backend, bedrockCheck: k.check }) }; };

  it("a model with no quota room in the company's AWS account is shown as such, with what to do (and the not-enabled steps stay for the other state)", async () => {
    const { w } = bedrockWorld((_cid, c) => ({ result: "ok", models: { [Object.values(c.models)[0]!]: "no_quota" } }));
    const ada = await w.signIn("ada", 30);
    const saved = await w.call(ada, "PUT", "/org/bedrock", write(0, FORM(A)));
    expect(saved.status).toBe(200);
    expect(bedrockView.safeParse(saved.body).success).toBe(true);
    expect(saved.body.connection).toMatchObject({ models: [{ name: "claude-sonnet-5-5", id: SONNET, state: "no_quota" }], quotaSteps: BEDROCK_NO_QUOTA_STEPS });
    expect((saved.body.connection as Record<string, unknown>).notEnabledSteps).toBeUndefined();
    expect(BEDROCK_NO_QUOTA_STEPS).toMatch(/quota/u);
    const read = await w.call(ada, "GET", "/org/bedrock");
    expect(read.body.connection).toMatchObject({ quotaSteps: BEDROCK_NO_QUOTA_STEPS });
  });

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

  it("Check again re-runs the test for the SAVED connection (company admin), shows the new time and each model's state, and says when AWS did not answer", async () => {
    let state: "ready" | "no_answer" | "not_enabled" = "no_answer";
    const { k, w } = bedrockWorld((_cid, c) => ({ result: "ok", models: { [Object.values(c.models)[0]!]: state } }));
    const ada = await w.signIn("ada", 30);
    const saved = await w.call(ada, "PUT", "/org/bedrock", write(0, FORM(A)));
    expect(saved.body.connection).toMatchObject({ checkedAt: START, models: [{ name: "claude-sonnet-5-5", id: SONNET, state: "no_answer" }] });
    // The older reader's contract still parses the new word (shown as a generic one), and the page's words are fixed.
    expect(bedrockView.safeParse(saved.body).success).toBe(true);
    w.advance(45_000); state = "ready";
    const checked = await w.call(ada, "POST", "/org/bedrock/check", write(1));
    expect(checked.status).toBe(200);
    expect(bedrockView.safeParse(checked.body).success).toBe(true);
    expect(k.probes).toEqual([{ cid: A, roleArn: ROLE(A) }, { cid: A, roleArn: ROLE(A) }]);
    expect(checked.body).toMatchObject({ revision: 2, connection: { connected: true, roleArn: ROLE(A), region: "us-west-2", checkedAt: START + 45_000, models: [{ name: "claude-sonnet-5-5", id: SONNET, state: "ready" }] } });
    expect((await w.call(ada, "GET", "/org/bedrock")).body.connection).toMatchObject({ checkedAt: START + 45_000 });
    // Audited like the other changes: who ran calls into the company's AWS account, and when.
    expect((await w.audit.read(A, { max: 50 })).rows.map((r) => r.action).sort()).toEqual(["agent_ai.bedrock.checked", "agent_ai.bedrock.connected"]);
  });

  it("the gateway is told the connection's product models: a connect and a Check again mark a ready product model ready (not unavailable)", async () => {
    const NOVA = "us.amazon.nova-pro-v1:0", TITAN = "amazon.titan-embed-text-v2:0";
    const { k, w } = bedrockWorld((_cid, c) => ({ result: "ok", models: Object.fromEntries(bedrockConnectionIds(c).map((id) => [id, id === TITAN ? "not_enabled" as const : "ready" as const])) }));
    const ada = await w.signIn("ada", 30);
    const saved = await w.call(ada, "PUT", "/org/bedrock", write(0, FORM(A, { productModels: [NOVA, TITAN] })));
    expect(saved.status).toBe(200);
    expect(k.probes).toEqual([{ cid: A, roleArn: ROLE(A), productModels: [NOVA, TITAN].sort() }]);
    const states = (body: Record<string, unknown>) => (body.connection as { models: Array<{ state: string }>; productModels: Array<{ id: string; state: string }> });
    expect(states(saved.body).models).toEqual([{ name: "claude-sonnet-5-5", id: SONNET, state: "ready" }]);
    expect(states(saved.body).productModels).toEqual([{ id: TITAN, state: "not_enabled" }, { id: NOVA, state: "ready" }]);
    w.advance(45_000);
    const checked = await w.call(ada, "POST", "/org/bedrock/check", write(1));
    expect(checked.status).toBe(200);
    expect(k.probes[1]).toEqual({ cid: A, roleArn: ROLE(A), productModels: [NOVA, TITAN].sort() });
    expect(states(checked.body).productModels).toEqual([{ id: TITAN, state: "not_enabled" }, { id: NOVA, state: "ready" }]);
    // A product model the gateway did not answer is still unavailable, never assumed ready.
  });

  it("Check again is limited to once per 30 seconds per company, without calling AWS", async () => {
    const { k, w } = bedrockWorld();
    const ada = await w.signIn("ada", 30); const bea = await w.signIn("bea", 30);
    await w.call(ada, "PUT", "/org/bedrock", write(0, FORM(A)));
    await w.call(bea, "PUT", "/org/bedrock", write(0, FORM(B)));
    w.advance(10_000);
    const early = await w.call(ada, "POST", "/org/bedrock/check", write(1));
    expect(early.status).toBe(429);
    expect(early.body.error).toEqual({ code: "RATE_LIMITED", message: "Bedrock was checked a moment ago. Wait about 30 seconds, then check again." });
    expect(k.probes).toHaveLength(2);
    w.advance(20_000);
    expect((await w.call(ada, "POST", "/org/bedrock/check", write(1))).status).toBe(200);
    expect(k.probes).toHaveLength(3);
    // Straight after, A is limited again; B's own time is its own (it was checked 30 s ago too, so it may check).
    expect((await w.call(ada, "POST", "/org/bedrock/check", write(2))).status).toBe(429);
    expect((await w.call(bea, "POST", "/org/bedrock/check", write(1))).status).toBe(200);
    expect(k.probes.map((p) => p.cid)).toEqual([A, B, A, B]);
  });

  it("a refused Check again (stale revision, no connection) does not spend the 30 seconds, and writes no audit row", async () => {
    const { k, w } = bedrockWorld();
    const ada = await w.signIn("ada", 30);
    await w.call(ada, "PUT", "/org/bedrock", write(0, FORM(A)));
    w.advance(40_000);
    // Two tabs: the second one holds an older revision and is refused before AWS is asked. The right one must still go through at once.
    expect((await w.call(ada, "POST", "/org/bedrock/check", write(0))).status).toBe(409);
    expect((await w.call(ada, "POST", "/org/bedrock/check", write(1))).status).toBe(200);
    expect(k.probes).toHaveLength(2);
    expect((await w.audit.read(A, { max: 50 })).rows.map((r) => r.action).sort()).toEqual(["agent_ai.bedrock.checked", "agent_ai.bedrock.connected"]);
  });

  it("Check again needs the same permission as connecting: a company admin only; nobody else reaches AWS", async () => {
    const { k, w } = bedrockWorld();
    const ada = await w.signIn("ada", 30);
    await w.call(ada, "PUT", "/org/bedrock", write(0, FORM(A)));
    w.advance(60_000);
    for (const who of ["pam", "cal"]) {
      for (const age of [30, undefined]) expect((await w.call(await w.signIn(who, age), "POST", "/org/bedrock/check", write(1))).status, who).toBe(403);
    }
    expect(k.probes).toHaveLength(1);
    // B's admin has no connection: not A's.
    expect((await w.call(await w.signIn("bea", 30), "POST", "/org/bedrock/check", write(0))).status).toBe(404);
    expect(k.probes).toHaveLength(1);
    // An admin with an old step-up needs none (as for connecting).
    expect((await w.call(await w.signIn("ada", 3600), "POST", "/org/bedrock/check", write(1))).status).toBe(200);
  });

  it("Check again refuses a bad body, a stale revision, no saved connection and a Cloud without Bedrock; the role found too open or refused is said in the page's words", async () => {
    let result: "ok" | "too_open" | "refused" | "unavailable" = "ok";
    const { k, w } = bedrockWorld((_cid, c) => result === "ok" ? { result, models: Object.fromEntries(Object.values(c.models).map((id) => [id, "ready" as const])) } : { result });
    const ada = await w.signIn("ada", 30);
    expect((await w.call(ada, "POST", "/org/bedrock/check", write(0))).status).toBe(404);
    await w.call(ada, "PUT", "/org/bedrock", write(0, FORM(A)));
    w.advance(60_000);
    for (const body of [{ requestId: "x", expectedRevision: 1 }, write(1, { extra: 1 }), { expectedRevision: 1 }, write(-1), {}]) expect((await w.call(ada, "POST", "/org/bedrock/check", body)).status).toBe(400);
    expect((await w.call(ada, "POST", "/org/bedrock/check", write(7))).status).toBe(409);
    expect(k.probes).toHaveLength(1);
    for (const [answer, status, words] of [["too_open", 400, "This AWS role would also trust another Rovara company"], ["refused", 400, "AWS refused Rovara for this role"], ["unavailable", 503, "Nothing was saved"]] as const) {
      result = answer; w.advance(31_000);
      const r = await w.call(ada, "POST", "/org/bedrock/check", write(1));
      expect(r.status, answer).toBe(status);
      expect(r.body.error?.message).toContain(words);
    }
    expect((await w.call(ada, "GET", "/org/bedrock")).body).toMatchObject({ revision: 1, connection: { checkedAt: START } });
    // A try that failed counts too: AWS is not asked again inside the 30 seconds, whatever the first answer was.
    w.advance(5_000);
    expect((await w.call(ada, "POST", "/org/bedrock/check", write(1))).status).toBe(429);
    const off = world({ company: true });
    expect((await off.call(await off.signIn("ada", 30), "POST", "/org/bedrock/check", write(0))).status).toBe(501);
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
