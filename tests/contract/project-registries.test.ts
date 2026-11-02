// N9 (INTG2): a project's private package registries, the contract half. A fake token is built at run time (never a literal that looks like a key).
import { describe, expect, it } from "vitest";
import {
  PREPARE_REGISTRIES_FEATURE,
  PrepareRegistriesSchema,
  ProjectDefinitionSchema,
  ProjectRegistriesSchema,
  REGISTRY_TOKEN_SECONDS,
  RegistryCredentialSchema,
  StoredProjectDefinitionSchema,
  WORKER_INVOCATION_FEATURES,
  WorkerInvocationSchema,
  hostMatchesDomain,
  prepareRegistriesOf,
  registryHostOf,
  registryProblems,
  registryUrlOf,
  scrubRegistrySecrets,
  workerProjectDefinition,
  type ProjectRegistry,
} from "../../packages/contracts/src/index.js";

const fakeToken = (seed = "a"): string => `eyJ${Buffer.from(`${seed}-token-material-${seed.repeat(24)}`).toString("base64url")}.${Buffer.from(seed.repeat(30)).toString("base64url")}`;
const CA: ProjectRegistry = { kind: "codeartifact", name: "internal-npm", format: "npm", domain: "acme", domainOwner: "123456789012", repository: "shared", region: "us-west-2" };
const GENERIC: ProjectRegistry = { kind: "pypi", name: "corp-pypi", url: "https://pypi.corp.acme.dev/simple/", credentialRef: "corp-pypi-reader" };
const PROJECT = { name: "payments", revision: 1, repositories: [{ name: "api", url: "https://github.com/acme/api.git", path: "repo/api", defaultBranch: "main", credentialRef: "github-app" }], setup: [], readiness: [], orchestratorInstructions: "x" };

describe("a registry entry", () => {
  it("derives CodeArtifact's address for each format, ending in a slash (npm and pip need it)", () => {
    expect(registryUrlOf(CA)).toBe("https://acme-123456789012.d.codeartifact.us-west-2.amazonaws.com/npm/shared/");
    expect(registryUrlOf({ ...CA, format: "pypi" })).toBe("https://acme-123456789012.d.codeartifact.us-west-2.amazonaws.com/pypi/shared/simple/");
    expect(registryUrlOf({ ...CA, format: "maven" })).toBe("https://acme-123456789012.d.codeartifact.us-west-2.amazonaws.com/maven/shared/");
    expect(registryHostOf(CA)).toBe("acme-123456789012.d.codeartifact.us-west-2.amazonaws.com");
    expect(registryUrlOf({ ...CA, region: "cn-north-1" })).toContain(".amazonaws.com.cn/");
  });

  it("keeps a generic address and adds the trailing slash", () => {
    expect(registryUrlOf({ kind: "npm", name: "n", url: "https://npm.corp.acme.dev/repo", credentialRef: "r" })).toBe("https://npm.corp.acme.dev/repo/");
  });

  it.each([
    ["http", { ...GENERIC, url: "http://pypi.corp.acme.dev/simple/" }],
    ["credentials in the address", { ...GENERIC, url: "https://user:pass@pypi.corp.acme.dev/simple/" }],
    ["a query", { ...GENERIC, url: "https://pypi.corp.acme.dev/simple/?token=1" }],
    ["an address as host", { ...GENERIC, url: "https://10.0.0.5/simple/" }],
    ["a single-label host", { ...GENERIC, url: "https://nexus/simple/" }],
    ["a port", { ...GENERIC, url: "https://pypi.corp.acme.dev:8443/simple/" }],
    ["an unknown field", { ...GENERIC, token: "x" }],
    ["a credential on CodeArtifact (nothing is stored for it)", { ...CA, credentialRef: "x" }],
    ["a scope on a pypi registry", { ...GENERIC, scope: "@acme" }],
    ["a bad account", { ...CA, domainOwner: "123" }],
    ["a bad region", { ...CA, region: "mars" }],
  ])("refuses %s", (_name, entry) => {
    expect(ProjectRegistriesSchema.safeParse([entry]).success).toBe(false);
  });

  it("refuses a duplicate name, and two registries of one format that would fight over one config line", () => {
    expect(ProjectRegistriesSchema.safeParse([CA, { ...CA, domain: "other" }]).success).toBe(false);
    expect(ProjectRegistriesSchema.safeParse([CA, { ...CA, name: "second" }]).success).toBe(false);
    expect(ProjectRegistriesSchema.safeParse([CA, { ...CA, name: "second", scope: "@acme" }]).success).toBe(true);
    expect(ProjectRegistriesSchema.safeParse(Array.from({ length: 9 }, (_, i) => ({ ...GENERIC, name: `r${String(i)}`, kind: "maven" }))).success).toBe(false);
  });
});

describe("the project record", () => {
  it("reads a record written before registries existed exactly as it was, and adds nothing", () => {
    const parsed = StoredProjectDefinitionSchema.parse(PROJECT);
    expect(parsed).toStrictEqual(PROJECT);
    expect(Object.hasOwn(parsed, "registries")).toBe(false);
  });

  it("holds registries at registration, and a worker is never sent them in the project (they travel as `registries`, only to a worker that lists the feature)", () => {
    const registered = ProjectDefinitionSchema.parse({ ...PROJECT, registries: [CA, GENERIC] });
    expect(registered.registries).toHaveLength(2);
    expect(Object.hasOwn(workerProjectDefinition(registered), "registries")).toBe(false);
  });
});

describe("the prepare payload", () => {
  const base = { protocolVersion: 1, operationId: "22222222-2222-4222-8222-222222222222", workspaceId: "11111111-1111-4111-8111-111111111111", fence: 1, projectRevision: 1, callbackCapability: "c".repeat(40), kind: "prepare" };
  it("carries where a registry is, never a credential, and lists its feature", () => {
    const registries = prepareRegistriesOf([CA, GENERIC]);
    expect(registries).toStrictEqual([
      { name: "internal-npm", kind: "codeartifact", format: "npm", url: "https://acme-123456789012.d.codeartifact.us-west-2.amazonaws.com/npm/shared/" },
      { name: "corp-pypi", kind: "pypi", format: "pypi", url: "https://pypi.corp.acme.dev/simple/" },
    ]);
    expect(JSON.stringify(registries)).not.toContain("corp-pypi-reader");
    expect(WorkerInvocationSchema.safeParse({ ...base, payload: { project: PROJECT, repositoryGrant: "g", registries } }).success).toBe(true);
    expect(PrepareRegistriesSchema.safeParse([{ ...registries[0], credentialRef: "x" }]).success).toBe(false);
    expect(WORKER_INVOCATION_FEATURES).toContain(PREPARE_REGISTRIES_FEATURE);
  });
});

describe("what an edition allows", () => {
  const approved = ["*.amazonaws.com"];
  it("Enterprise: CodeArtifact or a generic registry, each on an approved website", () => {
    expect(registryProblems({ edition: "enterprise", registries: [CA, GENERIC], allowedDomains: ["*.d.codeartifact.us-west-2.amazonaws.com", "pypi.corp.acme.dev"] })).toEqual([]);
    expect(registryProblems({ edition: "enterprise", registries: [GENERIC], allowedDomains: [] })).toEqual([{ code: "host_not_approved", registry: "corp-pypi" }]);
    // The cell-wide default list counts on Public only: an Enterprise firewall serves approved domains and nothing else.
    expect(registryProblems({ edition: "enterprise", registries: [CA], allowedDomains: [] })).toEqual([{ code: "host_not_approved", registry: "internal-npm" }]);
  });
  it("Public: CodeArtifact only (the default list already holds *.amazonaws.com); any other kind is refused", () => {
    expect(registryProblems({ edition: "public", registries: [CA], allowedDomains: [] })).toEqual([]);
    expect(registryProblems({ edition: "public", registries: [GENERIC], allowedDomains: ["pypi.corp.acme.dev"] })).toEqual([{ code: "edition_kind", registry: "corp-pypi" }]);
  });
  it("an install with no edition on record is held to Public's rule", () => {
    expect(registryProblems({ edition: undefined, registries: [GENERIC], allowedDomains: ["pypi.corp.acme.dev"] })).toEqual([{ code: "edition_kind", registry: "corp-pypi" }]);
  });
  it("a wildcard covers subdomains only, never the bare domain or a lookalike", () => {
    expect(hostMatchesDomain("a.b.example.com", ["*.example.com"])).toBe(true);
    expect(hostMatchesDomain("example.com", ["*.example.com"])).toBe(false);
    expect(hostMatchesDomain("evilexample.com", ["*.example.com"])).toBe(false);
    expect(hostMatchesDomain("x.example.com.evil.io", ["*.example.com"])).toBe(false);
    expect(approved).toHaveLength(1);
  });
});

describe("scrubbing", () => {
  const encodings = (token: string) => ({
    raw: token,
    percent: encodeURIComponent(token),
    twice: encodeURIComponent(encodeURIComponent(token)),
    base64: Buffer.from(token).toString("base64"),
    base64url: Buffer.from(token).toString("base64url"),
    hex: Buffer.from(token).toString("hex"),
    json: JSON.stringify({ t: token }),
  });
  it("removes a token in every spelling a tool or a transcript carries it in, and keeps the rest", () => {
    const token = fakeToken("s");
    for (const [name, spelling] of Object.entries(encodings(token))) {
      const out = scrubRegistrySecrets(`before ${spelling} after`, [token]);
      expect(out, name).toContain("before");
      expect(out, name).toContain("after");
      for (const form of Object.values(encodings(token))) expect(out, name).not.toContain(form);
    }
  });
  it("positive control: unscrubbed text does carry it", () => {
    const token = fakeToken("p");
    expect(`pip install https://aws:${encodeURIComponent(token)}@host/`).toContain(encodeURIComponent(token));
    expect(scrubRegistrySecrets(`pip install https://aws:${encodeURIComponent(token)}@host/`, [token])).not.toContain(encodeURIComponent(token));
  });
  it("ignores a value too short to be a token, so common strings are not corrupted", () => {
    expect(scrubRegistrySecrets("true 1 en-US", ["1", "true", "en-US"])).toBe("true 1 en-US");
  });
  it("redacts the longer spelling first, so none is left half-redacted", () => {
    const token = fakeToken("l");
    expect(scrubRegistrySecrets(`${encodeURIComponent(token)} ${token}`, [token])).toBe("[redacted] [redacted]");
  });
});

describe("the credential on the wire", () => {
  const ok = { username: "aws", token: fakeToken("w"), expiresAt: new Date(Date.now() + 60_000).toISOString() };
  it("takes a printable token of useful length and nothing else", () => {
    expect(RegistryCredentialSchema.safeParse(ok).success).toBe(true);
    expect(RegistryCredentialSchema.safeParse({ ...ok, token: "short" }).success).toBe(false);
    expect(RegistryCredentialSchema.safeParse({ ...ok, token: `${fakeToken("n")}\nregistry=https://evil.example/` }).success).toBe(false);
    expect(RegistryCredentialSchema.safeParse({ ...ok, extra: 1 }).success).toBe(false);
    expect(REGISTRY_TOKEN_SECONDS).toBe(3600);
  });
});
