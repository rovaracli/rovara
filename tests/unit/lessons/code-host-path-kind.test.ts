// Lessons in production, lane 2 (WB-7): the code host can say what a path is at a commit (`pathKind`: file, dir, none), so a lesson that cites a directory, or a glob whose literal directory prefix is one,
// can be verified. A host without it (or a reader without `kind`) leaves such paths unverified, which is what it did before.
import { describe, expect, it } from "vitest";
import { editionPolicy } from "@agentx/cloud-contracts";
import { projectRevisionKey } from "@rovara-code/contracts";
import { codeFileReader } from "../../../packages/broker/src/aws/broker/lessons-wiring.js";
import { createPluginRegistry } from "../../../packages/broker/src/plugins/registry.js";
import { FakeDynamoDb } from "../../support/fake-dynamodb.js";
import { TEST_ORG } from "../../support/orgs.js";
import { createCodeFacts, codeHostFactsReader } from "../../../packages/broker/src/lessons/code-facts.js";
import { githubCodeHost } from "../../../packages/broker/src/plugins/code-host/github/index.js";
import { FakeCodeHost } from "../../../packages/broker/src/plugins/fake/code-host.js";
import { FakeHostModel } from "../../../packages/broker/src/plugins/fake/model.js";

const URL = "https://host.example.test/acme/api.git";
const SCOPE = { orgId: "org_aaaaaaaaaaaaaaaaaaaa" } as never;
const build = () => {
  const model = new FakeHostModel({ url: URL, id: "7", fullName: "acme/api", initialFiles: { "README.md": "# demo\n", "src/http/client.ts": "export const a = 1;\n", "src/http/retry.ts": "export const b = 2;\n", "docs/guide.md": "g\n" } });
  return { model, host: new FakeCodeHost(model), commit: model.headOf("main") };
};

describe("the fake host's pathKind", () => {
  it("answers file, dir and none, and refuses a repository nobody registered and a scope that is not one", async () => {
    const { host, commit } = build();
    const kind = (path: string) => host.pathKind({ url: URL }, path, commit, SCOPE);
    expect(await kind("README.md")).toBe("file");
    expect(await kind("src/http/client.ts")).toBe("file");
    expect(await kind("src")).toBe("dir");
    expect(await kind("src/http")).toBe("dir");
    expect(await kind("src/htt")).toBe("none");
    expect(await kind("nothing/here")).toBe("none");
    await expect(host.pathKind({ url: "https://host.example.test/other.git" }, "src", commit, SCOPE)).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    await expect(host.pathKind({ url: URL }, "src", commit, {} as never)).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });
});

describe("the GitHub adapter's pathKind", () => {
  it("is there when the provider can tell, calls the provider with the checked scope and the repository's address, and is absent when the provider cannot", async () => {
    const calls: unknown[][] = [];
    const provider = { getPathKindAtCommit: async (...args: unknown[]) => { calls.push(args); return "dir" as const; } };
    const host = githubCodeHost(provider as never, { credentialRef: "ref" });
    expect(await host.pathKind!({ url: "https://github.com/acme/api.git" }, "src", "a".repeat(40), { system: "install" }, { timeoutMs: 1_000 })).toBe("dir");
    expect(calls).toEqual([["https://github.com/acme/api.git", "src", "a".repeat(40), { system: "install" }, { timeoutMs: 1_000 }]]);
    expect(Object.keys(githubCodeHost({} as never, { credentialRef: "ref" }))).not.toContain("pathKind");
  });
});

describe("the GitHub adapter's change request details (lessons in the repo: read and confirm before a close)", () => {
  it("carries whether Rovara's own account made it and the id of the repository it is against, and says nothing when the provider did not", async () => {
    const details = { number: 7, url: "https://github.com/acme/api/pull/7", state: "open" as const, headBranch: "rovara/lessons-0123456789ab", baseBranch: "main", headCommit: "a".repeat(40), title: "t", body: "b" };
    const host = (answer: object) => githubCodeHost({ getPullRequest: async () => ({ ...details, ...answer }) } as never, { credentialRef: "ref" });
    const read = (h: ReturnType<typeof host>) => h.getChangeRequest({ repository: { url: "https://github.com/acme/api.git" }, id: "7", url: "" }, { system: "install" });
    expect(await read(host({ authoredByApp: true, baseRepositoryId: "1001" }))).toMatchObject({ authoredByRovara: true, baseRepositoryId: "1001" });
    expect(await read(host({ authoredByApp: false }))).toMatchObject({ authoredByRovara: false });
    const silent = await read(host({}));
    expect(silent.authoredByRovara).toBeUndefined();
    expect(silent.baseRepositoryId).toBeUndefined();
  });
});

describe("pathExists through a host that has pathKind", () => {
  const facts = (host: Pick<FakeCodeHost, "fileAtRevision" | "pathKind"> | { fileAtRevision: FakeCodeHost["fileAtRevision"]; pathKind?: undefined }) => createCodeFacts({
    reader: codeHostFactsReader(host as never, async () => ({ repository: { url: URL }, scope: SCOPE })), repositoriesOf: async () => ["api"],
  });
  const ask = (f: ReturnType<typeof facts>, commit: string, path: string) => f.pathExists({ workspaceId: "ws", project: "p", repo: "api", commit, path });

  it("a directory exists, and a glob counts when its literal directory prefix is one", async () => {
    const { host, commit } = build();
    const f = facts(host);
    expect(await ask(f, commit, "src/http")).toBe(true);
    expect(await ask(f, commit, "src/http/client.ts")).toBe(true);
    expect(await ask(f, commit, "src/missing")).toBe(false);
    expect(await ask(f, commit, "src/http/**/*.ts")).toBe(true);
    expect(await ask(f, commit, "src/*.ts")).toBe(true);
    expect(await ask(f, commit, "**/*.md")).toBe(true);
    // A glob whose literal prefix is a FILE or is missing is not a directory glob.
    expect(await ask(f, commit, "README.md/**")).toBe(false);
    expect(await ask(f, commit, "lib/**/*.ts")).toBe(false);
  });

  it("a host without pathKind is as before: a file that can be read exists, a directory and a glob are unverified (undefined), never a guess", async () => {
    const { host, commit } = build();
    const f = facts({ fileAtRevision: host.fileAtRevision.bind(host) });
    expect(await ask(f, commit, "src/http/client.ts")).toBe(true);
    expect(await ask(f, commit, "src/http")).toBeUndefined();
    expect(await ask(f, commit, "src/http/**/*.ts")).toBeUndefined();
  });

  it("M3: a reader whose kind cannot tell (the broker's reader over a host with no pathKind) still verifies a plain file by reading it; a directory and a glob stay unverified", async () => {
    const { host, commit } = build();
    const reader = { file: (input: Parameters<typeof host.fileAtRevision>[1] extends string ? { path: string; commit: string } : never) => host.fileAtRevision({ url: URL }, input.path, input.commit, SCOPE), kind: async () => undefined };
    const f = createCodeFacts({ reader: reader, repositoriesOf: async () => ["api"] });
    expect(await ask(f, commit, "src/http/client.ts")).toBe(true);
    expect(await ask(f, commit, "src/missing.ts")).toBeUndefined();
    expect(await ask(f, commit, "src/http")).toBeUndefined();
    expect(await ask(f, commit, "src/http/**/*.ts")).toBeUndefined();
  });

  it("a host that fails is not verified (undefined), not 'missing'", async () => {
    const { host, commit } = build();
    const f = facts({ fileAtRevision: host.fileAtRevision.bind(host), pathKind: async () => { throw new Error("host down"); } });
    expect(await ask(f, commit, "src/http")).toBeUndefined();
  });
});

describe("the broker's own reader (codeFileReader) over a project's repository", () => {
  it("asks the repository's own host: a directory is a dir, a missing path is none; a host without pathKind answers undefined (cannot tell); a repository that is not the project's reads nothing", async () => {
    const fake = build();
    const db = new FakeDynamoDb();
    const repositories = [
      { name: "api", url: URL, path: "repo/api", defaultBranch: "main", credentialRef: "x", host: { kind: "fake", ref: "r1" } },
      { name: "web", url: "https://github.com/acme/web.git", path: "repo/web", defaultBranch: "main", credentialRef: "github-app" },
    ];
    db.set({ ...projectRevisionKey(TEST_ORG, "payments", 1), entityType: "PROJECT", registeredAt: "2026-10-31T00:00:00.000Z", definition: { name: "payments", revision: 1, repositories, setup: [], readiness: [], orchestratorInstructions: "x" } });
    const registry = createPluginRegistry({
      codeHosts: [githubCodeHost({} as never, { credentialRef: "github-app" }), fake.host], checkRunners: [{ kind: "github-actions", create: () => ({ kind: "github-actions" } as never) }], policy: editionPolicy("enterprise"),
    });
    const dependencies = { documentClient: db, tableName: "state", githubPullRequests: {}, environmentName: "test", codeHost: registry.codeHost, checkRunner: registry.checkRunner };
    const reader = codeFileReader(dependencies as never);
    const ask = (repo: string, path: string) => reader.kind!({ workspaceId: TEST_ORG, project: "payments", repo, commit: fake.commit, path, timeoutMs: 1_000 });
    expect(await ask("api", "src/http")).toBe("dir");
    expect(await ask("api", "README.md")).toBe("file");
    expect(await ask("api", "src/none")).toBe("none");
    // The GitHub adapter built over an empty provider cannot tell, so the reader says so.
    expect(await ask("web", "src")).toBeUndefined();
    expect(await ask("elsewhere", "src")).toBeUndefined();
  });
});
