// Part of the broker: builds the lessons library's ports from the broker's own dependencies (learning v2, LS-3) and puts them on `dependencies.lessons`. Called once at handler start. Where the Team
// record is off (`dependencies.teamRecord` is undefined, the default), or the install has no developer sign-in table, nothing is built: no lesson is stored, loaded, sent, shown or decided.
import { randomUUID } from "node:crypto";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { OrgIdSchema, codeRepositoriesOf, memberGithubKey, type AuditEventInput, type LessonsPauseCode, type OrgId } from "@agentx/contracts";
import { followMerges } from "../../agents/access.js";
import { dynamoAttributionReader } from "../../attribution/resolve.js";
import { DeveloperSignInStore } from "../../developer/store.js";
import type { CodeFactsReader } from "../../lessons/code-facts.js";
import { tableTaskVisibilityPort } from "../../team-record/live-audience-port.js";
import { NO_EMBEDDER, NO_VECTORS, createLessonsRuntime, type LessonsRuntime } from "../../lessons/runtime.js";
import type { Embedder, LearningSpend, LessonVectors, PipelineModel } from "../../lessons/ports.js";
import { lessonAuditSink } from "../../lessons/audit-sink.js";
import { lessonDeletionPort } from "../../lessons/deletion.js";
import { DynamoLessonStore } from "../../lessons/dynamo-store.js";
import { lessonsResumeJob, lessonsRevertJob, type LessonsJobDeps } from "../../lessons/jobs.js";
import type { TaskLearningDeps } from "../../lessons/task-end.js";
import { tableOutcomeRows } from "../../lessons/task-outcome-rows.js";
import { readObjectText } from "../../developer/plan-artifacts.js";
import { customerLearningModel } from "./learning-model.js";
import { readLessonsModel } from "../../lessons/model-setting.js";
import { dynamoPauseStore, spendLook } from "../../lessons/pause.js";
import { companyLearningSpend } from "./learning-spend.js";
import { lessonSubjectSource } from "./lesson-subject-source.js";
import { setLessonsHomeReader } from "../../lessons/home-source.js";
import { lessonsUsedReaderOver, setLessonsUsedReader, type RepositoryVisibility, visibilityOfRepositories } from "../../lessons/used-in-pr.js";
import { resolveLearning } from "../../lessons/policy.js";
import { buildLessonsView } from "../../lessons/view.js";
import { recordAuditSinkOf } from "./team-record-wiring.js";
import { auditPending } from "../../audit/outbox.js";
import { flushAuditEvents } from "../../audit/flush.js";
import { readProjectRole, readStanding } from "../../learning/standing.js";
import { requireLatestProject } from "./records.js";
import { hostOfRepository } from "./repository-hosts.js";
import { githubScope } from "./scope-helpers.js";
import type { AwsBrokerDependencies, LessonsHostDependencies } from "./definitions.js";

const MAX_BYTES = 1024 * 1024;
/** A rule file shown on the task page is cut at 64 KB by the route; the read stops there too. */
const RULE_TEXT_BYTES = 70 * 1024;
const RULE_TEXT_TIMEOUT_MS = 5_000;

/** The code host's file read at a commit, for the repository a project names. Never the working tree; a repository that is not the project's reads nothing. */
export function codeFileReader(dependencies: LessonsHostDependencies, maxBytes = MAX_BYTES): CodeFactsReader {
  return {
    async file(input) {
      const orgId = OrgIdSchema.parse(input.workspaceId);
      const record = await requireLatestProject(dependencies, orgId, input.project);
      const repository = codeRepositoriesOf(record.definition).find((candidate) => candidate.name === input.repo);
      if (repository === undefined) return undefined;
      return hostOfRepository(dependencies, repository).fileAtRevision({ url: repository.url }, input.path, input.commit, githubScope(dependencies, orgId), { timeoutMs: input.timeoutMs, maxBytes });
    },
    // WB-7: a directory, or a glob's literal directory prefix, is checked through the host's `pathKind` where the host has one; a host without it answers undefined ("cannot tell"), and only a readable file counts.
    async kind(input) {
      const orgId = OrgIdSchema.parse(input.workspaceId);
      const record = await requireLatestProject(dependencies, orgId, input.project);
      const repository = codeRepositoriesOf(record.definition).find((candidate) => candidate.name === input.repo);
      if (repository === undefined) return undefined;
      const host = hostOfRepository(dependencies, repository);
      if (host.pathKind === undefined) return undefined;
      return host.pathKind({ url: repository.url }, input.path, input.commit, githubScope(dependencies, orgId), { timeoutMs: input.timeoutMs });
    },
  };
}

/**
 * Whether the project's code repositories are private: "private" only when the host says so for EVERY repository the project has; "public" when it says any is not private; "unknown" for anything else
 * (no repository, a host that does not say, a read that fails). The pull request description writes lesson titles only for "private".
 */
export async function repositoryVisibilityOf(dependencies: LessonsHostDependencies, orgIdText: string, project: string): Promise<RepositoryVisibility> {
  try {
    const orgId = OrgIdSchema.parse(orgIdText);
    const repositories = codeRepositoriesOf((await requireLatestProject(dependencies, orgId, project)).definition);
    const answers = [];
    for (const repository of repositories) answers.push(await hostOfRepository(dependencies, repository).repositoryIdentity({ url: repository.url }, githubScope(dependencies, orgId)));
    return visibilityOfRepositories(answers);
  } catch { return "unknown"; }
}

/**
 * THE seam for lesson similarity (merging duplicates, finding contradictions, ranking at load, matching outcomes). It is an open owner decision (2026-11-08: Titan is not good enough; research first), so
 * today there is none: no embedder and no lesson vectors. Whatever is chosen plugs in HERE and nowhere else (the runtime's load and route dependencies and the learning dependencies all take it from this
 * function). Without an embedder curate finds no neighbours, so duplicates never merge and corroboration never builds: lessons must not be switched on before this is decided.
 */
export function lessonSimilarityFor(dependencies: Pick<AwsBrokerDependencies, "teamRecord">): { embedder: Embedder; vectors: LessonVectors } {
  void dependencies;
  return { embedder: NO_EMBEDDER, vectors: NO_VECTORS };
}

/**
 * Whether a recorded "lessons paused" reason still holds, asked only when a person who decides reads it. A probe call of the reflector's kind is quoted (nothing is held or made): when it would be accepted now, the cause of
 * a provider, model or budget reason is gone (a provider was connected, a model allowed, the budget raised) and the reason is cleared. The monthly limit is looked at on its own; a reason that depends on the size of the
 * call (`cost_too_high`) or on what the provider did (`model_failed`) is left for the next learning call to clear. A probe that fails keeps the reason.
 */
export function pauseStillAppliesFor(model: PipelineModel, spend: LearningSpend): (workspaceId: string, project: string, code: LessonsPauseCode) => Promise<boolean> {
  return async (workspaceId, project, code) => {
    if (code === "model_failed" || code === "cost_too_high") return true;
    if (code === "monthly_limit") return (await spendLook(spend, workspaceId, PUBLIC_PER_TASK_PROBE_USD)) !== "ok";
    try { return !(await model.quote?.({ purpose: "reflect", system: "probe", user: "probe", maxOutputTokens: 1800, workspaceId, project }))?.ok; } catch { return true; }
  };
}
const PUBLIC_PER_TASK_PROBE_USD = 0.15;

/** The lessons runtime for this install, or undefined where the Team record is off. */
export function lessonsRuntimeFor(dependencies: LessonsHostDependencies): LessonsRuntime | undefined {
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
  // The company's own model path, where this install has one (the model proxy): the curator's judge and the payer path. Without a proxy they stay the refusing stand-ins.
  const modelPath = dependencies.modelAccess === undefined ? {} : (() => {
    const model = customerLearningModel(dependencies, { edition: teamRecord.edition, lessonsModel: (orgId) => readLessonsModel(teamRecord.table, orgId) });
    const spend = companyLearningSpend({ documentClient: dependencies.documentClient, tableName: dependencies.tableName, edition: teamRecord.edition, now: Date.now, log: (event, fields) => console.log(JSON.stringify({ component: "lessons", event, ...fields })) });
    return { model, spend, pauseStillApplies: pauseStillAppliesFor(model, spend) };
  })();
  return createLessonsRuntime({
    ...modelPath, pause: dynamoPauseStore(teamRecord.table, Date.now, (event, fields) => console.log(JSON.stringify({ component: "lessons", event, ...fields }))), similarity: lessonSimilarityFor(dependencies),
    table: teamRecord.table, now: Date.now, log: (event, fields) => console.log(JSON.stringify({ component: "lessons", event, ...fields })),
    ...(audit === undefined ? {} : { audit }),
    ...(dependencies.audit === undefined ? {} : (() => { const ledger = dependencies.audit; return { auditOutbox: { pending: (event: AuditEventInput) => auditPending({ audit: ledger }, event), flush: (event: AuditEventInput) => flushAuditEvents({ audit: ledger }, [event]) } }; })()),
    reader, repositoriesOf,
    taskVisibility: tableTaskVisibilityPort({ documentClient: dependencies.documentClient, tableName: dependencies.tableName, now: Date.now }),
    evidence: { documentClient: dependencies.documentClient, tableName: dependencies.tableName, signInTableName, now: Date.now },
    resolveMember: (_orgId, developerId) => followMerges(merges, developerId),
    linkedAccounts: async (orgId, developerId) => {
      const item = ((await dependencies.documentClient.send(new GetCommand({ TableName: dependencies.tableName, Key: memberGithubKey(orgId, developerId), ConsistentRead: true }))) as { Item?: { githubUserId?: unknown } }).Item;
      return typeof item?.githubUserId === "string" ? [item.githubUserId] : [];
    },
    names: dynamoAttributionReader({ documentClient: dependencies.documentClient, stateTable: dependencies.tableName, signInTable: signInTableName, teamRecordTable: teamRecord.table.tableName }),
  });
}

/**
 * What the task-end hook needs (`TaskLearningDeps`), from the lessons runtime and the broker's own readers; undefined without the Team record, a model path or an audit ledger. Built here; the hook is NOT
 * registered from it in this release: `learning-wiring.ts` registers the inline handler only when its flag is on, and it is off until the reflection runs from a queue (WB-4).
 */
export function learningDepsFor(dependencies: LessonsHostDependencies, runtime: LessonsRuntime): TaskLearningDeps | undefined {
  const teamRecord = dependencies.teamRecord;
  const signInTableName = dependencies.developer?.signInTableName;
  if (teamRecord === undefined || dependencies.modelAccess === undefined || signInTableName === undefined || signInTableName === "") return undefined;
  const routes = runtime.routes;
  const state = { documentClient: dependencies.documentClient, tableName: dependencies.tableName };
  const log = (event: string, fields: Record<string, string | number>): void => console.log(JSON.stringify({ component: "lessons", event, ...fields }));
  const repositoriesOf = async (orgId: string, project: string): Promise<string[]> => {
    const record = await requireLatestProject(dependencies, OrgIdSchema.parse(orgId), project);
    return codeRepositoriesOf(record.definition).map((repository) => repository.name);
  };
  return {
    source: lessonSubjectSource({
      ...state, repositoriesOf,
      standing: (orgId, developerId, project) => readStanding(state, OrgIdSchema.parse(orgId), developerId, project),
      // Erased in the Team record (the permanent marker) or in the lessons' own fence: either one is enough. A read that cannot tell throws.
      isErased: async (orgId, developerId, project) => (await routes.names.isErased(OrgIdSchema.parse(orgId), developerId)) || (await routes.store.isErased({ workspaceId: orgId, project }, developerId)),
      visibility: (orgId, taskId) => teamRecord.taskVisibility(orgId, taskId),
      readObject: (key, maxBytes) => readObjectText(dependencies.s3, dependencies.artifactBucketName, key, maxBytes),
      now: Date.now,
    }),
    rows: tableOutcomeRows(teamRecord.table),
    settings: runtime.settings,
    reflect: { model: routes.judgeModel, spend: routes.spend, ...(routes.pause === undefined ? {} : { pause: routes.pause }), audit: routes.audit, settings: runtime.settings, edition: teamRecord.edition, now: Date.now },
    process: routes,
    rovara: teamRecord.emitter,
    log,
  };
}

/** At handler start (`broker/handler.ts`): sets `dependencies.lessons` unless the caller gave one (tests). */
export function installLessons(dependencies: LessonsHostDependencies): void {
  if (dependencies.lessons !== undefined) return;
  const built = lessonsRuntimeFor(dependencies);
  if (built !== undefined) dependencies.lessons = built;
  // Learning at the end of a task: only where the lessons runtime AND the model path exist (and a caller did not give its own).
  if (built !== undefined && dependencies.learning === undefined) {
    const learning = learningDepsFor(dependencies, built);
    if (learning !== undefined) dependencies.learning = learning;
  }
  // Lessons in production (lane 2, WB-7): the lessons' two jobs ride the Team record's schedules (the hourly deletion resumer, the nightly re-reflection of reverted tasks).
  installLessonsJobs(dependencies, built);
  // UX-4b: Home's "Lessons waiting" card counts what the Lessons tab would show this person to decide (learning Off: none).
  const routes = dependencies.lessons?.routes;
  // Approve by exception: the pull request description lists the lessons the task used (`lessons/used-in-pr.ts`).
  setLessonsUsedReader(routes === undefined ? undefined : lessonsUsedReaderOver({
    store: routes.store, settings: routes.settings, access: routes.access, names: routes.names, visibility: (orgId, project) => repositoryVisibilityOf(dependencies, orgId, project),
  }));
  setLessonsHomeReader(routes === undefined ? undefined : async (orgId, developerId, project) => {
    if ((await resolveLearning(routes.settings, orgId, project)).mode === "Off") return { waiting: 0 };
    const view = await buildLessonsView(routes, { orgId, developerId }, project, { surface: "home" });
    // Lane 1b: a person who decides here also hears why learning is paused (never silent).
    const paused = view.canDecide ? view.paused : undefined;
    if (!view.canDecide || view.waiting.length === 0) return { waiting: 0, ...(paused === undefined ? {} : { paused }) };
    return { waiting: view.waiting.length, at: new Date(Math.max(...view.waiting.map((lesson) => lesson.updatedAt))).toISOString(), ...(paused === undefined ? {} : { paused }) };
  });
}

/**
 * The hourly `lessons-resume` job and the nightly `lessons-reverts` job (`lessons/jobs.ts`), added to the record's schedules. Nothing is added where the record has no job runner (a partial harness).
 * L4 (lane 2 review): the hourly resume does not depend on the lessons runtime: an erase or a deletion left half-done must finish whether or not the record is paused, so with no runtime (a paused record) it runs on a
 * store-only deletion port (the lessons' store over the record's table, no vectors, the audit sink of the record). The nightly re-reflection needs the runtime (the learning mode) and so is not added while paused.
 */
export function installLessonsJobs(dependencies: LessonsHostDependencies, runtime: LessonsRuntime | undefined): void {
  const teamRecord = dependencies.teamRecord;
  if (teamRecord?.jobs?.extend === undefined || (teamRecord as { table?: unknown }).table === undefined) return;
  const log = (event: string, fields: Record<string, string | number>): void => console.log(JSON.stringify({ component: "lessons", event, ...fields }));
  const audit = runtime?.routes.audit ?? lessonAuditSink(recordAuditSinkOf(dependencies.audit, dependencies.documentClient) ?? (async () => { throw new Error("no audit ledger"); }), Date.now);
  const deletion = lessonDeletionPort({ store: runtime?.store ?? new DynamoLessonStore(teamRecord.table, Date.now), vectors: lessonSimilarityFor(dependencies).vectors, audit, now: Date.now });
  teamRecord.jobs.extend("hourly", (orgId, projects, budgetMs) => lessonsResumeJob({ resume: (org, project) => deletion.resumeAll(org, project), now: Date.now, log }, orgId, projects, budgetMs));
  if (runtime === undefined) return;
  const jobs: LessonsJobDeps = {
    table: teamRecord.table, settings: runtime.settings, queue: dependencies.lessonsReflectQueue, resume: (orgId, project) => deletion.resumeAll(orgId, project),
    now: Date.now, newRequestId: () => `nightly-${randomUUID()}`, log,
  };
  teamRecord.jobs.extend("nightly", (orgId, projects, budgetMs) => lessonsRevertJob(jobs, orgId, projects, budgetMs));
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
