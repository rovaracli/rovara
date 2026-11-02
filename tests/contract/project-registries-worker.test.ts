// N9 (INTG2): the worker's half. The setup and readiness commands run for real (a local shell, with real Git), so the config file the tools are pointed at is the one a command reads.
// A fake token is built at run time and PLANTED: every case that says "never appears" also proves the token really was in play (a positive control).
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { StoredProjectDefinitionSchema, e2eSecretSpellings, prepareRegistriesOf, type PrepareRegistry, type ProjectRegistry, type RegistryCredential } from "../../packages/contracts/src/index.js";
import { REGISTRY_CONFIG_PREFIX, openRegistrySession, removeLeftoverRegistryConfigs, renderMavenSettings, renderNpmrc, renderPipConf } from "../../packages/worker/src/registry-config.js";
import { createRegistryCredentialProvider } from "../../packages/worker/src/registry-credentials.js";
import { WORKER_IMPLEMENTED_FEATURES } from "../../packages/worker/src/implemented-features.js";
import { prepareWorkspace, runProjectCommand, type PreparationCommandRunner, type RepositoryMaterializer } from "../../packages/worker/src/prepare.js";

const execFileAsync = promisify(execFile);
const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" };
const fakeToken = (seed: string): string => `eyJ${Buffer.from(`${seed}-token-material-${seed.repeat(24)}`).toString("base64url")}.${Buffer.from(seed.repeat(30)).toString("base64url")}`;
const expiry = () => new Date(Date.now() + 3_600_000).toISOString();

const CA: ProjectRegistry = { kind: "codeartifact", name: "internal-npm", format: "npm", domain: "acme", domainOwner: "123456789012", repository: "shared", region: "us-west-2" };
const CA_PIP: ProjectRegistry = { kind: "codeartifact", name: "internal-pypi", format: "pypi", domain: "acme", domainOwner: "123456789012", repository: "shared", region: "us-west-2" };
const CA_MVN: ProjectRegistry = { kind: "codeartifact", name: "internal-maven", format: "maven", domain: "acme", domainOwner: "123456789012", repository: "shared", region: "us-west-2" };
const registries = (...entries: ProjectRegistry[]): PrepareRegistry[] => prepareRegistriesOf(entries);

async function sourceRepository(): Promise<{ root: string; source: string }> {
  const root = await mkdtemp(join(tmpdir(), "registries-"));
  const source = join(root, "api-source");
  await mkdir(source, { recursive: true });
  await execFileAsync("git", ["init", "--quiet", "--initial-branch=main", source], { env: gitEnv });
  await writeFile(join(source, "README.md"), "# api\n");
  await execFileAsync("git", ["-C", source, "add", "-A"], { env: gitEnv });
  await execFileAsync("git", ["-C", source, "commit", "--quiet", "-m", "init"], { env: gitEnv });
  return { root, source };
}

function project(setup: string[], readiness: string[] = [], devcontainer = false) {
  const command = (script: string) => ({ cwd: "repo/api", executable: "sh", args: ["-c", script], timeoutSeconds: 60 });
  return StoredProjectDefinitionSchema.parse({
    name: "payments", revision: 1,
    repositories: [{ name: "api", url: "https://github.com/acme/api.git", path: "repo/api", defaultBranch: "main", credentialRef: "github-app" }],
    setup: setup.map(command), readiness: readiness.map(command), orchestratorInstructions: "x",
    ...(devcontainer ? { devcontainer: { repository: "api", configPath: ".devcontainer/devcontainer.json" } } : {}),
  });
}

async function fixture() {
  const { root, source } = await sourceRepository();
  const materializer: RepositoryMaterializer = async (_repo, target) => { await execFileAsync("git", ["clone", "--quiet", "--no-checkout", pathToFileURL(source).href, target], { env: gitEnv }); };
  const workspace = () => mkdtemp(join(root, "ws-"));
  // The real local shell, as a developer's machine runs it.
  const commandRunner: PreparationCommandRunner = (command, index, rootPath) => runProjectCommand(command, index, rootPath, undefined, true);
  return { materializer, workspace, commandRunner };
}

async function* walk(directory: string): AsyncGenerator<string> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else if (entry.isFile()) yield path;
  }
}
/** Every file under `root` whose bytes carry the token in any spelling. */
async function filesCarrying(root: string, token: string): Promise<string[]> {
  const forms = e2eSecretSpellings(token).filter((form) => form.length >= 6);
  const found: string[] = [];
  for await (const path of walk(root)) {
    const text = (await readFile(path)).toString("latin1");
    if (forms.some((form) => text.includes(form))) found.push(path);
  }
  return found;
}
const providerOf = (tokens: Record<string, string>, calls: string[] = []) => async (registry: string): Promise<RegistryCredential> => {
  calls.push(registry);
  return { username: "aws", token: tokens[registry] ?? "", expiresAt: expiry() };
};
const leftovers = async (root: string) => (await readdir(root)).filter((name) => name.startsWith(REGISTRY_CONFIG_PREFIX));

describe("the config files", () => {
  const token = fakeToken("r");
  const credential = (registry: PrepareRegistry) => ({ registry, username: "aws", token });
  it("npm: the registry line and the token for that registry's own address (CodeArtifact's documented .npmrc), per scope", () => {
    const [npm] = registries(CA);
    expect(renderNpmrc([credential(npm!)])).toBe(
      `registry=${npm!.url}\n//acme-123456789012.d.codeartifact.us-west-2.amazonaws.com/npm/shared/:_authToken=${token}\n//acme-123456789012.d.codeartifact.us-west-2.amazonaws.com/npm/shared/:always-auth=true\n`,
    );
    expect(renderNpmrc([credential({ ...npm!, scope: "@acme" })])).toContain(`@acme:registry=${npm!.url}\n`);
  });
  it("pip: the user name and the percent-encoded token sit in the index URL; a second index is an extra", () => {
    const [pip] = registries(CA_PIP);
    expect(renderPipConf([{ ...credential(pip!), token: "a/b+c=d-e_f.g~hijklmnop" }])).toBe(
      "[global]\nindex-url = https://aws:a%2Fb%2Bc%3Dd-e_f.g~hijklmnop@acme-123456789012.d.codeartifact.us-west-2.amazonaws.com/pypi/shared/simple/\n",
    );
    expect(renderPipConf([credential(pip!), credential({ ...pip!, name: "second" })])).toContain("extra-index-url = https://aws:");
  });
  it("maven: a server and a repository with the same id (the documented settings.xml)", () => {
    const [maven] = registries(CA_MVN);
    const xml = renderMavenSettings([credential(maven!)]);
    expect(xml).toContain(`<server><id>internal-maven</id><username>aws</username><password>${token}</password></server>`);
    expect(xml).toContain(`<repository><id>internal-maven</id><url>${maven!.url}</url></repository>`);
    expect(xml).toContain("<activeProfile>agentx-registries</activeProfile>");
  });
});

describe("a session", () => {
  it("writes the config outside every repository in a private folder, points the tools at it, and removes it", async () => {
    const root = await mkdtemp(join(tmpdir(), "registries-session-"));
    const token = fakeToken("s");
    const session = await openRegistrySession({ rootPath: root, registries: registries(CA, CA_PIP, CA_MVN), provider: providerOf({ "internal-npm": token, "internal-pypi": fakeToken("t"), "internal-maven": fakeToken("u") }) });
    // Location: a direct child of the workspace root (a repository's folder is always below it), never a repository.
    expect(session.directory.startsWith(`${root}/${REGISTRY_CONFIG_PREFIX}`)).toBe(true);
    expect(session.directory.slice(root.length + 1)).not.toContain("/");
    expect((await stat(session.directory)).mode & 0o777).toBe(0o700);
    for (const name of ["npmrc", "pip.conf", "settings.xml"]) expect((await stat(join(session.directory, name))).mode & 0o777).toBe(0o600);
    expect(session.environment.NPM_CONFIG_USERCONFIG).toBe(join(session.directory, "npmrc"));
    expect(session.environment.PIP_CONFIG_FILE).toBe(join(session.directory, "pip.conf"));
    expect(session.environment.MAVEN_ARGS).toBe(`-s ${join(session.directory, "settings.xml")}`);
    // The environment holds paths only.
    expect(JSON.stringify(session.environment)).not.toContain(token);
    expect(await filesCarrying(root, token)).toHaveLength(1);
    await session.dispose();
    expect(await leftovers(root)).toEqual([]);
    expect(await filesCarrying(root, token)).toEqual([]);
  });

  it("asks for every token before it writes a file: one refusal leaves nothing on the disk", async () => {
    const root = await mkdtemp(join(tmpdir(), "registries-session-"));
    const calls: string[] = [];
    const provider = async (registry: string): Promise<RegistryCredential> => { calls.push(registry); if (registry === "internal-pypi") throw new Error("denied"); return { token: fakeToken("v"), expiresAt: expiry() }; };
    await expect(openRegistrySession({ rootPath: root, registries: registries(CA, CA_PIP), provider })).rejects.toThrow("denied");
    expect(calls).toEqual(["internal-npm", "internal-pypi"]);
    expect(await leftovers(root)).toEqual([]);
  });

  it.each([
    ["a token with a brace (npm would expand it)", "abc${HOME}defghijklmnop"],
    ["a token with a quote", `abcdefghijklmnop"x`],
    ["a token with a semicolon (an ini comment)", "abcdefghijklmnop;x"],
  ])("refuses %s, with nothing written", async (_name, token) => {
    const root = await mkdtemp(join(tmpdir(), "registries-session-"));
    await expect(openRegistrySession({ rootPath: root, registries: registries(CA), provider: async () => ({ token, expiresAt: expiry() }) })).rejects.toThrow(/cannot use the credential/);
    expect(await leftovers(root)).toEqual([]);
  });

  it("refuses an expired credential", async () => {
    const root = await mkdtemp(join(tmpdir(), "registries-session-"));
    await expect(openRegistrySession({ rootPath: root, registries: registries(CA), provider: async () => ({ token: fakeToken("e"), expiresAt: new Date(Date.now() - 1000).toISOString() }) })).rejects.toThrow(/cannot use the credential/);
  });

  it("sweeps what a crashed preparation left, including a link (removed itself, never followed), and nothing else", async () => {
    const root = await mkdtemp(join(tmpdir(), "registries-session-"));
    await mkdir(join(root, `${REGISTRY_CONFIG_PREFIX}old`));
    await writeFile(join(root, `${REGISTRY_CONFIG_PREFIX}old`, "npmrc"), "x");
    await mkdir(join(root, "repo"));
    await writeFile(join(root, "repo", "keep.txt"), "keep");
    expect(await removeLeftoverRegistryConfigs(root)).toBe(1);
    expect(await readdir(root)).toEqual(["repo"]);
  });
});

describe("a preparation with registries", () => {
  it("runs the setup and readiness commands with the config, scrubs the token from everything the preparation writes, and leaves no file behind", async () => {
    const f = await fixture();
    const token = fakeToken("p");
    const rootPath = await f.workspace();
    // The setup step PRINTS the config (the worst a command can do with stdout): raw, and as base64, JSON and percent-encoded. The readiness step proves the file is read from where the tool is told.
    const manifest = await prepareWorkspace({
      rootPath, materializer: f.materializer, commandRunner: f.commandRunner, creationIdentity: "op",
      project: project(
        ['cat "$NPM_CONFIG_USERCONFIG"; printf %s "$(cat "$NPM_CONFIG_USERCONFIG")" | base64; node -e \'console.log(JSON.stringify(require("fs").readFileSync(process.env.NPM_CONFIG_USERCONFIG,"utf8")))\''],
        ['test -s "$NPM_CONFIG_USERCONFIG" && echo config-present'],
      ),
      registries: registries(CA), registryCredentialProvider: providerOf({ "internal-npm": token }),
    });
    expect(manifest.complete).toBe(true);
    // Positive control: the command did read the config (the registry line is not secret and survives; the token is replaced).
    expect(manifest.readinessResults[0]!.stdout).toContain("config-present");
    // The recorded manifest and the whole workspace carry no spelling of the token.
    expect(await filesCarrying(rootPath, token)).toEqual([]);
    expect(await leftovers(rootPath)).toEqual([]);
  });

  it("scrubs a failing step's message and the manifest's failure text, and keeps the registry line (positive control)", async () => {
    const f = await fixture();
    const token = fakeToken("f");
    const rootPath = await f.workspace();
    const failure = await prepareWorkspace({
      rootPath, materializer: f.materializer, commandRunner: f.commandRunner, creationIdentity: "op",
      // The bare token on a line of its own (the existing key-based redaction cannot know it) after the config itself.
      project: project(['cat "$NPM_CONFIG_USERCONFIG" >&2; sed -n "s/.*_authToken=//p" "$NPM_CONFIG_USERCONFIG" | head -1 >&2; exit 3']),
      registries: registries(CA), registryCredentialProvider: providerOf({ "internal-npm": token }),
    }).then(() => undefined, (error: Error) => error);
    expect(failure?.message).toContain("registry=https://acme-123456789012.d.codeartifact.us-west-2.amazonaws.com/npm/shared/");
    expect(failure?.message).toContain("[redacted]");
    for (const form of e2eSecretSpellings(token)) expect(failure?.message).not.toContain(form);
    expect(await filesCarrying(rootPath, token)).toEqual([]);
    const written = JSON.parse(await readFile(join(rootPath, ".agentx", "preparation-manifest.json"), "utf8")) as { failure?: string; complete: boolean };
    expect(written.complete).toBe(false);
    expect(written.failure).toContain("[redacted]");
    // Even a failed preparation removes the config.
    expect(await leftovers(rootPath)).toEqual([]);
  });

  it("stops the preparation when a setup step copied the token into the repository, so a pull request could never carry it", async () => {
    const f = await fixture();
    const token = fakeToken("c");
    const rootPath = await f.workspace();
    const failure = await prepareWorkspace({
      rootPath, materializer: f.materializer, commandRunner: f.commandRunner, creationIdentity: "op",
      project: project(['cp "$NPM_CONFIG_USERCONFIG" .npmrc']),
      registries: registries(CA), registryCredentialProvider: providerOf({ "internal-npm": token }),
    }).then(() => undefined, (error: Error) => error);
    expect(failure?.message).toMatch(/wrote a package registry token into the repository/);
    expect(await readFile(join(rootPath, "repo/api/.npmrc"), "utf8")).toContain(token.slice(0, 20)); // positive control: it really was copied
    expect(await leftovers(rootPath)).toEqual([]);
    // The failure the broker will see does not carry it either.
    expect((await readFile(join(rootPath, ".agentx", "preparation-manifest.json"), "utf8"))).not.toContain(token);
  });

  it("a project command's own env wins over the default, and a project without registries is untouched", async () => {
    const f = await fixture();
    const rootPath = await f.workspace();
    const manifest = await prepareWorkspace({
      rootPath, materializer: f.materializer, commandRunner: f.commandRunner, creationIdentity: "op",
      project: project([], ['echo "npmrc=${NPM_CONFIG_USERCONFIG:-unset}"']),
    });
    expect(manifest.readinessResults[0]!.stdout).toContain("npmrc=unset");
  });

  it("refuses a project with a devcontainer before it clones or asks for any token (the config folder is not mounted there)", async () => {
    const f = await fixture();
    const calls: string[] = [];
    await expect(prepareWorkspace({
      rootPath: await f.workspace(), materializer: f.materializer, creationIdentity: "op",
      project: project([], [], true), registries: registries(CA), registryCredentialProvider: providerOf({ "internal-npm": fakeToken("d") }, calls),
    })).rejects.toThrow(/devcontainer cannot use private package registries/);
    expect(calls).toEqual([]);
  });

  it("a registry whose token cannot be had fails the preparation with no setup command run and no unauthenticated retry", async () => {
    const f = await fixture();
    const rootPath = await f.workspace();
    const ran = vi.fn(f.commandRunner);
    await expect(prepareWorkspace({
      rootPath, materializer: f.materializer, commandRunner: ran, creationIdentity: "op",
      project: project(["echo should-not-run"]),
      registries: registries(CA), registryCredentialProvider: async () => { throw new Error("Rovara could not get a token for the package registry \"internal-npm\""); },
    })).rejects.toThrow(/internal-npm/);
    expect(ran).not.toHaveBeenCalled();
    expect(await leftovers(rootPath)).toEqual([]);
  });

  it("asks for the tokens before the first clone, so a slow clone cannot outlast the grant that authorizes the request", async () => {
    const f = await fixture();
    const order: string[] = [];
    await prepareWorkspace({
      rootPath: await f.workspace(), commandRunner: f.commandRunner, creationIdentity: "op", project: project([]),
      materializer: async (repo, target, credential) => { order.push("clone"); await f.materializer(repo, target, credential); },
      registries: registries(CA), registryCredentialProvider: async () => { order.push("token"); return { token: fakeToken("o"), expiresAt: expiry() }; },
    });
    expect(order).toEqual(["token", "clone"]);
  });

  it("removes a crashed preparation's leftover config at the start of the next one", async () => {
    const f = await fixture();
    const rootPath = await f.workspace();
    await mkdir(join(rootPath, `${REGISTRY_CONFIG_PREFIX}crashed`), { recursive: true });
    await writeFile(join(rootPath, `${REGISTRY_CONFIG_PREFIX}crashed`, "npmrc"), "_authToken=old");
    await prepareWorkspace({ rootPath, materializer: f.materializer, commandRunner: f.commandRunner, creationIdentity: "op", project: project([]) });
    expect(await leftovers(rootPath)).toEqual([]);
  });
});

describe("the worker's request for a token", () => {
  const invocation = { workspaceId: "11111111-1111-4111-8111-111111111111", operationId: "22222222-2222-4222-8222-222222222222", payload: { repositoryGrant: "signed-grant" } } as never;
  it("names the registry and presents the preparation's grant, and reads a strict answer", async () => {
    const token = fakeToken("w");
    const send = vi.fn(async () => new Response(JSON.stringify({ credential: { username: "aws", token, expiresAt: expiry() } }), { status: 200 }));
    const credential = await createRegistryCredentialProvider({ controlPlaneUrl: "https://broker.example/", invocation, fetchImplementation: send })("internal-npm");
    expect(credential.token).toBe(token);
    const [url, init] = send.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://broker.example/v1/internal/workspaces/11111111-1111-4111-8111-111111111111/operations/22222222-2222-4222-8222-222222222222/registry-credentials");
    expect(init.headers).toMatchObject({ "x-agentx-repository-grant": "signed-grant" });
    expect(JSON.parse(init.body as string)).toEqual({ registry: "internal-npm" });
  });
  it("carries nothing of a refusal or an unreadable answer: a fixed sentence naming the registry", async () => {
    for (const response of [new Response(`denied ${fakeToken("n")}`, { status: 403 }), new Response(JSON.stringify({ credential: { token: "short" } }), { status: 200 }), new Response("not json", { status: 200 })]) {
      const failure = await createRegistryCredentialProvider({ controlPlaneUrl: "https://broker.example", invocation, fetchImplementation: async () => response })("internal-npm").then(() => undefined, (error: Error) => error);
      expect(failure?.message).toContain('Rovara could not get a token for the package registry "internal-npm"');
      expect(failure?.message).not.toContain("denied");
    }
  });
  it("is listed on /ping, so the broker sends registries to this worker", () => {
    expect(WORKER_IMPLEMENTED_FEATURES).toContain("prepare.registries.v1");
  });
});

void dirname;
