// Enterprise foundations, task P7: the code host router. A repository record names its code host by `host.kind` (`repositoryHostOf` reads old records as
// github); the install registers its code-host plug-ins once, at build time. This module picks the one entry whose kind matches, and refuses everything else:
// an unknown kind, an install with no entry, and an ambiguous registration. It never falls back to "the first entry" and never reads a kind from a request.
import { agentXError, repositoryHostOf, type CodeHost, type PluginKind, type RepositoryDefinition, type RepositoryHost } from "@agentx/contracts";

const NO_HOST = "This repository's code host is not available in this install.";
const AMBIGUOUS = "This install registers more than one code host of the same kind.";

/** The one registered entry for a kind; throws CONFIG_INVALID (fixed sentence, the kind is not echoed) when there is none or more than one. */
export function selectCodeHost(host: Pick<RepositoryHost, "kind">, entries: readonly CodeHost[]): CodeHost {
  const matches = entries.filter((entry) => entry.kind === host.kind);
  if (matches.length > 1) throw agentXError("CONFIG_INVALID", AMBIGUOUS);
  const [entry] = matches;
  if (entry === undefined) throw agentXError("CONFIG_INVALID", NO_HOST);
  return entry;
}

/** The kinds a registration holds, refusing a registration that names one kind twice. */
export function registeredCodeHostKinds(entries: readonly CodeHost[]): ReadonlySet<PluginKind> {
  const kinds = new Set<PluginKind>();
  for (const entry of entries) {
    if (kinds.has(entry.kind)) throw agentXError("CONFIG_INVALID", AMBIGUOUS);
    kinds.add(entry.kind);
  }
  return kinds;
}

/** At task start: every repository of the project must have a registered code host, or the start is refused before any work is spent. */
export function assertRepositoryHostsKnown(repositories: readonly Pick<RepositoryDefinition, "host" | "installationId" | "githubRepositoryId">[], entries: readonly CodeHost[]): void {
  const kinds = registeredCodeHostKinds(entries);
  for (const repository of repositories) {
    if (!kinds.has(repositoryHostOf(repository).kind)) throw agentXError("CONFIG_INVALID", NO_HOST);
  }
}
