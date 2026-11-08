// Learning v2 wiring (LS-3): the lessons library's ports, assembled once from the Team record's table and the broker's own readers. Everything here is built only where the Team record is on (the
// broker passes nothing otherwise), so with the switch off no lesson is stored, loaded, sent or shown.
//
// What is real: the Dynamo lesson store, the settings reader (the project's mode, the company lock, the tier-0 setting), the access check, the approver directory (the live roster), the
// citation verifier and the code facts (the code host's file reads at a commit), the audit sink (the broker's ledger) and the names reader.
// What is deliberately NOT here: any model call. There is no model adapter, spend gate or payer path for learning yet, so `judgeModel`, `judge` and `spend` refuse: a curator judgement, a
// correction rating and a reflector call all fail closed (a contradiction goes to a person, a helpful mark waits). Lesson vectors do not exist either (the `LessonVectors` adapter over S3 Vectors is
// not built), so the loader ranks by scope, helpfulness and recency; similarity is zero for every lesson. Both are listed in the lane report under "Left".
import type { OrgId } from "@agentx/contracts";
import type { AttributionReader } from "../attribution/resolve.js";
import type { SecondPersonEvidenceDependencies } from "../org/second-person-evidence.js";
import { createAccessCheckPort, type AccessCheckPort } from "../team-record/access-port.js";
import type { RecordAuditSink } from "../team-record/audit.js";
import type { TeamRecordTable } from "../team-record/types.js";
import type { ApproveDeps } from "./approve.js";
import { lessonAuditSink } from "./audit-sink.js";
import { createCitationVerifier } from "./citation-verifier.js";
import { createCodeFacts, type CodeFactsReader } from "./code-facts.js";
import type { CounterDeps } from "./counters.js";
import { createApproverDirectory } from "./directory.js";
import { dynamoLearningSettings, DynamoPresetStore, DynamoSoleOwnerSwitch, DynamoTier0Settings } from "./dynamo-settings.js";
import { secondPersonTier0Authority } from "./tier0-authority.js";
import type { PresetDeps } from "./preset-setting.js";
import { DynamoLessonStore } from "./dynamo-store.js";
import type { LoadDeps } from "./load.js";
import type { ApproverDirectory, CorrectionJudge, Embedder, LearningSpend, LessonVectors, PipelineModel } from "./ports.js";
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
  /** The code host's file reads at a commit, for citations and code facts. */
  reader: CodeFactsReader;
  repositoriesOf: (workspaceId: string, project: string) => Promise<readonly string[]>;
  evidence: SecondPersonEvidenceDependencies;
  linkedAccounts: (orgId: OrgId, developerId: string) => Promise<readonly string[]>;
  /** Follows a merged developer to the member they became (the author rules compare members, not raw ids). */
  resolveMember?: (orgId: OrgId, developerId: string) => Promise<string>;
  names: AttributionReader;
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
}

const noModel = (): never => { throw new Error("no learning model is set up in this install"); };
/** No pipeline model: every call fails, so nothing is judged, reflected or rated by a model. */
export const REFUSING_MODEL: PipelineModel = { complete: async () => noModel() };
export const REFUSING_JUDGE: CorrectionJudge = { rate: async () => noModel() };
/** No payer path: nothing is admitted and nothing is charged. */
export const DENYING_SPEND: LearningSpend = { admit: async () => false, charge: async () => undefined };
/** No lesson vectors and no embeddings: the loader ranks by scope, helpfulness and recency. No Bedrock call is made. */
export const NO_EMBEDDER: Embedder = { embed: async () => [] };
export const NO_VECTORS: LessonVectors = { upsert: async () => undefined, query: async () => [], remove: async () => undefined };

export function createLessonsRuntime(input: LessonsRuntimeInput): LessonsRuntime {
  const store = new DynamoLessonStore(input.table, input.now);
  const settings = dynamoLearningSettings(input.table, new DynamoTier0Settings(input.table));
  const access = createAccessCheckPort(input.table, input.log === undefined ? {} : { log: input.log });
  const directory = createApproverDirectory({ evidence: input.evidence, linkedAccounts: input.linkedAccounts, ...(input.resolveMember === undefined ? {} : { resolveMember: input.resolveMember }) });
  const unwritable: RecordAuditSink = async () => { throw new Error("no audit ledger"); };
  const audit = lessonAuditSink(input.audit ?? unwritable, input.now);
  const base = { now: input.now, audit, ...(input.log === undefined ? {} : { log: input.log }) };
  const facts = createCodeFacts({ reader: input.reader, repositoriesOf: async (workspaceId, project) => input.repositoriesOf(workspaceId, project) });
  const verifier = createCitationVerifier({ reader: input.reader, repositoriesOf: input.repositoriesOf });
  const load: LoadDeps = { ...base, store, embedder: NO_EMBEDDER, vectors: NO_VECTORS, settings, access, ...(directory.resolveMember === undefined ? {} : { resolveMember: (workspaceId: string, developerId: string) => directory.resolveMember!(workspaceId, developerId) }) };
  const counters: CounterDeps = { ...base, store, judge: REFUSING_JUDGE, settings };
  const presetStore = new DynamoPresetStore(input.table);
  const routes: LessonRouteDeps = {
    ...base, store, directory, settings, access, names: input.names, sources: { table: input.table },
    embedder: NO_EMBEDDER, vectors: NO_VECTORS, judgeModel: REFUSING_MODEL, spend: DENYING_SPEND, verifier, facts, judge: REFUSING_JUDGE,
    presets: {
      // The project's maintainers and admins decide a project's preset; a company's is decided by the company's admins. Both go through the shared second-person evidence (the same rule and fence as the tier-0 setting).
      settings: presetStore, changes: presetStore, audit, now: input.now, authority: secondPersonTier0Authority(input.evidence), soleOwnerLoosening: (workspaceId) => new DynamoSoleOwnerSwitch(input.table).read(workspaceId),
    },
  };
  return { store, settings, access, directory, load, counters, routes };
}
