// Learning v2 wiring (LS-3): the lessons library's ports, assembled once from the Team record's table and the broker's own readers. Everything here is built only where the Team record is on (the
// broker passes nothing otherwise), so with the switch off no lesson is stored, loaded, sent or shown.
//
// What is real: the Dynamo lesson store, the settings reader (the project's mode, the company lock, the tier-0 setting), the access check, the approver directory (the live roster), the
// citation verifier and the code facts (the code host's file reads at a commit), the audit sink (the broker's ledger) and the names reader.
// The model and the payer path are given by the broker's wiring where the company's own model path exists (`customerLearningModel`, `companyLearningSpend`); without them `judgeModel` and `spend` refuse
// (a curator judgement fails closed: a contradiction goes to a person). The correction judge (`judge`) still refuses: a correction rating is not wired yet. Lesson similarity (DECISIONS 23: keywords,
// cited paths and the optional small embedder, fused; the vectors kept with the lessons) plugs in through the one seam `lessonSimilarityFor`.
import type { OrgId } from "@agentx/contracts";
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
import type { LoadDeps } from "./load.js";
import type { LessonsPauseStore } from "./pause.js";
import type { ApproverDirectory, CorrectionJudge, LearningSpend, LessonEmbedder, LessonVectors, PipelineModel } from "./ports.js";
import type { ProcessDeps } from "./process.js";
import type { LearningSettingsReader } from "./policy.js";
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
  /** What `applyLoadReport` needs. */
  readonly counters: CounterDeps;
  /** What the lessons routes need. */
  readonly routes: LessonRouteDeps;
  /**
   * What the loader is told about a task besides its title: a summary of the approved plan and the files it names (`plan-facts.ts`). Set by the broker's wiring where the artifact store is reachable.
   * Absent, or a task with no plan yet: the loader asks with the title and the request alone and no files, so no path scope is judged.
   */
  planFacts?: (task: { orgId?: string | undefined; taskId: string; workflow?: unknown }) => Promise<{ summary: string; files: readonly string[] } | undefined>;
}

const noModel = (): never => { throw new Error("no learning model is set up in this install"); };
/** No pipeline model: every call fails, so nothing is judged, reflected or rated by a model. */
export const REFUSING_MODEL: PipelineModel = { complete: async () => noModel() };
export const REFUSING_JUDGE: CorrectionJudge = { rate: async () => noModel() };
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
  const counters: CounterDeps = { ...base, store, judge: REFUSING_JUDGE, settings, vectors: similarity.vectors };
  const presetStore = new DynamoPresetStore(input.table);
  const routes: LessonRouteDeps = {
    ...base, store, directory, settings, access, names: input.names, sources: { table: input.table },
    embedder: similarity.embedder, vectors: similarity.vectors, judgeModel: input.model ?? REFUSING_MODEL, spend: input.spend ?? DENYING_SPEND, ...(input.pause === undefined ? {} : { pause: input.pause }), ...(input.pauseStillApplies === undefined ? {} : { pauseStillApplies: input.pauseStillApplies }), verifier, facts, judge: REFUSING_JUDGE,
    presets: {
      // The project's maintainers and admins decide a project's preset; a company's is decided by the company's admins. Both go through the shared second-person evidence (the same rule and fence as the tier-0 setting).
      settings: presetStore, changes: presetStore, audit, now: input.now, authority: secondPersonTier0Authority(input.evidence), soleOwnerLoosening: (workspaceId) => new DynamoSoleOwnerSwitch(input.table).read(workspaceId),
    },
  };
  return { store, settings, access, directory, load, counters, routes };
}
