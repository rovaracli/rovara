// The Team record's runtime in the broker (wire-team-record): the ONE place the record's pieces (sink, taps, query API, tools, erase, jobs) are put together with the broker's real data.
//
// THE SWITCH. `createTeamRecordRuntime` returns `undefined` unless the environment says `TEAM_RECORD_ENABLED=1` exactly (the packed broker setting the CDK writes only when the install is
// synthesised with `agentxTeamRecord=enabled`). With it off, nothing here runs: no SDK client is created, no table is read or written, no schedule job does anything, and the broker's call
// sites (`dependencies.teamRecord?.…`) are all optional chains on `undefined`. The broker and the Slack ingress each check the same word, so a half-deployed switch is still off.
//
// ORG SCOPING. Every entry point takes the org from the caller's session, the verified delivery's installation, the hook's tenant, the Slack team's binding or the task record, never from a
// request body. A workspace id that is not an org id is refused by the router below before any vector bucket is looked up. A delivery that names no registered repository records nothing.
//
// What this does NOT contain (and the lane report says so): a model. The distiller and the human-edit extractor need the learning lane's `PipelineModel` and its spend gate; until a model is
// given (`distillModel`), retention B (Public Slack "notes with links") has nowhere to go and the message is processed and DROPPED, which is the safe side of Slack's terms.
import { createHash, randomUUID } from "node:crypto";
import { DeleteCommand, GetCommand, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { STSClient } from "@aws-sdk/client-sts";
import { OrgIdSchema, VECTOR_DIMENSION_DEFAULT, repositoryHostOf, githubMemberKey, teamRecordPk, memberGithubKey, orgMetaKey, TEAM_RECORD_ORG_DIRECTORY_PK, orgPk, orgProjectCatalogPk, teamRecordOrgDirectoryKey, type OrgId, type ProjectRole } from "@agentx/contracts";
import { companyIsOpen, readProjectRole, readStanding } from "../learning/standing.js";
import { readProjectMeta } from "../developer/project-roles.js";
import { latestRevision } from "../org/project-settings.js";
import { OrgStore } from "../org/store.js";
import { resolveSlackOrg } from "../org/resolve.js";
import { orgOfInstallation, projectsOf as projectsOfRepository } from "../triggers/github-events.js";
import { findLinkedChangeRequest } from "../rovara-code/linked-change-requests.js";
import { taskKey, type DeveloperTaskRecord } from "../developer/task-records.js";
import { athenaPort, bedrockInvokeModelPort, s3VectorsPortFromCredentials, type SdkLoader } from "./aws-adapters.js";
import { DynamoLessonStore } from "../lessons/dynamo-store.js";
import { lessonDeletionPort } from "../lessons/deletion.js";
import type { LessonVectors } from "../lessons/ports.js";
import { runArchive } from "./archiver.js";
import type { RecordAuditSink } from "./audit.js";
import { callRecordTool, recordToolsFor, type RecordToolContext } from "./agent-tools.js";
import { runDeleteWorker, type DeleteBudget } from "./delete-worker.js";
import { defaultRetention, readEdition, type TeamRecordEdition } from "./edition.js";
import { markSourceFailing } from "./store.js";
import { resolveTaskVisibility } from "../lessons/task-visibility.js";
import { createEmbedder } from "./embed.js";
import { eraseProject, eraseWorkspace, erasePerson, type EraseBudget } from "./erase.js";
import { tableHotArchiveSource, ensureWorkspaceVectorBucket, tableHotStatsSource } from "./hot-source.js";
import { createLakeClient, type LakeClient } from "./lake.js";
import { runLakeDeletes } from "./lake-delete.js";
import { tableLakeDeleteQueue } from "./lake-queue.js";
import { tableModeReader, type LearningModeReader } from "./mode.js";
import { buildRecordCaller, handleRecordRoute, type RecordRouteReply } from "./routes.js";
import { dynamoRateLimiter, type RecordQueryDependencies } from "./query.js";
import { SLACK_REFUSAL_FLOOR_MS, type SourceRouteDependencies, type SourceWriteContext } from "./source-write.js";
import { createCaptureModePort, createRecordSink, createSourceConfigPort, NOTES_OPT_IN_FROM_SOURCE_ROW, type RecordSink } from "./sink.js";
import { createOpConsumer, type QueueRecord } from "./sources/queue.js";
import { TEAM_RECORD_REMOVAL_SOURCE, type DeadLetterPort, type OpsQueue, type RemovalFallback, type RemovalFallbackEvent } from "./ops-queue.js";
import { developerOfTrackerAuthor, isTrackerSystem, linkTrackerByVerifiedEmail, linkTrackerIdentity, listLinkedTrackerUsers, listUnmatchedTrackerUsers, mapTrackerUser, removeTrackerLinks, trackerLinksOf, unmapTrackerUser, UNMATCHED_PREFIX, type LinkedTrackerUser, type TrackerLink, type TrackerLinkVia, type UnmatchedTrackerUser } from "./identity-links.js";
import { autoLinkEnabled, setAutoLinkEnabled, type VerifiedDomainsPort } from "./tracker-autolink.js";
import { markSyncDue, syncIsDue, syncTrackerUsers, type ConnectedTrackersPort, type SyncResult } from "./tracker-directory.js";
import { auditOccurrence, auditRecordTrackerAutolinkChanged, auditRecordTrackerPersonMapped, auditRecordTrackerPersonUnmapped } from "../audit/events.js";
import { needsLinkedAuthor, unlinkedCounter } from "./unlinked.js";
import { priorEditsPort } from "./prior-edits.js";
import { trackerPlaceCheck, trackerPlaceOptions } from "./source-places.js";
import { createGithubRecordTap, createHookRecordTap, createRecordParentLookup, createRovaraEmitter, createSlackRecordTap, createTicketRecorder, type ActorResolverPort, type RovaraEmitter, type TaskVisibility, type SlackChannelInfo, type SlackDirectoryPort } from "./sources/index.js";
import { createSlackAdd, type SlackAddService } from "./slack-add.js";
import { runStats, type StatsDeps } from "./stats-templates.js";
import { expireRawText } from "./text-expiry.js";
import { createTransientDistiller } from "./transient-distiller.js";
import { createAssume, createStsAssumePort, openWorkspaceIndex, WorkspaceVectorPorts, type StsAssumePort } from "./vector-access.js";
import { chooseVectorBucketForNewWorkspace, type VectorIndex } from "./vectors.js";
import type { S3VectorsIndex } from "./s3-vectors-index.js";
import type { DistillModel } from "./distill.js";
import type { PurgeDependencies } from "./purge.js";
import { readOpsFailures, recordOpsFailure, type OpsFailures } from "./ops-failures.js";
import type { RecordLog, RecordVectorPort, TeamRecordTable } from "./types.js";

type DocClient = TeamRecordTable["documentClient"];

/** Exactly the word the CDK writes. Anything else, including "true", "on" and a missing variable, is OFF. */
export const teamRecordIsOn = (env: Record<string, string | undefined>): boolean => env.TEAM_RECORD_ENABLED === "1";
/**
 * UX-4b review fix 1: the record PAUSED (`agentx config set teamRecord.enabled 0`, TEAM_RECORD_ACTIVE exactly "0"). The runtime is still built, so person and project erasure, source removals,
 * Slack deletes, the queue, expiry and the archiver keep running over the retained data. What stops: every new row (each put is refused as `paused`), the record's reads and search (the routes
 * answer TEAM_RECORD_PAUSED, except a source removal, which deletes), the agent's record tools, and learning (the mode reads Off, so nothing is captured or loaded; lessons are not built).
 */
export const teamRecordIsPaused = (env: Record<string, string | undefined>): boolean => env.TEAM_RECORD_ACTIVE === "0";
const PAUSED_REPLY = { status: 503, body: { code: "TEAM_RECORD_PAUSED", message: "The team record is paused in this installation." } } as const;
/** Whether a request may run while the record is paused: a source removal (it deletes data), and nothing else. */
function allowedWhilePaused(method: string, path: string, write: { body(): unknown } | undefined): boolean {
  if (method !== "POST" || !/\/record\/sources$/u.test(path) || write === undefined) return false;
  try { const body = write.body() as { action?: unknown } | null;return body?.action === "remove"; } catch { return false; }
}

export interface TeamRecordRuntimeInput {
  env: Record<string, string | undefined>;
  /** The State table's client (identities, projects, orgs, tasks) and name. The record's own table is named by `TEAM_RECORD_TABLE_NAME`. */
  documentClient: DocClient;
  stateTableName: string;
  now?: () => number;
  log?: (entry: Record<string, unknown>) => void;
  /**
   * The Slack user ids a developer has signed in with (the sign-in store's linked Slack identities). A person erase also erases the Slack rows those ids wrote, in every Slack team bound to the org.
   * Absent: only the linked GitHub account and the developer id are erased. (No Linear or Jira account is linked to a developer anywhere, so tracker rows by a person without a developer id are
   * reachable only once such a link exists; the DPA wording says so.)
   */
  slackUserIdsOf?: (developerId: string) => Promise<string[]>;
  /** The Rovara person a Slack user id belongs to (the sign-in store's Slack identity link), or undefined. A Slack message is stored only when its author resolves to a member of the org here (TRW-4). */
  developerOfSlackUser?: (slackUserId: string) => Promise<string | undefined>;
  /** The dead-letter queue, read only to delete PUT messages (their text) out of it every hour (TRW-5 S1). Absent: no sweep. */
  deadLetters?: DeadLetterPort;
  /** A delete that neither the table nor the durable queue accepted goes here: an asynchronous Event invoke of the broker itself (TRW-5 S2). Absent: the failure is thrown, as before. */
  removalFallback?: RemovalFallback;
  /**
   * The names a developer is known by (their sign-in name, or the one they chose). A person erase passes them as `ErasedPerson.names` so an Ask still being answered does not write them: they are kept for at
   * most 30 days, and only as keyed hashes (LI-2). Read again on each pass of the erase and never stored in its job. Absent, or a read that fails: the erase goes on without them (the Ask scrub then
   * keeps only the person's label tag).
   */
  namesOf?: (developerId: string) => Promise<string[]>;
  /** The key the erased person's aliases are hashed with (`askAliasHashKey(callbackSigningKey)`, LA-5). Absent: only the person's label tag is kept for Ask scrubbing, never a raw alias. */
  askAliasKey?: string;
  /** Where the record's own audit events go (record.tombstoned, record.erased, lesson.withdrawn). Absent: none are written. */
  audit?: RecordAuditSink;
  /** A model for the distiller (retention B / nightly). Absent: no distiller, B text is dropped. */
  distillModel?: DistillModel;
  /**
   * The durable queue for removals and edits (`agentx-<env>-team-record-ops`, a dead-letter queue behind it). A tombstone, a member or audience change, or a new version of an item that fails
   * against the record table is sent here and applied by `drain`, so a delete is never swallowed by a tap. Absent (tests, or an install without the queue): a failure is rethrown to the caller.
   */
  opsQueue?: OpsQueue;
  /**
   * The org's connected Linear and Jira connections, to read their user lists through (lane team-record-links). Absent: no tracker person is linked automatically and the mapping page lists nobody. A company that
   * has not connected a tool has nothing here for it, and nothing is read for it.
   */
  trackers?: ConnectedTrackersPort;
  /**
   * The domains the company has verified for its Rovara sign-in (condition 1 of the opt-in automatic linking). No install records such a list today, so nothing supplies it and the answer is always "none recorded": no
   * person is linked by themselves, and nothing is guessed from members' emails.
   */
  verifiedDomains?: VerifiedDomainsPort;
  /** Tests: a loader for the AWS SDK packages and an STS port. */
  sdk?: SdkLoader;
  sts?: StsAssumePort;
}

export interface TeamRecordCallerInput { orgId: OrgId; developerId: string; projectRole: ProjectRole | undefined }

/** What the scheduled jobs report: counts only. */
export interface TeamRecordJobSummary { orgs: number; skippedOrgs: number; details: Record<string, number> }

export interface TeamRecordRuntime {
  readonly edition: TeamRecordEdition;
  readonly table: TeamRecordTable;
  /**
   * The sink the taps write to: one sink per workspace, built on first use; a workspace id that is not an org id is refused. A removal or edit that fails is sent to the durable queue
   * (and rethrown if that fails too), so a tap never swallows a delete.
   */
  readonly sink: RecordSink;
  /** Applies a batch of messages from the durable queue (SQS partial-batch answer). A message that fails stays on the queue and is retried, then dead-lettered. */
  drain(records: ReadonlyArray<QueueRecord>, options?: { remainingMs?: () => number }): Promise<{ batchItemFailures: Array<{ itemIdentifier: string }> }>;
  /** Applies a delete the broker sent to itself (`agentx.team-record-removal`). Throws when it could not: Lambda retries the Event invoke twice and then hands it to the failure destination. */
  removal(event: RemovalFallbackEvent): Promise<void>;
  /** TRW-4: tracker author links. Called by the connect and sign-in flows, and by an adapter that holds an email its tracker reports as verified. */
  readonly links: {
    link(orgId: OrgId, input: TrackerLink & { developerId: string; via: Exclude<TrackerLinkVia, "verified_email"> }): Promise<boolean>;
    linkByVerifiedEmail(orgId: OrgId, input: TrackerLink & { email: string; emailVerified: boolean | undefined }): Promise<boolean>;
  };
  /**
   * Tracker people (Linear, Jira): who the tool lists, who is linked to a Rovara person, and the admin's mapping of the rest. Every call is for ONE org, taken from the caller's session by the route.
   * The route has already checked that the caller is a company owner or admin with a fresh sign-in.
   */
  readonly trackerPeople: {
    /** Tool users nobody is linked to (display name and tool id only) and the ones linked (so an admin can unmap one). */
    list(orgId: OrgId): Promise<{ unmatched: UnmatchedTrackerUser[]; linked: LinkedTrackerUser[]; truncated: boolean; autoLink: { enabled: boolean; verifiedDomainsRecorded: boolean } }>;
    /** Turns the company's automatic linking on or off (off by default). Audited first; the request id is bound to the change. Turning it on marks the org's connected tools due; turning it off stops NEW automatic links only. */
    setAutoLink(orgId: OrgId, input: { enabled: boolean; by: string; requestId: string }): Promise<"set" | "audit_unavailable" | "request_reused">;
    /** Maps an unmatched tool user to a member of the SAME org. `audit_unavailable` when the audit event cannot be written (nothing is changed then). */
    map(orgId: OrgId, input: TrackerLink & { developerId: string; by: string; requestId: string }): Promise<"mapped" | "not_found" | "not_member" | "audit_unavailable" | "request_reused">;
    unmap(orgId: OrgId, input: TrackerLink & { by: string; requestId: string }): Promise<"unmapped" | "not_found" | "audit_unavailable" | "request_reused">;
    /** A connection was saved: its users are marked due and the org joins the scheduled jobs, which read them at their next run. Nothing is read here, so a save never waits on the tool. False when the org has no such connection. */
    requestSync(orgId: OrgId, connectionId: string): Promise<boolean>;
    /** Reads one connection's users and links or lists them now, within `maxMs`. Undefined when the org has no such connection (nothing is read). */
    syncConnection(orgId: OrgId, connectionId: string, options?: { maxMs?: number }): Promise<SyncResult | undefined>;
  };
  readonly emitter: RovaraEmitter;
  /** Who may read the rows about a task: its Plan 5 visibility, read from the State table when a row is written (`lessons/task-visibility.ts`). `undefined`: nothing is recorded for the task. */
  taskVisibility(orgId: string, taskId: string): Promise<TaskVisibility | undefined>;
  readonly actors: ActorResolverPort;
  readonly modes: LearningModeReader;
  /** UX-4b review fix 1: the record is paused (`teamRecordIsPaused`): erasure, removals and expiry run, nothing new is captured, read or learned. */
  readonly paused: boolean;
  /** `/v1/app/projects/{project}/record/...` (the caller's project role already found by the broker). `undefined` for any other path. */
  routes(request: { method: string; path: string; query: Readonly<Record<string, string | undefined>>; caller: TeamRecordCallerInput; /** What a source write needs from the broker's request (`source-write.ts`); absent: reads only. */ write?: SourceWriteContext }): Promise<RecordRouteReply | undefined>;
  /** Start from inside Slack (task 12): the private "Add to project" prompt and its Add press, through the same source route as the web (`slack-add.ts`). The Slack reads it needs are handed in per call. */
  readonly slackAdd: SlackAddService;
  /** The record tools an agent step may be offered, and one call of them. */
  tools: {
    list(context: Pick<RecordToolContext, "memory">): ReadonlyArray<{ name: string; description: string; inputSchema: Record<string, unknown> }>;
    call(context: RecordToolContext, call: { tool: string; arguments: unknown }): ReturnType<typeof callRecordTool>;
    /** The task owner as a record caller, for a private task. */
    ownerAudience(task: Pick<DeveloperTaskRecord, "orgId" | "project">, developerId: string): Promise<NonNullable<RecordToolContext["ownerAudience"]>>;
  };
  /** The taps. Each never throws and records only what the source rows and the mode allow. */
  taps: {
    github: ReturnType<typeof createGithubRecordTap>;
    hook: ReturnType<typeof createHookRecordTap>;
    /** A Slack event the ingress verified and forwarded, with the channel facts it read with the bot token. */
    slack(forward: { payload: unknown; channel?: { teamId: string; channelId: string; info: SlackChannelInfo } }): ReturnType<ReturnType<typeof createSlackRecordTap>>;
    /** The queue consumer's Slack path: the same tap, writing directly, so a failure is thrown (and the message retried) and never swallowed. */
    slackStrict(forward: { payload: unknown; channel?: { teamId: string; channelId: string; info: SlackChannelInfo } }): Promise<void>;
  };
  /** Deletion and erase for the broker's existing erase paths. Each resolves when the step finished; it throws when it did not (the request is then repeated). */
  erase: {
    person(orgId: OrgId, developerId: string): Promise<void>;
    project(orgId: OrgId, project: string, cause: "project_archived" | "org_closed"): Promise<void>;
    workspace(orgId: OrgId): Promise<void>;
  };
  jobs: { run(job: "hourly" | "nightly"): Promise<TeamRecordJobSummary> };
  /** SRL-6: the company's erase and delete failures of the last 24 hours (counts and a time), for the admin Health data. Throws when the table cannot be read. */
  opsFailures(orgId: OrgId): Promise<OpsFailures>;
}

const DEFAULT_EMBEDDING_MODEL = "amazon.titan-embed-text-v2:0";
const ORG_PAGE = 50;
const MAX_ORGS_PER_RUN = 500;
/** One scheduled run's whole budget: inside the broker function's 30 s timeout with room for the answer. */
export const JOB_BUDGET_MS = 24_000;
const PER_ORG_MS = 8_000;
/** The most the dead-letter sweep may take of one hourly run, so the orgs keep most of the budget. */
const DLQ_SWEEP_MS = 6_000;
/**
 * TRW-5 S4 (fix round 1): a put that read the "open" answer just before an archive or a close can land up to the cache's minute afterwards. So an archive's or a close's erase is run a SECOND time once that
 * minute has passed (with margin), and only that second pass finishes the job (and writes the project's stamp). Until then the hourly job resumes the marker.
 */
const OPEN_CACHE_MS = 60_000;
const SETTLE_MS = 2 * OPEN_CACHE_MS;

const unavailable = (): Error => Object.assign(new Error("the team record could not finish this just now"), { name: "TeamRecordUnfinished" });

export function createTeamRecordRuntime(input: TeamRecordRuntimeInput): TeamRecordRuntime | undefined {
  const { env } = input;
  if (!teamRecordIsOn(env)) return undefined;
  const now = input.now ?? Date.now;
  const log: RecordLog = (event, fields) => input.log?.({ component: "team_record", event, ...fields });
  const tableName = env.TEAM_RECORD_TABLE_NAME;
  if (tableName === undefined || tableName === "") {
    // The switch is on but the install did not name the table: nothing is built, and the broker says so once.
    input.log?.({ component: "team_record", event: "team_record.misconfigured", level: "error", missing: "TEAM_RECORD_TABLE_NAME" });
    return undefined;
  }
  const table: TeamRecordTable = { documentClient: input.documentClient, tableName };
  const state = { documentClient: input.documentClient, tableName: input.stateTableName };
  const edition = readEdition(env);
  const paused = teamRecordIsPaused(env);
  // Paused: every project reads as Off, so the taps capture nothing and no lesson is made or loaded (erasure and removals do not read the mode).
  const modes: LearningModeReader = paused ? { effectiveMode: async () => "off" } : tableModeReader(table);
  const region = env.AWS_REGION;
  const sdkOptions = { region, ...(input.sdk === undefined ? {} : { load: input.sdk }) };

  // ---- vectors and the embedder (a workspace's index is opened through a session narrowed to that workspace)
  const modelId = env.TEAM_RECORD_EMBEDDING_MODEL_ID === undefined || env.TEAM_RECORD_EMBEDDING_MODEL_ID === "" ? DEFAULT_EMBEDDING_MODEL : env.TEAM_RECORD_EMBEDDING_MODEL_ID;
  const embedder = createEmbedder({ modelId, dimension: VECTOR_DIMENSION_DEFAULT, invoke: bedrockInvokeModelPort(sdkOptions) });
  const buckets = (env.TEAM_RECORD_VECTOR_BUCKETS ?? "").split(",").filter((name) => name !== "");
  const rolePart = env.TEAM_RECORD_VECTORS_ROLE_ARN;
  const account = env.AGENTX_ACCOUNT_ID;
  const vectorPorts = rolePart === undefined || rolePart === "" || buckets.length === 0 || region === undefined || account === undefined
    ? undefined
    : new WorkspaceVectorPorts({
        assume: createAssume({ sts: input.sts ?? createStsAssumePort(new STSClient(region === undefined ? {} : { region })), roleArn: rolePart, portFromCredentials: (credentials) => s3VectorsPortFromCredentials(sdkOptions, credentials) }),
        policyFor: (workspaceId, bucket) => ({
          region: region, account: account, bucket, workspaceId, partition: region.startsWith("cn-") ? "aws-cn" : region.startsWith("us-gov-") ? "aws-us-gov" : "aws",
          allowCreateIndex: edition === "public",
          ...(env.TEAM_RECORD_KMS_KEY_ARN === undefined || env.TEAM_RECORD_KMS_KEY_ARN === "" ? {} : { kmsKeyArn: env.TEAM_RECORD_KMS_KEY_ARN }),
        }),
        now,
      });
  const indexReady = new Set<OrgId>();
  /** The workspace's vector index, or undefined where vectors are not set up or cannot be opened (the row is then stored without a vector and found by keyword). */
  // A workspace whose index could not be opened is not tried again for a minute: without this every record write would repeat the bucket lookup, a new STS session and the failing call.
  const vectorsFailedUntil = new Map<OrgId, number>();
  async function indexFor(orgId: OrgId): Promise<S3VectorsIndex | undefined> {
    if (vectorPorts === undefined) return undefined;
    if ((vectorsFailedUntil.get(orgId) ?? 0) > now()) return undefined;
    try {
      const bucket = await ensureWorkspaceVectorBucket(table, orgId, buckets, chooseVectorBucketForNewWorkspace, now);
      const index = await openWorkspaceIndex({ ports: vectorPorts, workspaceId: orgId, bucket, dimension: VECTOR_DIMENSION_DEFAULT });
      // Public creates one index per workspace at run time; Enterprise's single index is made by the stack.
      if (edition === "public" && !indexReady.has(orgId)) { await index.ensureIndex(); indexReady.add(orgId); }
      return index;
    } catch {
      log("record.vectors_unavailable", {});
      vectorsFailedUntil.set(orgId, now() + 60_000);
      return undefined;
    }
  }

  // ---- the lake (Athena over S3 Tables), where the install has one
  const lakeOn = env.TEAM_RECORD_LAKE_ENABLED === "1" && env.TEAM_RECORD_TABLE_BUCKET !== undefined && env.TEAM_RECORD_ATHENA_WORKGROUP !== undefined;
  const tableBucket = env.TEAM_RECORD_TABLE_BUCKET ?? "";
  let lake: LakeClient | undefined;
  const lakeClient = (): LakeClient | undefined => {
    if (!lakeOn) return undefined;
    return lake ??= createLakeClient({ athena: athenaPort(sdkOptions), workGroup: env.TEAM_RECORD_ATHENA_WORKGROUP!, now });
  };
  const lakeQueue = tableLakeDeleteQueue(table, now);

  // ---- people: a GitHub account linked to a company member with a live project role is `member`; every other source identity is `outsider` until an identity link exists for it
  const orgStore = new OrgStore({ documentClient: input.documentClient, tableName: state.tableName, now });
  /** A person linked to a source identity, kept only while they belong to this org. Their standing in the project decides the trust; the link alone decides that the row is theirs to erase. */
  async function linkedActor(orgId: OrgId, project: string | undefined, developerId: string): Promise<{ developerId: string; trust: "member" | "outsider" }> {
    const standing = project === undefined ? "outsider" : await readStanding(state, orgId, developerId, project);
    return { developerId, trust: standing === "member" ? "member" : "outsider" };
  }
  const actors: ActorResolverPort = {
    async resolve({ workspaceId, project, system, sourceId, isBot }) {
      if (isBot === true) return { trust: "system" };
      const parsed = OrgIdSchema.safeParse(workspaceId);
      if (!parsed.success) return { trust: "outsider" };
      const orgId = parsed.data;
      // A GitHub (or other code host) account linked to a company member.
      if (system === "github" || system.startsWith("codehost:")) {
        const link = (await input.documentClient.send(new GetCommand({ TableName: state.tableName, Key: githubMemberKey(orgId, sourceId), ConsistentRead: true }))) as { Item?: { developerId?: unknown; orgId?: unknown } };
        const developerId = link.Item?.developerId;
        if (typeof developerId !== "string" || (link.Item?.orgId !== undefined && link.Item.orgId !== orgId)) return { trust: "outsider" };
        return linkedActor(orgId, project, developerId);
      }
      // A Slack user who signed in to Rovara with Slack, and belongs to this org.
      if (system.startsWith("slack:") && input.developerOfSlackUser !== undefined) {
        const developerId = await input.developerOfSlackUser(sourceId);
        if (developerId === undefined || (await orgStore.orgForDeveloper(developerId))?.orgId !== orgId) return { trust: "outsider" };
        return linkedActor(orgId, project, developerId);
      }
      // A Linear or Jira author the company linked (at connect or sign-in, or by an email the tracker reported as verified).
      if (isTrackerSystem(system)) {
        const developerId = await developerOfTrackerAuthor(table, orgId, { system, sourceId });
        // Checked again at use, as for Slack: a link outlives a person who has since left the org.
        if (developerId === undefined || (await orgStore.orgForDeveloper(developerId))?.orgId !== orgId) return { trust: "outsider" };
        return linkedActor(orgId, project, developerId);
      }
      return { trust: "outsider" };
    },
    async resolveDeveloper({ workspaceId, project, developerId }) {
      const parsed = OrgIdSchema.safeParse(workspaceId);
      if (!parsed.success || project === undefined) return { trust: "outsider" };
      return { trust: (await readStanding(state, parsed.data, developerId, project)) === "member" ? "member" : "outsider" };
    },
  };
  const skipped = unlinkedCounter(table, now);

  // ---- the router sink
  const sinks = new Map<OrgId, RecordSink>();
  const listed = new Set<OrgId>();
  /** The org joins the directory the scheduled jobs walk, before its first record write (so no row can exist for an org the jobs never reach). */
  async function listOrg(orgId: OrgId): Promise<void> {
    if (listed.has(orgId)) return;
    await table.documentClient.send(new PutCommand({ TableName: table.tableName, Item: { ...teamRecordOrgDirectoryKey(orgId), entityType: "TEAM_RECORD_ORG", orgId, at: new Date(now()).toISOString() } }));
    listed.add(orgId);
  }
  async function sinkFor(workspaceId: string): Promise<RecordSink> {
    // Refused before any bucket or index is looked up: a workspace is an org, nothing else.
    const orgId = OrgIdSchema.parse(workspaceId);
    const known = sinks.get(orgId);
    if (known !== undefined) return known;
    await listOrg(orgId);
    const vectors = await indexFor(orgId);
    const made = createRecordSink({
      table, modes, edition, rovaraDefaultRetention: defaultRetention(edition, "rovara"), embedder, now, log,
      ...(vectors === undefined ? {} : { vectors: vectors }),
    });
    // Only a sink that has its vectors is kept: one built without them (they could not be opened just now) is rebuilt on the next call.
    if (vectors !== undefined || vectorPorts === undefined) sinks.set(orgId, made);
    return made;
  }
  // TRW-5 S4: nothing is written for a company that is closing or closed, or into an archived project. A put that waited in the queue across a close or an archive is refused here when it is replayed;
  // the erase does not close scopes, and a row written after it would sit outside the directory the hourly text expiry walks. Live writes use a short cache (a minute); a replay reads fresh.
  const openCache = new Map<string, { until: number; reason: string | undefined }>();
  async function whyClosed(orgId: OrgId, project: string | undefined, fresh: boolean): Promise<string | undefined> {
    const key = `${orgId}/${project ?? ""}`;
    const hit = openCache.get(key);
    if (!fresh && hit !== undefined && hit.until > now()) return hit.reason;
    const org = ((await input.documentClient.send(new GetCommand({ TableName: state.tableName, Key: orgMetaKey(orgId), ConsistentRead: true }))) as { Item?: Record<string, unknown> }).Item;
    let reason: string | undefined = org !== undefined && (org.closingAt !== undefined || org.closedAt !== undefined) ? "company_closed" : undefined;
    if (reason === undefined && project !== undefined && (await readProjectMeta(state, orgId, project))?.status === "archived") reason = "project_archived";
    if (openCache.size > 1_000) openCache.clear();
    openCache.set(key, { until: now() + OPEN_CACHE_MS, reason });
    return reason;
  }
  const guardedPut = (fresh: boolean) => async (draft: Parameters<RecordSink["put"]>[0]) => {
    const orgId = OrgIdSchema.parse(draft.workspaceId);
    if (paused) { log("record.put_refused", { why: "paused" }); return { status: "refused", reason: "paused" } as never; }
    const reason = await whyClosed(orgId, draft.project, fresh);
    if (reason !== undefined) { log("record.put_refused", { why: reason }); return { status: "refused", reason } as never; }
    return (await sinkFor(draft.workspaceId)).put(draft);
  };
  const directSink: RecordSink = {
    put: guardedPut(false),
    tombstone: async (call) => (await sinkFor(call.workspaceId)).tombstone(call),
    changePrincipals: async (call) => (await sinkFor(call.workspaceId)).changePrincipals(call),
    replaceScopeAudience: async (call) => (await sinkFor(call.workspaceId)).replaceScopeAudience(call),
    ensureAccessSeed: async (call) => (await sinkFor(call.workspaceId)).ensureAccessSeed(call),
  };
  // The taps write through this one. A delete or an edit that fails against the table is not swallowed: it goes to the durable queue and the consumer applies it (retried, then dead-lettered).
  // A workspace that is not an org is refused BEFORE anything is tried or queued. A new version of an item may carry text, so it is queued only where the text may be kept: never a Slack message
  // (or a row made from one) in the Public edition, whose text must never be parked anywhere.
  const queue: OpsQueue | undefined = input.opsQueue;
  /** The durable path for a delete: the queue, then (TRW-5 S2) an ids-only Event invoke of the broker. Throws only when neither took it. */
  async function queueOrFallback(op: Parameters<OpsQueue["send"]>[0], removal: RemovalFallbackEvent | undefined, error: unknown): Promise<void> {
    if (queue !== undefined) { try { await queue.send(op); return; } catch { /* the Event invoke next */ } }
    if (removal === undefined || input.removalFallback === undefined) throw error;
    try { await input.removalFallback(removal); } catch { throw error; }
    log("record.removal_fallback", {});
  }
  const keepsText = (draft: { source: string; origin?: string | undefined }): boolean => !(edition === "public" && (draft.source === "slack" || draft.origin === "slack"));
  const durableSink: RecordSink = {
    async put(draft) {
      const orgId = OrgIdSchema.parse(draft.workspaceId);
      // TRW-4: a row is stored only when its author is a linked Rovara person, because only then can a person erase reach it. The skip is counted per project and source, for the maintainers.
      if (needsLinkedAuthor(draft)) {
        log("record.unlinked_skipped", { source: draft.source });
        await skipped.count(orgId, draft.project, draft.source).catch(() => log("record.unlinked_count_failed", {}));
        // S2: this change is not kept, but its words may be in the item's text: later edits by the author keep no whole text.
        if (draft.sourceRef.order !== undefined) await priorEdits.noteUnstored?.({ workspaceId: draft.workspaceId, source: draft.source as never, system: draft.sourceRef.system, id: draft.sourceRef.id }).catch(() => log("record.prior_edit_mark_failed", {}));
        // The org joins the scheduled jobs' directory now: the hourly job is what reads its connected tools' people and links them, so an org whose first changes were all refused must be reached by it.
        await listOrg(orgId).catch(() => log("record.list_org_failed", {}));
        return { status: "refused", reason: "author_not_linked" } as never;
      }
      try {
        const outcome = await directSink.put(draft);
        // An erased person's late change, or an excluded one, is refused too: same reason.
        if (outcome.status === "refused" && draft.sourceRef.order !== undefined && (outcome.reason === "actor_erased" || outcome.reason === "excluded")) await priorEdits.noteUnstored?.({ workspaceId: draft.workspaceId, source: draft.source as never, system: draft.sourceRef.system, id: draft.sourceRef.id }).catch(() => log("record.prior_edit_mark_failed", {}));
        return outcome;
      } catch (error) {
        if (queue === undefined || !keepsText(draft)) throw error;
        await queue.send({ v: 1, op: "put", draft, queuedAt: new Date(now()).toISOString() } as never);
        log("record.put_queued", {});
        return { status: "queued" } as never;
      }
    },
    async tombstone(call) {
      OrgIdSchema.parse(call.workspaceId);
      try { return await directSink.tombstone(call); } catch (error) {
        const removal: RemovalFallbackEvent = { source: TEAM_RECORD_REMOVAL_SOURCE, workspaceId: call.workspaceId, system: call.system, ...(call.sourceIds === undefined ? {} : { sourceIds: [...call.sourceIds] }), ...(call.scope === undefined ? {} : { scope: call.scope }), cause: call.cause };
        await queueOrFallback({ v: 1, op: "tombstone", workspaceId: call.workspaceId, system: call.system, ...(call.sourceIds === undefined ? {} : { sourceIds: [...call.sourceIds] }), ...(call.scope === undefined ? {} : { scope: call.scope }), cause: call.cause } as never, removal, error);
        log("record.tombstone_queued", {});
        return { hidden: 0 };
      }
    },
    async changePrincipals(call) {
      OrgIdSchema.parse(call.workspaceId);
      try { await directSink.changePrincipals(call); } catch (error) {
        if (queue === undefined) throw error;
        await queue.send({ v: 1, op: "principals", workspaceId: call.workspaceId, scope: call.scope, ...(call.add === undefined ? {} : { add: [...call.add] }), ...(call.remove === undefined ? {} : { remove: [...call.remove] }), at: call.at } as never);
        log("record.principals_queued", {});
      }
    },
    async replaceScopeAudience(call) {
      OrgIdSchema.parse(call.workspaceId);
      try { await directSink.replaceScopeAudience(call); } catch (error) {
        if (queue === undefined) throw error;
        await queue.send({ v: 1, op: "audience", workspaceId: call.workspaceId, scope: call.scope, audience: call.audience, at: call.at } as never);
        log("record.audience_queued", {});
      }
    },
    ensureAccessSeed: async (call) => directSink.ensureAccessSeed(call),
  };
  const sink = durableSink;

  const config = createSourceConfigPort({ table, edition });
  const mode = createCaptureModePort({ modes });
  const tapLog = (event: string, fields: Readonly<Record<string, string | number | boolean>>): void => log(event, fields);

  // ---- purge (delete worker, erase): per workspace, with that workspace's vectors
  // Lessons live in the same table. Their vectors do not exist yet (no lesson is made until the learning pipeline is connected), so removing one is a no-op; the learning lane replaces `lessonVectors`
  // with its vector store when it connects the pipeline (the lane report lists this).
  const lessonVectors: LessonVectors = { async upsert() {}, async query() { return []; }, async remove() {} };
  const lessons = lessonDeletionPort({ store: new DynamoLessonStore(table, now), vectors: lessonVectors, audit: { emit: async (event) => { log("record.lesson_event", { action: event.action }); } }, now });
  async function purgeFor(orgId: OrgId): Promise<PurgeDependencies> {
    const vectors = await indexFor(orgId);
    return {
      table, lakeQueue, now, log, lessons: lessons as never, ...(input.audit === undefined ? {} : { audit: input.audit }),
      ...(vectors === undefined ? {} : { vectors: vectors as unknown as RecordVectorPort }), projects: { projects: projectsOf },
      ...(input.askAliasKey === undefined ? {} : { askAliasKey: input.askAliasKey }),
    };
  }

  async function projectsOf(orgId: OrgId): Promise<string[]> {
    const names: string[] = [];
    let start: Record<string, unknown> | undefined;
    do {
      const page = (await input.documentClient.send(new QueryCommand({
        TableName: state.tableName, KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)", ExpressionAttributeValues: { ":pk": orgProjectCatalogPk(orgId), ":prefix": "PROJECT#" }, ConsistentRead: true,
        ...(start === undefined ? {} : { ExclusiveStartKey: start }),
      }))) as { Items?: Array<Record<string, unknown>>; LastEvaluatedKey?: Record<string, unknown> };
      for (const item of page.Items ?? []) if (typeof item.sk === "string") names.push(item.sk.slice("PROJECT#".length));
      start = page.LastEvaluatedKey;
    } while (start !== undefined && names.length < 5_000);
    return names;
  }

  // ---- the taps
  const transientDistiller = input.distillModel === undefined
    ? { distillTransient: async () => ({ accepted: false }) }
    : createTransientDistiller({
      ingest: { table, modes, edition, rovaraDefaultRetention: defaultRetention(edition, "rovara"), embedder, now, log },
      distill: { model: input.distillModel, now: () => new Date(now()).toISOString(), newId: () => `fact_${randomUUID().replace(/-/g, "")}` },
    });
  // Retention B writes facts (not rows) straight to the table, so it passes the SAME author gate a stored row passes (TRW-4): a note made from an unlinked author's words could not be erased with them.
  // Checked before the model is called. The skip is counted like any other. (Queued "distill" messages go through the same wrapper.)
  const distiller: typeof transientDistiller = {
    async distillTransient(draft) {
      if (needsLinkedAuthor(draft)) {
        const orgId = OrgIdSchema.safeParse(draft.workspaceId);
        log("record.unlinked_skipped", { source: draft.source });
        if (orgId.success) await skipped.count(orgId.data, draft.project, draft.source).catch(() => log("record.unlinked_count_failed", {}));
        return { accepted: false };
      }
      return transientDistiller.distillTransient(draft);
    },
  };

  const resolveRepo = async (repository: { installationId: number; repositoryId: number; fullName: string }): Promise<{ workspaceId: string; project?: string } | undefined> => {
    const orgId = await orgOfInstallation(state, repository.installationId);
    if (orgId === undefined) return undefined;
    const projects = await projectsOfRepository(state, orgId, repository.installationId, repository.repositoryId);
    // A repository held by no project of the org is not recorded. A repository shared by several projects names no project here: the source row for it (set by a maintainer) decides the project.
    if (projects.length === 0) return undefined;
    return projects.length === 1 ? { workspaceId: orgId, project: projects[0]! } : { workspaceId: orgId };
  };
  const rovaraPrs = {
    async byNumber({ workspaceId, host, repo, number }: { workspaceId: string; host: string; repo: string; number: number }) {
      if (host !== "github") return undefined;
      const linked = await findLinkedChangeRequest(state, { hostKind: "github", repositoryAddress: `https://github.com/${repo}`, id: String(number) });
      // The link must belong to THIS workspace: a pull request number is only unique inside a repository, and a repository belongs to one org's installation.
      if (linked === undefined || linked.workspaceId === undefined) return undefined;
      const task = ((await input.documentClient.send(new GetCommand({ TableName: state.tableName, Key: taskKey(linked.taskId), ConsistentRead: true }))) as { Item?: DeveloperTaskRecord }).Item;
      if (task === undefined || task.orgId !== workspaceId) return undefined;
      const entry = task.workflow?.pullRequests?.find((pullRequest) => pullRequest.number === number && pullRequest.url === linked.url);
      if (entry?.headSha === undefined) return undefined;
      return { taskId: task.taskId, project: task.project, number, url: linked.url, candidateHeadSha: entry.headSha };
    },
    // The merge commit of a Rovara pull request is not kept anywhere yet, so a revert named by commit cannot be matched to a task (see the lane report).
    async byMergeCommit() { return undefined; },
  };
  const priorEdits = priorEditsPort(table, now);
  // Per-editor rows: every change is its own row under the person who made it, and the sink counts a change whose person is not linked (`author_not_linked`).
  // A repository deleted or transferred also marks its source row `failing` (health only: no new revision, see `markSourceFailing`).
  const sourceHealth = {
    async markFailing({ workspaceId, source, scope }: { workspaceId: string; source: string; scope: string }): Promise<void> {
      const org = OrgIdSchema.safeParse(workspaceId);
      if (org.success && await markSourceFailing(table, org.data, source, scope) === "busy") log("record.health_busy", {});
    },
  };
  // SRL-6: a source delete that no durable path accepted is counted for the company's Health page (an id that is not an org id is not counted).
  const failures = { async tombstoneLost(workspaceId: string): Promise<void> { const org = OrgIdSchema.safeParse(workspaceId); if (org.success) await recordOpsFailure(table, org.data, "tombstone", now()); } };
  const github = createGithubRecordTap({ sink, actors, rovaraPrs, mode, config, resolveRepo, log: tapLog, now, priorEdits, sourceHealth, failures });
  // A comment names only its ticket: the ticket must already be recorded under the same place (Linear), and takes its restriction from how it was recorded (Jira). Read from the record, not from the tracker.
  const recorder = createTicketRecorder({ sink, actors, mode, config, log: tapLog, priorEdits, parents: createRecordParentLookup(table) });
  const hook = createHookRecordTap({ recorder });
  const emitter = createRovaraEmitter({ sink, actors, mode, config, log: tapLog, defaultRetention: defaultRetention(edition, "rovara") });

  // ---- the query API
  async function queryFor(orgId: OrgId): Promise<RecordQueryDependencies> {
    const vectors = await indexFor(orgId);
    const hot = tableHotStatsSource(table);
    const lakeNow = lakeClient();
    const stats: StatsDeps | undefined = lakeNow === undefined ? undefined : { lake: lakeNow, tableBucket, hot };
    return {
      table, modes, embedder, now, log,
      limiter: dynamoRateLimiter(table, now),
      skipped: { read: (org, project) => skipped.read(org, project) },
      ...(vectors === undefined ? {} : { vectorSearch: { query: (request) => (vectors as VectorIndex).query(request) } }),
      ...(stats === undefined ? {} : { stats: { run: async ({ template, workspaceId, project, params }) => (await runStats(stats, { workspaceId, project, audience: "project" } as never, template, params)).rows } }),
    };
  }

  /** The source write route's dependencies: this install's edition, the project's repositories read live from its latest revision, and the learning loop's paused sources. No company retention ceiling is stored anywhere yet, so none is read. */
  const sourceRoutes: SourceRouteDependencies = {
    edition,
    projectRepositories: async (orgId, project) => {
      const latest = await latestRevision(state, orgId, project);
      if (latest === undefined) return undefined;
      return latest.definition.repositories.flatMap((repository) => { const host = repositoryHostOf(repository); return host.kind === "github" && "repositoryId" in host && host.repositoryId !== undefined ? [host.repositoryId] : []; });
    },
    repositoryNames: async (orgId, project) => {
      const latest = await latestRevision(state, orgId, project);
      if (latest === undefined) return undefined;
      return latest.definition.repositories.flatMap((repository) => { const host = repositoryHostOf(repository); return host.kind === "github" && "repositoryId" in host && host.repositoryId !== undefined ? [{ id: host.repositoryId, name: repository.name }] : []; });
    },
    // Slack: the workspace must be the one the company bound (the binding the tap resolves); the channel itself is read live through the request's own context. Linear and Jira: the connected apps list the place.
    ...(input.slackUserIdsOf === undefined ? {} : { slackUserIdsOf: input.slackUserIdsOf }),
    // SRL-14: a web editor's refused Slack add takes the same time whether or not the channel exists.
    refusalFloor: { ms: SLACK_REFUSAL_FLOOR_MS, sleep: (ms) => new Promise<void>((resolve) => { setTimeout(resolve, ms); }) },
    slackTeamBound: async (orgId, teamId) => (await new OrgStore({ documentClient: input.documentClient, tableName: state.tableName, now }).orgForSlackTeam(teamId)) === orgId,
    ...(input.trackers === undefined ? {} : { trackerPlace: trackerPlaceCheck(input.trackers, { now }), trackerOptions: trackerPlaceOptions(input.trackers) }),
    pausedSources: async (orgId, project) => Object.keys((await new DynamoLessonStore(table, now).flags({ workspaceId: orgId, project })).pausedSources ?? {}),
  };

  const routes: TeamRecordRuntime["routes"] = async ({ method, path, query, caller, write }) => {
    if (paused && /^\/v1\/app\/projects\/[^/]+\/record\//u.test(path) && !allowedWhilePaused(method, path, write)) return PAUSED_REPLY;
    // The org is the caller's session's. The route handler never reads one from the path or the query.
    const orgId = OrgIdSchema.parse(caller.orgId);
    const identities = { identitiesOf: async (org: OrgId, developerId: string) => identitiesOf(org, developerId) };
    const built = await buildRecordCaller(identities, { orgId, developerId: caller.developerId, projectRole: caller.projectRole });
    // Review fix 6: an archived project's (or a closing company's) learning mode is not changed: it is as it was when it was archived.
    const modeWrite = method === "POST" ? /^\/v1\/app\/projects\/([^/]+)\/record\/learning-mode$/u.exec(path) : null;
    if (modeWrite !== null && caller.projectRole !== undefined) {
      let project: string | undefined;
      try { project = decodeURIComponent(modeWrite[1]!); } catch { project = undefined; }
      if (project !== undefined && (await whyClosed(orgId, project, true)) !== undefined) return { status: 409, body: { code: "PROJECT_ARCHIVED", message: "This project is archived, so how it learns can't be changed. Restore it first." } };
    }
    try {
      return await handleRecordRoute({ ...(await queryFor(orgId)), sources: sourceRoutes }, { method, path, query, caller: built, ...(write === undefined ? {} : { write }) });
    } catch (error) {
      // A project segment that is not valid percent-encoding is a project that does not exist.
      if (error instanceof URIError) return { status: 404, body: { code: "PROJECT_NOT_FOUND", message: "No such project." } };
      throw error;
    }
  };

  /** The identities a person has at each source: their linked GitHub account. Slack and tracker ids are not linked to a developer in the State table, so a restricted Slack or tracker row matches no one. */
  async function identitiesOf(orgId: OrgId, developerId: string): Promise<{ ids: Record<string, string[]>; groups: Record<string, string[]> }> {
    const item = ((await input.documentClient.send(new GetCommand({ TableName: state.tableName, Key: memberGithubKey(orgId, developerId), ConsistentRead: true }))) as { Item?: { githubUserId?: unknown } }).Item;
    const githubId = item?.githubUserId;
    return { ids: typeof githubId === "string" ? { github: [githubId] } : {}, groups: {} };
  }

  const tools: TeamRecordRuntime["tools"] = {
    list: (context) => (paused ? [] : recordToolsFor(context)),
    call: async (context, call) => paused ? { status: "FAILED" as const, text: "This tool is not available." } : callRecordTool(await queryFor(OrgIdSchema.parse(context.orgId)), context, call),
    async ownerAudience(task, developerId) {
      const orgId = OrgIdSchema.parse(task.orgId);
      const projectRole = await readProjectRole(state, orgId, developerId, task.project);
      return { kind: "caller", caller: await buildRecordCaller({ identitiesOf: async (org, developer) => identitiesOf(org, developer) }, { orgId, developerId, projectRole }) };
    },
  };

  // ---- erase. Every erase writes an "erase in progress" marker FIRST (in the org directory's partition, so it survives the erase of the org's own partition), then does ONE bounded pass inline. What does not
  // finish is finished by the hourly job, which resumes each marker a pass at a time until it is done; a company's marker then waits for the lake delete to run before the org leaves the directory.
  type EraseJob =
    | { kind: "workspace"; phase: "hot" | "lake"; projects: string[]; settleAt?: number; again?: string[] }
    | { kind: "project"; project: string; cause: "project_archived" | "org_closed"; settleAt?: number }
    | { kind: "person"; developerId: string; identities: Array<{ system: string; sourceId: string }>; projects: string[] };
  type StoredJob = EraseJob & { sk: string };
  const jobKey = (orgId: OrgId, job: EraseJob): { pk: string; sk: string } => ({ pk: TEAM_RECORD_ORG_DIRECTORY_PK, sk: `ERASE#${orgId}#${job.kind}#${job.kind === "workspace" ? "all" : job.kind === "project" ? job.project : job.developerId}` });
  async function putJob(orgId: OrgId, job: EraseJob): Promise<StoredJob> {
    await listOrg(orgId);
    const key = jobKey(orgId, job);
    // A job already recorded keeps its progress (its phase and remaining projects): the request that repeats does not start it over.
    const existing = (await table.documentClient.send(new GetCommand({ TableName: table.tableName, Key: key, ConsistentRead: true }))) as { Item?: Record<string, unknown> };
    if (existing.Item?.job !== undefined) return { ...(existing.Item.job as EraseJob), sk: key.sk };
    await table.documentClient.send(new PutCommand({ TableName: table.tableName, Item: { ...key, entityType: "TEAM_RECORD_ERASE_JOB", orgId, at: new Date(now()).toISOString(), job } }));
    return { ...job, sk: key.sk };
  }
  async function saveJob(orgId: OrgId, job: StoredJob): Promise<void> {
    const { sk, ...rest } = job;
    await table.documentClient.send(new PutCommand({ TableName: table.tableName, Item: { pk: TEAM_RECORD_ORG_DIRECTORY_PK, sk, entityType: "TEAM_RECORD_ERASE_JOB", orgId, at: new Date(now()).toISOString(), job: rest } }));
  }
  const dropJob = async (sk: string): Promise<void> => { await table.documentClient.send(new DeleteCommand({ TableName: table.tableName, Key: { pk: TEAM_RECORD_ORG_DIRECTORY_PK, sk } })); };
  async function jobsOf(orgId: OrgId): Promise<StoredJob[]> {
    const read = (await table.documentClient.send(new QueryCommand({
      TableName: table.tableName, KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)", ConsistentRead: true, Limit: 50,
      ExpressionAttributeValues: { ":pk": TEAM_RECORD_ORG_DIRECTORY_PK, ":prefix": `ERASE#${orgId}#` },
    }))) as { Items?: Array<{ sk?: unknown; job?: EraseJob }> };
    return (read.Items ?? []).flatMap((item) => (typeof item.sk === "string" && item.job !== undefined ? [{ ...item.job, sk: item.sk }] : []));
  }

  // TRW-5 S3: `ERASEDONE#<org>#project#<name>` in the directory partition (which an org's own erase does not empty) says which archive of a project was erased; the company's finish removes them.
  const stampKey = (orgId: OrgId, project: string): { pk: string; sk: string } => ({ pk: TEAM_RECORD_ORG_DIRECTORY_PK, sk: `ERASEDONE#${orgId}#project#${project}` });
  async function stampProjectErased(orgId: OrgId, project: string): Promise<void> {
    const archivedAt = (await readProjectMeta(state, orgId, project))?.archivedAt ?? "";
    await table.documentClient.send(new PutCommand({ TableName: table.tableName, Item: { ...stampKey(orgId, project), entityType: "TEAM_RECORD_ERASE_DONE", orgId, archivedAt: String(archivedAt), at: new Date(now()).toISOString() } }));
  }
  async function clearStamps(orgId: OrgId): Promise<void> {
    const read = (await table.documentClient.send(new QueryCommand({ TableName: table.tableName, KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)", ConsistentRead: true, ExpressionAttributeValues: { ":pk": TEAM_RECORD_ORG_DIRECTORY_PK, ":prefix": `ERASEDONE#${orgId}#` } }))) as { Items?: Array<{ sk?: unknown }> };
    for (const item of read.Items ?? []) if (typeof item.sk === "string") await dropJob(item.sk);
  }
  /** Archived projects whose erase never started or never finished (the marker write and the queue both failed at the archive, TRW-5 S3): started here, a few per run. */
  async function sweepArchivedProjects(orgId: OrgId, budgetMs: number): Promise<number> {
    const started = now();
    let begun = 0;
    const pending = new Set((await jobsOf(orgId)).flatMap((job) => (job.kind === "project" ? [job.project] : [])));
    for (const project of (await projectsOf(orgId)).slice(0, 200)) {
      if (begun >= 10 || now() - started > budgetMs) break;
      const meta = await readProjectMeta(state, orgId, project);
      if (meta?.status !== "archived" || pending.has(project)) continue;
      const stamp = ((await table.documentClient.send(new GetCommand({ TableName: table.tableName, Key: stampKey(orgId, project), ConsistentRead: true }))) as { Item?: { archivedAt?: unknown } }).Item;
      if (stamp !== undefined && stamp.archivedAt === String(meta.archivedAt ?? "")) continue;
      // The erase gets what is left of this sweep's share, never its full default: a slow one must not carry the hourly run past its timeout.
      await eraseProjectNow(orgId, project, "project_archived", Math.max(1_000, Math.min(INLINE_ERASE.maxMs ?? 8_000, budgetMs - (now() - started))));
      begun += 1;
    }
    return begun;
  }

  /** One bounded step of a job. `true` when the job is finished (its marker is gone). Never runs past `budget`. */
  async function advance(orgId: OrgId, job: StoredJob, budget: EraseBudget, lakeMs: number): Promise<boolean> {
    const deps = await purgeFor(orgId);
    if (job.kind === "workspace") {
      if (job.phase === "hot") {
        // Settling: the first pass finished; the second waits until a put that read the cache before the close can no longer land (TRW-5 S4).
        if (job.settleAt !== undefined && now() < job.settleAt) return false;
        const second = job.settleAt !== undefined;
        const result = await eraseWorkspace(deps, orgId, second ? (job.again ?? await projectsOf(orgId)) : job.projects, `org_closed:${orgId}`, budget);
        if (!(result.complete && result.remainingProjects.length === 0)) { await saveJob(orgId, second ? { ...job, again: result.remainingProjects } : { ...job, projects: result.remainingProjects }); return false; }
        // The second pass looks at every project the company has, not only those the first one still had left.
        if (!second) { await saveJob(orgId, { ...job, projects: [], again: await projectsOf(orgId), settleAt: now() + SETTLE_MS }); return false; }
        job = { kind: "workspace", sk: job.sk, phase: "lake", projects: [] };
        await saveJob(orgId, job);
      }
      // The lake: the whole-workspace delete queued by the erase is run here, and the org stays in the directory until nothing is left in the queue. Without a lake there is nothing to wait for.
      const lakeNow = lakeClient();
      if (lakeNow !== undefined) {
        await runLakeDeletes({ queue: lakeQueue, lake: lakeNow, tableBucket }, { workspaceId: orgId, budget: { maxStatements: 5, maxMs: Math.max(1_000, lakeMs) } });
        if ((await lakeQueue.listPending(orgId, 1)).length > 0) return false;
      }
      await dropJob(job.sk);
      await clearStamps(orgId);
      if ((await jobsOf(orgId)).length === 0) {
        await table.documentClient.send(new DeleteCommand({ TableName: table.tableName, Key: teamRecordOrgDirectoryKey(orgId) }));
        listed.delete(orgId);
        sinks.delete(orgId);
      }
      return true;
    }
    // A project's erase also settles first (TRW-5 S4): done once, then done again after the cache's minute, and only then finished.
    if (job.kind === "project" && job.settleAt !== undefined && now() < job.settleAt) return false;
    const names = job.kind === "person" ? await personNames(job.developerId) : [];
    let complete = job.kind === "project"
      ? (await eraseProject(deps, orgId, job.project, job.cause, `${job.cause}:${job.project}`, budget)).complete
      : (await erasePerson(deps, orgId, { developerId: job.developerId, projects: job.projects, ...(job.identities.length === 0 ? {} : { identities: job.identities }), ...(names.length === 0 ? {} : { names }) }, `erase:${job.developerId}`, budget)).complete;
    if (complete && job.kind === "project" && job.settleAt === undefined) { await saveJob(orgId, { ...job, settleAt: now() + SETTLE_MS }); complete = false; }
    if (complete) {
      // TRW-4: the person's links go with their rows. Only when the whole erase finished, so a pass that did not finish still knows which author ids to look for.
      if (job.kind === "person" && !(await removeTrackerLinks(table, orgId, job.developerId))) return false;
      // TRW-5 S3: a finished project erase leaves a stamp naming the archive it answered, so the hourly sweep knows which archived projects were never erased.
      if (job.kind === "project" && job.cause === "project_archived") await stampProjectErased(orgId, job.project);
      await dropJob(job.sk);
    }
    return complete;
  }
  /** The names the person is known by, for the Ask scrub (LI-2): read now, bounded, never kept in the job. A read that fails gives none (the erase is never held up for it). */
  async function personNames(developerId: string): Promise<string[]> {
    if (input.namesOf === undefined) return [];
    try {
      return [...new Set((await input.namesOf(developerId)).map((name) => name.trim()).filter((name) => name !== "" && name.length <= 200))].slice(0, 10);
    } catch {
      log("record.erase_names_unreadable", {});
      return [];
    }
  }
  /** The source identities a person has: their linked GitHub account, and each Slack user id they signed in with in every Slack team bound to the org (a Slack row is indexed under `slack:<team>`). */
  async function personIdentities(orgId: OrgId, developerId: string): Promise<Array<{ system: string; sourceId: string }>> {
    const github = ((await input.documentClient.send(new GetCommand({ TableName: state.tableName, Key: memberGithubKey(orgId, developerId), ConsistentRead: true }))) as { Item?: { githubUserId?: unknown } }).Item?.githubUserId;
    const identities: Array<{ system: string; sourceId: string }> = typeof github === "string" ? [{ system: "github", sourceId: github }] : [];
    const slackIds = input.slackUserIdsOf === undefined ? [] : await input.slackUserIdsOf(developerId);
    if (slackIds.length > 0) {
      const teams = (await input.documentClient.send(new QueryCommand({
        TableName: state.tableName, KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)", ConsistentRead: true, Limit: 25,
        ExpressionAttributeValues: { ":pk": orgPk(orgId), ":prefix": "SLACK_TEAM#" },
      }))) as { Items?: Array<{ sk?: unknown }> };
      for (const team of teams.Items ?? []) {
        const teamId = typeof team.sk === "string" ? team.sk.slice("SLACK_TEAM#".length) : "";
        if (/^[TE][A-Z0-9]{2,31}$/.test(teamId)) for (const slackId of slackIds) identities.push({ system: `slack:${teamId}`, sourceId: slackId });
      }
    }
    // Their Linear and Jira author ids (TRW-4): linked at connect or sign-in, or by a verified email.
    for (const link of await trackerLinksOf(table, orgId, developerId)) identities.push(link);
    return identities.slice(0, 50);
  }
  const INLINE_ERASE: EraseBudget = { maxItems: 500, maxMs: 8_000 };
  /** The queue consumer's own start of a project erase: the same marker and bounded pass, but a marker that cannot be written THROWS (the message is retried), it is never handed back to the queue. */
  async function eraseProjectNow(orgId: OrgId, project: string, cause: "project_archived" | "org_closed", maxMs: number = INLINE_ERASE.maxMs ?? 8_000): Promise<void> {
    await advance(orgId, await putJob(orgId, { kind: "project", project, cause }), { ...INLINE_ERASE, maxMs }, Math.min(2_000, maxMs));
  }
  const erase: TeamRecordRuntime["erase"] = {
    async person(orgId, developerId) {
      const parsed = OrgIdSchema.parse(orgId);
      const identities = await personIdentities(parsed, developerId);
      const job = await putJob(parsed, { kind: "person", developerId, identities, projects: await projectsOf(parsed) });
      // The request that asked is told to repeat while the erase is unfinished (the audit erase answers "send the same request again"); the hourly job also carries it on.
      if (!(await advance(parsed, job, INLINE_ERASE, 2_000))) throw unavailable();
    },
    async project(orgId, project, cause) {
      const parsed = OrgIdSchema.parse(orgId);
      let job: StoredJob;
      try { job = await putJob(parsed, { kind: "project", project, cause }); } catch (error) {
        // The marker is what the hourly job resumes, and it could not be written. Hand the erase to the durable queue (ids only): its consumer repeats this until the marker is written, then dead-letters
        // it for a person. With no queue the failure is thrown to the archive, which logs it.
        if (queue === undefined) throw error;
        await queue.send({ v: 1, op: "erase_project", workspaceId: parsed, project, cause });
        log("record.erase_queued", { kind: "project" });
        return;
      }
      await advance(parsed, job, INLINE_ERASE, 2_000);
    },
    async workspace(orgId) {
      const parsed = OrgIdSchema.parse(orgId);
      const job = await putJob(parsed, { kind: "workspace", phase: "hot", projects: await projectsOf(parsed) });
      await advance(parsed, job, INLINE_ERASE, 2_000);
    },
  };

  /** The jobs of an org the hourly run resumes. A company job only runs while the company is closing or closed; a project job only while the project is archived; otherwise the marker is stale (the close or archive did not happen) and is dropped. */
  async function resumeErases(orgId: OrgId, budgetMs: number): Promise<number> {
    let finished = 0;
    for (const job of await jobsOf(orgId)) {
      if (job.kind === "workspace" && await companyIsOpen(state, orgId)) { await dropJob(job.sk); continue; }
      if (job.kind === "project" && (await readProjectMeta(state, orgId, job.project))?.status !== "archived") { await dropJob(job.sk); continue; }
      if (await advance(orgId, job, { maxItems: 2_000, maxMs: Math.max(1_000, budgetMs / 2) }, budgetMs / 4)) finished += 1;
    }
    return finished;
  }

  // ---- the scheduled jobs: bounded in orgs, in time and (inside each module) in items
  async function eachOrg(work: (orgId: OrgId, budgetMs: number) => Promise<Record<string, number>>, totalMs: number = JOB_BUDGET_MS): Promise<TeamRecordJobSummary> {
    const started = now();
    const summary: TeamRecordJobSummary = { orgs: 0, skippedOrgs: 0, details: {} };
    let after: Record<string, unknown> | undefined;
    for (;;) {
      const read = (await table.documentClient.send(new QueryCommand({
        TableName: table.tableName, KeyConditionExpression: "pk = :pk", ExpressionAttributeValues: { ":pk": TEAM_RECORD_ORG_DIRECTORY_PK }, ConsistentRead: true, Limit: ORG_PAGE,
        ...(after === undefined ? {} : { ExclusiveStartKey: after }),
      }))) as { Items?: Array<{ sk?: unknown }>; LastEvaluatedKey?: Record<string, unknown> };
      const page = (read.Items ?? []).flatMap((item) => { const parsed = OrgIdSchema.safeParse(item.sk); return parsed.success ? [parsed.data] : []; });
      for (const orgId of page) {
        const left = totalMs - (now() - started);
        if (left < 1_000 || summary.orgs >= MAX_ORGS_PER_RUN) { summary.skippedOrgs += 1; continue; }
        try {
          for (const [key, value] of Object.entries(await work(orgId, Math.min(PER_ORG_MS, left)))) summary.details[key] = (summary.details[key] ?? 0) + value;
        } catch {
          // One org's failure never stops the others; a fixed line, no text.
          summary.details.orgFailures = (summary.details.orgFailures ?? 0) + 1;
          log("record.job_org_failed", {});
        }
        summary.orgs += 1;
      }
      if (read.LastEvaluatedKey === undefined) return summary;
      after = read.LastEvaluatedKey;
    }
  }

  /** Deletes the PUT (and distill) messages in the dead-letter queue: they hold a draft's text, which must not outlive retention or an erase for 14 days. Messages without text are left. Bounded. */
  async function sweepDeadLetterText(budgetMs: number): Promise<number> {
    const port = input.deadLetters;
    if (port === undefined) return 0;
    const started = now();
    let deleted = 0;
    try {
      for (let round = 0; round < 20 && now() - started < budgetMs; round += 1) {
        const batch = await port.receive(10);
        if (batch.length === 0) break;
        for (const message of batch) {
          let op: unknown;
          try { op = (JSON.parse(message.body) as { op?: unknown }).op; } catch { op = undefined; }
          if (op === "put" || op === "distill") { await port.remove(message.handle); deleted += 1; }
        }
      }
    } catch {
      log("record.dlq_sweep_failed", {});
    }
    if (deleted > 0) log("record.dlq_text_deleted", { count: deleted });
    return deleted;
  }

  /** Filled in below, where the tracker pieces are built (they need the links, which are defined after the jobs). */
  const trackerSync: { run: (orgId: OrgId, budgetMs: number) => Promise<number> } = { run: async () => 0 };
  const jobs: TeamRecordRuntime["jobs"] = {
    async run(job) {
      if (job === "hourly") {
        // TRW-5 S1: text that reached the dead-letter queue anyway is deleted from it, first, so an org's slow work cannot starve it.
        // The whole run shares ONE budget (the broker's timeout is 30 s): what the dead-letter sweep takes, the orgs do not get.
        const startedAt = now();
        const swept = await sweepDeadLetterText(DLQ_SWEEP_MS);
        const summary = await eachOrg(async (orgId, budgetMs) => {
          const deleteBudget: DeleteBudget = { maxRequests: 50, maxItems: 5_000, maxMs: budgetMs };
          const done = await runDeleteWorker(await purgeFor(orgId), orgId, deleteBudget);
          const lakeNow = lakeClient();
          const lakeDeletes = lakeNow === undefined ? undefined : await runLakeDeletes({ queue: lakeQueue, lake: lakeNow, tableBucket }, { workspaceId: orgId, budget: { maxStatements: 5, maxMs: Math.max(1_000, budgetMs / 2) } });
          // Erases that did not finish where they were asked for (a person, a project, a whole company): one bounded step each, then the company's lake delete is waited for.
          const erased = await resumeErases(orgId, budgetMs);
          // TRW-5 S3: archived projects whose erase was never recorded or finished.
          const projectsSwept = await sweepArchivedProjects(orgId, Math.max(1_000, budgetMs / 4));
          // Lane team-record-links: the org's connected Linear and Jira users, read again once a day.
          const trackersSynced = await trackerSync.run(orgId, Math.max(1_000, budgetMs / 4)).catch(() => 0);
          return { requests: done.requests, finished: done.finished, stillHidden: done.stillHidden, sweepFailed: done.sweepFailed, lakeStatements: lakeDeletes?.statements ?? 0, erasesFinished: erased, projectsSwept, trackersSynced };
        }, JOB_BUDGET_MS - (now() - startedAt));
        summary.details.deadLetterTextDeleted = swept;
        return summary;
      }
      return eachOrg(async (orgId, budgetMs) => {
        const vectors = await indexFor(orgId);
        const expired = await expireRawText({ table, now, log, ...(vectors === undefined ? {} : { vectors: vectors }) }, orgId, { maxItems: 2_000, maxMs: budgetMs });
        const lakeNow = lakeClient();
        if (lakeNow === undefined || vectors === undefined) return { expired: Object.values(expired).filter((value): value is number => typeof value === "number").reduce((total, value) => total + value, 0) };
        const archived = await runArchive({
          source: tableHotArchiveSource(table, { projects: projectsOf }, lakeQueue, now), lake: lakeNow, tableBucket, vectors, lakeDeletes: lakeQueue, edition,
        }, { workspaceId: orgId, budget: { maxRows: 500, maxMs: Math.max(1_000, budgetMs / 2) } });
        return { expired: Object.values(expired).filter((value): value is number => typeof value === "number").reduce((total, value) => total + value, 0), archived: archived.archived };
      });
    },
  };

  const slackDirectory = (forward: { teamId: string; channelId: string; info: SlackChannelInfo } | undefined): SlackDirectoryPort => ({
    // Only the channel the ingress read facts for is known; any other channel is unknown, and unknown is not recorded.
    async channelInfo(teamId, channelId) { return forward !== undefined && forward.teamId === teamId && forward.channelId === channelId ? forward.info : undefined; },
  });
  const slackTapOver = (over: RecordSink) => async (forward: Parameters<TeamRecordRuntime["taps"]["slack"]>[0]) => {
    const tap = createSlackRecordTap({
      edition, sink: over, distiller, actors, mode, config, directory: slackDirectory(forward.channel), log: tapLog,
      notesOptIn: NOTES_OPT_IN_FROM_SOURCE_ROW,
      // The org this Slack team is bound to; an unbound team is not recorded.
      resolveWorkspace: async (teamId) => {
        try { return { workspaceId: await resolveSlackOrg(new OrgStore({ documentClient: input.documentClient, tableName: state.tableName, now }), teamId) }; }
        // Only "this Slack team is not bound" means unbound. A failure to READ the binding is a failure: it is thrown, so a removal is retried rather than dropped as an unknown team.
        catch (error) { if ((error as { code?: unknown } | null)?.code === "SLACK_TEAM_NOT_BOUND") return undefined; throw error; }
      },
    });
    return tap(forward.payload);
  };
  const slack = slackTapOver(durableSink);
  const strictSlack = slackTapOver(directSink);
  /** The consumer's Slack path: the tap swallows its errors into `ignored("failed")`; here that is thrown, so the message is retried. */
  const slackStrict: TeamRecordRuntime["taps"]["slackStrict"] = async (forward) => {
    const outcome = await strictSlack(forward);
    if (outcome.outcome === "ignored" && outcome.reason === "failed") throw new Error("slack record failed");
  };

  // ---- the durable queue's consumer. A message the queue's own consumer cannot apply throws and is retried by SQS (then dead-lettered); a Slack removal goes through the strict tap.
  // A replayed put reads the company's and the project's state fresh (TRW-5 S4).
  const consumer = createOpConsumer({ sink: { ...directSink, put: guardedPut(true) }, distiller, log: tapLog, now });
  /** The most one drain may spend (the broker's timeout is 30 s) when the caller gives no clock of its own. */
  const DRAIN_MS = 24_000;
  /** Time kept back for the answer: a batch the function times out in raises every message's receive count without any code having run (TRW-5 S1). */
  const DRAIN_RESERVE_MS = 5_000;
  const drain: TeamRecordRuntime["drain"] = async (records, options) => {
    const failures: Array<{ itemIdentifier: string }> = [];
    const started = now();
    const remaining = options?.remainingMs ?? (() => DRAIN_MS - (now() - started));
    for (const [index, record] of records.entries()) {
      if (remaining() < DRAIN_RESERVE_MS) {
        // Out of time: what is left is answered as "retry" without being touched, so the invocation ends cleanly instead of timing out.
        for (const left of records.slice(index)) failures.push({ itemIdentifier: left.messageId });
        log("record.drain_out_of_time", { left: records.length - index });
        break;
      }
      let parsed: { v?: unknown; op?: unknown; payload?: unknown } | undefined;
      try { parsed = JSON.parse(record.body) as typeof parsed; } catch { parsed = undefined; }
      if (parsed?.v === 1 && parsed.op === "slack_removal") {
        try { await slackStrict({ payload: parsed.payload }); } catch { log("record.op_failed", { op: "slack_removal", receiveCount: record.receiveCount }); failures.push({ itemIdentifier: record.messageId }); }
      } else if (parsed?.v === 1 && parsed.op === "erase_project") {
        // The org comes from the broker's own message and is parsed; a project that is not archived any more (restored, or never archived) is stale and dropped, like a stale marker.
        const message = parsed as { workspaceId?: unknown; project?: unknown; cause?: unknown };
        const orgId = OrgIdSchema.safeParse(message.workspaceId);
        if (!orgId.success || typeof message.project !== "string" || (message.cause !== "project_archived" && message.cause !== "org_closed")) { log("record.op_invalid", {}); continue; }
        try {
          if ((await readProjectMeta(state, orgId.data, message.project))?.status === "archived") await eraseProjectNow(orgId.data, message.project, message.cause, Math.min(INLINE_ERASE.maxMs ?? 8_000, Math.max(1_000, remaining() - DRAIN_RESERVE_MS)));
        } catch { log("record.op_failed", { op: "erase_project", receiveCount: record.receiveCount }); failures.push({ itemIdentifier: record.messageId }); }
      } else {
        failures.push(...(await consumer.processBatch([record])).batchItemFailures);
      }
    }
    return { batchItemFailures: failures };
  };

  /** A delete the broker sent to itself. Written straight to the table: a failure is thrown so Lambda's retries (and then the failure destination) take over. */
  const removal: TeamRecordRuntime["removal"] = async (event) => {
    await directSink.tombstone({ workspaceId: event.workspaceId, system: event.system, ...(event.sourceIds === undefined ? {} : { sourceIds: event.sourceIds }), ...(event.scope === undefined ? {} : { scope: event.scope }), cause: event.cause });
  };
  const orgOfDeveloper = async (developerId: string): Promise<OrgId | undefined> => (await orgStore.orgForDeveloper(developerId))?.orgId;
  const links: TeamRecordRuntime["links"] = {
    link: (orgId, link) => linkTrackerIdentity(table, OrgIdSchema.parse(orgId), { ...link, at: new Date(now()).toISOString() }, { orgOfDeveloper }),
    linkByVerifiedEmail: (orgId, link) => linkTrackerByVerifiedEmail(table, { developerForVerifiedEmail: (email) => orgStore.developerForVerifiedEmail(email), orgOfDeveloper }, OrgIdSchema.parse(orgId), { ...link, at: new Date(now()).toISOString() }),
  };

  // ---- tracker people: the automatic link through the connected app's user list, and the admin's mapping of the rest
  const membership = { orgOfDeveloper: orgOfDeveloper };
  const linkVerified = (orgId: OrgId, link: Parameters<TeamRecordRuntime["links"]["linkByVerifiedEmail"]>[1] & { displayName?: string; via?: "auto"; why?: string }) =>
    linkTrackerByVerifiedEmail(table, { developerForVerifiedEmail: (email) => orgStore.developerForVerifiedEmail(email).catch(() => undefined), orgOfDeveloper }, orgId, { ...link, at: new Date(now()).toISOString() });
  async function syncOne(orgId: OrgId, connectionId: string, maxMs: number): Promise<SyncResult | undefined> {
    const tracker = await input.trackers?.get(orgId, connectionId);
    if (tracker === undefined) return undefined;
    await listOrg(orgId);
    return syncTrackerUsers({ table, now, log, linkByVerifiedEmail: linkVerified, autoLink: { enabled: (org) => autoLinkEnabled(table, org), domains: input.verifiedDomains ?? { domainsOf: async () => undefined } } }, orgId, tracker, { maxMs });
  }
  // S3: a request id is single use and bound to the exact change it first named. The same id with the same change answers what it answered (nothing is done twice, nothing is audited twice); the same id with another
  // change is refused. Written after the change; a crash before it only means the next try does the work again (and its audit event, bound to the same change, is the same event).
  const requestKey = (orgId: OrgId, requestId: string): { pk: string; sk: string } => ({ pk: teamRecordPk(orgId), sk: `TRREQ#${createHash("sha256").update(requestId).digest("hex")}` });
  const changeDigest = (change: string): string => createHash("sha256").update(change).digest("hex");
  async function requestOutcome(orgId: OrgId, requestId: string, change: string): Promise<string | undefined> {
    const item = ((await table.documentClient.send(new GetCommand({ TableName: table.tableName, Key: requestKey(orgId, requestId), ConsistentRead: true }))) as { Item?: { digest?: unknown; outcome?: unknown } }).Item;
    if (item === undefined) return undefined;
    return item.digest === changeDigest(change) && typeof item.outcome === "string" ? item.outcome : "reused";
  }
  async function rememberRequest(orgId: OrgId, requestId: string, change: string, outcome: string): Promise<void> {
    await table.documentClient.send(new PutCommand({ TableName: table.tableName, Item: { ...requestKey(orgId, requestId), entityType: "TEAM_RECORD_TRACKER_REQUEST", orgId, digest: changeDigest(change), outcome, at: new Date(now()).toISOString(), indexExpiresAt: Math.floor(now() / 1000) + 90 * 86_400 } })).catch(() => log("record.request_not_remembered", {}));
  }
  const trackerPeople: TeamRecordRuntime["trackerPeople"] = {
    async list(orgId) {
      const parsed = OrgIdSchema.parse(orgId);
      const [unmatched, linked, enabled, domains] = await Promise.all([listUnmatchedTrackerUsers(table, parsed), listLinkedTrackerUsers(table, parsed), autoLinkEnabled(table, parsed), (input.verifiedDomains?.domainsOf(parsed) ?? Promise.resolve(undefined)).catch(() => undefined)]);
      return { unmatched: unmatched.users, linked: linked.users, truncated: unmatched.truncated || linked.truncated, autoLink: { enabled, verifiedDomainsRecorded: domains !== undefined && domains.size > 0 } };
    },
    async setAutoLink(orgId, call) {
      const parsed = OrgIdSchema.parse(orgId);
      const change = `autolink|${call.enabled ? "on" : "off"}`;
      const earlier = await requestOutcome(parsed, call.requestId, change);
      if (earlier !== undefined) return earlier === "reused" ? "request_reused" : "set";
      if (input.audit === undefined) return "audit_unavailable";
      try { await input.audit(auditRecordTrackerAutolinkChanged({ orgId: parsed, actor: { kind: "member", id: call.by }, occurredAt: new Date(now()).toISOString(), occurrence: auditOccurrence(call.requestId, change), enabled: call.enabled })); } catch { return "audit_unavailable"; }
      await setAutoLinkEnabled(table, parsed, { enabled: call.enabled, by: call.by, at: new Date(now()).toISOString() });
      // Turning it on: the org's tools are read again at the next run, so people are judged under the new setting. Turning it off changes nothing already linked.
      if (call.enabled && input.trackers !== undefined) { await listOrg(parsed); for (const tracker of await input.trackers.list(parsed)) await markSyncDue(table, parsed, tracker.connectionId, now()); }
      await rememberRequest(parsed, call.requestId, change, "set");
      return "set";
    },
    async map(orgId, call) {
      const parsed = OrgIdSchema.parse(orgId);
      const change = `map|${call.system}|${call.sourceId}|${call.developerId}`;
      const earlier = await requestOutcome(parsed, call.requestId, change);
      if (earlier !== undefined) return earlier === "reused" ? "request_reused" : (earlier as "mapped");
      const listed = ((await table.documentClient.send(new GetCommand({ TableName: table.tableName, Key: { pk: teamRecordPk(parsed), sk: `${UNMATCHED_PREFIX}${call.system}#${call.sourceId}` }, ConsistentRead: true }))) as { Item?: unknown }).Item;
      if (listed === undefined || !isTrackerSystem(call.system)) return "not_found";
      if ((await orgOfDeveloper(call.developerId)) !== parsed) return "not_member";
      // The audit event first: a mapping the ledger could not record is not made. Its id is bound to the EXACT change (a request id alone could be reused for another mapping and the ledger would drop the second event).
      if (input.audit === undefined) return "audit_unavailable";
      try { await input.audit(auditRecordTrackerPersonMapped({ orgId: parsed, actor: { kind: "member", id: call.by }, occurredAt: new Date(now()).toISOString(), occurrence: auditOccurrence(call.requestId, call.system, call.sourceId, call.developerId), memberId: call.developerId, source: call.system.startsWith("jira") ? "jira" : "linear" })); } catch { return "audit_unavailable"; }
      if (!(await mapTrackerUser(table, parsed, { system: call.system, sourceId: call.sourceId, developerId: call.developerId, at: new Date(now()).toISOString() }, membership))) return "not_member";
      await rememberRequest(parsed, call.requestId, change, "mapped");
      return "mapped";
    },
    async unmap(orgId, call) {
      const parsed = OrgIdSchema.parse(orgId);
      const change = `unmap|${call.system}|${call.sourceId}`;
      const earlier = await requestOutcome(parsed, call.requestId, change);
      if (earlier !== undefined) return earlier === "reused" ? "request_reused" : (earlier as "unmapped");
      if (!isTrackerSystem(call.system)) return "not_found";
      const linkedTo = await developerOfTrackerAuthor(table, parsed, call);
      if (linkedTo === undefined) return "not_found";
      if (input.audit === undefined) return "audit_unavailable";
      try { await input.audit(auditRecordTrackerPersonUnmapped({ orgId: parsed, actor: { kind: "member", id: call.by }, occurredAt: new Date(now()).toISOString(), occurrence: auditOccurrence(call.requestId, call.system, call.sourceId, linkedTo), memberId: linkedTo, source: call.system.startsWith("jira") ? "jira" : "linear" })); } catch { return "audit_unavailable"; }
      if ((await unmapTrackerUser(table, parsed, call, new Date(now()).toISOString())) === undefined) return "not_found";
      await rememberRequest(parsed, call.requestId, change, "unmapped");
      return "unmapped";
    },
    async requestSync(orgId, connectionId) {
      const parsed = OrgIdSchema.parse(orgId);
      if (await input.trackers?.get(parsed, connectionId) === undefined) return false;
      await listOrg(parsed);
      await markSyncDue(table, parsed, connectionId, now());
      return true;
    },
    syncConnection: (orgId, connectionId, options) => syncOne(OrgIdSchema.parse(orgId), connectionId, Math.min(options?.maxMs ?? 5_000, 8_000)),
  };
  /** The hourly job's share: the org's connected trackers that are due (a day since the last full read, or a read that did not finish), a few per run. */
  async function syncDueTrackers(orgId: OrgId, budgetMs: number): Promise<number> {
    if (input.trackers === undefined) return 0;
    const started = now();
    let synced = 0;
    for (const tracker of (await input.trackers.list(orgId)).slice(0, 5)) {
      const left = budgetMs - (now() - started);
      if (left < 1_000 || synced >= 3) break;
      if (!await syncIsDue(table, orgId, tracker.connectionId, now())) continue;
      await syncOne(orgId, tracker.connectionId, Math.min(left, 4_000));
      synced += 1;
    }
    return synced;
  }
  trackerSync.run = syncDueTrackers;
  // Start from inside Slack (task 12): the company a Slack team is bound to, the person a Slack user is linked to, and the record's own source route.
  const slackAdd = createSlackAdd({
    edition, table, state, now, projectsOf, limiter: dynamoRateLimiter(table, now), route: routes,
    orgOfSlackTeam: (teamId) => new OrgStore({ documentClient: input.documentClient, tableName: state.tableName, now }).orgForSlackTeam(teamId),
    developerOfSlackUser: async (slackUserId) => (input.developerOfSlackUser === undefined ? undefined : await input.developerOfSlackUser(slackUserId)),
  });
  return { edition, table, sink, drain, removal, links, trackerPeople, emitter, slackAdd, taskVisibility: (orgId, taskId) => resolveTaskVisibility({ documentClient: input.documentClient, tableName: state.tableName, now }, orgId, taskId), actors, modes, paused, routes, tools, taps: { github, hook, slack, slackStrict }, erase, jobs, opsFailures: (orgId) => readOpsFailures(table, orgId, now()) };
}
