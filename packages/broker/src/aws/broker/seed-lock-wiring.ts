// SEED-RISK-1: the code host's side of the broker's seed locks (test-env/seed-lock.ts). For each repository of the project's latest definition that is on GitHub: the head of its default branch (read now), ONE tree
// listing of that commit (a listing GitHub cut short reads nothing), and file reads at that same commit through the org's own installation. Only regular files (mode 100644 or 100755) are read or listed: a link, a
// submodule or anything else makes the read throw or the listing unknown, so the seed stays HIGH. A repository on another host has no source, and a seed in it stays HIGH.
import { SEED_LOCK_LIMITS, type OrgId, type SeedSourceReader } from "@agentx/contracts";
import { GITHUB_HOST_KIND } from "../../plugins/code-host/github/index.js";
import type { SeedRepoSource, SeedRepoSources } from "../../test-env/seed-lock.js";
import type { AwsBrokerDependencies } from "./definitions.js";
import { requireLatestProject } from "./records.js";
import { hostOfRepository } from "./repository-hosts.js";
import { githubScope } from "./scope-helpers.js";

const REGULAR = new Set(["100644", "100755"]);
const READ_TIMEOUT_MS = 8_000;

/** A reader rooted at `directory` of one tree listing, reading files at the same commit. */
export function treeReader(entries: ReadonlyArray<{ path: string; mode: string; type: string }>, directory: string, readFile: (path: string) => Promise<string | undefined>): SeedSourceReader {
  const byPath = new Map(entries.map((entry) => [entry.path, entry] as const));
  const prefix = directory === "" ? "" : `${directory}/`;
  return {
    async read(path) {
      const entry = byPath.get(`${prefix}${path}`);
      if (entry === undefined || entry.type === "tree") return undefined;
      if (entry.type !== "blob" || !REGULAR.has(entry.mode)) throw new Error("not a regular file");
      const text = await readFile(`${prefix}${path}`);
      if (text === undefined) throw new Error("listed file not readable");
      return text;
    },
    async list(folder) {
      const inside = entries.filter((entry) => entry.path.startsWith(`${prefix}${folder}/`));
      if (inside.some((entry) => entry.type !== "tree" && (entry.type !== "blob" || !REGULAR.has(entry.mode)))) return undefined;
      return inside.filter((entry) => entry.type === "blob").map((entry) => entry.path.slice(prefix.length));
    },
  };
}

/** The route dependency, or nothing where the GitHub reads are not there (then every seed command is HIGH). */
export function seedRepoSourcesRoute(dependencies: AwsBrokerDependencies): { seedRepoSources?: SeedRepoSources } {
  const github = dependencies.githubPullRequests;
  if (github.getDefaultBranchHead === undefined || github.listTreeAtCommit === undefined || github.getFileAtCommit === undefined) return {};
  const head = github.getDefaultBranchHead.bind(github);
  const list = github.listTreeAtCommit.bind(github);
  const file = github.getFileAtCommit.bind(github);
  return {
    seedRepoSources: async (orgId: OrgId, project: string): Promise<SeedRepoSource[]> => {
      const scope = githubScope(dependencies, orgId);
      const sources: SeedRepoSource[] = [];
      for (const repository of (await requireLatestProject(dependencies, orgId, project)).definition.repositories) {
        if (hostOfRepository(dependencies, repository).kind !== GITHUB_HOST_KIND) continue;
        const commit = await head(repository.url, repository.defaultBranch, scope);
        const tree = await list(repository.url, commit, scope);
        if (tree.truncated) continue;
        sources.push({ path: repository.path, readerAt: (directory) => treeReader(tree.entries, directory, (path) => file(repository.url, path, commit, scope, { timeoutMs: READ_TIMEOUT_MS, maxBytes: SEED_LOCK_LIMITS.fileBytes + 1 })) });
      }
      return sources;
    },
  };
}
