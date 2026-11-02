// Enterprise foundations P4: the plug-in registry and the code host router.
//
// Adapters ship in the release and are registered here at build time; nothing is loaded from outside. The router answers "which code host serves this repository":
// today GitHub, for every repository (the repository `host` field and the choice by `host.kind` are task P7). A kind with no adapter is refused with a fixed sentence.
// The edition decides what may be registered: GitHub, GitHub Actions and CodeBuild are the install's own; any other kind is an Enterprise plug-in.
import {
  ENTERPRISE_ONLY_MESSAGE, PluginKindSchema, agentXError, repositoryHostOf, requireFeature,
  type CheckRunner, type CodeHost, type EditionPolicy, type PluginKind, type RepositoryDefinition, type RepositoryHost, type RepositoryRef, type Tracker,
} from "@agentx/contracts";

/** The code host every install has. */
export const BUILT_IN_CODE_HOST_KIND: PluginKind = "github";
/** The check runners every install has. */
export const BUILT_IN_CHECK_RUNNER_KINDS: readonly PluginKind[] = ["github-actions", "codebuild"];

export const NO_CODE_HOST_MESSAGE = "No code host is set up for this repository.";
/** P7: said when a repository record names a code host this install has not registered (the kind is not echoed). */
export const NO_HOST_MESSAGE = "This repository's code host is not available in this install.";
const AMBIGUOUS_HOST_MESSAGE = "This install registers more than one code host of the same kind.";
/** The trackers every install has: Linear is built in (P9). Any other tracker is an Enterprise plug-in. */
export const BUILT_IN_TRACKER_KINDS: readonly PluginKind[] = ["linear"];
export const NO_TRACKER_MESSAGE = "No tracker is set up for this kind of item.";
export const NO_CHECK_RUNNER_MESSAGE = "No check runner is set up for this kind of build.";

export interface CodeHostRouter {
  /** The code host that serves a repository; throws (CONFIG_INVALID, a fixed sentence) when there is none. */
  forRepository(repository: RepositoryRef): CodeHost;
  forKind(kind: PluginKind): CodeHost;
  /**
   * P7: the code host for a repository RECORD, by its `host.kind` (a record without one is GitHub). For callers that hold the project's repository record; a caller that
   * holds only an address uses `forRepository`. Throws CONFIG_INVALID with a fixed sentence when the kind has no registered host; never falls back to another host.
   */
  forRecord(repository: Pick<RepositoryDefinition, "host" | "installationId" | "githubRepositoryId">): CodeHost;
  /** The kinds of code host registered, sorted. */
  kinds(): readonly PluginKind[];
}

/** What a check runner is built for: the repositories the caller's project registered (a runner that builds for an address it was not told about refuses). */
export interface CheckRunnerContext {
  allowedRepositories: readonly string[];
}

export interface CheckRunnerRegistration {
  kind: PluginKind;
  create: (context: CheckRunnerContext) => CheckRunner;
}

export interface PluginRegistryInput {
  codeHosts: readonly CodeHost[];
  checkRunners: readonly CheckRunnerRegistration[];
  /** P9: the trackers (Linear, then a customer's). Absent: none is registered. */
  trackers?: readonly Tracker[];
  /** The edition's feature table. Absent (an install deployed before editions): only the built-in plug-ins may be registered. */
  policy?: EditionPolicy;
  /** The kind of code host a repository uses. Today every repository is GitHub; task P7 reads the repository's `host.kind`. */
  hostKindOf?: (repository: RepositoryRef) => PluginKind;
}

export interface PluginRegistry {
  codeHost: CodeHostRouter;
  /** A check runner of this kind, built for the given context. */
  checkRunner: (kind: PluginKind, context: CheckRunnerContext) => CheckRunner;
  /** P9: the tracker of this kind; throws CONFIG_INVALID (a fixed sentence, the kind not echoed) when none is registered. Never falls back to another tracker. */
  tracker: (kind: PluginKind) => Tracker;
  /** P9: the kinds of tracker registered, sorted. */
  trackerKinds: () => readonly PluginKind[];
}

function requireAllowedKind(kind: PluginKind, builtIn: readonly PluginKind[], policy: EditionPolicy | undefined): void {
  if (!PluginKindSchema.safeParse(kind).success) throw agentXError("CONFIG_INVALID", "A plug-in has a name that is not a plug-in name.");
  if (builtIn.includes(kind)) return;
  // Not built in: a customer's plug-in, which only the Enterprise edition has. No edition (an install deployed before editions) has none.
  if (policy === undefined) throw agentXError("FORBIDDEN", ENTERPRISE_ONLY_MESSAGE);
  requireFeature(policy, "codeHostPlugins");
}

export function createPluginRegistry(input: PluginRegistryInput): PluginRegistry {
  const hosts = new Map<PluginKind, CodeHost>();
  for (const host of input.codeHosts) {
    requireAllowedKind(host.kind, [BUILT_IN_CODE_HOST_KIND], input.policy);
    if (hosts.has(host.kind)) throw agentXError("CONFIG_INVALID", "Two code hosts are registered under one name.");
    hosts.set(host.kind, host);
  }
  // The install's own host is not optional: a registry without it would leave every repository without a host.
  if (!hosts.has(BUILT_IN_CODE_HOST_KIND)) throw agentXError("CONFIG_INVALID", "The GitHub code host is not registered.");

  const runners = new Map<PluginKind, CheckRunnerRegistration>();
  for (const registration of input.checkRunners) {
    requireAllowedKind(registration.kind, BUILT_IN_CHECK_RUNNER_KINDS, input.policy);
    if (runners.has(registration.kind)) throw agentXError("CONFIG_INVALID", "Two check runners are registered under one name.");
    runners.set(registration.kind, registration);
  }

  const trackers = new Map<PluginKind, Tracker>();
  for (const tracker of input.trackers ?? []) {
    requireAllowedKind(tracker.kind, BUILT_IN_TRACKER_KINDS, input.policy);
    if (trackers.has(tracker.kind)) throw agentXError("CONFIG_INVALID", "Two trackers are registered under one name.");
    trackers.set(tracker.kind, tracker);
  }

  const hostKindOf = input.hostKindOf ?? ((): PluginKind => BUILT_IN_CODE_HOST_KIND);
  const forKind = (kind: PluginKind): CodeHost => {
    const host = hosts.get(kind);
    if (host === undefined) throw agentXError("CONFIG_INVALID", NO_CODE_HOST_MESSAGE);
    return host;
  };
  return {
    codeHost: {
      forRepository: (repository) => forKind(hostKindOf(repository)),
      forKind,
      forRecord: (repository) => {
        const host = hosts.get(repositoryHostOf(repository).kind);
        if (host === undefined) throw agentXError("CONFIG_INVALID", NO_HOST_MESSAGE);
        return host;
      },
      kinds: () => [...hosts.keys()].sort(),
    },
    tracker(kind) {
      const tracker = trackers.get(kind);
      if (tracker === undefined) throw agentXError("CONFIG_INVALID", NO_TRACKER_MESSAGE);
      return tracker;
    },
    trackerKinds: () => [...trackers.keys()].sort(),
    checkRunner(kind, context) {
      const registration = runners.get(kind);
      if (registration === undefined) throw agentXError("CONFIG_INVALID", NO_CHECK_RUNNER_MESSAGE);
      const runner = registration.create(context);
      if (runner.kind !== kind) throw agentXError("CONFIG_INVALID", "A check runner's name does not match the name it was registered under.");
      return runner;
    },
  };
}

// ---- P7: the same registry, as pure functions over registered entries (used by the start check and the tests) ----

/** The one registered entry for a kind; throws CONFIG_INVALID (fixed sentence, the kind is not echoed) when there is none or more than one. */
export function selectCodeHost(host: Pick<RepositoryHost, "kind">, entries: readonly CodeHost[]): CodeHost {
  const matches = entries.filter((entry) => entry.kind === host.kind);
  if (matches.length > 1) throw agentXError("CONFIG_INVALID", AMBIGUOUS_HOST_MESSAGE);
  const [entry] = matches;
  if (entry === undefined) throw agentXError("CONFIG_INVALID", NO_HOST_MESSAGE);
  return entry;
}

/** The kinds a registration holds, refusing a registration that names one kind twice. The source is the entries, or a built registry's router. */
export function registeredCodeHostKinds(source: readonly Pick<CodeHost, "kind">[] | Pick<CodeHostRouter, "kinds">): ReadonlySet<PluginKind> {
  const kinds = new Set<PluginKind>();
  const list = Array.isArray(source) ? (source as readonly Pick<CodeHost, "kind">[]).map((entry) => entry.kind) : (source as Pick<CodeHostRouter, "kinds">).kinds();
  for (const kind of list) {
    if (kinds.has(kind)) throw agentXError("CONFIG_INVALID", AMBIGUOUS_HOST_MESSAGE);
    kinds.add(kind);
  }
  return kinds;
}

/** At task start: every repository of the project must have a registered code host, or the start is refused before any work is spent. */
export function assertRepositoryHostsKnown(
  repositories: readonly Pick<RepositoryDefinition, "host" | "installationId" | "githubRepositoryId">[],
  source: readonly Pick<CodeHost, "kind">[] | Pick<CodeHostRouter, "kinds">,
): void {
  const kinds = registeredCodeHostKinds(source);
  for (const repository of repositories) {
    if (!kinds.has(repositoryHostOf(repository).kind)) throw agentXError("CONFIG_INVALID", NO_HOST_MESSAGE);
  }
}
