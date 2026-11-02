// N9 (INTG2): the broker's half. Tokens are built at run time. Each case names the rule it holds; the mutation notes are in .superpowers/sdd/ent-registries/report.md.
import { describe, expect, it, vi } from "vitest";
import { REGISTRY_PROBLEM_MESSAGES, REGISTRY_TOKEN_SECONDS, type ProjectRegistry } from "../../packages/contracts/src/index.js";
import { REGISTRY_UNAVAILABLE_MESSAGE, mintRegistryCredential } from "../../packages/broker/src/project-registries/mint.js";
import { REGISTRIES_OFF_MESSAGE, exchangeRegistryCredentialCore, type RegistryExchangeContext } from "../../packages/broker/src/project-registries/exchange.js";
import { REGISTRY_FEATURE_MISSING, registriesPrepareFor } from "../../packages/broker/src/project-registries/prepare.js";
import { createCodeArtifactTokenClient } from "../../packages/broker/src/project-registries/codeartifact-client.js";
import { projectRegistriesEnabled } from "../../packages/broker/src/project-registries/switch.js";
import { RepositoryGrantService } from "../../packages/broker/src/repository-access.js";

const fakeToken = (seed: string): string => `eyJ${Buffer.from(`${seed}-token-material-${seed.repeat(24)}`).toString("base64url")}.${Buffer.from(seed.repeat(30)).toString("base64url")}`;
const NOW = new Date("2026-11-02T12:00:00.000Z");
const WS = "11111111-1111-4111-8111-111111111111";
const OP = "22222222-2222-4222-8222-222222222222";
const CA: ProjectRegistry = { kind: "codeartifact", name: "internal-npm", format: "npm", domain: "acme", domainOwner: "123456789012", repository: "shared", region: "us-west-2" };
const GENERIC: ProjectRegistry = { kind: "npm", name: "corp-npm", url: "https://npm.corp.acme.dev/", credentialRef: "corp-npm-reader" };

describe("minting a token", () => {
  it("asks CodeArtifact for the named domain, owner and region with exactly the run's duration, and hands the worker `aws` and the token", async () => {
    const token = fakeToken("m");
    const codeArtifact = vi.fn(async () => ({ token, expiresAt: new Date(NOW.getTime() + REGISTRY_TOKEN_SECONDS * 1_000) }));
    const credential = await mintRegistryCredential(CA, { codeArtifact }, () => NOW);
    expect(codeArtifact).toHaveBeenCalledWith({ domain: "acme", domainOwner: "123456789012", region: "us-west-2", durationSeconds: 3600 });
    expect(credential).toEqual({ username: "aws", token, expiresAt: new Date(NOW.getTime() + 3_600_000).toISOString() });
  });

  it.each([
    ["a token that lives 12 hours (CodeArtifact's default)", () => ({ token: fakeToken("a"), expiresAt: new Date(NOW.getTime() + 12 * 3_600_000) })],
    ["a token already expired", () => ({ token: fakeToken("b"), expiresAt: new Date(NOW.getTime() - 1) })],
    ["a token too short to be scrubbed for", () => ({ token: "short", expiresAt: new Date(NOW.getTime() + 600_000) })],
    ["a token with a newline in it (a second config line)", () => ({ token: `${fakeToken("c")}\nregistry=https://evil.example/`, expiresAt: new Date(NOW.getTime() + 600_000) })],
  ])("refuses %s, with a fixed sentence that carries nothing it was given", async (_name, minted) => {
    const failure = await mintRegistryCredential(CA, { codeArtifact: async () => minted() }, () => NOW).then(() => undefined, (error: Error) => error);
    expect(failure?.message).toContain(REGISTRY_UNAVAILABLE_MESSAGE("internal-npm"));
    expect(failure?.message.length).toBeLessThan(REGISTRY_UNAVAILABLE_MESSAGE("internal-npm").length + 40);
    expect((failure as { code?: string }).code).toBe("RUNTIME_UNAVAILABLE");
  });

  it("an AWS failure is one fixed sentence; what the service said, a path or a reference never travels", async () => {
    const secretish = fakeToken("z");
    const failure = await mintRegistryCredential(CA, { codeArtifact: async () => { throw new Error(`AccessDenied for ${secretish} at /v1/authorization-token`); } }, () => NOW).then(() => undefined, (error: Error) => error);
    expect(failure?.message).toContain(REGISTRY_UNAVAILABLE_MESSAGE("internal-npm"));
    expect(failure?.message).not.toContain(secretish);
  });

  it("a generic registry without a stored-credential source is refused, never tried without a credential", async () => {
    await expect(mintRegistryCredential(GENERIC, {}, () => NOW)).rejects.toThrow(REGISTRY_UNAVAILABLE_MESSAGE("corp-npm"));
    await expect(mintRegistryCredential(CA, { stored: async () => ({ token: fakeToken("q") }) }, () => NOW)).rejects.toThrow(REGISTRY_UNAVAILABLE_MESSAGE("internal-npm"));
  });

  it("a stored credential is leased for the run's duration and resolved by its reference alone", async () => {
    const stored = vi.fn(async () => ({ token: fakeToken("g"), username: "reader" }));
    const credential = await mintRegistryCredential(GENERIC, { stored }, () => NOW);
    expect(stored).toHaveBeenCalledWith("corp-npm-reader");
    expect(credential.username).toBe("reader");
    expect(Date.parse(credential.expiresAt) - NOW.getTime()).toBe(3_600_000);
  });
});

describe("the exchange", () => {
  const service = new RepositoryGrantService(Buffer.alloc(32, 9), async () => ({}));
  const grant = service.issue({ ownerKey: "o", projectName: "payments", workspaceId: WS, operationId: OP, repositories: [] });
  const token = fakeToken("x");
  function context(overrides: Partial<RegistryExchangeContext> = {}) {
    const codeArtifact = vi.fn(async () => ({ token, expiresAt: new Date(NOW.getTime() + 3_600_000) }));
    const log = vi.fn();
    const base: RegistryExchangeContext = {
      enabled: true, edition: "enterprise", source: { codeArtifact },
      inspectGrant: (value) => service.inspect(value),
      readOperation: async () => ({ kind: "prepare", status: "RUNNING", workspace: { status: "PREPARING", activeOperationId: OP } }),
      readProject: async () => ({ registries: [CA, GENERIC], allowedDomains: ["*.d.codeartifact.us-west-2.amazonaws.com", "npm.corp.acme.dev"] }),
      now: () => NOW, log,
    };
    return { ctx: { ...base, ...overrides }, codeArtifact, log };
  }
  const ask = (ctx: RegistryExchangeContext, over: Partial<{ grant: string | undefined; workspaceId: string; operationId: string; body: unknown }> = {}) =>
    exchangeRegistryCredentialCore(ctx, { grant, workspaceId: WS, operationId: OP, body: { registry: "internal-npm" }, ...over });

  it("gives a running preparation the token of a registry its project names, and logs the registry and expiry but never the token", async () => {
    const { ctx, codeArtifact, log } = context();
    const { credential } = await ask(ctx);
    expect(credential.token).toBe(token);
    expect(codeArtifact).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ event: "registry.credential_issued", registry: "internal-npm", kind: "codeartifact" }));
    expect(JSON.stringify(log.mock.calls)).not.toContain(token);
    expect(JSON.stringify(log.mock.calls)).not.toContain("corp-npm-reader");
  });

  it.each([
    ["a task", { kind: "task", status: "RUNNING", workspace: { status: "PREPARING", activeOperationId: OP } }],
    ["a publication", { kind: "publish", status: "RUNNING", workspace: { status: "PREPARING", activeOperationId: OP } }],
    ["a preparation that has finished", { kind: "prepare", status: "SUCCEEDED", workspace: { status: "READY", activeOperationId: null } }],
    ["a preparation that is no longer the workspace's active operation", { kind: "prepare", status: "RUNNING", workspace: { status: "PREPARING", activeOperationId: "33333333-3333-4333-8333-333333333333" } }],
    ["a workspace that is ready", { kind: "prepare", status: "RUNNING", workspace: { status: "READY", activeOperationId: OP } }],
  ])("gives nothing to %s (the token exists at prepare time only), and mints nothing", async (_name, operation) => {
    const { ctx, codeArtifact } = context({ readOperation: async () => operation });
    await expect(ask(ctx)).rejects.toThrow(/running preparation only/);
    expect(codeArtifact).not.toHaveBeenCalled();
  });

  it("refuses a grant for another operation or workspace, a missing grant and a forged one, before anything is read", async () => {
    const { ctx, codeArtifact } = context();
    const other = service.issue({ ownerKey: "o", projectName: "payments", workspaceId: WS, operationId: "44444444-4444-4444-8444-444444444444", repositories: [] });
    await expect(ask(ctx, { grant: other })).rejects.toThrow(/does not cover/);
    await expect(ask(ctx, { grant: undefined })).rejects.toThrow(/grant is required/);
    await expect(ask(ctx, { grant: `${grant}x` })).rejects.toThrow(/invalid repository grant/);
    await expect(ask(ctx, { workspaceId: "55555555-5555-4555-8555-555555555555" })).rejects.toThrow(/does not cover/);
    expect(codeArtifact).not.toHaveBeenCalled();
  });

  it("decides the registry itself: a name the project did not give is refused, and the request cannot carry a domain", async () => {
    const { ctx, codeArtifact } = context();
    await expect(ask(ctx, { body: { registry: "someone-elses" } })).rejects.toThrow(/does not cover/);
    await expect(ask(ctx, { body: { registry: "internal-npm", domain: "other" } })).rejects.toThrow(/request is invalid/);
    await expect(ask(ctx, { body: "internal-npm" })).rejects.toThrow(/request is invalid/);
    expect(codeArtifact).not.toHaveBeenCalled();
  });

  it("is switched off by default: with the switch off nothing is minted", async () => {
    const { ctx, codeArtifact } = context({ enabled: false });
    await expect(ask(ctx)).rejects.toThrow(REGISTRIES_OFF_MESSAGE);
    expect(codeArtifact).not.toHaveBeenCalled();
    expect(projectRegistriesEnabled({})).toBe(false);
    expect(projectRegistriesEnabled({ PROJECT_REGISTRIES_ENABLED: "true" })).toBe(false);
    expect(projectRegistriesEnabled({ PROJECT_REGISTRIES_ENABLED: "1" })).toBe(true);
  });

  it("applies the edition and the approved websites again at exchange time", async () => {
    const pub = context({ edition: "public" });
    await expect(ask(pub.ctx, { body: { registry: "corp-npm" } })).rejects.toThrow(REGISTRY_PROBLEM_MESSAGES.edition_kind);
    const unapproved = context({ readProject: async () => ({ registries: [GENERIC], allowedDomains: [] }) });
    await expect(ask(unapproved.ctx, { body: { registry: "corp-npm" } })).rejects.toThrow(REGISTRY_PROBLEM_MESSAGES.host_not_approved);
    expect(pub.codeArtifact).not.toHaveBeenCalled();
    expect(unapproved.codeArtifact).not.toHaveBeenCalled();
  });
});

describe("the registries a prepare invocation carries", () => {
  const project = { registries: [CA], network: { allowedDomains: ["*.d.codeartifact.us-west-2.amazonaws.com"] } };
  it("carries where, never how; nothing for a project with none or a run that runs none of its code", () => {
    expect(registriesPrepareFor({ project, edition: "enterprise", enabled: true }).registries).toEqual([
      { name: "internal-npm", kind: "codeartifact", format: "npm", url: "https://acme-123456789012.d.codeartifact.us-west-2.amazonaws.com/npm/shared/" },
    ]);
    expect(registriesPrepareFor({ project: {}, edition: "enterprise", enabled: false })).toEqual({});
    expect(registriesPrepareFor({ project, edition: "enterprise", enabled: false, readOnly: true })).toEqual({});
  });
  it("refuses the START rather than run setup without the registry: switch off, edition, or host not approved", () => {
    expect(() => registriesPrepareFor({ project, edition: "enterprise", enabled: false })).toThrow(REGISTRIES_OFF_MESSAGE);
    expect(() => registriesPrepareFor({ project: { registries: [GENERIC], network: { allowedDomains: ["npm.corp.acme.dev"] } }, edition: "public", enabled: true })).toThrow(/CodeArtifact registries only/);
    expect(() => registriesPrepareFor({ project: { registries: [CA] }, edition: "enterprise", enabled: true })).toThrow(/approved websites/);
    expect(REGISTRY_FEATURE_MISSING).toContain("newer worker");
  });
});

describe("the CodeArtifact call", () => {
  const creds = { accessKeyId: "AKIDEXAMPLE0000000000", secretAccessKey: "x".repeat(40) };
  it("is one signed POST to the region's CodeArtifact host with the domain, owner and duration, and reads a strict answer", async () => {
    const token = fakeToken("k");
    const sent: Array<{ url: string; init: RequestInit }> = [];
    const client = createCodeArtifactTokenClient({ credentials: creds, fetchImplementation: async (url, init) => { sent.push({ url: typeof url === "string" ? url : url instanceof URL ? url.href : url.url, init: init ?? {} }); return new Response(JSON.stringify({ authorizationToken: token, expiration: 1_780_000_000 }), { status: 200 }); } });
    const minted = await client({ domain: "acme", domainOwner: "123456789012", region: "us-west-2", durationSeconds: 3600 });
    expect(minted.token).toBe(token);
    expect(minted.expiresAt.getTime()).toBe(1_780_000_000_000);
    expect(sent).toHaveLength(1);
    const url = new URL(sent[0]!.url);
    expect(url.origin).toBe("https://codeartifact.us-west-2.amazonaws.com");
    expect(url.pathname).toBe("/v1/authorization-token");
    expect(Object.fromEntries(url.searchParams)).toEqual({ domain: "acme", "domain-owner": "123456789012", duration: "3600" });
    expect(sent[0]!.init.method).toBe("POST");
    const headers = sent[0]!.init.headers as Record<string, string>;
    expect(headers.authorization ?? headers.Authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE0000000000\/\d{8}\/us-west-2\/codeartifact\/aws4_request/);
  });
  it("refuses a request outside the documented duration or shape before signing, and never reads an error body", async () => {
    const fetchImplementation = vi.fn(async () => new Response(`denied ${fakeToken("e")}`, { status: 403 }));
    const client = createCodeArtifactTokenClient({ credentials: creds, fetchImplementation });
    for (const durationSeconds of [0, 899, 43_201]) await expect(client({ domain: "acme", domainOwner: "123456789012", region: "us-west-2", durationSeconds })).rejects.toThrow(/invalid CodeArtifact token request/);
    await expect(client({ domain: "Acme/../x", domainOwner: "123456789012", region: "us-west-2", durationSeconds: 3600 })).rejects.toThrow(/invalid/);
    expect(fetchImplementation).not.toHaveBeenCalled();
    const failure = await client({ domain: "acme", domainOwner: "123456789012", region: "us-west-2", durationSeconds: 3600 }).then(() => undefined, (error: Error) => error);
    expect(failure?.message).toBe("CodeArtifact answered 403");
  });
});
