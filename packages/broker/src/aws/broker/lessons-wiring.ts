// Part of the broker: builds the lessons library's ports from the broker's own dependencies (learning v2, LS-3) and puts them on `dependencies.lessons`. Called once at handler start. Where the Team
// record is off (`dependencies.teamRecord` is undefined, the default), or the install has no developer sign-in table, nothing is built: no lesson is stored, loaded, sent, shown or decided.
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { OrgIdSchema, codeRepositoriesOf, memberGithubKey, type OrgId } from "@agentx/contracts";
import { followMerges } from "../../agents/access.js";
import { dynamoAttributionReader } from "../../attribution/resolve.js";
import { DeveloperSignInStore } from "../../developer/store.js";
import type { CodeFactsReader } from "../../lessons/code-facts.js";
import { createLessonsRuntime, type LessonsRuntime } from "../../lessons/runtime.js";
import { setLessonsHomeReader } from "../../lessons/home-source.js";
import { lessonsUsedReaderOver, setLessonsUsedReader } from "../../lessons/used-in-pr.js";
import { resolveLearning } from "../../lessons/policy.js";
import { buildLessonsView } from "../../lessons/view.js";
import { recordAuditSinkOf } from "./team-record-wiring.js";
import { readProjectRole } from "../../learning/standing.js";
import { requireLatestProject } from "./records.js";
import { hostOfRepository } from "./repository-hosts.js";
import { githubScope } from "./scope-helpers.js";
import type { AwsBrokerDependencies } from "./definitions.js";

const MAX_BYTES = 1024 * 1024;
/** A rule file shown on the task page is cut at 64 KB by the route; the read stops there too. */
const RULE_TEXT_BYTES = 70 * 1024;
const RULE_TEXT_TIMEOUT_MS = 5_000;

/** The code host's file read at a commit, for the repository a project names. Never the working tree; a repository that is not the project's reads nothing. */
export function codeFileReader(dependencies: AwsBrokerDependencies, maxBytes = MAX_BYTES): CodeFactsReader {
  return {
    async file(input) {
      const orgId = OrgIdSchema.parse(input.workspaceId);
      const record = await requireLatestProject(dependencies, orgId, input.project);
      const repository = codeRepositoriesOf(record.definition).find((candidate) => candidate.name === input.repo);
      if (repository === undefined) return undefined;
      return hostOfRepository(dependencies, repository).fileAtRevision({ url: repository.url }, input.path, input.commit, githubScope(dependencies, orgId), { timeoutMs: input.timeoutMs, maxBytes });
    },
  };
}

/** The lessons runtime for this install, or undefined where the Team record is off. */
export function lessonsRuntimeFor(dependencies: AwsBrokerDependencies): LessonsRuntime | undefined {
  const teamRecord = dependencies.teamRecord;
  const signInTableName = dependencies.developer?.signInTableName;
  // A record runtime without its table (a partial one, as in some test harnesses) gives no lessons: lessons are off, never a crash at handler start.
  if (teamRecord === undefined || (teamRecord as { table?: unknown }).table === undefined || signInTableName === undefined || signInTableName === "") return undefined;
  // UX-4b review fix 1: a paused record learns nothing: no lesson is stored, loaded, shown or decided while it is paused (its stored lessons are kept; erasure still reaches them through the record).
  if ((teamRecord as { paused?: unknown }).paused === true) return undefined;
  const orgOf = (workspaceId: string): OrgId => OrgIdSchema.parse(workspaceId);
  const repositoriesOf = async (workspaceId: string, project: string): Promise<string[]> => {
    const record = await requireLatestProject(dependencies, orgOf(workspaceId), project);
    return codeRepositoriesOf(record.definition).map((repository) => repository.name);
  };
  const reader = codeFileReader(dependencies);
  // The author rules compare members: a developer merged into another reads as that other (the sign-in table's `mergedInto`).
  const merges = new DeveloperSignInStore({ documentClient: dependencies.documentClient, tableName: signInTableName, now: Date.now });
  const audit = recordAuditSinkOf(dependencies.audit, dependencies.documentClient);
  return createLessonsRuntime({
    table: teamRecord.table, now: Date.now, log: (event, fields) => console.log(JSON.stringify({ component: "lessons", event, ...fields })),
    ...(audit === undefined ? {} : { audit }), reader, repositoriesOf,
    evidence: { documentClient: dependencies.documentClient, tableName: dependencies.tableName, signInTableName, now: Date.now },
    resolveMember: (_orgId, developerId) => followMerges(merges, developerId),
    linkedAccounts: async (orgId, developerId) => {
      const item = ((await dependencies.documentClient.send(new GetCommand({ TableName: dependencies.tableName, Key: memberGithubKey(orgId, developerId), ConsistentRead: true }))) as { Item?: { githubUserId?: unknown } }).Item;
      return typeof item?.githubUserId === "string" ? [item.githubUserId] : [];
    },
    names: dynamoAttributionReader({ documentClient: dependencies.documentClient, stateTable: dependencies.tableName, signInTable: signInTableName, teamRecordTable: teamRecord.table.tableName }),
  });
}

/** At handler start (`broker/handler.ts`): sets `dependencies.lessons` unless the caller gave one (tests). */
export function installLessons(dependencies: AwsBrokerDependencies): void {
  if (dependencies.lessons !== undefined) return;
  const built = lessonsRuntimeFor(dependencies);
  if (built !== undefined) dependencies.lessons = built;
  // UX-4b: Home's "Lessons waiting" card counts what the Lessons tab would show this person to decide (learning Off: none).
  const routes = dependencies.lessons?.routes;
  // Approve by exception: the pull request description lists the lessons the task used (`lessons/used-in-pr.ts`).
  setLessonsUsedReader(routes === undefined ? undefined : lessonsUsedReaderOver({ store: routes.store, settings: routes.settings, access: routes.access }));
  setLessonsHomeReader(routes === undefined ? undefined : async (orgId, developerId, project) => {
    if ((await resolveLearning(routes.settings, orgId, project)).mode === "Off") return { waiting: 0 };
    const view = await buildLessonsView(routes, { orgId, developerId }, project);
    if (!view.canDecide || view.waiting.length === 0) return { waiting: 0 };
    return { waiting: view.waiting.length, at: new Date(Math.max(...view.waiting.map((lesson) => lesson.updatedAt))).toISOString() };
  });
}

/**
 * What the developer routes get (`DeveloperRouteDependencies`): the Team record's runtime (its `/record/` routes), the lessons ports, and the two reads that serve the text of a loaded rule file.
 * Empty where the Team record is off. A rule file's text is served only to a person who holds a role in the task's project and only from a repository that is the project's.
 */
export function recordAndLessonRouteDependencies(dependencies: AwsBrokerDependencies) {
  const lessons = dependencies.lessons;
  const rules = lessons === undefined ? undefined : codeFileReader(dependencies, RULE_TEXT_BYTES);
  return {
    ...(dependencies.teamRecord === undefined ? {} : { teamRecord: dependencies.teamRecord }),
    ...(lessons === undefined ? {} : { lessons: lessons.routes }),
    ...(rules === undefined ? {} : {
      loadedKnowledge: {
        canReadRepository: async (caller: { orgId: OrgId; developerId: string }, input: { project: string; repo: string }): Promise<boolean> => {
          const role = await readProjectRole({ documentClient: dependencies.documentClient, tableName: dependencies.tableName }, caller.orgId, caller.developerId, input.project);
          if (role === undefined) return false;
          const record = await requireLatestProject(dependencies, caller.orgId, input.project);
          return codeRepositoriesOf(record.definition).some((repository) => repository.name === input.repo);
        },
        readRuleFile: (input: { orgId: OrgId; project: string; repo: string; path: string; commit: string }): Promise<string | undefined> =>
          rules.file({ workspaceId: input.orgId, project: input.project, repo: input.repo, commit: input.commit, path: input.path, timeoutMs: RULE_TEXT_TIMEOUT_MS }),
      },
    }),
  };
}
