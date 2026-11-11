// Enterprise foundations, task P7: the repository record's `host` field, read beside the old top-level pins for one release, and the router that picks a
// code host by `host.kind`. Every case fails when the rule it names is removed.
import { describe, expect, it } from "vitest";
import { type CodeHost, canonicalJson } from "@rovara-code/contracts";
import { ProjectDefinitionSchema, RepositoryHostSchema, StoredProjectDefinitionSchema, repositoryHostOf, withRepositoryHost, workerProjectDefinition } from "@agentx/cloud-contracts";
import { editionPolicy } from "@agentx/cloud-contracts";
import { assertRepositoryHostsKnown, createPluginRegistry, selectCodeHost } from "../../packages/broker/src/plugins/registry.js";
import { FakeCodeHost } from "../../packages/broker/src/plugins/fake/code-host.js";
import { newModel } from "../plugins/fake-worlds.js";

const repo = (name: string, extra: Record<string, unknown> = {}) => ({
  name, url: `https://github.com/acme/${name}.git`, path: `repo/${name}`, defaultBranch: "main", credentialRef: "github-app", ...extra,
});
const project = (repositories: unknown[]) => ({
  name: "payments", revision: 1, repositories, setup: [], readiness: [], orchestratorInstructions: "Delegate work.",
});

describe("the repository host field", () => {
  it("reads a record written before it exactly as before: nothing is added on parse, and it is a github host", () => {
    const old = project([repo("api"), repo("web", { installationId: 7, githubRepositoryId: 99 })]);
    const parsed = ProjectDefinitionSchema.parse(old);
    expect(canonicalJson(parsed)).toBe(canonicalJson(old));
    expect(StoredProjectDefinitionSchema.parse(old)).toEqual(old);
    expect(repositoryHostOf(parsed.repositories[0]!)).toEqual({ kind: "github" });
    expect(repositoryHostOf(parsed.repositories[1]!)).toEqual({ kind: "github", installationId: 7, repositoryId: 99 });
  });

  it("reads the new shape from a stored record, and an explicit host wins over a missing pin", () => {
    const parsed = StoredProjectDefinitionSchema.parse(project([repo("api", { host: { kind: "github", installationId: 7, repositoryId: 99 } })]));
    expect(repositoryHostOf(parsed.repositories[0]!)).toEqual({ kind: "github", installationId: 7, repositoryId: 99 });
  });

  it("refuses a record whose host and old pins disagree, or whose host is another kind with github pins", () => {
    for (const bad of [
      repo("api", { host: { kind: "github", installationId: 7, repositoryId: 99 }, installationId: 8 }),
      repo("api", { host: { kind: "github", installationId: 7, repositoryId: 99 }, githubRepositoryId: 100 }),
      repo("api", { host: { kind: "examplehost" }, installationId: 8 }),
      repo("api", { host: { kind: "examplehost" }, githubRepositoryId: 8 }),
    ]) {
      expect(StoredProjectDefinitionSchema.safeParse(project([bad])).success).toBe(false);
    }
  });

  it("accepts a stored host and pins that agree", () => {
    expect(StoredProjectDefinitionSchema.safeParse(project([repo("api", { host: { kind: "github", installationId: 7, repositoryId: 99 }, installationId: 7, githubRepositoryId: 99 })])).success).toBe(true);
  });

  it("refuses malformed hosts: bad kind, unknown keys, non-positive ids, github fields on another kind", () => {
    for (const host of [
      { kind: "GitHub" }, { kind: "" }, { kind: "github", extra: 1 }, { kind: "github", installationId: 0 }, { kind: "github", repositoryId: -1 },
      { kind: "examplehost", installationId: 7 }, { kind: "examplehost", ref: "" }, {}, "github", null,
    ]) {
      expect(RepositoryHostSchema.safeParse(host).success, JSON.stringify(host)).toBe(false);
    }
    expect(RepositoryHostSchema.safeParse({ kind: "examplehost", ref: "pkg/abc" }).success).toBe(true);
  });

  it("does not WRITE a host in this release: a save with one is refused, whatever its kind, so the release before this one can still read what was saved (rollback)", () => {
    for (const host of [{ kind: "github" }, { kind: "github", installationId: 7, repositoryId: 99 }, { kind: "examplehost" }, { kind: "examplehost", ref: "pkg/abc" }, { kind: "made-up" }]) {
      const result = ProjectDefinitionSchema.safeParse(project([repo("api", { host })]));
      expect(result.success, JSON.stringify(host)).toBe(false);
      expect(JSON.stringify(result.error?.issues)).toContain("host");
      // The same record is read back fine when a later release has written it.
      expect(StoredProjectDefinitionSchema.safeParse(project([repo("api", { host })])).success, JSON.stringify(host)).toBe(true);
    }
  });

  it("the lazy rewrite adds no host to a GitHub record, so what is saved has exactly the fields the previous release knows", () => {
    const old = StoredProjectDefinitionSchema.parse(project([repo("web", { installationId: 7, githubRepositoryId: 99 })])).repositories[0]!;
    expect(withRepositoryHost(old)).toEqual(old);
    expect(withRepositoryHost(old)).not.toHaveProperty("host");
    const saved = ProjectDefinitionSchema.parse(project([withRepositoryHost(old)]));
    expect(Object.keys(saved.repositories[0]!).sort()).toEqual(["credentialRef", "defaultBranch", "githubRepositoryId", "installationId", "name", "path", "url"]);
  });

  it("is control-plane only: a worker is never sent the host", () => {
    const definition = StoredProjectDefinitionSchema.parse(project([repo("api", { host: { kind: "github", installationId: 7, repositoryId: 99 } })]));
    const sent = workerProjectDefinition(definition) as { repositories: Array<Record<string, unknown>> };
    expect(Object.keys(sent.repositories[0]!).sort()).toEqual(["credentialRef", "defaultBranch", "name", "path", "url"]);
  });
});

describe("the code host router", () => {
  // A fake whose kind is the one a test names (the fake itself is called "fake").
  const asKind = (kind: string): CodeHost => Object.create(new FakeCodeHost(newModel()), { kind: { value: kind } }) as CodeHost;
  const github = asKind("github");
  const other = asKind("examplehost");

  it("picks the entry whose kind is the host's kind", () => {
    const picked = selectCodeHost({ kind: "examplehost" }, [github, other]);
    expect(picked).toBe(other);
    const withInstallation = { kind: "github", installationId: 1 };
    expect(selectCodeHost(withInstallation, [github, other])).toBe(github);
  });

  it("an old record (no host) is routed to github", () => {
    const parsed = ProjectDefinitionSchema.parse(project([repo("api")]));
    expect(selectCodeHost(repositoryHostOf(parsed.repositories[0]!), [other, github])).toBe(github);
  });

  it("refuses an unknown kind with a fixed sentence that does not echo the kind", () => {
    let error: unknown;
    try { selectCodeHost({ kind: "unknown-host" }, [github, other]); } catch (caught) { error = caught; }
    expect((error as Error).message).not.toContain("unknown-host");
    expect((error as { code: string }).code).toBe("CONFIG_INVALID");
  });

  it("refuses when the install registered no code host at all, and never falls back to the first entry", () => {
    expect(() => selectCodeHost({ kind: "github" }, [])).toThrow("CONFIG_INVALID");
    expect(() => selectCodeHost({ kind: "github" }, [other])).toThrow("CONFIG_INVALID");
  });

  it("refuses an ambiguous registration: two entries for one kind", () => {
    expect(() => selectCodeHost({ kind: "github" }, [github, asKind("github")])).toThrow("CONFIG_INVALID");
  });

  it("refuses at start: every repository of a project must have a known kind", () => {
    const ok = StoredProjectDefinitionSchema.parse(project([repo("api"), repo("lib", { host: { kind: "examplehost" } })]));
    expect(() => assertRepositoryHostsKnown(ok.repositories, [github, other])).not.toThrow();
    expect(() => assertRepositoryHostsKnown(ok.repositories, [github])).toThrow("CONFIG_INVALID");
    expect(() => assertRepositoryHostsKnown(ok.repositories, [])).toThrow("CONFIG_INVALID");
  });
});

describe("the P4 router picks by the repository record's host (one registry)", () => {
  const asKind = (kind: string): CodeHost => Object.create(new FakeCodeHost(newModel()), { kind: { value: kind } }) as CodeHost;
  const github = asKind("github");
  const farm = asKind("examplehost");
  const enterprise = createPluginRegistry({ codeHosts: [github, farm], checkRunners: [], policy: editionPolicy("enterprise") });
  const publicOnly = createPluginRegistry({ codeHosts: [github], checkRunners: [] });

  it("forRecord routes by host.kind, and a record with no host (or old pins) is GitHub", () => {
    expect(enterprise.codeHost.forRecord(ProjectDefinitionSchema.parse(project([repo("api")])).repositories[0]!)).toBe(github);
    expect(enterprise.codeHost.forRecord(StoredProjectDefinitionSchema.parse(project([repo("api", { host: { kind: "examplehost" } })])).repositories[0]!)).toBe(farm);
    expect(enterprise.codeHost.forRecord({ installationId: 7, githubRepositoryId: 99 })).toBe(github);
  });

  it("forRecord refuses a kind with no registered host (fixed sentence, kind not echoed) and never falls back to GitHub", () => {
    let error: unknown;
    try { publicOnly.codeHost.forRecord(StoredProjectDefinitionSchema.parse(project([repo("api", { host: { kind: "examplehost" } })])).repositories[0]!); } catch (caught) { error = caught; }
    expect((error as { code: string }).code).toBe("CONFIG_INVALID");
    expect((error as Error).message).not.toContain("examplehost");
  });

  it("the start check takes the router's kinds: the same answer as with the entries", () => {
    const stored = StoredProjectDefinitionSchema.parse(project([repo("api"), repo("lib", { host: { kind: "examplehost" } })]));
    expect(() => assertRepositoryHostsKnown(stored.repositories, enterprise.codeHost)).not.toThrow();
    expect(() => assertRepositoryHostsKnown(stored.repositories, publicOnly.codeHost)).toThrow("CONFIG_INVALID");
  });

  it("a non-GitHub host cannot be registered without the Enterprise feature (P4), so Public refuses at build", () => {
    expect(() => createPluginRegistry({ codeHosts: [github, farm], checkRunners: [], policy: editionPolicy("public") })).toThrow();
  });
});
