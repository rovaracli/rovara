// K1 lane D, D2: the parts of a spec publication that are not the generic publish: which repository it goes to, the project the worker is sent, and the pull request's title.
import { agentXError, metaRepositoryOf, workerProjectDefinition, type SpecFile, type StoredProjectDefinition } from "@agentx/contracts";

/** What `acceptPullRequest` is asked for when it publishes a spec instead of a code candidate. */
export interface SpecPublicationOption {
  files: readonly SpecFile[];
  /** The task's `knowledgeCommit`: the meta repo commit the spec commit is built on. */
  baseCommit: string;
  /** The pull request's number-free title. */
  title?: string;
}

/** The project's meta repository, which must be the one named; undefined for a project without one, or another name. */
export function specTargetRepository(definition: Pick<StoredProjectDefinition, "repositories">, name: string): StoredProjectDefinition["repositories"][number] | undefined {
  const meta = metaRepositoryOf(definition);
  return meta !== undefined && meta.name === name ? meta : undefined;
}

/**
 * The project a worker is sent for a spec publication: what a worker is always sent, plus the meta repository as a plain repository entry (pins and role removed, as for every repository). The meta
 * repository is the only one added, and only here: a worker is never sent a pure meta repository for code work.
 */
export function specPublishProject(definition: StoredProjectDefinition): ReturnType<typeof workerProjectDefinition<StoredProjectDefinition>> {
  const meta = metaRepositoryOf(definition);
  if (meta === undefined) throw agentXError("CONFIG_INVALID", "the project has no meta repository to publish a spec to");
  const base = workerProjectDefinition(definition);
  const entry: Record<string, unknown> = { ...meta };
  for (const key of ["installationId", "githubRepositoryId", "role", "alsoCode"]) delete entry[key];
  const others = (base.repositories as unknown[]).filter((candidate) => (candidate as { name?: string }).name !== meta.name);
  return { ...base, repositories: [...others, entry] } as ReturnType<typeof workerProjectDefinition<StoredProjectDefinition>>;
}

/** The title of the spec pull request: the task's title as one inert line. */
export function specPullRequestTitle(taskTitle: string): string {
  const plain = taskTitle.replace(/[\p{Cc}\p{Cf}\s]+/gu, " ").replace(/[@<>`]/gu, "").trim().slice(0, 200);
  return `Rovara spec: ${plain === "" ? "task" : plain}`.slice(0, 256);
}
