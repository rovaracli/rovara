// What a setup run may cite (sh-setup-wire, SH14 fix round, F1). The agent has a shell in the working tree, and an install script can write files there: a `kalmius/project.json` or a file the model then cites
// would otherwise look like something the repository says. So:
//   - the scan of the folders (project files, MCP configs, hooks) is taken BEFORE the sandbox starts, from the pristine tree (`scanRepositories`, passed in as `scan`);
//   - a citation of a file that is not in the commit the broker resolved (`git ls-tree -r <commit>`) is dropped, and an item left with no citation is dropped with it;
//   - a devcontainer "exists" only if its file is in that commit.
// The broker then re-reads what is left from GitHub at the same commit (verifyProposalDetailed) before anything shows the proposal.
import { agentXError } from "@agentx/contracts";
import { runIsolatedGit } from "./isolated-repository.js";

export type TrackedPaths = ReadonlyMap<string, ReadonlySet<string>>;
const MAX_PATHS = 200_000;

const normal = (path: string): string => path.replace(/^(?:\.\/)+/u, "");

/** The files of each repository at its resolved commit. Fails closed (RUNTIME_UNAVAILABLE): a run that cannot say what the repository holds does not cite. */
export async function trackedPathsOf(repositories: ReadonlyArray<{ name: string; directory: string; resolvedCommit?: string | undefined }>): Promise<TrackedPaths> {
  const out = new Map<string, Set<string>>();
  for (const repository of repositories) {
    if (repository.resolvedCommit === undefined) throw agentXError("CONFIG_INVALID", "a setup run needs the commit the broker resolved");
    let listed: string;
    try {
      listed = await runIsolatedGit(repository.directory, ["ls-tree", "-r", "-z", "--name-only", repository.resolvedCommit], { maxBuffer: 64 * 1024 * 1024, timeout: 60_000 });
    } catch {
      throw agentXError("RUNTIME_UNAVAILABLE", "AgentX could not read which files the project's commit holds");
    }
    const paths = listed.split("\0").filter((path) => path !== "");
    if (paths.length > MAX_PATHS) throw agentXError("RUNTIME_UNAVAILABLE", "the project's commit holds too many files to check a citation against");
    out.set(repository.name, new Set(paths));
  }
  return out;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The model's answer without the citations of files the commit does not hold, and without the items that only had such citations. A citation of kind `inferred` names no file and stays. A citation of a
 * repository this run does not know is left for the reader, which drops it. Pure; the input is not changed.
 */
export function dropUntrackedCitations(answer: unknown, tracked: TrackedPaths): unknown {
  const keepCitation = (citation: unknown): boolean => {
    if (!isRecord(citation)) return false;
    if (citation["kind"] === "inferred") return true;
    const repo = citation["repo"];
    const path = citation["path"];
    if (typeof repo !== "string" || typeof path !== "string") return false;
    const files = tracked.get(repo);
    return files === undefined ? true : files.has(normal(path));
  };
  const walk = (value: unknown): unknown => {
    if (Array.isArray(value)) {
      const items = value.map(walk);
      return items.filter((item) => {
        if (!isRecord(item) || !Array.isArray(item["from"])) return true;
        return item["from"].length > 0;
      });
    }
    if (!isRecord(value)) return value;
    const copy: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value)) {
      if (key === "from" && Array.isArray(inner)) copy[key] = inner.filter(keepCitation);
      else copy[key] = walk(inner);
    }
    // An item that had citations and has none left is dropped by its array (above); an object that never had any is left alone.
    return copy;
  };
  return walk(answer);
}

/** Whether a repository's file is in the commit (the devcontainer's "exists"). */
export const isTracked = (tracked: TrackedPaths, repo: string, path: string): boolean => tracked.get(repo)?.has(normal(path)) === true;
