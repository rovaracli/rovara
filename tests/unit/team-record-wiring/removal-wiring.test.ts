// TRW-5 S1/S2 and TRW-4 wiring: the broker's side of the removal fallback, the dead-letter queue port, and the Slack sign-in link.
import { describe, expect, it } from "vitest";
import type { DeleteMessageCommand, ReceiveMessageCommand } from "@aws-sdk/client-sqs";
import { applyTeamRecordRemoval, drainTeamRecordQueue, isTeamRecordRemovalEvent, removalFallbackThroughLambda } from "../../../packages/broker/src/aws/broker/team-record-wiring.js";
import { deadLetterUrlOf, sqsDeadLetters, TEAM_RECORD_REMOVAL_SOURCE, type RemovalFallbackEvent } from "../../../packages/broker/src/team-record/ops-queue.js";
import { DeveloperSignInStore, signInIdentityKey } from "../../../packages/broker/src/developer/store.js";
import { ownerKeyForSubject } from "../../../packages/broker/src/aws/lambda.js";
import { SLACK_OIDC_ISSUER } from "@agentx/contracts";
import { FakeDynamoDb } from "../../support/fake-dynamodb.js";
import { ORG_A } from "../../support/team-record-core.js";

const event: RemovalFallbackEvent = { source: TEAM_RECORD_REMOVAL_SOURCE, workspaceId: ORG_A, system: "linear", sourceIds: ["issue:i1"], cause: "source_deleted" };

describe("the removal event", () => {
  it("is recognised only in its exact shape (never an HTTP request, never another source)", () => {
    expect(isTeamRecordRemovalEvent(event)).toBe(true);
    expect(isTeamRecordRemovalEvent({ ...event, requestContext: {} })).toBe(false);
    expect(isTeamRecordRemovalEvent({ ...event, source: "agentx.team-record-slack" })).toBe(false);
    expect(isTeamRecordRemovalEvent({ source: TEAM_RECORD_REMOVAL_SOURCE })).toBe(false);
    expect(isTeamRecordRemovalEvent(null)).toBe(false);
  });

  it("answers off where the record is off, applies it where on, and THROWS when the record could not", async () => {
    expect(await applyTeamRecordRemoval({ teamRecord: undefined }, event)).toStrictEqual({ skipped: true, reason: "off" });
    const applied: unknown[] = [];
    expect(await applyTeamRecordRemoval({ teamRecord: { removal: async (e: unknown) => { applied.push(e); } } as never }, event)).toStrictEqual({ applied: true });
    expect(applied).toStrictEqual([event]);
    await expect(applyTeamRecordRemoval({ teamRecord: { removal: async () => { throw new Error("table down"); } } as never }, event)).rejects.toThrow();
  });

  it("is sent to the broker itself as an Event, and a send Lambda did not accept (not 202) is a failure", async () => {
    const sent: Array<{ InvocationType: string; Payload: Uint8Array }> = [];
    const ok = removalFallbackThroughLambda(async (request) => { sent.push(request); return { StatusCode: 202 }; });
    await ok(event);
    expect(sent[0]!.InvocationType).toBe("Event");
    expect(JSON.parse(Buffer.from(sent[0]!.Payload).toString("utf8"))).toStrictEqual(event);
    await expect(removalFallbackThroughLambda(async () => ({ StatusCode: 500 }))(event)).rejects.toThrow();
  });
});

describe("the queue drain gets the function's clock", () => {
  it("passes the Lambda context's remaining time on, and fails the whole batch when the record is off", async () => {
    const seen: number[] = [];
    const teamRecord = { drain: async (_records: unknown, options?: { remainingMs?: () => number }) => { seen.push(options?.remainingMs?.() ?? -1); return { batchItemFailures: [] }; } };
    const batch = { Records: [{ eventSource: "aws:sqs", eventSourceARN: "arn:x", messageId: "m1", body: "{}", attributes: { ApproximateReceiveCount: "2" } }] };
    await drainTeamRecordQueue({ teamRecord: teamRecord as never }, batch, { getRemainingTimeInMillis: () => 12_345 });
    await drainTeamRecordQueue({ teamRecord: teamRecord as never }, batch);
    expect(seen).toStrictEqual([12_345, -1]);
    expect(await drainTeamRecordQueue({ teamRecord: undefined }, batch)).toStrictEqual({ batchItemFailures: [{ itemIdentifier: "m1" }] });
  });
});

describe("the dead-letter queue port", () => {
  it("builds its URL from the environment's name, and reads and deletes on that one queue", async () => {
    expect(deadLetterUrlOf({ AGENTX_ENV: "staging", AWS_REGION: "us-west-2", AGENTX_ACCOUNT_ID: "123456789012" })).toBe("https://sqs.us-west-2.amazonaws.com/123456789012/agentx-staging-team-record-ops-dead");
    expect(deadLetterUrlOf({ AGENTX_ENV: "staging" })).toBeUndefined();
    const commands: Array<ReceiveMessageCommand | DeleteMessageCommand> = [];
    const port = sqsDeadLetters({ send: async (command) => { commands.push(command); return { Messages: [{ ReceiptHandle: "h1", Body: "{}" }, { Body: "no handle" }] }; } }, "https://sqs/dead");
    expect(await port.receive(50)).toStrictEqual([{ handle: "h1", body: "{}" }]);
    expect(commands[0]!.input).toMatchObject({ QueueUrl: "https://sqs/dead", MaxNumberOfMessages: 10 });
    await port.remove("h1");
    expect(commands[1]!.input).toMatchObject({ QueueUrl: "https://sqs/dead", ReceiptHandle: "h1" });
  });
});

describe("the Slack sign-in link (TRW-4)", () => {
  const store = (db: FakeDynamoDb) => new DeveloperSignInStore({ documentClient: db, tableName: "State", nameTableName: "State", now: () => 1 });
  const link = (db: FakeDynamoDb, userId: string, developerId: string, extra: Record<string, unknown> = {}) => {
    const identityKey = ownerKeyForSubject(SLACK_OIDC_ISSUER, userId);
    db.set({ ...signInIdentityKey(identityKey), developerId, provider: "slack", issuer: SLACK_OIDC_ISSUER, subject: userId, ...extra });
  };

  it("answers the developer a Slack user id signed in as, and nobody for a user who did not, an id of the wrong shape, or an identity that was unlinked", async () => {
    const db = new FakeDynamoDb();
    link(db, "U0123456789", "dev-1");
    link(db, "U0123456780", "dev-2", { unlinkedFrom: "dev-9" });
    expect(await store(db).developerOfSlackUser("U0123456789")).toBe("dev-1");
    expect(await store(db).developerOfSlackUser("U0999999999")).toBeUndefined();
    expect(await store(db).developerOfSlackUser("U0123456780")).toBeUndefined();
    expect(await store(db).developerOfSlackUser("not a slack id")).toBeUndefined();
  });
});
