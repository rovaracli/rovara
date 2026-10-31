// Enterprise foundations P5c: where the working-branch review reads a repository's connection. The review is bound to the GitHub installation and the immutable repository id a project pinned
// (a transferred repository cannot quietly change installation), so it is GitHub's today. The pins are read from the repository's HOST record (task P7, with the old top-level fields read as before),
// and a repository whose record names any other code host is refused with the fixed "valid repository" sentence of the callers: it is never read through GitHub by its address.
import { agentXError, repositoryHostOf, type RepositoryDefinition } from "@agentx/contracts";

export interface GitHubPins { installationId: number | undefined; githubRepositoryId: number | undefined }

/** The installation and repository id the record pins, when its host is GitHub; throws CONFIG_INVALID (fixed sentence) for any other host. */
export function githubPinsOf(repository: Pick<RepositoryDefinition, "host" | "installationId" | "githubRepositoryId">): GitHubPins {
  const host = repositoryHostOf(repository);
  if (host.kind !== "github") throw agentXError("CONFIG_INVALID", "This repository's code host does not support working branch review yet.");
  // The record's other variant has a free `kind` string, so the compiler cannot narrow on it; a github host is the one with the pins.
  const pins = host as { installationId?: number | undefined; repositoryId?: number | undefined };
  return { installationId: pins.installationId, githubRepositoryId: pins.repositoryId };
}
