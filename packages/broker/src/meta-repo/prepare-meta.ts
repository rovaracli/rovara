// Meta repo lane A, task A3: the broker's half of putting the meta repository in a worker's workspace.
//
// A worker is sent the project WITHOUT a meta repository that is not also code (`workerProjectDefinition`), and, beside it, a `meta` request: the repository entry (name, address,
// folder, default branch, credential reference; never the installation pins) and the knowledge paths to materialize. Only a worker that lists `prepare.metaRepo` is sent it: the prepare
// payload is a strict schema, so an older worker would refuse the field. Such a worker would also prepare without the team's rules, so the caller refuses the task start instead
// (`metaPrepareProblem`), with a message that says what to do. The worker answers with `knowledgeCommit`, which the task record keeps (`parseKnowledgeCommit`).
//
// Wiring pending (hot files): the prepare invocation builders in broker.ts (`prepareWorkspace` and the task-start preparation) spread `metaPrepareFields(definition, workerFeatures, knowledge)`
// into the payload and refuse with `metaPrepareProblem`; the prepare result handler in broker.ts (where `preparedBase` is stored) also stores `parseKnowledgeCommit(result)` as the
// task's `knowledgeCommit` (developer-tasks.ts, slot H2).
import {
  META_KNOWLEDGE_DEFAULTS,
  PrepareMetaSchema,
  metaRepositoryOf,
  projectMetaShape,
  type MetaKnowledgeKind,
  type PrepareMeta,
  type StoredProjectDefinition,
} from "@agentx/contracts";

/** The feature a worker lists when it can materialize the meta repository. Added to the contracts' WORKER_INVOCATION_FEATURES. */
export const META_PREPARE_FEATURE = "prepare.metaRepo" as const;

export const META_FEATURE_MISSING = "This project's meta repo needs a newer worker. Ask an admin to upgrade Rovara.";

/** Root files that always belong to the knowledge, whatever the config names: the project's own settings and the rule files at the top. */
export const META_ALWAYS_PATHS: readonly string[] = [".rovara", "AGENTS.md", "AGENTS.override.md", "CLAUDE.md"];

/** The knowledge locations of a config (`MetaProjectConfig["knowledge"]`), each kind optional; an absent kind takes its default. */
export type KnowledgeLocations = Partial<Record<MetaKnowledgeKind, readonly string[]>>;

/** The paths to materialize: each kind's configured places or its defaults, plus the always-paths, without repeats, in a stable order. */
export function knowledgePaths(locations: KnowledgeLocations = {}): string[] {
  const paths = new Set<string>(META_ALWAYS_PATHS);
  for (const kind of ["steering", "skills", "specs", "runbooks", "keyDocs"] as const) {
    for (const path of locations[kind] ?? META_KNOWLEDGE_DEFAULTS[kind]) paths.add(path);
  }
  return [...paths];
}

/** Whether a project needs the worker to bring its meta repo: it has one that is not also code (one that is also code is cloned as code already). */
function needsMetaCheckout(definition: Pick<StoredProjectDefinition, "repositories">): boolean {
  return projectMetaShape(definition) === "separate";
}

/** What the prepare payload gets for the meta repo: nothing for a project without one, or for a worker that cannot use it (the caller checks `metaPrepareProblem`). */
export function metaPrepareFields(
  definition: Pick<StoredProjectDefinition, "repositories">,
  workerFeatures: readonly string[],
  locations?: KnowledgeLocations,
): { meta?: PrepareMeta } {
  if (!needsMetaCheckout(definition) || !workerFeatures.includes(META_PREPARE_FEATURE)) return {};
  const meta = metaRepositoryOf(definition)!;
  const request = PrepareMetaSchema.parse({
    repository: { name: meta.name, url: meta.url, path: meta.path, defaultBranch: meta.defaultBranch, credentialRef: meta.credentialRef },
    paths: knowledgePaths(locations),
  });
  return { meta: request };
}

/** Why a task cannot start with this worker, or undefined. A project with a meta repo is never run without it. */
export function metaPrepareProblem(definition: Pick<StoredProjectDefinition, "repositories">, workerFeatures: readonly string[]): string | undefined {
  return needsMetaCheckout(definition) && !workerFeatures.includes(META_PREPARE_FEATURE) ? META_FEATURE_MISSING : undefined;
}

/** The commit a prepare result reports for the meta repo, when it is a full hash. Anything else is no commit: a task never pins a value the worker did not give. */
export function parseKnowledgeCommit(result: unknown): string | undefined {
  if (typeof result !== "object" || result === null) return undefined;
  const value = (result as { knowledgeCommit?: unknown }).knowledgeCommit;
  return typeof value === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value) ? value : undefined;
}
