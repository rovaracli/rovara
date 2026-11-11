// Enterprise foundations P5d/P5e: the refusal for a step that has no CodeHost port counterpart yet and so speaks GitHub's API alone.
//
// Pure (no I/O, no broker dependencies), so the route side and the broker side share one sentence and one rule: a repository record that names a host this install has not registered is
// refused with the router's fixed `NO_HOST_MESSAGE`; one on a registered host that is not GitHub is refused with `GITHUB_ONLY_MESSAGE`; only GitHub (and a record that names no host) goes on.
import { agentXError } from "@rovara-code/contracts";
import { repositoryHostOf, type RepositoryDefinition } from "@agentx/cloud-contracts";
import { NO_HOST_MESSAGE, registeredCodeHostKinds, type CodeHostRouter } from "../registry.js";

/** Said when a step has no code host port counterpart yet and the repository is not on GitHub. Fixed: it never names the host. */
export const GITHUB_ONLY_MESSAGE = "This step is not available for this repository's code host yet.";

/**
 * Throws unless the record is a GitHub repository. `registered` is the router of the install (or just its kinds); without one the install knows GitHub alone. The kind is never echoed.
 * An unknown kind is `NO_HOST_MESSAGE` (the same sentence the router gives), a known non-GitHub kind is `GITHUB_ONLY_MESSAGE`.
 */
export function requireGithubRecord(
  repository: Pick<RepositoryDefinition, "host" | "installationId" | "githubRepositoryId">,
  registered: Pick<CodeHostRouter, "kinds"> | undefined,
): void {
  const kind = repositoryHostOf(repository).kind;
  const known = registered === undefined ? new Set(["github"]) : registeredCodeHostKinds(registered);
  if (!known.has(kind)) throw agentXError("CONFIG_INVALID", NO_HOST_MESSAGE);
  if (kind !== "github") throw agentXError("CONFIG_INVALID", GITHUB_ONLY_MESSAGE);
}
