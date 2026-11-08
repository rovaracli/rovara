// Owner decision 34 (LESSON-PROJECT-REPOS-PROJECT-WIDE): a lesson restricted ONLY because its evidence came from a repository that belongs to the lesson's project (PR review comments, human fix-up commits and the like in a
// private project repository) counts as visible to the whole project for lessons. Everything that makes decisions 31 and 32 work (the live audience of every source task) then applies as for any project-wide lesson.
//
// The shape this recognises is exactly what capture writes for a code-host row (`team-record/sources/codehost.ts`, `audienceOf`): a restricted audience whose ACL has NO principals and NO groups, and whose scope is one
// or more `<source>:repo/<repository id>` places joined by `+` (two sources intersect to their scopes joined, `narrowestAudience`). It is treated as project-wide only while EVERY one of those places is the place of a
// repository the project has NOW, read live from the project definition (`ProjectRepoScopesPort`). Anything else stays restricted and unloaded: a Slack channel, a tracker, a repository that is another project's or
// is no longer the project's, an explicit list, a scope joined with any other place, a scope cut at its length limit. A definition that cannot be read means no lesson is converted (fail closed).
//
// This is for lessons ONLY. The Team record's own access check (`team-record/access-port.ts`, `access.ts`) is unchanged: it still answers "restricted" for these rows, and `viewedForLessons` merely stops asking it
// about places that are the project's own repositories. Callers keep the lesson they passed in; only the checks look at the converted copy.
import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import { PROJECT_REVISION_SK_PREFIX, RepositoryDefinitionSchema, codeRepositoriesOf, projectPk, repositoryHostOf, type OrgId, type RepositoryDefinition } from "@agentx/contracts";
import type { Lesson } from "./types.js";

/** The places (`<source>:repo/<id>`) of the repositories a project has now. Throws when the project definition cannot be read. */
export interface ProjectRepoScopesPort {
  read(orgId: OrgId, project: string): Promise<ReadonlySet<string>>;
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
  const places = acl.scope.split("+");
  return places.length > 0 && places.every((place) => REPO_PLACE.test(place)) ? places : undefined;
}

/** Whether the project's repositories could change how this lesson is judged: its restriction is exactly repository readers, or it is project-wide and names a repository place among its sources. Pure. */
export function mentionsRepoPlace(lesson: Pick<Lesson, "provenance">): boolean {
  if (repoOnlyScopes(lesson) !== undefined) return true;
  return lesson.provenance.audience.kind === "project" && (lesson.provenance.sourceScopes ?? []).some((scope) => REPO_PLACE.test(scope));
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

/**
 * The State-table side: the places of the repositories the project's LATEST revision names, GitHub repositories by their pinned immutable id (`githubRepositoryId`, written when the repository was registered, so
 * nothing is asked of the code host). A repository with no pin, or on another host, is left out (its readers stay a restriction). Throws when the project or its definition cannot be read. Read each time, never cached.
 */
export function tableProjectRepoScopes(table: { documentClient: Send; tableName: string }): ProjectRepoScopesPort {
  return {
    async read(orgId, project) {
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
      const scopes = new Set<string>();
      for (const entry of codeRepositoriesOf({ repositories: definition.repositories as RepositoryDefinition[] })) {
        const parsed = RepositoryDefinitionSchema.safeParse(entry);
        if (!parsed.success) continue;
        const host: { kind: string; repositoryId?: number | undefined } = repositoryHostOf(parsed.data);
        if (host.kind === "github" && host.repositoryId !== undefined) scopes.add(`github:repo/${String(host.repositoryId)}`);
      }
      return scopes;
    },
  };
}
