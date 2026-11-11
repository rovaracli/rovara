// Plan 3 Task 14b (PF10, PF16): the tokens an agent's GitHub work is done with, and the reads made with them. Everything runs against a fake GitHub that
// records every request, so "no token was minted" and "exactly these permissions" are read off the record rather than assumed.
import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { agentXError, type OrgId } from "@rovara-code/contracts";
import { GitHubAppCredentialProvider } from "../../packages/broker/src/github-app.js";
import { TEST_ORG } from "../support/orgs.js";

const ORG_B = "org_bbbbbbbbbbbbbbbbbbbb" as OrgId;
const REPOSITORY = "https://github.com/example/demo.git";
const HEAD = "a".repeat(40);
const COMMIT = "c".repeat(40);

let privateKey = "";
beforeAll(() => {
  privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
});

interface Recorded { method: string; path: string; search: string; body?: unknown; authorization: string }

/** A fake GitHub: the installation of example/demo is 55, tokens are named for the permissions they carry, and each route answers from `answers`. */
function fakeGithub(answers: { handler?: (request: Recorded) => Response | undefined } = {}) {
  const requests: Recorded[] = [];
  const fetchImplementation = (async (url: string | URL | Request, init?: RequestInit) => {
    const parsed = new URL(typeof url === "string" ? url : url instanceof URL ? url.href : url.url);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const request: Recorded = {
      method: init?.method ?? "GET", path: parsed.pathname, search: parsed.search, authorization: headers["authorization"] ?? "",
      ...(typeof init?.body === "string" ? { body: JSON.parse(init.body) as unknown } : {}),
    };
    requests.push(request);
    const custom = answers.handler?.(request);
    if (custom !== undefined) return custom;
    if (/^\/repos\/[^/]+\/[^/]+\/installation$/.test(parsed.pathname)) return Response.json({ id: 55, account: { login: "example" } });
    if (request.method === "POST" && parsed.pathname === "/app/installations/55/access_tokens") {
      return Response.json({ token: `token-${JSON.stringify((request.body as { permissions: unknown }).permissions)}` }, { status: 201 });
    }
    return Response.json({ message: "unexpected" }, { status: 500 });
  }) as typeof fetch;
  const minted = () => requests.filter((request) => request.path.endsWith("/access_tokens"));
  return { fetchImplementation, requests, minted };
}

function providerOf(github: ReturnType<typeof fakeGithub>, requireInstallationBound?: ConstructorParameters<typeof GitHubAppCredentialProvider>[0]["requireInstallationBound"]) {
  return new GitHubAppCredentialProvider({
    credentialRef: "github-app", appId: "123", getPrivateKey: async () => privateKey, fetchImplementation: github.fetchImplementation,
    ...(requireInstallationBound === undefined ? {} : { requireInstallationBound }),
  });
}

const refusal = async (action: Promise<unknown>) => {
  const caught = await action.then(() => undefined, (thrown: unknown) => thrown as { code: string; message: string });
  if (caught === undefined) throw new Error("expected a refusal");
  return { code: caught.code, message: caught.message.replace(/^[A-Z_]+: /, "") };
};

describe("createAgentInstallationToken", () => {
  it("mints a token for one repository with exactly the permissions asked plus metadata read", async () => {
    const github = fakeGithub();
    const provider = providerOf(github);
    for (const permissions of [{ issues: "write" }, { pull_requests: "read", contents: "read" }, { pull_requests: "write" }, { contents: "read" }, { issues: "read" }] as const) {
      await provider.createAgentInstallationToken(REPOSITORY, permissions, { orgId: TEST_ORG });
    }
    expect(github.minted().map((request) => request.body)).toEqual([
      { repositories: ["demo"], permissions: { issues: "write", metadata: "read" } },
      { repositories: ["demo"], permissions: { pull_requests: "read", contents: "read", metadata: "read" } },
      { repositories: ["demo"], permissions: { pull_requests: "write", metadata: "read" } },
      { repositories: ["demo"], permissions: { contents: "read", metadata: "read" } },
      { repositories: ["demo"], permissions: { issues: "read", metadata: "read" } },
    ]);
  });

  it("mints `actions` and `deployments` at read, one repository at a time, for Plan 4's GitHub Actions connector, and only at read", async () => {
    const github = fakeGithub();
    const provider = providerOf(github);
    await provider.createAgentInstallationToken(REPOSITORY, { actions: "read" }, { orgId: TEST_ORG });
    await provider.createAgentInstallationToken(REPOSITORY, { deployments: "read" }, { orgId: TEST_ORG });
    await provider.createAgentInstallationToken(REPOSITORY, { actions: "read", deployments: "read" }, { orgId: TEST_ORG });
    expect(github.minted().map((request) => request.body)).toEqual([
      { repositories: ["demo"], permissions: { actions: "read", metadata: "read" } },
      { repositories: ["demo"], permissions: { deployments: "read", metadata: "read" } },
      { repositories: ["demo"], permissions: { actions: "read", deployments: "read", metadata: "read" } },
    ]);
  });

  it("keeps the one other way a token is minted exactly as it was: no narrowing option, and no `actions` or `deployments` key (R63)", () => {
    const mint = (GitHubAppCredentialProvider.prototype as unknown as Record<string, (...args: never[]) => unknown>)["createInstallationToken"]!;
    // (repository, permissions, scope, retried = false): three required parameters, as in Plan 2.
    expect(mint.length).toBe(3);
    const source = mint.toString();
    for (const word of ["narrow", "actions", "deployments"]) expect(source, word).not.toContain(word);
    expect(readFileSync(new URL("../../packages/broker/src/github-app.ts", import.meta.url), "utf8")).not.toMatch(/narrow\??:/u);
  });

  it("returns the token GitHub minted, and nothing else is asked for", async () => {
    const github = fakeGithub();
    const token = await providerOf(github).createAgentInstallationToken({ owner: "example", name: "demo" }, { issues: "write" }, { orgId: TEST_ORG });
    expect(token).toBe('token-{"issues":"write","metadata":"read"}');
  });

  it.each<[string, Record<string, unknown>]>([
    ["contents: write", { contents: "write" }],
    ["workflows", { workflows: "write" }],
    ["workflows: read", { workflows: "read" }],
    ["administration", { administration: "write" }],
    ["actions: write", { actions: "write" }],
    ["deployments: write", { deployments: "write" }],
    ["actions: write beside deployments: read", { actions: "write", deployments: "read" }],
    ["deployments: write beside actions: read", { actions: "read", deployments: "write" }],
    ["an actions level that is not a level", { actions: "admin" }],
    ["a permission nobody listed", { statuses: "write" }],
    ["metadata: write", { metadata: "write" }],
    ["a level that is not a level", { issues: "admin" }],
    ["contents: write beside a legal one", { issues: "read", contents: "write" }],
  ])("refuses %s before GitHub is asked anything", async (_name, permissions) => {
    const github = fakeGithub();
    const refused = await refusal(providerOf(github).createAgentInstallationToken(REPOSITORY, permissions, { orgId: TEST_ORG }));
    expect(refused.code).toBe("FORBIDDEN");
    expect(github.requests).toEqual([]);
  });

  it.each<[string, unknown]>([
    ["a webhook system scope", { system: "webhook" }],
    ["an install system scope", { system: "install" }],
    ["both an org and a system scope", { orgId: TEST_ORG, system: "webhook" }],
    ["no scope", undefined],
    ["a scope with no org", {}],
  ])("is minted only for an organization's own work: refuses %s", async (_name, scope) => {
    const github = fakeGithub();
    const refused = await refusal(providerOf(github).createAgentInstallationToken(REPOSITORY, { issues: "read" }, scope as never));
    expect(refused).toEqual({ code: "FORBIDDEN", message: "An agent's GitHub token is minted only for an organization's own work." });
    expect(github.requests).toEqual([]);
  });

  it("goes through the org's installation binding at the moment of the mint, for the installation the repository is under", async () => {
    const github = fakeGithub();
    const bound = vi.fn(async () => undefined);
    await providerOf(github, bound).createAgentInstallationToken(REPOSITORY, { issues: "read" }, { orgId: TEST_ORG });
    expect(bound).toHaveBeenCalledWith(TEST_ORG, 55, { owner: "example", name: "demo" });
    // The check comes before the token: it is the first thing after the installation lookup.
    expect(github.requests.map((request) => request.path)).toEqual(["/repos/example/demo/installation", "/app/installations/55/access_tokens"]);
  });

  it("mints nothing for an installation that is not bound to the org, and does not echo who asked for what", async () => {
    const github = fakeGithub();
    const notBound = vi.fn(async (orgId: OrgId) => { if (orgId === ORG_B) throw agentXError("GITHUB_NOT_CONNECTED", "GitHub isn't connected for this repository"); });
    const provider = providerOf(github, notBound);
    expect(await refusal(provider.createAgentInstallationToken(REPOSITORY, { issues: "read" }, { orgId: ORG_B }))).toEqual({ code: "GITHUB_NOT_CONNECTED", message: "GitHub isn't connected for this repository" });
    expect(github.minted()).toEqual([]);
    // The same repository for the org it is bound to still works.
    await provider.createAgentInstallationToken(REPOSITORY, { issues: "read" }, { orgId: TEST_ORG });
    expect(github.minted()).toHaveLength(1);
  });

  it("reads the binding again for every mint, so a binding removed in between stops the next token", async () => {
    const github = fakeGithub();
    let connected = true;
    const provider = providerOf(github, async () => { if (!connected) throw agentXError("GITHUB_NOT_CONNECTED", "GitHub isn't connected for this repository"); });
    await provider.createAgentInstallationToken(REPOSITORY, { issues: "read" }, { orgId: TEST_ORG });
    connected = false;
    await expect(provider.createAgentInstallationToken(REPOSITORY, { issues: "read" }, { orgId: TEST_ORG })).rejects.toMatchObject({ code: "GITHUB_NOT_CONNECTED" });
    expect(github.minted()).toHaveLength(1);
  });

  it("says GitHub is unavailable, not that a permission was refused, when GitHub does not mint", async () => {
    const github = fakeGithub({ handler: (request) => (request.path.endsWith("/access_tokens") ? Response.json({ message: "boom" }, { status: 503 }) : undefined) });
    expect(await refusal(providerOf(github).createAgentInstallationToken(REPOSITORY, { issues: "read" }, { orgId: TEST_ORG }))).toEqual({
      code: "RUNTIME_UNAVAILABLE", message: "GitHub App installation token request failed with HTTP 503",
    });
  });
});

describe("getAgentPullRequestHead (PF16)", () => {
  const pull = (overrides: Record<string, unknown> = {}) => ({ number: 12, state: "open", merged: false, head: { sha: HEAD, ref: "feature" }, base: { ref: "main" }, ...overrides });
  const answering = (body: unknown, status = 200) => fakeGithub({ handler: (request) => (request.path === "/repos/example/demo/pulls/12" ? Response.json(body, { status }) : undefined) });

  it("reads the head commit with a pull-request and contents read token for the org, plus metadata read", async () => {
    const github = answering(pull());
    const bound = vi.fn(async () => undefined);
    const head = await providerOf(github, bound).getAgentPullRequestHead(REPOSITORY, 12, { orgId: TEST_ORG });
    expect(head).toEqual({ headSha: HEAD, state: "open" });
    expect(github.minted().map((request) => request.body)).toEqual([{ repositories: ["demo"], permissions: { pull_requests: "read", contents: "read", metadata: "read" } }]);
    expect(bound).toHaveBeenCalledTimes(1);
    expect(bound).toHaveBeenCalledWith(TEST_ORG, 55, { owner: "example", name: "demo" });
    const read = github.requests.find((request) => request.path === "/repos/example/demo/pulls/12")!;
    expect(read.authorization).toBe('Bearer token-{"pull_requests":"read","contents":"read","metadata":"read"}');
  });

  it("reports a merged pull request as merged and reads the head of one from a fork", async () => {
    const merged = answering(pull({ state: "closed", merged: true }));
    expect((await providerOf(merged).getAgentPullRequestHead(REPOSITORY, 12, { orgId: TEST_ORG })).state).toBe("merged");
    const fork = answering(pull({ head: { sha: HEAD, ref: "x", repo: { full_name: "someone/demo" } } }));
    expect((await providerOf(fork).getAgentPullRequestHead(REPOSITORY, 12, { orgId: TEST_ORG })).headSha).toBe(HEAD);
  });

  it("says a pull request that is not there doesn't exist, without repeating anything the caller typed", async () => {
    const github = answering({ message: "Not Found" }, 404);
    expect(await refusal(providerOf(github).getAgentPullRequestHead(REPOSITORY, 12, { orgId: TEST_ORG }))).toEqual({ code: "CONFIG_INVALID", message: "pull request 12 of example/demo doesn't exist" });
  });

  it.each<[string, unknown, number]>([
    ["a GitHub error", { message: "boom" }, 500],
    ["an answer for another pull request", pull({ number: 13 }), 200],
    ["a head that is not a commit", pull({ head: { sha: "not-a-sha" } }), 200],
    ["a head sha of the wrong length", pull({ head: { sha: "a".repeat(64) } }), 200],
    ["no head", pull({ head: undefined }), 200],
    ["an answer that is not an object", ["x"], 200],
    ["a state that is neither open nor closed", pull({ state: "draft" }), 200],
  ])("fails closed on %s", async (_name, body, status) => {
    const github = answering(body, status);
    expect((await refusal(providerOf(github).getAgentPullRequestHead(REPOSITORY, 12, { orgId: TEST_ORG }))).code).toBe("RUNTIME_UNAVAILABLE");
  });

  it("refuses a number that is not a pull request number, and a scope that is not an org's, before asking GitHub", async () => {
    const github = answering(pull());
    for (const number of [0, -1, 1.5, Number.NaN]) {
      expect((await refusal(providerOf(github).getAgentPullRequestHead(REPOSITORY, number, { orgId: TEST_ORG }))).code).toBe("CONFIG_INVALID");
    }
    expect((await refusal(providerOf(github).getAgentPullRequestHead(REPOSITORY, 12, { system: "webhook" } as never))).code).toBe("FORBIDDEN");
    expect(github.requests).toEqual([]);
  });
});

describe("agentRepositoryReader", () => {
  const file = (path: string, text: string, sha = "b".repeat(40)) => ({ type: "file", path, name: path.split("/").at(-1), sha, size: Buffer.byteLength(text), encoding: "base64", content: Buffer.from(text).toString("base64") });
  function repo(contents: Record<string, unknown>) {
    return fakeGithub({
      handler: (request) => {
        if (request.path === "/repos/example/demo") return Response.json({ default_branch: "release/2026" });
        if (request.path === "/repos/example/demo/git/ref/heads/release/2026") return Response.json({ object: { sha: COMMIT } });
        const match = /^\/repos\/example\/demo\/contents\/(.+)$/.exec(request.path);
        if (match !== null) {
          const found = contents[decodeURIComponent(match[1]!)];
          return found === undefined ? Response.json({ message: "Not Found" }, { status: 404 }) : Response.json(found);
        }
        return undefined;
      },
    });
  }

  it("mints one contents read token, names the default branch's head commit, and reads every path at that commit", async () => {
    const github = repo({ ".github/workflows": [{ name: "ci.yml", path: ".github/workflows/ci.yml", type: "file", sha: "d".repeat(40), size: 20 }], "bors.toml": file("bors.toml", "status = []") });
    const reader = await providerOf(github).agentRepositoryReader(REPOSITORY, { orgId: TEST_ORG });
    expect(reader).toMatchObject({ defaultBranch: "release/2026", commit: COMMIT });
    expect(await reader.list(".github/workflows")).toEqual({ entries: [{ name: "ci.yml", path: ".github/workflows/ci.yml", type: "file", sha: "d".repeat(40), size: 20 }], truncated: false });
    expect(await reader.read("bors.toml", 1_000)).toEqual({ sha: "b".repeat(40), size: 11, text: "status = []" });
    expect(github.minted().map((request) => request.body)).toEqual([{ repositories: ["demo"], permissions: { contents: "read", metadata: "read" } }]);
    for (const request of github.requests.filter((candidate) => candidate.path.includes("/contents/"))) expect(request.search).toBe(`?ref=${COMMIT}`);
  });

  it("reads a path that is not there, or the other kind, as undefined", async () => {
    const github = repo({ "scripts": [{ name: "x.sh", path: "scripts/x.sh", type: "file", sha: "e".repeat(40), size: 1 }], "bors.toml": file("bors.toml", "x") });
    const reader = await providerOf(github).agentRepositoryReader(REPOSITORY, { orgId: TEST_ORG });
    expect(await reader.list("missing")).toBeUndefined();
    expect(await reader.read("missing", 100)).toBeUndefined();
    // A directory read as a file is not a file there (a script name that is a folder); the answers below are not "absent".
    expect(await reader.read("scripts", 100)).toBeUndefined();
  });

  it("reads only a 404 as absent: a 200 that is not a listing, or not a file, throws", async () => {
    const github = repo({
      "bors.toml": file("bors.toml", "x"),
      link: { type: "symlink", name: "link", path: "link", sha: "e".repeat(40), size: 4, target: "elsewhere" },
      sub: { type: "submodule", name: "sub", path: "sub", sha: "e".repeat(40), size: 0 },
      odd: "text",
    });
    const reader = await providerOf(github).agentRepositoryReader(REPOSITORY, { orgId: TEST_ORG });
    for (const path of ["bors.toml", "link", "sub", "odd"]) expect((await refusal(reader.list(path))).code, `list ${path}`).toBe("RUNTIME_UNAVAILABLE");
    for (const path of ["link", "sub", "odd"]) expect((await refusal(reader.read(path, 100))).code, `read ${path}`).toBe("RUNTIME_UNAVAILABLE");
  });

  it("does not read a file over the size it was asked for, and says so", async () => {
    const big = { ...file("big.yml", "x".repeat(50)), content: "" , encoding: "none" };
    const reader = await providerOf(repo({ "big.yml": big })).agentRepositoryReader(REPOSITORY, { orgId: TEST_ORG });
    expect(await reader.read("big.yml", 10)).toEqual({ sha: "b".repeat(40), size: 50, tooLarge: true });
  });

  it("marks a directory listing that may be cut short", async () => {
    const entries = Array.from({ length: 1_000 }, (_, index) => ({ name: `w${String(index)}.yml`, path: `.github/workflows/w${String(index)}.yml`, type: "file", sha: "d".repeat(40), size: 1 }));
    const reader = await providerOf(repo({ ".github/workflows": entries })).agentRepositoryReader(REPOSITORY, { orgId: TEST_ORG });
    expect((await reader.list(".github/workflows"))?.truncated).toBe(true);
  });

  it.each(["", "../secrets", "a//b", "./x", "a\\b", "x".repeat(600)])("refuses the path %j before asking GitHub", async (path) => {
    const github = repo({});
    const reader = await providerOf(github).agentRepositoryReader(REPOSITORY, { orgId: TEST_ORG });
    const before = github.requests.length;
    expect((await refusal(reader.read(path, 100))).code).toBe("CONFIG_INVALID");
    expect((await refusal(reader.list(path))).code).toBe("CONFIG_INVALID");
    expect(github.requests).toHaveLength(before);
  });

  it("throws, rather than reads as missing, when GitHub fails or answers something it should not", async () => {
    const failing = fakeGithub({ handler: (request) => (request.path === "/repos/example/demo" ? Response.json({ default_branch: "main" }) : request.path.includes("/git/ref/") ? Response.json({ object: { sha: COMMIT } }) : request.path.includes("/contents/") ? new Response("no", { status: 502 }) : undefined) });
    const reader = await providerOf(failing).agentRepositoryReader(REPOSITORY, { orgId: TEST_ORG });
    expect((await refusal(reader.read("bors.toml", 10))).code).toBe("RUNTIME_UNAVAILABLE");
    expect((await refusal(reader.list(".github/workflows"))).code).toBe("RUNTIME_UNAVAILABLE");
    const noBranch = fakeGithub({ handler: (request) => (request.path === "/repos/example/demo" ? Response.json({}) : undefined) });
    expect((await refusal(providerOf(noBranch).agentRepositoryReader(REPOSITORY, { orgId: TEST_ORG }))).code).toBe("RUNTIME_UNAVAILABLE");
    const badCommit = fakeGithub({ handler: (request) => (request.path === "/repos/example/demo" ? Response.json({ default_branch: "main" }) : request.path.includes("/git/ref/") ? Response.json({ object: { sha: "zz" } }) : undefined) });
    expect((await refusal(providerOf(badCommit).agentRepositoryReader(REPOSITORY, { orgId: TEST_ORG }))).code).toBe("RUNTIME_UNAVAILABLE");
  });

  it("goes through the org's binding like every other mint", async () => {
    const github = repo({});
    const bound = vi.fn(async (orgId: OrgId) => { if (orgId === ORG_B) throw agentXError("GITHUB_NOT_CONNECTED", "GitHub isn't connected for this repository"); });
    await expect(providerOf(github, bound).agentRepositoryReader(REPOSITORY, { orgId: ORG_B })).rejects.toMatchObject({ code: "GITHUB_NOT_CONNECTED" });
    expect(github.minted()).toEqual([]);
  });
});

describe("listAgentRepositoryLabels", () => {
  const label = (id: number, name: string) => ({ id, node_id: `LA_${String(id)}`, name });

  it("lists the labels with an issues read token for the org", async () => {
    const github = fakeGithub({ handler: (request) => (request.path === "/repos/example/demo/labels" ? Response.json([label(1, "bug"), label(2, "automerge")]) : undefined) });
    expect(await providerOf(github).listAgentRepositoryLabels(REPOSITORY, { orgId: TEST_ORG })).toEqual([
      { id: 1, nodeId: "LA_1", name: "bug" }, { id: 2, nodeId: "LA_2", name: "automerge" },
    ]);
    expect(github.minted().map((request) => request.body)).toEqual([{ repositories: ["demo"], permissions: { issues: "read", metadata: "read" } }]);
  });

  it("reads every page", async () => {
    const github = fakeGithub({
      handler: (request) => {
        if (request.path !== "/repos/example/demo/labels") return undefined;
        const page = Number(new URLSearchParams(request.search).get("page"));
        return Response.json(page === 1 ? Array.from({ length: 100 }, (_, index) => label(index + 1, `l${String(index)}`)) : [label(101, "last")]);
      },
    });
    const labels = await providerOf(github).listAgentRepositoryLabels(REPOSITORY, { orgId: TEST_ORG });
    expect(labels).toHaveLength(101);
    expect(labels.at(-1)).toEqual({ id: 101, nodeId: "LA_101", name: "last" });
  });

  it("fails closed on more than a thousand labels, an error and an answer that is not a list", async () => {
    const endless = fakeGithub({ handler: (request) => (request.path === "/repos/example/demo/labels" ? Response.json(Array.from({ length: 100 }, (_, index) => label(index + 1, "x"))) : undefined) });
    expect(await refusal(providerOf(endless).listAgentRepositoryLabels(REPOSITORY, { orgId: TEST_ORG }))).toEqual({ code: "RUNTIME_UNAVAILABLE", message: "this repository has too many labels to look up" });
    const down = fakeGithub({ handler: (request) => (request.path === "/repos/example/demo/labels" ? new Response("no", { status: 500 }) : undefined) });
    expect((await refusal(providerOf(down).listAgentRepositoryLabels(REPOSITORY, { orgId: TEST_ORG }))).code).toBe("RUNTIME_UNAVAILABLE");
    const odd = fakeGithub({ handler: (request) => (request.path === "/repos/example/demo/labels" ? Response.json({ labels: [] }) : request.path.endsWith("/installation") ? undefined : undefined) });
    expect((await refusal(providerOf(odd).listAgentRepositoryLabels(REPOSITORY, { orgId: TEST_ORG }))).code).toBe("RUNTIME_UNAVAILABLE");
    const badEntry = fakeGithub({ handler: (request) => (request.path === "/repos/example/demo/labels" ? Response.json([{ id: "1", node_id: "x", name: "y" }]) : undefined) });
    expect((await refusal(providerOf(badEntry).listAgentRepositoryLabels(REPOSITORY, { orgId: TEST_ORG }))).code).toBe("RUNTIME_UNAVAILABLE");
  });
});

// ---- Fix round 1 (review M5): the project repository's pinned installation

describe("a pinned installation id", () => {
  const NOT_CONNECTED = { code: "GITHUB_NOT_CONNECTED", message: expect.stringContaining("example/demo") as string };
  const pull = { number: 12, state: "open", merged: false, head: { sha: HEAD, ref: "x" }, base: { ref: "main" } };
  const world = () => fakeGithub({
    handler: (request) => {
      if (request.path === "/repos/example/demo/pulls/12") return Response.json(pull);
      if (request.path === "/repos/example/demo") return Response.json({ default_branch: "main" });
      if (request.path === "/repos/example/demo/git/ref/heads/main") return Response.json({ object: { sha: COMMIT } });
      if (request.path === "/repos/example/demo/labels") return Response.json([]);
      return undefined;
    },
  });

  it("is compared at the mint: a repository under another installation than the project pinned gets no token", async () => {
    const github = world();
    const provider = providerOf(github);
    expect(await refusal(provider.createAgentInstallationToken(REPOSITORY, { issues: "read" }, { orgId: TEST_ORG }, { installationId: 99 }))).toMatchObject(NOT_CONNECTED);
    expect(await refusal(provider.getAgentPullRequestHead(REPOSITORY, 12, { orgId: TEST_ORG }, { installationId: 99 }))).toMatchObject(NOT_CONNECTED);
    expect(await refusal(provider.agentRepositoryReader(REPOSITORY, { orgId: TEST_ORG }, { installationId: 99 }))).toMatchObject(NOT_CONNECTED);
    expect(await refusal(provider.listAgentRepositoryLabels(REPOSITORY, { orgId: TEST_ORG }, { installationId: 99 }))).toMatchObject(NOT_CONNECTED);
    expect(github.minted()).toEqual([]);
  });

  it("lets the pinned installation through, and an unpinned repository as before", async () => {
    const github = world();
    const provider = providerOf(github);
    await provider.createAgentInstallationToken(REPOSITORY, { issues: "read" }, { orgId: TEST_ORG }, { installationId: 55 });
    expect((await provider.getAgentPullRequestHead(REPOSITORY, 12, { orgId: TEST_ORG }, { installationId: 55 })).headSha).toBe(HEAD);
    expect((await provider.agentRepositoryReader(REPOSITORY, { orgId: TEST_ORG }, { installationId: 55 })).commit).toBe(COMMIT);
    expect(await provider.listAgentRepositoryLabels(REPOSITORY, { orgId: TEST_ORG }, { installationId: 55 })).toEqual([]);
    await provider.createAgentInstallationToken(REPOSITORY, { issues: "read" }, { orgId: TEST_ORG });
    expect(github.minted()).toHaveLength(5);
  });
});

// ---- Hardening 1 (review task-17-review.md, noted item): the retry after a 404 keeps the pin

describe("a pinned installation id and the token retry after a 404", () => {
  const NOT_CONNECTED = { code: "GITHUB_NOT_CONNECTED", message: expect.stringContaining("example/demo") as string };
  const pull = { number: 12, state: "open", merged: false, head: { sha: HEAD, ref: "x" }, base: { ref: "main" } };
  const LOOKUP = /^\/repos\/[^/]+\/[^/]+\/installation$/;

  /** example/demo is first under installation 55 (whose token request is then answered 404), and under installation 77 when GitHub is asked again. */
  const moving = () => {
    let lookups = 0;
    return fakeGithub({
      handler: (request) => {
        if (LOOKUP.test(request.path)) { lookups += 1; return Response.json({ id: lookups === 1 ? 55 : 77, account: { login: "example" } }); }
        if (request.path === "/app/installations/55/access_tokens") return Response.json({ message: "Not Found" }, { status: 404 });
        if (request.path === "/app/installations/77/access_tokens") return Response.json({ token: "token-of-77" }, { status: 201 });
        if (request.path === "/repos/example/demo/pulls/12") return Response.json(pull);
        return undefined;
      },
    });
  };

  it("refuses a retry that would cross to another installation than the pinned one, and mints nothing there", async () => {
    const github = moving();
    const provider = providerOf(github);
    expect(await refusal(provider.createAgentInstallationToken(REPOSITORY, { issues: "read" }, { orgId: TEST_ORG }, { installationId: 55 }))).toMatchObject(NOT_CONNECTED);
    expect(github.minted().map((request) => request.path)).toEqual(["/app/installations/55/access_tokens"]);
  });

  it("refuses it for the reads made with an agent token too", async () => {
    const github = moving();
    const provider = providerOf(github);
    expect(await refusal(provider.getAgentPullRequestHead(REPOSITORY, 12, { orgId: TEST_ORG }, { installationId: 55 }))).toMatchObject(NOT_CONNECTED);
    expect(github.minted().map((request) => request.path)).toEqual(["/app/installations/55/access_tokens"]);
    expect(github.requests.some((request) => request.authorization === "Bearer token-of-77")).toBe(false);
  });

  it("still retries when GitHub answers with the pinned installation again, and when nothing is pinned", async () => {
    let lookups = 0;
    let first = true;
    const github = fakeGithub({
      handler: (request) => {
        if (LOOKUP.test(request.path)) { lookups += 1; return Response.json({ id: 55, account: { login: "example" } }); }
        if (request.path === "/app/installations/55/access_tokens" && first) { first = false; return Response.json({ message: "Not Found" }, { status: 404 }); }
        return undefined;
      },
    });
    await providerOf(github).createAgentInstallationToken(REPOSITORY, { issues: "read" }, { orgId: TEST_ORG }, { installationId: 55 });
    expect(lookups).toBe(2);
    expect(github.minted()).toHaveLength(2);
    const unpinned = moving();
    await providerOf(unpinned).createAgentInstallationToken(REPOSITORY, { issues: "read" }, { orgId: TEST_ORG });
    expect(unpinned.minted().map((request) => request.path)).toEqual(["/app/installations/55/access_tokens", "/app/installations/77/access_tokens"]);
  });
});
