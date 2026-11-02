// N9 (INTG2): a project's registries for the setup and readiness commands of a preparation, and nothing else.
//
// For the length of one preparation the worker
//   1. asks the broker for each registry's short-lived, read-only token (registry-credentials.ts);
//   2. writes the package managers' config (an npmrc, a pip.conf, a Maven settings.xml) to a private directory OUTSIDE every repository (`<workspace>/.agentx-registry-<random>`, mode 0700,
//      files 0600; a repository's folder is always below the workspace root, never the root), and points the tools at it with NPM_CONFIG_USERCONFIG, PIP_CONFIG_FILE and MAVEN_ARGS,
//      so no file is ever put in a repository, a home folder or the agent's reach;
//   3. scrubs every command's output (and any error) for the tokens, in every spelling, before it can reach the manifest, a log or a callback;
//   4. looks for a token a setup step copied into a repository's changes, and fails the preparation if one did;
//   5. removes the directory when the preparation ends, and sweeps leftovers of a crashed one at start.
// A token that cannot be written safely (not URL-safe), a registry that cannot be reached, or a project with a devcontainer (the folder is not mounted there) fails the
// preparation with a fixed sentence. There is no unauthenticated retry and no fall-back to a public mirror.
import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { REGISTRY_TOKEN_MIN_LENGTH, agentXError, scrubRegistrySecrets, e2eSecretSpellings, type PrepareRegistry, type ProjectCommand, type RegistryCredential } from "@agentx/contracts";
import type { CommandResult } from "./readiness.js";
import type { RegistryCredentialProvider } from "./registry-credentials.js";
import { runIsolatedGit } from "./isolated-repository.js";

export const REGISTRY_CONFIG_PREFIX = ".agentx-registry-";
/** What a token may be made of for the config files to carry it without quoting or expansion (every CodeArtifact token is). */
const SAFE_TOKEN = /^[A-Za-z0-9._~+/=-]+$/;
const SAFE_USERNAME = /^[A-Za-z0-9._~@-]{1,128}$/;

export type PreparedCredential = { registry: PrepareRegistry; username: string; token: string };

const xml = (value: string): string => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

/** npm's `//host/path/` key for a registry URL (npm-auth.html): the URL without its scheme. */
const npmKey = (url: string): string => url.replace(/^https:/, "");

/** The npmrc: the registry line (per scope), and the token for that registry's URL. https://docs.aws.amazon.com/codeartifact/latest/ug/npm-auth.html */
export function renderNpmrc(entries: readonly PreparedCredential[]): string {
  const lines: string[] = [];
  for (const { registry, token } of entries) {
    lines.push(registry.scope === undefined ? `registry=${registry.url}` : `${registry.scope}:registry=${registry.url}`);
    lines.push(`${npmKey(registry.url)}:_authToken=${token}`, `${npmKey(registry.url)}:always-auth=true`);
  }
  return `${lines.join("\n")}\n`;
}

/** The pip.conf: the first index is `index-url`, the rest `extra-index-url`. The user name and token sit in the URL (python-configure-pip.html), percent-encoded. */
export function renderPipConf(entries: readonly PreparedCredential[]): string {
  const urls = entries.map(({ registry, username, token }) => registry.url.replace(/^https:\/\//, `https://${encodeURIComponent(username)}:${encodeURIComponent(token)}@`));
  const lines = ["[global]", `index-url = ${urls[0]!}`];
  if (urls.length > 1) lines.push(`extra-index-url = ${urls.slice(1).join("\n    ")}`);
  return `${lines.join("\n")}\n`;
}

/** The Maven settings.xml: a server (the credential) and a repository (the address) with the same id, as maven-mvn.html requires. */
export function renderMavenSettings(entries: readonly PreparedCredential[]): string {
  const servers = entries.map(({ registry, username, token }) => `    <server><id>${xml(registry.name)}</id><username>${xml(username)}</username><password>${xml(token)}</password></server>`);
  const repositories = entries.map(({ registry }) => `        <repository><id>${xml(registry.name)}</id><url>${xml(registry.url)}</url></repository>`);
  const plugins = entries.map(({ registry }) => `        <pluginRepository><id>${xml(registry.name)}</id><url>${xml(registry.url)}</url></pluginRepository>`);
  return `<settings>\n  <servers>\n${servers.join("\n")}\n  </servers>\n  <profiles>\n    <profile>\n      <id>agentx-registries</id>\n      <repositories>\n${repositories.join("\n")}\n      </repositories>\n      <pluginRepositories>\n${plugins.join("\n")}\n      </pluginRepositories>\n    </profile>\n  </profiles>\n  <activeProfiles><activeProfile>agentx-registries</activeProfile></activeProfiles>\n</settings>\n`;
}

export interface RegistrySession {
  /** Where the config lives (for a test; nothing else reads it). */
  readonly directory: string;
  /** The variables that point the tools at the files. Paths only. */
  readonly environment: Readonly<Record<string, string>>;
  /** The tokens, for scrubbing. */
  readonly secrets: readonly string[];
  /** A command runner whose commands carry the environment, and whose results and errors are scrubbed. */
  wrap<Run extends (command: ProjectCommand, index: number, rootPath: string) => Promise<CommandResult>>(run: Run): Run;
  scrub(text: string): string;
  /** Fails if a token is in any file the repository now has changed or untracked. */
  assertTokenNotInRepository(repositoryDirectory: string): Promise<void>;
  dispose(): Promise<void>;
}

export async function openRegistrySession(input: {
  rootPath: string;
  registries: readonly PrepareRegistry[];
  provider: RegistryCredentialProvider;
  onDiagnostic?: (message: string) => void;
}): Promise<RegistrySession> {
  const root = resolve(input.rootPath);
  const credentials: PreparedCredential[] = [];
  // Every token is asked for before any file is written, so one refusal leaves nothing behind.
  for (const registry of input.registries) {
    const credential: RegistryCredential = await input.provider(registry.name);
    const username = credential.username ?? "token";
    if (!SAFE_TOKEN.test(credential.token) || !SAFE_USERNAME.test(username) || credential.token.length < REGISTRY_TOKEN_MIN_LENGTH || Date.parse(credential.expiresAt) <= Date.now()) {
      throw agentXError("RUNTIME_UNAVAILABLE", `Rovara cannot use the credential of the package registry "${registry.name}"`);
    }
    credentials.push({ registry, username, token: credential.token });
  }
  const secrets = credentials.map((entry) => entry.token);
  const scrub = (text: string): string => scrubRegistrySecrets(text, secrets);

  const directory = join(root, `${REGISTRY_CONFIG_PREFIX}${randomUUID()}`);
  const environment: Record<string, string> = {};
  const write = async (name: string, content: string): Promise<string> => {
    const path = join(directory, name);
    await writeFile(path, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
    return path;
  };
  const remove = async (): Promise<void> => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await rm(directory, { recursive: true, force: true }).catch(() => undefined);
      if (await lstat(directory).then(() => false, () => true)) return;
    }
    // Nothing the next start does not also sweep (`removeLeftoverRegistryConfigs`); the token lasts an hour at most. It is said, without the path's contents.
    input.onDiagnostic?.("AgentX could not remove a package registry's config at the end of the preparation; it will be removed at the next start");
  };
  try {
    await mkdir(directory, { mode: 0o700 });
    const byFormat = (format: PrepareRegistry["format"]) => credentials.filter((entry) => entry.registry.format === format);
    if (byFormat("npm").length > 0) environment.NPM_CONFIG_USERCONFIG = await write("npmrc", renderNpmrc(byFormat("npm")));
    if (byFormat("pypi").length > 0) environment.PIP_CONFIG_FILE = await write("pip.conf", renderPipConf(byFormat("pypi")));
    if (byFormat("maven").length > 0) environment.MAVEN_ARGS = `-s ${await write("settings.xml", renderMavenSettings(byFormat("maven")))}`;
  } catch (error) {
    await remove();
    throw agentXError("RUNTIME_UNAVAILABLE", `Rovara could not prepare the package registry config: ${error instanceof Error && "code" in error ? String((error as NodeJS.ErrnoException).code) : "failed"}`);
  }

  return {
    directory,
    environment,
    secrets,
    scrub,
    wrap(run) {
      const wrapped = async (command: ProjectCommand, index: number, rootPath: string): Promise<CommandResult> => {
        // The project's own `env` wins, as it does over every default of the sandbox.
        const withEnvironment: ProjectCommand = { ...command, env: { ...environment, ...command.env } };
        try {
          const result = await run(withEnvironment, index, rootPath);
          return { ...result, stdout: scrub(result.stdout), stderr: scrub(result.stderr) };
        } catch (error) {
          throw error instanceof Error ? Object.assign(new Error(scrub(error.message)), { name: error.name }) : new Error("command failed");
        }
      };
      return wrapped as typeof run;
    },
    async assertTokenNotInRepository(repositoryDirectory) {
      const forms = new Set(secrets.flatMap((secret) => e2eSecretSpellings(secret)).filter((form) => form.length >= 6));
      const listed = await runIsolatedGit(repositoryDirectory, ["status", "--porcelain", "-z", "--untracked-files=all"], { timeout: 60_000, maxBuffer: 4 * 1024 * 1024 }).catch(() => undefined);
      // Unknowable is not clean: a repository whose changes cannot be listed is not trusted to be free of the token.
      if (listed === undefined) throw agentXError("RUNTIME_UNAVAILABLE", "Rovara could not check that a setup step kept the package registry token out of the repository");
      for (const entry of listed.split("\0").filter((item) => item.length > 3)) {
        const path = join(repositoryDirectory, entry.slice(3));
        const info = await stat(path).catch(() => undefined);
        if (info === undefined || !info.isFile() || info.size > 4 * 1024 * 1024) continue;
        const text = await readFile(path, "utf8").catch(() => "");
        if ([...forms].some((form) => text.includes(form))) throw agentXError("RUNTIME_UNAVAILABLE", "A setup step wrote a package registry token into the repository, so the preparation was stopped");
      }
    },
    dispose: remove,
  };
}

/** At start (and before a preparation): removes the config a crashed preparation left. A symbolic link is removed itself, never followed. */
export async function removeLeftoverRegistryConfigs(rootPath: string): Promise<number> {
  const root = resolve(rootPath);
  const names = await readdir(root).catch(() => [] as string[]);
  let removed = 0;
  for (const name of names.filter((entry) => entry.startsWith(REGISTRY_CONFIG_PREFIX))) {
    await rm(join(root, name), { recursive: true, force: true }).then(() => { removed += 1; }, () => undefined);
  }
  return removed;
}
