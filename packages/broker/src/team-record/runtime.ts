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
import { randomUUID } from "node:crypto";
import { DeleteCommand, GetCommand, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { STSClient } from "@aws-sdk/client-sts";
import { OrgIdSchema, VECTOR_DIMENSION_DEFAULT, githubMemberKey, memberGithubKey, TEAM_RECORD_ORG_DIRECTORY_PK, orgPk, orgProjectCatalogPk, teamRecordOrgDirectoryKey, type OrgId, type ProjectRole } from "@agentx/contracts";
import { companyIsOpen, readProjectRole, readStanding } from "../learning/standing.js";
import { readProjectMeta } from "../developer/project-roles.js";
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
import { createEmbedder } from "./embed.js";
import { eraseProject, eraseWorkspace, erasePerson, type EraseBudget } from "./erase.js";
import { tableHotArchiveSource, ensureWorkspaceVectorBucket, tableHotStatsSource } from "./hot-source.js";
import { createLakeClient, type LakeClient } from "./lake.js";
import { runLakeDeletes } from "./lake-delete.js";
import { tableLakeDeleteQueue } from "./lake-queue.js";
import { tableModeReader, type LearningModeReader } from "./mode.js";
import { buildRecordCaller, handleRecordRoute, type RecordRouteReply } from "./routes.js";
import { dynamoRateLimiter, type RecordQueryDependencies } from "./query.js";
import { createCaptureModePort, createRecordHistoryPort, createRecordSink, createSourceConfigPort, NOTES_OPT_IN_FROM_SOURCE_ROW, type RecordSink } from "./sink.js";
import { createOpConsumer, type QueueRecord } from "./sources/queue.js";
import type { OpsQueue } from "./ops-queue.js";
import { createGithubRecordTap, createHookRecordTap, createRovaraEmitter, createSlackRecordTap, createTicketRecorder, type ActorResolverPort, type RovaraEmitter, type SlackChannelInfo, type SlackDirectoryPort } from "./sources/index.js";
import { runStats, type StatsDeps } from "./stats-templates.js";
import { expireRawText } from "./text-expiry.js";
import { createTransientDistiller } from "./transient-distiller.js";
import { createAssume, createStsAssumePort, openWorkspaceIndex, WorkspaceVectorPorts, type StsAssumePort } from "./vector-access.js";
import { chooseVectorBucketForNewWorkspace, type VectorIndex } from "./vectors.js";
import type { S3VectorsIndex } from "./s3-vectors-index.js";
import type { DistillModel } from "./distill.js";
import type { PurgeDependencies } from "./purge.js";
import type { RecordLog, RecordVectorPort, TeamRecordTable } from "./types.js";

type DocClient = TeamRecordTable["documentClient"];

/** Exactly the word the CDK writes. Anything else, including "true", "on" and a missing variable, is OFF. */
export const teamRecordIsOn = (env: Record<string, string | undefined>): boolean => env.TEAM_RECORD_ENABLED === "1";

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
  drain(records: ReadonlyArray<QueueRecord>): Promise<{ batchItemFailures: Array<{ itemIdentifier: string }> }>;
  readonly emitter: RovaraEmitter;
  readonly actors: ActorResolverPort;
  readonly modes: LearningModeReader;
  /** `/v1/app/projects/{project}/record/...` (the caller's project role already found by the broker). `undefined` for any other path. */
  routes(request: { method: string; path: string; query: Readonly<Record<string, string | undefined>>; caller: TeamRecordCallerInput }): Promise<RecordRouteReply | undefined>;
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
}

const DEFAULT_EMBEDDING_MODEL = "amazon.titan-embed-text-v2:0";
const ORG_PAGE = 50;
const MAX_ORGS_PER_RUN = 500;
/** One scheduled run's whole budget: inside the broker function's 30 s timeout with room for the answer. */
export const JOB_BUDGET_MS = 24_000;
const PER_ORG_MS = 8_000;

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
  const modes = tableModeReader(table);
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
  const actors: ActorResolverPort = {
    async resolve({ workspaceId, project, system, sourceId, isBot }) {
      if (isBot === true) return { trust: "system" };
      const parsed = OrgIdSchema.safeParse(workspaceId);
      if (!parsed.success || project === undefined || (system !== "github" && !system.startsWith("codehost:"))) return { trust: "outsider" };
      const link = (await input.documentClient.send(new GetCommand({ TableName: state.tableName, Key: githubMemberKey(parsed.data, sourceId), ConsistentRead: true }))) as { Item?: { developerId?: unknown; orgId?: unknown } };
      const developerId = link.Item?.developerId;
      if (typeof developerId !== "string" || (link.Item?.orgId !== undefined && link.Item.orgId !== parsed.data)) return { trust: "outsider" };
      return (await readStanding(state, parsed.data, developerId, project)) === "member" ? { developerId, trust: "member" } : { trust: "outsider" };
    },
    async resolveDeveloper({ workspaceId, project, developerId }) {
      const parsed = OrgIdSchema.safeParse(workspaceId);
      if (!parsed.success || project === undefined) return { trust: "outsider" };
      return { trust: (await readStanding(state, parsed.data, developerId, project)) === "member" ? "member" : "outsider" };
    },
  };

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
  const directSink: RecordSink = {
    put: async (draft) => (await sinkFor(draft.workspaceId)).put(draft),
    tombstone: async (call) => (await sinkFor(call.workspaceId)).tombstone(call),
    changePrincipals: async (call) => (await sinkFor(call.workspaceId)).changePrincipals(call),
    replaceScopeAudience: async (call) => (await sinkFor(call.workspaceId)).replaceScopeAudience(call),
    ensureAccessSeed: async (call) => (await sinkFor(call.workspaceId)).ensureAccessSeed(call),
  };
  // The taps write through this one. A delete or an edit that fails against the table is not swallowed: it goes to the durable queue and the consumer applies it (retried, then dead-lettered).
  // A workspace that is not an org is refused BEFORE anything is tried or queued. A new version of an item may carry text, so it is queued only where the text may be kept: never a Slack message
  // (or a row made from one) in the Public edition, whose text must never be parked anywhere.
  const queue: OpsQueue | undefined = input.opsQueue;
  const keepsText = (draft: { source: string; origin?: string | undefined }): boolean => !(edition === "public" && (draft.source === "slack" || draft.origin === "slack"));
  const durableSink: RecordSink = {
    async put(draft) {
      OrgIdSchema.parse(draft.workspaceId);
      try { return await directSink.put(draft); } catch (error) {
        if (queue === undefined || !keepsText(draft)) throw error;
        await queue.send({ v: 1, op: "put", draft } as never);
        log("record.put_queued", {});
        return { status: "queued" } as never;
      }
    },
    async tombstone(call) {
      OrgIdSchema.parse(call.workspaceId);
      try { return await directSink.tombstone(call); } catch (error) {
        if (queue === undefined) throw error;
        await queue.send({ v: 1, op: "tombstone", workspaceId: call.workspaceId, system: call.system, ...(call.sourceIds === undefined ? {} : { sourceIds: [...call.sourceIds] }), ...(call.scope === undefined ? {} : { scope: call.scope }), cause: call.cause } as never);
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
  const history = createRecordHistoryPort({ table });
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
  const distiller = input.distillModel === undefined
    ? { distillTransient: async () => ({ accepted: false }) }
    : createTransientDistiller({
      ingest: { table, modes, edition, rovaraDefaultRetention: defaultRetention(edition, "rovara"), embedder, now, log },
      distill: { model: input.distillModel, now: () => new Date(now()).toISOString(), newId: () => `fact_${randomUUID().replace(/-/g, "")}` },
    });

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
  const github = createGithubRecordTap({ sink, actors, rovaraPrs, mode, config, resolveRepo, log: tapLog, now });
  const recorder = createTicketRecorder({ sink, actors, mode, config, history, log: tapLog });
  const hook = createHookRecordTap({ recorder });
  const emitter = createRovaraEmitter({ sink, actors, mode, config, log: tapLog });

  // ---- the query API
  async function queryFor(orgId: OrgId): Promise<RecordQueryDependencies> {
    const vectors = await indexFor(orgId);
    const hot = tableHotStatsSource(table);
    const lakeNow = lakeClient();
    const stats: StatsDeps | undefined = lakeNow === undefined ? undefined : { lake: lakeNow, tableBucket, hot };
    return {
      table, modes, embedder, now, log,
      limiter: dynamoRateLimiter(table, now),
      ...(vectors === undefined ? {} : { vectorSearch: { query: (request) => (vectors as VectorIndex).query(request) } }),
      ...(stats === undefined ? {} : { stats: { run: async ({ template, workspaceId, project, params }) => (await runStats(stats, { workspaceId, project, audience: "project" } as never, template, params)).rows } }),
    };
  }

  const routes: TeamRecordRuntime["routes"] = async ({ method, path, query, caller }) => {
    // The org is the caller's session's. The route handler never reads one from the path or the query.
    const orgId = OrgIdSchema.parse(caller.orgId);
    const identities = { identitiesOf: async (org: OrgId, developerId: string) => identitiesOf(org, developerId) };
    const built = await buildRecordCaller(identities, { orgId, developerId: caller.developerId, projectRole: caller.projectRole });
    try {
      return await handleRecordRoute(await queryFor(orgId), { method, path, query, caller: built });
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
    list: (context) => recordToolsFor(context),
    call: async (context, call) => callRecordTool(await queryFor(OrgIdSchema.parse(context.orgId)), context, call),
    async ownerAudience(task, developerId) {
      const orgId = OrgIdSchema.parse(task.orgId);
      const projectRole = await readProjectRole(state, orgId, developerId, task.project);
      return { kind: "caller", caller: await buildRecordCaller({ identitiesOf: async (org, developer) => identitiesOf(org, developer) }, { orgId, developerId, projectRole }) };
    },
  };

  // ---- erase. Every erase writes an "erase in progress" marker FIRST (in the org directory's partition, so it survives the erase of the org's own partition), then does ONE bounded pass inline. What does not
  // finish is finished by the hourly job, which resumes each marker a pass at a time until it is done; a company's marker then waits for the lake delete to run before the org leaves the directory.
  type EraseJob =
    | { kind: "workspace"; phase: "hot" | "lake"; projects: string[] }
    | { kind: "project"; project: string; cause: "project_archived" | "org_closed" }
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

  /** One bounded step of a job. `true` when the job is finished (its marker is gone). Never runs past `budget`. */
  async function advance(orgId: OrgId, job: StoredJob, budget: EraseBudget, lakeMs: number): Promise<boolean> {
    const deps = await purgeFor(orgId);
    if (job.kind === "workspace") {
      if (job.phase === "hot") {
        const result = await eraseWorkspace(deps, orgId, job.projects, `org_closed:${orgId}`, budget);
        if (!(result.complete && result.remainingProjects.length === 0)) { await saveJob(orgId, { ...job, projects: result.remainingProjects }); return false; }
        job = { ...job, phase: "lake", projects: [] };
        await saveJob(orgId, job);
      }
      // The lake: the whole-workspace delete queued by the erase is run here, and the org stays in the directory until nothing is left in the queue. Without a lake there is nothing to wait for.
      const lakeNow = lakeClient();
      if (lakeNow !== undefined) {
        await runLakeDeletes({ queue: lakeQueue, lake: lakeNow, tableBucket }, { workspaceId: orgId, budget: { maxStatements: 5, maxMs: Math.max(1_000, lakeMs) } });
        if ((await lakeQueue.listPending(orgId, 1)).length > 0) return false;
      }
      await dropJob(job.sk);
      if ((await jobsOf(orgId)).length === 0) {
        await table.documentClient.send(new DeleteCommand({ TableName: table.tableName, Key: teamRecordOrgDirectoryKey(orgId) }));
        listed.delete(orgId);
        sinks.delete(orgId);
      }
      return true;
    }
    const names = job.kind === "person" ? await personNames(job.developerId) : [];
    const complete = job.kind === "project"
      ? (await eraseProject(deps, orgId, job.project, job.cause, `${job.cause}:${job.project}`, budget)).complete
      : (await erasePerson(deps, orgId, { developerId: job.developerId, projects: job.projects, ...(job.identities.length === 0 ? {} : { identities: job.identities }), ...(names.length === 0 ? {} : { names }) }, `erase:${job.developerId}`, budget)).complete;
    if (complete) await dropJob(job.sk);
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
    return identities.slice(0, 50);
  }
  const INLINE_ERASE: EraseBudget = { maxItems: 500, maxMs: 8_000 };
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
      const job = await putJob(parsed, { kind: "project", project, cause });
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
  async function eachOrg(work: (orgId: OrgId, budgetMs: number) => Promise<Record<string, number>>): Promise<TeamRecordJobSummary> {
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
        const left = JOB_BUDGET_MS - (now() - started);
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

  const jobs: TeamRecordRuntime["jobs"] = {
    async run(job) {
      if (job === "hourly") {
        return eachOrg(async (orgId, budgetMs) => {
          const deleteBudget: DeleteBudget = { maxRequests: 50, maxItems: 5_000, maxMs: budgetMs };
          const done = await runDeleteWorker(await purgeFor(orgId), orgId, deleteBudget);
          const lakeNow = lakeClient();
          const lakeDeletes = lakeNow === undefined ? undefined : await runLakeDeletes({ queue: lakeQueue, lake: lakeNow, tableBucket }, { workspaceId: orgId, budget: { maxStatements: 5, maxMs: Math.max(1_000, budgetMs / 2) } });
          // Erases that did not finish where they were asked for (a person, a project, a whole company): one bounded step each, then the company's lake delete is waited for.
          const erased = await resumeErases(orgId, budgetMs);
          return { requests: done.requests, finished: done.finished, stillHidden: done.stillHidden, lakeStatements: lakeDeletes?.statements ?? 0, erasesFinished: erased };
        });
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
  const consumer = createOpConsumer({ sink: directSink, distiller, log: tapLog });
  const drain: TeamRecordRuntime["drain"] = async (records) => {
    const failures: Array<{ itemIdentifier: string }> = [];
    const rest: QueueRecord[] = [];
    for (const record of records) {
      let parsed: { v?: unknown; op?: unknown; payload?: unknown } | undefined;
      try { parsed = JSON.parse(record.body) as typeof parsed; } catch { parsed = undefined; }
      if (parsed?.v === 1 && parsed.op === "slack_removal") {
        try { await slackStrict({ payload: parsed.payload }); } catch { log("record.op_failed", { op: "slack_removal", receiveCount: record.receiveCount }); failures.push({ itemIdentifier: record.messageId }); }
      } else rest.push(record);
    }
    failures.push(...(await consumer.processBatch(rest)).batchItemFailures);
    return { batchItemFailures: failures };
  };

  return { edition, table, sink, drain, emitter, actors, modes, routes, tools, taps: { github, hook, slack, slackStrict }, erase, jobs };
}
