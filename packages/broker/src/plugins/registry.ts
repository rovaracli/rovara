// Enterprise foundations P4: the plug-in registry and the code host router.
//
// Adapters ship in the release and are registered here at build time; nothing is loaded from outside. The router answers "which code host serves this repository":
// today GitHub, for every repository (the repository `host` field and the choice by `host.kind` are task P7). A kind with no adapter is refused with a fixed sentence.
// The edition decides what may be registered: GitHub, GitHub Actions and CodeBuild are the install's own; any other kind is an Enterprise plug-in.
import {
  ENTERPRISE_ONLY_MESSAGE, PluginKindSchema, agentXError, requireFeature,
  type CheckRunner, type CodeHost, type EditionPolicy, type PluginKind, type RepositoryRef,
} from "@agentx/contracts";

/** The code host every install has. */
export const BUILT_IN_CODE_HOST_KIND: PluginKind = "github";
/** The check runners every install has. */
export const BUILT_IN_CHECK_RUNNER_KINDS: readonly PluginKind[] = ["github-actions", "codebuild"];

export const NO_CODE_HOST_MESSAGE = "No code host is set up for this repository.";
export const NO_CHECK_RUNNER_MESSAGE = "No check runner is set up for this kind of build.";

export interface CodeHostRouter {
  /** The code host that serves a repository; throws (CONFIG_INVALID, a fixed sentence) when there is none. */
  forRepository(repository: RepositoryRef): CodeHost;
  forKind(kind: PluginKind): CodeHost;
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
  /** The edition's feature table. Absent (an install deployed before editions): only the built-in plug-ins may be registered. */
  policy?: EditionPolicy;
  /** The kind of code host a repository uses. Today every repository is GitHub; task P7 reads the repository's `host.kind`. */
  hostKindOf?: (repository: RepositoryRef) => PluginKind;
}

export interface PluginRegistry {
  codeHost: CodeHostRouter;
  /** A check runner of this kind, built for the given context. */
  checkRunner: (kind: PluginKind, context: CheckRunnerContext) => CheckRunner;
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
      kinds: () => [...hosts.keys()].sort(),
    },
    checkRunner(kind, context) {
      const registration = runners.get(kind);
      if (registration === undefined) throw agentXError("CONFIG_INVALID", NO_CHECK_RUNNER_MESSAGE);
      const runner = registration.create(context);
      if (runner.kind !== kind) throw agentXError("CONFIG_INVALID", "A check runner's name does not match the name it was registered under.");
      return runner;
    },
  };
}
