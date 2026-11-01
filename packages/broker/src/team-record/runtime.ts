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
import { OrgIdSchema, VECTOR_DIMENSION_DEFAULT, githubMemberKey, memberGithubKey, TEAM_RECORD_ORG_DIRECTORY_PK, orgProjectCatalogPk, teamRecordOrgDirectoryKey, type OrgId, type ProjectRole } from "@agentx/contracts";
import { readProjectRole, readStanding } from "../learning/standing.js";
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
import { eraseProject, eraseWorkspace, erasePerson, type EraseResult } from "./erase.js";
import { tableHotArchiveSource, ensureWorkspaceVectorBucket, tableHotStatsSource } from "./hot-source.js";
import { createLakeClient, type LakeClient } from "./lake.js";
import { runLakeDeletes } from "./lake-delete.js";
import { tableLakeDeleteQueue } from "./lake-queue.js";
import { tableModeReader, type LearningModeReader } from "./mode.js";
import { buildRecordCaller, handleRecordRoute, type RecordRouteReply } from "./routes.js";
import { dynamoRateLimiter, type RecordQueryDependencies } from "./query.js";
import { createCaptureModePort, createRecordHistoryPort, createRecordSink, createSourceConfigPort, NOTES_OPT_IN_FROM_SOURCE_ROW, type RecordSink } from "./sink.js";
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
  /** Where the record's own audit events go (record.tombstoned, record.erased, lesson.withdrawn). Absent: none are written. */
  audit?: RecordAuditSink;
  /** A model for the distiller (retention B / nightly). Absent: no distiller, B text is dropped. */
  distillModel?: DistillModel;
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
  /** The router sink: one sink per workspace, built on first use. A workspace id that is not an org id is refused. */
  readonly sink: RecordSink;
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
const ERASE_PASSES = 5;

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
  async function indexFor(orgId: OrgId): Promise<S3VectorsIndex | undefined> {
    if (vectorPorts === undefined) return undefined;
    try {
      const bucket = await ensureWorkspaceVectorBucket(table, orgId, buckets, chooseVectorBucketForNewWorkspace, now);
      const index = await openWorkspaceIndex({ ports: vectorPorts, workspaceId: orgId, bucket, dimension: VECTOR_DIMENSION_DEFAULT });
      // Public creates one index per workspace at run time; Enterprise's single index is made by the stack.
      if (edition === "public" && !indexReady.has(orgId)) { await index.ensureIndex(); indexReady.add(orgId); }
      return index;
    } catch {
      log("record.vectors_unavailable", {});
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
  const sink: RecordSink = {
    put: async (draft) => (await sinkFor(draft.workspaceId)).put(draft),
    tombstone: async (call) => (await sinkFor(call.workspaceId)).tombstone(call),
    changePrincipals: async (call) => (await sinkFor(call.workspaceId)).changePrincipals(call),
    replaceScopeAudience: async (call) => (await sinkFor(call.workspaceId)).replaceScopeAudience(call),
    ensureAccessSeed: async (call) => (await sinkFor(call.workspaceId)).ensureAccessSeed(call),
  };

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

  // ---- erase: each repeats the walk until it finishes or gives up; unfinished work throws so the request that asked is repeated
  async function untilComplete(step: () => Promise<EraseResult>): Promise<void> {
    for (let pass = 0; pass < ERASE_PASSES; pass += 1) if ((await step()).complete) return;
    throw unavailable();
  }
  const erase: TeamRecordRuntime["erase"] = {
    async person(orgId, developerId) {
      const parsed = OrgIdSchema.parse(orgId);
      const deps = await purgeFor(parsed);
      const github = ((await input.documentClient.send(new GetCommand({ TableName: state.tableName, Key: memberGithubKey(parsed, developerId), ConsistentRead: true }))) as { Item?: { githubUserId?: unknown } }).Item?.githubUserId;
      const projects = await projectsOf(parsed);
      await untilComplete(() => erasePerson(deps, parsed, { developerId, projects, ...(typeof github === "string" ? { identities: [{ system: "github", sourceId: github }] } : {}) }, `erase:${developerId}`));
    },
    async project(orgId, project, cause) {
      const parsed = OrgIdSchema.parse(orgId);
      const deps = await purgeFor(parsed);
      await untilComplete(() => eraseProject(deps, parsed, project, cause, `${cause}:${project}`));
    },
    async workspace(orgId) {
      const parsed = OrgIdSchema.parse(orgId);
      const deps = await purgeFor(parsed);
      for (let pass = 0; pass < ERASE_PASSES; pass += 1) {
        const result = await eraseWorkspace(deps, parsed, await projectsOf(parsed), `org_closed:${parsed}`);
        if (result.complete && result.remainingProjects.length === 0) {
          // Nothing of the org is left for the jobs to find.
          await table.documentClient.send(new DeleteCommand({ TableName: table.tableName, Key: teamRecordOrgDirectoryKey(parsed) }));
          listed.delete(parsed);
          sinks.delete(parsed);
          return;
        }
      }
      throw unavailable();
    },
  };

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
          return { requests: done.requests, finished: done.finished, stillHidden: done.stillHidden, lakeStatements: lakeDeletes?.statements ?? 0 };
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
  const slack: TeamRecordRuntime["taps"]["slack"] = async (forward) => {
    const tap = createSlackRecordTap({
      edition, sink, distiller, actors, mode, config, directory: slackDirectory(forward.channel), log: tapLog,
      notesOptIn: NOTES_OPT_IN_FROM_SOURCE_ROW,
      // The org this Slack team is bound to; an unbound team is not recorded.
      resolveWorkspace: async (teamId) => {
        try { return { workspaceId: await resolveSlackOrg(new OrgStore({ documentClient: input.documentClient, tableName: state.tableName, now }), teamId) }; }
        catch { return undefined; }
      },
    });
    return tap(forward.payload);
  };

  return { edition, table, sink, emitter, actors, modes, routes, tools, taps: { github, hook, slack }, erase, jobs };
}
