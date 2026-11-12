// The `AWS_ENDPOINT_URL_*` names a project's own settings set (test services, wide AWS plans). A repository can carry `AWS_ENDPOINT_URL_SNS=http://localhost:4566` in a `.env` file or a settings file, and a dotenv loader does not
// override a variable that is already set, so the run points every such name at the emulator itself (service-env.ts `repoEndpointNames`): a value of the repository can then not send a service somewhere else. The names come
// from the same reader the setup draft uses (the `env` detector: variable NAMES only, never a value), over the checkout as it is now, in a thread with a time limit.
//
// Fail soft, on purpose: a repository that cannot be read in time gives no names. The names only widen what is redirected; the global endpoint, the sealed network and the ledger hold either way.
import { listRepositoryFiles, readRepositoryFile } from "./test-env-detect.js";
import { boundedReader } from "./env-detect/index.js";
import { runDetectorsGuarded, type GuardOptions } from "./env-detect/guarded.js";
import { REPO_ENDPOINT_NAMES_MAX } from "./service-env.js";

/** The longest the settings of one repository are read for. */
export const REPO_ENDPOINT_NAMES_LIMIT_MS = 10_000;
const ENDPOINT_VARIABLE = /^AWS_ENDPOINT_URL_[A-Z0-9_]{2,60}$/u;

/** What the reading could not do (Cloud only): names past the limit are not redirected (`notRedirected` of them), and a repository that could not be read in time or at all (`unread`) added none. Counts only, never a name. */
export interface RepoEndpointNamesNote { notRedirected: number; unread: number }

/** The endpoint variable names the repositories' settings set, sorted and unique. Never throws. `onNote` hears of names dropped past the limit and of repositories that could not be read. */
export async function repoAwsEndpointNames(input: { repositoryPaths: readonly string[]; guard?: GuardOptions; onNote?: (note: RepoEndpointNamesNote) => void }): Promise<string[]> {
  let unread = 0;
  const names = new Set<string>();
  for (const directory of input.repositoryPaths) {
    try {
      const paths = await listRepositoryFiles(directory);
      if (paths.length === 0) continue;
      const { reader } = boundedReader(paths, (path) => readRepositoryFile(directory, path));
      const detection = await runDetectorsGuarded(reader, ".", { timeoutMs: REPO_ENDPOINT_NAMES_LIMIT_MS, ...input.guard, only: ["env"] });
      // The guard answers a pass that ran out of time with an empty detection and this note: such a repository gave no names, which is said, not hidden.
      if (detection.notes.some((note) => note.includes("took too long"))) unread += 1;
      for (const candidate of detection.dependencies ?? []) for (const name of candidate.hints.envNames ?? []) if (ENDPOINT_VARIABLE.test(name)) names.add(name);
    } catch {
      // A repository that cannot be read adds no names.
      unread += 1;
    }
  }
  const sorted = [...names].sort();
  if (sorted.length > REPO_ENDPOINT_NAMES_MAX || unread > 0) input.onNote?.({ notRedirected: Math.max(0, sorted.length - REPO_ENDPOINT_NAMES_MAX), unread });
  return sorted.slice(0, REPO_ENDPOINT_NAMES_MAX);
}
