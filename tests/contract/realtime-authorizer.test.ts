// Plan 5 Task 8 (Review Focus 1): the events API's authorizer. Connecting needs a good realtime token; subscribing needs a channel of the org, the person, a project they
// have a role on, or a session they can view; publishing is never allowed; nothing is cached; no Slack call is made.
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { GetPublicKeyCommand, SignCommand } from "@aws-sdk/client-kms";
import { describe, expect, it, vi } from "vitest";
import {
  REALTIME_TOKEN_PROJECTS_MAX,
  agentSessionKey,
  projectChannel,
  projectSegment,
  sessionChannel,
  userChannel,
  type OrgId,
} from "../../packages/contracts/src/index.js";
import { authorizeRealtime, type AuthorizerDependencies, type RealtimeAuthorizerEvent } from "../../packages/broker/src/realtime/authorizer.js";
import { issueRealtimeToken, verifyRealtimeToken } from "../../packages/broker/src/realtime/token.js";
import { kmsTokenSigner, type TokenSigner } from "../../packages/broker/src/developer/tokens.js";
import { realtimeTokenThroughLambda } from "../../packages/broker/src/aws/developer-routes.js";
import { identityHarness } from "../support/developer-fakes.js";
import { ARJUN, BO, MIA, OLA, ORG_A, ORG_B, PRIYA, T0, ZED, sessionWorld } from "../support/agent-session-world.js";

const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const other = generateKeyPairSync("rsa", { modulusLength: 2048 });
const spki = publicKey.export({ format: "der", type: "spki" });
const kid = createHash("sha256").update(spki).digest("base64url").slice(0, 16);
const jwk = { ...publicKey.export({ format: "jwk" }), kid, alg: "RS256" as const, use: "sig" as const } as { kty: "RSA"; n: string; e: string; kid: string; alg: "RS256"; use: "sig" };
/** Signs as the KMS key would: RS256 over the signing input. `kmsLimit` is KMS's 4096-byte limit on a raw message. */
const signer = (key = privateKey): TokenSigner => ({
  publicJwk: async () => jwk,
  sign: async (input) => { if (input.length > 4096) throw new Error("too large for KMS"); return sign("sha256", input, key); },
});
const NOW = T0;
const tokenFor = async (orgId: OrgId, developerId: string, projects: string[] | "lookup", over: { now?: number; signWith?: TokenSigner } = {}) =>
  (await issueRealtimeToken(over.signWith ?? signer(), { orgId, developerId, projects, now: over.now ?? NOW })).token;

function world() {
  const w = sessionWorld();
  const deps: AuthorizerDependencies = { documentClient: w.db, tableName: "state", now: () => w.clock.now, publicKey: async () => jwk, log: () => undefined };
  const run = (event: RealtimeAuthorizerEvent, over: Partial<AuthorizerDependencies> = {}) => authorizeRealtime(event, { ...deps, ...over });
  const connect = (token: string | undefined) => run({ authorizationToken: token, requestContext: { operation: "EVENT_CONNECT", channel: null } });
  const subscribe = (token: string | undefined, channel: string | null | undefined) => run({ authorizationToken: token, requestContext: { operation: "EVENT_SUBSCRIBE", channel } });
  return { w, deps, run, connect, subscribe };
}
const ALLOWED = { isAuthorized: true, ttlOverride: 0 };
const REFUSED = { isAuthorized: false, ttlOverride: 0 };

describe("connecting", () => {
  it("needs a valid, unexpired realtime token, and every answer says not to cache", async () => {
    const t = world();
    const token = await tokenFor(ORG_A, PRIYA, []);
    expect(await t.connect(token)).toEqual(ALLOWED);
    expect(await t.connect(`Bearer ${token}`)).toEqual(ALLOWED);
    expect(await t.connect(undefined)).toEqual(REFUSED);
    expect(await t.connect("")).toEqual(REFUSED);
    expect(await t.connect("not a token")).toEqual(REFUSED);
    expect(await t.connect(`${token}x`)).toEqual(REFUSED);
    expect(await t.connect(token.split(".").slice(0, 2).join("."))).toEqual(REFUSED);
  });

  it("refuses an expired token (and one not yet valid), accepting one inside its fifteen minutes", async () => {
    const t = world();
    const token = await tokenFor(ORG_A, PRIYA, []);
    t.w.clock.now = NOW + 899_000;
    expect(await t.connect(token)).toEqual(ALLOWED);
    t.w.clock.now = NOW + 931_000;
    expect(await t.connect(token)).toEqual(REFUSED);
    // Backdated 30 seconds and allowed 30 more of skew: a clock a minute behind is the limit.
    t.w.clock.now = NOW - 59_000;
    expect(await t.connect(token)).toEqual(ALLOWED);
    t.w.clock.now = NOW - 61_000;
    expect(await t.connect(token)).toEqual(REFUSED);
    t.w.clock.now = NOW;
    expect(await t.connect(await tokenFor(ORG_A, PRIYA, [], { now: NOW - 3_600_000 }))).toEqual(REFUSED);
  });

  it("refuses a token signed by another key, one for another audience or issuer, one with a bad shape, and a sign-in token", async () => {
    const t = world();
    expect(await t.connect(await tokenFor(ORG_A, PRIYA, [], { signWith: signer(other.privateKey) }))).toEqual(REFUSED);
    const forge = (payload: Record<string, unknown>, header: Record<string, unknown> = { alg: "RS256", typ: "JWT", kid }) => {
      const input = `${Buffer.from(JSON.stringify(header)).toString("base64url")}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}`;
      return `${input}.${sign("sha256", Buffer.from(input), privateKey).toString("base64url")}`;
    };
    const iat = Math.floor(NOW / 1000);
    const good = { iss: "rovara-broker", aud: "rovara-realtime", sub: PRIYA, org: ORG_A, projects: [], iat, nbf: iat - 30, exp: iat + 900 };
    expect(await t.connect(forge(good))).toEqual(ALLOWED);
    expect(await t.connect(forge({ ...good, aud: "agentx-developer" }))).toEqual(REFUSED);
    expect(await t.connect(forge({ ...good, iss: "https://x.example.com" }))).toEqual(REFUSED);
    expect(await t.connect(forge({ ...good, org: "nope" }))).toEqual(REFUSED);
    expect(await t.connect(forge({ ...good, sub: "short" }))).toEqual(REFUSED);
    expect(await t.connect(forge({ ...good, projects: "everything" }))).toEqual(REFUSED);
    expect(await t.connect(forge({ ...good, projects: ["web"] }))).toEqual(REFUSED);
    expect(await t.connect(forge({ ...good, projects: [] , nbf: undefined }))).toEqual(REFUSED);
    expect(await t.connect(forge({ ...good, exp: undefined }))).toEqual(REFUSED);
    expect(await t.connect(forge(good, { alg: "RS256", typ: "JWT", kid: "someone-else" }))).toEqual(REFUSED);
    expect(await t.connect(forge(good, { alg: "RS384", typ: "JWT", kid }))).toEqual(REFUSED);
    expect(await t.connect(forge(good, { alg: "none", typ: "JWT", kid }))).toEqual(REFUSED);
    expect(await t.connect(forge(good, { alg: "RS256", typ: "JWT", kid, crit: ["x"], x: 1 }))).toEqual(REFUSED);
  });

  it("refuses, rather than fails, when the key can't be read, and logs only the error's name", async () => {
    const t = world();
    const logs: Array<Record<string, unknown>> = [];
    const token = await tokenFor(ORG_A, PRIYA, []);
    const answer = await t.run({ authorizationToken: token, requestContext: { operation: "EVENT_CONNECT", channel: null } }, { publicKey: async () => { throw Object.assign(new Error("kms said secret things"), { name: "AccessDeniedException" }); }, log: (entry) => logs.push(entry) });
    expect(answer).toEqual(REFUSED);
    expect(logs).toEqual([{ event: "realtime.refused", operation: "EVENT_CONNECT", reason: "AccessDeniedException" }]);
  });
});

describe("publishing and other operations", () => {
  it("never allows a publish, whatever the token and the channel", async () => {
    const t = world();
    const token = await tokenFor(ORG_A, PRIYA, []);
    const ours = userChannel(ORG_A, PRIYA);
    expect(await t.run({ authorizationToken: token, requestContext: { operation: "EVENT_PUBLISH", channel: ours } })).toEqual(REFUSED);
    expect(await t.run({ authorizationToken: token, requestContext: { operation: "EVENT_PUBLISH", channel: null } })).toEqual(REFUSED);
    expect(await t.run({ authorizationToken: token, requestContext: { operation: "SOMETHING_NEW", channel: ours } })).toEqual(REFUSED);
    expect(await t.run({ authorizationToken: token, requestContext: {} })).toEqual(REFUSED);
    expect(await t.run({ authorizationToken: token })).toEqual(REFUSED);
  });
});

describe("subscribing", () => {
  it("refuses a channel with a * anywhere, and every channel that is not one of ours", async () => {
    const t = world();
    const token = await tokenFor(ORG_A, PRIYA, []);
    const body = ORG_A.slice(4);
    for (const channel of [`/rovara/o-${body}/s/*`, `/rovara/o-${body}/*`, `/rovara/*`, `/rovara/o-${body}/s/s-*`, `/*`, `/rovara/o-*/u/d-${"a".repeat(40)}`, `/rovara/o-${body}/s`, `/rovara/o-${body}/s/s-${"a".repeat(20)}/extra`, `/default/foo`, "", "/", "rovara", null, undefined, `/rovara/o-${body}/x/s-${"a".repeat(20)}`]) {
      expect(await t.subscribe(token, channel), String(channel)).toEqual(REFUSED);
    }
  });

  it("allows a person their own user channel, and refuses another person's", async () => {
    const t = world();
    const priya = await tokenFor(ORG_A, PRIYA, []);
    expect(await t.subscribe(priya, userChannel(ORG_A, PRIYA))).toEqual(ALLOWED);
    expect(await t.subscribe(priya, userChannel(ORG_A, ARJUN))).toEqual(REFUSED);
    expect(await t.subscribe(await tokenFor(ORG_A, ARJUN, []), userChannel(ORG_A, PRIYA))).toEqual(REFUSED);
  });

  it("refuses a token of org B on org A's channels, and the same names in the other org", async () => {
    const t = world();
    const bo = await tokenFor(ORG_B, BO, [projectSegment(ORG_B, "web")]);
    const session = t.w.seedSession();
    expect(await t.subscribe(bo, userChannel(ORG_A, BO))).toEqual(REFUSED);
    expect(await t.subscribe(bo, projectChannel(ORG_A, "web"))).toEqual(REFUSED);
    expect(await t.subscribe(bo, sessionChannel(ORG_A, session.sessionId))).toEqual(REFUSED);
    expect(await t.subscribe(bo, userChannel(ORG_B, BO))).toEqual(ALLOWED);
    expect(await t.subscribe(bo, projectChannel(ORG_B, "web"))).toEqual(ALLOWED);
    // A project segment the token names is the segment of the org it was made in: another org's is not the same.
    expect(await t.subscribe(await tokenFor(ORG_A, ARJUN, [projectSegment(ORG_B, "web")]), projectChannel(ORG_A, "web"))).toEqual(REFUSED);
  });

  it("allows a project channel only for a segment in the token's list", async () => {
    const t = world();
    const arjun = await tokenFor(ORG_A, ARJUN, [projectSegment(ORG_A, "web")]);
    expect(await t.subscribe(arjun, projectChannel(ORG_A, "web"))).toEqual(ALLOWED);
    expect(await t.subscribe(arjun, projectChannel(ORG_A, "ops"))).toEqual(REFUSED);
    expect(await t.subscribe(await tokenFor(ORG_A, ZED, []), projectChannel(ORG_A, "web"))).toEqual(REFUSED);
    // A 63-character project ending in "-" gets a valid segment of at most 50 characters, and a token for it works.
    const long = `${"a".repeat(62)}-`;
    expect(projectChannel(ORG_A, long).split("/").every((part) => part.length <= 50)).toBe(true);
    expect(await t.subscribe(await tokenFor(ORG_A, ARJUN, [projectSegment(ORG_A, long)]), projectChannel(ORG_A, long))).toEqual(ALLOWED);
  });

  it("checks the role through the read-only path for a token that carries 'lookup' (an org admin in a large org)", async () => {
    const t = world();
    const lookup = (who: string) => tokenFor(ORG_A, who, "lookup");
    // Arjun has a grant on web, none on ops; Ola is an org admin with no grant; Zed has no role and no grant.
    expect(await t.subscribe(await lookup(ARJUN), projectChannel(ORG_A, "web"))).toEqual(ALLOWED);
    expect(await t.subscribe(await lookup(ARJUN), projectChannel(ORG_A, "ops"))).toEqual(REFUSED);
    expect(await t.subscribe(await lookup(OLA), projectChannel(ORG_A, "web"))).toEqual(ALLOWED);
    expect(await t.subscribe(await lookup(OLA), projectChannel(ORG_A, "ops"))).toEqual(ALLOWED);
    expect(await t.subscribe(await lookup(ZED), projectChannel(ORG_A, "web"))).toEqual(REFUSED);
    // A project that is not in the catalog is nobody's, an admin's included; one removed from the org's members is refused.
    expect(await t.subscribe(await lookup(OLA), projectChannel(ORG_A, "nothere"))).toEqual(REFUSED);
    const gone = "9".repeat(63) + "8";
    const logs: Array<Record<string, unknown>> = [];
    expect(await t.run({ authorizationToken: await tokenFor(ORG_A, gone, "lookup"), requestContext: { operation: "EVENT_SUBSCRIBE", channel: projectChannel(ORG_A, "web") } }, { log: (entry) => logs.push(entry) })).toEqual(REFUSED);
    // The person is read live first (member removal): someone who is not a member is refused there.
    expect(logs).toEqual([{ event: "realtime.refused", operation: "EVENT_SUBSCRIBE", reason: "member" }]);
    expect(t.w.channelCalls).toEqual([]);
  });

  it("allows a session channel to a person who can view the session now, and refuses one who can't", async () => {
    const t = world();
    const made = t.w.seedSession();
    const channel = sessionChannel(ORG_A, made.sessionId);
    const token = (who: string) => tokenFor(ORG_A, who, []);
    expect(await t.subscribe(await token(PRIYA), channel)).toEqual(ALLOWED);
    expect(await t.subscribe(await token(ARJUN), channel)).toEqual(ALLOWED);
    expect(await t.subscribe(await token(MIA), channel)).toEqual(ALLOWED);
    expect(await t.subscribe(await token(OLA), channel)).toEqual(ALLOWED);
    expect(await t.subscribe(await token(ZED), channel)).toEqual(REFUSED);
    // A session Arjun can't view (a local one of Priya's, not shared), and the same once it is shared with him.
    const local = t.w.seedSession({ kind: "local" });
    expect(await t.subscribe(await token(ARJUN), sessionChannel(ORG_A, local.sessionId))).toEqual(REFUSED);
    expect(await t.subscribe(await token(PRIYA), sessionChannel(ORG_A, local.sessionId))).toEqual(ALLOWED);
    t.w.seedShare(ORG_A, local.sessionId, { kind: "member", developerId: ARJUN }, "view");
    expect(await t.subscribe(await token(ARJUN), sessionChannel(ORG_A, local.sessionId))).toEqual(ALLOWED);
    // A session that doesn't exist, and one of another org.
    expect(await t.subscribe(await token(PRIYA), sessionChannel(ORG_A, "ses_zzzzzzzzzzzzzzzzzzzz"))).toEqual(REFUSED);
    expect(await t.subscribe(await token(PRIYA), sessionChannel(ORG_B, made.sessionId))).toEqual(REFUSED);
    // A task with a Task People denial for Arjun.
    const denied = t.w.seedSession({ people: [{ developerId: ARJUN, role: "denied" }] });
    expect(await t.subscribe(await token(ARJUN), sessionChannel(ORG_A, denied.sessionId))).toEqual(REFUSED);
    expect(t.w.channelCalls).toEqual([]);
  });

  it("reads the session's access live: a share removed after the token was made is refused on the next subscribe", async () => {
    const t = world();
    const made = t.w.seedSession({ kind: "local" });
    t.w.seedShare(ORG_A, made.sessionId, { kind: "member", developerId: ZED }, "view");
    const token = await tokenFor(ORG_A, ZED, []);
    expect(await t.subscribe(token, sessionChannel(ORG_A, made.sessionId))).toEqual(ALLOWED);
    t.w.db.delete(agentSessionKey(ORG_A, made.sessionId, `SHARE#MEMBER#${ZED}`));
    expect(await t.subscribe(token, sessionChannel(ORG_A, made.sessionId))).toEqual(REFUSED);
  });

  it("reads a chain session by the id it has, and through Plan 4's readers only when they are given", async () => {
    const t = world();
    const chain = t.w.seedSession({ kind: "chain" });
    const channel = sessionChannel(ORG_A, chain.sessionId);
    expect(channel).toContain("/s/c-");
    const arjun = await tokenFor(ORG_A, ARJUN, []);
    expect(await t.subscribe(arjun, channel)).toEqual(REFUSED);
    expect(await t.run({ authorizationToken: arjun, requestContext: { operation: "EVENT_SUBSCRIBE", channel } }, { chainReadAccess: async (caller) => caller.developerId === ARJUN })).toEqual(ALLOWED);
    expect(await t.subscribe(await tokenFor(ORG_A, PRIYA, []), channel)).toEqual(ALLOWED);
  });

  it("refuses with the session as the reason when there is no level, and with the error's name when the session can't be read", async () => {
    const t = world();
    const logs: Array<Record<string, unknown>> = [];
    const made = t.w.seedSession();
    const ask = async (who: string) => t.run({ authorizationToken: await tokenFor(ORG_A, who, []), requestContext: { operation: "EVENT_SUBSCRIBE", channel: sessionChannel(ORG_A, made.sessionId) } }, { log: (entry) => logs.push(entry) });
    expect(await ask(ZED)).toEqual(REFUSED);
    t.w.db.set({ ...t.w.db.get(agentSessionKey(ORG_A, made.sessionId, "META"))!, summary: { nonsense: true } });
    expect(await ask(PRIYA)).toEqual(REFUSED);
    expect(logs.map((entry) => entry.reason)).toEqual(["session", "AgentXError"]);
  });

  it("refuses, and logs only a reason, when the table can't be read", async () => {
    const t = world();
    const logs: Array<Record<string, unknown>> = [];
    const made = t.w.seedSession();
    const broken = { send: async () => { throw Object.assign(new Error("throttled"), { name: "ThrottlingException" }); } };
    const answer = await t.run({ authorizationToken: await tokenFor(ORG_A, PRIYA, []), requestContext: { operation: "EVENT_SUBSCRIBE", channel: sessionChannel(ORG_A, made.sessionId) } }, { documentClient: broken, log: (entry) => logs.push(entry) });
    expect(answer).toEqual(REFUSED);
    expect(logs).toEqual([{ event: "realtime.refused", operation: "EVENT_SUBSCRIBE", reason: "ThrottlingException" }]);
  });
});

describe("the token", () => {
  it("keeps its signing input inside KMS's limit with the most projects it lists, and carries the person, the org and the segments", async () => {
    const names = Array.from({ length: REALTIME_TOKEN_PROJECTS_MAX }, (_, n) => `${"p".repeat(60)}${String(n).padStart(2, "0")}-`.slice(0, 63));
    const segments = names.map((name) => projectSegment(ORG_A, name));
    let signed = 0;
    const kms = { send: async (command: unknown) => {
      if (command instanceof GetPublicKeyCommand) return { PublicKey: spki, KeyUsage: "SIGN_VERIFY" };
      if (command instanceof SignCommand) { signed = (command.input.Message as Uint8Array).length; return { Signature: sign("sha256", Buffer.from(command.input.Message as Uint8Array), privateKey) }; }
      throw new Error("unexpected");
    } };
    const real = kmsTokenSigner({ kms, keyId: "key" });
    const { token, expiresAt } = await issueRealtimeToken(real, { orgId: ORG_A, developerId: PRIYA, projects: segments, now: NOW });
    expect(signed).toBeGreaterThan(0);
    expect(signed).toBeLessThan(4096);
    expect(expiresAt).toBe(new Date(NOW + 900_000).toISOString());
    const claims = await verifyRealtimeToken(() => real.publicJwk(), token, NOW);
    expect(claims).toMatchObject({ iss: "rovara-broker", aud: "rovara-realtime", sub: PRIYA, org: ORG_A, projects: segments });
    expect(Number(claims!["exp"]) - Number(claims!["iat"])).toBe(900);
    // 'lookup' is tiny however many projects a person has.
    await issueRealtimeToken(real, { orgId: ORG_A, developerId: PRIYA, projects: "lookup", now: NOW });
    expect(signed).toBeLessThan(600);
    // A token names no title, name or email.
    expect(Buffer.from(token.split(".")[1]!, "base64url").toString()).not.toMatch(/Priya|@|title/);
    // Twenty-six segments would not be a token the authorizer accepts: the route carries "lookup" past 25.
    expect(await verifyRealtimeToken(() => real.publicJwk(), (await issueRealtimeToken(real, { orgId: ORG_A, developerId: PRIYA, projects: [...segments, projectSegment(ORG_A, "extra")], now: NOW })).token, NOW)).toBeUndefined();
  });
});

describe("the sign-in function signs it", () => {
  const request = (over: Record<string, unknown> = {}) => ({ kind: "realtime-token", orgId: ORG_A, developerId: PRIYA, projects: [projectSegment(ORG_A, "web")], ...over });

  it("answers the broker's request with a token the authorizer accepts, and refuses a request that is not the shape it asks", async () => {
    const harness = identityHarness({});
    const answer = await harness.handler(request() as never) as { ok: boolean; token: string; expiresAt: string };
    expect(answer).toMatchObject({ ok: true, expiresAt: new Date(harness.now() + 900_000).toISOString() });
    expect(await verifyRealtimeToken(() => harness.signer.publicJwk(), answer.token, harness.now())).toMatchObject({ sub: PRIYA, org: ORG_A, projects: [projectSegment(ORG_A, "web")] });
    // Neither a sign-in token for the developer API nor a token of another key.
    expect(await verifyRealtimeToken(async () => jwk, answer.token, harness.now())).toBeUndefined();
    expect(await harness.handler(request({ projects: "lookup" }) as never)).toMatchObject({ ok: true });
    for (const bad of [{ orgId: "org_x" }, { developerId: "x" }, { projects: ["web"] }, { projects: "all" }, { extra: 1 }, { projects: Array.from({ length: 26 }, () => projectSegment(ORG_A, "web")) }]) {
      expect(await harness.handler(request(bad) as never), JSON.stringify(bad)).toEqual({ ok: false, error: "invalid_request" });
    }
  });

  it("says unavailable, logging only the error's name, when the key can't sign", async () => {
    const harness = identityHarness({});
    harness.deps.signer.sign = async () => { throw Object.assign(new Error("kms: secret detail"), { name: "KMSInternalException" }); };
    expect(await harness.handler(request() as never)).toEqual({ ok: false, error: "unavailable" });
    expect(harness.logs).toContainEqual({ event: "signin.realtime_token_failed", error: "KMSInternalException" });
    expect(JSON.stringify(harness.logs)).not.toContain("secret detail");
  });

  it("is asked by the broker through the invoke helper: a good reply is the token, anything else is unavailable", async () => {
    const reply = (value: unknown) => ({ Payload: Buffer.from(JSON.stringify(value)) });
    const body = { kind: "realtime-token" as const, orgId: ORG_A, developerId: PRIYA, projects: [] as string[] };
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      expect(await realtimeTokenThroughLambda(async () => reply({ ok: true, token: "t", expiresAt: "2026-10-22T09:15:00.000Z" }))(body)).toEqual({ ok: true, token: "t", expiresAt: "2026-10-22T09:15:00.000Z" });
      expect(await realtimeTokenThroughLambda(async () => reply({ ok: false, error: "unavailable" }))(body)).toEqual({ ok: false, error: "unavailable" });
      expect(await realtimeTokenThroughLambda(async () => reply({ ok: true }))(body)).toEqual({ ok: false, error: "unavailable" });
      expect(await realtimeTokenThroughLambda(async () => reply({ ok: false, error: "invalid_request" }))(body)).toEqual({ ok: false, error: "invalid_request" });
      expect(await realtimeTokenThroughLambda(async () => ({ FunctionError: "Unhandled" }))(body)).toEqual({ ok: false, error: "unavailable" });
      expect(await realtimeTokenThroughLambda(async () => { throw new Error("boom"); })(body)).toEqual({ ok: false, error: "unavailable" });
    } finally {
      spy.mockRestore();
    }
  });
});

// Member removal (v1.1), task 3, §5 row 16: the person is read live, on connect and on every subscribe, so a removed person's old token (900 s) opens nothing.
describe("a person removed from the company", () => {
  it("cannot connect or subscribe with a token made before the removal, and a member still can", async () => {
    const t = world();
    const gone = await tokenFor(ORG_A, PRIYA, []);
    const kept = await tokenFor(ORG_A, ARJUN, []);
    expect(await t.connect(gone)).toEqual(ALLOWED);
    expect(await t.subscribe(gone, userChannel(ORG_A, PRIYA))).toEqual(ALLOWED);
    t.w.db.delete({ pk: `ORG#${ORG_A}`, sk: `MEMBER#${PRIYA}` });
    expect(await t.connect(gone)).toEqual(REFUSED);
    expect(await t.subscribe(gone, userChannel(ORG_A, PRIYA))).toEqual(REFUSED);
    expect(await t.connect(kept)).toEqual(ALLOWED);
    expect(await t.subscribe(kept, userChannel(ORG_A, ARJUN))).toEqual(ALLOWED);
  });

  it("cannot subscribe to a project channel the token lists", async () => {
    const t = world();
    const channel = projectChannel(ORG_A, "web");
    const token = await tokenFor(ORG_A, PRIYA, [projectSegment(ORG_A, "web")]);
    expect(await t.subscribe(token, channel)).toEqual(ALLOWED);
    t.w.db.delete({ pk: `ORG#${ORG_A}`, sk: `MEMBER#${PRIYA}` });
    expect(await t.subscribe(token, channel)).toEqual(REFUSED);
  });
});
