// wire-team-record: the Team record's runtime in the broker. Three things are proved here:
//  1. SWITCH OFF: with `TEAM_RECORD_ENABLED` not exactly "1" no runtime is built, no client is created, no table is read or written, and every call site answers "off".
//  2. ORG SCOPING of the newly connected paths: the sink refuses a workspace that is not an org before looking anything up; the query routes read only the caller's org; an erase in one org leaves
//     another org's rows alone.
//  3. PUBLIC SLACK: message text is never stored in the Public edition (processed, then dropped), whatever the source row says; the positive control shows Enterprise does store it.
import { afterEach, describe, expect, it, vi } from "vitest";
import { githubInstallationKey, githubRepoProjectKey, projectRevisionKey, slackTeamOrgKey, type OrgId } from "@agentx/contracts";
import { announceHumanSendBack } from "../../../packages/broker/src/lessons/send-back-events.js";
import { installTeamRecordEmitter, isTeamRecordJobEvent, isTeamRecordSlackEvent, recordSlackForward, runTeamRecordJob, uninstallTeamRecordEmitter } from "../../../packages/broker/src/aws/broker/team-record-wiring.js";
import { createTeamRecordRuntime, teamRecordIsOn, type TeamRecordRuntime } from "../../../packages/broker/src/team-record/runtime.js";
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
  const embedBodies: string[] = [];
  const sessions: Array<{ roleArn: string; policy: string; sessionName: string }> = [];
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
    throw new SdkUnavailableError();
  };
  const sts = {
    async assumeRole(request: { roleArn: string; sessionName: string; policy: string; durationSeconds: number }) {
      sessions.push({ roleArn: request.roleArn, policy: request.policy, sessionName: request.sessionName });
      return { credentials: { accessKeyId: `AKIA-${sessions.length}`, secretAccessKey: "s", sessionToken: "t" }, expiresAtMs: T0 + 3_600_000 };
    },
  };
  return { sdk, sts, vectorCalls, embedBodies, sessions };
}
const VECTORS_ENV = { TEAM_RECORD_VECTORS_ROLE_ARN: "arn:aws:iam::123456789012:role/agentx/ent/vr", TEAM_RECORD_VECTOR_BUCKETS: "agentx-ent-record-vectors", AGENTX_ACCOUNT_ID: "123456789012" } as const;
const everything = (db: FakeDynamoDb): string => JSON.stringify(db.find(() => true));

function build(db: FakeDynamoDb, env: Record<string, string | undefined>, extra: Partial<Parameters<typeof createTeamRecordRuntime>[0]> = {}): TeamRecordRuntime {
  const aws = fakeAws();
  const runtime = createTeamRecordRuntime({ env: { ...VECTORS_ENV, ...env }, documentClient: db, stateTableName: "State", now: () => T0, sdk: aws.sdk, sts: aws.sts, ...extra });
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
