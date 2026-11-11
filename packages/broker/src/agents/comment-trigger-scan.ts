// Plan 3 Task 14b (R1-1, R3-1): does this repository have workflows or bots that act on comments, issues or labels? If it does, every comment, review
// or label an agent writes there, and every issue it creates or edits, can start a deploy or a merge, so each needs a person whatever the text says
// (Task 20b's `classifyWrite` asks `repoCommandTriggers`). The scan reads the repository's DEFAULT branch, because `issue_comment`, `issues` and
// `discussion*` workflows always run from it, through a read-only agent token (`contents: read`), at one commit.
//
// The scan hashes every workflow of the repository whenever it triggers (a comment can start any of them: a workflow_run one, a `workflow_dispatch` or
// `repository_dispatch` one through `gh workflow run`, a push), and reaches into what they run: local actions and reusable workflows (and every file in
// a local action's folder), the scripts, manifests and files named in `run:`, `shell:` and in the environment (`BASH_ENV`, `NODE_OPTIONS --require/--import/-r`,
// `PYTHONSTARTUP`, `PERL5OPT`, `RUBYOPT`, `LD_PRELOAD`, in env maps, `export` and `$GITHUB_ENV` lines), the word after a wrapper (`env`, `sudo`, `exec`, `eval`,
// `timeout`, `nohup`, `nice`, `time`, `command`, `xargs`, `stdbuf`), the folders and files named by `make -C/-f`, `npm --prefix`, `pnpm -C/--dir`, `yarn --cwd`,
// `package.json` and `Makefile` where npm, npx, yarn, pnpm or make is run, `.gitmodules`, this repository's own files named remotely at its default branch,
// and the files a shell script runs in turn (read with the same rules, transitively; a script that runs `"$@"` or `$1` gets its caller's arguments as candidate
// files, whatever they look like). All of it counts against 50 files. The digest covers it, so an opt-out (comment-trigger-optouts.ts) lapses when any of it
// changes. Remote actions are listed with their ref and not hashed.
//
// The scan can never be complete, so wherever it can't tell which file runs it FAILS CLOSED (`triggers: true, failedClosed: true`: no opt-out is possible and
// comments stay consequential), with one fixed hint when it knows why (COMMENT_TRIGGER_HINTS; never repository text). That is: a file it can't read or parse,
// a listing that may be cut short, more than 100 workflow files, a file over 512 KiB, more than 50 reached files, a name with a control or format character,
// a remote reference that is not `owner/repo[/path]@ref` or `docker://`, a `${{ }}` expression or shell variable (other than github.workspace/github.action_path
// and their environment forms) where a path goes (a command word, the word after an interpreter or a wrapper, `working-directory`, `shell:`, an environment
// variable that loads a file, `uses:`), `..` in a path, a glob or brace expansion, `cd`, `pushd` or `popd` in anything it reads, a command written with a
// backslash or an empty quote pair, `env -C/--chdir`, `git -C`, a `make`, `npm`, `pnpm` or `yarn` folder or file flag it can't resolve, `find -exec/-execdir/-ok`,
// `run-parts`, an `xargs` whose command is an interpreter or missing, `python -m` of a module outside a short list (pip, venv, json.tool, http.server
// and the like, and pytest, mypy, ruff, black, flake8, isort, coverage, tox, nox, whose configuration files are hashed) in `run:` or `shell:`, a custom `shell:` that is not a plain path, a script that uses `$1`/`$@`/`$*` where a path goes when the caller's
// arguments can't be read, a root action (`uses: ./`) that is not composite, a local action with no action.yml/action.yaml, a named file (written as a path or
// with a script extension) that is not in the repository (except under node_modules, .venv or venv, which a run creates), any path under a git submodule, and
// a symlink or submodule where it lists.
//
// What remains, exactly (Accepted residual risks, shown to the admin as COMMENT_TRIGGER_COVERAGE_NOTE):
//  - a command run by bare name or resolved from the PATH, including one a step adds with `$GITHUB_PATH`, unless npm, npx, yarn, pnpm or make runs it;
//  - code fetched or built at run time (a download, a package install, a remote action or its ref's content) and a Docker build's context and Dockerfile;
//  - files a script in another language imports or requires (only shell scripts are read for further paths; a Python or JavaScript script is hashed);
//  - the code npm, make and `python -m pytest|mypy|ruff|black|flake8|isort|coverage|tox|nox` run (only package.json, Makefile and pyproject.toml, setup.cfg, pytest.ini,
//    tox.ini, noxfile.py are hashed), and other tool configuration the tools read on their own (.npmrc and the like);
//  - code a shell script builds from pieces or passes through here-documents, `eval` of a variable, `python -c`/`node -e` strings and computed paths;
//  - a workflow on a branch other than the default (it matters once it is merged, and the next run's scan sees it);
//  - symlinked directories on the path to a script, which the API may report as absent (a script written as a path then fails closed as missing).
import { createHash } from "node:crypto";
import { parseDocument } from "yaml";
import { CommentTriggerRepositorySchema, COMMENT_TRIGGER_FILES_MAX, COMMENT_TRIGGER_FILE_NAME_MAX, COMMENT_TRIGGER_HINTS as HINTS, agentXError, type OrgId } from "@rovara-code/contracts";
import type { AgentRepositoryReader } from "../github-app.js";
import { cacheNameOf, type RunCache } from "./run-cache.js";

/** What a scan found. `fileShas` is the blob sha of each hashed file, so a lapse can name what changed. */
export interface RepoCommandTriggers {
  triggers: boolean;
  failedClosed: boolean;
  /** SHA-256 of the sorted (path, blob sha) pairs of the triggering workflows, the bot configs and every file they reach; all zeros when `failedClosed`. */
  digest: string;
  /** The triggering workflows and bot configs found, the files they reach and the remote actions they use (with their ref), sorted. */
  files: string[];
  fileShas: Record<string, string>;
  /** Only on a scan that failed closed, and only when the scan knows why: one fixed sentence (COMMENT_TRIGGER_HINTS), never text from the repository. */
  hint?: string;
}

export interface RepoScanDependencies {
  /** A read-only reader of the repository's default branch for the org (the GitHub App's `agentRepositoryReader`). */
  repositoryReader: (input: { orgId: OrgId; repositoryUrl: string; installationId?: number }) => Promise<AgentRepositoryReader>;
  /** Where this run keeps what it found. Without one, every call reads again. Nothing is kept across runs. */
  cache?: RunCache;
  now?: () => number;
}

export const WORKFLOW_DIRECTORY = ".github/workflows";
export const BOT_CONFIG_PATHS: readonly string[] = [".mergify.yml", ".mergify/config.yml", ".github/mergify.yml", "bors.toml", ".github/bors.toml", ".kodiak.toml", ".github/.kodiak.toml", "atlantis.yaml", "atlantis.yml"];
export const MAX_WORKFLOW_FILES = 100;
export const MAX_FILE_BYTES = 512 * 1024;
export const MAX_REACHED_FILES = 50;
/** Lookups of paths named in `run:` lines that turn out not to be files cost a request each; this many in one scan is the most. */
const MAX_LOOKUPS = 400;
/** A scan that takes longer than this gives up (fail closed): the call it is part of has its own time to keep. */
export const SCAN_BUDGET_MS = 25_000;
const MAX_WALK_DEPTH = 64;
const MAX_DIRECTORY_DEPTH = 8;
const MAX_CANDIDATES_PER_RUN_BLOCK = 200;
const FAILED_DIGEST = "0".repeat(64);

/** Events whose workflows run on a comment, a review, a discussion or an issue, whatever their config. */
const COMMENT_EVENTS = new Set(["issue_comment", "pull_request_review_comment", "pull_request_review", "discussion", "discussion_comment", "issues"]);
/** Events that count only when their `types` include `labeled`. */
const LABEL_EVENTS = new Set(["pull_request", "pull_request_target"]);

class ScanFailure extends Error {
  constructor(why: string, readonly hint?: string) { super(why); }
}
const fail = (why: string, hint?: string): never => { throw new ScanFailure(why, hint); };

const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

function failedClosed(hint?: string): RepoCommandTriggers {
  return { triggers: true, failedClosed: true, digest: FAILED_DIGEST, files: [], fileShas: {}, ...(hint === undefined ? {} : { hint }) };
}

// ---- which workflows act on comments

/** The event names and, for each, the `types` its config lists (undefined when it lists none). */
function eventsOf(on: unknown): Array<{ event: string; types: string[] | undefined }> {
  if (typeof on === "string") return [{ event: on.toLowerCase(), types: undefined }];
  if (Array.isArray(on)) return on.filter((entry): entry is string => typeof entry === "string").map((event) => ({ event: event.toLowerCase(), types: undefined }));
  if (!isRecord(on)) return [];
  return Object.entries(on).map(([event, config]) => {
    const types = isRecord(config) ? config["types"] : undefined;
    const list = typeof types === "string" ? [types] : Array.isArray(types) ? types.filter((type): type is string => typeof type === "string") : undefined;
    return { event: event.toLowerCase(), types: list?.map((type) => type.toLowerCase()) };
  });
}

/** Whether a parsed workflow runs on a comment, a review, a discussion, an issue, or a label being added. */
export function workflowTriggers(workflow: Record<string, unknown>): boolean {
  // YAML 1.2 reads `on` as a string; a parser of YAML 1.1 reads it as the boolean `true`, and that key is `on` too.
  const on = Object.hasOwn(workflow, "on") ? workflow["on"] : workflow["true"];
  return eventsOf(on).some(({ event, types }) => COMMENT_EVENTS.has(event) || (LABEL_EVENTS.has(event) && types?.includes("labeled") === true));
}

function parseYaml(text: string): unknown {
  // Merge keys (`<<`) are resolved, so a default or a step reused through one is walked as the runner reads it.
  const document = parseDocument(text, { version: "1.2", schema: "core", uniqueKeys: true, merge: true });
  if (document.errors.length > 0) return fail("a file does not parse");
  return document.toJS({ maxAliasCount: 100 });
}

// ---- what a workflow reaches

function normalizedPath(raw: string): string | undefined {
  const withoutDot = raw.replace(/^\.\//u, "").replace(/\/+$/u, "");
  if (withoutDot === "" || withoutDot.length > 300 || withoutDot.startsWith("/") || withoutDot.includes("\\") || /[$*{}~]/u.test(withoutDot)) return undefined;
  const parts = withoutDot.split("/");
  return parts.some((part) => part === "" || part === "." || part === "..") ? undefined : parts.join("/");
}

/** `github.action_path` and `GITHUB_ACTION_PATH` are the folder of the action that runs the step; `github.workspace` and `GITHUB_WORKSPACE` the repository's root. */
const ACTION_PATH = /\$\{\{\s*github\.action_path\s*\}\}|\$\{GITHUB_ACTION_PATH\}|\$GITHUB_ACTION_PATH(?![A-Za-z0-9_])/gu;
const WORKSPACE = /\$\{\{\s*github\.workspace\s*\}\}|\$\{GITHUB_WORKSPACE\}|\$GITHUB_WORKSPACE(?![A-Za-z0-9_])/gu;

/** A run block with those four names replaced by the folders they stand for, written as `./folder` so that what follows reads as a path in the repository. */
export function withKnownFolders(run: string, actionDirectory: string): string {
  return run.replace(ACTION_PATH, actionDirectory === "" ? "." : `./${actionDirectory}`).replace(WORKSPACE, ".");
}

const PACKAGE_MANAGERS = new Set(["npm", "npx", "yarn", "pnpm"]);
const MAKE = new Set(["make", "gmake"]);

/**
 * The manifests a run block's tools read their commands from: `package.json` for npm, npx, yarn and pnpm, `Makefile` for make. A script they run
 * without a path or an extension is found through these (an extensionless script run by name is an accepted residual risk).
 */
export function toolManifests(run: string): string[] {
  const words = new Set(run.split(/[\s;|&()<>"'`]+/u).map((word) => word.toLowerCase()));
  return [...(([...PACKAGE_MANAGERS].some((tool) => words.has(tool))) ? ["package.json"] : []), ...(([...MAKE].some((tool) => words.has(tool))) ? ["Makefile"] : [])];
}

/** A remote action: `owner/repo@ref`, `owner/repo/path@ref`, or a `docker://` image. Anything else is not a reference this scan can list. */
const REMOTE_ACTION = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(?:\/([A-Za-z0-9_./-]+))?@([A-Za-z0-9_./-]+)$/u;
const DOCKER_ACTION = /^docker:\/\/[A-Za-z0-9][A-Za-z0-9_.:/@-]{0,300}$/u;

const INTERPRETERS = new Set(["bash", "sh", "zsh", "dash", "ksh", "fish", "node", "nodejs", "python", "python2", "python3", "ruby", "perl", "php", "deno", "bun", "tsx", "ts-node", "pwsh", "powershell", "source", "."]);
const PYTHONS = new Set(["python", "python2", "python3"]);
/** Standard-library and installer modules `python -m` may run without naming a file of the repository. Any other module is code the scan can't see. */
const PYTHON_MODULES = new Set(["pip", "venv", "ensurepip", "json.tool", "http.server", "zipfile", "tarfile", "base64", "compileall", "py_compile", "timeit", "sysconfig", "site", "platform", "uuid", "calendar"]);
/** Well-known tools `python -m` may run: like npm and make, their configuration files are hashed and the code they run is not followed. */
const PYTHON_TOOL_MODULES = new Set(["pytest", "mypy", "ruff", "black", "flake8", "isort", "coverage", "tox", "nox"]);
const PYTHON_CONFIG_FILES = ["pyproject.toml", "setup.cfg", "pytest.ini", "tox.ini", "noxfile.py"];
const SCRIPT_EXTENSION = /\.(?:sh|bash|zsh|py|rb|js|mjs|cjs|ts|pl|ps1|php)$/u;
/** Stands for one `${{ ... }}` expression while a run block is read: what an expression names is not known to the scan. */
const EXPRESSION_MARK = "\u0001";
const EXPRESSION = /\$\{\{(?:(?!\}\}).){0,1000}\}\}/gsu;
const MAX_RUN_TEXT = 100_000;
const MAX_ARGUMENTS = 40;
const DIRECTORY_COMMANDS = new Set(["cd", "pushd", "popd"]);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/u;
/** Files that a tool loads before the command it was started for runs, named by an environment variable. */
const ENV_FILE_VARIABLES = new Set(["BASH_ENV", "NODE_OPTIONS", "PYTHONSTARTUP", "PERL5OPT", "RUBYOPT", "LD_PRELOAD"]);
/** Commands that run the command that follows them, and the flags of each that take a value. The wrapped word is a command position. */
const WRAPPERS: Readonly<Record<string, ReadonlySet<string>>> = {
  env: new Set(["-u", "--unset", "-S"]),
  sudo: new Set(["-u", "-g", "-h", "-p", "-C", "-r", "-t", "-U", "-R"]),
  timeout: new Set(["-s", "--signal", "-k", "--kill-after"]),
  nice: new Set(["-n", "--adjustment"]),
  xargs: new Set(["-n", "-I", "-P", "-a", "-d", "-L", "-s", "-E", "-l"]),
  stdbuf: new Set(),
  exec: new Set(["-a"]),
  nohup: new Set(),
  time: new Set(["-f", "-o"]),
  command: new Set(),
  eval: new Set(),
};
/** Tools whose flags name another folder or file to read their commands from. */
const FOLDER_TOOLS = new Set(["make", "gmake", "npm", "npx", "pnpm", "yarn"]);
/** A directory that the run itself creates (installed or built): a path in it that isn't in the repository is not a missing file. */
const BUILT_AT_RUN_TIME = /^(?:node_modules|\.venv|venv)(?:\/|$)/u;

const POSITIONAL_PARAMETER = /^\$(?:[@*#?0-9]|\{[@*#?0-9]+\})$/u;

type Classified = { path: string } | "outside" | "positional" | "unresolvable";

/**
 * What a word in a path position names. A path outside the repository (absolute, `~`, a URL, the root itself) is `outside`: no file of the repository is
 * meant. A positional parameter (`$@`, `$1`) is what the caller passed. Anything the scan can't turn into one file of the repository (a variable or
 * expression, `..`, a glob or brace expansion, a Windows path) is `unresolvable`, and the scan fails closed on it.
 */
function classifyPath(word: string): Classified {
  if (POSITIONAL_PARAMETER.test(word)) return "positional";
  if (word.startsWith("/") || word.startsWith("~") || word.includes("://") || word === "." || word === "./") return "outside";
  if (word.includes(EXPRESSION_MARK) || word.includes("$") || /[*{}\\]/u.test(word) || word.split("/").includes("..")) return "unresolvable";
  const path = normalizedPath(word);
  return path === undefined ? "unresolvable" : { path };
}

/** Why a word could not be resolved, as a fixed hint. */
const whyUnresolvable = (word: string): string => (word.includes(EXPRESSION_MARK) || word.includes("$") ? HINTS.dynamic : HINTS.path);

export interface RunAnalysis {
  /** The files of the repository a shell block may run, source or read: `./x`, a path with a script extension, the word after an interpreter, and what tools and environment variables load. */
  candidates: string[];
  /** The block holds something the scan can't resolve: a `cd`, `pushd` or `popd`, a variable or expression where a path goes, `..`, a glob, a folder flag it can't read, files found at run time. */
  unresolvable: boolean;
  /** The candidates written as paths (`./x`, a slash, a script extension): a file that is not in the repository is then an error, not a word. */
  strong: string[];
  /** The arguments each candidate is called with, as written (flags left out). */
  calls: Record<string, string[]>;
  /** A positional parameter (`$1`, `$@`, `$*`) stands where a path goes: the files are the caller's arguments. */
  positional: boolean;
  /** One fixed hint for the first thing that could not be resolved, when the scan has one. */
  hint?: string;
}

/** The file words an environment variable loads, from the words of its value (and what follows). */
function envFileWords(name: string, value: readonly string[]): string[] {
  const words = value.filter((word) => word !== "");
  if (name === "BASH_ENV" || name === "PYTHONSTARTUP") return words.slice(0, 1);
  if (name === "LD_PRELOAD") return (words[0] ?? "").split(":").filter((word) => word !== "");
  const found: string[] = [];
  const flags = name === "NODE_OPTIONS" ? ["--require", "--import", "-r"] : ["-I", "-M", "-m", "-r"];
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index]!;
    for (const flag of flags) {
      if (word === flag) { if (index + 1 < words.length) { index += 1; found.push(words[index]!); } break; }
      if (flag.startsWith("--") ? word.startsWith(`${flag}=`) : name !== "NODE_OPTIONS" && word.startsWith(flag) && word.length > flag.length) {
        found.push(word.slice(flag.length + (flag.startsWith("--") ? 1 : 0)));
        break;
      }
    }
  }
  return found;
}

/**
 * Reads a shell block the way the scan needs: which repository files it may run. A path position is the command word (and the word after a wrapper such
 * as `env`, `sudo`, `timeout` or `xargs`), the word after an interpreter (`bash x`, `python x`, `source x`), a word starting `./`, and a word with a slash and
 * a script extension. A bare command word (`make`, `git`) is not a path: it is found on the PATH (an accepted residual risk). Files that
 * environment variables load (`BASH_ENV`, `NODE_OPTIONS --require`, ...) and the folders a tool is told to read (`make -C`, `npm --prefix`) are read too.
 * What can't be resolved is flagged. Full-line comments are skipped.
 */
export function analyseRun(run: string): RunAnalysis {
  const candidates = new Set<string>();
  const strong = new Set<string>();
  const calls = new Map<string, Set<string>>();
  let unresolvable = false;
  let positional = false;
  let hint: string | undefined;
  const flag = (why?: string): void => {
    unresolvable = true;
    if (hint === undefined && why !== undefined) hint = why;
  };
  const result = (): RunAnalysis => ({
    candidates: [...candidates], unresolvable, strong: [...strong], calls: Object.fromEntries([...calls].map(([path, args]) => [path, [...args]])), positional,
    ...(hint === undefined ? {} : { hint }),
  });
  if (run.length > MAX_RUN_TEXT) { flag(); return result(); }
  const take = (word: string, isStrong: boolean, args?: readonly string[]): void => {
    const classified = classifyPath(word);
    if (classified === "positional") { positional = true; return; }
    if (classified === "unresolvable") { flag(whyUnresolvable(word)); return; }
    if (classified === "outside") return;
    candidates.add(classified.path);
    if (isStrong) strong.add(classified.path);
    if (args !== undefined) {
      const known = calls.get(classified.path) ?? new Set<string>();
      for (const argument of args) known.add(argument);
      calls.set(classified.path, known);
    }
  };
  /** A folder a tool is told to read: its manifest is a candidate. Returns the folder, or undefined (flagged when it can't be resolved). */
  const folder = (word: string | undefined, manifest: string | undefined): string | undefined => {
    if (word === undefined) { flag(HINTS.folderFlag); return undefined; }
    const classified = classifyPath(word);
    if (classified === "unresolvable") { flag(HINTS.folderFlag); return undefined; }
    if (typeof classified === "string") return undefined;
    if (manifest !== undefined) candidates.add(`${classified.path}/${manifest}`);
    return classified.path;
  };
  const toolFlags = (tool: string, rest: readonly string[]): void => {
    const make = tool === "make" || tool === "gmake";
    const dirFlags = make ? ["-C", "--directory"] : tool === "yarn" ? ["--cwd"] : tool === "pnpm" ? ["-C", "--dir", "--prefix"] : ["--prefix"];
    const fileFlags = make ? ["-f", "--file", "--makefile"] : [];
    const manifest = make ? "Makefile" : "package.json";
    let directory: string | undefined;
    const files: Array<string | undefined> = [];
    for (let index = 0; index < rest.length; index += 1) {
      const word = rest[index]!;
      for (const [flags, into] of [[dirFlags, "dir"], [fileFlags, "file"]] as const) {
        for (const name of flags) {
          let value: string | undefined;
          let matched = false;
          if (word === name) { matched = true; index += 1; value = rest[index]; }
          else if (name.startsWith("--") ? word.startsWith(`${name}=`) : word.startsWith(name) && word.length > name.length) { matched = true; value = word.slice(name.length + (name.startsWith("--") ? 1 : 0)); }
          if (!matched) continue;
          if (into === "dir") directory = folder(value, manifest) ?? directory;
          else files.push(value);
        }
      }
    }
    for (const file of files) {
      if (file === undefined) { flag(HINTS.folderFlag); continue; }
      take(file, false);
      if (directory !== undefined) take(`${directory}/${file}`, false);
    }
  };
  const skipWrapper = (words: readonly string[], at: number, name: string): number => {
    const withValue = WRAPPERS[name]!;
    let next = at + 1;
    let durationSeen = name !== "timeout";
    while (next < words.length) {
      const word = words[next]!;
      if (name === "env" && ASSIGNMENT.test(word)) { next += 1; continue; }
      if (word.startsWith("-") && word.length > 1) {
        if ((name === "env" && (word.startsWith("-C") || word === "--chdir" || word.startsWith("--chdir="))) || (name === "sudo" && (word === "-D" || word.startsWith("--chdir")))) flag(HINTS.folderFlag);
        next += withValue.has(word) ? 2 : 1;
        continue;
      }
      if (!durationSeen && /^[0-9]/u.test(word)) { durationSeen = true; next += 1; continue; }
      break;
    }
    // xargs runs the names it is given at run time: unless its command is a plain program, the files are not in the text.
    if (name === "xargs" && (next >= words.length || INTERPRETERS.has(words[next]!.toLowerCase()))) flag(HINTS.runtimeFiles);
    return next;
  };
  const text = run.replace(EXPRESSION, EXPRESSION_MARK);
  for (const line of text.split(/\r\n|\r|\n|\u2028|\u2029|\u0085/u)) {
    if (line.trimStart().startsWith("#")) continue;
    for (const segment of line.split(/&&|\|\||[;|&]/u)) {
      // A command written with a backslash or an empty quote pair (`\cd`, `c''d`) is the same command by another spelling: the scan doesn't try to undo that.
      const written = segment.trim().split(/\s+/u)[0] ?? "";
      if (written !== "\\" && /\\|''|""/u.test(written)) flag(HINTS.plainCommand);
      const words = segment.split(/[\s()<>"'`]+/u).filter((word) => word !== "");
      let leading = true;
      let afterInterpreter = false;
      for (let index = 0; index < words.length; index += 1) {
        const word = words[index]!;
        const lower = word.toLowerCase();
        const variable = /^([A-Z_][A-Z0-9_]*)=(.*)$/u.exec(word);
        if (variable !== null && ENV_FILE_VARIABLES.has(variable[1]!)) {
          for (const file of envFileWords(variable[1]!, [variable[2]!, ...words.slice(index + 1)])) take(file, false);
          continue;
        }
        if (DIRECTORY_COMMANDS.has(lower)) { flag(HINTS.directory); continue; }
        if (leading && ASSIGNMENT.test(word)) continue;
        const command = leading;
        leading = false;
        if (command) {
          if (Object.hasOwn(WRAPPERS, lower)) { index = skipWrapper(words, index, lower) - 1; leading = true; continue; }
          const rest = words.slice(index + 1);
          if (FOLDER_TOOLS.has(lower)) toolFlags(lower, rest);
          if (lower === "git" && rest.includes("-C")) flag(HINTS.folderFlag);
          if (lower === "run-parts" || (lower === "find" && rest.some((other) => ["-exec", "-execdir", "-ok", "-okdir"].includes(other)))) flag(HINTS.runtimeFiles);
          if (PYTHONS.has(lower)) {
            for (let look = 0; look < rest.length && rest[look]!.startsWith("-"); look += 1) {
              const option = rest[look]!;
              if (option === "-m" || (option.startsWith("-m") && !option.startsWith("--"))) {
                const module = option === "-m" ? rest[look + 1] : option.slice(2);
                if (module === undefined || !(PYTHON_MODULES.has(module) || PYTHON_TOOL_MODULES.has(module))) flag(HINTS.pythonModule);
                else if (PYTHON_TOOL_MODULES.has(module)) for (const name of PYTHON_CONFIG_FILES) take(name, false);
                break;
              }
            }
          }
        }
        if (INTERPRETERS.has(lower) && (lower !== "." || command)) { afterInterpreter = true; continue; }
        if (afterInterpreter && word.startsWith("-")) continue;
        const dynamic = word.includes(EXPRESSION_MARK) || word.includes("$");
        const written2 = word.startsWith("./") || word.startsWith("../") || word.includes("/") || SCRIPT_EXTENSION.test(lower);
        const pathPosition = afterInterpreter || (command && (dynamic || word.includes("/"))) || word.startsWith("./") || word.startsWith("../") || (word.includes("/") && SCRIPT_EXTENSION.test(lower));
        afterInterpreter = false;
        if (pathPosition) take(word, written2, words.slice(index + 1).filter((other) => !other.startsWith("-")).slice(0, MAX_ARGUMENTS));
        if (candidates.size >= MAX_CANDIDATES_PER_RUN_BLOCK) { flag(); return result(); }
      }
    }
  }
  return result();
}

/** The files a shell block may run (see `analyseRun`; what it can't resolve is not listed here). */
export function scriptCandidates(run: string): string[] {
  return analyseRun(run).candidates;
}

const STANDARD_SHELLS = new Set([...INTERPRETERS, "cmd"]);

/**
 * What a `shell:` value runs. The standard shells and their flags run nothing of the repository; a plain path to a file is that file; anything else
 * (an expression, a variable, `..`, a command found on the PATH, `python -m` of a module that is not a standard one) can't be resolved.
 */
function shellFiles(value: string, actionDirectory: string): RunAnalysis {
  const candidates = new Set<string>();
  let unresolvable = false;
  let hint: string | undefined;
  const flag = (why: string): void => { unresolvable = true; hint ??= why; };
  let afterFlag = false;
  const words = withKnownFolders(value, actionDirectory).replace(EXPRESSION, EXPRESSION_MARK).split(/\s+/u).map((raw) => raw.replace(/^["']+|["']+$/gu, "")).filter((word) => word !== "");
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index]!;
    if (word.includes("{0}")) continue;
    if (PYTHONS.has(word.toLowerCase())) {
      const option = words[index + 1];
      if (option !== undefined && (option === "-m" || (option.startsWith("-m") && !option.startsWith("--")))) {
        const module = option === "-m" ? words[index + 2] : option.slice(2);
        if (module === undefined || !(PYTHON_MODULES.has(module) || PYTHON_TOOL_MODULES.has(module))) flag(HINTS.pythonModule);
        else if (PYTHON_TOOL_MODULES.has(module)) for (const name of PYTHON_CONFIG_FILES) candidates.add(name);
      }
    }
    if (word.startsWith("-")) { afterFlag = true; continue; }
    if (afterFlag && /^[A-Za-z.]+$/u.test(word)) { afterFlag = false; continue; }
    afterFlag = false;
    if (STANDARD_SHELLS.has(word.toLowerCase())) continue;
    const classified = classifyPath(word);
    if (classified === "unresolvable") flag(whyUnresolvable(word));
    else if (typeof classified === "object" && !word.includes("/") && !SCRIPT_EXTENSION.test(word.toLowerCase())) flag(HINTS.shell);
    else if (typeof classified === "object") candidates.add(classified.path);
  }
  return { candidates: [...candidates], unresolvable, strong: [], calls: {}, positional: false, ...(hint === undefined ? {} : { hint }) };
}

/** A `working-directory` value: the folder it names ("" for the root), undefined when it is outside the repository. An expression or variable the scan can't resolve fails closed. */
function workingDirectoryOf(value: string, actionDirectory: string): string | undefined {
  const written = withKnownFolders(value, actionDirectory).replace(EXPRESSION, EXPRESSION_MARK);
  const classified = classifyPath(written);
  if (classified === "unresolvable") return fail("a working directory the scan can't resolve", whyUnresolvable(written));
  if (typeof classified === "string") return value.trim() === "." || value.trim() === "./" ? "" : undefined;
  return classified.path;
}

/** Where a script was named from: the step's working directory, the action folder `github.action_path` meant, and the arguments it was called with. */
interface Origin { here: string | undefined; directory: string; args: string[] | undefined }

/** A script (or manifest) the scan should hash. `paths` are the ways it may be spelled (as named, and under the step's working directory); `strong` means a file that is not there is an error. */
interface ScriptRef { paths: string[]; strong: boolean; here: string | undefined; directory: string; args: string[] | undefined }

interface Reach {
  /** `uses` values that name a local action or reusable workflow. */
  local: Array<{ path: string }>;
  remote: string[];
  scripts: ScriptRef[];
}

/** The repository being scanned and its default branch: a remote reference to it at that branch is its own file. */
interface Self { repository: string; branch: string }

/**
 * Everything a parsed workflow or action file names: its `uses` (local or remote) and the files its `run`, `shell` and environment can run, wherever they
 * are in the tree. `directory` is the folder of the action the file is (empty for a workflow). Whatever can't be resolved fails the scan closed.
 */
function reachOf(document: unknown, directory: string, self: Self): Reach {
  const reach: Reach = { local: [], remote: [], scripts: [] };
  const addScripts = (analysis: RunAnalysis, extra: readonly string[], here: string | undefined): void => {
    for (const path of new Set([...analysis.candidates, ...extra])) {
      reach.scripts.push({
        paths: here === undefined || here === "" ? [path] : [path, `${here}/${path}`], strong: analysis.strong.includes(path), here, directory,
        args: Object.hasOwn(analysis.calls, path) ? analysis.calls[path] : undefined,
      });
    }
  };
  const visit = (node: unknown, depth: number, workingDirectory: string | undefined): void => {
    if (depth > MAX_WALK_DEPTH) return fail("a workflow is nested too deeply");
    if (Array.isArray(node)) { for (const item of node) visit(item, depth + 1, workingDirectory); return; }
    if (!isRecord(node)) return;
    // A step's own working-directory wins; then the nearest `defaults.run.working-directory` (a job's over the workflow's); then what came down.
    const own = typeof node["working-directory"] === "string" ? workingDirectoryOf(node["working-directory"], directory) : undefined;
    const defaults = isRecord(node["defaults"]) && isRecord(node["defaults"]["run"]) ? node["defaults"]["run"]["working-directory"] : undefined;
    const fromDefaults = typeof defaults === "string" ? workingDirectoryOf(defaults, directory) : undefined;
    const here = own ?? fromDefaults ?? workingDirectory;
    const uses = node["uses"];
    if (typeof uses === "string") {
      if (uses.startsWith("./") || uses === ".") {
        const path = uses === "." || uses === "./" ? "" : normalizedPath(uses);
        if (path === undefined) return fail("a workflow names a local action by a path the scan can't resolve", HINTS.path);
        reach.local.push({ path });
      } else if (uses.startsWith("docker://")) {
        if (!DOCKER_ACTION.test(uses)) fail("a workflow names a container image that is not a plain reference");
        reach.remote.push(uses);
      } else {
        const match = REMOTE_ACTION.exec(uses);
        if (match === null || uses.length > COMMENT_TRIGGER_FILE_NAME_MAX) return fail("a workflow names an action that is not a plain reference", HINTS.dynamic);
        if (`${match[1]!}/${match[2]!}`.toLowerCase() === self.repository && (match[4] === self.branch || match[4] === `refs/heads/${self.branch}`)) {
          // This repository at its default branch is the file that is there.
          const path = match[3] === undefined ? "" : normalizedPath(match[3]);
          if (path === undefined) return fail("a workflow names a path of this repository that is not a plain one", HINTS.path);
          reach.local.push({ path });
        } else {
          reach.remote.push(uses);
        }
      }
    }
    const run = node["run"];
    if (typeof run === "string") {
      const expanded = withKnownFolders(run, directory);
      const analysis = analyseRun(expanded);
      if (analysis.unresolvable) return fail("a run block holds something the scan can't resolve", analysis.hint);
      addScripts(analysis, toolManifests(expanded), here);
    }
    const shell = node["shell"];
    if (typeof shell === "string") {
      const analysis = shellFiles(shell, directory);
      if (analysis.unresolvable) return fail("a shell the scan can't resolve", analysis.hint);
      addScripts(analysis, [], here);
    }
    for (const name of ENV_FILE_VARIABLES) {
      const value = node[name];
      if (typeof value !== "string") continue;
      const analysis = analyseRun(`${name}=${withKnownFolders(value, directory)}`);
      if (analysis.unresolvable) return fail("an environment variable names a file the scan can't resolve", analysis.hint);
      addScripts(analysis, [], here);
    }
    // A local action that is not a composite one runs a file of its own.
    if (isRecord(node["runs"])) {
      for (const key of ["main", "pre", "post", "image"] as const) {
        const value = node["runs"][key];
        if (typeof value === "string" && !value.startsWith("docker://")) {
          const classified = classifyPath(directory === "" ? value : `${directory}/${value}`);
          if (classified === "unresolvable") return fail("an action runs a file the scan can't resolve", HINTS.path);
          if (typeof classified === "object") reach.scripts.push({ paths: [classified.path], strong: false, here: undefined, directory, args: undefined });
        }
      }
    }
    for (const value of Object.values(node)) visit(value, depth + 1, here);
  };
  visit(document, 0, undefined);
  return reach;
}

/** Whether a file is a shell script the scan should read for further paths: by its extension, or by a shebang. Scripts in other languages are hashed but not read. */
function isShellScript(text: string, path: string): boolean {
  return /\.(?:sh|bash|zsh)$/iu.test(path) || (text.startsWith("#!") && /\b(?:ba|z|da|k)?sh\b/u.test(text.split("\n", 1)[0]!));
}

// ---- the scan

async function scan(reader: AgentRepositoryReader, now: () => number, selfRepository: string): Promise<RepoCommandTriggers> {
  const started = now();
  const self: Self = { repository: selfRepository, branch: reader.defaultBranch };
  const hashed = new Map<string, string>();
  const remote = new Set<string>();
  let lookups = 0;
  const lookedUp = new Map<string, Awaited<ReturnType<AgentRepositoryReader["read"]>>>();
  const spend = (): void => {
    lookups += 1;
    if (lookups > MAX_LOOKUPS) fail("a scan needs too many lookups");
    if (now() - started > SCAN_BUDGET_MS) fail("a scan takes too long");
  };
  /** The folders of git submodules (from .gitmodules): their files are not in this repository's tree, so a path under one can't be read. */
  const submodules: string[] = [];
  const read = async (path: string) => {
    if (lookedUp.has(path)) return lookedUp.get(path);
    if (submodules.some((folder) => path === folder || path.startsWith(`${folder}/`))) return fail("a path is inside a git submodule", HINTS.submodule);
    spend();
    const file = await reader.read(path, MAX_FILE_BYTES);
    if (file !== undefined && "tooLarge" in file && file.tooLarge === true) fail("a file is over the size limit");
    lookedUp.set(path, file);
    return file;
  };

  // The workflow files, listed from the default branch.
  const listing = await reader.list(WORKFLOW_DIRECTORY);
  const workflows: Array<{ path: string; text: string; sha: string }> = [];
  if (listing !== undefined) {
    if (listing.truncated) fail("the workflow listing may be cut short");
    const named = listing.entries.filter((entry) => /\.ya?ml$/iu.test(entry.name));
    if (named.length > MAX_WORKFLOW_FILES) fail("more than 100 workflow files");
    for (const entry of named) {
      if (entry.type !== "file") fail("a workflow file is not a plain file");
      if (entry.size > MAX_FILE_BYTES) fail("a workflow file is over the size limit");
      const file = await read(entry.path);
      if (file === undefined || !("text" in file)) fail("a workflow file can't be read");
      else workflows.push({ path: entry.path, text: file.text, sha: file.sha });
    }
  }

  // The bot configs are present or not; their content is not parsed.
  const botConfigs: Array<{ path: string; sha: string }> = [];
  for (const path of BOT_CONFIG_PATHS) {
    const file = await read(path);
    if (file !== undefined) botConfigs.push({ path, sha: file.sha });
  }

  // Which workflows act on comments. A file that is not a workflow (not a mapping) can't be judged, so it fails closed.
  const triggering: Array<{ path: string; sha: string; document: unknown }> = [];
  const others: Array<{ path: string; sha: string; document: Record<string, unknown> }> = [];
  for (const workflow of workflows) {
    const document = parseYaml(workflow.text);
    if (!isRecord(document)) return fail("a workflow file is not a mapping");
    if (workflowTriggers(document)) triggering.push({ path: workflow.path, sha: workflow.sha, document });
    else others.push({ path: workflow.path, sha: workflow.sha, document });
  }

  // A comment can start any other workflow: a workflow_run workflow that follows it, a workflow_dispatch or repository_dispatch one it triggers
  // (`gh workflow run`), a push it makes. Whenever the repository triggers, every workflow of the repository is part of what was reviewed.
  const triggers = triggering.length > 0 || botConfigs.length > 0;
  const reviewed = [...triggering, ...(triggers ? others : [])];

  if (triggers) {
    // Git submodules: their files can't be read through this tree, so the file that names them is hashed and a path under one fails closed.
    const modules = await read(".gitmodules");
    if (modules !== undefined && "text" in modules) {
      hashed.set(".gitmodules", modules.sha);
      for (const match of modules.text.matchAll(/^\s*path\s*=\s*(.+?)\s*$/gmu)) {
        const folder = normalizedPath(match[1]!);
        if (folder !== undefined) submodules.push(folder);
      }
    }
  }

  for (const entry of [...reviewed, ...botConfigs]) hashed.set(entry.path, entry.sha);

  // What those workflows reach, transitively through local actions and reusable workflows.
  let reached = 0;
  const pending: Array<{ path: string; document: unknown; directory: string }> = reviewed.map((entry) => ({ path: entry.path, document: entry.document, directory: "" }));
  const visited = new Set<string>(reviewed.map((entry) => entry.path));
  /**
   * Hashes a file the workflows reach. A YAML file is followed (`followYaml`); a shell script is read for the files it runs in turn, with the same reading
   * of a shell block as a `run:` line has (`origin` says where it was named from), transitively and within the same 50 files.
   */
  const take = async (path: string, followYaml: boolean, directory: string, origin?: Origin): Promise<boolean> => {
    if (visited.has(path)) return hashed.has(path);
    visited.add(path);
    const file = await read(path);
    if (file === undefined || !("text" in file)) return false;
    reached += 1;
    if (reached > MAX_REACHED_FILES) fail("a workflow reaches more than 50 files");
    hashed.set(path, file.sha);
    if (followYaml) {
      pending.push({ path, document: parseYaml(file.text), directory });
    } else if (isShellScript(file.text, path)) {
      const expanded = withKnownFolders(file.text, origin?.directory ?? "");
      const analysis = analyseRun(expanded);
      if (analysis.unresolvable) fail("a script holds something the scan can't resolve", analysis.hint);
      const here = origin?.here;
      const group = (name: string, strong: boolean, args: string[] | undefined): Promise<void> =>
        takeGroup({ paths: here === undefined || here === "" ? [name] : [name, `${here}/${name}`], strong, here, directory: origin?.directory ?? "", args });
      for (const name of new Set([...analysis.candidates, ...toolManifests(expanded)])) {
        // An argument this script forwards (`"$@"`) is what its own caller passed.
        const written = Object.hasOwn(analysis.calls, name) ? analysis.calls[name]! : undefined;
        const forwarded = written?.flatMap((argument) => (POSITIONAL_PARAMETER.test(argument) ? origin?.args ?? [] : [argument]));
        await group(name, analysis.strong.includes(name), forwarded);
      }
      if (analysis.positional) {
        // The script runs what its caller passed: every argument is a candidate file, whatever it looks like.
        const passed = origin?.args;
        if (passed === undefined) return fail("a script runs what its caller passes, and the scan doesn't know the caller's arguments", HINTS.arguments);
        for (const argument of passed) {
          const classified = classifyPath(argument);
          if (classified === "unresolvable") fail("an argument names a file the scan can't resolve", whyUnresolvable(argument));
          if (typeof classified === "object") await group(classified.path, false, undefined);
        }
      }
    }
    return true;
  };
  /** A script named one way or another (as written, and under the step's working directory): any one of them being there is enough. A named path that is nowhere is an error. */
  const takeGroup = async (ref: ScriptRef): Promise<void> => {
    let found = false;
    for (const path of ref.paths) {
      if (await take(path, false, "", { here: ref.here, directory: ref.directory, args: ref.args })) found = true;
    }
    if (!found && ref.strong && !ref.paths.some((path) => BUILT_AT_RUN_TIME.test(path))) fail("a named file is not in the repository", HINTS.missing);
  };
  /** Every file under a local action's folder is that action's code, whether or not a run line names it. */
  const takeDirectory = async (directory: string, depth: number): Promise<void> => {
    if (depth > MAX_DIRECTORY_DEPTH) fail("a local action's folder is nested too deeply");
    spend();
    const listing = await reader.list(directory);
    if (listing === undefined) return;
    if (listing.truncated) fail("a local action's folder may be cut short");
    for (const entry of listing.entries) {
      if (entry.type === "dir") await takeDirectory(entry.path, depth + 1);
      else if (entry.type === "file") {
        if (entry.size > MAX_FILE_BYTES) fail("a file is over the size limit");
        await take(entry.path, false, "", { here: undefined, directory: entry.path.includes("/") ? entry.path.slice(0, entry.path.lastIndexOf("/")) : "", args: undefined });
      } else fail("a local action's folder holds something that is not a plain file");
    }
  };
  while (pending.length > 0) {
    const current = pending.shift()!;
    const reach = reachOf(current.document, current.directory, self);
    for (const uses of reach.remote) remote.add(uses);
    for (const { path } of reach.local) {
      if (/\.ya?ml$/iu.test(path)) {
        if (!await take(path, true, path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "")) fail("a reusable workflow is not in the repository", HINTS.missing);
      } else {
        let found = false;
        const action = [path === "" ? "action.yml" : `${path}/action.yml`, path === "" ? "action.yaml" : `${path}/action.yaml`];
        for (const candidate of action) {
          // A cycle of actions comes back to one already taken.
          if (visited.has(candidate)) { if (hashed.has(candidate)) { found = true; break; } continue; }
          const manifest = await read(candidate);
          if (manifest !== undefined && "text" in manifest) {
            // A root action's code can be anywhere in the repository, so only a composite one (whose steps the scan reads) is followed.
            if (path === "") {
              const parsed = parseYaml(manifest.text);
              if (!isRecord(parsed) || !isRecord(parsed["runs"]) || parsed["runs"]["using"] !== "composite") fail("a root action that is not composite runs code the scan can't enumerate");
            }
            found = true;
            await take(candidate, true, path);
            // The root action is the whole repository; only its action file is its own.
            if (path !== "") await takeDirectory(path, 0);
            break;
          }
        }
        if (!found) fail("a local action has no action file", HINTS.missing);
      }
    }
    for (const script of reach.scripts) await takeGroup(script);
  }

  const files = [...hashed.keys(), ...remote].sort();
  if (files.length > COMMENT_TRIGGER_FILES_MAX) fail("a scan lists too many files");
  // What is listed reaches the API and the page an admin decides on: a name with a control or format character (a bidi override, say) is not shown, it fails closed.
  if (files.some((file) => file.length > COMMENT_TRIGGER_FILE_NAME_MAX || /[\p{Cc}\p{Cf}]/u.test(file))) fail("a file name holds control or format characters");
  const pairs = [...hashed.entries()].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return {
    triggers,
    failedClosed: false,
    digest: sha256(pairs.map(([path, sha]) => `${path}\t${sha}\n`).join("")),
    files,
    fileShas: Object.fromEntries(pairs),
  };
}

/**
 * Whether the repository's default branch has workflows that act on comments, reviews, discussions, issues or labels, or a bot config (Mergify, bors,
 * Kodiak, Atlantis). Fails closed: a repository that can't be read, a listing that may be cut short, a file that doesn't parse, more than 100 workflow
 * files, any file over 512 KiB or more than 50 reached files answers `triggers: true, failedClosed: true`. The org's own scope reads it (an
 * installation bound to another org gives no token, which also fails closed). A successful scan is kept for this run only, in `deps.cache`; a failed one is
 * not, so the next call tries again.
 */
export async function repoCommandTriggers(deps: RepoScanDependencies, input: { orgId: OrgId; repository: string; /** The installation the project pinned for this repository: the reader is held to it. */ installationId?: number | undefined }): Promise<RepoCommandTriggers> {
  const checked = CommentTriggerRepositorySchema.safeParse(input.repository);
  if (!checked.success) throw agentXError("CONFIG_INVALID", "repository: must be a repository as owner/name");
  const key = cacheNameOf(input.orgId, checked.data.toLowerCase());
  const kept = await deps.cache?.get("repo-scan", key);
  if (isKeptScan(kept)) return kept;
  let result: RepoCommandTriggers;
  try {
    const reader = await deps.repositoryReader({ orgId: input.orgId, repositoryUrl: `https://github.com/${checked.data}.git`, ...(input.installationId === undefined ? {} : { installationId: input.installationId }) });
    result = await scan(reader, deps.now ?? Date.now, checked.data.toLowerCase());
  } catch (error) {
    // Whatever went wrong, nothing is known about this repository, so the answer is the cautious one. The reason stays out of the answer and the log:
    // it may hold a path or a name from the repository.
    return failedClosed(error instanceof ScanFailure ? error.hint : undefined);
  }
  await deps.cache?.set("repo-scan", key, result);
  return result;
}

function isKeptScan(value: unknown): value is RepoCommandTriggers {
  return isRecord(value) && typeof value["triggers"] === "boolean" && value["failedClosed"] === false && typeof value["digest"] === "string"
    && Array.isArray(value["files"]) && isRecord(value["fileShas"]);
}
