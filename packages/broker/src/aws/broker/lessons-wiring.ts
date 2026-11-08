// Part of the broker: builds the lessons library's ports from the broker's own dependencies (learning v2, LS-3) and puts them on `dependencies.lessons`. Called once at handler start. Where the Team
// record is off (`dependencies.teamRecord` is undefined, the default), or the install has no developer sign-in table, nothing is built: no lesson is stored, loaded, sent, shown or decided.
import { randomUUID } from "node:crypto";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { OrgIdSchema, cleanLessonText, codeRepositoriesOf, memberGithubKey, type AuditEventInput, type LessonsPauseCode, type OrgId } from "@agentx/contracts";
import { followMerges } from "../../agents/access.js";
import { dynamoAttributionReader } from "../../attribution/resolve.js";
import { DeveloperSignInStore } from "../../developer/store.js";
import type { CodeFactsReader } from "../../lessons/code-facts.js";
import { tableTaskVisibilityPort } from "../../team-record/live-audience-port.js";
import { tableLessonAudiencePort, withLessonAudiences } from "../../lessons/task-audience.js";
import { tableProjectRepoScopes, withProjectRepoScopes } from "../../lessons/project-repo-audience.js";
import { NO_VECTORS, createLessonsRuntime, type LessonsRuntime } from "../../lessons/runtime.js";
import { dynamoLessonVectors } from "../../lessons/dynamo-vectors.js";
import type { LearningSpend, LessonEmbedder, LessonVectors, PipelineModel } from "../../lessons/ports.js";
import { lessonAuditSink } from "../../lessons/audit-sink.js";
import { lessonDeletionPort } from "../../lessons/deletion.js";
import { DynamoLessonStore } from "../../lessons/dynamo-store.js";
import { lessonsNightlyJob, lessonsResumeJob, type LessonsJobDeps } from "../../lessons/jobs.js";
import type { TaskLearningDeps } from "../../lessons/task-end.js";
import { tableOutcomeRows } from "../../lessons/task-outcome-rows.js";
import { tableCapturedRows } from "../../lessons/captured-rows.js";
import { createHumanEditExtractor } from "../../lessons/human-edit.js";
import { listTaskComments } from "../../developer/page-comments.js";
import { liveRememberedNoteIds } from "../../learning/capture-comment.js";
import { loadWorkflowDocument, readObjectText } from "../../developer/plan-artifacts.js";
import type { DeveloperTaskRecord } from "../../developer/task-records.js";
import { PLAN_FACTS_SUMMARY_MAX, planLoadFacts } from "../../lessons/plan-facts.js";
import { resolveTaskVisibility } from "../../lessons/task-visibility.js";
import { resolveTaskProjectWide } from "../../lessons/task-project-wide.js";
import { customerLearningModel } from "./learning-model.js";
import { readLessonsModel } from "../../lessons/model-setting.js";
import { dynamoPauseStore, spendLook } from "../../lessons/pause.js";
import { companyLearningSpend } from "./learning-spend.js";
import { MAX_THREAD_REPLIES, lessonSubjectSource } from "./lesson-subject-source.js";
import { lessonSlackAuthor } from "./lesson-slack-author.js";
import { threadNoteAuthors } from "./lesson-thread-note-authors.js";
import { setLessonsHomeReader } from "../../lessons/home-source.js";
import { lessonsUsedReaderOver, setLessonsUsedReader, type RepositoryVisibility, visibilityOfRepositories } from "../../lessons/used-in-pr.js";
import { resolveLearning } from "../../lessons/policy.js";
import { humanEditMessageOf, type ReflectQueue } from "../../lessons/reflect-queue.js";
import type { HumanEditJob } from "../../team-record/sources/codehost.js";
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
 * THE seam for lesson similarity (DECISIONS 23: merging duplicates, finding contradictions, ranking at load, matching corrections). The vectors are kept WITH the lessons in the Team record table
 * (`lessons/dynamo-vectors.ts`; no vector index, no Bedrock call). The embedder is OPTIONAL: `dependencies.lessonEmbedder` is the small open model served by the self-hosted embedder (our own compute, never a
 * Rovara-paid model); an install that has none ranks by code-aware keywords and cited paths alone, and says so once in one fixed log line (`lessons.similarity_no_embedder`). Nothing blocks on it.
 */
export function lessonSimilarityFor(dependencies: Pick<AwsBrokerDependencies, "teamRecord" | "lessonEmbedder">): { embedder: LessonEmbedder | undefined; vectors: LessonVectors } {
  const table = (dependencies.teamRecord as { table?: Parameters<typeof dynamoLessonVectors>[0] } | undefined)?.table;
  // An embedder the host passes wins (tests, a custom install); otherwise the record runtime's own, built from the embedder function the environment names (none: keywords and paths).
  const embedder = dependencies.lessonEmbedder ?? (dependencies.teamRecord as { lessonEmbedder?: LessonEmbedder } | undefined)?.lessonEmbedder;
  return { embedder, vectors: table === undefined ? NO_VECTORS : dynamoLessonVectors(table) };
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
    ...modelPath, edition: teamRecord.edition, pause: dynamoPauseStore(teamRecord.table, Date.now, (event, fields) => console.log(JSON.stringify({ component: "lessons", event, ...fields }))), similarity: lessonSimilarityFor(dependencies),
    table: teamRecord.table, now: Date.now, log: (event, fields) => console.log(JSON.stringify({ component: "lessons", event, ...fields })),
    ...(audit === undefined ? {} : { audit }),
    ...(dependencies.audit === undefined ? {} : (() => { const ledger = dependencies.audit; return { auditOutbox: { pending: (event: AuditEventInput) => auditPending({ audit: ledger }, event), flush: (event: AuditEventInput) => flushAuditEvents({ audit: ledger }, [event]) } }; })()),
    reader, repositoriesOf,
    taskVisibility: withProjectRepoScopes(withLessonAudiences(tableTaskVisibilityPort({ documentClient: dependencies.documentClient, tableName: dependencies.tableName, now: Date.now }), tableLessonAudiencePort({ documentClient: dependencies.documentClient, tableName: dependencies.tableName, now: Date.now })), tableProjectRepoScopes({ documentClient: dependencies.documentClient, tableName: dependencies.tableName }, { record: teamRecord.table })),
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
  const standing = (orgId: string, developerId: string, project: string) => readStanding(state, OrgIdSchema.parse(orgId), developerId, project);
  // Erased in the Team record (the permanent marker) or in the lessons' own fence: either one is enough. A read that cannot tell throws.
  const isErased = async (orgId: string, developerId: string, project: string): Promise<boolean> => (await routes.names.isErased(OrgIdSchema.parse(orgId), developerId)) || (await routes.store.isErased({ workspaceId: orgId, project }, developerId));
  const adapters = teamRecord.captureAdapters;
  const source = lessonSubjectSource({
    ...state, repositoriesOf, standing, isErased,
    visibility: (orgId, taskId) => teamRecord.taskVisibility(orgId, taskId),
    // Lessons connect: the strict reader (any unreadable part throws) decides `sharedTask`, the mark repository publishing needs.
    strictVisibility: (orgId, taskId) => resolveTaskVisibility({ ...state, now: Date.now }, orgId, taskId, { strict: true }),
    // Owner decision 32: an ordinary task nobody shared counts as project-wide when no People entry denies anyone (the Team record's own resolver above is unchanged).
    projectWide: (orgId, taskId) => resolveTaskProjectWide({ ...state, now: Date.now }, orgId, taskId),
    log,
    // Slack thread replies name their author through the Slack account's verified Rovara link (lessons sweep, lane D); the words are not read.
    threadNotes: (_orgId, taskId) => threadNoteAuthors(state, taskId, MAX_THREAD_REPLIES),
    slackAuthor: lessonSlackAuthor({ documentClient: dependencies.documentClient, tableName: dependencies.tableName, signIn: new DeveloperSignInStore({ documentClient: dependencies.documentClient, tableName: signInTableName, now: Date.now }) }),
    readObject: (key, maxBytes) => readObjectText(dependencies.s3, dependencies.artifactBucketName, key, maxBytes),
    now: Date.now,
    // The corrections people already make, from the Team record: "remember this" notes (the notes of the task's comments) and reviewers' comments on its pull requests (listed by the code host through
    // its capture adapter, read from the record). The merge commit is the one the tap noted when the host said the pull request merged.
    captured: tableCapturedRows(teamRecord.table),
    // The LIVE corrections only (M1): a comment that was remembered and not forgotten. The record keeps its row after a Forget, so the comments' own list is never the source of notes.
    rememberedNoteIds: async (orgId, project, taskId) => liveRememberedNoteIds({ ...state, now: Date.now }, orgId, project, taskId,
      (await listTaskComments(state, taskId)).filter((comment) => comment.author.kind === "person" && comment.deletedAt === undefined).map((comment) => comment.commentId)),
    // The author's account on the place's exclusion list now (checked by the account id the row keeps).
    sourceExcluded: ({ orgId, source, scope, accountId }) => teamRecord.sourceExcluded({ workspaceId: orgId, source, scope, accountId }),
    // What a person's own commits changed on the branch since a comment's commit, read live and only for a range proved to be members' commits.
    humanChangedFiles: async (input) => teamRecord.humanEdit.provenFiles({
      repo: { host: input.host, id: input.scope.slice(input.scope.lastIndexOf("repo/") + "repo/".length), fullName: input.repository, isPrivate: input.isPrivate, workspaceId: input.orgId, project: input.project },
      project: input.project, base: input.base, head: input.head, ...(input.headRef === undefined ? {} : { headRef: input.headRef }),
    }),
    pullRequestAddress: (url) => adapters.addressOf(url)?.address,
    pullRequestFeedback: async (input) => adapters.forHost(input.address.host)?.pullRequestFeedback?.({ workspaceId: input.orgId, project: input.project, taskId: input.taskId, address: input.address, url: input.url }),
    mergeCommitOf: ({ orgId, taskId, address }) => teamRecord.mergeIndex.mergeCommitOf({ workspaceId: orgId, host: address.host, repo: address.repository, number: address.number, taskId }),
  });
  return {
    source,
    rows: tableOutcomeRows(teamRecord.table),
    settings: runtime.settings,
    reflect: { model: routes.judgeModel, spend: routes.spend, ...(routes.pause === undefined ? {} : { pause: routes.pause }), audit: routes.audit, settings: runtime.settings, edition: teamRecord.edition, now: Date.now },
    process: routes,
    rovara: teamRecord.emitter,
    // Lessons connect (fix 1, H1): the end of a task counts its outcome for the lessons it loaded, with the runtime's judge (today the refusing one: no model call).
    counters: runtime.counters,
    log,
    humanEdit: { standing, isErased },
  };
}

/**
 * What the dispatch tells the loader about a task besides its title: the latest plan document's summary and the files it names (`lessons/plan-facts.ts`), read from the artifact store. A task with no plan
 * yet, a plan that cannot be read or whose copy does not match its digest gives nothing; a plan written as Markdown (an older task) gives its first lines and no files.
 */
export function planFactsFor(dependencies: Pick<AwsBrokerDependencies, "s3" | "artifactBucketName">): NonNullable<LessonsRuntime["planFacts"]> {
  return async (task) => {
    const workflow = (task as { workflow?: DeveloperTaskRecord["workflow"] }).workflow;
    const plan = (workflow?.artifacts ?? []).filter((artifact) => artifact.type === "plan").sort((a, b) => a.version - b.version).at(-1);
    if (plan === undefined) return undefined;
    const loaded = await loadWorkflowDocument((key, max) => readObjectText(dependencies.s3, dependencies.artifactBucketName, key, max).catch(() => undefined), plan, {});
    if (loaded === undefined) return undefined;
    if (loaded.format === "structured") return planLoadFacts(loaded.plan);
    return { summary: cleanLessonText(loaded.markdown, PLAN_FACTS_SUMMARY_MAX), files: [] };
  };
}

/**
 * The tap's `enqueue` for human fix-up commits: one message of coordinates on the reflections' queue, like a task's end (the learning mode is checked by the worker, before anything is read from the host or the model
 * is called). Throws when the queue did not take it (the tap counts the delivery as failed; the lease makes a second message for the same edit harmless).
 */
export function humanEditEnqueue(queue: ReflectQueue, log?: (event: string, fields: Record<string, string | number>) => void, newRequestId: () => string = randomUUID): (job: HumanEditJob) => Promise<void> {
  return async (job) => {
    try {
      await queue.send(humanEditMessageOf(job, newRequestId()));
    } catch (error) {
      log?.("learning.human_edit_enqueue_failed", { taskId: job.taskId });
      throw error;
    }
  };
}

/** At handler start (`broker/handler.ts`): sets `dependencies.lessons` unless the caller gave one (tests). */
export function installLessons(dependencies: LessonsHostDependencies): void {
  if (dependencies.lessons !== undefined) return;
  const built = lessonsRuntimeFor(dependencies);
  if (built !== undefined) {
    dependencies.lessons = built;
    built.planFacts = planFactsFor(dependencies);
  }
  // Learning at the end of a task: only where the lessons runtime AND the model path exist (and a caller did not give its own).
  if (built !== undefined && dependencies.learning === undefined) {
    const learning = learningDepsFor(dependencies, built);
    if (learning !== undefined) dependencies.learning = learning;
  }
  // Lessons in production (lane 2, WB-7): the lessons' two jobs ride the Team record's schedules (the hourly deletion resumer, the nightly re-reflection of reverted tasks).
  installLessonsJobs(dependencies, built);

  // Human fix-up commits (decision Q5): the extractor is given to the Team record's tap, which reads nothing from a host until it has one. It also needs a way to queue a job that has time for a model call
  // (the LessonsWorker, lane 2): `humanEdit.install({ enqueue })` is that seam. Until a queue is installed no job is queued and no host is read.
  const live = dependencies.learning;
  // (A partial record runtime, as in some test harnesses, has no `humanEdit`: then nothing is installed.)
  const humanEditing = (dependencies.teamRecord as { humanEdit?: NonNullable<AwsBrokerDependencies["teamRecord"]>["humanEdit"] } | undefined)?.humanEdit;
  if (built !== undefined && live?.humanEdit !== undefined && humanEditing !== undefined) {
    humanEditing.install({
      extractor: createHumanEditExtractor({ source: live.source, settings: live.settings, reflect: live.reflect, process: live.process, standing: live.humanEdit.standing, isErased: live.humanEdit.isErased, ...(live.log === undefined ? {} : { log: live.log }) }),
      // Where the tap sends a job at a merge: ONE message of coordinates to the LessonsReflect queue (the reflections' own queue, worker, dead-letter queue and alarms), never a compare or a model call inside the webhook's
      // answer. The queue is only where the broker has one (the LessonsWorker itself has none and never sends). The worker checks the learning mode first, so a project with learning Off or Collect reads nothing from the host.
      ...(dependencies.lessonsReflectQueue === undefined ? {} : { enqueue: humanEditEnqueue(dependencies.lessonsReflectQueue, live.log) }),
    });
  }
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
    table: teamRecord.table, settings: runtime.settings, queue: dependencies.lessonsReflectQueue, maintain: runtime.counters, counters: runtime.counters, resume: (orgId, project) => deletion.resumeAll(orgId, project),
    now: Date.now, newRequestId: () => `nightly-${randomUUID()}`, log,
  };
  teamRecord.jobs.extend("nightly", (orgId, projects, budgetMs) => lessonsNightlyJob(jobs, orgId, projects, budgetMs));
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
