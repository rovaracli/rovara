// Stdio MCP host redesign (T3), design section 4: the install task's program. It runs in the runner image as an unprivileged user, in a task that has no task role and no secrets,
// and its egress is the registry and the controller only. It turns an admin-named package into the pinned bundle the approval binds:
//
//   1. `npm pack <name>@<version> --ignore-scripts`, hash the tarball; if the admin typed an integrity it must equal it.
//   2. Unpack it (in plain Node: the image has no `tar`). If it ships `npm-shrinkwrap.json`, that is the lockfile; otherwise make one with `npm install --package-lock-only`.
//   3. Check the lockfile against the dependency rules BEFORE anything else is fetched (gateway/mcp-runner/lockfile-policy.ts).
//   4. `npm ci --ignore-scripts --omit=dev --no-audit --no-fund`, with a scrubbed environment and no git. Check what was installed against the same rules again.
//   5. Normalise the tree, write the deterministic tar, hash it.
//   6. Upload the tar to the controller under its hash and report.
//
// No package code runs: scripts are off at every npm call, nothing in the tree is executed, and `git` does not exist for npm to call. Every failure is a fixed code and sentence;
// npm's own text (which holds addresses, paths and package contents) is read only to pick a code and is never kept, logged or shown.
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { dirname, isAbsolute, join } from "node:path";
import { McpStdioProposalSchema, type McpStdioProposal } from "@agentx/contracts";
import {
  BUNDLE_LIMITS, BundleError, INSTALL_STEPS_SENTENCE, LOCKFILE_LIMITS, runsAsRoot, NpmTarballError, binOf, checkLockfile, extractNpmTarball, lockfileHash, normalizeTree, writeBundle,
  type LockfileRule, type LockfileVerdict,
} from "@agentx/gateway";

// ---------------------------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------------------------

export const INSTALL_FAILURES = {
  invalid_request: "That package name or version cannot be installed.",
  integrity_mismatch: "The package's checksum is not the one you typed.",
  not_found: "Your registry does not have that package or version.",
  download_failed: "Rovara could not download that package from your registry.",
  bad_package: "The package file is not one Rovara can unpack.",
  wrong_package: "Your registry returned a different package from the one asked for.",
  git_dependency: "This package needs a git dependency. Rovara installs only from your registry.",
  unsupported_manifest: "This package changes the versions of its dependencies with overrides or resolutions. Rovara does not support that in this version.",
  install_scripts: "This package needs install steps or a native build. Rovara does not run install steps, so this package cannot be used yet.",
  lockfile_policy: "This package's dependencies are not allowed.",
  resolve_failed: "Rovara could not work out this package's dependencies from your registry.",
  install_failed: "Rovara could not install this package's dependencies from your registry.",
  no_program: "This package does not offer a program Rovara can run.",
  too_large: "This package is larger than Rovara allows.",
  timed_out: "Installing this package took longer than Rovara allows.",
  bundle_failed: "Rovara could not prepare this package to run.",
  upload_failed: "Rovara could not store the prepared package.",
} as const;
export type InstallFailureCode = keyof typeof INSTALL_FAILURES;

export interface InstallReport {
  /** `sha512-…` of the tarball as the registry served it. */
  integrity: string;
  /** sha256 of the lockfile the install used. */
  lockfileHash: string;
  /** sha256 of the deterministic bundle. */
  bundleHash: string;
  /** Packages installed, the package itself included. */
  packageCount: number;
  unpackedBytes: number;
  tarBytes: number;
  /** The program the server runs, relative to the bundle's top folder, run as `node <bin>`. */
  bin: string;
}

export type InstallResult =
  | { ok: true; report: InstallReport; bundlePath: string }
  | {
    ok: false; code: InstallFailureCode; sentence: string;
    /** For `lockfile_policy`: which rule, and the package, when one is to blame. */
    rule?: LockfileRule; package?: string;
    /** For `integrity_mismatch`: the checksum the registry's tarball really has, which the admin is shown. */
    computedIntegrity?: string;
  };

function failure(code: InstallFailureCode, extra: { sentence?: string; rule?: LockfileRule; package?: string; computedIntegrity?: string } = {}): InstallResult {
  return { ok: false, code, sentence: extra.sentence ?? INSTALL_FAILURES[code], ...(extra.rule === undefined ? {} : { rule: extra.rule }), ...(extra.package === undefined ? {} : { package: extra.package }), ...(extra.computedIntegrity === undefined ? {} : { computedIntegrity: extra.computedIntegrity }) };
}

// ---------------------------------------------------------------------------------------------
// Running npm
// ---------------------------------------------------------------------------------------------

export interface ExecInput { file: string; args: string[]; cwd: string; env: Record<string, string>; timeoutMs: number }
export interface ExecOutput { code: number | null; timedOut: boolean; stdout: string; /** The last part of stderr. Used to pick a failure code, never kept or shown. */ stderr: string }
export type Exec = (input: ExecInput) => Promise<ExecOutput>;

const OUTPUT_LIMIT = 1_048_576;
const STDERR_TAIL = 16_384;

/** Runs a program with no shell, in its own process group so that a timeout takes everything it started. */
export const defaultExec: Exec = (input) => new Promise((resolve) => {
  let stdout = "";
  let stderr = "";
  let timedOut = false;
  let settled = false;
  const child = spawn(input.file, input.args, { cwd: input.cwd, env: input.env, shell: false, detached: true, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  const killGroup = () => { try { if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL"); } catch { /* already gone */ } };
  const timer = setTimeout(() => { timedOut = true; killGroup(); }, input.timeoutMs);
  const done = (code: number | null) => { if (settled) return; settled = true; clearTimeout(timer); killGroup(); resolve({ code, timedOut, stdout, stderr }); };
  child.stdout.on("data", (chunk: Buffer) => { if (stdout.length < OUTPUT_LIMIT) stdout += chunk.toString("utf8"); else killGroup(); });
  child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString("utf8")).slice(-STDERR_TAIL); });
  child.on("error", () => done(null));
  child.on("close", (code) => done(code));
});

/** Where npm's command line is: next to the node that runs this (the image has node and npm, and no `npm` shell script on a PATH). */
export function defaultNpmCli(): string {
  return join(dirname(process.execPath), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js");
}

/**
 * The environment npm gets. Nothing is inherited: no token, no cloud credential, no proxy, no npmrc. The registry is the install's one registry, scripts are off, and `git` is a
 * path that does not exist, so a git dependency cannot be fetched even if one got past the lockfile check.
 */
export function npmEnvironment(input: { work: string; registry: string; caFile?: string | undefined; nodeDirectory: string }): Record<string, string> {
  const home = join(input.work, "home");
  // npm refuses one file as both its user and its global config, so there are two empty ones.
  return {
    PATH: input.nodeDirectory, HOME: home, TMPDIR: join(input.work, "tmp"), NODE_ENV: "production",
    npm_config_registry: input.registry, npm_config_cache: join(input.work, "cache"), npm_config_userconfig: join(home, "empty-user-npmrc"), npm_config_globalconfig: join(home, "empty-global-npmrc"), npm_config_prefix: join(input.work, "prefix"),
    npm_config_git: "/nonexistent/git", npm_config_ignore_scripts: "true", npm_config_audit: "false", npm_config_fund: "false", npm_config_update_notifier: "false",
    npm_config_progress: "false", npm_config_loglevel: "error", npm_config_strict_ssl: "true", npm_config_fetch_retries: "1", npm_config_fetch_timeout: "60000",
    ...(input.caFile === undefined ? {} : { npm_config_cafile: input.caFile }),
  };
}

/** Picks a fixed failure code from npm's error output, which is then dropped. */
function classify(stderr: string, fallback: "download_failed" | "resolve_failed" | "install_failed"): InstallFailureCode {
  if (/\/nonexistent\/git|\bgit\b.*\b(ENOENT|spawn)\b|\bENOENT\b.*\bgit\b/iu.test(stderr)) return "git_dependency";
  if (/\bE404\b|\b404 Not Found\b|\bETARGET\b|\bnotarget\b/iu.test(stderr)) return "not_found";
  return fallback;
}

// ---------------------------------------------------------------------------------------------
// The install
// ---------------------------------------------------------------------------------------------

export interface InstallLimits {
  maxPackages: number;
  maxUnpackedBytes: number;
  maxEntries: number;
  /** For the whole install. The design's default is 3 minutes. */
  timeoutMs: number;
}

export const INSTALL_LIMITS: InstallLimits = { maxPackages: LOCKFILE_LIMITS.maxPackages, maxUnpackedBytes: BUNDLE_LIMITS.maxUnpackedBytes, maxEntries: BUNDLE_LIMITS.maxEntries, timeoutMs: 180_000 };

export interface InstallOptions {
  /** The install's one registry (`rovaraMcpNpmRegistry`): https. */
  registry: string;
  /** An empty or new folder this install may fill. */
  workDir: string;
  /** A certificate file for a registry with a private authority. */
  caFile?: string | undefined;
  limits?: Partial<InstallLimits>;
  exec?: Exec;
  npmCli?: string;
  now?: () => number;
}

const SPEC_FORBIDDEN = /^(?:git(?:\+[a-z]+)?|github|gitlab|bitbucket|gist|file|link|http|https|ssh|workspace|portal|patch):/iu;
/** A dependency range in a package.json that is not a registry range: a git address, a path, a URL, `user/repo`. */
function specIsNotRegistry(spec: unknown): boolean {
  if (typeof spec !== "string") return true;
  const trimmed = spec.trim();
  if (SPEC_FORBIDDEN.test(trimmed)) return true;
  // `npm:@scope/name@range` is an alias; its address is checked in the lockfile. A bare `a/b` is a GitHub shorthand; a path starts with `.`, `/`, `~`.
  if (trimmed.startsWith("npm:")) return false;
  return /^[./~]/u.test(trimmed) || trimmed.includes("/") || /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+/u.test(trimmed);
}

async function readJson(path: string, maxBytes = 1_048_576): Promise<Record<string, unknown> | undefined> {
  try {
    if ((await stat(path)).size > maxBytes) return undefined;
    const value = JSON.parse(await readFile(path, "utf8")) as unknown;
    return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  } catch { return undefined; }
}

const NPM_NAME = /^(?:@[a-z0-9][a-z0-9._-]{0,60}\/)?[a-z0-9][a-z0-9._-]{0,60}$/u;

/** The lifecycle scripts that run when a package is installed (or prepared). Any one of them makes a package one Rovara refuses in this version. */
const INSTALL_SCRIPTS = ["preinstall", "install", "postinstall", "prepare"] as const;

/** Whether a package's manifest, or a binding.gyp beside it, says it needs an install step or a native build. */
export function needsInstallSteps(manifest: Record<string, unknown>, hasBindingGyp: boolean): boolean {
  const scripts = manifest.scripts;
  if (typeof scripts === "object" && scripts !== null && !Array.isArray(scripts) && INSTALL_SCRIPTS.some((name) => Object.hasOwn(scripts, name))) return true;
  return manifest.gypfile === true || hasBindingGyp;
}

async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; } catch { return false; }
}

/**
 * Installs the package into `options.workDir` and leaves the bundle at `<workDir>/bundle.tar`. Nothing here uploads it or reads a secret.
 */
export async function runInstall(requested: unknown, options: InstallOptions): Promise<InstallResult> {
  const limits: InstallLimits = { ...INSTALL_LIMITS, ...options.limits };
  const exec = options.exec ?? defaultExec;
  const now = options.now ?? Date.now;
  const startedAt = now();
  const remaining = (): number => limits.timeoutMs - (now() - startedAt);

  const parsed = McpStdioProposalSchema.safeParse(requested);
  if (!parsed.success) return failure("invalid_request");
  const request: McpStdioProposal = parsed.data;
  let registry: string;
  try {
    const url = new URL(options.registry);
    if (url.protocol !== "https:" || url.username !== "" || url.password !== "") return failure("invalid_request");
    registry = url.href;
  } catch { return failure("invalid_request"); }

  // The folder is where everything is made (the cache, the home, the tree): it is named in full, so that a mistake cannot fill the folder the process happens to be in.
  if (!isAbsolute(options.workDir)) return failure("invalid_request");
  const work = options.workDir;
  const pack = join(work, "pack");
  const pkg = join(work, "pkg");
  const bundlePath = join(work, "bundle.tar");
  for (const folder of ["home", "tmp", "cache", "prefix", "pack"]) await mkdir(join(work, folder), { recursive: true });
  await writeFile(join(work, "home", "empty-user-npmrc"), "");
  await writeFile(join(work, "home", "empty-global-npmrc"), "");
  const npmCli = options.npmCli ?? defaultNpmCli();
  const environment = npmEnvironment({ work, registry, caFile: options.caFile, nodeDirectory: dirname(process.execPath) });
  const npm = async (args: string[], cwd: string, step: "download_failed" | "resolve_failed" | "install_failed"): Promise<{ ok: true; stdout: string } | { ok: false; result: InstallResult }> => {
    const budget = remaining();
    if (budget <= 0) return { ok: false, result: failure("timed_out") };
    const output = await exec({ file: process.execPath, args: [npmCli, ...args], cwd, env: environment, timeoutMs: budget });
    if (output.timedOut) return { ok: false, result: failure("timed_out") };
    if (output.code !== 0) return { ok: false, result: failure(classify(output.stderr, step)) };
    return { ok: true, stdout: output.stdout };
  };

  // 1. The tarball, and its integrity.
  const packed = await npm(["pack", `${request.name}@${request.version}`, "--pack-destination", pack, "--ignore-scripts", "--json"], pack, "download_failed");
  if (!packed.ok) return packed.result;
  let filename: unknown;
  try { filename = (JSON.parse(packed.stdout) as Array<{ filename?: unknown }>)[0]?.filename; } catch { return failure("download_failed"); }
  if (typeof filename !== "string" || !/^[A-Za-z0-9._@+-]+\.tgz$/u.test(filename)) return failure("download_failed");
  const tarball = join(pack, filename);
  let tarballInfo;
  try { tarballInfo = await stat(tarball); } catch { return failure("download_failed"); }
  if (!tarballInfo.isFile()) return failure("download_failed");
  if (tarballInfo.size > limits.maxUnpackedBytes) return failure("too_large");
  const integrity = await new Promise<string>((resolve, reject) => {
    const hash = createHash("sha512");
    createReadStream(tarball).on("data", (chunk) => hash.update(chunk)).on("error", reject).on("end", () => resolve(`sha512-${hash.digest("base64")}`));
  }).catch(() => undefined);
  if (integrity === undefined) return failure("download_failed");
  if (request.integrity !== undefined && integrity !== request.integrity) return failure("integrity_mismatch", { computedIntegrity: integrity });

  // 2. Unpack, and check it is the package that was asked for.
  try {
    await extractNpmTarball(tarball, pkg, join(work, "unpack.tar"), { maxEntries: limits.maxEntries, maxUnpackedBytes: limits.maxUnpackedBytes });
  } catch (error) {
    if (error instanceof NpmTarballError) return failure(error.code);
    return failure("bad_package");
  }
  const manifest = await readJson(join(pkg, "package.json"));
  if (manifest === undefined) return failure("bad_package");
  if (manifest.name !== request.name || manifest.version !== request.version) return failure("wrong_package");
  // A package that needs install steps or a native build is refused (owner decision for v1): the package itself here, every package it brings after `npm ci` below.
  if (needsInstallSteps(manifest, await exists(join(pkg, "binding.gyp")))) return failure("install_scripts", { sentence: INSTALL_STEPS_SENTENCE(undefined).replace("A dependency", "This package"), package: request.name });
  // The folder npm runs in must be only what the lockfile says: no author-supplied lock beside the one we check, no npmrc (dropped when unpacking).
  await rm(join(pkg, "package-lock.json"), { force: true });

  // 3. The lockfile: the package's own shrinkwrap, or one made now from the registry. Either way it is checked before a single dependency is fetched.
  // Before npm runs at all (with a shipped shrinkwrap as much as without): `overrides` and `resolutions` can send any dependency to any address, and a dependency range that is
  // a git address, a path or a URL is not a registry range. Neither is looked at by the lockfile check until npm has already tried to fetch it.
  if (manifest.overrides !== undefined || manifest.resolutions !== undefined) return failure("unsupported_manifest");
  for (const field of ["dependencies", "optionalDependencies", "peerDependencies"] as const) {
    const table = manifest[field];
    if (table === undefined) continue;
    if (typeof table !== "object" || table === null || Array.isArray(table) || Object.values(table as Record<string, unknown>).some(specIsNotRegistry)) return failure("git_dependency", { sentence: "This package needs a dependency that does not come from your registry. Rovara installs only from your registry." });
  }
  const shrinkwrap = join(pkg, "npm-shrinkwrap.json");
  let lockfilePath = shrinkwrap;
  if (!await exists(shrinkwrap)) {
    // Only what a production install needs: dev dependencies, workspaces and scripts are removed from the copy of package.json that npm resolves.
    for (const field of ["devDependencies", "workspaces", "scripts"]) delete manifest[field];
    await writeFile(join(pkg, "package.json"), JSON.stringify(manifest));
    const made = await npm(["install", "--package-lock-only", "--ignore-scripts", "--omit=dev", "--no-audit", "--no-fund"], pkg, "resolve_failed");
    if (!made.ok) return made.result;
    lockfilePath = join(pkg, "package-lock.json");
  }
  let lockfileBytes: Buffer;
  try { lockfileBytes = await readFile(lockfilePath); } catch { return failure("resolve_failed"); }
  const verdict = checkLockfile(lockfileBytes, { registry, maxPackages: limits.maxPackages });
  if (!verdict.ok) return failure("lockfile_policy", { sentence: verdict.sentence, rule: verdict.rule, ...(verdict.package === undefined ? {} : { package: verdict.package }) });

  // 4. Install from the lockfile, and check what is on disk against the same rules.
  const installed = await npm(["ci", "--ignore-scripts", "--omit=dev", "--no-audit", "--no-fund"], pkg, "install_failed");
  if (!installed.ok) return installed.result;
  // npm writes `node_modules/.package-lock.json` when it installs anything. A package with no dependencies installs nothing and leaves no such file; any other lockfile that
  // leaves none is a failed install, not a package with nothing in it.
  let after: LockfileVerdict = { ok: true, packageCount: 0 };
  const hiddenPath = join(pkg, "node_modules", ".package-lock.json");
  if (verdict.packageCount > 0 || await exists(hiddenPath)) {
    let hidden: Buffer;
    try { hidden = await readFile(hiddenPath); } catch { return failure("install_failed"); }
    after = checkLockfile(hidden, { registry, maxPackages: limits.maxPackages });
    if (!after.ok) return failure("lockfile_policy", { sentence: after.sentence, rule: after.rule, ...(after.package === undefined ? {} : { package: after.package }) });
    // The lockfile's `hasInstallScript` comes from the registry's metadata; the installed package.json files are read too, so a registry that does not say is not believed.
    const paths = Object.keys((JSON.parse(hidden.toString("utf8")) as { packages?: Record<string, unknown> }).packages ?? {}).filter((key) => key !== "");
    for (const path of paths) {
      const folder = join(pkg, ...path.split("/"));
      const installedManifest = await readJson(join(folder, "package.json"));
      if (installedManifest !== undefined && needsInstallSteps(installedManifest, await exists(join(folder, "binding.gyp")))) {
        const name = path.slice(path.lastIndexOf("node_modules/") + "node_modules/".length);
        const shown = NPM_NAME.test(name) ? name : undefined;
        return failure("install_scripts", { sentence: INSTALL_STEPS_SENTENCE(shown), ...(shown === undefined ? {} : { package: shown }) });
      }
    }
  }
  if (!after.ok) return failure("install_failed");

  // 5. The program, the normalised tree, the bundle.
  const bin = binOf(request.name, manifest);
  if (bin === undefined) return failure("no_program");
  try {
    const file = await lstat(join(pkg, ...bin.split("/")));
    if (!file.isFile()) return failure("no_program");
  } catch { return failure("no_program"); }
  try {
    await normalizeTree(pkg, { maxEntries: limits.maxEntries, maxUnpackedBytes: limits.maxUnpackedBytes });
    const info = await writeBundle(pkg, bundlePath, { maxEntries: limits.maxEntries, maxUnpackedBytes: limits.maxUnpackedBytes });
    return {
      ok: true, bundlePath,
      report: {
        integrity, lockfileHash: lockfileHash(lockfileBytes), bundleHash: info.bundleHash, packageCount: after.packageCount + 1, unpackedBytes: info.unpackedBytes, tarBytes: info.tarBytes,
        bin,
      },
    };
  } catch (error) {
    if (error instanceof BundleError && (error.code === "too_large" || error.code === "too_many_files")) return failure("too_large");
    return failure("bundle_failed");
  }
}

// ---------------------------------------------------------------------------------------------
// Handing the bundle to the controller
// ---------------------------------------------------------------------------------------------

export interface BundleUploader { upload(input: { bundlePath: string; bundleHash: string; tarBytes: number }): Promise<void> }

/** The controller's address: https, or http only on this machine's own loopback (a test controller never leaves it). The bearer token travels only over TLS. */
export function assertSecureControllerUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("the controller address is not a web address"); }
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) throw new Error("the controller must be reached over https");
  if (url.username !== "" || url.password !== "") throw new Error("the controller address must not hold a login");
  return url;
}

/** `PUT /bundles/{bundleHash}` with the per-task token. The controller hashes what it receives and keeps it only under that hash. */
export function controllerUploader(input: { url: string; token: string; timeoutMs?: number; caFile?: string | undefined; ca?: string | undefined }): BundleUploader {
  const base = assertSecureControllerUrl(input.url);
  return {
    async upload({ bundlePath, bundleHash, tarBytes }) {
      if (!/^[0-9a-f]{64}$/u.test(bundleHash)) throw new Error("bad bundle hash");
      const target = new URL(`${base.href.replace(/\/$/u, "")}/bundles/${bundleHash}`);
      const send = target.protocol === "https:" ? httpsRequest : httpRequest;
      await new Promise<void>((resolve, reject) => {
        const req = send(target, {
          method: "PUT", timeout: input.timeoutMs ?? 120_000,
          headers: { authorization: `Bearer ${input.token}`, "content-type": "application/x-tar", "content-length": String(tarBytes) },
          ...(input.ca === undefined ? {} : { ca: input.ca }),
        }, (response) => {
          response.resume();
          response.on("end", () => ((response.statusCode ?? 0) >= 200 && (response.statusCode ?? 0) < 300 ? resolve() : reject(new Error("controller refused"))));
        });
        req.on("timeout", () => req.destroy(new Error("controller timed out")));
        req.on("error", (error) => reject(error));
        const source = createReadStream(bundlePath);
        source.on("error", (error) => req.destroy(error));
        source.pipe(req);
      });
    },
  };
}

// ---------------------------------------------------------------------------------------------
// The task's entry point
// ---------------------------------------------------------------------------------------------

const RESULT_PREFIX = "ROVARA_MCP_INSTALL_RESULT ";

function boundedNumber(text: string | undefined, fallback: number, min: number, max: number): number {
  if (text === undefined || !/^\d{1,12}$/u.test(text)) return fallback;
  return Math.min(max, Math.max(min, Number(text)));
}

export interface MainDependencies {
  env: Record<string, string | undefined>;
  getuid?: () => number | undefined;
  getgid?: () => number | undefined;
  /** One line per call. The result line holds fixed codes and hashes, never a token or npm's text. */
  write?: (line: string) => void;
  uploader?: BundleUploader;
  exec?: Exec;
}

/** Runs the install the task was started for. Returns the exit code. It refuses to run as root. */
export async function main(dependencies: MainDependencies): Promise<number> {
  const env = dependencies.env;
  const write = dependencies.write ?? ((line: string) => { process.stdout.write(`${line}\n`); });
  if (runsAsRoot({ getuid: dependencies.getuid, getgid: dependencies.getgid })) throw new Error("the install task must not run as root");
  const token = env.MCP_RUNNER_TOKEN;
  // The token is held here only; the environment npm gets is built from nothing (npmEnvironment), so it never reaches a child.
  delete dependencies.env.MCP_RUNNER_TOKEN;
  const emit = (value: Record<string, unknown>): void => write(`${RESULT_PREFIX}${JSON.stringify(value)}`);
  let request: unknown;
  try { request = JSON.parse(env.MCP_INSTALL_REQUEST ?? ""); } catch { emit({ ok: false, code: "invalid_request", sentence: INSTALL_FAILURES.invalid_request }); return 1; }
  const registry = env.ROVARA_MCP_NPM_REGISTRY;
  if (registry === undefined || registry === "") { emit({ ok: false, code: "invalid_request", sentence: INSTALL_FAILURES.invalid_request }); return 1; }
  const limits: Partial<InstallLimits> = {
    maxPackages: boundedNumber(env.ROVARA_MCP_MAX_PACKAGES, INSTALL_LIMITS.maxPackages, 1, 5_000),
    maxUnpackedBytes: boundedNumber(env.ROVARA_MCP_MAX_UNPACKED_MB, INSTALL_LIMITS.maxUnpackedBytes / 1_048_576, 1, 1_024) * 1_048_576,
    timeoutMs: boundedNumber(env.ROVARA_MCP_INSTALL_TIMEOUT_SECONDS, INSTALL_LIMITS.timeoutMs / 1_000, 10, 900) * 1_000,
  };
  const result = await runInstall(request, {
    registry, workDir: env.MCP_INSTALL_WORKDIR || "/work", caFile: env.ROVARA_MCP_NPM_CAFILE, limits, ...(dependencies.exec === undefined ? {} : { exec: dependencies.exec }),
  });
  if (!result.ok) {
    emit({ ok: false, code: result.code, sentence: result.sentence, ...(result.rule === undefined ? {} : { rule: result.rule }), ...(result.package === undefined ? {} : { package: result.package }), ...(result.computedIntegrity === undefined ? {} : { computedIntegrity: result.computedIntegrity }) });
    return 1;
  }
  try {
    const uploader = dependencies.uploader ?? controllerUploader({ url: env.MCP_CONTROLLER_URL ?? "", token: token ?? "", ...(env.ROVARA_MCP_CONTROLLER_CA === undefined ? {} : { ca: env.ROVARA_MCP_CONTROLLER_CA }) });
    await uploader.upload({ bundlePath: result.bundlePath, bundleHash: result.report.bundleHash, tarBytes: result.report.tarBytes });
  } catch {
    emit({ ok: false, code: "upload_failed", sentence: INSTALL_FAILURES.upload_failed });
    return 1;
  }
  emit({ ok: true, ...result.report });
  return 0;
}

/** Whether this file is the program being run (and not just imported). The real path is compared: a program started through a link would otherwise never start. */
function isMainModule(): boolean {
  if (process.argv[1] === undefined) return false;
  try { return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { return false; }
}

if (isMainModule()) {
  void main({ env: process.env }).then((code) => { process.exitCode = code; }, () => { process.exitCode = 1; });
}
