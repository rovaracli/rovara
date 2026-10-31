// Meta repo lane A, task A2: a project that starts from a meta repo, and the meta repo's config file imported as a pending change a maintainer applies.
// The file is the source of truth, never applied by a push; a value a person typed is never replaced unless that person names it; the settings a file manages are
// read-only in the settings save. Each case fails when the rule it names is removed (the lane report lists the mutations run).
import { randomUUID } from "node:crypto";
import { TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it, vi } from "vitest";
import { AgentXError } from "@agentx/contracts";
import {
  ProjectDefinitionSchema,
  StoredProjectDefinitionSchema,
  githubInstallationKey,
  githubRepoProjectKey,
  orgProjectCatalogKey,
  parseCommandLine,
  projectCreateRequestKey,
  projectMetaKey,
  projectRevisionKey,
  type OrgId,
  type ProjectRole,
} from "../../packages/contracts/src/index.js";
import { parseMetaConfigFile, planMetaConfigChange, githubFullName } from "../../packages/broker/src/meta-repo/config-plan.js";
import {
  applyMetaConfigChange,
  checkMetaConfigNow,
  dismissMetaConfigChange,
  metaConfigPendingKey,
  queueMetaConfigImport,
  readMetaConfigState,
  routeMetaConfig,
  type MetaConfigCaller,
  type MetaConfigDependencies,
} from "../../packages/broker/src/meta-repo/config-import.js";
import { createProjectFromMeta, createProjectFromMetaRoute, type CreateFromMetaDependencies } from "../../packages/broker/src/org/create-from-meta.js";
import { deliverGithubTriggerEvents, githubMetaPushes } from "../../packages/broker/src/triggers/github-events.js";
import { GithubWebhookRetryableError } from "../../packages/broker/src/aws/github-webhooks.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { TEST_ORG } from "../support/orgs.js";

const ORG: OrgId = TEST_ORG;
const BINDING = { deploymentMode: "ec2-ebs", launchTemplateId: "lt-0123456789abcdef0", subnets: [{ availabilityZone: "us-west-2a", subnetId: "subnet-0123456789abcdef0" }], volumeSizeGiB: 20, volumeType: "gp3" } as const;
const COMMIT_A = "a".repeat(40);
const COMMIT_B = "b".repeat(40);
const MAINTAINER: MetaConfigCaller = { developerId: "dev-maintainer", orgId: ORG, orgRole: "admin" };
const CONTRIBUTOR: MetaConfigCaller = { developerId: "dev-contributor", orgId: ORG, orgRole: "member" };
const STRANGER: MetaConfigCaller = { developerId: "dev-stranger", orgId: ORG, orgRole: "member" };

const repo = (name: string, extra: Record<string, unknown> = {}) => ({
  name, url: `https://github.com/acme/${name}.git`, path: `repo/${name}`, defaultBranch: "main", credentialRef: "github-app", installationId: 55, githubRepositoryId: 100 + name.length, ...extra,
});
const command = (line: string, cwd: string, timeout = 900) => parseCommandLine(line, cwd, timeout);
const definition = (repositories: unknown[], extra: Record<string, unknown> = {}, revision = 1) => ({
  name: "payments", revision, repositories, setup: [], readiness: [], orchestratorInstructions: "Delegate work.", ...extra,
});
const separate = (extra: Record<string, unknown> = {}) => definition([repo("api", { role: "code" }), repo("web"), repo("service-meta", { role: "meta" })], extra);
const selfMeta = (extra: Record<string, unknown> = {}) => definition([repo("app", { role: "meta", alsoCode: true })], extra);
const stored = (value: unknown) => StoredProjectDefinitionSchema.parse(value);
const yaml = (text: string) => { const parsed = parseMetaConfigFile(".rovara/project.yaml", text); if (!parsed.ok) throw new Error(`config did not parse: ${JSON.stringify(parsed.problems)}`); return parsed.config; };

describe("reading a config file", () => {
  it("reads YAML, and JSON by its extension", () => {
    expect(parseMetaConfigFile(".rovara/project.yaml", "version: 1\nsetup:\n  api:\n    - npm ci\n")).toMatchObject({ ok: true, config: { setup: { api: ["npm ci"] } } });
    expect(parseMetaConfigFile(".rovara/project.yml", "version: 1\n")).toMatchObject({ ok: true });
    expect(parseMetaConfigFile(".rovara/project.json", '{"version":1,"setup":{"api":["npm ci"]}}')).toMatchObject({ ok: true });
    expect(parseMetaConfigFile(".rovara/project.json", "version: 1")).toMatchObject({ ok: false });
  });

  it("answers a fixed sentence for text that is not YAML, never a quote of the file", () => {
    const parsed = parseMetaConfigFile(".rovara/project.yaml", "version: 1\npassword: hunter2-secret\n  bad: [unclosed");
    expect(parsed).toEqual({ ok: false, problems: [{ path: "(file)", message: "the file is not valid YAML" }] });
  });

  it("refuses a file over the size limit unread", () => {
    expect(parseMetaConfigFile(".rovara/project.yaml", `version: 1\n# ${"x".repeat(262_144)}`)).toMatchObject({ ok: false });
  });

  it("refuses an alias expansion (YAML's billion-laughs shape), merge keys, duplicate keys and a second document", () => {
    const aliases = `version: 1\nsetup:\n  api: &a [x]\n  b: [${Array.from({ length: 30 }, () => "*a").join(", ")}]\n`;
    expect(parseMetaConfigFile(".rovara/project.yaml", aliases)).toMatchObject({ ok: false });
    expect(parseMetaConfigFile(".rovara/project.yaml", "base: &b {x: 1}\nversion: 1\n<<: *b\n")).toMatchObject({ ok: false });
    expect(parseMetaConfigFile(".rovara/project.yaml", "version: 1\nversion: 1\n")).toMatchObject({ ok: false });
    expect(parseMetaConfigFile(".rovara/project.yaml", "version: 1\n---\nversion: 1\n")).toMatchObject({ ok: false });
  });

  it("refuses a setting this release does not know, and names where, not what", () => {
    const parsed = parseMetaConfigFile(".rovara/project.yaml", "version: 1\ncredentials:\n  token: s3cr3t-value\n");
    expect(parsed.ok).toBe(false);
    expect(JSON.stringify(parsed)).not.toContain("s3cr3t");
  });
});

describe("planning what a config file changes", () => {
  it("lists each repository's commands, run in that repository's folder, and the test commands as the project's readiness", () => {
    const plan = planMetaConfigChange({
      config: yaml("version: 1\nsetup:\n  api: [npm ci, npm run build]\n  web: [npm ci]\ntests:\n  api:\n    commands: [npm test]\n"),
      definition: stored(separate()),
    });
    expect(plan.problems).toEqual([]);
    expect(plan.items.map((item) => item.id)).toEqual(["setup", "readiness"]);
    expect(plan.items[0]).toMatchObject({ kind: "set_commands", before: [], after: ["api: npm ci", "api: npm run build", "web: npm ci"] });
    expect(plan.items[1]).toMatchObject({ after: ["api: npm test"] });
  });

  it("plans nothing when the project already has what the file says", () => {
    const plan = planMetaConfigChange({ config: yaml("version: 1\nsetup:\n  api: [npm ci]\n"), definition: stored(separate({ setup: [command("npm ci", "repo/api")] })) });
    expect(plan.items).toEqual([]);
  });

  it("leaves alone a field the file does not mention", () => {
    const plan = planMetaConfigChange({ config: yaml("version: 1\nsetup:\n  api: [npm ci]\n"), definition: stored(separate({ readiness: [command("npm test", "repo/api", 1800)] })) });
    expect(plan.items.map((item) => item.id)).toEqual(["setup"]);
  });

  it("flags a value a person typed that differs, but not an empty one, one the file set before, or one an agent set", () => {
    const config = yaml("version: 1\nsetup:\n  api: [npm ci]\n");
    const typed = stored(separate({ setup: [command("make setup", "repo/api")] }));
    expect(planMetaConfigChange({ config, definition: typed }).items[0]).toMatchObject({ id: "setup", conflict: "person_value", before: ["api: make setup"] });
    expect(planMetaConfigChange({ config, definition: stored(separate()) }).items[0]!.conflict).toBeUndefined();
    expect(planMetaConfigChange({ config, definition: stored(separate({ setup: [command("make setup", "repo/api")], origins: { setup: "file" } })) }).items[0]!.conflict).toBeUndefined();
    expect(planMetaConfigChange({ config, definition: stored(separate({ setup: [command("make setup", "repo/api")], origins: { setup: "agent" } })) }).items[0]!.conflict).toBeUndefined();
  });

  it("adds a repository the file lists, matching an existing one by its GitHub name whatever its case, and never removes without a confirmation", () => {
    const plan = planMetaConfigChange({
      config: yaml("version: 1\nrepositories:\n  - {name: lib, url: 'https://github.com/Acme/lib.git'}\n  - {name: api, url: 'https://github.com/ACME/API'}\n"),
      definition: stored(separate()),
    });
    expect(plan.problems).toEqual([]);
    expect(plan.items.map((item) => `${item.id}${item.needsConfirmation === true ? "*" : ""}${item.blocked === undefined ? "" : `!${item.blocked}`}`)).toEqual(["repositories:add:lib", "repositories:remove:web*"]);
  });

  it("blocks adding a repository on another host, a name that is taken, and any addition to a project whose one repository is its own meta repo", () => {
    const config = yaml("version: 1\nrepositories:\n  - {name: gitlabrepo, url: 'https://gitlab.com/acme/x.git'}\n  - {name: web, url: 'https://github.com/acme/other-web.git'}\n");
    const plan = planMetaConfigChange({ config, definition: stored(separate()) });
    expect(plan.items.filter((item) => item.kind === "add_repository").map((item) => item.blocked)).toEqual(["unsupported_host", "invalid"]);
    const self = planMetaConfigChange({ config: yaml("version: 1\nrepositories:\n  - {name: lib, url: 'https://github.com/acme/lib.git'}\n"), definition: stored(selfMeta()) });
    expect(self.items).toMatchObject([{ id: "repositories:add:lib", blocked: "self_meta_project" }]);
    // A project that is its own meta repo is never asked to remove its only repository.
    expect(self.items.some((item) => item.kind === "remove_repository")).toBe(false);
  });

  it("runs an added repository's commands in its folder repo/<name>, and shows that folder in the plan", () => {
    const plan = planMetaConfigChange({ config: yaml("version: 1\nrepositories:\n  - {name: lib, url: 'https://github.com/acme/lib.git'}\nsetup:\n  lib: [make]\n"), definition: stored(separate()) });
    expect(plan.problems).toEqual([]);
    expect(plan.items.find((item) => item.id === "setup")).toMatchObject({ after: ["lib: make"] });
    expect(plan.items.find((item) => item.id === "repositories:add:lib")).toMatchObject({ path: "repo/lib" });
  });

  it("reports a command that cannot be read, a repository the project does not have, and commands for the meta repository that holds no code", () => {
    const plan = planMetaConfigChange({
      config: yaml("version: 1\nsetup:\n  api: ['npm ci && npm test']\n  ghost: [x]\n  service-meta: [y]\ntests:\n  web:\n    commands: ['\"unclosed']\n"),
      definition: stored(separate()),
    });
    const paths = plan.problems.map((problem) => problem.path).sort();
    expect(paths).toContain("setup.api.0");
    expect(paths).toContain("setup.ghost");
    expect(paths).toContain("setup.service-meta");
    expect(paths).toContain("tests.web.commands.0");
    expect(plan.items.some((item) => item.id === "setup")).toBe(false);
    expect(JSON.stringify(plan.problems)).not.toContain("npm test");
  });

  it("lets a file with no repositories section name the project's own repositories", () => {
    const plan = planMetaConfigChange({ config: yaml("version: 1\nsetup:\n  web: [npm ci]\n"), definition: stored(separate()) });
    expect(plan.problems).toEqual([]);
  });

  it("plans for a repository called constructor (a name every record has on its prototype), reading only the file's own entries", () => {
    const def = stored(definition([repo("constructor", { role: "code" }), repo("service-meta", { role: "meta" })]));
    const none = planMetaConfigChange({ config: yaml("version: 1\nsetup:\n  other: [x]\n"), definition: def });
    expect(none.problems.map((problem) => problem.path)).toEqual(["setup.other"]);
    expect(planMetaConfigChange({ config: yaml("version: 1\nsetup:\n  constructor: [make]\n"), definition: def }).items[0]).toMatchObject({ id: "setup", after: ["constructor: make"] });
    expect(() => planMetaConfigChange({ config: yaml("version: 1\ntests:\n  api:\n    commands: [t]\n"), definition: def })).not.toThrow();
    expect(() => planMetaConfigChange({ config: yaml("version: 1\n"), definition: def })).not.toThrow();
  });

  it("refuses a __proto__ key anywhere, instead of reading it as an empty section that would wipe the project's commands", () => {
    expect(parseMetaConfigFile(".rovara/project.json", '{"version":1,"setup":{"__proto__":["x"]}}')).toEqual({ ok: false, problems: [{ path: "(file)", message: "has a reserved key" }] });
    expect(parseMetaConfigFile(".rovara/project.yaml", "version: 1\ntests:\n  api:\n    __proto__: {commands: [x]}\n")).toMatchObject({ ok: false });
    expect(parseMetaConfigFile(".rovara/project.yaml", "version: 1\nsetup:\n  constructor: [x]\n")).toMatchObject({ ok: true });
  });

  it("refuses a repository folder the file chooses: only repo/<name>, never a reserved or dot folder", () => {
    for (const path of [".agentx/web", ".devcontainer/x", "tools/lib", "repo/other", "repo/lib/sub", "/abs", "../x"]) {
      expect(parseMetaConfigFile(".rovara/project.yaml", `version: 1\nrepositories:\n  - {name: lib, url: 'https://github.com/acme/lib.git', path: '${path}'}\n`), path).toMatchObject({ ok: false });
    }
    expect(parseMetaConfigFile(".rovara/project.yaml", "version: 1\nrepositories:\n  - {name: lib, url: 'https://github.com/acme/lib.git', path: repo/lib}\n")).toMatchObject({ ok: true });
  });

  it("says how many of a person's commands the file removes", () => {
    const plan = planMetaConfigChange({ config: yaml("version: 1\nsetup:\n  api: [one]\n"), definition: stored(separate({ setup: [command("a", "repo/api"), command("b", "repo/api"), command("c", "repo/web")], origins: { setup: "file" } })) });
    expect(plan.items[0]).toMatchObject({ id: "setup", removes: 2 });
  });

  it("lists the sections it carries but does not apply, and refuses a project with no meta repository", () => {
    const plan = planMetaConfigChange({ config: yaml("version: 1\nchecks:\n  - {name: Lint, repo: api, command: npm run lint}\nsources:\n  - {connection: wiki}\n"), definition: stored(separate()) });
    expect(plan.deferred).toEqual(["checks", "sources"]);
    expect(plan.items).toEqual([]);
    expect(planMetaConfigChange({ config: yaml("version: 1\n"), definition: stored(definition([repo("api")])) }).problems).toEqual([{ path: "(project)", message: "this project has no meta repository" }]);
  });

  it("plans the spec target the file names (K1 lane D), as lines the maintainer reads, and nothing when the project already has it", () => {
    const config = yaml("version: 1\nspecTarget: {format: speckit, when: always}\n");
    const plan = planMetaConfigChange({ config, definition: stored(separate()) });
    expect(plan.deferred).toEqual([]);
    expect(plan.items).toEqual([{ id: "specTarget", field: "specTarget", kind: "set_spec_target", before: [], after: ['where: "meta_repo"', 'format: "speckit"', 'when: "always"', 'linkStyle: "together"'] }]);
    const have = stored(separate({ specTarget: { where: "meta_repo", format: "speckit", when: "always", linkStyle: "together" } }));
    expect(planMetaConfigChange({ config, definition: have }).items).toEqual([]);
  });

  it("refuses a spec target with an unsafe folder, an unknown key, or a template folder for a format that reads none", () => {
    for (const target of ["{pathTemplate: ../../etc}", "{pathTemplate: .git/hooks}", "{surprise: 1}", "{format: kiro, templatePath: tpl}", "{format: team_template}"]) {
      expect(parseMetaConfigFile(".rovara/project.yaml", `version: 1\nspecTarget: ${target}\n`).ok, target).toBe(false);
    }
  });

  it("knows a GitHub repository by its owner and name only", () => {
    expect(githubFullName("https://github.com/Acme/Api.git")).toBe("acme/api");
    expect(githubFullName("https://github.com/acme/api/")).toBe("acme/api");
    expect(githubFullName("https://gitlab.com/acme/api")).toBeUndefined();
    expect(githubFullName("http://github.com/acme/api")).toBeUndefined();
    expect(githubFullName("https://github.com/acme")).toBeUndefined();
  });
});

// ---- the broker side, over an in-memory table

const PROJECT = "payments";
interface World {
  db: FakeDynamoDb;
  files: Map<string, string>;
  deps: MetaConfigDependencies;
  now: { value: number };
  roles: Map<string, ProjectRole>;
  registered: number[];
  readMetaFile: ReturnType<typeof vi.fn>;
  /** The meta repo's default-branch head as GitHub says; `push` moves it. */
  head: { value: string; reads: number; moveAfterReads?: { reads: number; to: string } };
  connectedCalls: string[];
}

function seedRevision(db: FakeDynamoDb, def: Record<string, unknown>, extra: Record<string, unknown> = {}): void {
  const revision = def.revision as number;
  db.set({ ...projectRevisionKey(ORG, PROJECT, revision), entityType: "PROJECT", registeredBy: "seed", registeredAt: "2026-10-01T00:00:00.000Z", runtimeBinding: BINDING, definition: def, ...extra });
  db.set({ ...orgProjectCatalogKey(ORG, PROJECT), entityType: "PROJECT_CATALOG", name: PROJECT, latestRevision: revision, firstRegisteredAt: "2026-10-01T00:00:00.000Z" });
  db.set({ ...projectMetaKey(ORG, PROJECT), entityType: "PROJECT_META", name: PROJECT, status: "active", createdAt: "2026-10-02T00:00:00.000Z", createdBy: "seed" });
}

function world(def: Record<string, unknown> = separate(), options: { cloud?: boolean; archived?: boolean } = {}): World {
  const db = new FakeDynamoDb();
  seedRevision(db, def);
  if (options.archived === true) db.set({ ...projectMetaKey(ORG, PROJECT), entityType: "PROJECT_META", name: PROJECT, status: "archived", createdAt: "2026-10-02T00:00:00.000Z", createdBy: "seed" });
  const files = new Map<string, string>();
  const now = { value: Date.parse("2026-10-30T10:00:00.000Z") };
  const roles = new Map<string, ProjectRole>([[MAINTAINER.developerId, "maintainer"], [CONTRIBUTOR.developerId, "contributor"]]);
  const registered: number[] = [];
  const connectedCalls: string[] = [];
  const readMetaFile = vi.fn(async (input: { commit: string; path: string }) => files.get(`${input.commit}:${input.path}`));
  const head: World["head"] = { value: COMMIT_A, reads: 0 };
  const deps: MetaConfigDependencies = {
    documentClient: db, tableName: "state", now: () => now.value, log: () => undefined, cloud: options.cloud ?? true,
    effectiveRole: async (caller) => roles.get(caller.developerId),
    readMetaFile: readMetaFile,
    getHead: async () => { head.reads += 1; if (head.moveAfterReads !== undefined && head.reads > head.moveAfterReads.reads) head.value = head.moveAfterReads.to; return head.value; },
    githubCredentialRef: "github-app",
    requireRepositoryConnected: async (_org, owner, name) => { connectedCalls.push(`${owner}/${name}`); return { installationId: 55, githubRepositoryId: 900 }; },
    repositoryIdentity: async (url) => { const [owner, name] = new URL(url).pathname.replace(/\.git$/, "").split("/").filter(Boolean) as [string, string]; return { fullName: `${owner}/${name}`, defaultBranch: "trunk", repositoryId: 900 }; },
    // What the broker's registration does for a settings save: the next revision, in one transaction with the caller's own items.
    registerRevision: async (actor, input, extraItems) => {
      const parsed = ProjectDefinitionSchema.parse(input.definition);
      await db.send(new TransactWriteCommand({ TransactItems: [
        { Put: { TableName: "state", Item: { ...projectRevisionKey(actor.orgId, parsed.name, parsed.revision), entityType: "PROJECT", registeredBy: actor.ownerKey, registeredAt: "2026-10-30T10:00:00.000Z", runtimeBinding: input.runtimeBinding, definition: parsed }, ConditionExpression: "attribute_not_exists(pk)" } },
        ...(extraItems ?? []),
      ] }));
      registered.push(parsed.revision);
    },
  };
  return { db, files, deps, now, roles, registered, readMetaFile, head, connectedCalls };
}
/** A push to the default branch: the branch now points at `commit` (whose file is `text`), and Rovara is told. */
const push = (w: World, commit: string, text: string | undefined, _unused?: number, path = ".rovara/project.yaml") => {
  if (text !== undefined) w.files.set(`${commit}:${path}`, text);
  w.head.value = commit;
  return queueMetaConfigImport(w.deps, { orgId: ORG, project: PROJECT, commit });
};
const pending = (w: World) => w.db.get(metaConfigPendingKey(ORG, PROJECT)) as Record<string, unknown> | undefined;
const latestDefinition = (w: World, revision: number) => (w.db.get(projectRevisionKey(ORG, PROJECT, revision)) as { definition: Record<string, unknown> } | undefined)?.definition;
/** The code of a refusal, and whether it says the config has problems (rather than some other invalid input). */
const failure = async (promise: Promise<unknown>): Promise<{ code: string; problem: boolean }> => {
  try { await promise; return { code: "ok", problem: false }; } catch (error) { const e = error as { code?: string; message?: string }; return { code: e.code ?? "other", problem: (e.message ?? "").includes("the meta repo's config has problems") }; }
};
const apply = (w: World, commit: string, extra: Record<string, unknown> = {}, who: MetaConfigCaller = MAINTAINER, expectedRevision = 1) =>
  applyMetaConfigChange(w.deps, who, PROJECT, { requestId: randomUUID(), expectedRevision, commit, ...extra });
// The broker modules import the contracts' built package: the errors a fake throws are that package's too, so `instanceof` in the code under test sees them.
const code = async (promise: Promise<unknown>): Promise<string> => { try { await promise; return "ok"; } catch (error) { return (error as { code?: unknown }).code as string ?? "other"; } };

const SETUP_YAML = "version: 1\nsetup:\n  api: [npm ci]\n  web: [npm ci]\ntests:\n  api:\n    commands: [npm test]\n";

describe("a push to the meta repo's default branch", () => {
  it("records a pending change and applies nothing", async () => {
    const w = world();
    await expect(push(w, COMMIT_A, SETUP_YAML)).resolves.toBe("queued");
    expect(pending(w)).toMatchObject({ status: "pending", commit: COMMIT_A, path: ".rovara/project.yaml", baseRevision: 1 });
    expect(w.registered).toEqual([]);
    expect(latestDefinition(w, 1)).toMatchObject({ setup: [], readiness: [] });
  });

  it("tries the file's places in order and takes the first that exists", async () => {
    const w = world();
    await push(w, COMMIT_A, "version: 1\nsetup:\n  api: [from-json]\n", undefined, ".rovara/project.json");
    // The JSON file is the only one: the YAML places were asked first and answered nothing.
    expect(w.readMetaFile.mock.calls.map((call) => (call[0] as { path: string }).path)).toEqual([".rovara/project.yaml", ".rovara/project.yml", ".rovara/project.json"]);
  });

  it("records nothing for a project with no meta repository, or for a file that matches the project", async () => {
    const plain = world(definition([repo("api")]));
    await expect(push(plain, COMMIT_A, SETUP_YAML)).resolves.toBe("ignored");
    expect(pending(plain)).toBeUndefined();
    const w = world(separate({ setup: [command("npm ci", "repo/api")] }));
    await expect(push(w, COMMIT_A, "version: 1\nsetup:\n  api: [npm ci]\n")).resolves.toBe("no_change");
    expect(pending(w)).toBeUndefined();
  });

  it("records an invalid file as invalid, with where and what, and never the file's words", async () => {
    const w = world();
    await expect(push(w, COMMIT_A, "version: 1\nsetup:\n  api: [\"npm ci && echo hunter2-secret\"]\n")).resolves.toBe("invalid");
    const record = pending(w)!;
    expect(record.status).toBe("invalid");
    expect(JSON.stringify(record)).not.toContain("hunter2");
    expect(record.problems).toEqual([{ path: "setup.api.0", message: "a command runs one program; put && , | and ; steps in a script or Makefile target and call that" }]);
    // An invalid change cannot be applied, and the refusal says why (not merely that something is invalid).
    expect(await failure(apply(w, COMMIT_A))).toEqual({ code: "CONFIG_INVALID", problem: true });
    expect(w.registered).toEqual([]);
  });

  it("orders by the branch's head, never by a commit's own date: a late delivery of an old push reads the current head and changes nothing", async () => {
    const w = world();
    await push(w, COMMIT_B, "version: 1\nsetup:\n  api: [new]\n");
    w.files.set(`${COMMIT_A}:.rovara/project.yaml`, "version: 1\nsetup:\n  api: [old]\n");
    // GitHub redelivers the OLDER push now (the branch is at COMMIT_B).
    await expect(queueMetaConfigImport(w.deps, { orgId: ORG, project: PROJECT, commit: COMMIT_A })).resolves.toBe("queued");
    expect(pending(w)).toMatchObject({ commit: COMMIT_B });
    expect(JSON.parse(pending(w)!.configJson as string)).toMatchObject({ setup: { api: ["new"] } });
    expect(w.readMetaFile.mock.calls.every((call) => (call[0] as { commit: string }).commit === COMMIT_B)).toBe(true);
    // No date of any commit is read anywhere in the record.
    expect(JSON.stringify(pending(w))).not.toContain("pushedAtMs");
  });

  it("cannot bring an old config back after it was applied: the late delivery finds the head's file already in the project", async () => {
    const w = world();
    await push(w, COMMIT_B, SETUP_YAML);
    await apply(w, COMMIT_B);
    expect(pending(w)).toBeUndefined();
    w.files.set(`${COMMIT_A}:.rovara/project.yaml`, "version: 1\nsetup:\n  api: [old]\n");
    await expect(queueMetaConfigImport(w.deps, { orgId: ORG, project: PROJECT, commit: COMMIT_A })).resolves.toBe("no_change");
    expect(pending(w)).toBeUndefined();
  });

  it("steps aside when the head moves while the file is read", async () => {
    const w = world();
    w.files.set(`${COMMIT_A}:.rovara/project.yaml`, SETUP_YAML);
    w.head.value = COMMIT_A;
    w.head.moveAfterReads = { reads: 1, to: COMMIT_B };
    await expect(queueMetaConfigImport(w.deps, { orgId: ORG, project: PROJECT, commit: COMMIT_A })).resolves.toBe("stale");
    expect(pending(w)).toBeUndefined();
  });

  it("applies only while the change is still the branch's head, asking GitHub at apply time", async () => {
    const w = world();
    await push(w, COMMIT_A, SETUP_YAML);
    // The branch moved on (or was rolled back) and no push reached Rovara yet.
    w.head.value = COMMIT_B;
    await expect(failure(apply(w, COMMIT_A))).resolves.toEqual({ code: "PROJECT_REVISION_MISMATCH", problem: false });
    expect(w.registered).toEqual([]);
    w.head.value = COMMIT_A;
    expect((await apply(w, COMMIT_A)).revision).toBe(2);
  });

  it("records an oversized config file as invalid, once, instead of failing again and again", async () => {
    const w = world();
    w.head.value = COMMIT_A;
    w.readMetaFile.mockRejectedValue(Object.assign(new Error("file too large"), { code: "CONFIG_INVALID" }));
    await expect(queueMetaConfigImport(w.deps, { orgId: ORG, project: PROJECT, commit: COMMIT_A })).resolves.toBe("invalid");
    expect(pending(w)).toMatchObject({ status: "invalid", commit: COMMIT_A, problems: [{ path: "(file)", message: "the file is larger than 262144 bytes" }] });
    await expect(queueMetaConfigImport(w.deps, { orgId: ORG, project: PROJECT, commit: COMMIT_A })).resolves.toBe("invalid");
    // A real outage is still retried, not recorded.
    w.readMetaFile.mockRejectedValue(Object.assign(new Error("503"), { code: "RUNTIME_UNAVAILABLE" }));
    await expect(queueMetaConfigImport(w.deps, { orgId: ORG, project: PROJECT, commit: COMMIT_B })).rejects.toThrow("503");
  });

  it("lets a maintainer check the meta repo now, which recovers a push that never arrived", async () => {
    const w = world();
    // The file was pushed but the event was lost: nothing is pending.
    w.files.set(`${COMMIT_B}:.rovara/project.yaml`, SETUP_YAML);
    w.head.value = COMMIT_B;
    expect(pending(w)).toBeUndefined();
    const checked = await checkMetaConfigNow(w.deps, MAINTAINER, PROJECT);
    expect(checked.outcome).toBe("queued");
    expect(checked.state.pending).toMatchObject({ status: "pending", commit: COMMIT_B });
    expect(await code(checkMetaConfigNow(w.deps, CONTRIBUTOR, PROJECT))).toBe("FORBIDDEN");
    expect(await code(checkMetaConfigNow(w.deps, STRANGER, PROJECT))).toBe("PROJECT_NOT_FOUND");
    expect((await routeMetaConfig(w.deps, MAINTAINER, PROJECT, { method: "POST", action: "check", body: {} })).status).toBe(200);
  });

  it("clears the pending change when the newest file makes it pointless", async () => {
    const w = world();
    await push(w, COMMIT_A, SETUP_YAML);
    expect(pending(w)).toBeDefined();
    await expect(push(w, COMMIT_B, "version: 1\n")).resolves.toBe("no_change");
    expect(pending(w)).toBeUndefined();
  });

  it("does not read a code host outage as the file being removed", async () => {
    const w = world(separate({ setup: [command("npm ci", "repo/api")], origins: { setup: "file" } }));
    w.readMetaFile.mockRejectedValueOnce(new Error("503"));
    await expect(push(w, COMMIT_A, undefined)).rejects.toThrow("503");
    expect(pending(w)).toBeUndefined();
  });

  it("offers to release the settings a removed file managed, and only then", async () => {
    const managed = world(separate({ setup: [command("npm ci", "repo/api")], origins: { setup: "file" } }));
    await expect(push(managed, COMMIT_A, undefined)).resolves.toBe("released");
    expect(pending(managed)).toMatchObject({ status: "released" });
    const result = await apply(managed, COMMIT_A);
    expect(result.applied).toEqual(["release:setup"]);
    const next = latestDefinition(managed, 2)!;
    // The values stay; they are people's again, so the settings save may change them.
    expect(next.setup).toEqual([command("npm ci", "repo/api")]);
    expect(next.origins).toBeUndefined();
    const plain = world();
    await expect(push(plain, COMMIT_A, undefined)).resolves.toBe("no_change");
  });
});

describe("applying a spec target (K1 lane D)", () => {
  const SPEC_YAML = "version: 1\nspecTarget: {format: kiro, where: meta_repo, when: features, linkStyle: spec_first}\n";
  it("applies the file's spec target as a new revision marked as the file's, and the stored target reads as the file wrote it", async () => {
    const w = world();
    await push(w, COMMIT_A, SPEC_YAML);
    const result = await apply(w, COMMIT_A);
    expect(result).toMatchObject({ applied: ["specTarget"], notApplied: [], revision: 2 });
    expect(latestDefinition(w, 2)).toMatchObject({ specTarget: { where: "meta_repo", format: "kiro", when: "features", linkStyle: "spec_first" }, origins: { specTarget: "file" } });
  });
  it("never replaces a spec target a person set, unless the person names the field", async () => {
    const w = world(separate({ specTarget: { where: "meta_repo", format: "rovara", when: "always", linkStyle: "together" } }));
    await push(w, COMMIT_A, SPEC_YAML);
    const first = await apply(w, COMMIT_A);
    expect(first).toMatchObject({ applied: [], notApplied: [{ id: "specTarget", reason: "person_value" }] });
    const second = await apply(w, COMMIT_A, { useFile: ["specTarget"] });
    expect(second.applied).toEqual(["specTarget"]);
    expect(latestDefinition(w, 2)).toMatchObject({ specTarget: { format: "kiro", linkStyle: "spec_first" } });
  });
});

describe("applying the pending change", () => {
  it("applies the file's commands as a new revision, marks them as the file's, and clears the pending change", async () => {
    const w = world();
    await push(w, COMMIT_A, SETUP_YAML);
    const result = await apply(w, COMMIT_A);
    expect(result).toMatchObject({ applied: ["setup", "readiness"], notApplied: [], revision: 2, duplicate: false });
    expect(latestDefinition(w, 2)).toMatchObject({
      revision: 2,
      setup: [command("npm ci", "repo/api"), command("npm ci", "repo/web")],
      readiness: [command("npm test", "repo/api", 1800)],
      origins: { setup: "file", readiness: "file" },
    });
    expect(pending(w)).toBeUndefined();
    // The revision carries the roles it had, and the meta repository is untouched.
    expect((latestDefinition(w, 2)!.repositories as Array<{ name: string; role?: string }>).map((entry) => `${entry.name}:${entry.role ?? "code"}`)).toEqual(["api:code", "web:code", "service-meta:meta"]);
  });

  it("never replaces a value a person typed, and says so; the person can name the field to replace it", async () => {
    const w = world(separate({ setup: [command("make setup", "repo/api")] }));
    await push(w, COMMIT_A, SETUP_YAML);
    const first = await apply(w, COMMIT_A);
    expect(first.notApplied).toEqual([{ id: "setup", reason: "person_value" }]);
    expect(first.applied).toEqual(["readiness"]);
    expect(latestDefinition(w, 2)).toMatchObject({ setup: [command("make setup", "repo/api")], readiness: [command("npm test", "repo/api", 1800)], origins: { readiness: "file" } });
  });

  it("replaces it when the person names the field", async () => {
    const w = world(separate({ setup: [command("make setup", "repo/api")] }));
    await push(w, COMMIT_A, SETUP_YAML);
    const result = await apply(w, COMMIT_A, { useFile: ["setup"] });
    expect(result.applied).toEqual(["setup", "readiness"]);
    expect(latestDefinition(w, 2)).toMatchObject({ setup: [command("npm ci", "repo/api"), command("npm ci", "repo/web")], origins: { setup: "file", readiness: "file" } });
  });

  it("changes nothing when everything is held back, and keeps the pending change", async () => {
    const w = world(separate({ setup: [command("make setup", "repo/api")] }));
    await push(w, COMMIT_A, "version: 1\nsetup:\n  api: [npm ci]\n");
    const result = await apply(w, COMMIT_A);
    expect(result).toMatchObject({ applied: [], revision: 1 });
    expect(w.registered).toEqual([]);
    expect(pending(w)).toBeDefined();
  });

  it("adds the repositories the file lists through the org's GitHub connection, pinned and named as the file says", async () => {
    const w = world();
    await push(w, COMMIT_A, "version: 1\nrepositories:\n  - {name: lib, url: 'https://github.com/acme/lib.git'}\nsetup:\n  lib: [make]\n");
    const result = await apply(w, COMMIT_A);
    expect(result.applied).toEqual(["repositories:add:lib", "setup"]);
    expect(w.connectedCalls).toEqual(["acme/lib"]);
    const next = latestDefinition(w, 2)!;
    const lib = (next.repositories as Array<Record<string, unknown>>).find((entry) => entry.name === "lib")!;
    expect(lib).toMatchObject({ url: "https://github.com/acme/lib.git", path: "repo/lib", defaultBranch: "trunk", role: "code", installationId: 55, githubRepositoryId: 900, credentialRef: "github-app" });
    expect(next.setup).toEqual([command("make", "repo/lib")]);
    expect(next.origins).toEqual({ repositories: "file", setup: "file" });
  });

  it("refuses to add a repository the org's connection does not reach, writing nothing", async () => {
    const w = world();
    w.deps.requireRepositoryConnected = async () => { throw new AgentXError("GITHUB_NOT_CONNECTED", "Rovara can't reach acme/lib"); };
    await push(w, COMMIT_A, "version: 1\nrepositories:\n  - {name: lib, url: 'https://github.com/acme/lib.git'}\n");
    expect(await code(apply(w, COMMIT_A))).toBe("GITHUB_NOT_CONNECTED");
    expect(w.registered).toEqual([]);
    expect(pending(w)).toBeDefined();
  });

  it("checks what GitHub says of an added repository against the connection and the owner the file named", async () => {
    const yamlText = "version: 1\nrepositories:\n  - {name: lib, url: 'https://github.com/acme/lib.git'}\n";
    const other = world();
    other.deps.repositoryIdentity = async (url) => ({ fullName: new URL(url).pathname.slice(1).replace(/\.git$/, ""), defaultBranch: "trunk", repositoryId: 4242 });
    await push(other, COMMIT_A, yamlText);
    expect(await code(apply(other, COMMIT_A))).toBe("RUNTIME_UNAVAILABLE");
    const moved = world();
    moved.deps.repositoryIdentity = async () => ({ fullName: "someone-else/lib", defaultBranch: "trunk", repositoryId: 900 });
    await push(moved, COMMIT_A, yamlText);
    expect(await code(apply(moved, COMMIT_A))).toBe("FORBIDDEN");
    expect(other.registered.concat(moved.registered)).toEqual([]);
  });

  it("removes a repository only when the person confirms it by name", async () => {
    const w = world();
    await push(w, COMMIT_A, "version: 1\nrepositories:\n  - {name: api, url: 'https://github.com/acme/api.git'}\n");
    const held = await apply(w, COMMIT_A);
    expect(held).toMatchObject({ applied: [], notApplied: [{ id: "repositories:remove:web", reason: "unconfirmed_removal" }] });
    expect(w.registered).toEqual([]);
    expect(await code(apply(w, COMMIT_A, { confirmRemovals: ["ghost"] }))).toBe("CONFIG_INVALID");
    const done = await apply(w, COMMIT_A, { confirmRemovals: ["web"] });
    expect(done.applied).toEqual(["repositories:remove:web"]);
    expect((latestDefinition(w, 2)!.repositories as Array<{ name: string }>).map((entry) => entry.name)).toEqual(["api", "service-meta"]);
    // The meta repository stays last whatever is added or removed.
    const grown = world();
    await push(grown, COMMIT_A, "version: 1\nrepositories:\n  - {name: api, url: 'https://github.com/acme/api.git'}\n  - {name: web, url: 'https://github.com/acme/web.git'}\n  - {name: lib, url: 'https://github.com/acme/lib.git'}\n");
    await apply(grown, COMMIT_A);
    expect((latestDefinition(grown, 2)!.repositories as Array<{ name: string }>).map((entry) => entry.name)).toEqual(["api", "web", "lib", "service-meta"]);
  });

  it("will not remove a repository the project's commands or devcontainer still use", async () => {
    const used = world(separate({ setup: [command("npm ci", "repo/web")], origins: { setup: "agent" } }));
    await push(used, COMMIT_A, "version: 1\nrepositories:\n  - {name: api, url: 'https://github.com/acme/api.git'}\n");
    expect(await code(apply(used, COMMIT_A, { confirmRemovals: ["web"] }))).toBe("CONFIG_INVALID");
    const dev = world(separate({ devcontainer: { repository: "web" } }));
    await push(dev, COMMIT_A, "version: 1\nrepositories:\n  - {name: api, url: 'https://github.com/acme/api.git'}\n");
    expect(await code(apply(dev, COMMIT_A, { confirmRemovals: ["web"] }))).toBe("CONFIG_INVALID");
  });

  it("holds back an addition that is blocked and tells which", async () => {
    const w = world(selfMeta());
    await push(w, COMMIT_A, "version: 1\nrepositories:\n  - {name: lib, url: 'https://github.com/acme/lib.git'}\nsetup:\n  app: [npm ci]\n");
    const result = await apply(w, COMMIT_A);
    expect(result.notApplied).toEqual([{ id: "repositories:add:lib", reason: "blocked" }]);
    expect(result.applied).toEqual(["setup"]);
  });

  it("answers a repeat of the same request with the same result and writes one revision", async () => {
    const w = world();
    await push(w, COMMIT_A, SETUP_YAML);
    const body = { requestId: randomUUID(), expectedRevision: 1, commit: COMMIT_A };
    const first = await applyMetaConfigChange(w.deps, MAINTAINER, PROJECT, body);
    const again = await applyMetaConfigChange(w.deps, MAINTAINER, PROJECT, body);
    expect(again).toMatchObject({ applied: first.applied, revision: 2, duplicate: true });
    expect(w.registered).toEqual([2]);
    // The same id for another body, or by another person, is a conflict.
    expect(await code(applyMetaConfigChange(w.deps, MAINTAINER, PROJECT, { ...body, useFile: ["setup"] }))).toBe("IDEMPOTENCY_CONFLICT");
    w.roles.set(CONTRIBUTOR.developerId, "maintainer");
    expect(await code(applyMetaConfigChange(w.deps, CONTRIBUTOR, PROJECT, body))).toBe("IDEMPOTENCY_CONFLICT");
  });

  it("refuses the file a person did not look at: a newer commit, or a project that moved on", async () => {
    const w = world();
    await push(w, COMMIT_A, SETUP_YAML);
    await push(w, COMMIT_B, "version: 1\nsetup:\n  api: [other]\n");
    expect(await code(apply(w, COMMIT_A))).toBe("PROJECT_REVISION_MISMATCH");
    expect(await code(apply(w, COMMIT_B, {}, MAINTAINER, 7))).toBe("PROJECT_REVISION_MISMATCH");
    expect(w.registered).toEqual([]);
  });

  it("refuses a change planned against a revision a person has since changed: the plan is made again, so a typed value is still protected", async () => {
    const w = world();
    await push(w, COMMIT_A, "version: 1\nsetup:\n  api: [npm ci]\n");
    // A person types a different command after the push: revision 2.
    seedRevision(w.db, separate({ setup: [command("make setup", "repo/api")], revision: 2 }));
    const result = await apply(w, COMMIT_A, {}, MAINTAINER, 2);
    expect(result).toMatchObject({ applied: [], notApplied: [{ id: "setup", reason: "person_value" }] });
  });

  it("plans again at apply time: a file that named a repository a person has since removed is refused whole", async () => {
    const w = world();
    await push(w, COMMIT_A, SETUP_YAML);
    // Revision 2: a person removed `web`, which the file still gives commands for.
    seedRevision(w.db, definition([repo("api", { role: "code" }), repo("service-meta", { role: "meta" })], {}, 2));
    expect(await failure(apply(w, COMMIT_A, {}, MAINTAINER, 2))).toEqual({ code: "CONFIG_INVALID", problem: true });
    expect(w.registered).toEqual([]);
  });

  it("is a maintainer's act, on a cloud install, on a project that is not archived", async () => {
    const w = world();
    await push(w, COMMIT_A, SETUP_YAML);
    expect(await code(apply(w, COMMIT_A, {}, CONTRIBUTOR))).toBe("FORBIDDEN");
    expect(await code(apply(w, COMMIT_A, {}, STRANGER))).toBe("PROJECT_NOT_FOUND");
    expect(await code(dismissMetaConfigChange(w.deps, CONTRIBUTOR, PROJECT, { commit: COMMIT_A }))).toBe("FORBIDDEN");
    const other = world(separate(), { cloud: false });
    await push(other, COMMIT_A, SETUP_YAML);
    expect(await code(apply(other, COMMIT_A))).toBe("FORBIDDEN");
    const archived = world(separate(), { archived: true });
    await push(archived, COMMIT_A, SETUP_YAML);
    expect(await code(apply(archived, COMMIT_A))).toBe("PROJECT_ARCHIVED");
    expect(w.registered.concat(other.registered, archived.registered)).toEqual([]);
  });

  it("leaves a project that only an administrator may change to the administrator", async () => {
    const w = world(separate({ e2e: undefined }));
    seedRevision(w.db, separate(), { setupApproval: { proposalRef: "x" } });
    await push(w, COMMIT_A, SETUP_YAML);
    expect(await code(apply(w, COMMIT_A))).toBe("FORBIDDEN");
  });

  it("refuses a body with a field it does not know", async () => {
    const w = world();
    await push(w, COMMIT_A, SETUP_YAML);
    expect(await code(apply(w, COMMIT_A, { force: true }))).toBe("CONFIG_INVALID");
    expect(await code(applyMetaConfigChange(w.deps, MAINTAINER, PROJECT, { requestId: "nope", expectedRevision: 1, commit: COMMIT_A }))).toBe("CONFIG_INVALID");
  });
});

describe("what the app shows", () => {
  it("shows the settings the file manages and the pending change with its diff against the project as it is now", async () => {
    const w = world(separate({ setup: [command("npm ci", "repo/api")], origins: { setup: "file" } }));
    await push(w, COMMIT_A, "version: 1\nsetup:\n  api: [npm ci, npm run build]\ntests:\n  api:\n    commands: [npm test]\n");
    const view = await readMetaConfigState(w.deps, CONTRIBUTOR, PROJECT);
    expect(view.managedFields).toEqual(["setup"]);
    expect(view.pending).toMatchObject({ status: "pending", commit: COMMIT_A, baseRevision: 1, problems: [] });
    expect(view.pending!.items.map((item) => item.id)).toEqual(["setup", "readiness"]);
    expect(view.pending!.items[0]).toMatchObject({ before: ["api: npm ci"], after: ["api: npm ci", "api: npm run build"] });
    expect(await code(readMetaConfigState(w.deps, STRANGER, PROJECT))).toBe("PROJECT_NOT_FOUND");
  });

  it("shows nothing pending when there is nothing", async () => {
    expect(await readMetaConfigState(world().deps, MAINTAINER, PROJECT)).toEqual({ managedFields: [] });
  });

  it("sets a pending change aside, for the commit the person saw only", async () => {
    const w = world();
    await push(w, COMMIT_A, SETUP_YAML);
    expect(await code(dismissMetaConfigChange(w.deps, MAINTAINER, PROJECT, { commit: COMMIT_B }))).toBe("PROJECT_REVISION_MISMATCH");
    expect(pending(w)).toBeDefined();
    await expect(dismissMetaConfigChange(w.deps, MAINTAINER, PROJECT, { commit: COMMIT_A })).resolves.toEqual({ dismissed: true });
    expect(pending(w)).toBeUndefined();
  });

  it("routes the three calls, and refuses another", async () => {
    const w = world();
    await push(w, COMMIT_A, SETUP_YAML);
    expect((await routeMetaConfig(w.deps, MAINTAINER, PROJECT, { method: "GET", action: undefined, body: undefined })).status).toBe(200);
    expect((await routeMetaConfig(w.deps, MAINTAINER, PROJECT, { method: "POST", action: "apply", body: { requestId: randomUUID(), expectedRevision: 1, commit: COMMIT_A } })).body).toMatchObject({ revision: 2 });
    expect(await code(routeMetaConfig(w.deps, MAINTAINER, PROJECT, { method: "DELETE", action: undefined, body: undefined }))).toBe("NOT_FOUND");
  });
});

// ---- creating a project from a meta repo

function createWorld(options: { visible?: Record<string, { id: number; branch: string }>; defaults?: boolean } = {}) {
  const db = new FakeDynamoDb();
  const visible = options.visible ?? { "acme/service-meta": { id: 1, branch: "main" }, "acme/api": { id: 2, branch: "trunk" }, "acme/web": { id: 3, branch: "main" }, "acme/app": { id: 4, branch: "main" }, "globex/api": { id: 5, branch: "main" } };
  const registrations: Array<{ definition: ReturnType<typeof ProjectDefinitionSchema.parse>; description?: string }> = [];
  const deps: CreateFromMetaDependencies = {
    documentClient: db, tableName: "state", now: () => Date.parse("2026-10-30T10:00:00.000Z"),
    defaults: options.defaults === false ? undefined : { runtimeBinding: BINDING as never, githubCredentialRef: "github-app" },
    requireRepositoryConnected: async (_org, owner, name) => {
      const found = visible[`${owner}/${name}`.toLowerCase()];
      if (found === undefined) throw new AgentXError("GITHUB_NOT_CONNECTED", `Rovara can't reach ${owner}/${name}`);
      return { installationId: 55, githubRepositoryId: found.id };
    },
    repositoryIdentity: async (url) => {
      const [owner, name] = new URL(url).pathname.replace(/\.git$/, "").split("/").filter(Boolean) as [string, string];
      const found = visible[`${owner}/${name}`.toLowerCase()];
      return found === undefined ? undefined : { repositoryId: found.id, fullName: `${owner}/${name}`, defaultBranch: found.branch };
    },
    registerProject: async (actor, input, registerOptions) => {
      const parsed = ProjectDefinitionSchema.parse(input.definition);
      const taken = db.get(orgProjectCatalogKey(actor.orgId, parsed.name));
      if (taken !== undefined) throw new AgentXError("PROJECT_NAME_TAKEN", "name taken");
      await db.send(new TransactWriteCommand({ TransactItems: [
        { Put: { TableName: "state", Item: { ...projectRevisionKey(actor.orgId, parsed.name, 1), entityType: "PROJECT", registeredAt: "2026-10-30T10:00:00.000Z", definition: parsed } } },
        { Put: { TableName: "state", Item: { ...orgProjectCatalogKey(actor.orgId, parsed.name), entityType: "PROJECT_CATALOG", name: parsed.name } } },
        ...registerOptions.extraItems,
      ] }));
      registrations.push({ definition: parsed, ...(registerOptions.description === undefined ? {} : { description: registerOptions.description }) });
      return { project: { definition: parsed, registeredAt: "2026-10-30T10:00:00.000Z" }, duplicate: false };
    },
  };
  return { db, deps, registrations };
}
const OWNER: MetaConfigCaller = { developerId: "dev-owner", orgId: ORG, orgRole: "owner" };
const createBody = (extra: Record<string, unknown> = {}) => ({ requestId: randomUUID(), metaRepository: "acme/service-meta", codeRepositories: ["acme/api", "acme/web"], ...extra });

describe("creating a project from a meta repo", () => {
  it("makes a project with a separate meta repository, listed last so commands still run in a code repository", async () => {
    const w = createWorld();
    const created = await createProjectFromMeta(w.deps, OWNER, createBody({ description: "Payments" }));
    expect(created.duplicate).toBe(false);
    const repositories = w.registrations[0]!.definition.repositories;
    expect(repositories.map((entry) => `${entry.name}:${entry.role}${entry.alsoCode === true ? "+code" : ""}`)).toEqual(["api:code", "web:code", "service-meta:meta"]);
    expect(w.registrations[0]!.definition.name).toBe("service-meta");
    expect(w.registrations[0]!.description).toBe("Payments");
    // Pinned to what the org's connection answered, with GitHub's own default branch.
    expect(repositories[0]).toMatchObject({ installationId: 55, githubRepositoryId: 2, defaultBranch: "trunk", credentialRef: "github-app", path: "repo/api" });
    // A tenant is told nothing of the credential or the runtime.
    expect(JSON.stringify(created)).not.toContain("github-app");
    expect(created.project.definition.repositories[2]).toMatchObject({ name: "service-meta", role: "meta" });
  });

  it("makes a one-repository project that is its own meta repository", async () => {
    const w = createWorld();
    await createProjectFromMeta(w.deps, OWNER, { requestId: randomUUID(), metaRepository: "acme/app" });
    expect(w.registrations[0]!.definition.repositories).toMatchObject([{ name: "app", role: "meta", alsoCode: true }]);
  });

  it("answers a repeat of the request with the project it made, and refuses the same id for another project or by another person", async () => {
    const w = createWorld();
    const body = createBody();
    const first = await createProjectFromMeta(w.deps, OWNER, body);
    const again = await createProjectFromMeta(w.deps, OWNER, body);
    expect(again.duplicate).toBe(true);
    expect(again.project.definition.name).toBe(first.project.definition.name);
    expect(w.registrations).toHaveLength(1);
    expect(await code(createProjectFromMeta(w.deps, OWNER, { ...body, codeRepositories: ["acme/api"] }))).toBe("IDEMPOTENCY_CONFLICT");
    expect(await code(createProjectFromMeta(w.deps, { ...OWNER, developerId: "dev-other" }, body as never))).toBe("IDEMPOTENCY_CONFLICT");
    expect(w.db.get(projectCreateRequestKey(ORG, body.requestId))).toMatchObject({ by: OWNER.developerId, projectName: "service-meta" });
  });

  it("answers the project an identical request in flight made a moment ago, when it loses the name", async () => {
    const w = createWorld();
    const body = createBody();
    const registerProject = w.deps.registerProject.bind(w.deps);
    // The winner registers; this attempt then finds the name taken, and answers what the winner made.
    w.deps.registerProject = async (...args) => { await registerProject(...args); throw new AgentXError("PROJECT_NAME_TAKEN", "name taken"); };
    const answer = await createProjectFromMeta(w.deps, OWNER, body);
    expect(answer.duplicate).toBe(true);
    expect(w.registrations).toHaveLength(1);
  });

  it("refuses a repository the org's connection does not reach, before registering anything", async () => {
    const w = createWorld();
    expect(await code(createProjectFromMeta(w.deps, OWNER, createBody({ codeRepositories: ["acme/api", "acme/ghost"] }) as never))).toBe("GITHUB_NOT_CONNECTED");
    expect(await code(createProjectFromMeta(w.deps, OWNER, createBody({ metaRepository: "acme/ghost" }) as never))).toBe("GITHUB_NOT_CONNECTED");
    expect(w.registrations).toEqual([]);
  });

  it("refuses a repository GitHub describes differently from the connection, or under another owner", async () => {
    const w = createWorld();
    w.deps.repositoryIdentity = async (url) => ({ repositoryId: 999, fullName: new URL(url).pathname.slice(1).replace(/\.git$/, ""), defaultBranch: "main" });
    expect(await code(createProjectFromMeta(w.deps, OWNER, createBody() as never))).toBe("RUNTIME_UNAVAILABLE");
    const moved = createWorld();
    moved.deps.repositoryIdentity = async (url) => ({ repositoryId: Number(new URL(url).pathname.length), fullName: "someone-else/x", defaultBranch: "main" });
    moved.deps.requireRepositoryConnected = async (_org, _owner, name) => ({ installationId: 55, githubRepositoryId: `/acme/${name}.git`.length });
    expect(await code(createProjectFromMeta(moved.deps, OWNER, createBody() as never))).toBe("FORBIDDEN");
    expect(w.registrations).toEqual([]);
  });

  it("refuses two repositories that would be called the same", async () => {
    const w = createWorld();
    expect(await code(createProjectFromMeta(w.deps, OWNER, createBody({ codeRepositories: ["acme/api", "globex/api"] }) as never))).toBe("CONFIG_INVALID");
  });

  it("refuses a name that is taken, and a deployment that has no runtime defaults", async () => {
    const w = createWorld();
    await createProjectFromMeta(w.deps, OWNER, createBody());
    expect(await code(createProjectFromMeta(w.deps, OWNER, createBody() as never))).toBe("PROJECT_NAME_TAKEN");
    expect(await code(createProjectFromMeta(createWorld({ defaults: false }).deps, OWNER, createBody() as never))).toBe("RUNTIME_UNAVAILABLE");
  });

  it("is an owner's or admin's act on a cloud install, and refuses a body it cannot read", async () => {
    const w = createWorld();
    const createFromMeta = (caller: MetaConfigCaller, input: never) => createProjectFromMeta(w.deps, caller, input);
    expect((await createProjectFromMetaRoute({ cloud: true, createFromMeta }, OWNER, createBody())).status).toBe(201);
    // A repeat of the same request is answered 200 with the project it made.
    const body = createBody({ metaRepository: "acme/app", codeRepositories: undefined });
    expect((await createProjectFromMetaRoute({ cloud: true, createFromMeta }, OWNER, body)).status).toBe(201);
    expect((await createProjectFromMetaRoute({ cloud: true, createFromMeta }, OWNER, body)).status).toBe(200);
    expect(await code(createProjectFromMetaRoute({ cloud: true, createFromMeta }, CONTRIBUTOR, createBody()))).toBe("FORBIDDEN");
    expect(await code(createProjectFromMetaRoute({ cloud: false, createFromMeta }, OWNER, createBody()))).toBe("FORBIDDEN");
    expect(await code(createProjectFromMetaRoute({ cloud: true }, OWNER, createBody()))).toBe("NOT_FOUND");
    expect(await code(createProjectFromMetaRoute({ cloud: true, createFromMeta }, OWNER, { metaRepository: "nope" }))).toBe("CONFIG_INVALID");
  });
});

// ---- the push that queues an import

describe("a GitHub push as a meta repo's config changing", () => {
  const INSTALLATION = 55;
  const META_ID = 100 + "service-meta".length;
  function pushWorld(def: Record<string, unknown> = separate()) {
    const w = world(def);
    w.db.set({ ...githubInstallationKey(INSTALLATION), entityType: "GITHUB_INSTALLATION", orgId: ORG, status: "active" });
    for (const entry of (def.repositories as Array<{ githubRepositoryId: number }>)) {
      w.db.set({ ...githubRepoProjectKey(entry.githubRepositoryId, ORG, PROJECT), entityType: "GITHUB_REPO_PROJECT", orgId: ORG, project: PROJECT, installationId: INSTALLATION, githubRepositoryId: entry.githubRepositoryId });
    }
    const queued: Array<{ orgId: string; project: string; commit: string }> = [];
    const triggerDeps = (extra: Record<string, unknown> = {}) => ({ documentClient: w.db, tableName: "state", now: () => w.now.value, dispatch: async () => undefined, log: () => undefined, queueMetaConfigImport: async (pushed: (typeof queued)[number]) => { queued.push(pushed); }, ...extra }) as never;
    return { w, queued, triggerDeps };
  }
  const pushed = (over: Record<string, unknown> = {}, repositoryId = META_ID) => ({
    eventName: "push", installationId: INSTALLATION,
    payload: { ref: "refs/heads/main", after: COMMIT_A, deleted: false, repository: { id: repositoryId, full_name: "acme/service-meta", default_branch: "main" }, ...over },
  });

  it("queues an import for a push to the meta repository's default branch", async () => {
    const { queued, triggerDeps } = pushWorld();
    const result = await deliverGithubTriggerEvents(triggerDeps(), pushed());
    expect(result).toEqual({ events: 1, duplicates: 0 });
    expect(queued).toEqual([{ orgId: ORG, project: PROJECT, commit: COMMIT_A }]);
  });

  it("ignores a push to another branch, a deleted branch, a push of nothing, and a malformed body", async () => {
    const { queued, triggerDeps } = pushWorld();
    for (const over of [{ ref: "refs/heads/feature" }, { ref: "refs/tags/main" }, { deleted: true }, { after: "0".repeat(40) }, { after: "short" }]) {
      expect(await deliverGithubTriggerEvents(triggerDeps(), pushed(over))).toEqual({ events: 0, duplicates: 0 });
    }
    expect(queued).toEqual([]);
  });

  it("ignores a push to a code repository, a repository no project of the org pins, and an installation that is not bound", async () => {
    const { w, queued, triggerDeps } = pushWorld();
    expect(await deliverGithubTriggerEvents(triggerDeps(), pushed({}, 100 + "api".length))).toEqual({ events: 0, duplicates: 0 });
    expect(await deliverGithubTriggerEvents(triggerDeps(), pushed({}, 4242))).toEqual({ events: 0, duplicates: 0 });
    w.db.set({ ...githubInstallationKey(INSTALLATION), entityType: "GITHUB_INSTALLATION", orgId: ORG, status: "removed" });
    expect(await deliverGithubTriggerEvents(triggerDeps(), pushed())).toEqual({ events: 0, duplicates: 0 });
    expect(queued).toEqual([]);
  });

  it("follows the project's own record of the default branch, not the payload's", async () => {
    const { queued, triggerDeps } = pushWorld(definition([repo("api"), repo("service-meta", { role: "meta", defaultBranch: "trunk" })]));
    await deliverGithubTriggerEvents(triggerDeps(), pushed());
    expect(queued).toEqual([]);
    await deliverGithubTriggerEvents(triggerDeps(), pushed({ ref: "refs/heads/trunk", repository: { id: META_ID, default_branch: "trunk" } }));
    expect(queued).toHaveLength(1);
  });

  it("looks at no record at all for a push that is not to the default branch, or is to one of Rovara's own agentx/ branches", async () => {
    const { w, queued, triggerDeps } = pushWorld();
    const before = w.db.commandNames().length;
    for (const over of [{ ref: "refs/heads/agentx/0b9f4c1e-6a56-4a52-8a8e-2f3a8d9a8c11" }, { ref: "refs/heads/feature" }, { repository: { id: META_ID } }, { ref: "refs/heads/agentx/x", repository: { id: META_ID, default_branch: "agentx/x" } }]) {
      expect(await deliverGithubTriggerEvents(triggerDeps(), pushed(over))).toEqual({ events: 0, duplicates: 0 });
    }
    // Not one read of the table: the early exit comes before the installation, the repository index and the project are looked up.
    expect(w.db.commandNames().length).toBe(before);
    expect(queued).toEqual([]);
    await deliverGithubTriggerEvents(triggerDeps(), pushed());
    expect(w.db.commandNames().length).toBeGreaterThan(before);
  });

  it("does nothing when no import is wired, and asks GitHub to deliver again when the queue fails", async () => {
    const { w, triggerDeps } = pushWorld();
    expect(await deliverGithubTriggerEvents({ documentClient: w.db, tableName: "state", now: () => w.now.value, dispatch: async () => undefined, log: () => undefined }, pushed())).toEqual({ events: 0, duplicates: 0 });
    await expect(deliverGithubTriggerEvents(triggerDeps({ queueMetaConfigImport: async () => { throw new Error("down"); } }), pushed())).rejects.toBeInstanceOf(GithubWebhookRetryableError);
  });

  it("reads the pushes without queueing them", async () => {
    const { w } = pushWorld();
    expect(await githubMetaPushes({ documentClient: w.db, tableName: "state", log: () => undefined }, pushed() as never)).toHaveLength(1);
  });
});
