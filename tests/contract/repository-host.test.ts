// Enterprise foundations, task P7: the repository record's `host` field, read beside the old top-level pins for one release, and the router that picks a
// code host by `host.kind`. Every case fails when the rule it names is removed.
import { describe, expect, it } from "vitest";
import {
  type CodeHost,
  ProjectDefinitionSchema,
  RepositoryHostSchema,
  StoredProjectDefinitionSchema,
  canonicalJson,
  repositoryHostOf,
  withRepositoryHost,
  workerProjectDefinition,
} from "../../packages/contracts/src/index.js";
import { assertRepositoryHostsKnown, selectCodeHost } from "../../packages/broker/src/plugins/registry.js";
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

  it("reads the new shape, and an explicit host wins over a missing pin", () => {
    const parsed = ProjectDefinitionSchema.parse(project([repo("api", { host: { kind: "github", installationId: 7, repositoryId: 99 } })]));
    expect(repositoryHostOf(parsed.repositories[0]!)).toEqual({ kind: "github", installationId: 7, repositoryId: 99 });
  });

  it("refuses a record whose host and old pins disagree, or whose host is another kind with github pins", () => {
    for (const bad of [
      repo("api", { host: { kind: "github", installationId: 7, repositoryId: 99 }, installationId: 8 }),
      repo("api", { host: { kind: "github", installationId: 7, repositoryId: 99 }, githubRepositoryId: 100 }),
      repo("api", { host: { kind: "gitfarm" }, installationId: 8 }),
      repo("api", { host: { kind: "gitfarm" }, githubRepositoryId: 8 }),
    ]) {
      expect(ProjectDefinitionSchema.safeParse(project([bad])).success).toBe(false);
      expect(StoredProjectDefinitionSchema.safeParse(project([bad])).success).toBe(false);
    }
  });

  it("accepts a host and pins that agree", () => {
    expect(ProjectDefinitionSchema.safeParse(project([repo("api", { host: { kind: "github", installationId: 7, repositoryId: 99 }, installationId: 7, githubRepositoryId: 99 })])).success).toBe(true);
  });

  it("refuses malformed hosts: bad kind, unknown keys, non-positive ids, github fields on another kind", () => {
    for (const host of [
      { kind: "GitHub" }, { kind: "" }, { kind: "github", extra: 1 }, { kind: "github", installationId: 0 }, { kind: "github", repositoryId: -1 },
      { kind: "gitfarm", installationId: 7 }, { kind: "gitfarm", ref: "" }, {}, "github", null,
    ]) {
      expect(RepositoryHostSchema.safeParse(host).success, JSON.stringify(host)).toBe(false);
    }
    expect(RepositoryHostSchema.safeParse({ kind: "gitfarm", ref: "pkg/abc" }).success).toBe(true);
  });

  it("withRepositoryHost is the lazy rewrite: sets host from the pins, keeps the pins for one release, and is idempotent", () => {
    const old = ProjectDefinitionSchema.parse(project([repo("web", { installationId: 7, githubRepositoryId: 99 })])).repositories[0]!;
    const rewritten = withRepositoryHost(old);
    expect(rewritten.host).toEqual({ kind: "github", installationId: 7, repositoryId: 99 });
    expect(rewritten.installationId).toBe(7);
    expect(rewritten.githubRepositoryId).toBe(99);
    expect(withRepositoryHost(rewritten)).toEqual(rewritten);
    // A rewritten record is a valid record.
    expect(ProjectDefinitionSchema.safeParse(project([rewritten])).success).toBe(true);
  });

  it("is control-plane only: a worker is never sent the host", () => {
    const definition = ProjectDefinitionSchema.parse(project([repo("api", { host: { kind: "github", installationId: 7, repositoryId: 99 } })]));
    const sent = workerProjectDefinition(definition) as { repositories: Array<Record<string, unknown>> };
    expect(Object.keys(sent.repositories[0]!).sort()).toEqual(["credentialRef", "defaultBranch", "name", "path", "url"]);
  });
});

describe("the code host router", () => {
  // A fake whose kind is the one a test names (the fake itself is called "fake").
  const asKind = (kind: string): CodeHost => Object.create(new FakeCodeHost(newModel()), { kind: { value: kind } }) as CodeHost;
  const github = asKind("github");
  const other = asKind("gitfarm");

  it("picks the entry whose kind is the host's kind", () => {
    const picked = selectCodeHost({ kind: "gitfarm" }, [github, other]);
    expect(picked).toBe(other);
    expect(selectCodeHost({ kind: "github", installationId: 1 }, [github, other])).toBe(github);
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
    const ok = ProjectDefinitionSchema.parse(project([repo("api"), repo("lib", { host: { kind: "gitfarm" } })]));
    expect(() => assertRepositoryHostsKnown(ok.repositories, [github, other])).not.toThrow();
    expect(() => assertRepositoryHostsKnown(ok.repositories, [github])).toThrow("CONFIG_INVALID");
    expect(() => assertRepositoryHostsKnown(ok.repositories, [])).toThrow("CONFIG_INVALID");
  });
});
