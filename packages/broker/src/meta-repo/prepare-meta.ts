// Meta repo lane A, task A3 (+ fix round 1, I4): the broker's half of putting the meta repository in a worker's workspace.
//
// A worker is sent the project WITHOUT a meta repository that is not also code (`workerProjectDefinition`), and, beside it, a `meta` request: the repository entry (name, address,
// folder, default branch, credential reference; never the installation pins), the knowledge paths to materialize and `commit`, the meta repo's default-branch head AS THE BROKER READ IT
// FROM GITHUB when it built the invocation. The worker materializes exactly that commit and reports it back; the broker keeps the commit it chose on the prepare operation
// (`knowledgeCommit`) and stores it on the task only when the worker reports the same one (`knowledgeCommitToStore`). A task therefore never takes `knowledgeCommit` from the worker's
// own choice or from a manifest written before the task.
//
// Old workers: the prepare payload is a strict schema, so the delivery step refuses a `meta` request for a worker that does not list `prepare.metaRepo` (ec2-delivery.ts), with
// the "needs a newer worker" message, rather than dropping the field and running without the team's rules.
import { META_KNOWLEDGE_DEFAULTS, PrepareMetaSchema, agentXError, metaRepositoryOf, projectMetaShape, type MetaKnowledgeKind, type OrgId, type PrepareMeta } from "@rovara-code/contracts";
import { type StoredProjectDefinition } from "@agentx/cloud-contracts";

/** The feature a worker lists when it can materialize the meta repository. Added to the contracts' WORKER_INVOCATION_FEATURES. */
export const META_PREPARE_FEATURE = "prepare.metaRepo" as const;

export const META_FEATURE_MISSING = "This project's meta repo needs a newer worker. Ask an admin to upgrade Rovara.";
export const META_UNREADABLE = "Rovara can't read the project's meta repo just now; try again in a moment.";

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
export function needsMetaCheckout(definition: Pick<StoredProjectDefinition, "repositories">): boolean {
  return projectMetaShape(definition) === "separate";
}

/** What the broker needs of GitHub to pin a commit: the head of an ordinary branch (`GitHubAppCredentialProvider.getDefaultBranchHead`). */
export interface MetaHeadReader {
  getHead(input: { orgId: OrgId | undefined; repositoryUrl: string; branch: string }): Promise<string>;
}

/**
 * The prepare fields for a project's meta repo: nothing for a project without a separate one; otherwise the request with the head the broker just read. A head that cannot be
 * read is a refusal (`RUNTIME_UNAVAILABLE`), never a run without the team's rules, and the commit it gives must be a full hash.
 */
export async function metaPrepareFor(
  definition: Pick<StoredProjectDefinition, "repositories">,
  reader: MetaHeadReader | undefined,
  orgId: OrgId | undefined,
  locations?: KnowledgeLocations,
): Promise<{ meta?: PrepareMeta; knowledgeCommit?: string }> {
  if (!needsMetaCheckout(definition)) return {};
  const meta = metaRepositoryOf(definition)!;
  if (reader === undefined) throw agentXError("RUNTIME_UNAVAILABLE", META_UNREADABLE);
  let commit: string;
  try {
    commit = await reader.getHead({ orgId, repositoryUrl: meta.url, branch: meta.defaultBranch });
  } catch {
    throw agentXError("RUNTIME_UNAVAILABLE", META_UNREADABLE);
  }
  if (!/^[a-f0-9]{40}$/.test(commit)) throw agentXError("RUNTIME_UNAVAILABLE", META_UNREADABLE);
  const request = PrepareMetaSchema.parse({
    repository: { name: meta.name, url: meta.url, path: meta.path, defaultBranch: meta.defaultBranch, credentialRef: meta.credentialRef },
    paths: knowledgePaths(locations),
    commit,
  });
  return { meta: request, knowledgeCommit: commit };
}

/** Why a task cannot start with a worker that lists `workerFeatures`, or undefined. The delivery step enforces the same rule for a prepare that carries `meta`. */
export function metaPrepareProblem(definition: Pick<StoredProjectDefinition, "repositories">, workerFeatures: readonly string[]): string | undefined {
  return needsMetaCheckout(definition) && !workerFeatures.includes(META_PREPARE_FEATURE) ? META_FEATURE_MISSING : undefined;
}

/** The commit a prepare result reports for the meta repo, when it is a full hash. Anything else is no commit. */
export function parseKnowledgeCommit(result: unknown): string | undefined {
  if (typeof result !== "object" || result === null) return undefined;
  const value = (result as { knowledgeCommit?: unknown }).knowledgeCommit;
  return typeof value === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value) ? value : undefined;
}

/**
 * The commit to store on the task: the one the broker chose for this prepare operation, and only when the worker reported exactly it. A missing choice (a prepare with no meta
 * request), a missing report, or a different one is no commit, so a worker or a stale manifest cannot decide it.
 */
export function knowledgeCommitToStore(chosenByBroker: string | undefined, result: unknown): string | undefined {
  if (chosenByBroker === undefined || !/^[a-f0-9]{40}$/.test(chosenByBroker)) return undefined;
  return parseKnowledgeCommit(result) === chosenByBroker ? chosenByBroker : undefined;
}

/**
 * The task update a successful prepare makes: `preparedBase` (the code repositories' base commits) and `knowledgeCommit` are each set when there is a value and removed when
 * there is not, in one expression (DynamoDB allows one SET and one REMOVE clause).
 */
export function taskPreparedUpdate(preparedBase: unknown, knowledgeCommit: string | undefined): { UpdateExpression: string; ExpressionAttributeValues?: Record<string, unknown> } {
  const sets: string[] = [];
  const removes: string[] = [];
  const values: Record<string, unknown> = {};
  if (preparedBase === undefined) removes.push("preparedBase"); else { sets.push("preparedBase = :base"); values[":base"] = preparedBase; }
  if (knowledgeCommit === undefined) removes.push("knowledgeCommit"); else { sets.push("knowledgeCommit = :knowledgeCommit"); values[":knowledgeCommit"] = knowledgeCommit; }
  return {
    UpdateExpression: [...(sets.length === 0 ? [] : [`SET ${sets.join(", ")}`]), ...(removes.length === 0 ? [] : [`REMOVE ${removes.join(", ")}`])].join(" "),
    ...(sets.length === 0 ? {} : { ExpressionAttributeValues: values }),
  };
}
