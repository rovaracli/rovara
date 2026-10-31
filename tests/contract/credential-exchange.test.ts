import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { GitCredential } from "@agentx/contracts";
import { CREDENTIAL_REFUSED_MESSAGES, portCredentialResolver, workerWireCredential } from "../../packages/broker/src/aws/broker/credential-exchange.js";
import { RepositoryGrantService } from "../../packages/broker/src/repository-access.js";

// Enterprise foundations N-3 wiring: a credential reaches a worker only if it passes workerGitCredentialUsable.

const NOW = Date.parse("2026-10-31T12:00:00.000Z");
const URL_A = "https://github.com/acme/app.git";
const REF = "github-app";
const SCOPE = { system: "private-install" } as const;
const WORKSPACE = "11111111-1111-4111-8111-111111111111";
const OPERATION = "22222222-2222-4222-8222-222222222222";
const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();

function setup(issued: unknown) {
  const issueGitCredential = vi.fn(async () => issued as GitCredential);
  const forRepository = vi.fn(() => ({ issueGitCredential }));
  const service = new RepositoryGrantService(Buffer.alloc(32, 7), portCredentialResolver({ codeHost: { forRepository, forKind: forRepository, kinds: () => ["github"] } as never, credentialRef: REF, now: () => NOW }));
  const grant = service.issue({ ownerKey: "o", projectName: "payments", workspaceId: WORKSPACE, operationId: OPERATION, repositories: [{ credentialRef: REF, repositoryUrl: URL_A, access: "clone" }] });
  const exchange = (overrides: Partial<{ credentialRef: string; repositoryUrl: string; access: "clone" | "push" }> = {}) =>
    service.exchange(grant, { workspaceId: WORKSPACE, operationId: OPERATION, credentialRef: REF, repositoryUrl: URL_A, access: "clone", ...overrides }, SCOPE);
  return { exchange, issueGitCredential, forRepository };
}

const basic = (expiresAt: string, extra: Record<string, unknown> = {}) => ({ kind: "basic", username: "x-access-token", password: "installation-token", expiresAt, ...extra });

describe("the repository credential exchange", () => {
  it("hands the worker a usable credential in the shape it takes, asking the repository's code host for exactly that repository and access", async () => {
    const { exchange, issueGitCredential, forRepository } = setup(basic(iso(55 * 60_000)));
    expect(await exchange()).toEqual({ username: "x-access-token", password: "installation-token" });
    expect(forRepository).toHaveBeenCalledWith({ url: URL_A });
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
    ["an ssh key (a service identity may hold one, but this worker cannot take it yet)", { kind: "ssh-key", privateKey: "k", expiresAt: iso(30 * 60_000) }, "unsupported_kind"],
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
    const { exchange, forRepository } = setup(basic(iso(10 * 60_000)));
    await expect(exchange({ repositoryUrl: "https://github.com/acme/other.git" })).rejects.toThrow(/does not cover/);
    await expect(exchange({ access: "push" })).rejects.toThrow(/does not cover/);
    await expect(exchange({ credentialRef: "other-app" })).rejects.toThrow(/does not cover/);
    expect(forRepository).not.toHaveBeenCalled();
  });

  it("a repository under another credential reference than the install's gets nothing (as the GitHub App provider answers)", async () => {
    const issueGitCredential = vi.fn();
    const resolve = portCredentialResolver({ codeHost: { forRepository: () => ({ issueGitCredential }) } as never, credentialRef: REF, now: () => NOW });
    expect(await resolve("someone-elses-app", URL_A, "clone", SCOPE)).toEqual({});
    expect(issueGitCredential).not.toHaveBeenCalled();
  });

  it("broker.ts builds the grant service on this resolver (one wiring line)", () => {
    const source = readFileSync(new URL("../../packages/broker/src/aws/broker.ts", import.meta.url), "utf8");
    expect(source).toMatch(/new RepositoryGrantService\([\s\S]*?portCredentialResolver\(\{ codeHost: plugins\.codeHost/);
    expect(source).not.toMatch(/githubCredentials\.resolve\(/);
  });
});
