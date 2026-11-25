// Contract drift: the Code workspace packages that Code's contracts import (since Code train 42: @preplabsai/rovara-code-api, packages/code-api).
// A bare `git archive <sha> packages/contracts` has no node_modules and none of the sibling workspace packages, so loading Code's contracts failed with
// "Cannot find package '@preplabsai/rovara-code-api'". This module reads Code's package.json files at the pinned commit, finds every workspace package the contracts
// depend on (and what those depend on), exports each one with `git archive`, builds its `dist` from `src` and installs it into a node_modules directory. Fail closed: a
// dependency that cannot be exported or built, or a package whose `exports` point at a file the build did not make, throws; nothing is skipped.
//
// Plain node can run this file (erasable types only, node: imports only): the deployed-drift gate runs it through link-code-workspaces.ts against trees whose own copy of the drift tool predates it.
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";

interface PackageJson {
  readonly name?: string;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly peerDependencies?: Readonly<Record<string, string>>;
  readonly optionalDependencies?: Readonly<Record<string, string>>;
  readonly exports?: unknown;
}

/** A workspace package of the Code repository: its name and its directory (`packages/<dir>`). */
export interface CodeWorkspace { readonly name: string; readonly dir: string }

function git(repo: string, args: readonly string[]): string {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).trim();
}

function packageJsonAt(repo: string, sha: string, dir: string): PackageJson | undefined {
  try {
    return JSON.parse(execFileSync("git", ["-C", repo, "show", `${sha}:${dir}/package.json`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })) as PackageJson;
  } catch {
    return undefined;
  }
}

/** Every `packages/<dir>` of the Code commit that has a package.json with a name. */
export function codeWorkspaces(repo: string, sha: string): CodeWorkspace[] {
  const dirs = git(repo, ["ls-tree", "--name-only", sha, "packages/"]).split("\n").filter((line) => line !== "");
  const found: CodeWorkspace[] = [];
  for (const dir of dirs) {
    const name = packageJsonAt(repo, sha, dir)?.name;
    if (name !== undefined) found.push({ name, dir });
  }
  return found;
}

/** The workspace packages `fromDir` (e.g. `packages/contracts`) needs at run time, and what they need in turn. The package itself is not in the list. */
export function workspaceDependencies(repo: string, sha: string, fromDir: string): CodeWorkspace[] {
  const all = codeWorkspaces(repo, sha);
  const byName = new Map(all.map((workspace) => [workspace.name, workspace]));
  const wanted = new Map<string, CodeWorkspace>();
  const queue = [fromDir];
  const seen = new Set<string>([fromDir]);
  while (queue.length > 0) {
    const dir = queue.shift() as string;
    const manifest = packageJsonAt(repo, sha, dir);
    if (manifest === undefined) throw new Error(`Code ${sha.slice(0, 12)} has no ${dir}/package.json`);
    for (const group of [manifest.dependencies, manifest.peerDependencies, manifest.optionalDependencies]) {
      for (const name of Object.keys(group ?? {})) {
        const workspace = byName.get(name);
        if (workspace === undefined || seen.has(workspace.dir)) continue;
        seen.add(workspace.dir);
        wanted.set(name, workspace);
        queue.push(workspace.dir);
      }
    }
  }
  return [...wanted.values()].sort((a, b) => a.name.localeCompare(b.name));
}

interface TypeScriptLike {
  readonly ModuleKind: { readonly ESNext: number };
  readonly ScriptTarget: { readonly ES2023: number };
  transpileModule(source: string, options: { fileName: string; reportDiagnostics: boolean; compilerOptions: Record<string, unknown> }): { outputText: string; diagnostics?: readonly { messageText: unknown }[] };
}

/** The TypeScript of the Cloud tree that runs the check (a dev dependency of every Cloud tree; it is what builds Cloud's own packages). */
function typescriptOf(cloudRoot: string): TypeScriptLike {
  try {
    return createRequire(path.join(cloudRoot, "package.json"))("typescript") as TypeScriptLike;
  } catch (error) {
    throw new Error(`cannot build the Code workspace packages: typescript is not installed in ${cloudRoot}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (/\.ts$/u.test(entry.name) && !/\.d\.ts$/u.test(entry.name)) out.push(full);
  }
  return out;
}

/** Every file name an `exports` map (or a `main`-like string) points at, without the types-only conditions. */
function exportTargets(value: unknown, key = ""): string[] {
  if (typeof value === "string") return key === "types" ? [] : [value];
  if (typeof value !== "object" || value === null) return [];
  return Object.entries(value).flatMap(([name, inner]) => exportTargets(inner, name));
}

/**
 * Exports one workspace package of the Code commit into `<nodeModules>/<name>` and builds it: `package.json` and `src` as they are in Code, `dist` transpiled from `src` (no type
 * check: the package compiles in Code's own build; this only needs the JavaScript). Throws when the build did not make a file the package's `exports` name.
 */
export function installCodeWorkspace(repo: string, sha: string, workspace: CodeWorkspace, nodeModules: string, cloudRoot: string): void {
  const target = path.join(nodeModules, ...workspace.name.split("/"));
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  // git archive of the directory, with the package's own files landing in `target` (no leading packages/<dir>).
  execFileSync("sh", ["-c", `git -C "$1" archive "$2" "$3" | tar -x -C "$4" --strip-components=2`, "sh", repo, sha, workspace.dir, target]);
  const src = path.join(target, "src");
  if (!existsSync(src)) throw new Error(`Code workspace ${workspace.name} (${workspace.dir}) has no src directory at ${sha.slice(0, 12)}`);
  const ts = typescriptOf(cloudRoot);
  const files = sourceFiles(src);
  if (files.length === 0) throw new Error(`Code workspace ${workspace.name} has no .ts files under src`);
  for (const file of files) {
    const out = ts.transpileModule(readFileSync(file, "utf8"), { fileName: file, reportDiagnostics: true, compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2023, verbatimModuleSyntax: true } });
    const errors = (out.diagnostics ?? []).map((diagnostic) => (typeof diagnostic.messageText === "string" ? diagnostic.messageText : "syntax error"));
    if (errors.length > 0) throw new Error(`Code workspace ${workspace.name}: ${path.relative(target, file)} did not compile: ${errors.join("; ").slice(0, 200)}`);
    const dist = path.join(target, "dist", path.relative(src, file).replace(/\.ts$/u, ".js"));
    mkdirSync(path.dirname(dist), { recursive: true });
    writeFileSync(dist, out.outputText);
  }
  const manifest = JSON.parse(readFileSync(path.join(target, "package.json"), "utf8")) as PackageJson;
  const missing = exportTargets(manifest.exports).filter((file) => !existsSync(path.join(target, file)));
  if (missing.length > 0) throw new Error(`Code workspace ${workspace.name}: the build did not make ${missing.join(", ")}, which its exports name`);
}

/**
 * Installs every workspace package that Code's `packages/contracts` needs into `nodeModules`, from the Code commit. Returns what it installed.
 * `cloudRoot` is the Cloud tree whose TypeScript builds them.
 */
export function installContractsWorkspaces(repo: string, sha: string, nodeModules: string, cloudRoot: string): CodeWorkspace[] {
  const needed = workspaceDependencies(repo, sha, "packages/contracts");
  for (const workspace of needed) installCodeWorkspace(repo, sha, workspace, nodeModules, cloudRoot);
  return needed;
}

/**
 * A node_modules for the temporary Code tree: a real directory holding a link to every entry of the Cloud tree's node_modules (so zod is the Cloud tree's one copy), plus
 * the Code workspace packages. A scope directory that both have (for example @preplabsai) is made real too, so the Cloud tree's own is never written to.
 */
export function makeTemporaryNodeModules(tree: string, cloudRoot: string, repo: string, sha: string): CodeWorkspace[] {
  const nodeModules = path.join(tree, "node_modules");
  const cloudModules = path.join(cloudRoot, "node_modules");
  mkdirSync(nodeModules, { recursive: true });
  const needed = workspaceDependencies(repo, sha, "packages/contracts");
  const scopes = new Set(needed.filter((workspace) => workspace.name.startsWith("@")).map((workspace) => workspace.name.split("/")[0] as string));
  for (const entry of readdirSync(cloudModules)) {
    if (scopes.has(entry)) {
      mkdirSync(path.join(nodeModules, entry), { recursive: true });
      for (const inner of readdirSync(path.join(cloudModules, entry))) symlinkSync(path.join(cloudModules, entry, inner), path.join(nodeModules, entry, inner));
    } else symlinkSync(path.join(cloudModules, entry), path.join(nodeModules, entry));
  }
  for (const workspace of needed) installCodeWorkspace(repo, sha, workspace, nodeModules, cloudRoot);
  return needed;
}

/** A scratch directory for an export; the caller removes it. */
export function scratchDirectory(prefix: string): string {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

/** True when `p` is a symbolic link (used by tests to show the Cloud tree's node_modules was not written to). */
export function isSymlink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}
