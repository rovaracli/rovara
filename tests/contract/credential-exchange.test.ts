import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { editionPolicy } from "@agentx/cloud-contracts";
import { type GitCredential } from "@rovara-code/contracts";
import { issueRepositoryGrant } from "../../packages/broker/src/aws/broker/admin-and-helpers.js";
import { NO_HOST_MESSAGE, createPluginRegistry } from "../../packages/broker/src/plugins/registry.js";
import { CREDENTIAL_REFUSED_MESSAGES, portCredentialResolver, workerWireCredential } from "../../packages/broker/src/aws/broker/credential-exchange.js";
import { RepositoryGrantService } from "../../packages/broker/src/repository-access.js";

// Enterprise foundations N-3 wiring: a credential reaches a worker only if it passes workerGitCredentialUsable.

const NOW = Date.parse("2026-10-31T12:00:00.000Z");
const URL_A = "https://github.com/acme/app.git";
const REF = "github-app";
const SCOPE = { system: "install" } as const;
const WORKSPACE = "11111111-1111-4111-8111-111111111111";
const OPERATION = "22222222-2222-4222-8222-222222222222";
const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();

function setup(issued: unknown) {
  const issueGitCredential = vi.fn(async () => issued as GitCredential);
  const forRepository = vi.fn(() => ({ issueGitCredential }));
  // The host is the one the record names (`forRecord`); `forRepository` (by address) must never be asked.
  const forRecord = vi.fn(() => ({ issueGitCredential }));
  const service = new RepositoryGrantService(Buffer.alloc(32, 7), portCredentialResolver({ codeHost: { forRepository, forRecord, forKind: forRecord, kinds: () => ["github"] } as never, credentialRef: REF, now: () => NOW }));
  const grant = service.issue({ ownerKey: "o", projectName: "payments", workspaceId: WORKSPACE, operationId: OPERATION, repositories: [{ credentialRef: REF, repositoryUrl: URL_A, access: "clone" }] });
  const exchange = (overrides: Partial<{ credentialRef: string; repositoryUrl: string; access: "clone" | "push" }> = {}) =>
    service.exchange(grant, { workspaceId: WORKSPACE, operationId: OPERATION, credentialRef: REF, repositoryUrl: URL_A, access: "clone", ...overrides }, SCOPE);
  return { exchange, issueGitCredential, forRepository, forRecord };
}

const basic = (expiresAt: string, extra: Record<string, unknown> = {}) => ({ kind: "basic", username: "x-access-token", password: "installation-token", expiresAt, ...extra });

describe("the repository credential exchange", () => {
  it("hands the worker a usable credential in the shape it takes, asking the repository's code host for exactly that repository and access", async () => {
    const { exchange, issueGitCredential, forRepository, forRecord } = setup(basic(iso(55 * 60_000)));
    expect(await exchange()).toEqual({ username: "x-access-token", password: "installation-token" });
    expect(forRecord).toHaveBeenCalledWith({});
    expect(forRepository).not.toHaveBeenCalled();
    expect(issueGitCredential).toHaveBeenCalledWith({ url: URL_A }, "clone", SCOPE);
  });

  it("maps a token credential to the token the worker takes", async () => {
    expect(await setup({ kind: "token", token: "t-1", expiresAt: iso(30 * 60_000) }).exchange()).toEqual({ token: "t-1" });
    expect(workerWireCredential({ kind: "token", token: "t-1", username: "u", expiresAt: iso(1000) })).toEqual({ token: "t-1", username: "u" });
  });

  it.each([
    ["an expired credential", basic(iso(-1000)), "expired"],
    ["one that expires right now", basic(iso(0)), "expired"],
    ["one that lasts longer than an hour", basic(iso(61 * 60_000)), "too_long_lived"],
    ["one with no expiry", { kind: "basic", username: "u", password: "p" }, "invalid"],
    ["one in a shape nobody defined", { kind: "cookie", value: "x" }, "invalid"],
    ["nothing at all", undefined, "invalid"],
    // P8: an ssh key is a kind a worker takes only when it says so (the `x-agentx-credential-kinds` header); a caller that says nothing is never sent one.
    ["an ssh key to a caller that did not say it takes one", { kind: "ssh-key", privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----\n", sshUrl: "ssh://git@git.example.invalid/srv/app.git", knownHosts: `git.example.invalid ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI${"A".repeat(43)}`, expiresAt: iso(30 * 60_000) }, "unsupported_kind"],
    ["an ssh key with no host key to trust", { kind: "ssh-key", privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----\n", sshUrl: "ssh://git@git.example.invalid/srv/app.git", expiresAt: iso(30 * 60_000) }, "invalid"],
    ["a credential helper (the worker cannot take one yet)", { kind: "helper", helper: "aws-codecommit", expiresAt: iso(30 * 60_000) }, "unsupported_kind"],
  ] as const)("refuses %s, with a fixed sentence, and the worker gets nothing", async (_name, issued, reason) => {
    const { exchange } = setup(issued);
    const failure = await exchange().then(() => undefined, (error: Error) => error);
    expect(failure?.message).toContain(CREDENTIAL_REFUSED_MESSAGES[reason]);
    // The refusal never carries the credential.
    expect(failure?.message ?? "").not.toContain("installation-token");
    expect((failure as { code?: string } | undefined)?.code).toBe("RUNTIME_UNAVAILABLE");
  });

  it("the grant still decides what may be asked: another repository, access or reference is refused before any code host is asked", async () => {
    const { exchange, forRecord } = setup(basic(iso(10 * 60_000)));
    await expect(exchange({ repositoryUrl: "https://github.com/acme/other.git" })).rejects.toThrow(/does not cover/);
    await expect(exchange({ access: "push" })).rejects.toThrow(/does not cover/);
    await expect(exchange({ credentialRef: "other-app" })).rejects.toThrow(/does not cover/);
    expect(forRecord).not.toHaveBeenCalled();
  });

  it("a repository under another credential reference than the install's gets nothing (as the GitHub App provider answers)", async () => {
    const issueGitCredential = vi.fn();
    const resolve = portCredentialResolver({ codeHost: { forRecord: () => ({ issueGitCredential }) } as never, credentialRef: REF, now: () => NOW });
    expect(await resolve("someone-elses-app", URL_A, "clone", SCOPE, undefined)).toEqual({});
    expect(issueGitCredential).not.toHaveBeenCalled();
  });

  it("broker.ts builds the grant service on this resolver (one wiring line)", () => {
    const source = readFileSync(new URL("../../packages/broker/src/aws/broker.ts", import.meta.url), "utf8");
    expect(source).toMatch(/new RepositoryGrantService\([\s\S]*?portCredentialResolver\(\{ codeHost: plugins\.codeHost/);
    expect(source).not.toMatch(/githubCredentials\.resolve\(/);
  });
});

// P5d fix round 1: the host is the one the repository's RECORD names, carried in the grant the broker signs; never the one the address suggests.
describe("the repository credential exchange routes by the record's host", () => {
  const ADDRESS = "https://github.com/acme/app.git";
  function routed() {
    const github = { issueGitCredential: vi.fn(async () => ({ kind: "basic", username: "x-access-token", password: "github-installation-token", expiresAt: iso(30 * 60_000) })) };
    const fake = { issueGitCredential: vi.fn(async () => ({ kind: "token", token: "fake-host-token", expiresAt: iso(30 * 60_000) })) };
    const registry = createPluginRegistry({
      codeHosts: [{ ...github, kind: "github", capabilities: {}, events: { mode: "none" } } as never, { ...fake, kind: "fake", capabilities: {}, events: { mode: "none" } } as never],
      checkRunners: [], policy: editionPolicy("enterprise"),
    });
    const service = new RepositoryGrantService(Buffer.alloc(32, 7), portCredentialResolver({ codeHost: registry.codeHost, credentialRef: REF, now: () => NOW }));
    const exchange = (repositories: Array<{ hostKind?: string }>, request: { repositoryUrl?: string } = {}) => {
      const grant = service.issue({ ownerKey: "o", projectName: "payments", workspaceId: WORKSPACE, operationId: OPERATION, repositories: repositories.map((repository) => ({ credentialRef: REF, repositoryUrl: ADDRESS, access: "clone" as const, ...repository })) });
      return service.exchange(grant, { workspaceId: WORKSPACE, operationId: OPERATION, credentialRef: REF, repositoryUrl: request.repositoryUrl ?? ADDRESS, access: "clone" }, SCOPE);
    };
    return { exchange, github, fake };
  }

  it("a record that names another host gets that host's credential, even at an address that looks like GitHub's, and GitHub is never asked", async () => {
    const t = routed();
    expect(await t.exchange([{ hostKind: "fake" }])).toEqual({ token: "fake-host-token" });
    expect(t.fake.issueGitCredential).toHaveBeenCalledTimes(1);
    expect(t.github.issueGitCredential).not.toHaveBeenCalled();
  });

  it("a record that names GitHub, or no host (a grant from before the record was carried), gets GitHub's", async () => {
    const t = routed();
    expect(await t.exchange([{ hostKind: "github" }])).toEqual({ username: "x-access-token", password: "github-installation-token" });
    expect(await t.exchange([{}])).toEqual({ username: "x-access-token", password: "github-installation-token" });
    expect(t.fake.issueGitCredential).not.toHaveBeenCalled();
  });

  it("a record that names a host this install has not registered is refused with the router's sentence, and no host is asked", async () => {
    const t = routed();
    await expect(t.exchange([{ hostKind: "examplehost" }])).rejects.toMatchObject({ code: "CONFIG_INVALID", message: expect.stringContaining(NO_HOST_MESSAGE) as unknown });
    await expect(t.exchange([{ hostKind: "examplehost" }])).rejects.not.toThrow(/examplehost/u);
    expect(t.github.issueGitCredential).not.toHaveBeenCalled();
    expect(t.fake.issueGitCredential).not.toHaveBeenCalled();
  });

  it("one address held by repositories on different hosts is refused, not resolved by the first", async () => {
    const t = routed();
    await expect(t.exchange([{ hostKind: "github" }, { hostKind: "fake" }])).rejects.toThrow(/does not cover/);
    expect(t.github.issueGitCredential).not.toHaveBeenCalled();
    expect(t.fake.issueGitCredential).not.toHaveBeenCalled();
  });

  it("the grants the broker issues carry the host each repository's record names", () => {
    const issued: unknown[] = [];
    const dependencies = { repositoryGrants: { issue: (input: unknown) => { issued.push(input); return "g"; } } } as never;
    const project = { definition: { name: "payments", revision: 1, repositories: [
      { name: "web", url: ADDRESS, credentialRef: REF }, { name: "api", url: "https://git.example.test/api", credentialRef: REF, host: { kind: "fake" } },
    ] } } as never;
    issueRepositoryGrant(dependencies, project, "o", WORKSPACE, OPERATION);
    expect((issued[0] as { repositories: Array<{ repositoryUrl: string; hostKind: string }> }).repositories.map((repository) => [repository.repositoryUrl, repository.hostKind])).toEqual([[ADDRESS, "github"], ["https://git.example.test/api", "fake"]]);
  });
});
