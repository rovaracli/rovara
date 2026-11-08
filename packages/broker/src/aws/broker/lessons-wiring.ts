// Part of the broker: builds the lessons library's ports from the broker's own dependencies (learning v2, LS-3) and puts them on `dependencies.lessons`. Called once at handler start. Where the Team
// record is off (`dependencies.teamRecord` is undefined, the default), or the install has no developer sign-in table, nothing is built: no lesson is stored, loaded, sent, shown or decided.
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { OrgIdSchema, codeRepositoriesOf, memberGithubKey, type AuditEventInput, type LessonsPauseCode, type OrgId } from "@agentx/contracts";
import { followMerges } from "../../agents/access.js";
import { dynamoAttributionReader } from "../../attribution/resolve.js";
import { DeveloperSignInStore } from "../../developer/store.js";
import type { CodeFactsReader } from "../../lessons/code-facts.js";
import { NO_EMBEDDER, NO_VECTORS, createLessonsRuntime, type LessonsRuntime } from "../../lessons/runtime.js";
import type { Embedder, LearningSpend, LessonVectors, PipelineModel } from "../../lessons/ports.js";
import type { TaskLearningDeps } from "../../lessons/task-end.js";
import { tableOutcomeRows } from "../../lessons/task-outcome-rows.js";
import { readObjectText } from "../../developer/plan-artifacts.js";
import { customerLearningModel } from "./learning-model.js";
import { readLessonsModel } from "../../lessons/model-setting.js";
import { dynamoPauseStore, spendLook } from "../../lessons/pause.js";
import { companyLearningSpend } from "./learning-spend.js";
import { lessonSubjectSource } from "./lesson-subject-source.js";
import { setLessonsHomeReader } from "../../lessons/home-source.js";
import { resolveLearning } from "../../lessons/policy.js";
import { buildLessonsView } from "../../lessons/view.js";
import { recordAuditSinkOf } from "./team-record-wiring.js";
import { auditPending } from "../../audit/outbox.js";
import { flushAuditEvents } from "../../audit/flush.js";
import { readProjectRole, readStanding } from "../../learning/standing.js";
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
export function learningDepsFor(dependencies: AwsBrokerDependencies, runtime: LessonsRuntime): TaskLearningDeps | undefined {
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
export function installLessons(dependencies: AwsBrokerDependencies): void {
  if (dependencies.lessons !== undefined) return;
  const built = lessonsRuntimeFor(dependencies);
  if (built !== undefined) dependencies.lessons = built;
  // Learning at the end of a task: only where the lessons runtime AND the model path exist (and a caller did not give its own).
  if (built !== undefined && dependencies.learning === undefined) {
    const learning = learningDepsFor(dependencies, built);
    if (learning !== undefined) dependencies.learning = learning;
  }
  // UX-4b: Home's "Lessons waiting" card counts what the Lessons tab would show this person to decide (learning Off: none).
  const routes = dependencies.lessons?.routes;
  setLessonsHomeReader(routes === undefined ? undefined : async (orgId, developerId, project) => {
    if ((await resolveLearning(routes.settings, orgId, project)).mode === "Off") return { waiting: 0 };
    const view = await buildLessonsView(routes, { orgId, developerId }, project);
    // Lane 1b: a person who decides here also hears why learning is paused (never silent).
    const paused = view.canDecide ? view.paused : undefined;
    if (!view.canDecide || view.waiting.length === 0) return { waiting: 0, ...(paused === undefined ? {} : { paused }) };
    return { waiting: view.waiting.length, at: new Date(Math.max(...view.waiting.map((lesson) => lesson.updatedAt))).toISOString(), ...(paused === undefined ? {} : { paused }) };
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
