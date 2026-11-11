// Lessons in the repo, lane R2: builds the lessons file pass's ports from the broker's own dependencies (`lessons/repo-file-job.ts` RepoFileRuntime). It owns the provider-specific parts, so the lessons code stays neutral (decision 51):
//   - the project's repositories as targets: each with the code host its record names (`hostOfRepository`) and the scope to call it in. A repository on a host this install has not registered, or with no pinned id, is left out.
//   - the people the lessons could name: the project's members and the lessons' own people, by display name. A name that cannot be read throws, and the pass waits.
// PORT GAPS (decision 51, listed for the Code port, not refactored here): a host must offer `changeRequestForBranch` as well as `commitFiles` and `deleteBranch` to write (a pull request made from a branch is found by its branch, not by a list: the port has no list of change requests, so a host without it gets no target); only a GitHub repository gets a target (`host.kind !== "github"` is left out, and the place is `github:repo/<id>`), and the pass's cleanup of a write whose pull
// request was never recorded deletes the branch, which closes the pull request on GitHub but not on a host where a merge request outlives its branch. A second host needs a place from the host and a close-by-branch method on the port.
// The store, settings and audit sink are the lessons runtime's own; the state is the Team record table's `LESSONSET#REPOFILE#` items. Nothing here calls a model.
import { randomUUID } from "node:crypto";
import { OrgIdSchema, RepositoryDefinitionSchema, codeRepositoriesOf, repositoryHostOf } from "@rovara-code/contracts";
import { DeveloperSignInStore } from "../../developer/store.js";
import { dynamoRepoFileStore } from "../../lessons/dynamo-repo-file.js";
import type { LessonAuditSink } from "../../lessons/ports.js";
import type { RepoFileRuntime } from "../../lessons/repo-file-job.js";
import type { RepoFileTarget } from "../../lessons/repo-file-pass.js";
import type { LessonsRuntime } from "../../lessons/runtime.js";
import { peopleOf } from "../../lessons/types.js";
import { createProjectMembers } from "../../org/project-members.js";
import { requireLatestProject } from "./records.js";
import { hostOfRepository } from "./repository-hosts.js";
import { githubScope } from "./scope-helpers.js";
import type { LessonsHostDependencies } from "./definitions.js";

/** At most this many people's names are looked up in one pass. */
const MAX_NAME_LOOKUPS = 300;

export function repoFileRuntimeFor(dependencies: LessonsHostDependencies, runtime: LessonsRuntime, audit: LessonAuditSink): RepoFileRuntime | undefined {
  const teamRecord = dependencies.teamRecord as { table?: Parameters<typeof dynamoRepoFileStore>[0] } | undefined;
  const signInTableName = dependencies.developer?.signInTableName;
  if (teamRecord?.table === undefined || signInTableName === undefined || signInTableName === "") return undefined;
  const merges = new DeveloperSignInStore({ documentClient: dependencies.documentClient, tableName: signInTableName, now: Date.now });
  const members = createProjectMembers({ documentClient: dependencies.documentClient, tableName: dependencies.tableName, developerRecord: (developerId) => merges.getDeveloper(developerId) });
  const log = (event: string, fields: Record<string, string | number>): void => console.log(JSON.stringify({ component: "lessons", event, ...fields }));
  return {
    deps: {
      store: runtime.store, state: dynamoRepoFileStore(teamRecord.table, { onUnreadable: (what) => log("lessons_repo_file.item_unreadable", { what }) }), settings: runtime.settings, audit, now: Date.now, log,
      names: async (key, lessons) => {
        const orgId = OrgIdSchema.parse(key.workspaceId);
        const ids = new Set((await members.list(orgId, key.project)).map((member) => member.developerId));
        for (const lesson of lessons) if (lesson.provenance.repoOnly !== undefined) for (const id of peopleOf(lesson)) ids.add(id);
        if (ids.size > MAX_NAME_LOOKUPS) throw new Error("too many people to look up");
        const names: string[] = [];
        for (const id of ids) { const name = await runtime.routes.names.memberName(orgId, id); if (name !== undefined) names.push(name); }
        return names;
      },
    },
    newHolder: () => `broker-${randomUUID()}`,
    // A repository the project no longer lists, from what its watch row remembers (decision 51: only GitHub has a place today, `github:repo/<id>`). Whether the installation still reaches it is found out by the first host call.
    async reach(workspaceId, _project, former) {
      const id = /^github:repo\/(\d{1,15})$/u.exec(former.place)?.[1];
      if (id === undefined) return undefined;
      try {
        const orgId = OrgIdSchema.parse(workspaceId);
        return { name: former.name, place: former.place, repository: { url: former.url }, scope: githubScope(dependencies, orgId), host: hostOfRepository(dependencies, { githubRepositoryId: Number(id) }) };
      } catch { return undefined; }
    },
    async targets(workspaceId, project) {
      const orgId = OrgIdSchema.parse(workspaceId);
      const record = await requireLatestProject(dependencies, orgId, project);
      const targets: RepoFileTarget[] = [];
      for (const entry of codeRepositoriesOf(record.definition)) {
        const parsed = RepositoryDefinitionSchema.safeParse(entry);
        if (!parsed.success) continue;
        const host: { kind: string; repositoryId?: number | undefined } = repositoryHostOf(parsed.data);
        // The place of a repository is the one the Team record names it by; only a host whose pinned id is known here (GitHub today) has one.
        if (host.kind !== "github" || host.repositoryId === undefined) continue;
        try {
          targets.push({ name: parsed.data.name, place: `${host.kind}:repo/${String(host.repositoryId)}`, repository: { url: parsed.data.url }, scope: githubScope(dependencies, orgId), host: hostOfRepository(dependencies, parsed.data) });
        } catch { /* a host this install has not registered: the repository is left out */ }
      }
      return targets;
    },
  };
}
