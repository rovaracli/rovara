// Owner decision 34 (LESSON-PROJECT-REPOS-PROJECT-WIDE): a lesson restricted ONLY because its evidence came from a repository that belongs to the lesson's project (PR review comments, human fix-up commits and the like in a
// private project repository) counts as visible to the whole project for lessons. Everything that makes decisions 31 and 32 work (the live audience of every source task) then applies as for any project-wide lesson.
//
// The shape this recognises is exactly what capture writes for a code-host row (`team-record/sources/codehost.ts`, `audienceOf`): a restricted audience whose ACL has NO principals and NO groups, and whose scope is one
// or more `<source>:repo/<repository id>` places joined by `+` (two sources intersect to their scopes joined, `narrowestAudience`). It is treated as project-wide only while EVERY one of those places is the place of a
// repository the project has NOW, read live from the project definition (`ProjectRepoScopesPort`). Anything else stays restricted and unloaded: a Slack channel, a tracker, a repository that is another project's or
// is no longer the project's, an explicit list, a scope joined with any other place, a scope cut at its length limit (it ends with the place `CUT_SCOPE_PLACE`, which no record matches, and a scope of the limit's length is never believed). A definition that cannot be read means no lesson is converted (fail closed).
//
// This is for lessons ONLY. The Team record's own access check (`team-record/access-port.ts`, `access.ts`) is unchanged: it still answers "restricted" for these rows, and `viewedForLessons` merely stops asking it
// about places that are the project's own repositories. Callers keep the lesson they passed in; only the checks look at the converted copy.
import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import { PROJECT_REVISION_SK_PREFIX, RepositoryDefinitionSchema, codeRepositoriesOf, projectPk, repositoryHostOf, type OrgId, type RepositoryDefinition } from "@agentx/contracts";
import { isScopeClosed } from "../team-record/item-head.js";
import type { TeamRecordTable } from "../team-record/types.js";
import { ACL_SCOPE_MAX, type Lesson } from "./types.js";

/** The places (`<source>:repo/<id>`) of the repositories a project has now. Throws when the project definition cannot be read. */
export interface ProjectRepoScopesPort {
  read(orgId: OrgId, project: string): Promise<ReadonlySet<string>>;
  /** The place (`github:repo/<id>`) of the project's repository called `name`, or undefined when the project has no such pinned repository. Throws when the project definition cannot be read. Absent: no pull request can name a repository-only lesson (decision 36). */
  placeOf?(orgId: OrgId, project: string, name: string): Promise<string | undefined>;
}

/** The port rides on the task-visibility port the access check carries (as the lesson audiences do), so the shared access port and the Team record's port types stay exactly as they were. */
export interface WithProjectRepoScopes { projectRepoScopes: ProjectRepoScopesPort }

export function withProjectRepoScopes<T extends object>(port: T, scopes: ProjectRepoScopesPort): T & WithProjectRepoScopes {
  return Object.assign(Object.create(Object.getPrototypeOf(port) as object | null), port, { projectRepoScopes: scopes }) as T & WithProjectRepoScopes;
}

export function projectRepoScopesOf(port: object | undefined): ProjectRepoScopesPort | undefined {
  const found = (port as Partial<WithProjectRepoScopes> | undefined)?.projectRepoScopes;
  return found !== undefined && typeof found.read === "function" ? found : undefined;
}

const REPO_PLACE = /^[a-z][a-z0-9:._-]*:repo\/[^+\s]+$/;

/** The repository places of a lesson whose restriction is exactly "readers of these repositories" (see the top of this file); `undefined` for any other lesson. Pure. */
export function repoOnlyScopes(lesson: Pick<Lesson, "provenance">): string[] | undefined {
  const audience = lesson.provenance.audience;
  if (audience.kind !== "restricted") return undefined;
  const acl = audience.acl;
  if (acl.principals !== undefined || acl.groups !== undefined) return undefined;
  // A scope at the length limit may have been cut (`narrowestAudience` ends a cut one with a place nobody matches, but a lesson stored before that, or one cut elsewhere, has none): the places after the cut are unknown, so
  // this is not "exactly these repositories" and the lesson stays restricted (fails closed, review M1).
  if (acl.scope.length >= ACL_SCOPE_MAX) return undefined;
  const places = acl.scope.split("+");
  return places.length > 0 && places.every((place) => REPO_PLACE.test(place)) ? places : undefined;
}

/** Whether the project's repositories could change how this lesson is judged: its restriction is exactly repository readers, or it is project-wide and names a repository place among its sources. Pure. */
export function mentionsRepoPlace(lesson: Pick<Lesson, "provenance">): boolean {
  if (repoOnlyScopes(lesson) !== undefined) return true;
  return lesson.provenance.audience.kind === "project" && (lesson.provenance.sourceScopes ?? []).some((scope) => REPO_PLACE.test(scope));
}

/**
 * Owner decision 36 (LESSON-CROSS-REPO-NAMING): a lesson restricted ONLY to repository A loads into any project task (decision 34), but it is NAMED in a pull request's "Lessons used" list and PUBLISHED into AGENTS.md
 * (and similar files) only in repository A itself. In the project's other repositories the pull request only counts it. `targetPlace` is the place (`github:repo/<id>`) of the repository the text goes into;
 * undefined (not known) is "not A". Every other lesson (project-wide, or restricted for another reason, which never gets here) is not limited by this rule. The restriction is read from the lesson's OWN audience,
 * whether or not it has been converted by `viewedForLessons`. Pure.
 */
export function mayNameInRepository(lesson: Pick<Lesson, "provenance">, targetPlace: string | undefined): boolean {
  const places = repoOnlyScopes(lesson);
  if (places === undefined) return true;
  return targetPlace !== undefined && places.every((place) => place === targetPlace);
}

/**
 * The lesson as the lesson read paths judge it: when its restriction is exactly the readers of repositories that are ALL the project's own now (`projectRepos`), it is project-wide and those places are no
 * longer places the access records are asked about. A project-wide lesson that names a project repository among its sources (a repository that has gone private since) stops being asked about that place too.
 * `projectRepos` undefined (not asked, or unreadable) leaves the lesson as it is, restricted. Returns the same object when nothing changes.
 */
export function viewedForLessons<T extends Pick<Lesson, "provenance">>(lesson: T, projectRepos: ReadonlySet<string> | undefined): T {
  if (projectRepos === undefined) return lesson;
  const places = repoOnlyScopes(lesson);
  const restrictedToProjectRepos = places !== undefined && places.every((place) => projectRepos.has(place));
  if (places !== undefined && !restrictedToProjectRepos) return lesson;
  if (places === undefined && lesson.provenance.audience.kind !== "project") return lesson;
  const sourceScopes = (lesson.provenance.sourceScopes ?? []).filter((scope) => !projectRepos.has(scope));
  if (!restrictedToProjectRepos && sourceScopes.length === (lesson.provenance.sourceScopes ?? []).length) return lesson;
  return { ...lesson, provenance: { ...lesson.provenance, audience: { kind: "project" as const }, sourceScopes } };
}

type Send = { send(command: unknown): Promise<unknown> };

interface PinnedRepository { name: string; place: string }

/** The GitHub repositories (by pinned immutable id) of the project's LATEST revision. Throws when the project or its definition cannot be read. */
async function latestPinnedRepositories(table: { documentClient: Send; tableName: string }, orgId: OrgId, project: string): Promise<PinnedRepository[]> {
  const response = await table.documentClient.send(new QueryCommand({
    TableName: table.tableName,
    KeyConditionExpression: "pk = :pk AND begins_with(sk, :revision)",
    ExpressionAttributeValues: { ":pk": projectPk(orgId, project), ":revision": PROJECT_REVISION_SK_PREFIX },
    ScanIndexForward: false,
    Limit: 1,
    ConsistentRead: true,
  })) as { Items?: Array<{ definition?: unknown }> };
  const definition = response.Items?.[0]?.definition as { repositories?: unknown } | undefined;
  if (definition === undefined || !Array.isArray(definition.repositories)) throw new Error("lessons: the project definition can't be read");
  const found: PinnedRepository[] = [];
  for (const entry of codeRepositoriesOf({ repositories: definition.repositories as RepositoryDefinition[] })) {
    const parsed = RepositoryDefinitionSchema.safeParse(entry);
    if (!parsed.success) continue;
    const host: { kind: string; repositoryId?: number | undefined } = repositoryHostOf(parsed.data);
    if (host.kind === "github" && host.repositoryId !== undefined) found.push({ name: parsed.data.name, place: `github:repo/${String(host.repositoryId)}` });
  }
  return found;
}

/**
 * The State-table side: the places of the repositories the project's LATEST revision names, GitHub repositories by their pinned immutable id (`githubRepositoryId`, written when the repository was registered, so
 * nothing is asked of the code host). A repository with no pin, or on another host, is left out (its readers stay a restriction). Throws when the project or its definition cannot be read. Read each time, never cached.
 *
 * `record` (the Team record's table) is the live signal that a repository is GONE (review L2): a repository that was deleted, transferred out or excluded has its place closed (`closeScope`) the moment the removal is
 * queued, while the pinned id stays in the project definition until someone edits it. A closed place is left out too, so its lessons stop loading at once instead of when the queued withdrawal has run. One
 * consistent read per pinned repository; a marker that cannot be read throws (the lessons stay restricted, as for any unreadable definition).
 */
export function tableProjectRepoScopes(table: { documentClient: Send; tableName: string }, options: { record?: TeamRecordTable | undefined } = {}): ProjectRepoScopesPort {
  return {
    async read(orgId, project) {
      const pinned = await latestPinnedRepositories(table, orgId, project);
      const open = options.record === undefined ? pinned : (await Promise.all(pinned.map(async (repository) => ((await isScopeClosed(options.record!, orgId, repository.place)) ? undefined : repository)))).flatMap((repository) => (repository === undefined ? [] : [repository]));
      return new Set(open.map((repository) => repository.place));
    },
    async placeOf(orgId, project, name) {
      const found = (await latestPinnedRepositories(table, orgId, project)).find((repository) => repository.name === name);
      if (found === undefined) return undefined;
      return options.record !== undefined && await isScopeClosed(options.record, orgId, found.place) ? undefined : found.place;
    },
  };
}
