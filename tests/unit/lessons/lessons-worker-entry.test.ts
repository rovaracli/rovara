// Lessons in production, lane 2 (M4, M6): the LessonsWorker's own entry builds only what learning reads, writes audit events as pending items only, and stops writing the lessons' table once a reflection's deadline has passed.
import { readFileSync } from "node:fs";
import { PutCommand, GetCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it, vi } from "vitest";
import * as builders from "../../../packages/broker/src/audit/events.js";
import { recordAuditSinkOf } from "../../../packages/broker/src/aws/broker/team-record-wiring.js";
import { lessonsWorkerDependencies } from "../../../packages/broker/src/aws/lessons-worker-entry.js";
import { LEARNING_WRITE_DEADLINE, deadlineGuardedClient } from "../../../packages/broker/src/lessons/deadline-guard.js";
import { withLearningAttempt } from "../../../packages/broker/src/lessons/learning-deadline.js";
import { FakeAuditSqs } from "../../support/fake-audit-sqs.js";
import { FakeDynamoDb } from "../../support/fake-dynamodb.js";
import { TEST_ORG } from "../../support/orgs.js";

describe("M4: the lessons' table is not written after the deadline", () => {
  const setup = () => {
    const db = new FakeDynamoDb();
    const guarded = deadlineGuardedClient(db, (table) => table === "record");
    return { db, guarded };
  };
  const put = (table: string, id: string) => new PutCommand({ TableName: table, Item: { pk: id, sk: "x" } });

  it("before the deadline, and outside any attempt, every write goes through", async () => {
    const { db, guarded } = setup();
    await guarded.send(put("record", "a"));
    await withLearningAttempt({ deadlineAt: Date.now() + 10_000, signal: new AbortController().signal }, () => guarded.send(put("record", "b") as never));
    expect(db.get("a", "x")).toBeDefined();
    expect(db.get("b", "x")).toBeDefined();
  });

  it("after the signal is aborted a put, an update and a transaction to the record table are refused BEFORE they are sent, while reads, the State table and the ledger's writes still go through", async () => {
    const { db, guarded } = setup();
    db.set({ pk: "keep", sk: "x", n: 1 });
    const controller = new AbortController();
    const spy = vi.spyOn(db, "send");
    await withLearningAttempt({ deadlineAt: Date.now() + 10_000, signal: controller.signal }, async () => {
      controller.abort();
      await expect(guarded.send(put("record", "late") as never)).rejects.toThrow(LEARNING_WRITE_DEADLINE);
      await expect(guarded.send(new UpdateCommand({ TableName: "record", Key: { pk: "keep", sk: "x" }, UpdateExpression: "SET n = :n", ExpressionAttributeValues: { ":n": 2 } }) as never)).rejects.toThrow(LEARNING_WRITE_DEADLINE);
      await expect(guarded.send(new TransactWriteCommand({ TransactItems: [{ Put: { TableName: "state", Item: { pk: "s", sk: "x" } } }, { Put: { TableName: "record", Item: { pk: "t", sk: "x" } } }] }) as never)).rejects.toThrow(LEARNING_WRITE_DEADLINE);
      expect(spy).not.toHaveBeenCalled();
      // A read, and the State table's own write (the key block and the lease must still happen after the deadline), are not guarded.
      expect(((await guarded.send(new GetCommand({ TableName: "record", Key: { pk: "keep", sk: "x" } }) as never)) as { Item?: unknown }).Item).toBeDefined();
      await guarded.send(put("state", "ledger"));
    });
    expect(db.get("late", "x")).toBeUndefined();
    expect(db.get("t", "x")).toBeUndefined();
    expect(db.get("s", "x")).toBeUndefined();
    expect(db.get("ledger", "x")).toBeDefined();
    expect(db.get("keep", "x")).toMatchObject({ n: 1 });
  });
});

describe("M6: audit events from the worker are pending items only", () => {
  const event = () => builders.auditPullRequestOpened({ orgId: TEST_ORG, actor: { kind: "member", id: "dev_1" }, occurredAt: "2026-10-20T11:59:00.000Z", occurrence: "op-1", pullRequestId: "pr_1", number: 7 });
  const runtime = (pendingOnly: boolean) => {
    const db = new FakeDynamoDb();
    const sqs = new FakeAuditSqs();
    const audit = { sqs: sqs.client, queueUrl: "https://sqs.test/agentx-test-audit-intake.fifo", documentClient: { send: db.send } as never, tableName: "state", now: () => Date.parse("2026-10-20T12:00:00.000Z"), log: () => undefined, ...(pendingOnly ? { pendingOnly: true as const } : {}) };
    return { db, sqs, audit };
  };
  it("the pending item is written (the broker's drain sends it) and NOTHING is sent to the queue the worker has no right to", async () => {
    const w = runtime(true);
    await recordAuditSinkOf(w.audit, w.db)!(event());
    expect(w.db.find((item) => String(item.pk).startsWith("AUDIT_PENDING#"))).toHaveLength(1);
    expect(w.sqs.calls).toHaveLength(0);
  });
  it("the same event through an ordinary audit runtime is sent (the positive control: it is the flag that stops the send)", async () => {
    const w = runtime(false);
    await recordAuditSinkOf(w.audit, w.db)!(event());
    expect(w.sqs.queue.length).toBeGreaterThan(0);
  });
});

describe("M6: the worker's own entry", () => {
  const env = {
    AWS_REGION: "us-west-2", AGENTX_ENV: "staging", AGENTX_ACCOUNT_ID: "123456789012", STATE_TABLE_NAME: "state", ARTIFACT_BUCKET_NAME: "artifacts", DEVELOPER_SIGNIN_TABLE_NAME: "signin", MODEL_ACCESS_FUNCTION_NAME: "model-access",
    TEAM_RECORD_ENABLED: "1", TEAM_RECORD_TABLE_NAME: "record", ROVARA_EDITION: "public", GITHUB_APP_CREDENTIAL_REF: "github-app", GITHUB_APP_PRIVATE_KEY_SECRET_ARN: "arn:aws:secretsmanager:us-west-2:123456789012:secret:github-app-key",
  };
  const build = (over: Record<string, string> = {}) => {
    for (const [name, value] of Object.entries({ ...env, ...over })) vi.stubEnv(name, value);
    try { return lessonsWorkerDependencies(); } finally { vi.unstubAllEnvs(); }
  };
  const built = build();

  it("builds exactly what learning reads: the tables, the Team record, the model path, the code host, the edition, a pending-only audit, and nothing of the broker's secrets", () => {
    expect(built.tableName).toBe("state");
    expect(built.artifactBucketName).toBe("artifacts");
    expect(built.developer).toEqual({ signInTableName: "signin" });
    expect(built.cloud).toBe(true);
    expect(built.teamRecord?.table.tableName).toBe("record");
    expect(built.modelAccess?.access).toBeDefined();
    expect(built.codeHost).toBeDefined();
    expect(built.audit?.pendingOnly).toBe(true);
    for (const forbidden of ["callbackSigningKey", "repositoryGrants", "issuer", "adminClaim", "adminValues", "codeBuild", "orchestratorRoleArn", "connectorCredentials", "githubWebhookSecret"]) expect(built, forbidden).not.toHaveProperty(forbidden);
  });
  it("Enterprise (a private install) is not the cloud", () => {
    expect(build({ ROVARA_EDITION: "enterprise" }).cloud).toBe(false);
  });
  it("the Team record has no durable queue, no dead-letter reader and no removal fallback that would invoke or send anywhere", () => {
    const record = built.teamRecord as unknown as Record<string, unknown>;
    expect(record).toBeDefined();
    const source = readFileSync(new URL("../../../packages/broker/src/aws/lessons-worker-entry.ts", import.meta.url), "utf8");
    const code = source.split("\n").filter((line) => !line.trimStart().startsWith("//")).join("\n");
    // No call back into the broker module, no secret, no self-invoke, no queue it cannot reach.
    for (const forbidden of ["CALLBACK_SIGNING_KEY", "AWS_LAMBDA_FUNCTION_NAME", "removalFallback", "opsQueue", "deadLetters", "InvokeCommand", "SendMessageCommand", "AUDIT_INTAKE_QUEUE_URL", "./broker.js", "createAwsBrokerHandler"]) expect(code, forbidden).not.toContain(forbidden);
  });
});
