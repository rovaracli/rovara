// Enterprise foundations P5a-c: the consumers reach a repository's code host by the repository's RECORD (task P7), never by its address and never by a default. A record that names a host the
// install has not registered is refused with the fixed sentence; one that names none is GitHub; the check runner and the team lookup follow the host.
import { describe, expect, it, vi } from "vitest";
import { editionPolicy, projectRevisionKey } from "../../packages/contracts/src/index.js";
import { consumerRepositoryResolver, githubRepositoryOver } from "../../packages/broker/src/aws/broker/consumer-hosts.js";
import { FakeCheckRunner } from "../../packages/broker/src/plugins/fake/check-runner.js";
import { FakeCodeHost } from "../../packages/broker/src/plugins/fake/code-host.js";
import { FakeHostModel } from "../../packages/broker/src/plugins/fake/model.js";
import { githubCodeHost } from "../../packages/broker/src/plugins/code-host/github/index.js";
import { NO_HOST_MESSAGE, createPluginRegistry } from "../../packages/broker/src/plugins/registry.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { TEST_ORG } from "../support/orgs.js";

const GITHUB_URL = "https://github.com/acme/web.git";
const FAKE_URL = "https://git.example.test/acme/api";

function setup(options: { withoutRegistry?: boolean } = {}) {
  const db = new FakeDynamoDb();
  const repositories = [
    { name: "web", url: GITHUB_URL, path: "repo/web", defaultBranch: "main", credentialRef: "github-app" },
    { name: "web-pinned", url: GITHUB_URL, path: "repo/web2", defaultBranch: "main", credentialRef: "github-app", host: { kind: "github" as const, installationId: 5, repositoryId: 6 } },
    { name: "api", url: FAKE_URL, path: "repo/api", defaultBranch: "main", credentialRef: "x", host: { kind: "fake", ref: "r1" } },
    { name: "mystery", url: "https://git.example.test/acme/mystery", path: "repo/m", defaultBranch: "main", credentialRef: "x", host: { kind: "examplehost" } },
  ];
  db.set({ ...projectRevisionKey(TEST_ORG, "payments", 1), entityType: "PROJECT", registeredAt: "2026-10-31T00:00:00.000Z", definition: { name: "payments", revision: 1, repositories, setup: [], readiness: [], orchestratorInstructions: "x" } });
  const isTeamMember = vi.fn(async () => "member" as const);
  const github = {
    getPullRequestStatus: vi.fn(), getRepositoryPermission: async () => "write" as const, mergePullRequest: vi.fn(), isTeamMember,
    getJobLogTail: async () => "tail",
  };
  const fakeHost = new FakeCodeHost(new FakeHostModel({ url: FAKE_URL, id: "7", fullName: "acme/api" }));
  const registry = createPluginRegistry({
    codeHosts: [githubCodeHost(github as never, { credentialRef: "github-app" }), fakeHost],
    checkRunners: [{ kind: "github-actions", create: () => ({ kind: "github-actions" } as never) }],
    // The fake host is an Enterprise plug-in: its kind needs the edition's feature.
    policy: editionPolicy("enterprise"),
  });
  const dependencies = {
    documentClient: db, tableName: "state", githubPullRequests: github, environmentName: "test",
    ...(options.withoutRegistry === true ? {} : { codeHost: registry.codeHost, checkRunner: registry.checkRunner }),
  };
  return { resolve: consumerRepositoryResolver(dependencies as never), fakeHost, github, isTeamMember };
}

describe("the repository the consumers are given", () => {
  it("is on the code host its record names: no host is GitHub, a github host is GitHub, a fake host is the fake", async () => {
    const { resolve, fakeHost } = setup();
    const plain = (await resolve("payments", 1, "web", TEST_ORG))!;
    const pinned = (await resolve("payments", 1, "web-pinned", TEST_ORG))!;
    const api = (await resolve("payments", 1, "api", TEST_ORG))!;
    expect([plain.codeHost.kind, pinned.codeHost.kind, api.codeHost.kind]).toEqual(["github", "github", "fake"]);
    expect(api.codeHost).toBe(fakeHost);
    expect(plain.url).toBe(GITHUB_URL);
    expect(api.url).toBe(FAKE_URL);
  });

  it("refuses a record that names a host this install has not registered, with the fixed sentence, and never falls back to GitHub", async () => {
    const { resolve } = setup();
    await expect(resolve("payments", 1, "mystery", TEST_ORG)).rejects.toMatchObject({ code: "CONFIG_INVALID", message: expect.stringContaining(NO_HOST_MESSAGE) as unknown });
    // The refusal does not echo the kind.
    await expect(resolve("payments", 1, "mystery", TEST_ORG)).rejects.not.toMatchObject({ message: expect.stringContaining("examplehost") as unknown });
  });

  it("refuses the same way when the install has no registry (a GitHub-only router stands in): a fake kind is not GitHub", async () => {
    const { resolve } = setup({ withoutRegistry: true });
    await expect(resolve("payments", 1, "api", TEST_ORG)).rejects.toMatchObject({ code: "CONFIG_INVALID", message: expect.stringContaining(NO_HOST_MESSAGE) as unknown });
    expect((await resolve("payments", 1, "web", TEST_ORG))?.codeHost.kind).toBe("github");
  });

  it("answers nothing for a repository the project does not hold", async () => {
    const { resolve } = setup();
    expect(await resolve("payments", 1, "ghost", TEST_ORG)).toBeUndefined();
  });

  it("carries the host's check runner and team lookup only where the host has them: GitHub has both, the fake host neither", async () => {
    const { resolve, isTeamMember } = setup();
    const web = (await resolve("payments", 1, "web", TEST_ORG))!;
    expect(web.checkRunner?.kind).toBe("github-actions");
    expect(await web.isTeamMember?.("acme/core", "maya", { orgId: TEST_ORG })).toBe("member");
    expect(isTeamMember).toHaveBeenCalledWith(GITHUB_URL, "acme/core", "maya", { orgId: TEST_ORG });
    const api = (await resolve("payments", 1, "api", TEST_ORG))!;
    expect(api.checkRunner).toBeUndefined();
    expect(api.isTeamMember).toBeUndefined();
    void FakeCheckRunner;
  });

  it("over a partial GitHub provider: a person's standing falls back to their permission, and code owners stay off unless the provider reads them", async () => {
    const partial = { getRepositoryPermission: async () => "admin" as const };
    const repository = githubRepositoryOver(partial as never, GITHUB_URL);
    await expect(repository.codeHost.standing({ url: GITHUB_URL }, { login: "maya" }, { orgId: TEST_ORG })).resolves.toEqual({ permission: "admin" });
    expect(repository.codeHost.capabilities.codeOwners).toBe(false);
    expect(repository.checkRunner).toBeUndefined();
    const reading = githubRepositoryOver({ ...partial, readCodeOwners: async () => undefined, listPullRequestFiles: async () => ({ files: [] }), getJobLogTail: async () => "x" } as never, GITHUB_URL);
    expect(reading.codeHost.capabilities.codeOwners).toBe(true);
    expect(reading.checkRunner?.kind).toBe("github-actions");
  });
});
