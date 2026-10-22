// Plan 3 Task 14b (R1-1, R3-1): does this repository have workflows or bots that act on comments, issues or labels? If it does, every comment, review
// or label an agent writes there, and every issue it creates or edits, can start a deploy or a merge, so each needs a person whatever the text says
// (Task 20b's `classifyWrite` asks `repoCommandTriggers`). The scan reads the repository's DEFAULT branch, because `issue_comment`, `issues` and
// `discussion*` workflows always run from it, through a read-only agent token (`contents: read`), at one commit.
//
// The scan also reaches into what a triggering workflow runs, and hashes it: local actions and reusable workflows (and every file in a local action's
// folder), the scripts and manifests named in `run:`, `shell:` and `BASH_ENV` (a shell script is read for the files it runs in turn, transitively),
// every `workflow_run` workflow whenever the repository triggers, `package.json` and `Makefile` where npm, npx, yarn, pnpm or make is run, and this
// repository's own files named remotely at its default branch. All of it counts against 50 files. The digest covers it, so an opt-out
// (comment-trigger-optouts.ts) lapses when any of it changes. Remote actions are listed with their ref and not hashed.
//
// The scan can never be complete, so wherever it can't tell which file runs it FAILS CLOSED (`triggers: true, failedClosed: true`: no opt-out is
// possible and comments stay consequential). That is: a file it can't read or parse, a listing that may be cut short, more than 100 workflow files, a file over
// 512 KiB, more than 50 reached files, a name with a control or format character, a remote reference that is not `owner/repo[/path]@ref` or `docker://`,
// a `${{ }}` expression or a shell variable (other than github.workspace/github.action_path and their environment forms) where a path goes (a `run:` path,
// `working-directory`, `shell:`, `BASH_ENV`, `uses:`), `..` in a path, a glob or brace expansion, `cd`, `pushd` or `popd` in anything it reads, a custom
// `shell:` that is not a plain path, a root action (`uses: ./`) that is not composite, and a symlink or submodule where it lists.
//
// What remains, exactly (Accepted residual risks, shown to the admin as COMMENT_TRIGGER_COVERAGE_NOTE):
//  - a command run by bare name or resolved from the PATH, including a script run by name with no path (`deploy`), unless npm, npx, yarn, pnpm or make runs it;
//  - code fetched or built at run time (a download, a package install, a Docker build step's context, a remote action or its ref's content);
//  - files a script in another language imports or requires (only shell scripts are read for further paths; a Python or JavaScript script is hashed);
//  - what a Makefile or package.json itself runs beyond hashing those two files, and a script reached by a path that only a runtime value decides inside a
//    shell construct the tokenizer does not model (a here-document, eval, a variable built from pieces);
//  - the bodies of a Dockerfile, of dependencies installed by a package manager, and of anything a local action's own non-composite code loads from outside its folder;
//  - a workflow on a branch other than the default (it matters once it is merged, and the next run's scan sees it);
//  - symlinked directories on the path to a script, which the API may report as absent.
import { createHash } from "node:crypto";
import { parseDocument } from "yaml";
import { CommentTriggerRepositorySchema, COMMENT_TRIGGER_FILES_MAX, COMMENT_TRIGGER_FILE_NAME_MAX, agentXError, type OrgId } from "@agentx/contracts";
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

class ScanFailure extends Error {}
const fail = (why: string): never => { throw new ScanFailure(why); };

const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

function failedClosed(): RepoCommandTriggers {
  return { triggers: true, failedClosed: true, digest: FAILED_DIGEST, files: [], fileShas: {} };
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
const SCRIPT_EXTENSION = /\.(?:sh|bash|zsh|py|rb|js|mjs|cjs|ts|pl|ps1|php)$/u;
/** Stands for one `${{ ... }}` expression while a run block is read: what an expression names is not known to the scan. */
const EXPRESSION_MARK = "\u0001";
const EXPRESSION = /\$\{\{(?:(?!\}\}).){0,1000}\}\}/gsu;
const MAX_RUN_TEXT = 100_000;
const DIRECTORY_COMMANDS = new Set(["cd", "pushd", "popd"]);

const POSITIONAL_PARAMETER = /^\$(?:[@*#?0-9]|\{[@*#?0-9]+\})$/u;

type Classified = { path: string } | "outside" | "unresolvable";

/**
 * What a word in a path position names. A path outside the repository (absolute, `~`, a URL, the root itself) is `outside`: no file of the repository is
 * meant. Anything the scan can't turn into one file of the repository (a variable or expression, `..`, a glob or brace expansion, a Windows path) is
 * `unresolvable`, and the scan fails closed on it.
 */
function classifyPath(word: string): Classified {
  // A positional parameter (`$@`, `$1`) is what the caller passed: its text is in the caller's own run block, where it is read.
  if (word.startsWith("/") || word.startsWith("~") || word.includes("://") || word === "." || word === "./" || POSITIONAL_PARAMETER.test(word)) return "outside";
  if (word.includes(EXPRESSION_MARK) || word.includes("$") || /[*{}\\]/u.test(word) || word.split("/").includes("..")) return "unresolvable";
  const path = normalizedPath(word);
  return path === undefined ? "unresolvable" : { path };
}

export interface RunAnalysis {
  /** The files of the repository a shell block may run, source or read: `./x`, a path with a script extension, the word after an interpreter. */
  candidates: string[];
  /** The block holds something the scan can't resolve: a `cd`, `pushd` or `popd`, a variable or expression where a path goes, `..`, a glob, too much text. */
  unresolvable: boolean;
}

/**
 * Reads a shell block the way the scan needs: which repository files it may run. A path position is the command word, the word after an interpreter
 * (`bash x`, `python x`, `source x`), a word starting `./`, and a word with a slash and a script extension. `BASH_ENV=<file>` names a file too. A bare command word
 * (`make`, `git`) is not a path: it is found on the PATH (an accepted residual risk). Full-line comments are skipped.
 */
export function analyseRun(run: string): RunAnalysis {
  if (run.length > MAX_RUN_TEXT) return { candidates: [], unresolvable: true };
  const candidates = new Set<string>();
  let unresolvable = false;
  const take = (word: string): void => {
    const classified = classifyPath(word);
    if (classified === "unresolvable") unresolvable = true;
    else if (classified !== "outside") candidates.add(classified.path);
  };
  const text = run.replace(EXPRESSION, EXPRESSION_MARK);
  for (const line of text.split(/\r\n|\r|\n|\u2028|\u2029|\u0085/u)) {
    if (line.trimStart().startsWith("#") && !line.startsWith("#!")) continue;
    for (const segment of line.split(/&&|\|\||[;|&]/u)) {
      const words = segment.split(/[\s()<>"'`]+/u).filter((word) => word !== "");
      let leading = true;
      let afterInterpreter = false;
      for (let index = 0; index < words.length; index += 1) {
        const word = words[index]!;
        const lower = word.toLowerCase();
        if (word.startsWith("BASH_ENV=")) {
          let value = word.slice("BASH_ENV=".length);
          if (value === "" && index + 1 < words.length) { index += 1; value = words[index]!; }
          take(value);
          continue;
        }
        if (DIRECTORY_COMMANDS.has(lower)) { unresolvable = true; continue; }
        if (leading && /^[A-Za-z_][A-Za-z0-9_]*=/u.test(word)) continue;
        const command = leading;
        leading = false;
        if (INTERPRETERS.has(lower) && (lower !== "." || command)) { afterInterpreter = true; continue; }
        if (afterInterpreter && word.startsWith("-")) continue;
        const dynamic = word.includes(EXPRESSION_MARK) || word.includes("$");
        const pathPosition = afterInterpreter || (command && (dynamic || word.includes("/"))) || word.startsWith("./") || word.startsWith("../") || (word.includes("/") && SCRIPT_EXTENSION.test(lower));
        afterInterpreter = false;
        if (pathPosition) take(word);
        if (candidates.size >= MAX_CANDIDATES_PER_RUN_BLOCK) return { candidates: [...candidates], unresolvable: true };
      }
    }
  }
  return { candidates: [...candidates], unresolvable };
}

/** The files a shell block may run (see `analyseRun`; what it can't resolve is not listed here). */
export function scriptCandidates(run: string): string[] {
  return analyseRun(run).candidates;
}

const STANDARD_SHELLS = new Set([...INTERPRETERS, "cmd"]);

/**
 * What a `shell:` value runs. The standard shells and their flags run nothing of the repository; a plain path to a file is that file; anything else
 * (an expression, a variable, `..`, a command found on the PATH) can't be resolved.
 */
function shellFiles(value: string, actionDirectory: string): RunAnalysis {
  const candidates = new Set<string>();
  let unresolvable = false;
  let afterFlag = false;
  for (const raw of withKnownFolders(value, actionDirectory).replace(EXPRESSION, EXPRESSION_MARK).split(/\s+/u)) {
    const word = raw.replace(/^["']+|["']+$/gu, "");
    if (word === "" || word.includes("{0}")) continue;
    if (word.startsWith("-")) { afterFlag = true; continue; }
    if (afterFlag && /^[A-Za-z]+$/u.test(word)) { afterFlag = false; continue; }
    afterFlag = false;
    if (STANDARD_SHELLS.has(word.toLowerCase())) continue;
    const classified = classifyPath(word);
    if (classified === "unresolvable" || (classified !== "outside" && !word.includes("/") && !SCRIPT_EXTENSION.test(word.toLowerCase()))) unresolvable = true;
    else if (classified !== "outside") candidates.add(classified.path);
  }
  return { candidates: [...candidates], unresolvable };
}

/** A `working-directory` value: the folder it names ("" for the root), undefined when it is outside the repository. An expression or variable the scan can't resolve fails closed. */
function workingDirectoryOf(value: string, actionDirectory: string): string | undefined {
  const classified = classifyPath(withKnownFolders(value, actionDirectory).replace(EXPRESSION, EXPRESSION_MARK));
  if (classified === "unresolvable") return fail("a working directory the scan can't resolve");
  if (classified === "outside") return value.trim() === "." || value.trim() === "./" ? "" : undefined;
  return classified.path;
}

/** A script (or manifest) the scan should hash, with where it was named from: the step's working directory and the action folder `github.action_path` meant. */
interface ScriptRef { path: string; here: string | undefined; directory: string }

interface Reach {
  /** `uses` values that name a local action or reusable workflow. */
  local: Array<{ path: string }>;
  remote: string[];
  scripts: ScriptRef[];
}

/** The repository being scanned and its default branch: a remote reference to it at that branch is its own file. */
interface Self { repository: string; branch: string }

/**
 * Everything a parsed workflow or action file names: its `uses` (local or remote) and the files its `run`, `shell` and `BASH_ENV` can run, wherever they
 * are in the tree. `directory` is the folder of the action the file is (empty for a workflow). Whatever can't be resolved fails the scan closed.
 */
function reachOf(document: unknown, directory: string, self: Self): Reach {
  const reach: Reach = { local: [], remote: [], scripts: [] };
  const addScripts = (paths: readonly string[], here: string | undefined): void => {
    for (const path of paths) {
      reach.scripts.push({ path, here, directory });
      if (here !== undefined && here !== "") reach.scripts.push({ path: `${here}/${path}`, here, directory });
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
        if (path === undefined) return fail("a workflow names a local action by a path the scan can't resolve");
        reach.local.push({ path });
      } else if (uses.startsWith("docker://")) {
        if (!DOCKER_ACTION.test(uses)) fail("a workflow names a container image that is not a plain reference");
        reach.remote.push(uses);
      } else {
        const match = REMOTE_ACTION.exec(uses);
        if (match === null || uses.length > COMMENT_TRIGGER_FILE_NAME_MAX) return fail("a workflow names an action that is not a plain reference");
        if (`${match[1]!}/${match[2]!}`.toLowerCase() === self.repository && (match[4] === self.branch || match[4] === `refs/heads/${self.branch}`)) {
          // This repository at its default branch is the file that is there.
          const path = match[3] === undefined ? "" : normalizedPath(match[3]);
          if (path === undefined) return fail("a workflow names a path of this repository that is not a plain one");
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
      if (analysis.unresolvable) return fail("a run block holds something the scan can't resolve");
      addScripts([...analysis.candidates, ...toolManifests(expanded)], here);
    }
    const shell = node["shell"];
    if (typeof shell === "string") {
      const analysis = shellFiles(shell, directory);
      if (analysis.unresolvable) return fail("a shell the scan can't resolve");
      addScripts(analysis.candidates, here);
    }
    const bashEnv = node["BASH_ENV"];
    if (typeof bashEnv === "string") {
      const analysis = analyseRun(`BASH_ENV=${withKnownFolders(bashEnv, directory)}`);
      if (analysis.unresolvable) return fail("a BASH_ENV the scan can't resolve");
      addScripts(analysis.candidates, here);
    }
    // A local action that is not a composite one runs a file of its own.
    if (isRecord(node["runs"])) {
      for (const key of ["main", "pre", "post", "image"] as const) {
        const value = node["runs"][key];
        if (typeof value === "string" && !value.startsWith("docker://")) {
          const classified = classifyPath(directory === "" ? value : `${directory}/${value}`);
          if (classified === "unresolvable") return fail("an action runs a file the scan can't resolve");
          if (classified !== "outside") reach.scripts.push({ path: classified.path, here: undefined, directory });
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
  const read = async (path: string) => {
    if (lookedUp.has(path)) return lookedUp.get(path);
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

  // A workflow_run workflow runs from the default branch after another workflow, and whatever it does, it does because of the comment that started the chain.
  // Whenever the repository triggers, every one of them is part of what was reviewed, whichever workflow it names (so a chain of any length is followed).
  const triggers = triggering.length > 0 || botConfigs.length > 0;
  const chained: typeof triggering = [];
  if (triggers) {
    for (const { path, sha, document } of others) {
      const on = Object.hasOwn(document, "on") ? document["on"] : document["true"];
      if (eventsOf(on).some(({ event }) => event === "workflow_run")) chained.push({ path, sha, document });
    }
  }
  const reviewed = [...triggering, ...chained];

  for (const entry of [...reviewed, ...botConfigs]) hashed.set(entry.path, entry.sha);

  // What those workflows reach, transitively through local actions and reusable workflows.
  let reached = 0;
  const pending: Array<{ path: string; document: unknown; directory: string }> = reviewed.map((entry) => ({ path: entry.path, document: entry.document, directory: "" }));
  const visited = new Set<string>(reviewed.map((entry) => entry.path));
  /**
   * Hashes a file the workflows reach. A YAML file is followed (`followYaml`); a shell script is read for the files it runs in turn, with the same reading
   * of a shell block as a `run:` line has (`origin` says where it was named from), transitively and within the same 50 files.
   */
  const take = async (path: string, followYaml: boolean, directory: string, origin?: { here: string | undefined; directory: string }): Promise<void> => {
    if (visited.has(path)) return;
    visited.add(path);
    const file = await read(path);
    if (file === undefined || !("text" in file)) return;
    reached += 1;
    if (reached > MAX_REACHED_FILES) fail("a workflow reaches more than 50 files");
    hashed.set(path, file.sha);
    if (followYaml) {
      pending.push({ path, document: parseYaml(file.text), directory });
    } else if (isShellScript(file.text, path)) {
      const expanded = withKnownFolders(file.text, origin?.directory ?? "");
      const analysis = analyseRun(expanded);
      if (analysis.unresolvable) fail("a script holds something the scan can't resolve");
      for (const candidate of [...analysis.candidates, ...toolManifests(expanded)]) {
        await take(candidate, false, "", origin);
        if (origin?.here !== undefined && origin.here !== "") await take(`${origin.here}/${candidate}`, false, "", origin);
      }
    }
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
        await take(entry.path, false, "", { here: undefined, directory: entry.path.includes("/") ? entry.path.slice(0, entry.path.lastIndexOf("/")) : "" });
      } else fail("a local action's folder holds something that is not a plain file");
    }
  };
  while (pending.length > 0) {
    const current = pending.shift()!;
    const reach = reachOf(current.document, current.directory, self);
    for (const uses of reach.remote) remote.add(uses);
    for (const { path } of reach.local) {
      if (/\.ya?ml$/iu.test(path)) await take(path, true, path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");
      else {
        const action = [path === "" ? "action.yml" : `${path}/action.yml`, path === "" ? "action.yaml" : `${path}/action.yaml`];
        for (const candidate of action) {
          const manifest = visited.has(candidate) ? undefined : await read(candidate);
          if (manifest !== undefined && "text" in manifest) {
            // A root action's code can be anywhere in the repository, so only a composite one (whose steps the scan reads) is followed.
            if (path === "") {
              const parsed = parseYaml(manifest.text);
              if (!isRecord(parsed) || !isRecord(parsed["runs"]) || parsed["runs"]["using"] !== "composite") fail("a root action that is not composite runs code the scan can't enumerate");
            }
            await take(candidate, true, path);
            // The root action is the whole repository; only its action file is its own.
            if (path !== "") await takeDirectory(path, 0);
            break;
          }
        }
      }
    }
    for (const script of reach.scripts) await take(script.path, false, "", { here: script.here, directory: script.directory });
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
  } catch {
    // Whatever went wrong, nothing is known about this repository, so the answer is the cautious one. The reason stays out of the answer and the log:
    // it may hold a path or a name from the repository.
    return failedClosed();
  }
  await deps.cache?.set("repo-scan", key, result);
  return result;
}

function isKeptScan(value: unknown): value is RepoCommandTriggers {
  return isRecord(value) && typeof value["triggers"] === "boolean" && value["failedClosed"] === false && typeof value["digest"] === "string"
    && Array.isArray(value["files"]) && isRecord(value["fileShas"]);
}
