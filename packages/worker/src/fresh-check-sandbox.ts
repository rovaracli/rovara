// TE-B1-fresh: the pieces of a fresh check sandbox that are not Docker calls: its `docker run` arguments with the allow-list that judges them, and the clean export of the candidate commit it is made from.
// The round itself (the one place that STARTS the sandbox) is fresh-check-round.ts; a source guard keeps `freshSandboxRunArgs` there.
//
// THE EXPORT IS THE COMMIT. The fresh sandbox mounts a new worker-owned directory that holds the regular files of the candidate COMMIT and nothing else: not an untracked file, an ignored file, an uncommitted edit, a `.git` folder (so no
// hook), a `node_modules` the agent edited, a symlink or a submodule (the last two are reported, never written). It is made through e2e-candidate-source.ts's `createProcessCandidateGit`, which runs no git inside the candidate's own
// repository, and it is refused when the commit's tree is not the tree the candidate names. The directory is under `<workspace>/.agentx/fresh-check`: the working sandbox hides `.agentx` behind an empty mount (workspace-state.ts), and the
// Docker host shares the workspace with the worker at the same path.
//
// THE EXPORT IS VERIFIED (fresh-check-export.ts): every object is hashed against the id it was asked for, because the candidate's object store is agent-writable. The lane's OWN CAPS are 100,000 files, 1 GiB in all, 100 MiB a file; blobs stream to disk
// and the free space is checked first. A repository over them, or a disk too small, is refused in plain words; nothing is ever cut to fit.
import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import { removeWithoutFollowing } from "./e2e-candidate-source.js";
import { FreshExportError, makeRemovable, materializeVerified, type FreshExportCaps, type FreshSkippedEntry } from "./fresh-check-export.js";
import { privateAddressHostArgs } from "./private-address-hosts.js";
import { SANDBOX_INIT, TASK_SANDBOX_NETWORK, TASK_SANDBOX_USER, taskSandboxRunArgs, workspaceKey } from "./task-sandbox.js";

/** Why a fresh round did not run. Fixed codes: nothing a repository, git or docker printed is ever repeated. */
export type FreshNotRunReason = "export_failed" | "tree_changed" | "too_large" | "no_space" | "corrupt" | "quiesce_failed" | "sandbox_failed" | "no_image" | "not_prepared" | "stopped";

/** The words the check shows for each reason. Each starts with "not run", and none says "sealed". */
export const FRESH_NOT_RUN_SENTENCES: Readonly<Record<FreshNotRunReason, string>> = {
  export_failed: "not run: the fresh check sandbox could not start (the committed code could not be exported)",
  tree_changed: "not run: the fresh check sandbox could not start (the files changed after they were committed, so they are not the committed code)",
  too_large: "not run: the repository is too large for a fresh check sandbox",
  no_space: "not run: there is not enough free disk space for a fresh check sandbox",
  corrupt: "not run: the committed code could not be read safely (an object is missing or does not match its id)",
  quiesce_failed: "not run: programs the agent left running could not be stopped, so the fresh check sandbox did not start",
  sandbox_failed: "not run: the fresh check sandbox could not start (the container did not start)",
  no_image: "not run: the fresh check sandbox could not start (no sandbox image is configured)",
  not_prepared: "not run: the fresh check sandbox could not be prepared (the project's setup did not finish)",
  stopped: "not run: the task was stopped before the fresh check sandbox was ready",
};

/** Marks a container as a fresh check sandbox (beside the task's own labels, which the leftover sweep at worker start uses to remove it). */
export const FRESH_SANDBOX_ROUND_LABEL = "rovara.check-round=fresh";
/** Under the workspace, in the folder the working sandbox cannot see. */
export const FRESH_EXPORT_PARENT = join(".agentx", "fresh-check");
const SCRATCH_NAME = "scratch";

export interface FreshSandboxRunInput {
  name: string;
  taskId: string;
  image: string;
  /** The WORKING root: the path the sandbox sees the export at, so every path a check names means the same thing in both places. */
  rootPath: string;
  /** The export directory on the host: the only mount. */
  exportDirectory: string;
  hostCpus?: number;
  hostMemoryBytes?: number;
  /** Where the wall's pinned hosts are read from; default: this process's environment. */
  environment?: NodeJS.ProcessEnv;
}

const exportParentOf = (rootPath: string): string => join(resolve(rootPath), FRESH_EXPORT_PARENT);

/**
 * The `docker run` arguments of a fresh check sandbox: the task sandbox's hardening (non-root user, no capability, no-new-privileges, pids, cpu and memory limits, the `agentx-task` network, the task labels), with the export as the only
 * mount (at the working root's path, with no masked folders: there is nothing of the worker's in it) and one more label. It never joins a helper network and takes no `--add-host` but the wall's own pinned hosts.
 */
export function freshSandboxRunArgs(input: FreshSandboxRunInput): string[] {
  const exportDirectory = resolve(input.exportDirectory);
  if (!exportDirectory.startsWith(exportParentOf(input.rootPath) + sep)) throw new Error("the fresh check sandbox's export is not a folder under the working root's own fresh-check folder, so it would not be kept from the working root");
  const base = taskSandboxRunArgs({
    name: input.name, taskId: input.taskId, image: input.image, rootPath: resolve(input.rootPath), maskedPaths: [],
    ...(input.hostCpus === undefined ? {} : { hostCpus: input.hostCpus }), ...(input.hostMemoryBytes === undefined ? {} : { hostMemoryBytes: input.hostMemoryBytes }),
    ...(input.environment === undefined ? {} : { environment: input.environment }),
  });
  const args: string[] = [];
  for (let index = 0; index < base.length; index += 1) {
    const arg = base[index]!;
    if (arg === "--volume") { args.push(arg, `${exportDirectory}:${resolve(input.rootPath)}`); index += 1; continue; }
    args.push(arg);
    if (arg === "--label" && base[index + 1]!.startsWith("agentx.workspace=")) { args.push(base[index + 1]!, "--label", FRESH_SANDBOX_ROUND_LABEL); index += 1; }
  }
  return args;
}

const VALUE_FLAGS = new Set(["--name", "--label", "--network", "--add-host", "--user", "--cpus", "--memory", "--memory-swap", "--pids-limit", "--cap-drop", "--security-opt", "--volume", "--workdir", "--entrypoint"]);

/**
 * The allow-list a fresh sandbox's arguments must pass before they are run (in the style of check-sandbox.ts's `checkSandboxArgProblems`, which this does not touch): exactly one network (`agentx-task`), the unprivileged user, every
 * capability dropped, no-new-privileges, exactly one mount (the export, at the working root's path), the task's labels, the expected name and image, and no flag that is not on the list (no `--privileged`, `--cap-add`, `--pid`, `--device`,
 * `--tmpfs`, second network, docker socket). An `--add-host` passes only when it is one the wall pinned. Returns the problems, empty when the arguments are fine.
 */
export function freshSandboxArgProblems(args: readonly string[], expected: FreshSandboxRunInput): string[] {
  const problems: string[] = [];
  const root = resolve(expected.rootPath);
  const pinned = new Set(privateAddressHostArgs(expected.environment ?? process.env).filter((_, index) => index % 2 === 1));
  const labels = new Set([`agentx.task=${expected.taskId}`, `agentx.workspace=${workspaceKey(root)}`, FRESH_SANDBOX_ROUND_LABEL]);
  const seen = { name: false, network: false, user: false, capDrop: false, securityOpt: false, volumes: 0 };
  if (args[0] !== "run" || args[1] !== "--detach") problems.push("the arguments do not start with `run --detach`");
  let index = 2;
  for (; index < args.length; index += 1) {
    const flag = args[index]!;
    if (!flag.startsWith("-")) break;
    if (!VALUE_FLAGS.has(flag)) { problems.push(`flag ${flag} is not allowed`); continue; }
    const value = args[index + 1];
    index += 1;
    if (value === undefined) { problems.push(`${flag} has no value`); break; }
    switch (flag) {
      case "--name": seen.name = true; if (value !== expected.name) problems.push("name is not the expected container name"); break;
      case "--label": if (!labels.has(value)) problems.push(`label ${value.split("=")[0]!} is not an expected label`); break;
      case "--network": seen.network = true; if (value !== TASK_SANDBOX_NETWORK) problems.push(`network must be ${TASK_SANDBOX_NETWORK} and only that`); break;
      case "--add-host": if (!pinned.has(value)) problems.push("add-host is not one the host's wall pinned"); break;
      case "--user": seen.user = true; if (value !== TASK_SANDBOX_USER) problems.push("user is not the unprivileged sandbox user"); break;
      case "--cap-drop": seen.capDrop = true; if (value !== "ALL") problems.push("--cap-drop must be ALL"); break;
      case "--security-opt": seen.securityOpt = true; if (value !== "no-new-privileges") problems.push("only --security-opt no-new-privileges is allowed"); break;
      case "--volume": seen.volumes += 1; if (value !== `${resolve(expected.exportDirectory)}:${root}`) problems.push("volume: the export at the working root's path is the only mount"); break;
      case "--workdir": if (value !== root) problems.push("workdir is not the working root's path"); break;
      case "--entrypoint": if (value !== SANDBOX_INIT) problems.push("entrypoint is not the sandbox init"); break;
      default: if (!/^[0-9a-z.]+$/u.test(value)) problems.push(`${flag} has a value that is not a plain limit`);
    }
  }
  if (args[index] !== expected.image) problems.push("image is not the expected one");
  if (args[index + 1] !== "--" || args[index + 2] !== "sleep" || args[index + 3] !== "infinity" || args.length !== index + 4) problems.push("the command is not `sleep infinity`");
  if (!seen.name) problems.push("name is missing");
  if (!seen.network) problems.push("network is missing");
  if (!seen.user) problems.push("user is missing");
  if (!seen.capDrop) problems.push("--cap-drop ALL is missing");
  if (!seen.securityOpt) problems.push("no-new-privileges is missing");
  if (seen.volumes !== 1) problems.push("volume: exactly one mount is allowed");
  return problems;
}

// ---- the export

export interface FreshCandidateRepository {
  repositoryId: string;
  /** The repository's folder relative to the workspace root (the manifest's `path`; "." for a repository at the root). */
  path: string;
  /** The repository's directory on the worker (only its object store is read). */
  directory: string;
  commitSha: string;
  /** The tree the candidate names: the commit's tree must be exactly this one. */
  treeSha: string;
}

export interface FreshSkippedRepositoryEntry extends FreshSkippedEntry { repositoryId: string }

export type FreshExportResult = { ok: true; directory: string; skipped: FreshSkippedRepositoryEntry[] } | { ok: false; reason: FreshNotRunReason };

const safeName = (text: string): string => text.replace(/[^a-zA-Z0-9_.-]/gu, "-").slice(0, 40) || "task";
/** A repository path that stays inside the workspace: relative, no `..`, no NUL, no empty part ("." is the root itself). */
function safeRelativePath(path: string): boolean {
  if (path === ".") return true;
  return path !== "" && !path.startsWith("/") && !path.includes("\0") && path.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

/**
 * Writes the candidate commit of every repository into a NEW directory (a fresh one for each call: a second round on the same task gets its own) and returns it with the symlinks and submodules that were skipped. Refuses
 * (`{ ok: false }`, nothing left behind) when a path leaves the workspace, a tree is not the one named, a repository is over the caps, or git fails. Never writes anything of the working tree.
 */
export async function exportCandidateForFreshRound(input: {
  rootPath: string; taskId: string; repositories: readonly FreshCandidateRepository[]; signal: AbortSignal; caps?: Partial<FreshExportCaps> | undefined;
}): Promise<FreshExportResult> {
  if (input.repositories.length === 0 || input.repositories.some((repository) => !safeRelativePath(repository.path))) return { ok: false, reason: "export_failed" };
  const parent = exportParentOf(input.rootPath);
  let directory: string | undefined;
  try {
    await mkdir(parent, { recursive: true, mode: 0o700 });
    directory = await mkdtemp(join(parent, `${safeName(input.taskId)}-`));
    await chmod(directory, 0o755);
    const skipped: FreshSkippedRepositoryEntry[] = [];
    for (const repository of [...input.repositories].sort((left, right) => left.repositoryId.localeCompare(right.repositoryId))) {
      if (input.signal.aborted) return await refuse(parent, directory, "stopped");
      const destination = repository.path === "." ? directory : join(directory, repository.path);
      await mkdir(destination, { recursive: true, mode: 0o755 });
      await chmod(destination, 0o755);
      const entries = await materializeVerified({ repositoryRoot: resolve(repository.directory), commitSha: repository.commitSha, treeSha: repository.treeSha, destination, scratchRoot: join(parent, SCRATCH_NAME), signal: input.signal, ...(input.caps === undefined ? {} : { caps: input.caps }) });
      for (const entry of entries) skipped.push({ repositoryId: repository.repositoryId, ...entry });
    }
    return { ok: true, directory, skipped };
  } catch (error) {
    if (directory !== undefined) await removeFreshExport(input.rootPath, directory).catch(() => undefined);
    if (input.signal.aborted) return { ok: false, reason: "stopped" };
    return { ok: false, reason: error instanceof FreshExportError ? error.reason : "export_failed" };
  }
}

async function refuse(parent: string, directory: string, reason: FreshNotRunReason): Promise<FreshExportResult> {
  await removeWithoutFollowing(parent, basename(directory)).catch(() => undefined);
  return { ok: false, reason };
}

/** Removes an export directory made by `exportCandidateForFreshRound`, without following a link; a path that is not directly under the fresh-check folder is refused. */
export async function removeFreshExport(rootPath: string, directory: string): Promise<void> {
  const parent = exportParentOf(rootPath);
  if (dirname(resolve(directory)) !== parent || basename(directory) === SCRATCH_NAME) throw new Error("not a fresh check export");
  // a check may have left a folder at 0000 or 0555: made removable first, never following a link
  await makeRemovable(resolve(directory));
  await removeWithoutFollowing(parent, basename(directory));
}

/** A random suffix for a container name. */
export const freshSandboxSuffix = (): string => randomUUID().replace(/-/gu, "").slice(0, 8);
