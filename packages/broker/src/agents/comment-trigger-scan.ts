// Plan 3 Task 14b (R1-1, R3-1): does this repository have workflows or bots that act on comments, issues or labels? If it does, every comment, review
// or label an agent writes there, and every issue it creates or edits, can start a deploy or a merge, so each needs a person whatever the text says
// (Task 20b's `classifyWrite` asks `repoCommandTriggers`). The scan reads the repository's DEFAULT branch, because `issue_comment`, `issues` and
// `discussion*` workflows always run from it, through a read-only agent token (`contents: read`), at one commit.
//
// The scan also reaches into what a triggering workflow runs: local actions and reusable workflows (followed, at most 50 files), and the scripts named in
// `run:` lines. The digest covers all of them, so an opt-out (comment-trigger-optouts.ts) lapses when any of them changes. Remote actions are listed with
// their ref but not hashed (Accepted residual risks). Anything the scan cannot read completely answers `triggers: true, failedClosed: true`.
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
  repositoryReader: (input: { orgId: OrgId; repositoryUrl: string }) => Promise<AgentRepositoryReader>;
  /** Where this run keeps what it found. Without one, every call reads again. Nothing is kept across runs. */
  cache?: RunCache;
  now?: () => number;
}

export const WORKFLOW_DIRECTORY = ".github/workflows";
export const BOT_CONFIG_PATHS: readonly string[] = [".mergify.yml", ".mergify/config.yml", ".github/mergify.yml", "bors.toml", ".kodiak.toml", ".github/.kodiak.toml", "atlantis.yaml"];
export const MAX_WORKFLOW_FILES = 100;
export const MAX_FILE_BYTES = 512 * 1024;
export const MAX_REACHED_FILES = 50;
/** Lookups of paths named in `run:` lines that turn out not to be files cost a request each; this many in one scan is the most. */
const MAX_LOOKUPS = 400;
/** A scan that takes longer than this gives up (fail closed): the call it is part of has its own time to keep. */
export const SCAN_BUDGET_MS = 25_000;
const MAX_WALK_DEPTH = 64;
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
  const document = parseDocument(text, { version: "1.2", schema: "core", uniqueKeys: true });
  if (document.errors.length > 0) return fail("a file does not parse");
  return document.toJS({ maxAliasCount: 100 });
}

// ---- what a workflow reaches

function normalizedPath(raw: string): string | undefined {
  const withoutDot = raw.replace(/^\.\//u, "").replace(/\/+$/u, "");
  if (withoutDot === "" || withoutDot.length > 300 || withoutDot.startsWith("/") || withoutDot.includes("\\") || /[\p{Cc}$*{}~]/u.test(withoutDot)) return undefined;
  const parts = withoutDot.split("/");
  return parts.some((part) => part === "" || part === "." || part === "..") ? undefined : parts.join("/");
}

const INTERPRETERS = new Set(["bash", "sh", "zsh", "dash", "ksh", "fish", "node", "nodejs", "python", "python2", "python3", "ruby", "perl", "php", "deno", "bun", "tsx", "ts-node", "pwsh", "powershell", "source", "."]);
const SCRIPT_EXTENSION = /\.(?:sh|bash|zsh|py|rb|js|mjs|cjs|ts|pl|ps1|php)$/u;

/** The paths a shell block might run: `./x`, a path with a script extension, and the word after an interpreter (`bash scripts/x.sh`, `python x.py`). */
export function scriptCandidates(run: string): string[] {
  const found = new Set<string>();
  for (const line of run.split(/\r\n|\r|\n|\u2028|\u2029|\u0085/u)) {
    const tokens = line.split(/[\s;|&()<>"'`]+/u).filter((token) => token !== "");
    let afterInterpreter = false;
    for (const token of tokens) {
      if (found.size >= MAX_CANDIDATES_PER_RUN_BLOCK) return [...found];
      if (INTERPRETERS.has(token.toLowerCase())) { afterInterpreter = true; continue; }
      if (token.startsWith("-") && afterInterpreter) continue;
      const looksLikeScript = afterInterpreter || token.startsWith("./") || (token.includes("/") && SCRIPT_EXTENSION.test(token.toLowerCase()));
      afterInterpreter = false;
      if (!looksLikeScript || token.includes("://")) continue;
      const path = normalizedPath(token);
      if (path !== undefined) found.add(path);
    }
  }
  return [...found];
}

interface Reach {
  /** `uses` values that name a local action or reusable workflow, and the folder their `runs` paths are relative to. */
  local: Array<{ path: string }>;
  remote: string[];
  scripts: string[];
}

/** Everything a parsed workflow or action file names: its `uses` (local or remote) and the scripts in its `run` blocks, wherever they are in the tree. */
function reachOf(document: unknown, directory: string): Reach {
  const reach: Reach = { local: [], remote: [], scripts: [] };
  const visit = (node: unknown, depth: number, workingDirectory: string | undefined): void => {
    if (depth > MAX_WALK_DEPTH) return fail("a workflow is nested too deeply");
    if (Array.isArray(node)) { for (const item of node) visit(item, depth + 1, workingDirectory); return; }
    if (!isRecord(node)) return;
    const here = typeof node["working-directory"] === "string" ? normalizedPath(node["working-directory"]) ?? workingDirectory : workingDirectory;
    const uses = node["uses"];
    if (typeof uses === "string") {
      if (uses.startsWith("./") || uses === ".") {
        const path = uses === "." || uses === "./" ? "" : normalizedPath(uses);
        if (path !== undefined) reach.local.push({ path });
      } else {
        if (uses.length > COMMENT_TRIGGER_FILE_NAME_MAX) fail("a workflow names an action by a very long reference");
        reach.remote.push(uses);
      }
    }
    const run = node["run"];
    if (typeof run === "string") {
      for (const candidate of scriptCandidates(run)) {
        reach.scripts.push(candidate);
        if (here !== undefined) reach.scripts.push(`${here}/${candidate}`);
      }
    }
    // A local action that is not a composite one runs a file of its own.
    if (isRecord(node["runs"])) {
      for (const key of ["main", "pre", "post", "image"] as const) {
        const value = node["runs"][key];
        if (typeof value === "string" && !value.startsWith("docker://")) {
          const path = normalizedPath(directory === "" ? value : `${directory}/${value}`);
          if (path !== undefined) reach.scripts.push(path);
        }
      }
    }
    for (const value of Object.values(node)) visit(value, depth + 1, here);
  };
  visit(document, 0, undefined);
  return reach;
}

// ---- the scan

async function scan(reader: AgentRepositoryReader, now: () => number): Promise<RepoCommandTriggers> {
  const started = now();
  const hashed = new Map<string, string>();
  const remote = new Set<string>();
  let lookups = 0;
  const lookedUp = new Map<string, Awaited<ReturnType<AgentRepositoryReader["read"]>>>();
  const read = async (path: string) => {
    if (lookedUp.has(path)) return lookedUp.get(path);
    lookups += 1;
    if (lookups > MAX_LOOKUPS) return fail("a scan needs too many lookups");
    if (now() - started > SCAN_BUDGET_MS) return fail("a scan takes too long");
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
  for (const workflow of workflows) {
    const document = parseYaml(workflow.text);
    if (!isRecord(document)) fail("a workflow file is not a mapping");
    if (workflowTriggers(document as Record<string, unknown>)) triggering.push({ path: workflow.path, sha: workflow.sha, document });
  }

  for (const entry of [...triggering, ...botConfigs]) hashed.set(entry.path, entry.sha);

  // What the triggering workflows reach, transitively through local actions and reusable workflows.
  let reached = 0;
  const pending: Array<{ path: string; document: unknown; directory: string }> = triggering.map((entry) => ({ path: entry.path, document: entry.document, directory: "" }));
  const visited = new Set<string>(triggering.map((entry) => entry.path));
  const take = async (path: string, followYaml: boolean, directory: string): Promise<void> => {
    if (visited.has(path)) return;
    visited.add(path);
    const file = await read(path);
    if (file === undefined || !("text" in file)) return;
    reached += 1;
    if (reached > MAX_REACHED_FILES) fail("a workflow reaches more than 50 files");
    hashed.set(path, file.sha);
    if (followYaml) pending.push({ path, document: parseYaml(file.text), directory });
  };
  while (pending.length > 0) {
    const current = pending.shift()!;
    const reach = reachOf(current.document, current.directory);
    for (const uses of reach.remote) remote.add(uses);
    for (const { path } of reach.local) {
      if (/\.ya?ml$/iu.test(path)) await take(path, true, path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");
      else {
        const action = [path === "" ? "action.yml" : `${path}/action.yml`, path === "" ? "action.yaml" : `${path}/action.yaml`];
        for (const candidate of action) {
          if (!visited.has(candidate) && (await read(candidate)) !== undefined) { await take(candidate, true, path); break; }
        }
      }
    }
    for (const script of reach.scripts) await take(script, false, "");
  }

  const files = [...hashed.keys(), ...remote].sort();
  if (files.length > COMMENT_TRIGGER_FILES_MAX) fail("a scan lists too many files");
  const pairs = [...hashed.entries()].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return {
    triggers: triggering.length > 0 || botConfigs.length > 0,
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
export async function repoCommandTriggers(deps: RepoScanDependencies, input: { orgId: OrgId; repository: string }): Promise<RepoCommandTriggers> {
  const checked = CommentTriggerRepositorySchema.safeParse(input.repository);
  if (!checked.success) throw agentXError("CONFIG_INVALID", "repository: must be a repository as owner/name");
  const key = cacheNameOf(input.orgId, checked.data.toLowerCase());
  const kept = await deps.cache?.get("repo-scan", key);
  if (isKeptScan(kept)) return kept;
  let result: RepoCommandTriggers;
  try {
    result = await scan(await deps.repositoryReader({ orgId: input.orgId, repositoryUrl: `https://github.com/${checked.data}.git` }), deps.now ?? Date.now);
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
