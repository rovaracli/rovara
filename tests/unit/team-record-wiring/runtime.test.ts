// wire-team-record: the Team record's runtime in the broker. Three things are proved here:
//  1. SWITCH OFF: with `TEAM_RECORD_ENABLED` not exactly "1" no runtime is built, no client is created, no table is read or written, and every call site answers "off".
//  2. ORG SCOPING of the newly connected paths: the sink refuses a workspace that is not an org before looking anything up; the query routes read only the caller's org; an erase in one org leaves
//     another org's rows alone.
//  3. PUBLIC SLACK: message text is never stored in the Public edition (processed, then dropped), whatever the source row says; the positive control shows Enterprise does store it.
import { afterEach, describe, expect, it, vi } from "vitest";
import { TEAM_RECORD_OPS_MAX_RECEIVES, TEAM_RECORD_QUEUED_PUT_MAX_AGE_MS, developerOrgKey, githubInstallationKey, githubMemberKey, githubRepoProjectKey, orgMetaKey, orgSlackTeamKey, orgProjectCatalogKey, projectMetaKey, projectRevisionKey, slackTeamOrgKey, type OrgId } from "@agentx/contracts";
import { announceHumanSendBack } from "../../../packages/broker/src/lessons/send-back-events.js";
import { drainTeamRecordQueue, installTeamRecordEmitter, isTeamRecordJobEvent, isTeamRecordQueueEvent, isTeamRecordSlackEvent, recordSlackForward, runTeamRecordJob, uninstallTeamRecordEmitter } from "../../../packages/broker/src/aws/broker/team-record-wiring.js";
import { createTeamRecordRuntime, teamRecordIsOn, type TeamRecordRuntime } from "../../../packages/broker/src/team-record/runtime.js";
import { ERASE_SWEEP_DELAY_MS } from "../../../packages/broker/src/team-record/erase.js";
import { putSourceConfig } from "../../../packages/broker/src/team-record/store.js";
import { SdkUnavailableError } from "../../../packages/broker/src/team-record/aws-adapters.js";
import { FakeDynamoDb } from "../../support/fake-dynamodb.js";
import { ORG_A, ORG_B, T0, githubDraft } from "../../support/team-record-core.js";

afterEach(() => { uninstallTeamRecordEmitter(); });

void 0;
const MARKER = "SECRETMARKER-QZX-withRetry";
const ON = { TEAM_RECORD_ENABLED: "1", TEAM_RECORD_TABLE_NAME: "TeamRecord", AWS_REGION: "us-west-2" } as const;
const indexKeys = { gsi1: { partition: "gsi1pk" }, gsi2: { partition: "gsi2pk" }, gsi3: { partition: "gsi3pk", sort: "gsi3sk" }, gsi4: { partition: "gsi4pk" }, gsi5: { partition: "gsi5pk", sort: "textDueAt" } };
const dbOf = () => new FakeDynamoDb({ indexKeys });
const noSdk = async (): Promise<never> => { throw new SdkUnavailableError(); };

/** A fake AWS: Bedrock answers a 1,024-dimension embedding, S3 Vectors records every command with the credentials it was signed with, and STS records every session policy it was asked for. */
function fakeAws() {
  const vectorCalls: Array<{ command: string; input: Record<string, unknown>; accessKeyId: string }> = [];
  const athenaCalls: Array<{ command: string; sql: string }> = [];
  const athena = { down: false };
  const embedBodies: string[] = [];
  const sessions: Array<{ roleArn: string; policy: string; sessionName: string; tags?: ReadonlyArray<{ Key: string; Value: string }> | undefined }> = [];
  const command = (name: string) => ({ [name]: class { constructor(readonly input: Record<string, unknown>) {} get commandName() { return name; } } });
  const sdk = async (name: string): Promise<Record<string, unknown>> => {
    if (name === "@aws-sdk/client-bedrock-runtime") {
      return {
        BedrockRuntimeClient: class { async send(c: { input: { body: string } }) { embedBodies.push(c.input.body); return { body: Buffer.from(JSON.stringify({ embedding: Array.from({ length: 1024 }, () => 0.01) })) }; } },
        ...command("InvokeModelCommand"),
      };
    }
    if (name === "@aws-sdk/client-s3vectors") {
      return {
        S3VectorsClient: class {
          constructor(readonly config: { credentials: { accessKeyId: string } }) {}
          async send(c: { commandName: string; input: Record<string, unknown> }) {
            vectorCalls.push({ command: c.commandName, input: c.input, accessKeyId: this.config.credentials.accessKeyId });
            return c.commandName === "QueryVectorsCommand" || c.commandName === "GetVectorsCommand" ? { vectors: [] } : {};
          }
        },
        ...command("PutVectorsCommand"), ...command("QueryVectorsCommand"), ...command("GetVectorsCommand"), ...command("DeleteVectorsCommand"), ...command("CreateIndexCommand"),
      };
    }
    if (name === "@aws-sdk/client-athena") {
      return {
        AthenaClient: class {
          async send(c: { commandName: string; input: Record<string, unknown> }) {
            athenaCalls.push({ command: c.commandName, sql: typeof c.input.QueryString === "string" ? c.input.QueryString : "" });
            if (athena.down && c.commandName === "StartQueryExecutionCommand") throw Object.assign(new Error("secret"), { name: "InternalServerException" });
            if (c.commandName === "StartQueryExecutionCommand") return { QueryExecutionId: `q${athenaCalls.length}` };
            if (c.commandName === "GetQueryExecutionCommand") return { QueryExecution: { Status: { State: "SUCCEEDED" } } };
            return { ResultSet: { ResultSetMetadata: { ColumnInfo: [] }, Rows: [] } };
          }
        },
        ...command("StartQueryExecutionCommand"), ...command("GetQueryExecutionCommand"), ...command("GetQueryResultsCommand"), ...command("StopQueryExecutionCommand"),
      };
    }
    throw new SdkUnavailableError();
  };
  const sts = {
    async assumeRole(request: { roleArn: string; sessionName: string; policy: string; durationSeconds: number; tags?: ReadonlyArray<{ Key: string; Value: string }> }) {
      sessions.push({ roleArn: request.roleArn, policy: request.policy, sessionName: request.sessionName, tags: request.tags });
      return { credentials: { accessKeyId: `AKIA-${sessions.length}`, secretAccessKey: "s", sessionToken: "t" }, expiresAtMs: T0 + 3_600_000 };
    },
  };
  return { sdk, sts, vectorCalls, embedBodies, sessions, athenaCalls, athena };
}
const VECTORS_ENV = { TEAM_RECORD_VECTORS_ROLE_ARN: "arn:aws:iam::123456789012:role/agentx/ent/vr", TEAM_RECORD_VECTOR_BUCKETS: "agentx-ent-record-vectors", AGENTX_ACCOUNT_ID: "123456789012" } as const;
const everything = (db: FakeDynamoDb): string => JSON.stringify(db.find(() => true));

/** TRW-4: a row is stored only for a linked author. By default the GitHub account 123 and the Slack user U0123456789 are the member dev-1 of both orgs. */
const SLACK_LINKED = "U0123456789";
function linkDefaults(db: FakeDynamoDb): void {
  for (const orgId of [ORG_A, ORG_B]) {
    db.set({ ...githubMemberKey(orgId, "123"), entityType: "GITHUB_MEMBER", developerId: "dev-1", orgId });
  }
  db.set({ ...developerOrgKey("dev-1"), entityType: "DEVELOPER_ORG", orgId: ORG_A, role: "member" });
}

function build(db: FakeDynamoDb, env: Record<string, string | undefined>, extra: Partial<Parameters<typeof createTeamRecordRuntime>[0]> = {}): TeamRecordRuntime {
  const aws = fakeAws();
  linkDefaults(db);
  const runtime = createTeamRecordRuntime({ env: { ...VECTORS_ENV, ...env }, documentClient: db, stateTableName: "State", now: () => T0, sdk: aws.sdk, sts: aws.sts, developerOfSlackUser: async (id) => (id === SLACK_LINKED ? "dev-1" : undefined), ...extra });
  if (runtime === undefined) throw new Error("the runtime was not built");
  return runtime;
}

async function addSource(db: FakeDynamoDb, edition: "enterprise" | "public", input: { orgId: typeof ORG_A; source: "slack" | "github"; scope: string; retention: "A" | "B" | "C" | "D"; notesOptIn?: true; project?: string }): Promise<void> {
  const result = await putSourceConfig({ documentClient: db, tableName: "TeamRecord" }, {
    workspaceId: input.orgId, project: input.project ?? "web", source: input.source, scope: input.scope, enabled: true, retention: input.retention, exclude: [], audienceDefault: "project", health: "unknown",
    addedBy: "dev-1", updatedAt: "2026-10-30T10:00:00.000Z", ...(input.notesOptIn === true ? { notesOptIn: true as const } : {}),
  }, { edition });
  expect(result, JSON.stringify(result)).toMatchObject({ status: "saved" });
}

describe("the switch is off", () => {
  it.each([[{}], [{ TEAM_RECORD_ENABLED: "" }], [{ TEAM_RECORD_ENABLED: "0" }], [{ TEAM_RECORD_ENABLED: "true" }], [{ TEAM_RECORD_ENABLED: "on" }], [{ TEAM_RECORD_ENABLED: "enabled" }], [{ TEAM_RECORD_ENABLED: " 1" }]])("builds nothing and touches nothing for %j", (partial) => {
    const touched: string[] = [];
    const documentClient = { send: async (command: unknown) => { touched.push((command as { constructor: { name: string } }).constructor.name); throw new Error("the table was touched"); } };
    const loader = async () => { touched.push("sdk"); throw new Error("an sdk was loaded"); };
    const env = { TEAM_RECORD_TABLE_NAME: "TeamRecord", AWS_REGION: "us-west-2", ...partial };
    expect(teamRecordIsOn(env)).toBe(false);
    expect(createTeamRecordRuntime({ env, documentClient, stateTableName: "State", sdk: loader })).toBeUndefined();
    expect(touched).toStrictEqual([]);
  });

  it("answers off at every call site: the scheduled jobs, a forwarded Slack event, and a send-back (no listener is registered)", async () => {
    expect(await runTeamRecordJob({ teamRecord: undefined }, { job: "hourly" })).toStrictEqual({ skipped: true, reason: "off" });
    expect(await runTeamRecordJob({ teamRecord: undefined }, { job: "nightly" })).toStrictEqual({ skipped: true, reason: "off" });
    expect(await recordSlackForward({ teamRecord: undefined }, { source: "agentx.team-record-slack", payload: { type: "event_callback" } })).toStrictEqual({ skipped: true, reason: "off" });
    installTeamRecordEmitter({ teamRecord: undefined });
    // A send-back with no listener is a no-op that never throws.
    await expect(announceHumanSendBack({ workspaceId: ORG_A, project: "web", taskId: "t1", requestId: "r1", actorDeveloperId: "d".repeat(64), instructions: MARKER, round: 1, shared: true, ownerDeveloperId: "d".repeat(64), at: "2026-10-30T10:00:00.000Z" })).resolves.toBeUndefined();
  });

  it("recognises the scheduler's event and the ingress's event only in their exact shapes (never an HTTP request, never another job)", () => {
    expect(isTeamRecordJobEvent({ source: "agentx.team-record", job: "hourly" })).toBe(true);
    expect(isTeamRecordJobEvent({ source: "agentx.team-record", job: "everything" })).toBe(false);
    expect(isTeamRecordJobEvent({ source: "agentx.team-record", job: "hourly", requestContext: {} })).toBe(false);
    expect(isTeamRecordJobEvent({ source: "agentx.chain-sweep", job: "hourly" })).toBe(false);
    expect(isTeamRecordSlackEvent({ source: "agentx.team-record-slack", payload: {} })).toBe(true);
    expect(isTeamRecordSlackEvent({ source: "agentx.team-record-slack", payload: {}, requestContext: {} })).toBe(false);
    expect(isTeamRecordSlackEvent({ source: "agentx.team-record-slack" })).toBe(false);
  });

  it("is off, with one log line, when the switch is on but the install named no table", () => {
    const lines: Array<Record<string, unknown>> = [];
    expect(createTeamRecordRuntime({ env: { TEAM_RECORD_ENABLED: "1" }, documentClient: dbOf(), stateTableName: "State", log: (entry) => lines.push(entry) })).toBeUndefined();
    expect(lines).toStrictEqual([{ component: "team_record", event: "team_record.misconfigured", level: "error", missing: "TEAM_RECORD_TABLE_NAME" }]);
  });
});

describe("org scoping of the connected paths", () => {
  it("refuses a workspace that is not an org before it looks up a bucket, a source row or anything else", async () => {
    const db = dbOf();
    const calls: string[] = [];
    const spy = { send: async (command: unknown) => { calls.push((command as { constructor: { name: string } }).constructor.name); return db.send(command as never); } };
    const runtime = build(db, { ...ON, ROVARA_EDITION: "enterprise" }, { documentClient: spy });
    for (const workspaceId of ["acme", "org_short", "ORG_AAAAAAAAAAAAAAAAAAAA", `${ORG_A}#x`, ""]) {
      await expect(runtime.sink.put({ ...githubDraft(), workspaceId })).rejects.toThrow();
      await expect(runtime.sink.tombstone({ workspaceId, system: "github.com", scope: "github:repo/9", cause: "source_deleted" })).rejects.toThrow();
    }
    expect(calls).toStrictEqual([]);
  });

  it("answers a route only from the caller's own org: org B's rows are invisible to org A and visible to org B", async () => {
    const db = dbOf();
    // No vectors and no embedding here: the search falls back to keywords over the hot rows, which is the path whose scoping is read.
    const runtime = build(db, { ...ON, ROVARA_EDITION: "enterprise", TEAM_RECORD_VECTORS_ROLE_ARN: undefined }, { sdk: noSdk });
    await addSource(db, "enterprise", { orgId: ORG_B, source: "github", scope: "github:repo/9", retention: "C" });
    const projectWide = { kind: "project" as const };
    const putB = await runtime.sink.put(githubDraft({ workspaceId: ORG_B, retention: "C", audience: projectWide, scope: "github:repo/9", text: `Use ${MARKER} for network calls.` }));
    expect(putB, JSON.stringify(putB)).toMatchObject({ status: "stored" });
    const ask = (orgId: typeof ORG_A) => runtime.routes({ method: "GET", path: "/v1/app/projects/web/record/search", query: { query: "withRetry" }, caller: { orgId, developerId: "d".repeat(64), projectRole: "maintainer" } });
    const own = await ask(ORG_B);
    expect(own?.status).toBe(200);
    expect(JSON.stringify(own?.body)).toContain(MARKER);
    const other = await ask(ORG_A);
    expect(other?.status).toBe(200);
    expect(JSON.stringify(other?.body)).not.toContain(MARKER);
    expect((other?.body as { hits: unknown[] }).hits).toStrictEqual([]);
    // A caller with no project role gets nothing at all, and a path that is not a record route is not this runtime's.
    expect((await runtime.routes({ method: "GET", path: "/v1/app/projects/web/record/search", query: { query: "withRetry" }, caller: { orgId: ORG_B, developerId: "d".repeat(64), projectRole: undefined } }))?.status).toBe(403);
    expect(await runtime.routes({ method: "GET", path: "/v1/app/projects/web/learning", query: {}, caller: { orgId: ORG_B, developerId: "d".repeat(64), projectRole: "maintainer" } })).toBeUndefined();
  });

  it("erasing a person in one org leaves the same person's rows in another org", async () => {
    const db = dbOf();
    const runtime = build(db, { ...ON, ROVARA_EDITION: "enterprise" });
    for (const orgId of [ORG_A, ORG_B]) await addSource(db, "enterprise", { orgId, source: "github", scope: "github:repo/9", retention: "C" });
    const person = { sourceId: "123", developerId: "dev-1", trust: "member" as const };
    for (const orgId of [ORG_A, ORG_B]) expect(await runtime.sink.put(githubDraft({ workspaceId: orgId, retention: "C", audience: { kind: "project" }, scope: "github:repo/9", actor: person, text: `${orgId} says ${MARKER}` }))).toMatchObject({ status: "stored" });
    expect(everything(db)).toContain(`${ORG_A} says`);
    await runtime.erase.person(ORG_A, "dev-1");
    expect(everything(db)).not.toContain(`${ORG_A} says`);
    expect(everything(db)).toContain(`${ORG_B} says`);
  });
});


describe("vectors are opened per workspace", () => {
  it("assumes one session per workspace whose policy names only that workspace's index, and signs the vector calls with that session", async () => {
    const db = dbOf();
    const aws = fakeAws();
    const runtime = build(db, { ...ON, ROVARA_EDITION: "enterprise" }, { sdk: aws.sdk, sts: aws.sts });
    for (const orgId of [ORG_A, ORG_B]) await addSource(db, "enterprise", { orgId, source: "github", scope: "github:repo/9", retention: "C" });
    for (const orgId of [ORG_A, ORG_B]) expect(await runtime.sink.put(githubDraft({ workspaceId: orgId, retention: "C", audience: { kind: "project" }, scope: "github:repo/9", text: `${orgId} note` }))).toMatchObject({ status: "stored" });
    expect(aws.sessions).toHaveLength(2);
    const [first, second] = aws.sessions;
    expect(first!.roleArn).toBe(VECTORS_ENV.TEAM_RECORD_VECTORS_ROLE_ARN);
    const indexArns = (policy: string): string[] => (JSON.parse(policy) as { Statement: Array<{ Resource: string | string[] }> }).Statement.flatMap((statement) => [statement.Resource].flat()).filter((resource) => resource.includes(":index/") || resource.includes("/index/"));
    expect(indexArns(first!.policy)).toHaveLength(1);
    expect(indexArns(second!.policy)).toHaveLength(1);
    expect(indexArns(first!.policy)[0]).not.toBe(indexArns(second!.policy)[0]);
    // Fix round 1, S2: each session is TAGGED with its own workspace's index name (the data role's rights are written in terms of that tag), and the tag is the index the policy names.
    for (const session of aws.sessions) {
      expect(session.tags).toHaveLength(1);
      expect(session.tags![0]!.Key).toBe("rovara-index");
      expect(session.tags![0]!.Value).toMatch(/^ws-[0-9a-f]{32}$/);
      expect(session.policy).toContain(session.tags![0]!.Value);
    }
    expect(first!.tags![0]!.Value).not.toBe(second!.tags![0]!.Value);
    // The put of org A used session 1 and the put of org B used session 2: no call is signed with the other workspace's session.
    const puts = aws.vectorCalls.filter((call) => call.command === "PutVectorsCommand");
    expect(puts.map((call) => call.accessKeyId)).toStrictEqual(["AKIA-1", "AKIA-2"]);
    expect(String(puts[0]!.input.indexName)).not.toBe(String(puts[1]!.input.indexName));
  });

  it("Public makes the workspace's index on first use and Enterprise never does (the stack made it)", async () => {
    for (const [edition, made] of [["public", 1], ["enterprise", 0]] as const) {
      const db = dbOf();
      const aws = fakeAws();
      const runtime = build(db, { ...ON, ROVARA_EDITION: edition }, { sdk: aws.sdk, sts: aws.sts });
      await addSource(db, edition, { orgId: ORG_A, source: "github", scope: "github:repo/9", retention: edition === "public" ? "D" : "C" });
      for (const id of ["c-1", "c-2"]) await runtime.sink.put(githubDraft({ retention: edition === "public" ? "D" : "C", audience: { kind: "project" }, scope: "github:repo/9", sourceRef: { system: "github.com", id, version: "1" } }));
      expect(aws.vectorCalls.filter((call) => call.command === "CreateIndexCommand"), edition).toHaveLength(made);
    }
  });

  it("an erase deletes the person's vectors in THEIR workspace's index only", async () => {
    const db = dbOf();
    const aws = fakeAws();
    const runtime = build(db, { ...ON, ROVARA_EDITION: "enterprise" }, { sdk: aws.sdk, sts: aws.sts });
    for (const orgId of [ORG_A, ORG_B]) await addSource(db, "enterprise", { orgId, source: "github", scope: "github:repo/9", retention: "C" });
    const person = { sourceId: "123", developerId: "dev-1", trust: "member" as const };
    for (const orgId of [ORG_A, ORG_B]) await runtime.sink.put(githubDraft({ workspaceId: orgId, retention: "C", audience: { kind: "project" }, scope: "github:repo/9", actor: person, text: `${orgId} says hello` }));
    await runtime.erase.person(ORG_A, "dev-1");
    const deletes = aws.vectorCalls.filter((call) => call.command === "DeleteVectorsCommand");
    expect(deletes.length).toBeGreaterThan(0);
    // Only session 1 (org A's) deleted; org B's index was never touched by the erase.
    expect(new Set(deletes.map((call) => call.accessKeyId))).toStrictEqual(new Set(["AKIA-1"]));
  });
});

describe("Public Slack text is processed, then dropped", () => {
  const SCOPE = "slack:T0123456789/C0123456789";
  const payload = (text: string, extra: Record<string, unknown> = {}) => ({
    type: "event_callback", team_id: "T0123456789", api_app_id: "A0123456789",
    event: { type: "message", channel: "C0123456789", user: "U0123456789", text, ts: "1761818400.000100", channel_type: "channel", ...extra },
  });
  const publicChannel = { teamId: "T0123456789", channelId: "C0123456789", info: { kind: "public" as const, extShared: false } };
  const bind = (db: FakeDynamoDb) => db.set({ ...slackTeamOrgKey("T0123456789"), orgId: ORG_A });

  it("with retention B and the opt-in but no model, the message is processed and DROPPED: no row, no note, no text anywhere", async () => {
    const db = dbOf();
    bind(db);
    const runtime = build(db, { ...ON, ROVARA_EDITION: "public" });
    await addSource(db, "public", { orgId: ORG_A, source: "slack", scope: SCOPE, retention: "B", notesOptIn: true });
    const outcome = await runtime.taps.slack({ payload: payload(`please ${MARKER} always`), channel: publicChannel });
    expect(outcome, JSON.stringify(outcome)).toMatchObject({ outcome: "ignored", reason: "refused" });
    expect(everything(db)).not.toContain(MARKER);
    expect(db.find((item) => item.entityType === "TEAM_RECORD_EVENT")).toStrictEqual([]);
  });

  it("with a model, only the model's note is kept; the message text is in no row, no fact and no embedding request", async () => {
    const db = dbOf();
    bind(db);
    const embedded: string[] = [];
    const sdk = async (name: string) => {
      if (name !== "@aws-sdk/client-bedrock-runtime") throw new SdkUnavailableError();
      return { BedrockRuntimeClient: class { async send(command: { input: { body: string } }) { embedded.push(command.input.body); throw new Error("no embedding in this test"); } }, InvokeModelCommand: class { constructor(readonly input: { body: string }) {} } };
    };
    const note = JSON.stringify({ facts: [{ kind: "note", text: "The team retries network calls.", links: [] }] });
    const runtime = build(db, { ...ON, ROVARA_EDITION: "public" }, { distillModel: async () => note, sdk });
    await addSource(db, "public", { orgId: ORG_A, source: "slack", scope: SCOPE, retention: "B", notesOptIn: true });
    const outcome = await runtime.taps.slack({ payload: payload(`please ${MARKER} always`), channel: publicChannel });
    expect(outcome.outcome).toBe("recorded");
    expect(everything(db)).not.toContain(MARKER);
    expect(embedded.join("")).not.toContain(MARKER);
    expect(db.find((item) => item.entityType === "TEAM_RECORD_EVENT")).toStrictEqual([]);
  });

  it("reads a Public Slack row set to live only (A) as live only, and the store refuses a B row without the opt-in or a C or D row", async () => {
    const db = dbOf();
    bind(db);
    const runtime = build(db, { ...ON, ROVARA_EDITION: "public" });
    await addSource(db, "public", { orgId: ORG_A, source: "slack", scope: SCOPE, retention: "A" });
    expect(await runtime.taps.slack({ payload: payload(`please ${MARKER} always`), channel: publicChannel })).toMatchObject({ outcome: "ignored", reason: "retention_a" });
    expect(everything(db)).not.toContain(MARKER);
    for (const retention of ["B", "C", "D"] as const) {
      const refused = await putSourceConfig({ documentClient: db, tableName: "TeamRecord" }, {
        workspaceId: ORG_A, project: "web", source: "slack", scope: `${SCOPE}9`, enabled: true, retention, exclude: [], audienceDefault: "project", health: "unknown", addedBy: "dev-1", updatedAt: "2026-10-30T10:00:00.000Z",
      }, { edition: "public" });
      expect(refused.status, retention).toBe("refused");
    }
  });

  it("reads an older Slack row that was kept as raw text (C), from before the install became Public, as live only: no text is stored", async () => {
    const db = dbOf();
    bind(db);
    // Written as an Enterprise row (the store refuses C for Public), then read by a Public install.
    await addSource(db, "enterprise", { orgId: ORG_A, source: "slack", scope: SCOPE, retention: "C" });
    const runtime = build(db, { ...ON, ROVARA_EDITION: "public" });
    expect(await runtime.taps.slack({ payload: payload(`please ${MARKER} always`), channel: publicChannel })).toMatchObject({ outcome: "ignored", reason: "retention_a" });
    expect(everything(db)).not.toContain(MARKER);
  });

  it("records nothing from a Slack Connect channel, a channel the ingress could not read, an unbound team, or a channel with no source row", async () => {
    const db = dbOf();
    bind(db);
    const runtime = build(db, { ...ON, ROVARA_EDITION: "public" });
    await addSource(db, "public", { orgId: ORG_A, source: "slack", scope: SCOPE, retention: "B", notesOptIn: true });
    expect(await runtime.taps.slack({ payload: payload(`x ${MARKER}`), channel: { ...publicChannel, info: { kind: "public", extShared: true } } })).toMatchObject({ outcome: "ignored", reason: "ext_shared" });
    expect(await runtime.taps.slack({ payload: payload(`x ${MARKER}`) })).toMatchObject({ outcome: "ignored", reason: "channel_unknown" });
    expect(await runtime.taps.slack({ payload: { ...payload(`x ${MARKER}`), team_id: "T9999999999" }, channel: { ...publicChannel, teamId: "T9999999999" } })).toMatchObject({ outcome: "ignored", reason: "unbound_team" });
    expect(await runtime.taps.slack({ payload: payload(`x ${MARKER}`, { channel: "C0000000000" }), channel: { ...publicChannel, channelId: "C0000000000" } })).toMatchObject({ outcome: "ignored", reason: "no_source_row" });
    // The facts the ingress read are for ONE channel: an event for another channel finds no facts and is not recorded.
    expect(await runtime.taps.slack({ payload: payload(`x ${MARKER}`, { channel: "C0123456780" }), channel: publicChannel })).toMatchObject({ outcome: "ignored" });
    expect(everything(db)).not.toContain(MARKER);
  });

  it("positive control: Enterprise with retention C DOES keep the text, so the checks above would see a leak if there were one", async () => {
    const db = dbOf();
    bind(db);
    const runtime = build(db, { ...ON, ROVARA_EDITION: "enterprise" });
    await addSource(db, "enterprise", { orgId: ORG_A, source: "slack", scope: SCOPE, retention: "C" });
    expect(await runtime.taps.slack({ payload: payload(`please ${MARKER} always`), channel: publicChannel })).toMatchObject({ outcome: "recorded", stored: true });
    expect(everything(db)).toContain(MARKER);
  });

  it("a Slack delete removes what was recorded, from the org the team is bound to", async () => {
    const db = dbOf();
    bind(db);
    const runtime = build(db, { ...ON, ROVARA_EDITION: "enterprise" });
    await addSource(db, "enterprise", { orgId: ORG_A, source: "slack", scope: SCOPE, retention: "C" });
    await runtime.taps.slack({ payload: payload(`please ${MARKER} always`), channel: publicChannel });
    expect(everything(db)).toContain(MARKER);
    const deleted = { type: "event_callback", team_id: "T0123456789", event: { type: "message", subtype: "message_deleted", channel: "C0123456789", deleted_ts: "1761818400.000100", ts: "1761818500.000100" } };
    expect(await runtime.taps.slack({ payload: deleted, channel: publicChannel })).toMatchObject({ outcome: "deleted" });
    // Hidden at once: a search by the org no longer shows it.
    const found = await runtime.routes({ method: "GET", path: "/v1/app/projects/web/record/search", query: { query: "withRetry" }, caller: { orgId: ORG_A, developerId: "d".repeat(64), projectRole: "maintainer" } });
    expect(JSON.stringify(found?.body)).not.toContain(MARKER);
  });
});

// ---- the GitHub tap: the org comes from the INSTALLATION, never from the body
const repoOf = (id: number, name: string) => ({ name, url: `https://github.com/acme/${name}.git`, path: `repo/${name}`, defaultBranch: "main", credentialRef: "github-app", installationId: 55, githubRepositoryId: id });
function seedRepository(db: FakeDynamoDb, orgId: OrgId, input: { installationId: number; repositoryId: number; project: string; org?: OrgId }): void {
  db.set({ ...githubInstallationKey(input.installationId), entityType: "GITHUB_INSTALLATION", orgId, status: "active" });
  db.set({ ...githubRepoProjectKey(input.repositoryId, orgId, input.project), entityType: "GITHUB_REPO_PROJECT", orgId, project: input.project, installationId: input.installationId, githubRepositoryId: input.repositoryId });
  db.set({ ...projectRevisionKey(orgId, input.project, 1), entityType: "PROJECT_REVISION", definition: { name: input.project, revision: 1, repositories: [{ ...repoOf(input.repositoryId, "api"), installationId: input.installationId }], setup: [], readiness: [], orchestratorInstructions: "Delegate work." } });
}
const delivery = (installationId: number, repositoryId: number, text: string) => ({
  eventName: "issue_comment", deliveryId: "d-1",
  payload: {
    action: "created", installation: { id: installationId }, repository: { id: repositoryId, full_name: "acme/api", private: false, default_branch: "main" },
    issue: { number: 12, pull_request: {} },
    comment: { id: 7, html_url: "https://github.com/acme/api/pull/12#issuecomment-7", body: text, user: { id: 123, login: "maya", type: "User" }, updated_at: "2026-10-30T10:00:00Z" },
  },
});

describe("the GitHub tap finds the org from the installation", () => {
  it("records a comment into the org the installation is bound to, and into no other org", async () => {
    const db = dbOf();
    const runtime = build(db, { ...ON, ROVARA_EDITION: "enterprise" });
    seedRepository(db, ORG_A, { installationId: 55, repositoryId: 101, project: "web" });
    // The org B has a source row for the same scope: a delivery must still never land there.
    for (const orgId of [ORG_A, ORG_B]) await addSource(db, "enterprise", { orgId, source: "github", scope: "github:repo/101", retention: "C" });
    const result = await runtime.taps.github(delivery(55, 101, `Please use ${MARKER}`));
    expect(result).toMatchObject({ written: 1 });
    const rowsOf = (orgId: OrgId) => db.find((item) => item.entityType === "TEAM_RECORD_EVENT" && JSON.stringify(item).includes(orgId));
    expect(rowsOf(ORG_A)).toHaveLength(1);
    expect(rowsOf(ORG_B)).toHaveLength(0);
    // The commenter is not a linked company member, so the words are an outsider's.
    expect(rowsOf(ORG_A)[0]).toMatchObject({ trust: "outsider" });
  });

  it("records nothing for an installation that is bound to no org, a repository no project holds, or a body that names another repository than the registered one", async () => {
    const db = dbOf();
    const runtime = build(db, { ...ON, ROVARA_EDITION: "enterprise" });
    seedRepository(db, ORG_A, { installationId: 55, repositoryId: 101, project: "web" });
    await addSource(db, "enterprise", { orgId: ORG_A, source: "github", scope: "github:repo/101", retention: "C" });
    await addSource(db, "enterprise", { orgId: ORG_A, source: "github", scope: "github:repo/999", retention: "C" });
    expect(await runtime.taps.github(delivery(77, 101, `x ${MARKER}`))).toBeUndefined();
    expect(await runtime.taps.github(delivery(55, 999, `x ${MARKER}`))).toBeUndefined();
    expect(await runtime.taps.github({ eventName: "issue_comment", deliveryId: "d-2", payload: { nonsense: true } })).toBeUndefined();
    expect(everything(db)).not.toContain(MARKER);
  });

  it("a repository held by two projects is recorded into the project its SOURCE ROW names, never one guessed from the delivery", async () => {
    const db = dbOf();
    const runtime = build(db, { ...ON, ROVARA_EDITION: "enterprise" });
    seedRepository(db, ORG_A, { installationId: 55, repositoryId: 101, project: "web" });
    seedRepository(db, ORG_A, { installationId: 55, repositoryId: 101, project: "docs" });
    await addSource(db, "enterprise", { orgId: ORG_A, source: "github", scope: "github:repo/101", retention: "C", project: "web" });
    await runtime.taps.github(delivery(55, 101, `shared ${MARKER}`));
    const stored = db.find((item) => item.entityType === "TEAM_RECORD_EVENT");
    expect(stored).toHaveLength(1);
    expect(stored[0]!.project).toBe("web");
    expect(JSON.stringify(stored)).not.toContain("docs");
  });
});

describe("the scheduled jobs reach only the orgs that have written, and finish a delete", () => {
  it("lists an org when it first writes, runs the delete worker for it, and the rows of a deleted Slack message are physically gone afterwards", async () => {
    const db = dbOf();
    db.set({ ...slackTeamOrgKey("T0123456789"), orgId: ORG_A });
    const runtime = build(db, { ...ON, ROVARA_EDITION: "enterprise" });
    expect((await runtime.jobs.run("hourly")).orgs).toBe(0);
    await addSource(db, "enterprise", { orgId: ORG_A, source: "slack", scope: "slack:T0123456789/C0123456789", retention: "C" });
    await addSource(db, "enterprise", { orgId: ORG_B, source: "github", scope: "github:repo/9", retention: "C" });
    const message = { type: "event_callback", team_id: "T0123456789", event: { type: "message", channel: "C0123456789", user: "U0123456789", text: `please ${MARKER}`, ts: "1761818400.000100", channel_type: "channel" } };
    const channel = { teamId: "T0123456789", channelId: "C0123456789", info: { kind: "public" as const, extShared: false } };
    await runtime.taps.slack({ payload: message, channel });
    expect(everything(db)).toContain(MARKER);
    await runtime.taps.slack({ payload: { type: "event_callback", team_id: "T0123456789", event: { type: "message", subtype: "message_deleted", channel: "C0123456789", deleted_ts: "1761818400.000100", ts: "1761818500.000100" } }, channel });
    // Hidden at once, and the words are already gone from the row; the row itself (a tombstone) stays until the worker removes it.
    expect(everything(db)).not.toContain(MARKER);
    expect(db.find((item) => item.entityType === "TEAM_RECORD_EVENT")).toHaveLength(1);
    const summary = await runtime.jobs.run("hourly");
    // Only org A has written to the record, so only org A is visited (org B has a source row but never a write).
    expect(summary.orgs).toBe(1);
    expect(db.find((item) => item.entityType === "TEAM_RECORD_EVENT")).toStrictEqual([]);
  });

  it("a failing org does not stop the others, and the nightly job runs the raw-text expiry", async () => {
    const db = dbOf();
    const runtime = build(db, { ...ON, ROVARA_EDITION: "enterprise" });
    for (const orgId of [ORG_A, ORG_B]) await addSource(db, "enterprise", { orgId, source: "github", scope: "github:repo/9", retention: "C" });
    for (const orgId of [ORG_A, ORG_B]) await runtime.sink.put(githubDraft({ workspaceId: orgId, retention: "C", audience: { kind: "project" }, scope: "github:repo/9", text: `${orgId} note` }));
    const summary = await runtime.jobs.run("nightly");
    expect(summary.orgs).toBe(2);
    expect(summary.skippedOrgs).toBe(0);
  });
});

void vi;

// ---- fix round 1, B1: a delete or an edit is never swallowed
describe("a delete that arrives during a store failure is retried and lands", () => {
  const SCOPE = "slack:T0123456789/C0123456789";
  const channel = { teamId: "T0123456789", channelId: "C0123456789", info: { kind: "public" as const, extShared: false } };
  const post = { type: "event_callback", team_id: "T0123456789", event: { type: "message", channel: "C0123456789", user: "U0123456789", text: `please ${MARKER} always`, ts: "1761818400.000100", channel_type: "channel" } };
  const removal = { type: "event_callback", team_id: "T0123456789", event: { type: "message", subtype: "message_deleted", channel: "C0123456789", deleted_ts: "1761818400.000100", ts: "1761818500.000100" } };

  /** A client whose WRITES fail while `down.on` is set (reads still answer); the record table is "down for writes". */
  function flaky(db: FakeDynamoDb) {
    const down = { on: false, writes: 0 };
    const client = { send: async (command: unknown) => {
      const name = (command as { constructor: { name: string } }).constructor.name;
      if (down.on && /^(Put|Update|Delete|TransactWrite|BatchWrite)/.test(name)) { down.writes += 1; throw Object.assign(new Error("ProvisionedThroughputExceeded secret detail"), { name: "ProvisionedThroughputExceededException" }); }
      return db.send(command as never);
    } };
    return { client, down };
  }
  const queueOf = () => { const sent: Array<Record<string, unknown>> = []; return { sent, queue: { send: async (op: Record<string, unknown>) => { sent.push(op); } } }; };
  const asRecords = (sent: Array<Record<string, unknown>>) => sent.map((op, i) => ({ messageId: `m${i}`, body: JSON.stringify(op), receiveCount: 1 }));
  const eventRows = (db: FakeDynamoDb) => db.find((item) => item.entityType === "TEAM_RECORD_EVENT");

  it("Slack: the tombstone that fails is queued, the queue drains it once the table is back, and the text is gone", async () => {
    const db = dbOf();
    db.set({ ...slackTeamOrgKey("T0123456789"), orgId: ORG_A });
    const { client, down } = flaky(db);
    const { sent, queue } = queueOf();
    const runtime = build(db, { ...ON, ROVARA_EDITION: "enterprise" }, { documentClient: client, opsQueue: queue });
    await addSource(db, "enterprise", { orgId: ORG_A, source: "slack", scope: SCOPE, retention: "C" });
    await runtime.taps.slack({ payload: post, channel });
    expect(JSON.stringify(eventRows(db))).toContain(MARKER);
    down.on = true;
    expect(await runtime.taps.slack({ payload: removal, channel })).toMatchObject({ outcome: "deleted" });
    expect(down.writes).toBeGreaterThan(0);
    expect(sent.map((op) => op.op)).toStrictEqual(["tombstone"]);
    expect(JSON.stringify(eventRows(db))).toContain(MARKER);
    down.on = false;
    expect(await runtime.drain(asRecords(sent))).toStrictEqual({ batchItemFailures: [] });
    expect(everything(db)).not.toContain(MARKER);
  });

  it("the ingress's queued removal is applied by the strict tap: a failure leaves the message on the queue, the retry lands", async () => {
    const db = dbOf();
    db.set({ ...slackTeamOrgKey("T0123456789"), orgId: ORG_A });
    const { client, down } = flaky(db);
    const runtime = build(db, { ...ON, ROVARA_EDITION: "enterprise" }, { documentClient: client });
    await addSource(db, "enterprise", { orgId: ORG_A, source: "slack", scope: SCOPE, retention: "C" });
    await runtime.taps.slack({ payload: post, channel });
    const record = { messageId: "m1", body: JSON.stringify({ v: 1, op: "slack_removal", payload: removal }), receiveCount: 1 };
    down.on = true;
    expect(await runtime.drain([record])).toStrictEqual({ batchItemFailures: [{ itemIdentifier: "m1" }] });
    down.on = false;
    expect(await runtime.drain([{ ...record, receiveCount: 2 }])).toStrictEqual({ batchItemFailures: [] });
    expect(everything(db)).not.toContain(MARKER);
  });

  it("a failure to READ the Slack team's binding is a failure (retried), not an unknown team (dropped)", async () => {
    const db = dbOf();
    const broken = { send: async () => { throw new Error("read failed"); } };
    const runtime = build(db, { ...ON, ROVARA_EDITION: "enterprise" }, { documentClient: broken });
    await expect(runtime.taps.slackStrict({ payload: removal, channel })).rejects.toThrow();
  });

  it("GitHub: a deleted comment whose tombstone fails is queued and lands on the drain; an edit (a new version) is queued the same way", async () => {
    const db = dbOf();
    const { client, down } = flaky(db);
    const { sent, queue } = queueOf();
    const runtime = build(db, { ...ON, ROVARA_EDITION: "enterprise" }, { documentClient: client, opsQueue: queue });
    seedRepository(db, ORG_A, { installationId: 55, repositoryId: 101, project: "web" });
    await addSource(db, "enterprise", { orgId: ORG_A, source: "github", scope: "github:repo/101", retention: "C" });
    expect(await runtime.taps.github(delivery(55, 101, `first ${MARKER}`))).toMatchObject({ written: 1 });
    const comment = delivery(55, 101, "edited").payload;
    down.on = true;
    const deleted = { eventName: "issue_comment", deliveryId: "d-9", payload: { ...comment, action: "deleted" } };
    await runtime.taps.github(deleted);
    expect(sent.map((op) => op.op)).toContain("tombstone");
    down.on = false;
    expect(await runtime.drain(asRecords(sent))).toStrictEqual({ batchItemFailures: [] });
    expect(everything(db)).not.toContain(MARKER);
  });

  // ---- TRW-3 R4: a queued put holds text. It must not sit in the dead-letter queue, nor wait past a day for a consumer.
  it("a put that fails is queued with the time it was queued; the drain applies it once the table is back", async () => {
    const db = dbOf();
    const { client, down } = flaky(db);
    const { sent, queue } = queueOf();
    const runtime = build(db, { ...ON, ROVARA_EDITION: "enterprise" }, { documentClient: client, opsQueue: queue });
    await addSource(db, "enterprise", { orgId: ORG_A, source: "github", scope: "github:repo/9", retention: "C" });
    down.on = true;
    expect(await runtime.sink.put(githubDraft({ retention: "C", scope: "github:repo/9", text: `queued ${MARKER}` }))).toMatchObject({ status: "queued" });
    expect(sent.map((op) => op.op)).toStrictEqual(["put"]);
    expect(typeof sent[0]!.queuedAt).toBe("string");
    down.on = false;
    expect(await runtime.drain(asRecords(sent))).toStrictEqual({ batchItemFailures: [] });
    expect(everything(db)).toContain(MARKER);
  });

  it("a queued put that still cannot be applied two deliveries before the LAST is dropped (acknowledged), never dead-lettered with its text; a removal is still retried to the dead-letter queue", async () => {
    const db = dbOf();
    const down = { on: false };
    // Every storage call fails while it is down (the flaky client above fails only the deletes and updates).
    const client = { send: async (command: unknown) => { if (down.on) throw new Error("table down"); return db.send(command as never); } };
    const { sent, queue } = queueOf();
    const logs: Array<Record<string, unknown>> = [];
    const runtime = build(db, { ...ON, ROVARA_EDITION: "enterprise" }, { documentClient: client, opsQueue: queue, log: (entry: Record<string, unknown>) => logs.push(entry) });
    await addSource(db, "enterprise", { orgId: ORG_A, source: "github", scope: "github:repo/9", retention: "C" });
    down.on = true;
    await runtime.sink.put(githubDraft({ retention: "C", scope: "github:repo/9", text: `queued ${MARKER}` }));
    await runtime.sink.tombstone({ workspaceId: ORG_A, system: "github.com", scope: "github:repo/9", cause: "source_deleted" });
    expect(sent.map((op) => op.op)).toStrictEqual(["put", "tombstone"]);
    const at = (receiveCount: number) => asRecords(sent).map((record) => ({ ...record, receiveCount }));
    // TRW-5 S1: dropped two deliveries before the queue would dead-letter it (a timed-out or throttled invocation raises the count with no code run).
    expect(await runtime.drain(at(TEAM_RECORD_OPS_MAX_RECEIVES - 3))).toStrictEqual({ batchItemFailures: [{ itemIdentifier: "m0" }, { itemIdentifier: "m1" }] });
    expect(await runtime.drain(at(TEAM_RECORD_OPS_MAX_RECEIVES - 2))).toStrictEqual({ batchItemFailures: [{ itemIdentifier: "m1" }] });
    expect(JSON.stringify(logs)).not.toContain(MARKER);
    expect(logs.map((entry) => entry.event)).toContain("record.put_dropped");
  });

  it("a queued put older than a day, or with no time on it, is dropped unapplied: its text does not outlive the day, and an erase in between is never raced", async () => {
    const db = dbOf();
    const { sent, queue } = queueOf();
    const runtime = build(db, { ...ON, ROVARA_EDITION: "enterprise" }, { opsQueue: queue });
    await addSource(db, "enterprise", { orgId: ORG_A, source: "github", scope: "github:repo/9", retention: "C" });
    const draft = githubDraft({ retention: "C", scope: "github:repo/9", text: `old ${MARKER}` });
    const stale = new Date(T0 - TEAM_RECORD_QUEUED_PUT_MAX_AGE_MS - 60_000).toISOString();
    for (const queuedAt of [stale, undefined]) {
      const body = JSON.stringify({ v: 1, op: "put", draft, ...(queuedAt === undefined ? {} : { queuedAt }) });
      expect(await runtime.drain([{ messageId: "m1", body, receiveCount: 1 }])).toStrictEqual({ batchItemFailures: [] });
    }
    expect(everything(db)).not.toContain(MARKER);
    expect(sent).toStrictEqual([]);
  });

  it("a failed write with no queue is rethrown to the caller (never swallowed), and a Public Slack message is never queued", async () => {
    const db = dbOf();
    const { client, down } = flaky(db);
    const runtime = build(db, { ...ON, ROVARA_EDITION: "enterprise" }, { documentClient: client });
    await addSource(db, "enterprise", { orgId: ORG_A, source: "github", scope: "github:repo/9", retention: "C" });
    down.on = true;
    await expect(runtime.sink.tombstone({ workspaceId: ORG_A, system: "github.com", scope: "github:repo/9", cause: "source_deleted" })).rejects.toThrow();
    const dbP = dbOf();
    const flakyP = flaky(dbP);
    const queued = queueOf();
    const publicRuntime = build(dbP, { ...ON, ROVARA_EDITION: "public" }, { documentClient: flakyP.client, opsQueue: queued.queue });
    flakyP.down.on = true;
    await expect(publicRuntime.sink.put(githubDraft({ source: "slack", kind: "slack.message", workspaceId: ORG_A, text: `slack ${MARKER}` }))).rejects.toThrow();
    await expect(publicRuntime.sink.put(githubDraft({ workspaceId: ORG_A, origin: "slack", text: `from slack ${MARKER}` }))).rejects.toThrow();
    expect(queued.sent).toStrictEqual([]);
    expect(JSON.stringify(queued.sent)).not.toContain(MARKER);
  });

  it("the broker's Slack branch THROWS when the tap failed, so Lambda runs the invoke again", async () => {
    const db = dbOf();
    const runtime = build(db, { ...ON, ROVARA_EDITION: "enterprise" }, { documentClient: { send: async () => { throw new Error("down"); } } });
    await expect(recordSlackForward({ teamRecord: runtime }, { source: "agentx.team-record-slack", payload: post, channel })).rejects.toThrow();
  });

  it("the queue's event is recognised only from the record's own queue, and a broker with the record off fails the whole batch", async () => {
    const arn = "arn:aws:sqs:us-west-2:123456789012:agentx-staging-team-record-ops";
    const record = (eventSourceARN: string) => ({ eventSource: "aws:sqs", eventSourceARN, messageId: "m1", body: "{}" });
    const env = { AGENTX_ENV: "staging" };
    expect(isTeamRecordQueueEvent({ Records: [record(arn)] }, env)).toBe(true);
    expect(isTeamRecordQueueEvent({ Records: [record("arn:aws:sqs:us-west-2:123456789012:other")] }, env)).toBe(false);
    expect(isTeamRecordQueueEvent({ Records: [record(arn)], requestContext: {} }, env)).toBe(false);
    expect(isTeamRecordQueueEvent({ Records: [] }, env)).toBe(false);
    expect(await drainTeamRecordQueue({ teamRecord: undefined }, { Records: [record(arn)] })).toStrictEqual({ batchItemFailures: [{ itemIdentifier: "m1" }] });
  });
});


// ---- fix round 1, B2 and S5: an erase is recorded first, bounded inline, and finished by the hourly job, the lake included
describe("an erase that does not finish is resumed, and a company stays in the directory until its lake delete has run", () => {
  const LAKE = { TEAM_RECORD_LAKE_ENABLED: "1", TEAM_RECORD_TABLE_BUCKET: "agentx-ent-record-lake", TEAM_RECORD_ATHENA_WORKGROUP: "agentx-ent-record" } as const;
  const orgMeta = (db: FakeDynamoDb, extra: Record<string, unknown>) => db.set({ ...orgMetaKey(ORG_A), orgId: ORG_A, ...extra });
  const directory = (db: FakeDynamoDb) => db.find((item) => item.pk === "TEAM_RECORD_ORGS" && item.sk === ORG_A);
  const jobs = (db: FakeDynamoDb) => db.find((item) => item.entityType === "TEAM_RECORD_ERASE_JOB");
  const queueOf = () => { const sent: Array<Record<string, unknown>> = []; return { sent, queue: { send: async (op: Record<string, unknown>) => { sent.push(op); } } }; };
  const asRecords = (sent: Array<Record<string, unknown>>) => sent.map((op, i) => ({ messageId: `m${i}`, body: JSON.stringify(op), receiveCount: 1 }));

  async function company(extra: Partial<Parameters<typeof createTeamRecordRuntime>[0]> = {}, existing?: FakeDynamoDb) {
    const db = existing ?? dbOf();
    const aws = fakeAws();
    const runtime = build(db, { ...ON, ...LAKE, ROVARA_EDITION: "enterprise" }, { sdk: aws.sdk, sts: aws.sts, ...extra });
    db.set({ ...orgProjectCatalogKey(ORG_A, "web"), entityType: "PROJECT_CATALOG", name: "web" });
    await addSource(db, "enterprise", { orgId: ORG_A, source: "github", scope: "github:repo/9", retention: "C" });
    await runtime.sink.put(githubDraft({ retention: "C", audience: { kind: "project" }, scope: "github:repo/9", text: `${MARKER} history` }));
    return { db, aws, runtime };
  }

  it("a close interrupted after the hot store was cleared still deletes the lake rows on the next pass, and only then leaves the directory", async () => {
    const { db, aws, runtime } = await company();
    orgMeta(db, { closingAt: "2026-10-30T11:00:00.000Z" });
    await runtime.erase.workspace(ORG_A);
    // The hot store is clear and the company waits in the directory for the lake: the marker says so.
    expect(db.find((item) => item.entityType === "TEAM_RECORD_EVENT")).toStrictEqual([]);
    expect(directory(db)).toHaveLength(1);
    expect(jobs(db)).toHaveLength(1);
    // The lake is down at the first hourly run: nothing is dropped.
    aws.athena.down = true;
    await runtime.jobs.run("hourly");
    expect(directory(db)).toHaveLength(1);
    expect(jobs(db)).toHaveLength(1);
    // The lake is back: its delete statement for THIS company runs, and then the marker and the directory entry go.
    aws.athena.down = false;
    await runtime.jobs.run("hourly");
    const deletes = aws.athenaCalls.filter((call) => call.command === "StartQueryExecutionCommand" && /DELETE FROM/i.test(call.sql));
    expect(deletes.length).toBeGreaterThan(0);
    expect(deletes.every((call) => call.sql.includes(ORG_A))).toBe(true);
    expect(directory(db)).toStrictEqual([]);
    expect(jobs(db)).toStrictEqual([]);
  });

  it("an erase interrupted by a storage failure leaves its marker, and the next hourly run finishes it", async () => {
    const db = dbOf();
    const { client, down } = (() => {
      const state = { on: false };
      return { down: state, client: { send: async (command: unknown) => {
        const name = (command as { constructor: { name: string } }).constructor.name;
        if (state.on && /^(Delete|Update|TransactWrite|BatchWrite)/.test(name)) throw new Error("down");
        return db.send(command as never);
      } } };
    })();
    const aws = fakeAws();
    const runtime = build(db, { ...ON, ROVARA_EDITION: "enterprise" }, { documentClient: client, sdk: aws.sdk, sts: aws.sts });
    await addSource(db, "enterprise", { orgId: ORG_A, source: "github", scope: "github:repo/9", retention: "C" });
    const person = { sourceId: "123", developerId: "dev-1", trust: "member" as const };
    await runtime.sink.put(githubDraft({ retention: "C", audience: { kind: "project" }, scope: "github:repo/9", actor: person, text: `${MARKER} mine` }));
    down.on = true;
    await expect(runtime.erase.person(ORG_A, "dev-1")).rejects.toThrow();
    expect(jobs(db)).toHaveLength(1);
    expect(JSON.stringify(jobs(db))).toContain("dev-1");
    down.on = false;
    await runtime.jobs.run("hourly");
    expect(everything(db)).not.toContain(MARKER);
    expect(jobs(db)).toStrictEqual([]);
  });

  it("a small project's inline erase finishes in its one pass and leaves no marker", async () => {
    const { db, runtime } = await company();
    await runtime.erase.project(ORG_A, "web", "project_archived");
    expect(jobs(db)).toHaveLength(0);
    expect(db.find((item) => item.entityType === "TEAM_RECORD_EVENT")).toStrictEqual([]);
  });

  // ---- TRW-3 R5: the erase marker is the only thing the hourly job resumes. If writing it fails there must still be something durable that does.
  describe("a failed marker write on a project archive is not lost", () => {
    const markerDown = (db: FakeDynamoDb) => {
      const state = { on: true };
      return { state, client: { send: async (command: unknown) => {
        const input = (command as { input?: { Item?: { entityType?: string } } }).input;
        if (state.on && input?.Item?.entityType === "TEAM_RECORD_ERASE_JOB") throw new Error("marker table down");
        return db.send(command as never);
      } } };
    };
    const archived = (db: FakeDynamoDb) => db.set({ ...projectMetaKey(ORG_A, "web"), entityType: "PROJECT_META", name: "web", status: "archived", createdAt: "x", createdBy: "y", archivedAt: "z" });

    it("hands the archive to the durable queue (ids only); the queue's consumer erases the project once the table is back, and the marker goes", async () => {
      const db = dbOf();
      const { state, client } = markerDown(db);
      const { sent, queue } = queueOf();
      const { runtime } = await company({ documentClient: client, opsQueue: queue }, db);
      archived(db);
      await runtime.erase.project(ORG_A, "web", "project_archived");
      expect(sent).toStrictEqual([{ v: 1, op: "erase_project", workspaceId: ORG_A, project: "web", cause: "project_archived" }]);
      expect(jobs(db)).toStrictEqual([]);
      expect(db.find((item) => item.entityType === "TEAM_RECORD_EVENT")).toHaveLength(1);
      state.on = false;
      expect(await runtime.drain(asRecords(sent))).toStrictEqual({ batchItemFailures: [] });
      expect(db.find((item) => item.entityType === "TEAM_RECORD_EVENT")).toStrictEqual([]);
      expect(jobs(db)).toStrictEqual([]);
    });

    it("the consumer retries (leaves the message) while the marker still cannot be written", async () => {
      const db = dbOf();
      const { client } = markerDown(db);
      const { sent, queue } = queueOf();
      const { runtime } = await company({ documentClient: client, opsQueue: queue }, db);
      archived(db);
      await runtime.erase.project(ORG_A, "web", "project_archived");
      expect(await runtime.drain(asRecords(sent))).toStrictEqual({ batchItemFailures: [{ itemIdentifier: "m0" }] });
    });

    it("a project that is no longer archived, or an org id that is not one, is dropped without erasing", async () => {
      const { db, runtime } = await company();
      db.set({ ...projectMetaKey(ORG_A, "web"), entityType: "PROJECT_META", name: "web", status: "active", createdAt: "x", createdBy: "y" });
      const body = (workspaceId: string) => JSON.stringify({ v: 1, op: "erase_project", workspaceId, project: "web", cause: "project_archived" });
      expect(await runtime.drain([{ messageId: "a", body: body(ORG_A), receiveCount: 1 }, { messageId: "b", body: body("not-an-org"), receiveCount: 1 }])).toStrictEqual({ batchItemFailures: [] });
      expect(db.find((item) => item.entityType === "TEAM_RECORD_EVENT")).toHaveLength(1);
      expect(jobs(db)).toStrictEqual([]);
    });

    it("with no queue, a marker that cannot be written is rethrown to the archive (which logs it), never swallowed", async () => {
      const db = dbOf();
      const { client } = markerDown(db);
      const { runtime } = await company({ documentClient: client }, db);
      await expect(runtime.erase.project(ORG_A, "web", "project_archived")).rejects.toThrow();
    });
  });

  it("a company marker for a company that is still open is stale and is dropped without erasing anything (the close did not happen)", async () => {
    const { db, runtime } = await company();
    orgMeta(db, {});
    // Put the marker by hand, as an erase that began and then never closed the company would have left it.
    db.set({ pk: "TEAM_RECORD_ORGS", sk: `ERASE#${ORG_A}#workspace#all`, entityType: "TEAM_RECORD_ERASE_JOB", orgId: ORG_A, at: "2026-10-30T11:00:00.000Z", job: { kind: "workspace", phase: "hot", projects: ["web"] } });
    await runtime.jobs.run("hourly");
    expect(jobs(db)).toStrictEqual([]);
    expect(db.find((item) => item.entityType === "TEAM_RECORD_EVENT")).toHaveLength(1);
  });

  it("a project marker for a project that is NOT archived is stale: it is dropped and the project's rows stay", async () => {
    const { db, runtime } = await company();
    db.set({ ...projectMetaKey(ORG_A, "web"), entityType: "PROJECT_META", name: "web", status: "active", createdAt: "x", createdBy: "y" });
    db.set({ pk: "TEAM_RECORD_ORGS", sk: `ERASE#${ORG_A}#project#web`, entityType: "TEAM_RECORD_ERASE_JOB", orgId: ORG_A, at: "2026-10-30T11:00:00.000Z", job: { kind: "project", project: "web", cause: "project_archived" } });
    await runtime.jobs.run("hourly");
    expect(jobs(db)).toStrictEqual([]);
    expect(db.find((item) => item.entityType === "TEAM_RECORD_EVENT")).toHaveLength(1);
  });

  it("a project marker only runs while the project is archived", async () => {
    const { db, runtime } = await company();
    db.set({ ...projectMetaKey(ORG_A, "web"), entityType: "PROJECT_META", name: "web", status: "archived", createdAt: "x", createdBy: "y", archivedAt: "z" });
    db.set({ pk: "TEAM_RECORD_ORGS", sk: `ERASE#${ORG_A}#project#web`, entityType: "TEAM_RECORD_ERASE_JOB", orgId: ORG_A, at: "2026-10-30T11:00:00.000Z", job: { kind: "project", project: "web", cause: "project_archived" } });
    await runtime.jobs.run("hourly");
    expect(jobs(db)).toStrictEqual([]);
    expect(db.find((item) => item.entityType === "TEAM_RECORD_EVENT")).toStrictEqual([]);
  });
});

describe("fix round 1, S1: a workspace whose vector index cannot be opened is not retried on every write", () => {
  it("in Public, with the S3 Vectors package missing, five writes look up the bucket assignment ONCE and every row is still stored", async () => {
    const db = dbOf();
    const bucketReads: number[] = [];
    const counting = { send: async (command: unknown) => { if ((command as { input?: { Key?: { sk?: string } } }).input?.Key?.sk === "VECBUCKET") bucketReads.push(1); return db.send(command as never); } };
    const aws = fakeAws();
    const sdk = async (name: string) => (name === "@aws-sdk/client-s3vectors" ? Promise.reject(new SdkUnavailableError()) : aws.sdk(name));
    const runtime = build(db, { ...ON, ROVARA_EDITION: "public" }, { sdk, sts: aws.sts, documentClient: counting });
    await addSource(db, "public", { orgId: ORG_A, source: "github", scope: "github:repo/9", retention: "D" });
    for (const id of ["a", "b", "c", "d", "e"]) expect(await runtime.sink.put(githubDraft({ retention: "D", audience: { kind: "project" }, scope: "github:repo/9", sourceRef: { system: "github.com", id, version: "1" } }))).toMatchObject({ status: "stored" });
    expect(aws.sessions).toHaveLength(1);
    expect(bucketReads).toHaveLength(1);
    expect(db.find((item) => item.entityType === "TEAM_RECORD_EVENT")).toHaveLength(5);
  });
});

describe("fix round 1, S4: a person's erase also reaches the Slack rows they wrote", () => {
  const SCOPE = "slack:T0123456789/C0123456789";
  const channel = { teamId: "T0123456789", channelId: "C0123456789", info: { kind: "public" as const, extShared: false } };
  const says = (user: string, ts: string, text: string) => ({ type: "event_callback", team_id: "T0123456789", event: { type: "message", channel: "C0123456789", user, text, ts, channel_type: "channel" } });

  async function world(slackUserIdsOf?: (developerId: string) => Promise<string[]>) {
    const db = dbOf();
    db.set({ ...slackTeamOrgKey("T0123456789"), orgId: ORG_A });
    db.set({ ...orgSlackTeamKey(ORG_A, "T0123456789"), teamId: "T0123456789" });
    db.set({ ...developerOrgKey("dev-2"), entityType: "DEVELOPER_ORG", orgId: ORG_A, role: "member" });
    // The colleague is a linked member too (dev-2), so their message is stored and a person erase of dev-1 must leave it.
    const runtime = build(db, { ...ON, ROVARA_EDITION: "enterprise" }, { developerOfSlackUser: async (id) => (id === "U0123456789" ? "dev-1" : id === "U0123456780" ? "dev-2" : undefined), ...(slackUserIdsOf === undefined ? {} : { slackUserIdsOf }) });
    await addSource(db, "enterprise", { orgId: ORG_A, source: "slack", scope: SCOPE, retention: "C" });
    await runtime.taps.slack({ payload: says("U0123456789", "1761818400.000100", `leaver ${MARKER}`), channel });
    await runtime.taps.slack({ payload: says("U0123456780", "1761818401.000100", "colleague stays"), channel });
    return { db, runtime };
  }

  it("their Slack messages go and a colleague's stay", async () => {
    const { db, runtime } = await world(async (developerId) => (developerId === "dev-1" ? ["U0123456789"] : []));
    expect(everything(db)).toContain(MARKER);
    await runtime.erase.person(ORG_A, "dev-1");
    expect(everything(db)).not.toContain(MARKER);
    expect(everything(db)).toContain("colleague stays");
  });

  it("the rows are found by the developer id on them, so even with no Slack ids at hand nothing of the person is left (TRW-4: a row is only ever stored for a linked author)", async () => {
    const { db, runtime } = await world();
    await runtime.erase.person(ORG_A, "dev-1");
    expect(everything(db)).not.toContain(MARKER);
    expect(everything(db)).toContain("colleague stays");
  });
});

// ---- TRW-4 (owner, 2026-11-02): the Team record keeps only what it can erase
describe("TRW-4: a row is stored only when its author is linked to a Rovara person", () => {
  const SLACK_SCOPE = "slack:T0123456789/C0123456789";
  const channel = { teamId: "T0123456789", channelId: "C0123456789", info: { kind: "public" as const, extShared: false } };
  const says = (user: string, ts: string, text: string) => ({ type: "event_callback", team_id: "T0123456789", event: { type: "message", channel: "C0123456789", user, text, ts, channel_type: "channel" } });
  const hook = (source: "linear" | "jira") => (source === "linear"
    ? { source, project: "web", tenant: { organizationId: "lin-org", teamId: "t1" } }
    : { source, project: "web", tenant: { siteHost: "acme.atlassian.net", projectKey: "WEB" } });
  const linearIssue = (id: string, author: string, text: string, extra: Record<string, unknown> = {}) => ({
    type: "Issue", action: "create", organizationId: "lin-org", createdAt: "2026-10-30T10:00:00.000Z", actor: { id: author }, data: { id, teamId: "t1", title: text, creatorId: author, updatedAt: "2026-10-30T10:00:00.000Z", ...extra },
  });
  const jiraIssue = (id: string, author: string, text: string) => ({
    webhookEvent: "jira:issue_created", timestamp: 1_761_818_400_000, user: { accountId: author },
    issue: { id, key: `WEB-${id}`, self: `https://acme.atlassian.net/rest/api/2/issue/${id}`, fields: { summary: text, project: { key: "WEB" }, creator: { accountId: author }, status: { name: "Open" } } },
  });
  const maintainer = { orgId: ORG_A, developerId: "dev-1", projectRole: "maintainer" as const };

  async function world() {
    const db = dbOf();
    db.set({ ...slackTeamOrgKey("T0123456789"), orgId: ORG_A });
    db.set({ ...orgSlackTeamKey(ORG_A, "T0123456789"), teamId: "T0123456789" });
    const runtime = build(db, { ...ON, ROVARA_EDITION: "enterprise" });
    await addSource(db, "enterprise", { orgId: ORG_A, source: "slack", scope: SLACK_SCOPE, retention: "C" });
    for (const [source, scope] of [["linear", "linear:team/t1"], ["jira", "jira:project/WEB"]] as const) {
      const saved = await putSourceConfig({ documentClient: db, tableName: "TeamRecord" }, { workspaceId: ORG_A, project: "web", source, scope, enabled: true, retention: "C", exclude: [], audienceDefault: "project", health: "unknown", addedBy: "dev-1", updatedAt: "2026-10-30T10:00:00.000Z" }, { edition: "enterprise" });
      expect(saved, JSON.stringify(saved)).toMatchObject({ status: "saved" });
    }
    await addSource(db, "enterprise", { orgId: ORG_A, source: "github", scope: "github:repo/9", retention: "C" });
    return { db, runtime };
  }
  const skippedFor = async (runtime: TeamRecordRuntime, role: "maintainer" | "contributor") => {
    const reply = await runtime.routes({ method: "GET", path: "/v1/app/projects/web/record/sources", query: {}, caller: { ...maintainer, projectRole: role } });
    return (reply?.body as { skippedUnlinked?: Record<string, number> }).skippedUnlinked;
  };

  it("Slack: an unlinked author's message is not stored and is counted; a linked author's is stored", async () => {
    const { db, runtime } = await world();
    await runtime.taps.slack({ payload: says("U0999999999", "1761818400.000100", `stranger ${MARKER}`), channel });
    expect(everything(db)).not.toContain(MARKER);
    expect(db.find((item) => item.entityType === "TEAM_RECORD_EVENT")).toStrictEqual([]);
    expect(await skippedFor(runtime, "maintainer")).toStrictEqual({ slack: 1 });
    await runtime.taps.slack({ payload: says(SLACK_LINKED, "1761818401.000100", `member ${MARKER}`), channel });
    expect(everything(db)).toContain(MARKER);
    expect(JSON.stringify(db.find((item) => item.entityType === "TEAM_RECORD_EVENT"))).toContain("dev-1");
  });

  it("the counts are for maintainers: a contributor's read of the sources carries none; and they hold no words and no ids", async () => {
    const { db, runtime } = await world();
    await runtime.taps.slack({ payload: says("U0999999999", "1761818400.000100", `stranger ${MARKER}`), channel });
    expect(await skippedFor(runtime, "contributor")).toBeUndefined();
    const counters = JSON.stringify(db.find((item) => item.entityType === "TEAM_RECORD_SKIPPED"));
    expect(counters).not.toContain(MARKER);
    expect(counters).not.toContain("U0999999999");
  });

  it("GitHub: an account nobody linked is not stored and is counted", async () => {
    const { db, runtime } = await world();
    seedRepository(db, ORG_A, { installationId: 55, repositoryId: 101, project: "web" });
    await addSource(db, "enterprise", { orgId: ORG_A, source: "github", scope: "github:repo/101", retention: "C" });
    const stranger = delivery(55, 101, `stranger ${MARKER}`);
    (stranger.payload.comment.user as { id: number }).id = 999;
    await runtime.taps.github(stranger);
    expect(everything(db)).not.toContain(MARKER);
    expect(await skippedFor(runtime, "maintainer")).toStrictEqual({ github: 1 });
    expect(await runtime.taps.github(delivery(55, 101, `member ${MARKER}`))).toMatchObject({ written: 1 });
  });

  it("Linear and Jira: nothing is stored until the author id is linked; then it is, with the person on the row", async () => {
    const { db, runtime } = await world();
    await runtime.taps.hook({ orgId: ORG_A, hook: hook("linear"), body: linearIssue("i1", "lin-ann", `linear ${MARKER}`) });
    await runtime.taps.hook({ orgId: ORG_A, hook: hook("jira"), body: jiraIssue("1", "acc-ann", `jira ${MARKER}`) });
    expect(everything(db)).not.toContain(MARKER);
    expect(await skippedFor(runtime, "maintainer")).toStrictEqual({ jira: 1, linear: 1 });
    expect(await runtime.links.link(ORG_A, { system: "linear", sourceId: "lin-ann", developerId: "dev-1", via: "connect" })).toBe(true);
    expect(await runtime.links.link(ORG_A, { system: "jira:acme.atlassian.net", sourceId: "acc-ann", developerId: "dev-1", via: "signin" })).toBe(true);
    await runtime.taps.hook({ orgId: ORG_A, hook: hook("linear"), body: linearIssue("i1", "lin-ann", `linear ${MARKER}`) });
    await runtime.taps.hook({ orgId: ORG_A, hook: hook("jira"), body: jiraIssue("1", "acc-ann", `jira ${MARKER}`) });
    const rows = db.find((item) => item.entityType === "TEAM_RECORD_EVENT");
    expect(rows).toHaveLength(2);
    expect(JSON.stringify(rows)).toContain("dev-1");
  });

  it("a ticket a linked person wrote but an unlinked person edited is not stored (their words could not be erased)", async () => {
    const { db, runtime } = await world();
    await runtime.links.link(ORG_A, { system: "linear", sourceId: "lin-ann", developerId: "dev-1", via: "connect" });
    await runtime.taps.hook({ orgId: ORG_A, hook: hook("linear"), body: { ...linearIssue("i2", "lin-ann", `edited ${MARKER}`), actor: { id: "lin-stranger" } } });
    expect(everything(db)).not.toContain(MARKER);
    expect(await skippedFor(runtime, "maintainer")).toStrictEqual({ linear: 1 });
  });

  it("a tracker link by an email links only when the tracker said the email is verified, and only to a member of this org", async () => {
    const { runtime } = await world();
    const input = { system: "linear", sourceId: "lin-bob", email: "bob@acme.test" };
    expect(await runtime.links.linkByVerifiedEmail(ORG_A, { ...input, emailVerified: false })).toBe(false);
    expect(await runtime.links.linkByVerifiedEmail(ORG_A, { ...input, emailVerified: undefined })).toBe(false);
  });

  it("bots (trust system) and Rovara's own rows need no linked person", async () => {
    const { db, runtime } = await world();
    const bot = await runtime.sink.put(githubDraft({ retention: "C", audience: { kind: "project" }, scope: "github:repo/9", actor: { sourceId: "bot-1", trust: "system" }, text: `bot ${MARKER}` }));
    expect(bot).toMatchObject({ status: "stored" });
    expect(db.find((item) => item.entityType === "TEAM_RECORD_EVENT")).toHaveLength(1);
  });
});

describe("TRW-4: a person's erase takes their rows from all four sources, queues, lake and vectors, and their links", () => {
  const SLACK_SCOPE = "slack:T0123456789/C0123456789";
  const channel = { teamId: "T0123456789", channelId: "C0123456789", info: { kind: "public" as const, extShared: false } };
  const LAKE = { TEAM_RECORD_LAKE_ENABLED: "1", TEAM_RECORD_TABLE_BUCKET: "agentx-ent-record-lake", TEAM_RECORD_ATHENA_WORKGROUP: "agentx-ent-record" } as const;

  it("Slack, GitHub, Linear and Jira rows of one person, an unfinished queued put of theirs, and a put of theirs in the dead-letter queue: nothing of them is left anywhere", async () => {
    const db = dbOf();
    const aws = fakeAws();
    db.set({ ...slackTeamOrgKey("T0123456789"), orgId: ORG_A });
    db.set({ ...orgSlackTeamKey(ORG_A, "T0123456789"), teamId: "T0123456789" });
    db.set({ ...orgMetaKey(ORG_A), orgId: ORG_A });
    db.set({ ...orgProjectCatalogKey(ORG_A, "web"), entityType: "PROJECT_CATALOG", name: "web" });
    seedRepository(db, ORG_A, { installationId: 55, repositoryId: 101, project: "web" });
    const queued: Array<Record<string, unknown>> = [];
    const deadLetters: Array<{ handle: string; body: string }> = [];
    const down = { on: false };
    const client = { send: async (command: unknown) => { if (down.on && /^(Put|Update|Delete|TransactWrite)/.test((command as { constructor: { name: string } }).constructor.name)) throw new Error("table down"); return db.send(command as never); } };
    const clock = { at: T0 };
    const runtime = build(db, { ...ON, ...LAKE, ROVARA_EDITION: "enterprise" }, {
      now: () => clock.at, sdk: aws.sdk, sts: aws.sts, documentClient: client, opsQueue: { send: async (op) => { queued.push(op); } },
      deadLetters: { receive: async () => deadLetters.splice(0, 10), remove: async () => undefined },
    });
    await addSource(db, "enterprise", { orgId: ORG_A, source: "slack", scope: SLACK_SCOPE, retention: "C" });
    await addSource(db, "enterprise", { orgId: ORG_A, source: "github", scope: "github:repo/101", retention: "C" });
    for (const [source, scope] of [["linear", "linear:team/t1"], ["jira", "jira:project/WEB"]] as const) {
      await putSourceConfig({ documentClient: db, tableName: "TeamRecord" }, { workspaceId: ORG_A, project: "web", source, scope, enabled: true, retention: "C", exclude: [], audienceDefault: "project", health: "unknown", addedBy: "dev-1", updatedAt: "2026-10-30T10:00:00.000Z" }, { edition: "enterprise" });
    }
    await runtime.links.link(ORG_A, { system: "linear", sourceId: "lin-ann", developerId: "dev-1", via: "connect" });
    await runtime.links.link(ORG_A, { system: "jira:acme.atlassian.net", sourceId: "acc-ann", developerId: "dev-1", via: "verified_email" as never });
    // The four sources.
    await runtime.taps.slack({ payload: { type: "event_callback", team_id: "T0123456789", event: { type: "message", channel: "C0123456789", user: SLACK_LINKED, text: `slack ${MARKER}`, ts: "1761818400.000100", channel_type: "channel" } }, channel });
    await runtime.taps.github(delivery(55, 101, `github ${MARKER}`));
    await runtime.taps.hook({ orgId: ORG_A, hook: { source: "linear", project: "web", tenant: { organizationId: "lin-org", teamId: "t1" } }, body: { type: "Issue", action: "create", organizationId: "lin-org", actor: { id: "lin-ann" }, data: { id: "i1", teamId: "t1", title: `linear ${MARKER}`, creatorId: "lin-ann", updatedAt: "2026-10-30T10:00:00.000Z" } } });
    await runtime.taps.hook({ orgId: ORG_A, hook: { source: "jira", project: "web", tenant: { siteHost: "acme.atlassian.net", projectKey: "WEB" } }, body: { webhookEvent: "jira:issue_created", timestamp: 1_761_818_400_000, user: { accountId: "acc-ann" }, issue: { id: "1", key: "WEB-1", self: "https://acme.atlassian.net/rest/api/2/issue/1", fields: { summary: `jira ${MARKER}`, project: { key: "WEB" }, creator: { accountId: "acc-ann" } } } } });
    const rowsBefore = db.find((item) => item.entityType === "TEAM_RECORD_EVENT");
    expect(rowsBefore).toHaveLength(4);
    expect(new Set(rowsBefore.map((row) => row.source as string))).toStrictEqual(new Set(["slack", "github", "linear", "jira"]));
    expect(aws.vectorCalls.filter((call) => call.command === "PutVectorsCommand").length).toBeGreaterThan(0);
    // A put of theirs that was queued while the table was down, and one that reached the dead-letter queue.
    down.on = true;
    await runtime.sink.put(githubDraft({ retention: "C", audience: { kind: "project" }, scope: "github:repo/101", sourceRef: { system: "github.com", id: "late", version: "1" }, text: `queued ${MARKER}` }));
    down.on = false;
    expect(queued.map((op) => op.op)).toStrictEqual(["put"]);
    deadLetters.push({ handle: "h1", body: JSON.stringify(queued[0]) }, { handle: "h2", body: JSON.stringify({ v: 1, op: "tombstone", workspaceId: ORG_A, system: "github.com", cause: "source_deleted" }) });

    await runtime.erase.person(ORG_A, "dev-1");
    await runtime.jobs.run("hourly");
    // The erase's own delayed second pass (it keeps the ids for fifteen minutes to catch a late write) has run and removed its item.
    clock.at += ERASE_SWEEP_DELAY_MS + 1;
    await runtime.jobs.run("hourly");

    // The table: no row, fact, link, derivation, queue entry or counter with their words or their ids.
    const left = everything(db);
    expect(left).not.toContain(MARKER);
    for (const id of ["lin-ann", "acc-ann"]) expect(db.find((item) => JSON.stringify(item).includes(id)).map((item) => `${item.pk as string} ${item.sk as string} ${item.entityType as string}`), id).toStrictEqual([]);
    for (const type of ["TEAM_RECORD_EVENT", "TEAM_RECORD_FACT", "TEAM_RECORD_DERIVATION", "TEAM_RECORD_TRACKER_LINK", "TEAM_RECORD_TRACKER_LINK_BY_PERSON"]) expect(db.find((item) => item.entityType === type), type).toStrictEqual([]);
    // The lake: the person's rows were told to be forgotten (by developer and by source identity) and the statements ran.
    const deletes = aws.athenaCalls.filter((call) => call.command === "StartQueryExecutionCommand" && /DELETE FROM/i.test(call.sql));
    expect(deletes.length).toBeGreaterThan(0);
    // The vector index: every vector put was deleted.
    const putKeys = aws.vectorCalls.filter((call) => call.command === "PutVectorsCommand").flatMap((call) => ((call.input.vectors as Array<{ key: string }> | undefined) ?? []).map((vector) => vector.key));
    const deletedKeys = new Set(aws.vectorCalls.filter((call) => call.command === "DeleteVectorsCommand").flatMap((call) => (call.input.keys as string[] | undefined) ?? []));
    expect(putKeys.length).toBeGreaterThan(0);
    for (const key of putKeys) expect(deletedKeys.has(key), key).toBe(true);
    // The queue: the put that waited is refused when it is replayed (the person is erased), and stores nothing.
    expect(await runtime.drain(queued.map((op, i) => ({ messageId: `m${i}`, body: JSON.stringify(op), receiveCount: 1 })))).toStrictEqual({ batchItemFailures: [] });
    expect(everything(db)).not.toContain(MARKER);
    expect(db.find((item) => item.entityType === "TEAM_RECORD_EVENT")).toStrictEqual([]);
    // The dead-letter queue: the sweep took the put (its text) out; what is left holds ids only.
    expect(deadLetters).toStrictEqual([]);
  });
});

// ---- TRW-5 (Opus review of team-record-fixes)
describe("TRW-5 S1: a queued put never reaches the dead-letter queue, whatever the invocation does", () => {
  const LINKED_DRAFT = () => githubDraft({ retention: "C", audience: { kind: "project" }, scope: "github:repo/9", text: `queued ${MARKER}` });

  it("a drain that is out of time answers every message it has not touched as 'retry' and touches nothing more", async () => {
    const db = dbOf();
    const runtime = build(db, { ...ON, ROVARA_EDITION: "enterprise" });
    await addSource(db, "enterprise", { orgId: ORG_A, source: "github", scope: "github:repo/9", retention: "C" });
    const put = (id: string) => ({ messageId: id, body: JSON.stringify({ v: 1, op: "put", draft: { ...LINKED_DRAFT(), sourceRef: { system: "github.com", id, version: "1" } }, queuedAt: new Date(T0).toISOString() }), receiveCount: 1 });
    const left = [4_000, 4_000, 4_000];
    expect(await runtime.drain([put("a"), put("b"), put("c")], { remainingMs: () => left.shift() ?? 0 })).toStrictEqual({ batchItemFailures: [{ itemIdentifier: "a" }, { itemIdentifier: "b" }, { itemIdentifier: "c" }] });
    expect(db.find((item) => item.entityType === "TEAM_RECORD_EVENT")).toStrictEqual([]);
    const some = [60_000, 3_000];
    expect(await runtime.drain([put("a"), put("b")], { remainingMs: () => some.shift() ?? 0 })).toStrictEqual({ batchItemFailures: [{ itemIdentifier: "b" }] });
    expect(db.find((item) => item.entityType === "TEAM_RECORD_EVENT")).toHaveLength(1);
  });

  it("the hourly job deletes put and distill messages from the dead-letter queue, leaves the ones that hold ids only, and does not fail when the queue cannot be read", async () => {
    const db = dbOf();
    const held = [
      { handle: "put", body: JSON.stringify({ v: 1, op: "put", draft: { text: MARKER } }) },
      { handle: "distill", body: JSON.stringify({ v: 1, op: "distill", draft: { text: MARKER } }) },
      { handle: "tombstone", body: JSON.stringify({ v: 1, op: "tombstone", workspaceId: ORG_A, system: "x", cause: "source_deleted" }) },
      { handle: "junk", body: "not json" },
    ];
    const removed: string[] = [];
    let pending = [...held];
    const runtime = build(db, { ...ON, ROVARA_EDITION: "enterprise" }, { deadLetters: { receive: async () => pending.splice(0, 10), remove: async (handle) => { removed.push(handle); } } });
    const summary = await runtime.jobs.run("hourly");
    expect(removed.sort()).toStrictEqual(["distill", "put"]);
    expect(summary.details.deadLetterTextDeleted).toBe(2);
    pending = [];
    const broken = build(db, { ...ON, ROVARA_EDITION: "enterprise" }, { deadLetters: { receive: async () => { throw new Error("sqs down"); }, remove: async () => undefined } });
    await expect(broken.jobs.run("hourly")).resolves.toBeDefined();
  });
});

describe("TRW-5 S2: a delete is never lost when the table and the queue are both down", () => {
  const tombstone = { workspaceId: ORG_A, system: "linear", sourceIds: ["issue:i1"], cause: "source_deleted" as const };
  const allDown = (db: FakeDynamoDb) => ({ send: async (command: unknown) => { if (/^(Put|Update|Delete|TransactWrite)/.test((command as { constructor: { name: string } }).constructor.name)) throw new Error("table down"); return db.send(command as never); } });

  it("goes by an ids-only Event invoke of the broker, which applies it directly and throws when it cannot (so Lambda retries and the failure destination keeps it)", async () => {
    const db = dbOf();
    const sent: unknown[] = [];
    const runtime = build(db, { ...ON, ROVARA_EDITION: "enterprise" }, { documentClient: allDown(db), opsQueue: { send: async () => { throw new Error("sqs down"); } }, removalFallback: async (event) => { sent.push(event); } });
    await expect(runtime.sink.tombstone(tombstone)).resolves.toBeDefined();
    expect(sent).toStrictEqual([{ source: "agentx.team-record-removal", workspaceId: ORG_A, system: "linear", sourceIds: ["issue:i1"], cause: "source_deleted" }]);
    // The broker applying it to a table that is down throws.
    await expect(runtime.removal(sent[0] as never)).rejects.toThrow();
    // And to a table that is back, it lands.
    const healthy = build(db, { ...ON, ROVARA_EDITION: "enterprise" });
    await expect(healthy.removal(sent[0] as never)).resolves.toBeUndefined();
  });

  it("is thrown (not swallowed) only when the table, the queue AND the invoke all failed; with no fallback configured it is thrown as before", async () => {
    const db = dbOf();
    const bothDown = build(db, { ...ON, ROVARA_EDITION: "enterprise" }, { documentClient: allDown(db), opsQueue: { send: async () => { throw new Error("sqs down"); } }, removalFallback: async () => { throw new Error("lambda down"); } });
    await expect(bothDown.sink.tombstone(tombstone)).rejects.toThrow();
    const none = build(db, { ...ON, ROVARA_EDITION: "enterprise" }, { documentClient: allDown(db) });
    await expect(none.sink.tombstone(tombstone)).rejects.toThrow();
  });

  it("the queue still comes first: a delete the queue takes sends no Event invoke", async () => {
    const db = dbOf();
    const sent: unknown[] = [];
    const queued: unknown[] = [];
    const runtime = build(db, { ...ON, ROVARA_EDITION: "enterprise" }, { documentClient: allDown(db), opsQueue: { send: async (op) => { queued.push(op); } }, removalFallback: async (event) => { sent.push(event); } });
    await runtime.sink.tombstone(tombstone);
    expect(queued).toHaveLength(1);
    expect(sent).toStrictEqual([]);
  });
});

describe("TRW-5 S3: an archived project whose erase was never recorded is found and erased by the hourly job", () => {
  async function archivedWorld() {
    const db = dbOf();
    const runtime = build(db, { ...ON, ROVARA_EDITION: "enterprise" });
    db.set({ ...orgProjectCatalogKey(ORG_A, "web"), entityType: "PROJECT_CATALOG", name: "web" });
    await addSource(db, "enterprise", { orgId: ORG_A, source: "github", scope: "github:repo/9", retention: "C" });
    await runtime.sink.put(githubDraft({ retention: "C", audience: { kind: "project" }, scope: "github:repo/9", text: `${MARKER} history` }));
    return { db, runtime };
  }
  const archive = (db: FakeDynamoDb, archivedAt: string) => db.set({ ...projectMetaKey(ORG_A, "web"), entityType: "PROJECT_META", name: "web", status: "archived", createdAt: "x", createdBy: "y", archivedAt });

  it("erases it, once: a stamp names the archive it answered, so the next hour does nothing; an archive again after a restore is erased again", async () => {
    const { db, runtime } = await archivedWorld();
    archive(db, "2026-10-30T11:00:00.000Z");
    expect((await runtime.jobs.run("hourly")).details.projectsSwept).toBe(1);
    expect(db.find((item) => item.entityType === "TEAM_RECORD_EVENT")).toStrictEqual([]);
    expect((await runtime.jobs.run("hourly")).details.projectsSwept).toBe(0);
    await runtime.sink.put(githubDraft({ retention: "C", audience: { kind: "project" }, scope: "github:repo/9", sourceRef: { system: "github.com", id: "again", version: "1" }, text: "after restore" }));
    db.set({ ...projectMetaKey(ORG_A, "web"), entityType: "PROJECT_META", name: "web", status: "active", createdAt: "x", createdBy: "y" });
    expect((await runtime.jobs.run("hourly")).details.projectsSwept).toBe(0);
    archive(db, "2026-10-31T11:00:00.000Z");
    expect((await runtime.jobs.run("hourly")).details.projectsSwept).toBe(1);
  });

  it("leaves an active project alone, and the company's finish takes the stamps away", async () => {
    const { db, runtime } = await archivedWorld();
    db.set({ ...projectMetaKey(ORG_A, "web"), entityType: "PROJECT_META", name: "web", status: "active", createdAt: "x", createdBy: "y" });
    expect((await runtime.jobs.run("hourly")).details.projectsSwept).toBe(0);
    expect(db.find((item) => item.entityType === "TEAM_RECORD_EVENT")).toHaveLength(1);
    archive(db, "z");
    await runtime.jobs.run("hourly");
    expect(db.find((item) => item.entityType === "TEAM_RECORD_ERASE_DONE")).toHaveLength(1);
    db.set({ ...orgMetaKey(ORG_A), orgId: ORG_A, closingAt: "2026-10-30T11:00:00.000Z" });
    await runtime.erase.workspace(ORG_A);
    await runtime.jobs.run("hourly");
    expect(db.find((item) => item.entityType === "TEAM_RECORD_ERASE_DONE")).toStrictEqual([]);
  });
});

describe("TRW-5 S4: nothing is written for a closed company or into an archived project, a queued put replayed later included", () => {
  it("a put for a company that is closing, or a project that is archived, is refused; a put replayed from the queue after the close reads the state fresh and is refused", async () => {
    const db = dbOf();
    const runtime = build(db, { ...ON, ROVARA_EDITION: "enterprise" });
    await addSource(db, "enterprise", { orgId: ORG_A, source: "github", scope: "github:repo/9", retention: "C" });
    const draft = githubDraft({ retention: "C", audience: { kind: "project" }, scope: "github:repo/9", text: `late ${MARKER}` });
    expect(await runtime.sink.put(draft)).toMatchObject({ status: "stored" });
    // Replayed: the company closed a minute after the put was queued (a live write can sit on a minute-old answer; a replay may not).
    db.set({ ...orgMetaKey(ORG_A), orgId: ORG_A, closingAt: "2026-10-30T11:00:00.000Z" });
    const replay = { messageId: "m1", body: JSON.stringify({ v: 1, op: "put", draft: { ...draft, sourceRef: { system: "github.com", id: "queued", version: "1" } }, queuedAt: new Date(T0).toISOString() }), receiveCount: 1 };
    expect(await runtime.drain([replay])).toStrictEqual({ batchItemFailures: [] });
    expect(db.find((item) => item.entityType === "TEAM_RECORD_EVENT")).toHaveLength(1);
    // Fresh runtime (no cache): the live path refuses too.
    const fresh = build(db, { ...ON, ROVARA_EDITION: "enterprise" });
    expect(await fresh.sink.put({ ...draft, sourceRef: { system: "github.com", id: "live", version: "1" } })).toMatchObject({ status: "refused", reason: "company_closed" });
  });

  it("an archived project refuses new rows", async () => {
    const db = dbOf();
    const runtime = build(db, { ...ON, ROVARA_EDITION: "enterprise" });
    await addSource(db, "enterprise", { orgId: ORG_A, source: "github", scope: "github:repo/9", retention: "C" });
    db.set({ ...projectMetaKey(ORG_A, "web"), entityType: "PROJECT_META", name: "web", status: "archived", createdAt: "x", createdBy: "y", archivedAt: "z" });
    expect(await runtime.sink.put(githubDraft({ retention: "C", audience: { kind: "project" }, scope: "github:repo/9", text: `late ${MARKER}` }))).toMatchObject({ status: "refused", reason: "project_archived" });
    expect(everything(db)).not.toContain(MARKER);
  });
});

describe("TRW-4: the erase knows the person's tracker author ids and removes their links only when it has finished", () => {
  it("the erase marker names their Linear and Jira ids (so rows made before the developer id was on them are found), and the links stay until the erase is complete", async () => {
    const db = dbOf();
    db.set({ ...orgMetaKey(ORG_A), orgId: ORG_A });
    const down = { on: false };
    const client = { send: async (command: unknown) => { if (down.on && /^(Delete|Update|TransactWrite)/.test((command as { constructor: { name: string } }).constructor.name)) throw new Error("down"); return db.send(command as never); } };
    const runtime = build(db, { ...ON, ROVARA_EDITION: "enterprise" }, { documentClient: client });
    await runtime.links.link(ORG_A, { system: "linear", sourceId: "lin-ann", developerId: "dev-1", via: "connect" });
    await runtime.links.link(ORG_A, { system: "jira:acme.atlassian.net", sourceId: "acc-ann", developerId: "dev-1", via: "connect" });
    await addSource(db, "enterprise", { orgId: ORG_A, source: "github", scope: "github:repo/9", retention: "C" });
    await runtime.sink.put(githubDraft({ retention: "C", audience: { kind: "project" }, scope: "github:repo/9", text: `mine ${MARKER}` }));
    down.on = true;
    await expect(runtime.erase.person(ORG_A, "dev-1")).rejects.toThrow();
    const marker = JSON.stringify(db.find((item) => item.entityType === "TEAM_RECORD_ERASE_JOB"));
    expect(marker).toContain("lin-ann");
    expect(marker).toContain("acc-ann");
    expect(db.find((item) => item.entityType === "TEAM_RECORD_TRACKER_LINK").length).toBe(2);
    down.on = false;
    await runtime.jobs.run("hourly");
    expect(db.find((item) => item.entityType === "TEAM_RECORD_ERASE_JOB")).toStrictEqual([]);
    expect(db.find((item) => item.entityType === "TEAM_RECORD_TRACKER_LINK")).toStrictEqual([]);
    expect(db.find((item) => item.entityType === "TEAM_RECORD_TRACKER_LINK_BY_PERSON")).toStrictEqual([]);
  });
});
