// Meta repo lane A, task A3: the worker puts the meta repository in the workspace read-only and sparse, and reports the commit every stage reads (`knowledgeCommit`).
// Real Git repositories in a temporary folder; the clone is injected as the other preparation tests do. Each case fails when the rule it names is removed.
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  PrepareMetaSchema,
  StoredProjectDefinitionSchema,
  WorkerInvocationSchema,
  type ProjectDefinition,
} from "../../packages/contracts/src/index.js";
import { META_CHECKOUT_MAX_FILES, listMaterialized, metaPathWanted, parseTreeListing } from "../../packages/worker/src/meta-checkout.js";
import { WORKER_IMPLEMENTED_FEATURES } from "../../packages/worker/src/implemented-features.js";
import { prepareWorkspace, preparedBaseResult, type RepositoryMaterializer } from "../../packages/worker/src/prepare.js";
import { META_PREPARE_FEATURE, metaPrepareFields, metaPrepareProblem, parseKnowledgeCommit } from "../../packages/broker/src/meta-repo/prepare-meta.js";

const execFileAsync = promisify(execFile);
const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" };
const git = async (cwd: string, ...args: string[]) => (await execFileAsync("git", ["-C", cwd, ...args], { env: gitEnv })).stdout.trim();

async function repository(root: string, name: string, files: Record<string, string>, links: Record<string, string> = {}): Promise<{ dir: string; head: string }> {
  const dir = join(root, name);
  await mkdir(dir, { recursive: true });
  await execFileAsync("git", ["init", "--quiet", "--initial-branch=main", dir], { env: gitEnv });
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(dir, path)), { recursive: true });
    await writeFile(join(dir, path), text, "utf8");
  }
  for (const [path, target] of Object.entries(links)) await symlink(target, join(dir, path));
  await git(dir, "add", "-A");
  await git(dir, "commit", "--quiet", "-m", "init");
  return { dir, head: await git(dir, "rev-parse", "HEAD") };
}

const META_FILES = {
  "AGENTS.md": "# team rules\n",
  ".kiro/steering/product.md": "---\ninclusion: always\n---\nproduct\n",
  ".kiro/steering/oncall.md": "oncall\n",
  ".agents/skills/build/SKILL.md": "---\nname: build\n---\n",
  "services/search/AGENTS.md": "# search rules\n",
  "services/search/src/big.bin": "x".repeat(10_000),
  "src/app.py": "print('code')\n",
  "docs/unrelated.md": "not knowledge\n",
};

async function fixture(options: { files?: Record<string, string>; links?: Record<string, string> } = {}) {
  const root = await mkdtemp(join(tmpdir(), "meta-checkout-"));
  const meta = await repository(root, "meta-source", options.files ?? META_FILES, options.links);
  const code = await repository(root, "api-source", { "README.md": "# api\n" });
  const project: ProjectDefinition = {
    name: "payments", revision: 1,
    repositories: [
      { name: "api", url: "https://github.com/acme/api.git", path: "repo/api", defaultBranch: "main", credentialRef: "github-app", role: "code" },
      { name: "service-meta", url: "https://github.com/acme/service-meta.git", path: "repo/service-meta", defaultBranch: "main", credentialRef: "github-app", role: "meta" },
    ],
    setup: [], readiness: [], orchestratorInstructions: "Delegate all code changes to the remote worker.",
  };
  const cloned: string[] = [];
  const materializer: RepositoryMaterializer = async (repo, target) => {
    cloned.push(repo.name);
    const source = repo.name === "service-meta" ? meta.dir : code.dir;
    await execFileAsync("git", ["clone", "--quiet", "--no-checkout", pathToFileURL(source).href, target], { env: gitEnv });
  };
  const workspace = () => mkdtemp(join(root, "ws-"));
  const metaRequest = { repository: { name: "service-meta", url: "https://github.com/acme/service-meta.git", path: "repo/service-meta", defaultBranch: "main", credentialRef: "github-app" }, paths: [".kiro/steering", ".agents/skills", "AGENTS.md"] };
  // What a worker is sent: the project without the pure meta repository.
  const workerProject = StoredProjectDefinitionSchema.parse({ ...project, repositories: [{ name: "api", url: project.repositories[0]!.url, path: "repo/api", defaultBranch: "main", credentialRef: "github-app" }] });
  return { root, meta, code, project, workerProject, cloned, materializer, workspace, metaRequest };
}

describe("the meta repository in the workspace", () => {
  it("materializes only the knowledge paths and the nested rule files, at the default branch's head", async () => {
    const f = await fixture();
    const rootPath = await f.workspace();
    const manifest = await prepareWorkspace({ rootPath, project: f.workerProject, readOnly: true, materializer: f.materializer, meta: f.metaRequest });
    expect(manifest.complete).toBe(true);
    expect(f.cloned).toEqual(["api", "service-meta"]);
    expect(await listMaterialized(join(rootPath, "repo/service-meta"))).toEqual([
      ".agents/skills/build/SKILL.md", ".kiro/steering/oncall.md", ".kiro/steering/product.md", "AGENTS.md", "services/search/AGENTS.md",
    ]);
    expect(manifest.meta).toMatchObject({ name: "service-meta", path: "repo/service-meta", resolvedCommit: f.meta.head, files: 5, skipped: 0 });
    expect(await readFile(join(rootPath, "repo/service-meta/AGENTS.md"), "utf8")).toBe("# team rules\n");
  });

  it("reports the commit as knowledgeCommit and leaves the code repositories' base commits alone", async () => {
    const f = await fixture();
    const manifest = await prepareWorkspace({ rootPath: await f.workspace(), project: f.workerProject, readOnly: true, materializer: f.materializer, meta: f.metaRequest });
    const result = preparedBaseResult(manifest);
    expect(result.preparedBase).toEqual([{ repositoryId: "api", baseCommitSha: f.code.head }]);
    expect(result.knowledgeCommit).toBe(f.meta.head);
  });

  it("pins the commit it first resolved: a push to the meta repo later does not move a prepared workspace", async () => {
    const f = await fixture();
    const rootPath = await f.workspace();
    const first = await prepareWorkspace({ rootPath, project: f.workerProject, readOnly: true, materializer: f.materializer, meta: f.metaRequest });
    await writeFile(join(f.meta.dir, "AGENTS.md"), "# changed\n", "utf8");
    await git(f.meta.dir, "commit", "--quiet", "-am", "later");
    const again = await prepareWorkspace({ rootPath, project: f.workerProject, readOnly: true, materializer: f.materializer, meta: f.metaRequest });
    expect(again.meta?.resolvedCommit).toBe(first.meta?.resolvedCommit);
    expect(await readFile(join(rootPath, "repo/service-meta/AGENTS.md"), "utf8")).toBe("# team rules\n");
  });

  it("makes the files read-only", async () => {
    const f = await fixture();
    const rootPath = await f.workspace();
    await prepareWorkspace({ rootPath, project: f.workerProject, readOnly: true, materializer: f.materializer, meta: f.metaRequest });
    for (const path of ["AGENTS.md", ".kiro/steering/product.md", "services/search/AGENTS.md"]) {
      expect((await stat(join(rootPath, "repo/service-meta", path))).mode & 0o222, path).toBe(0);
    }
    const refusal = await writeFile(join(rootPath, "repo/service-meta/AGENTS.md"), "x").then(() => "written", (error: NodeJS.ErrnoException) => error.code);
    expect(["EACCES", "EPERM"]).toContain(refusal);
  });

  it("does nothing about a meta repo when none is asked for, and writes no meta entry in the manifest", async () => {
    const f = await fixture();
    const manifest = await prepareWorkspace({ rootPath: await f.workspace(), project: f.workerProject, readOnly: true, materializer: f.materializer });
    expect(manifest.meta).toBeUndefined();
    expect(f.cloned).toEqual(["api"]);
    expect(preparedBaseResult(manifest)).not.toHaveProperty("knowledgeCommit");
  });

  it("does not follow a symbolic link or a submodule among the chosen paths, and counts them", async () => {
    const f = await fixture({ files: { "AGENTS.md": "# rules\n", ".kiro/steering/a.md": "a\n" }, links: { ".kiro/steering/evil.md": "/etc/passwd" } });
    const rootPath = await f.workspace();
    const manifest = await prepareWorkspace({ rootPath, project: f.workerProject, readOnly: true, materializer: f.materializer, meta: f.metaRequest });
    expect(await listMaterialized(join(rootPath, "repo/service-meta"))).toEqual([".kiro/steering/a.md", "AGENTS.md"]);
    expect(manifest.meta).toMatchObject({ files: 2, skipped: 1 });
  });

  it("refuses a meta repo with more knowledge files than the cap, with a fixed message", async () => {
    const files: Record<string, string> = { "AGENTS.md": "x\n" };
    for (let i = 0; i <= META_CHECKOUT_MAX_FILES; i += 1) files[`.kiro/steering/f${String(i)}.md`] = "x";
    const f = await fixture({ files });
    await expect(prepareWorkspace({ rootPath: await f.workspace(), project: f.workerProject, readOnly: true, materializer: f.materializer, meta: f.metaRequest }))
      .rejects.toThrow("the meta repo cannot be read: too many files");
  });

  it("refuses a meta repo whose knowledge is larger than the byte cap", async () => {
    const f = await fixture({ files: { "AGENTS.md": "x\n", ".kiro/steering/huge.md": "y".repeat(17 * 1024 * 1024) } });
    await expect(prepareWorkspace({ rootPath: await f.workspace(), project: f.workerProject, readOnly: true, materializer: f.materializer, meta: f.metaRequest }))
      .rejects.toThrow("the meta repo cannot be read: too large");
  });

  it("fails the preparation, and records the failure, when the meta repo cannot be cloned", async () => {
    const f = await fixture();
    const rootPath = await f.workspace();
    const failing: RepositoryMaterializer = async (repo, target, credential) => {
      if (repo.name === "service-meta") throw new Error("fatal: Authentication failed for 'https://x-access-token:ghs_leaked@github.com/acme/service-meta.git'");
      return f.materializer(repo, target, credential);
    };
    await expect(prepareWorkspace({ rootPath, project: f.workerProject, readOnly: true, materializer: failing, meta: f.metaRequest })).rejects.toThrow();
    const manifest = JSON.parse(await readFile(join(rootPath, ".agentx/preparation-manifest.json"), "utf8")) as { complete: boolean; failure?: string };
    expect(manifest.complete).toBe(false);
    expect(manifest.failure).not.toContain("ghs_leaked");
  });

  it("starts again from a folder an interrupted attempt left, instead of trusting it", async () => {
    const f = await fixture();
    const rootPath = await f.workspace();
    await mkdir(join(rootPath, "repo/service-meta"), { recursive: true });
    await writeFile(join(rootPath, "repo/service-meta/AGENTS.md"), "# tampered\n", "utf8");
    const manifest = await prepareWorkspace({ rootPath, project: f.workerProject, readOnly: true, materializer: f.materializer, meta: f.metaRequest });
    expect(manifest.meta?.resolvedCommit).toBe(f.meta.head);
    expect(await readFile(join(rootPath, "repo/service-meta/AGENTS.md"), "utf8")).toBe("# team rules\n");
  });

  it("refuses a meta repository that shares a name or folder with one of the project's repositories", async () => {
    const f = await fixture();
    for (const repositoryOverride of [{ path: "repo/api/meta" }, { path: "repo/api" }, { name: "api" }, { path: "repo" }]) {
      const clash = { ...f.metaRequest, repository: { ...f.metaRequest.repository, ...repositoryOverride } };
      await expect(prepareWorkspace({ rootPath: await f.workspace(), project: f.workerProject, readOnly: true, materializer: f.materializer, meta: clash }), JSON.stringify(repositoryOverride)).rejects.toThrow("also another repository's");
    }
  });

  it("treats a chosen path as a literal name, never as a pattern that could take other files", async () => {
    const f = await fixture({ files: { "AGENTS.md": "# rules\n", ".kiro/steering/[x].md": "literal\n", ".kiro/steering/x.md": "sibling\n" } });
    const rootPath = await f.workspace();
    await prepareWorkspace({ rootPath, project: f.workerProject, readOnly: true, materializer: f.materializer, meta: { ...f.metaRequest, paths: [".kiro/steering/[x].md", "AGENTS.md"] } });
    expect(await listMaterialized(join(rootPath, "repo/service-meta"))).toEqual([".kiro/steering/[x].md", "AGENTS.md"]);
  });

  it("matches paths by folder and by name, never by prefix of a name", () => {
    const chosen = [".kiro/steering", "AGENTS.md"];
    expect(metaPathWanted(".kiro/steering/a.md", chosen)).toBe(true);
    expect(metaPathWanted(".kiro/steering-old/a.md", chosen)).toBe(false);
    expect(metaPathWanted("AGENTS.md", chosen)).toBe(true);
    expect(metaPathWanted("a/b/CLAUDE.md", chosen)).toBe(true);
    expect(metaPathWanted("a/b/NOTAGENTS.md", chosen)).toBe(false);
    expect(metaPathWanted("src/app.py", chosen)).toBe(false);
  });

  it("reads a tree listing with odd names, and drops a line it cannot read", () => {
    const listing = ["100644 blob aaaa      12\tdocs/a b.md", "100644 blob bbbb       3\tweird\nname.md", "garbage", "120000 blob cccc       4\tlink"].join("\0");
    expect(parseTreeListing(listing).map((entry) => entry.path)).toEqual(["docs/a b.md", "weird\nname.md", "link"]);
  });
});

describe("the contract and the delivery guard", () => {
  const request = { repository: { name: "service-meta", url: "https://github.com/acme/service-meta.git", path: "repo/service-meta", defaultBranch: "main", credentialRef: "github-app" }, paths: [".kiro/steering"] };

  it("accepts a well-formed request and refuses a path out of the repo, a duplicate, an empty list, a URL with a password and an unknown key", () => {
    expect(PrepareMetaSchema.safeParse(request).success).toBe(true);
    expect(PrepareMetaSchema.safeParse({ ...request, paths: ["../x"] }).success).toBe(false);
    expect(PrepareMetaSchema.safeParse({ ...request, paths: [".git/config"] }).success).toBe(false);
    expect(PrepareMetaSchema.safeParse({ ...request, paths: ["a", "a"] }).success).toBe(false);
    expect(PrepareMetaSchema.safeParse({ ...request, paths: [] }).success).toBe(false);
    expect(PrepareMetaSchema.safeParse({ ...request, repository: { ...request.repository, url: "https://u:p@github.com/a/b.git" } }).success).toBe(false);
    expect(PrepareMetaSchema.safeParse({ ...request, token: "x" }).success).toBe(false);
  });

  it("is part of the prepare invocation, which a worker without the field would refuse (strict), so only a worker that lists the feature is sent it", () => {
    const base = { protocolVersion: 1, operationId: "0b9f4c1e-6a56-4a52-8a8e-2f3a8d9a8c11", workspaceId: "1b9f4c1e-6a56-4a52-8a8e-2f3a8d9a8c11", fence: 1, projectRevision: 1, callbackCapability: "c".repeat(40), kind: "prepare" };
    const project = { name: "payments", revision: 1, repositories: [{ name: "api", url: "https://github.com/acme/api.git", path: "repo/api", defaultBranch: "main", credentialRef: "github-app" }], setup: [], readiness: [], orchestratorInstructions: "x" };
    expect(WorkerInvocationSchema.safeParse({ ...base, payload: { project, repositoryGrant: "g", meta: request } }).success).toBe(true);
    expect(WorkerInvocationSchema.safeParse({ ...base, payload: { project, repositoryGrant: "g" } }).success).toBe(true);
    expect(WorkerInvocationSchema.safeParse({ ...base, payload: { project, repositoryGrant: "g", meta: { ...request, paths: [] } } }).success).toBe(false);
  });

  it("takes a knowledge commit only when it is a full hash", () => {
    expect(parseKnowledgeCommit({ knowledgeCommit: "a".repeat(40) })).toBe("a".repeat(40));
    expect(parseKnowledgeCommit({ knowledgeCommit: "a".repeat(64) })).toBe("a".repeat(64));
    for (const bad of ["abc123", "A".repeat(40), "main", 5, null, undefined]) expect(parseKnowledgeCommit({ knowledgeCommit: bad })).toBeUndefined();
    expect(parseKnowledgeCommit(null)).toBeUndefined();
    expect(parseKnowledgeCommit("a".repeat(40))).toBeUndefined();
  });

  it("is advertised by the worker that implements it", () => {
    expect(WORKER_IMPLEMENTED_FEATURES).toContain(META_PREPARE_FEATURE);
  });

  const separate = StoredProjectDefinitionSchema.parse({
    name: "payments", revision: 1, setup: [], readiness: [], orchestratorInstructions: "x",
    repositories: [
      { name: "api", url: "https://github.com/acme/api.git", path: "repo/api", defaultBranch: "main", credentialRef: "github-app" },
      { name: "service-meta", url: "https://github.com/acme/service-meta.git", path: "repo/service-meta", defaultBranch: "main", credentialRef: "github-app", role: "meta" },
    ],
  });

  it("builds the prepare fields for a project with a separate meta repo, only for a worker that lists the feature", () => {
    const fields = metaPrepareFields(separate, [META_PREPARE_FEATURE]);
    expect(fields).toMatchObject({ meta: { repository: { name: "service-meta", defaultBranch: "main" } } });
    expect(fields.meta?.paths).toEqual(expect.arrayContaining([".kiro/steering", ".agents/skills", ".kiro/specs", "AGENTS.md", ".rovara"]));
    expect(PrepareMetaSchema.safeParse(fields.meta).success).toBe(true);
    // An older worker is sent nothing (its strict schema would refuse the field), and the caller refuses the task start with a clear message instead of running without the team's rules.
    expect(metaPrepareFields(separate, [])).toEqual({});
    expect(metaPrepareProblem(separate, [])).toBe("This project's meta repo needs a newer worker. Ask an admin to upgrade Rovara.");
    expect(metaPrepareProblem(separate, [META_PREPARE_FEATURE])).toBeUndefined();
  });

  it("sends the credential no more than the repository entry needs, and never the pins", () => {
    const withPins = StoredProjectDefinitionSchema.parse({ ...separate, repositories: separate.repositories.map((entry) => ({ ...entry, installationId: 5, githubRepositoryId: 9 })) });
    expect(JSON.stringify(metaPrepareFields(withPins, [META_PREPARE_FEATURE]))).not.toMatch(/installationId|githubRepositoryId|alsoCode|role/);
  });

  it("asks for nothing when the project has no meta repo, or the meta repo is its own code (it is cloned as code already)", () => {
    const plain = StoredProjectDefinitionSchema.parse({ ...separate, repositories: [separate.repositories[0]] });
    expect(metaPrepareFields(plain, [META_PREPARE_FEATURE])).toEqual({});
    expect(metaPrepareProblem(plain, [])).toBeUndefined();
    const self = StoredProjectDefinitionSchema.parse({ ...separate, repositories: [{ ...separate.repositories[1], role: "meta", alsoCode: true }] });
    expect(metaPrepareFields(self, [META_PREPARE_FEATURE])).toEqual({});
    expect(metaPrepareProblem(self, [])).toBeUndefined();
  });

  it("uses the knowledge paths a config names instead of the defaults", () => {
    const fields = metaPrepareFields(separate, [META_PREPARE_FEATURE], { steering: ["docs/rules"], skills: [], specs: ["specs"], runbooks: [], keyDocs: ["ARCHITECTURE.md"] });
    expect(fields.meta?.paths).toEqual(expect.arrayContaining(["docs/rules", "specs", "ARCHITECTURE.md", "AGENTS.md"]));
    expect(fields.meta?.paths).not.toContain(".kiro/steering");
  });
});
