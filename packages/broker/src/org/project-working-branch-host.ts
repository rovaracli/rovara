// Enterprise foundations P5c: where the working-branch review reads a repository's connection. The review is bound to the GitHub installation and the immutable repository id a project pinned
// (a transferred repository cannot quietly change installation), so it is GitHub's today. The pins are read from the repository's HOST record (task P7, with the old top-level fields read as before),
// and a repository whose record names any other code host is refused with CONFIG_INVALID, which each caller's `safe()` maps to its own fixed sentence: it is never read through GitHub by its address.
//
// Known asymmetry (latent, P7 follow-up): this reader and the agent GitHub connector's `pinOf` honour a pin that exists only on `host`. Other control-plane checks (task start, credentials,
// trigger events, allowed domains, project registration) still read the top-level `installationId` / `githubRepositoryId` alone. Nothing writes a `host`-only GitHub record yet
// (`withRepositoryHost` is a no-op), so the two readings agree on every record that exists; the day writes turn on, those readers move to `repositoryHostOf` together.
import { agentXError, repositoryHostOf, type RepositoryDefinition } from "@rovara-code/contracts";

export interface GitHubPins { installationId: number | undefined; githubRepositoryId: number | undefined }

/** The installation and repository id the record pins when its host is GitHub; undefined for any other host. */
export function tryGithubPinsOf(repository: Pick<RepositoryDefinition, "host" | "installationId" | "githubRepositoryId">): GitHubPins | undefined {
  const host = repositoryHostOf(repository);
  if (host.kind !== "github") return undefined;
  // The record's other variant has a free `kind` string, so the compiler cannot narrow on it; a github host is the one with the pins.
  const pins = host as { installationId?: number | undefined; repositoryId?: number | undefined };
  return { installationId: pins.installationId, githubRepositoryId: pins.repositoryId };
}

/** The pins of a GitHub record; throws CONFIG_INVALID (a fixed sentence that does not echo the kind) for any other host. */
export function githubPinsOf(repository: Pick<RepositoryDefinition, "host" | "installationId" | "githubRepositoryId">): GitHubPins {
  const pins = tryGithubPinsOf(repository);
  if (pins === undefined) throw agentXError("CONFIG_INVALID", "This repository's code host does not support working branch review yet.");
  return pins;
}
