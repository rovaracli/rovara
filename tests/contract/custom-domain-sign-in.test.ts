// 0.5.7: with a custom domain the sign-in server and the broker take its address as the issuer (redirect URIs, `iss`, links, CORS and cookies follow), the API's own
// address keeps answering as itself, and tokens signed under it are accepted until they expire.
import { describe, expect, it } from "vitest";
import { developerIdentityConfigFromEnvironment } from "../../packages/broker/src/aws/developer-identity.js";
import { developerClaims } from "../../packages/broker/src/aws/developer-routes/authentication.js";
import { createDeveloperApiConfiguration } from "../../packages/broker/src/aws/workflow-dependencies-configuration.js";
import { developerIssuers } from "../../packages/broker/src/developer/custom-domain.js";
import { legacyHostRedirect } from "../../packages/broker/src/developer/legacy-host-redirect.js";
import { createDeveloperIdentityHandler, type HttpResult } from "../../packages/broker/src/developer/server.js";
import { developerTokenVerifier } from "../../packages/broker/src/developer/verify-token.js";
import { issueAccessToken } from "../../packages/broker/src/developer/tokens.js";
import { API, CLI_REDIRECT, ISSUER, T0, VERIFIER, authorizeQuery, httpEvent, identityHarness, localSigner } from "../support/developer-fakes.js";
import { createAppHandler } from "../../packages/web/src/server/handler.js";
import { TEST_ORG } from "../support/orgs.js";

const DOMAIN = "staging.rovara.dev";
const CUSTOM = `https://${DOMAIN}`;
const CUSTOM_ISSUER = `${CUSTOM}/v1/auth`;
const SUB = "d".repeat(64);
const json = (body: string) => JSON.parse(body) as Record<string, unknown>;
const onHost = (host: string | undefined, event: ReturnType<typeof httpEvent>) => (host === undefined ? event : { ...event, headers: { ...event.headers, host } });

describe("developerIssuers", () => {
  it("is the API's own issuer alone without a domain (unset or empty)", () => {
    expect(developerIssuers(ISSUER, undefined)).toEqual({ issuer: ISSUER });
    expect(developerIssuers(ISSUER, "")).toEqual({ issuer: ISSUER });
  });

  it("is the domain's issuer, with the API's own as the previous one, with a domain", () => {
    expect(developerIssuers(ISSUER, DOMAIN)).toEqual({ issuer: CUSTOM_ISSUER, previousIssuer: ISSUER });
  });

  it.each(["Staging.Rovara.dev", "staging", "staging.rovara.dev/x", "https://staging.rovara.dev", "staging.rovara.dev:443", "-a.rovara.dev", "a b.rovara.dev"])("refuses %s, so a bad value stops the function instead of building a bad address", (value) => {
    expect(() => developerIssuers(ISSUER, value)).toThrow(/DEVELOPER_CUSTOM_DOMAIN/);
  });
});

describe("the sign-in function's configuration", () => {
  const env = { AGENTX_ENV: "staging", DEVELOPER_TOKEN_ISSUER: ISSUER, DEVELOPER_SIGNIN_SLACK: "enabled" };

  it("keeps the API's own issuer, and no legacy issuer, without a domain", () => {
    const config = developerIdentityConfigFromEnvironment(env);
    expect(config.issuer).toBe(ISSUER);
    expect(config).not.toHaveProperty("legacyIssuer");
    expect(developerIdentityConfigFromEnvironment({ ...env, DEVELOPER_CUSTOM_DOMAIN: "" })).not.toHaveProperty("legacyIssuer");
  });

  it("serves the domain as the issuer and the API's own as the legacy one with a domain", () => {
    const config = developerIdentityConfigFromEnvironment({ ...env, DEVELOPER_CUSTOM_DOMAIN: DOMAIN });
    expect(config).toMatchObject({ issuer: CUSTOM_ISSUER, legacyIssuer: ISSUER });
  });
});

describe("the sign-in server on two hosts", () => {
  const dual = (h: ReturnType<typeof identityHarness>) => createDeveloperIdentityHandler({ ...h.deps, config: { ...h.deps.config, issuer: CUSTOM_ISSUER, legacyIssuer: ISSUER } });
  const http = (handler: ReturnType<typeof dual>) => async (event: ReturnType<typeof httpEvent>) => handler(event) as Promise<HttpResult>;

  it("answers the configuration as the domain on the domain's host, and as the API's own on the API's host", async () => {
    const h = identityHarness();
    const call = http(dual(h));
    const custom = json((await call(onHost(DOMAIN, httpEvent("GET", "/v1/auth/.well-known/agentx-configuration")))).body);
    expect(custom).toMatchObject({ issuer: CUSTOM_ISSUER, authorizationEndpoint: `${CUSTOM_ISSUER}/authorize`, tokenEndpoint: `${CUSTOM_ISSUER}/token`, revocationEndpoint: `${CUSTOM_ISSUER}/revoke` });
    const own = json((await call(onHost(new URL(API).host, httpEvent("GET", "/v1/auth/.well-known/agentx-configuration")))).body);
    expect(own).toMatchObject({ issuer: ISSUER, authorizationEndpoint: `${ISSUER}/authorize`, tokenEndpoint: `${ISSUER}/token` });
    const discovery = json((await call(onHost(DOMAIN, httpEvent("GET", "/v1/auth/.well-known/openid-configuration")))).body);
    expect(discovery).toMatchObject({ issuer: CUSTOM_ISSUER, jwks_uri: `${CUSTOM_ISSUER}/.well-known/jwks.json` });
  });

  it("treats a request with no host, or a host that is neither, as the domain's (the canonical server)", async () => {
    const call = http(dual(identityHarness()));
    for (const host of [undefined, "unknown.example"]) {
      expect(json((await call(onHost(host, httpEvent("GET", "/v1/auth/.well-known/agentx-configuration")))).body)).toMatchObject({ issuer: CUSTOM_ISSUER });
    }
  });

  it("matches the host without regard to case, and the header name too", async () => {
    const call = http(dual(identityHarness()));
    const event = { ...httpEvent("GET", "/v1/auth/.well-known/agentx-configuration"), headers: { Host: new URL(API).host.toUpperCase() } };
    expect(json((await call(event)).body)).toMatchObject({ issuer: ISSUER });
  });

  it("sends the provider the redirect URI of the host the sign-in started on, and signs the token as that host's issuer", async () => {
    for (const [host, issuer] of [[DOMAIN, CUSTOM_ISSUER], [new URL(API).host, ISSUER]] as const) {
      const h = identityHarness({ slackUsers: [{ userId: "U0MAYA001", name: "Maya Chen", email: "maya@example.com" }] });
      const call = http(dual(h));
      let response = await call(onHost(host, httpEvent("GET", authorizeQuery())));
      if (response.statusCode === 200) response = await call(onHost(host, httpEvent("GET", new RegExp('href="([^"]*method=slack)"').exec(response.body)![1]!.replaceAll("&amp;", "&"))));
      const providerUrl = response.headers.location!;
      expect(new URL(providerUrl).searchParams.get("redirect_uri"), host).toBe(`${issuer}/callback/slack`);
      const callback = new URL(h.slack.approve(providerUrl, "U0MAYA001"));
      const back = await call(onHost(host, httpEvent("GET", `${callback.pathname}${callback.search}`)));
      const code = new URL(back.headers.location!).searchParams.get("code")!;
      const exchanged = await call(onHost(host, httpEvent("POST", "/v1/auth/token", { grant_type: "authorization_code", client_id: "agentx-cli", code, code_verifier: VERIFIER, redirect_uri: CLI_REDIRECT })));
      const body = json(exchanged.body);
      const payload = JSON.parse(Buffer.from(String(body.access_token).split(".")[1]!, "base64url").toString("utf8")) as { iss: string };
      expect(payload.iss, host).toBe(issuer);
    }
  });
});

describe("the broker accepts both issuers while a domain is set", () => {
  const config = (extra: Record<string, string> = {}) => createDeveloperApiConfiguration({
    DEVELOPER_TOKEN_ISSUER: ISSUER, DEVELOPER_IDENTITY_FUNCTION_NAME: "identity", DEVELOPER_SIGNIN_TABLE_NAME: "sign-ins", AGENTX_ENV: "staging", DEVELOPER_SIGNIN_SLACK: "enabled", ...extra,
  }, () => ({ channelMembers: async () => ({ ok: true as const, memberOf: [] as string[] }), verifyAccessToken: async () => ({}) }))!;
  const claims = (iss: string) => ({ iss, aud: "agentx-developer", sub: SUB, amr: "slack", env: "staging", sid: "s-1", org: TEST_ORG, org_role: "member" });

  it("builds every link from the domain, and keeps the API's own as the previous issuer and a reserved one", () => {
    const withDomain = config({ DEVELOPER_CUSTOM_DOMAIN: DOMAIN });
    expect(withDomain).toMatchObject({ issuer: CUSTOM_ISSUER, previousIssuer: ISSUER });
    expect(withDomain.reservedIssuers).toEqual(expect.arrayContaining([CUSTOM_ISSUER, ISSUER]));
    const without = config();
    expect(without.issuer).toBe(ISSUER);
    expect(without).not.toHaveProperty("previousIssuer");
  });

  it("developerClaims takes either issuer with a domain, and only the API's own without one", () => {
    const withDomain = config({ DEVELOPER_CUSTOM_DOMAIN: DOMAIN });
    expect(developerClaims(claims(CUSTOM_ISSUER), withDomain)).toMatchObject({ developerId: SUB });
    expect(developerClaims(claims(ISSUER), withDomain)).toMatchObject({ developerId: SUB });
    expect(() => developerClaims(claims("https://other.example/v1/auth"), withDomain)).toThrow(/AUTH_REQUIRED/);
    const without = config();
    expect(developerClaims(claims(ISSUER), without)).toMatchObject({ developerId: SUB });
    expect(() => developerClaims(claims(CUSTOM_ISSUER), without)).toThrow(/AUTH_REQUIRED/);
  });

  it("the token check accepts a token signed under either issuer with a domain, and refuses the other without", async () => {
    const signer = localSigner();
    const jwk = await signer.publicJwk();
    const verifier = (previousIssuer?: string) => developerTokenVerifier({ issuer: CUSTOM_ISSUER, ...(previousIssuer === undefined ? {} : { previousIssuer }), keys: async () => [jwk], now: () => T0 });
    const token = async (issuer: string) => `Bearer ${(await issueAccessToken(signer, { issuer, subject: SUB, amr: "slack", env: "staging", sessionId: "s-1", now: T0, orgId: TEST_ORG, orgRole: "member" })).token}`;
    expect(await verifier(ISSUER)(await token(CUSTOM_ISSUER))).toMatchObject({ iss: CUSTOM_ISSUER });
    expect(await verifier(ISSUER)(await token(ISSUER))).toMatchObject({ iss: ISSUER });
    await expect(verifier()(await token(ISSUER))).rejects.toThrow(/AUTH_REQUIRED/);
    await expect(verifier(ISSUER)(await token("https://other.example/v1/auth"))).rejects.toThrow(/AUTH_REQUIRED/);
  });
});

describe("browser pages on the API's own address", () => {
  const own = new URL(API).host;
  it("go to the same path on the domain with a temporary redirect, GET only", () => {
    const moved = legacyHostRedirect({ issuer: CUSTOM_ISSUER, previousIssuer: ISSUER, method: "GET", headers: { host: own }, path: "/review/task-1/task?x=1" });
    expect(moved).toMatchObject({ statusCode: 307, headers: { location: `${CUSTOM}/review/task-1/task?x=1`, "cache-control": "no-store" } });
    expect(legacyHostRedirect({ issuer: CUSTOM_ISSUER, previousIssuer: ISSUER, method: "POST", headers: { host: own }, path: "/review/task-1/task" })).toBeUndefined();
  });

  it("do not move on the domain's own host, with no host, without a domain, or to anywhere but a path on the domain", () => {
    const base = { issuer: CUSTOM_ISSUER, previousIssuer: ISSUER, method: "GET", path: "/review/task-1/task" };
    expect(legacyHostRedirect({ ...base, headers: { host: DOMAIN } })).toBeUndefined();
    expect(legacyHostRedirect({ ...base, headers: {} })).toBeUndefined();
    expect(legacyHostRedirect({ issuer: ISSUER, method: "GET", headers: { host: own }, path: "/review/x" })).toBeUndefined();
    expect(legacyHostRedirect({ ...base, headers: { host: own }, path: "//evil.example/x" })).toBeUndefined();
  });

  const web = (canonicalOrigin: string) => createAppHandler({ appDirectory: "/nonexistent", assetOrigin: "", realtimeHttpHost: "", realtimeWsHost: "", canonicalOrigin });
  const get = (rawPath: string, host: string, rawQueryString = "") => ({ rawPath, rawQueryString, headers: { host }, requestContext: { http: { method: "GET" } } });

  it("the web app's pages go to the domain too, but its assets and its own host do not", async () => {
    const handler = web(CUSTOM);
    expect(await handler(get("/app/tasks", own, "a=1"))).toMatchObject({ statusCode: 307, headers: { location: `${CUSTOM}/app/tasks?a=1` } });
    expect(await handler(get("/app", own))).toMatchObject({ statusCode: 307, headers: { location: `${CUSTOM}/app` } });
    expect(await handler(get(`/s/${"0".repeat(8)}-0000-0000-0000-${"0".repeat(12)}`, own))).toMatchObject({ statusCode: 307 });
    // A page on the domain's own host is served (here the shell file is missing, so the 503 shows it was not redirected).
    expect((await handler(get("/app", DOMAIN))).statusCode).toBe(503);
    expect((await handler(get("/app/assets/x.js", own))).statusCode).not.toBe(307);
  });

  it("serve every address as before without a canonical origin", async () => {
    expect((await web("")(get("/app", own))).statusCode).toBe(503);
  });
});
