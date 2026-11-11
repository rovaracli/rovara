import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { editionPolicy } from "@agentx/cloud-contracts";
import { createBrokerPlugins } from "../../packages/broker/src/aws/broker/plugin-wiring.js";
import { FakeCheckRunner } from "../../packages/broker/src/plugins/fake/check-runner.js";
import { FakeCodeHost } from "../../packages/broker/src/plugins/fake/code-host.js";
import { createPluginRegistry } from "../../packages/broker/src/plugins/registry.js";
import { newModel, REPO_URL, SCOPE } from "./fake-worlds.js";

// Enterprise foundations P4: the code host router (GitHub only for now) and the plug-in registry behind it.

function thrown(run: () => unknown): { code?: string; message: string } | undefined {
  try { run(); } catch (error) { return error as { code?: string; message: string }; }
  return undefined;
}

const github = () => Object.assign(new FakeCodeHost(newModel()), { kind: "github" });
const other = () => Object.assign(new FakeCodeHost(newModel()), { kind: "ghes" });
const runnerOf = (kind: string) => Object.assign(new FakeCheckRunner(newModel()), { kind });

describe("the code host router", () => {
  it("returns the GitHub adapter for every repository, whatever its address", () => {
    const host = github();
    const { codeHost } = createPluginRegistry({ codeHosts: [host], checkRunners: [] });
    for (const url of [REPO_URL, "https://github.com/acme/app", "https://git.corp.example.test/x/y", "ssh://whatever"]) expect(codeHost.forRepository({ url })).toBe(host);
    expect(codeHost.forKind("github")).toBe(host);
    expect(codeHost.kinds()).toEqual(["github"]);
  });

  it("refuses a repository whose host kind has no adapter, with a fixed sentence and nothing cloned", () => {
    const { codeHost } = createPluginRegistry({ codeHosts: [github()], checkRunners: [], hostKindOf: () => "ghes" });
    const failure = thrown(() => codeHost.forRepository({ url: REPO_URL }));
    expect(failure?.code).toBe("CONFIG_INVALID");
    expect(failure?.message).toContain("No code host is set up for this repository");
    expect(failure?.message).not.toContain(REPO_URL);
    expect(failure?.message).not.toContain("ghes");
  });

  it("refuses a registry with no GitHub adapter: the install's one built-in host is not optional", () => {
    expect(thrown(() => createPluginRegistry({ codeHosts: [], checkRunners: [] }))?.code).toBe("CONFIG_INVALID");
  });

  it("refuses the same kind twice, and a kind that is not a plug-in name", () => {
    expect(thrown(() => createPluginRegistry({ codeHosts: [github(), github()], checkRunners: [] }))?.code).toBe("CONFIG_INVALID");
    expect(thrown(() => createPluginRegistry({ codeHosts: [github(), Object.assign(other(), { kind: "Bad Kind" })], checkRunners: [], policy: editionPolicy("enterprise") }))?.code).toBe("CONFIG_INVALID");
    expect(thrown(() => createPluginRegistry({ codeHosts: [github()], checkRunners: [{ kind: "codebuild", create: () => runnerOf("codebuild") }, { kind: "codebuild", create: () => runnerOf("codebuild") }] }))?.code).toBe("CONFIG_INVALID");
    const { checkRunner } = createPluginRegistry({ codeHosts: [github()], checkRunners: [{ kind: "codebuild", create: () => runnerOf("github-actions") }] });
    expect(thrown(() => checkRunner("codebuild", { allowedRepositories: [] }))?.message).toContain("does not match");
  });
});

describe("the edition decides which plug-ins may be registered", () => {
  it("a host other than GitHub needs the Enterprise edition: Public and an install with no edition refuse it", () => {
    for (const policy of [editionPolicy("public"), undefined]) {
      expect(thrown(() => createPluginRegistry({ codeHosts: [github(), other()], checkRunners: [], ...(policy === undefined ? {} : { policy }) }))?.code, String(policy?.edition)).toBe("FORBIDDEN");
    }
    const { codeHost } = createPluginRegistry({ codeHosts: [github(), other()], checkRunners: [], policy: editionPolicy("enterprise"), hostKindOf: (repository) => (repository.url.includes("corp") ? "ghes" : "github") });
    expect(codeHost.kinds()).toEqual(["ghes", "github"]);
    expect(codeHost.forRepository({ url: "https://git.corp.example.test/a/b" }).kind).toBe("ghes");
    expect(codeHost.forRepository({ url: "https://github.com/a/b" }).kind).toBe("github");
  });

  it("a check runner other than the built-in GitHub Actions and CodeBuild ones needs the Enterprise edition", () => {
    const build = [{ kind: "github-actions", create: () => runnerOf("github-actions") }, { kind: "codebuild", create: () => runnerOf("codebuild") }];
    expect(thrown(() => createPluginRegistry({ codeHosts: [github()], checkRunners: build, policy: editionPolicy("public") }))).toBeUndefined();
    expect(thrown(() => createPluginRegistry({ codeHosts: [github()], checkRunners: build }))).toBeUndefined();
    const custom = [...build, { kind: "brazil", create: () => runnerOf("brazil") }];
    expect(thrown(() => createPluginRegistry({ codeHosts: [github()], checkRunners: custom, policy: editionPolicy("public") }))?.code).toBe("FORBIDDEN");
    expect(thrown(() => createPluginRegistry({ codeHosts: [github()], checkRunners: custom }))?.code).toBe("FORBIDDEN");
    expect(thrown(() => createPluginRegistry({ codeHosts: [github()], checkRunners: custom, policy: editionPolicy("enterprise") }))).toBeUndefined();
  });
});

describe("check runners", () => {
  it("are looked up by kind, built with the caller's repositories, and an unknown kind is refused", () => {
    const create = vi.fn((context: { allowedRepositories: readonly string[] }) => Object.assign(runnerOf("codebuild"), { seen: context.allowedRepositories }));
    const { checkRunner } = createPluginRegistry({ codeHosts: [github()], checkRunners: [{ kind: "codebuild", create }] });
    const runner = checkRunner("codebuild", { allowedRepositories: [REPO_URL] }) as unknown as { seen: readonly string[] };
    expect(runner.seen).toEqual([REPO_URL]);
    expect(create).toHaveBeenCalledTimes(1);
    expect(thrown(() => checkRunner("circleci", { allowedRepositories: [] }))?.code).toBe("CONFIG_INVALID");
  });
});

describe("the broker's wiring (createBrokerPlugins)", () => {
  const provider = { checkRepository: vi.fn(), getPullRequestStatus: vi.fn(), getJobLogTail: vi.fn() };
  const gateway = { start: vi.fn(), status: vi.fn() };
  const build = (policy?: ReturnType<typeof editionPolicy>) => createBrokerPlugins({ provider: provider as never, credentialRef: "github-app", codeBuild: gateway, ...(policy === undefined ? {} : { policy }) });

  it("registers GitHub as the code host and GitHub Actions and CodeBuild as check runners", () => {
    const plugins = build();
    expect(plugins.codeHost.kinds()).toEqual(["github"]);
    expect(plugins.codeHost.forRepository({ url: "https://github.com/acme/app" }).kind).toBe("github");
    expect(plugins.checkRunner("github-actions", { allowedRepositories: [] }).kind).toBe("github-actions");
    expect(plugins.checkRunner("codebuild", { allowedRepositories: [] }).kind).toBe("codebuild");
  });

  it("the CodeBuild runner serves only the repositories it was given", async () => {
    const runner = build(editionPolicy("enterprise")).checkRunner("codebuild", { allowedRepositories: [REPO_URL] });
    await expect(runner.start!({ repository: { url: "https://elsewhere.example.test/x/y" }, gate: "unit", project: "p", revision: "a".repeat(40), timeoutMinutes: 10, idempotencyKey: "k-1" }, SCOPE)).rejects.toThrow(/not registered/);
    expect(gateway.start).not.toHaveBeenCalled();
  });

  it("the GitHub credential reference reaches the adapter: a repository check names it", async () => {
    await build().codeHost.forRepository({ url: "https://github.com/acme/app" }).checkRepository({ url: "https://github.com/acme/app" }, SCOPE);
    expect(provider.checkRepository).toHaveBeenCalledWith({ credentialRef: "github-app", url: "https://github.com/acme/app" }, SCOPE);
  });

  it("broker.ts hands the router to the broker (one wiring line), beside the old name", () => {
    const source = readFileSync(new URL("../../packages/broker/src/aws/broker.ts", import.meta.url), "utf8");
    expect(source).toMatch(/createBrokerPlugins\(/);
    expect(source).toMatch(/codeHost: plugins\.codeHost/);
    expect(source).toMatch(/githubPullRequests: githubCredentials/);
  });
});
