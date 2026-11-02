// Enterprise foundations P8: credential kinds on /repository-credentials, and the worker's ping feature. An ssh key goes only to a worker that said it takes one; a kind nobody takes is
// never sent; every refusal is a fixed sentence that carries nothing of the credential. The ssh clone and push run real git against a local "server" (a stand-in ssh that runs the
// remote command on this machine); no real key, token or host is used (the key is made here by ssh-keygen and thrown away).
import { execFile as execFileCallback } from "node:child_process";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  GitCredentialSchema, LEGACY_WORKER_CREDENTIAL_KINDS, WORKER_CREDENTIAL_KINDS_FEATURE, WORKER_CREDENTIAL_KINDS_HEADER, WORKER_INVOCATION_FEATURES, credentialKindNeedsWorkerFeature,
  credentialKindsOfWorkerFeatures, parseWorkerCredentialKindsHeader, workerGitCredentialUsable, type GitCredential, type WorkerInvocation,
} from "@agentx/contracts";
import { exchangeRepositoryCredential } from "../../packages/broker/src/aws/broker/admin-and-helpers.js";
import { CREDENTIAL_REFUSED_MESSAGES, portCredentialResolver, workerWireCredential } from "../../packages/broker/src/aws/broker/credential-exchange.js";
import { RepositoryGrantService, credentialKindOf, nonLegacyCredentialKindsOfGrant } from "../../packages/broker/src/repository-access.js";
import { WORKER_IMPLEMENTED_FEATURES } from "../../packages/worker/src/implemented-features.js";
import { pushCommitFromIsolatedRepository, runGitWithCredential, useSshProgramForTests } from "../../packages/worker/src/git-auth.js";
import { WORKER_TAKEN_CREDENTIAL_KINDS, createRepositoryCredentialProvider } from "../../packages/worker/src/repository-credentials.js";

const execFile = promisify(execFileCallback);
const NOW = Date.parse("2026-11-02T12:00:00.000Z");
const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();
const HTTPS = "https://git.example.invalid/acme/app.git";
const REF = "host-ref";
const SCOPE = { system: "private-install" } as const;
const WORKSPACE = "11111111-1111-4111-8111-111111111111";
const OPERATION = "22222222-2222-4222-8222-222222222222";
// A host key line in the right shape; the bytes are not any real server's key.
const KNOWN_HOSTS = `git.example.invalid ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI${"A".repeat(43)}`;

const directories: string[] = [];
const scratch = async (prefix: string): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
};
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

/** A throwaway OpenSSH key, made here and never written anywhere that outlives the test. */
async function makeKey(): Promise<string> {
  const directory = await scratch("agentx-p8-key-");
  await execFile("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "p8-test", "-f", join(directory, "k")]);
  return readFile(join(directory, "k"), "utf8");
}

const sshCredential = (privateKey: string, overrides: Record<string, unknown> = {}) => ({ kind: "ssh-key", privateKey, sshUrl: "ssh://git@git.example.invalid/srv/app.git", knownHosts: KNOWN_HOSTS, expiresAt: iso(30 * 60_000), ...overrides });

describe("the ssh-key credential (contract)", () => {
  it("needs the key, the ssh:// address, the pinned host keys and an expiry; the key must look like a private key", async () => {
    const key = await makeKey();
    expect(GitCredentialSchema.safeParse(sshCredential(key)).success).toBe(true);
    for (const bad of [
      sshCredential("k"),
      sshCredential(key, { knownHosts: undefined }),
      sshCredential(key, { knownHosts: "" }),
      sshCredential(key, { knownHosts: "git.example.invalid ssh-ed25519 short" }),
      sshCredential(key, { knownHosts: `@cert-authority * ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI${"A".repeat(43)}` }),
      sshCredential(key, { knownHosts: `command="touch x" git.example.invalid ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI${"A".repeat(43)}` }),
      sshCredential(key, { sshUrl: undefined }),
      sshCredential(key, { sshUrl: "https://git.example.invalid/x.git" }),
      sshCredential(key, { sshUrl: "ssh://-oProxyCommand=touch/x" }),
      sshCredential(key, { sshUrl: "ssh://git.example.invalid/a b" }),
      sshCredential(key, { sshUrl: "ssh://git.example.invalid/$(id)" }),
      sshCredential(key, { sshUrl: "ssh://git.example.invalid/x'y" }),
      sshCredential(key, { expiresAt: undefined }),
      sshCredential(key, { extra: "x" }),
    ]) expect(GitCredentialSchema.safeParse(bad).success, JSON.stringify(bad).slice(0, 120)).toBe(false);
  });

  it("is for a service identity only, and lives at most an hour (as every kind)", async () => {
    const key = await makeKey();
    expect(workerGitCredentialUsable(sshCredential(key), { now: NOW, actingAs: "service" }).ok).toBe(true);
    expect(workerGitCredentialUsable(sshCredential(key), { now: NOW, actingAs: "on-behalf-of" })).toEqual({ ok: false, reason: "ssh_key_needs_service_identity" });
    expect(workerGitCredentialUsable(sshCredential(key, { expiresAt: iso(61 * 60_000) }), { now: NOW, actingAs: "service" })).toEqual({ ok: false, reason: "too_long_lived" });
  });
});

describe("which kinds a worker takes", () => {
  it("a worker that says nothing, or lists no feature, takes the legacy two; the feature adds the ssh key and nothing else", () => {
    expect(credentialKindsOfWorkerFeatures([])).toEqual(["token", "basic"]);
    expect(credentialKindsOfWorkerFeatures(["task.agentRun"])).toEqual(["token", "basic"]);
    expect(credentialKindsOfWorkerFeatures([WORKER_CREDENTIAL_KINDS_FEATURE])).toEqual(["token", "basic", "ssh-key"]);
    expect(LEGACY_WORKER_CREDENTIAL_KINDS).toEqual(["token", "basic"]);
    expect(credentialKindNeedsWorkerFeature("token")).toBe(false);
    expect(credentialKindNeedsWorkerFeature("basic")).toBe(false);
    expect(credentialKindNeedsWorkerFeature("ssh-key")).toBe(true);
    expect(credentialKindNeedsWorkerFeature("helper")).toBe(true);
    expect(credentialKindNeedsWorkerFeature("anything-else")).toBe(true);
  });

  it("the request header: unknown names dropped, missing/empty/oversized means the legacy two, never more than was said", () => {
    expect(parseWorkerCredentialKindsHeader(undefined)).toEqual(["token", "basic"]);
    expect(parseWorkerCredentialKindsHeader("")).toEqual(["token", "basic"]);
    expect(parseWorkerCredentialKindsHeader("nonsense")).toEqual(["token", "basic"]);
    expect(parseWorkerCredentialKindsHeader("x".repeat(200))).toEqual(["token", "basic"]);
    expect(parseWorkerCredentialKindsHeader("token,basic,ssh-key")).toEqual(["token", "basic", "ssh-key"]);
    expect(parseWorkerCredentialKindsHeader(" ssh-key , token ")).toEqual(["token", "ssh-key"]);
    expect(parseWorkerCredentialKindsHeader("ssh-key,ssh-key,bogus")).toEqual(["ssh-key"]);
  });

  it("the worker lists the feature on /ping and takes exactly the kinds it implements (a helper is not one)", () => {
    expect(WORKER_INVOCATION_FEATURES).toContain(WORKER_CREDENTIAL_KINDS_FEATURE);
    expect(WORKER_IMPLEMENTED_FEATURES).toContain(WORKER_CREDENTIAL_KINDS_FEATURE);
    expect(WORKER_TAKEN_CREDENTIAL_KINDS).toEqual(["token", "basic", "ssh-key"]);
    expect(credentialKindsOfWorkerFeatures(WORKER_IMPLEMENTED_FEATURES)).toEqual(WORKER_TAKEN_CREDENTIAL_KINDS);
  });
});

describe("the exchange sends a kind only to a worker that takes it", () => {
  async function setup(issued: unknown, kindsOf?: (hostKind: string) => readonly string[] | undefined) {
    const issueGitCredential = vi.fn(async () => issued as GitCredential);
    const forRecord = vi.fn(() => ({ issueGitCredential }));
    const service = new RepositoryGrantService(Buffer.alloc(32, 7), portCredentialResolver({ codeHost: { forRecord } as never, credentialRef: REF, now: () => NOW }), kindsOf);
    const grant = service.issue({ ownerKey: "o", projectName: "payments", workspaceId: WORKSPACE, operationId: OPERATION, repositories: [{ credentialRef: REF, repositoryUrl: HTTPS, access: "clone", hostKind: "customer-host" }] });
    const exchange = (acceptedCredentialKinds?: readonly string[]) => service.exchange(grant, { workspaceId: WORKSPACE, operationId: OPERATION, credentialRef: REF, repositoryUrl: HTTPS, access: "clone", ...(acceptedCredentialKinds === undefined ? {} : { acceptedCredentialKinds }) }, SCOPE);
    return { exchange, service, grant, issueGitCredential };
  }
  const refusedWith = (promise: Promise<unknown>) => promise.then(() => undefined, (error: { code?: string; message?: string }) => error);

  it("an ssh key reaches a worker that says it takes one, in the wire shape {ssh:{privateKey,url,knownHosts}}", async () => {
    const key = await makeKey();
    const { exchange } = await setup(sshCredential(key));
    expect(await exchange(["token", "basic", "ssh-key"])).toEqual({ ssh: { privateKey: key, url: "ssh://git@git.example.invalid/srv/app.git", knownHosts: KNOWN_HOSTS } });
  });

  it.each([
    ["a caller that said nothing (an older worker sends no header)", undefined],
    ["a worker that takes only the legacy two", ["token", "basic"]],
    ["an empty list", []],
  ] as const)("an ssh key is refused for %s, with a fixed sentence that carries no part of the key", async (_name, accepted) => {
    const key = await makeKey();
    const { exchange } = await setup(sshCredential(key));
    const failure = await refusedWith(exchange(accepted));
    expect(failure?.code).toBe("RUNTIME_UNAVAILABLE");
    expect(failure?.message).toContain(CREDENTIAL_REFUSED_MESSAGES.unsupported_kind);
    expect(failure?.message ?? "").not.toContain("PRIVATE KEY");
    expect(failure?.message ?? "").not.toContain(key.split("\n")[1] ?? "never");
  });

  it("a token and a password still reach a worker that said nothing (the legacy two are unchanged)", async () => {
    expect(await (await setup({ kind: "token", token: "t-1", expiresAt: iso(60_000) })).exchange()).toEqual({ token: "t-1" });
    expect(await (await setup({ kind: "basic", username: "u", password: "p", expiresAt: iso(60_000) })).exchange(undefined)).toEqual({ username: "u", password: "p" });
    // A worker that lists only ssh-key does not take a token: it is refused rather than sent.
    const failure = await refusedWith((await setup({ kind: "token", token: "t-1", expiresAt: iso(60_000) })).exchange(["ssh-key"]));
    expect(failure?.message).toContain(CREDENTIAL_REFUSED_MESSAGES.unsupported_kind);
  });

  it("a credential helper has no wire shape: it is refused even for a worker that lists every kind", async () => {
    const { exchange } = await setup({ kind: "helper", helper: "aws-codecommit", expiresAt: iso(60_000) });
    const failure = await refusedWith(exchange(["token", "basic", "ssh-key", "helper"]));
    expect(failure?.message).toContain(CREDENTIAL_REFUSED_MESSAGES.unsupported_kind);
  });

  it("maps the neutral credential to the wire, and tells the kind of a wire credential", async () => {
    const key = await makeKey();
    expect(workerWireCredential(sshCredential(key) as GitCredential)).toEqual({ ssh: { privateKey: key, url: "ssh://git@git.example.invalid/srv/app.git", knownHosts: KNOWN_HOSTS } });
    expect(workerWireCredential({ kind: "helper", helper: "aws-codecommit", expiresAt: iso(1) })).toBeUndefined();
    expect(credentialKindOf({ ssh: { privateKey: "k", url: "u", knownHosts: "h" } })).toBe("ssh-key");
    expect(credentialKindOf({ username: "u", password: "p" })).toBe("basic");
    expect(credentialKindOf({ token: "t" })).toBe("token");
    expect(credentialKindOf({})).toBeUndefined();
  });

  it("the grant names a kind beyond the legacy two only when the host can hand one out; a legacy host's grant is exactly what it was", async () => {
    const legacy = await setup({}, (hostKind) => (hostKind === "customer-host" ? ["token", "basic"] : undefined));
    expect(legacy.service.inspect(legacy.grant).repositories).toEqual([{ credentialRef: REF, repositoryUrl: HTTPS, access: "clone", hostKind: "customer-host" }]);
    expect(nonLegacyCredentialKindsOfGrant(legacy.grant)).toEqual([]);

    const withSsh = await setup({}, () => ["basic", "ssh-key"]);
    expect(withSsh.service.inspect(withSsh.grant).repositories[0]).toMatchObject({ hostKind: "customer-host", credentialKinds: ["basic", "ssh-key"] });
    expect(nonLegacyCredentialKindsOfGrant(withSsh.grant)).toEqual(["ssh-key"]);

    // A host that also lists a helper (which is never sent) is not made undispatchable by it: only kinds the exchange can send are named, and a helper alone names nothing.
    const withHelper = await setup({}, () => ["basic", "ssh-key", "helper"]);
    expect(withHelper.service.inspect(withHelper.grant).repositories[0]).toMatchObject({ credentialKinds: ["basic", "ssh-key"] });
    const helperOnly = await setup({}, () => ["basic", "helper"]);
    expect(helperOnly.service.inspect(helperOnly.grant).repositories[0]).not.toHaveProperty("credentialKinds");
    expect(nonLegacyCredentialKindsOfGrant(helperOnly.grant)).toEqual([]);

    // A lookup that throws (an unknown host) leaves the grant as it was: the exchange, which verifies the grant, decides.
    const throwing = await setup({}, () => { throw new Error("unknown host"); });
    expect(nonLegacyCredentialKindsOfGrant(throwing.grant)).toEqual([]);
  });

  it("reads a grant it cannot read as naming nothing, and never throws", () => {
    for (const grant of ["", "x", "signed-grant", "a.b", `${Buffer.from("{").toString("base64url")}.sig`, `${Buffer.from(JSON.stringify({ repositories: "no" })).toString("base64url")}.s`, `${Buffer.from(JSON.stringify({ repositories: [null, { credentialKinds: "ssh-key" }, { credentialKinds: [1, "ssh-key"] }] })).toString("base64url")}.s`]) {
      expect(() => nonLegacyCredentialKindsOfGrant(grant)).not.toThrow();
    }
    expect(nonLegacyCredentialKindsOfGrant(`${Buffer.from(JSON.stringify({ repositories: [{ credentialKinds: [1, "ssh-key", "token"] }] })).toString("base64url")}.s`)).toEqual(["ssh-key"]);
  });
});

describe("broker.ts wiring (one line)", () => {
  it("builds the grant service with the host's credential kinds, so a grant names a kind that needs a worker feature", () => {
    const source = readFileSync(new URL("../../packages/broker/src/aws/broker.ts", import.meta.url), "utf8");
    expect(source).toMatch(/new RepositoryGrantService\([\s\S]*?portCredentialResolver\([\s\S]*?\(hostKind\) => plugins\.codeHost\.forKind\(hostKind\)\.capabilities\.credentialKinds,\s*\);/);
  });
});

describe("the route reads the worker's header", () => {
  async function route(issued: unknown, headers: Record<string, string>) {
    const key = await makeKey();
    const service = new RepositoryGrantService(Buffer.alloc(32, 7), portCredentialResolver({ codeHost: { forRecord: () => ({ issueGitCredential: async () => issued ?? sshCredential(key) }) } as never, credentialRef: REF, now: () => NOW }));
    const grant = service.issue({ ownerKey: "o", projectName: "payments", workspaceId: WORKSPACE, operationId: OPERATION, repositories: [{ credentialRef: REF, repositoryUrl: HTTPS, access: "clone", hostKind: "customer-host" }] });
    // Just enough of the broker for a clone exchange: the operation row is found, and the install is a private one.
    const dependencies = { cloud: false, tableName: "state", repositoryGrants: service, documentClient: { send: async () => ({ Item: { kind: "prepare", workspaceId: WORKSPACE, id: OPERATION } }) } } as never;
    const request = { method: "POST", path: "/x", requestId: randomUUID(), headers: { "x-agentx-repository-grant": grant, ...headers }, body: JSON.stringify({ credentialRef: REF, repositoryUrl: HTTPS, access: "clone" }) };
    return { key, call: () => exchangeRepositoryCredential(dependencies, request, WORKSPACE, OPERATION) };
  }

  it("sends an ssh key to a worker whose header lists ssh-key, and refuses it for a worker that sends no header or lists only the legacy two", async () => {
    const takes = await route(undefined, { [WORKER_CREDENTIAL_KINDS_HEADER]: "token,basic,ssh-key" });
    await expect(takes.call()).resolves.toMatchObject({ ssh: { privateKey: takes.key, knownHosts: KNOWN_HOSTS } });
    for (const headers of [{}, { [WORKER_CREDENTIAL_KINDS_HEADER]: "token,basic" }, { [WORKER_CREDENTIAL_KINDS_HEADER]: "bogus" }]) {
      const older = await route(undefined, headers);
      await expect(older.call()).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE", message: expect.stringContaining(CREDENTIAL_REFUSED_MESSAGES.unsupported_kind) as string });
    }
  });
});

describe("the worker side of the exchange", () => {
  function invocation(): Extract<WorkerInvocation, { kind: "prepare" }> {
    return {
      protocolVersion: 1, kind: "prepare", operationId: randomUUID(), workspaceId: randomUUID(), fence: 1, projectRevision: 1, callbackCapability: "c".repeat(64),
      payload: { project: { name: "payments", revision: 1, repositories: [{ name: "app", url: HTTPS, path: "app", defaultBranch: "main", credentialRef: REF }], setup: [], readiness: [], orchestratorInstructions: "x" }, repositoryGrant: "signed.repository-grant" },
    };
  }
  async function ask(credential: unknown) {
    const headers: Headers[] = [];
    const provider = createRepositoryCredentialProvider({
      controlPlaneUrl: "https://broker.example.invalid", invocation: invocation(),
      fetchImplementation: async (_url, init) => { headers.push(new Headers(init?.headers)); return new Response(JSON.stringify({ credential }), { status: 200 }); },
    });
    const repository = invocation().payload.project.repositories[0]!;
    return { result: provider(repository).then((value) => value, (error: Error) => error), headers };
  }

  it("says which kinds it takes in the header on every exchange", async () => {
    const { result, headers } = await ask({ token: "t" });
    await result;
    expect(headers[0]?.get(WORKER_CREDENTIAL_KINDS_HEADER)).toBe("token,basic,ssh-key");
  });

  it("reads an ssh credential and remembers which https address it stands in for; the legacy shapes are read as before", async () => {
    const key = await makeKey();
    const ssh = { privateKey: key, url: "ssh://git@git.example.invalid/srv/app.git", knownHosts: KNOWN_HOSTS };
    expect(await (await ask({ ssh })).result).toEqual({ ssh: { ...ssh, forUrl: HTTPS } });
    expect(await (await ask({ username: "u", password: "p" })).result).toEqual({ username: "u", password: "p" });
    expect(await (await ask({ token: "t" })).result).toEqual({ token: "t" });
  });

  it.each([
    ["an ssh key next to a password", (ssh: object) => ({ ssh, password: "p" })],
    ["an ssh key next to a token", (ssh: object) => ({ ssh, token: "t" })],
    ["an ssh key with a field nobody defined", (ssh: object) => ({ ssh: { ...ssh, command: "x" } })],
    ["an ssh key with no host keys", (ssh: object) => ({ ssh: { ...ssh, knownHosts: "" } })],
    ["an ssh key that is not a key", (ssh: object) => ({ ssh: { ...ssh, privateKey: "nope" } })],
    ["an ssh address that is not ssh://", (ssh: object) => ({ ssh: { ...ssh, url: "https://x.invalid/y" } })],
    ["an ssh address with a shell word in it", (ssh: object) => ({ ssh: { ...ssh, url: "ssh://h.invalid/a;b" } })],
    ["an ssh value that is not an object", () => ({ ssh: "key" })],
  ] as const)("refuses %s", async (_name, build) => {
    const key = await makeKey();
    const failure = await (await ask(build({ privateKey: key, url: "ssh://git@git.example.invalid/srv/app.git", knownHosts: KNOWN_HOSTS }))).result;
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(/repository credential/);
    expect((failure as Error).message).not.toContain("PRIVATE KEY");
  });
});

describe("git over ssh with the credential (a local server stands in for the host)", () => {
  /** A stand-in ssh: records what it was given, then runs the remote command on this machine, which is what an ssh server would do. */
  async function stubSsh(log: string): Promise<string> {
    const directory = await scratch("agentx-p8-ssh-");
    const program = join(directory, "ssh");
    await writeFile(program, [
      "#!/bin/sh",
      'key=""; known=""; strict=""; prev=""; cur=""; host=""',
      'for a in "$@"; do',
      '  case "$prev" in -i) key="$a";; esac',
      '  case "$a" in UserKnownHostsFile=*) known="${a#UserKnownHostsFile=}";; StrictHostKeyChecking=*) strict="${a#StrictHostKeyChecking=}";; esac',
      '  host="$cur"; cur="$a"; prev="$a"',
      "done",
      // After the loop `cur` is the remote command and `host` is the argument before it.
      'command="$cur"',
      `echo "key_perm=$(ls -l "$key" | cut -c1-10)" >> ${JSON.stringify(log)}`,
      `echo "key_is_a_key=$(ssh-keygen -y -f "$key" >/dev/null 2>&1 && echo yes || echo no)" >> ${JSON.stringify(log)}`,
      `echo "known_hosts=$(cat "$known")" >> ${JSON.stringify(log)}`,
      `echo "strict=$strict" >> ${JSON.stringify(log)}`,
      `echo "host=$host" >> ${JSON.stringify(log)}`,
      `echo "key_path=$key" >> ${JSON.stringify(log)}`,
      'exec sh -c "$command"',
      "",
    ].join("\n"));
    await chmod(program, 0o755);
    return program;
  }

  async function serverRepository(): Promise<{ bare: string; head: string }> {
    const root = await scratch("agentx-p8-server-");
    const work = join(root, "work");
    const bare = join(root, "app.git");
    await mkdir(work, { recursive: true });
    const git = (cwd: string, ...args: string[]) => execFile("git", ["-C", cwd, "-c", "user.email=a@example.invalid", "-c", "user.name=A", "-c", "init.defaultBranch=main", ...args]);
    await git(work, "init", "--quiet");
    await writeFile(join(work, "README.md"), "hello\n");
    await git(work, "add", ".");
    await git(work, "commit", "--quiet", "-m", "first");
    await execFile("git", ["clone", "--quiet", "--bare", work, bare]);
    const head = (await git(work, "rev-parse", "HEAD")).stdout.trim();
    return { bare, head };
  }

  beforeEach(async () => {
    const home = await scratch("agentx-p8-home-");
    vi.stubEnv("HOME", home);
    vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
    vi.stubEnv("GIT_CONFIG_GLOBAL", "/dev/null");
    // No agent of the machine running the test may take part.
    vi.stubEnv("SSH_AUTH_SOCK", "/nonexistent/agent.sock");
  });

  it("clones with the ssh key through the ssh address, keeps the registered https address as the remote, and leaves no key behind", async () => {
    const key = await makeKey();
    const { bare, head } = await serverRepository();
    const log = join(await scratch("agentx-p8-log-"), "log");
    const undo = useSshProgramForTests(await stubSsh(log));
    try {
      const destination = join(await scratch("agentx-p8-clone-"), "app");
      await runGitWithCredential({
        directory: destination, args: ["clone", "--quiet", "--no-checkout", "--", HTTPS, destination],
        credential: { ssh: { privateKey: key, url: `ssh://git@git.example.invalid${bare}`, knownHosts: KNOWN_HOSTS, forUrl: HTTPS } },
      });
      expect((await execFile("git", ["-C", destination, "rev-parse", "origin/main"])).stdout.trim()).toBe(head);
      // The clone's remote is the registered https address, so every later check that the remote matches the project still holds.
      expect((await execFile("git", ["-C", destination, "remote", "get-url", "origin"])).stdout.trim()).toBe(HTTPS);

      const seen = await readFile(log, "utf8");
      expect(seen).toContain("key_perm=-rw-------");
      expect(seen).toContain("key_is_a_key=yes");
      expect(seen).toContain(`known_hosts=${KNOWN_HOSTS}`);
      // The server's host key is checked, and an unknown or changed host is refused, never asked about.
      expect(seen).toContain("strict=yes");
      expect(seen).toContain("host=git@git.example.invalid");
      // The key's file is gone once the command ends.
      const keyPath = /key_path=(.*)/u.exec(seen)?.[1];
      expect(keyPath).toBeTruthy();
      await expect(stat(keyPath!)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      undo();
    }
  });

  it("never puts the key in a process's environment, and gives git no agent and the pinned ssh settings", async () => {
    const key = await makeKey();
    const directory = await scratch("agentx-p8-env-");
    const seenEnvironments: NodeJS.ProcessEnv[] = [];
    await runGitWithCredential({
      directory, args: ["--version"], credential: { ssh: { privateKey: key, url: "ssh://git@git.example.invalid/srv/app.git", knownHosts: KNOWN_HOSTS, forUrl: HTTPS } },
      run: async (_args, options) => { seenEnvironments.push(options.env); return { stdout: "", stderr: "" }; },
    });
    const environment = seenEnvironments[0]!;
    const body = key.split("\n")[1]!;
    for (const [name, value] of Object.entries(environment)) expect(`${name}=${value ?? ""}`, name).not.toContain(body);
    expect(environment.SSH_AUTH_SOCK).toBeUndefined();
    const command = environment.GIT_SSH_COMMAND ?? "";
    for (const option of ["-F", "/dev/null", "IdentitiesOnly=yes", "IdentityAgent=none", "BatchMode=yes", "StrictHostKeyChecking=yes", "GlobalKnownHostsFile=/dev/null", "PasswordAuthentication=no", "ForwardAgent=no", "ProxyCommand=none", "ControlMaster=no"]) expect(command, option).toContain(option);
    // The ssh address is used in place of the https one, for this command only, and ssh is allowed for it alone.
    const settings = Object.entries(environment).filter(([name]) => name.startsWith("GIT_CONFIG_KEY_")).map(([name, value]) => [value, environment[name.replace("KEY", "VALUE")]]);
    expect(settings).toContainEqual(["protocol.ssh.allow", "always"]);
    expect(settings).toContainEqual(["url.ssh://git@git.example.invalid/srv/app.git.insteadOf", HTTPS]);
    expect(Number(environment.GIT_CONFIG_COUNT)).toBe(Object.keys(environment).filter((name) => name.startsWith("GIT_CONFIG_KEY_")).length);
  });

  it("does not turn ssh on for a credential that is not an ssh key", async () => {
    const seen: NodeJS.ProcessEnv[] = [];
    await runGitWithCredential({ directory: await scratch("agentx-p8-env-"), args: ["--version"], credential: { token: "t" }, run: async (_a, o) => { seen.push(o.env); return { stdout: "", stderr: "" }; } });
    expect(seen[0]?.GIT_SSH_COMMAND).toBeUndefined();
    expect(Object.entries(seen[0]!).some(([name, value]) => name.startsWith("GIT_CONFIG_KEY_") && value === "protocol.ssh.allow")).toBe(false);
  });

  it("refuses a credential that is both an ssh key and a password, before git runs", async () => {
    const run = vi.fn();
    await expect(runGitWithCredential({
      directory: await scratch("agentx-p8-env-"), args: ["--version"], run,
      credential: { username: "u", password: "p", ssh: { privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----\nx\n-----END OPENSSH PRIVATE KEY-----", url: "ssh://h.invalid/x", knownHosts: KNOWN_HOSTS, forUrl: HTTPS } },
    })).rejects.toThrow(/ssh key or a password/);
    expect(run).not.toHaveBeenCalled();
  });

  it("pushes a commit with the ssh key to the ssh address, from the isolated repository a publication uses", async () => {
    const key = await makeKey();
    const { bare, head } = await serverRepository();
    const log = join(await scratch("agentx-p8-log-"), "log");
    const undo = useSshProgramForTests(await stubSsh(log));
    try {
      const destination = join(await scratch("agentx-p8-push-"), "app");
      const credential = { ssh: { privateKey: key, url: `ssh://git@git.example.invalid${bare}`, knownHosts: KNOWN_HOSTS, forUrl: HTTPS } };
      await runGitWithCredential({ directory: destination, args: ["clone", "--quiet", "--no-checkout", "--", HTTPS, destination], credential });
      await writeFile(join(destination, "NEW.md"), "new\n");
      const git = (...args: string[]) => execFile("git", ["-C", destination, "-c", "user.email=a@example.invalid", "-c", "user.name=A", ...args]);
      await git("checkout", "--quiet", "-b", "agentx/p8", head);
      await git("add", "NEW.md");
      await git("commit", "--quiet", "-m", "second");
      const commit = (await git("rev-parse", "HEAD")).stdout.trim();
      await pushCommitFromIsolatedRepository({ objectsDirectory: join(destination, ".git", "objects"), url: HTTPS, commit, branch: "agentx/p8", credential });
      expect((await execFile("git", ["-C", bare, "rev-parse", "refs/heads/agentx/p8"])).stdout.trim()).toBe(commit);
      expect(await readFile(log, "utf8")).toContain("key_is_a_key=yes");
    } finally {
      undo();
    }
  });
});
