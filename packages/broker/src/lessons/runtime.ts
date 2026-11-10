// Learning v2 wiring (LS-3): the lessons library's ports, assembled once from the Team record's table and the broker's own readers. Everything here is built only where the Team record is on (the
// broker passes nothing otherwise), so with the switch off no lesson is stored, loaded, sent or shown.
//
// What is real: the Dynamo lesson store, the settings reader (the project's mode, the company lock, the tier-0 setting), the access check, the approver directory (the live roster), the
// citation verifier and the code facts (the code host's file reads at a commit), the audit sink (the broker's ledger) and the names reader.
// The model and the payer path are given by the broker's wiring where the company's own model path exists (`customerLearningModel`, `companyLearningSpend`); without them `judgeModel` and `spend` refuse
// (a curator judgement fails closed: a contradiction goes to a person). The correction judge of the counters rates corrections on the same model and payer path (`judge-model.ts`); without them it refuses too. Lesson similarity (DECISIONS 23: keywords,
// cited paths and the optional small embedder, fused; the vectors kept with the lessons) plugs in through the one seam `lessonSimilarityFor`.
import type { RepoFileRuntime } from "./repo-file-job.js";
import { OrgIdSchema, type OrgId } from "@agentx/contracts";
import type { AttributionReader } from "../attribution/resolve.js";
import type { SecondPersonEvidenceDependencies } from "../org/second-person-evidence.js";
import { createAccessCheckPort, type AccessCheckPort } from "../team-record/access-port.js";
import type { TaskVisibilityPort } from "../team-record/live-audience.js";
import type { RecordAuditSink } from "../team-record/audit.js";
import type { TeamRecordTable } from "../team-record/types.js";
import type { ApproveDeps } from "./approve.js";
import { lessonAuditSink, type LessonAuditOutbox } from "./audit-sink.js";
import { createCitationVerifier } from "./citation-verifier.js";
import { createCodeFacts, type CodeFactsReader } from "./code-facts.js";
import type { CounterDeps } from "./counters.js";
import { createApproverDirectory } from "./directory.js";
import { dynamoLearningSettings, DynamoPresetStore, DynamoSoleOwnerSwitch, DynamoTier0Settings } from "./dynamo-settings.js";
import { secondPersonTier0Authority } from "./tier0-authority.js";
import type { PresetDeps } from "./preset-setting.js";
import { DynamoLessonStore } from "./dynamo-store.js";
import { modelCorrectionJudge } from "./judge-model.js";
import { dynamoEvalSnapshotStore, dynamoSnapshotStore, type EvalSnapshotStore, type SnapshotStore } from "./replay-snapshot-store.js";
import type { LoadDeps } from "./load.js";
import type { LessonsPauseStore } from "./pause.js";
import type { ApproverDirectory, CorrectionJudge, LearningSpend, LessonEmbedder, LessonVectors, PipelineModel } from "./ports.js";
import type { ProcessDeps } from "./process.js";
import type { Edition, LearningSettingsReader } from "./policy.js";
import { gatedByLessonsSwitch } from "./model-gate.js";
import { projectRepoScopesOf } from "./project-repo-audience.js";
import type { LessonStore } from "./store.js";
import type { LessonViewDeps } from "./view.js";

export interface LessonsRuntimeInput {
  table: TeamRecordTable;
  now: () => number;
  log?: (event: string, fields: Record<string, unknown>) => void;
  /** The broker's audit ledger writer. Absent: nothing that needs an audit record can be decided (fail closed). */
  audit?: RecordAuditSink | undefined;
  /** How an audit event rides in a caller's own transaction (a setting and its audit line commit together). Absent: such a change is refused. */
  auditOutbox?: LessonAuditOutbox | undefined;
  /** The code host's file reads at a commit, for citations and code facts. */
  reader: CodeFactsReader;
  repositoriesOf: (workspaceId: string, project: string) => Promise<readonly string[]>;
  evidence: SecondPersonEvidenceDependencies;
  linkedAccounts: (orgId: OrgId, developerId: string) => Promise<readonly string[]>;
  /** The live Plan 5 visibility of tasks (`tableTaskVisibilityPort` over the State table): a lesson is shown only while every task it was learned from is still visible to the reader (`live-visibility.ts`). */
  taskVisibility: TaskVisibilityPort;
  /** Follows a merged developer to the member they became (the author rules compare members, not raw ids). */
  resolveMember?: (orgId: OrgId, developerId: string) => Promise<string>;
  names: AttributionReader;
  /**
   * Lessons in production: the model the curator's judge calls and the payer path (the company's cap). Absent: the refusing stand-ins, so nothing is judged or spent. The reflector's own model is
   * built from the same two in the broker's wiring (`aws/broker/lessons-wiring.ts`).
   */
  model?: PipelineModel;
  spend?: LearningSpend;
  /** The install's edition: the curator's judge call is held to Public's per-task cap (like the reflector's). Absent: Public. */
  edition?: Edition;
  /** Where "lessons paused" is recorded and read (lane 1b). Absent: learning never records why it stopped, and the tab and Home say nothing about it. */
  pause?: LessonsPauseStore;
  /** Whether a recorded pause reason still holds (`LessonViewDeps.pauseStillApplies`). */
  pauseStillApplies?: LessonViewDeps["pauseStillApplies"];
  /**
   * The one seam for lesson similarity (`lessonSimilarityFor`): the lesson vectors and the OPTIONAL small open embedder. Without an embedder the shortlist is code-aware keywords and cited paths alone (lessons/similarity.ts).
   * Absent: no vectors are kept either, which is the same ranking.
   */
  similarity?: { embedder?: LessonEmbedder | undefined; vectors: LessonVectors };
}

/** The route-side lesson dependencies (`DeveloperRouteDependencies.lessons`). */
export type LessonRouteDeps = LessonViewDeps & ApproveDeps & ProcessDeps & CounterDeps & { /** Where a maintainer or admin sets the preset (Regulated at once; Standard through a second person). Absent: the route is not there. */ presets?: PresetDeps };

export interface LessonsRuntime {
  readonly store: LessonStore;
  readonly settings: LearningSettingsReader;
  readonly access: AccessCheckPort;
  readonly directory: ApproverDirectory;
  /** What the dispatch loader needs. */
  readonly load: LoadDeps;
  /** Lane 7: the frozen snapshots a replay copy reads (`replay-snapshot-store.ts`). */
  readonly snapshots?: SnapshotStore;
  /** Lane 7 (DECISIONS 68): the lessons an arm's own pipeline built offline, imported as frozen snapshots; separate from the live lessons. */
  readonly evalSnapshots?: EvalSnapshotStore;
  /** Lane 7 (DECISIONS 68): the company's model path and learning month WITHOUT the lessons switch, for the replay's gradings and offline pipelines only (`eval-model.ts`). Absent: no model path. */
  readonly evalModel?: { model: PipelineModel; spend: LearningSpend };
  /** What `applyLoadReport` needs. */
  readonly counters: CounterDeps;
  /** What the lessons routes need. */
  readonly routes: LessonRouteDeps;
  /**
   * What the loader is told about a task besides its title: a summary of the approved plan and the files it names (`plan-facts.ts`). Set by the broker's wiring where the artifact store is reachable.
   * Absent, or a task with no plan yet: the loader asks with the title and the request alone and no files, so no path scope is judged.
   */
  planFacts?: (task: { orgId?: string | undefined; taskId: string; workflow?: unknown }) => Promise<{ summary: string; files: readonly string[] } | undefined>;
  /** Lessons in the repo (R2): the weekly file pass and its routes. Set by the broker's wiring where the Team record and the sign-in table exist. */
  repoFile?: RepoFileRuntime;
}

const noModel = (): never => { throw new Error("no learning model is set up in this install"); };
/** No pipeline model: every call fails, so nothing is judged, reflected or rated by a model. */
export const REFUSING_MODEL: PipelineModel = { complete: async () => noModel() };
/** Never usable: with no model nothing can be rated, so nothing is recorded and no helpful mark is queued (fails safe). */
export const REFUSING_JUDGE: CorrectionJudge = { rate: async () => noModel(), usable: async () => false };
/** No payer path: nothing is admitted and nothing is charged. */
export const DENYING_SPEND: LearningSpend = { admit: async () => false };
/** No lesson vectors are kept: the ranking is keywords and cited paths alone. */
export const NO_VECTORS: LessonVectors = { get: async () => new Map(), put: async () => undefined, remove: async () => undefined };

export function createLessonsRuntime(input: LessonsRuntimeInput): LessonsRuntime {
  const store = new DynamoLessonStore(input.table, input.now);
  const settings = dynamoLearningSettings(input.table, new DynamoTier0Settings(input.table));
  const access = createAccessCheckPort(input.table, { taskVisibility: input.taskVisibility, ...(input.log === undefined ? {} : { log: input.log }) });
  const directory = createApproverDirectory({ evidence: input.evidence, linkedAccounts: input.linkedAccounts, ...(input.resolveMember === undefined ? {} : { resolveMember: input.resolveMember }) });
  const unwritable: RecordAuditSink = async () => { throw new Error("no audit ledger"); };
  const audit = lessonAuditSink(input.audit ?? unwritable, input.now, input.auditOutbox);
  const base = { now: input.now, audit, ...(input.log === undefined ? {} : { log: input.log }) };
  const facts = createCodeFacts({ reader: input.reader, repositoriesOf: async (workspaceId, project) => input.repositoriesOf(workspaceId, project) });
  const verifier = createCitationVerifier({ reader: input.reader, repositoriesOf: input.repositoriesOf });
  const similarity = input.similarity ?? { vectors: NO_VECTORS };
  const load: LoadDeps = { ...base, store, embedder: similarity.embedder, vectors: similarity.vectors, settings, access, ...(directory.resolveMember === undefined ? {} : { resolveMember: (workspaceId: string, developerId: string) => directory.resolveMember!(workspaceId, developerId) }) };
  // Lessons outcomes: the counters' correction judge rides the company's own model path with its caps and pause records, like the curator's judge; without that path it refuses (a correction stays unjudged).
  const outcomeJudge = input.model === undefined || input.spend === undefined ? REFUSING_JUDGE : modelCorrectionJudge({ model: input.model, spend: input.spend, pause: input.pause, edition: input.edition });
  const counters: CounterDeps = { ...base, store, judge: outcomeJudge, settings, vectors: similarity.vectors };
  const presetStore = new DynamoPresetStore(input.table);
  const routes: LessonRouteDeps = {
    ...base, store, directory, settings, access, names: input.names, sources: { table: input.table },
    embedder: similarity.embedder, vectors: similarity.vectors, judgeModel: input.model === undefined ? REFUSING_MODEL : gatedByLessonsSwitch(input.model), spend: input.spend ?? DENYING_SPEND, ...(input.edition === undefined ? {} : { edition: input.edition }), ...(input.pause === undefined ? {} : { pause: input.pause }), ...(input.pauseStillApplies === undefined ? {} : { pauseStillApplies: input.pauseStillApplies }), verifier, facts, judge: REFUSING_JUDGE,
    // Owner decision 34: the project's own repositories, read live when a lesson is tiered or put on trial; no port or an unreadable definition is "not known", which leaves a repository-restricted lesson restricted.
    projectRepos: async (key) => {
      const port = projectRepoScopesOf(input.taskVisibility);
      const org = OrgIdSchema.safeParse(key.workspaceId);
      if (port === undefined || !org.success) return undefined;
      try { return await port.read(org.data, key.project); } catch { return undefined; }
    },
    presets: {
      // The project's maintainers and admins decide a project's preset; a company's is decided by the company's admins. Both go through the shared second-person evidence (the same rule and fence as the tier-0 setting).
      settings: presetStore, changes: presetStore, audit, now: input.now, authority: secondPersonTier0Authority(input.evidence), soleOwnerLoosening: (workspaceId) => new DynamoSoleOwnerSwitch(input.table).read(workspaceId),
    },
  };
  return { store, settings, access, directory, load, counters, routes, snapshots: dynamoSnapshotStore(input.table), evalSnapshots: dynamoEvalSnapshotStore(input.table, undefined, input.now), ...(input.model === undefined || input.spend === undefined ? {} : { evalModel: { model: input.model, spend: input.spend } }) };
}
