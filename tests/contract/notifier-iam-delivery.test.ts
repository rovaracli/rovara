import { describe, expect, it, vi } from "vitest";
import { orgMemberKey } from "@agentx/cloud-contracts";
import { projectMemberKey } from "@rovara-code/contracts";
import { createNotifierHandler } from "../../packages/broker/src/aws/developer-task-notifier.js";
import { noticesOf, type Notice } from "../../packages/broker/src/developer/notifications.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { enforceRolePolicy, list, notifierStatements, patternsOf, type Statement } from "../support/notifier-role-policy.js";
import { TEST_ORG } from "../support/orgs.js";
import { skipLambdaBundling } from "../support/skip-bundling.js";

// The three direct messages the notifier sends from its own rows (a person's attention batch, the owner-stopped notice, the settings-proof failure) delivered under the notifier role's REAL policy, as
// CloudFormation synthesizes it: a document client that throws AccessDeniedException for any call the role does not allow, as DynamoDB does. Each of the three was refused on staging or would have been
// (NOTIFY_DM in 0.5.14; the member rows the owner-stopped check reads), and the unit tests with an open fake table did not see it.

skipLambdaBundling();

const statements = notifierStatements();

function notifier(options: { without?: (statement: Statement) => boolean } = {}) {
  const db = new FakeDynamoDb();
  const denied: string[] = [];
  const policy = options.without === undefined ? statements : statements.filter((statement) => !options.without!(statement));
  const client = enforceRolePolicy(db, policy, denied);
  const post = vi.fn(async (input: { channel: string; text: string }) => { void input; return { ts: "1.2", channel: "D0X" }; });
  const failures = vi.fn();
  const handler = createNotifierHandler({ documentClient: client, tableName: "state", enqueue: async () => undefined, retryLater: async () => undefined,
    post, now: () => Date.now(), log: () => undefined, deliveryFailed: failures, reviewUrlBase: "https://agentx.example.test" });
  const deliver = (notice: Notice, messageId = "m1") => handler({ Records: [{ eventSource: "aws:sqs", messageId, receiptHandle: "r", body: JSON.stringify(notice), attributes: { ApproximateReceiveCount: "1" } }] });
  return { db, denied, post, failures, deliver };
}

const grantsKey = (statement: Statement, key: string) => { const patterns = patternsOf(statement); return patterns !== "any" && patterns !== "unreadable" && patterns.includes(key); };

describe("the notifier's direct messages are delivered under its real IAM policy", () => {
  const taskId = "22222222-2222-4222-8222-222222222222";
  const bea = "b".repeat(64);
  const stopKey = `OWNER_STOP_NOTIFY#ci_fix_round#31#${bea}`;
  const at = new Date().toISOString();
  const ownerStopped = (t: ReturnType<typeof notifier>) => {
    t.db.set({ pk: `DEVTASK#${taskId}`, sk: "META", entityType: "DEVELOPER_TASK", taskId, orgId: TEST_ORG, title: "Fix the retry bug", project: "payments", developerId: "a".repeat(64), developerName: "Maya", provider: "slack" });
    t.db.set({ pk: `DEVTASK#${taskId}`, sk: "PEOPLE", schemaVersion: 1, revision: 2, orphaned: false, people: [{ developerId: bea, slackUserId: "U0BEA00001", name: "Bea", role: "owner" }] });
    t.db.set({ ...orgMemberKey(TEST_ORG, bea), entityType: "ORG_MEMBER", orgId: TEST_ORG, developerId: bea, role: "member", joinedAt: "2026-10-01T00:00:00.000Z" });
    t.db.set({ ...projectMemberKey(TEST_ORG, bea, "payments"), entityType: "MEMBERSHIP", ownerKey: bea, projectName: "payments", role: "developer" });
    t.db.set({ pk: `DEVTASK#${taskId}`, sk: stopKey, entityType: "TASK_OWNER_STOPPED_NOTIFICATION", schemaVersion: 1, taskId, stopId: "ci_fix_round#31", targetDeveloperId: bea, slackUserId: "U0BEA00001", ownerAtStop: "a".repeat(64), status: "PENDING", attempts: 0, createdAt: at });
    return { id: `${taskId}:owner_stopped:ci_fix_round#31#${bea}`, kind: "owner_stopped_dm", taskId, ownerStopKey: stopKey, at } as Notice;
  };

  it("the owner-stopped message is sent once, and the member rows it reads are granted read-only", async () => {
    const t = notifier();
    const notice = ownerStopped(t);
    await t.deliver(notice);
    await t.deliver(notice, "m2");
    expect(t.denied).toEqual([]);
    expect(t.post).toHaveBeenCalledOnce();
    expect(t.post.mock.calls[0]![0]).toMatchObject({ channel: "U0BEA00001" });
    expect(t.db.get(`DEVTASK#${taskId}`, stopKey)).toMatchObject({ status: "SENT" });
  });

  it("without the member-row grant the same delivery is refused by IAM and nothing is sent (the staging failure)", async () => {
    const t = notifier({ without: (statement) => grantsKey(statement, "ORG#org_????????????????????") });
    const notice = ownerStopped(t);
    const outcome = await t.deliver(notice);
    expect(t.denied.some((entry) => entry.startsWith("GetItem ORG#"))).toBe(true);
    expect(t.post).not.toHaveBeenCalled();
    expect(outcome.batchItemFailures).toEqual([{ itemIdentifier: "m1" }]);
  });

  it("an attention message (and the Slack-member warning, which uses the same row) is sent once, claimed and marked sent", async () => {
    const t = notifier();
    const sk = `${TEST_ORG}#slack-member-warning#U0MEMBER01`;
    t.db.set({ pk: "NOTIFY_DM", sk, entityType: "TASK_ATTENTION_DM", status: "PENDING", orgId: TEST_ORG, slackUserId: "U0MEMBER01", text: "A person in your Slack is not a member.", at });
    const [notice] = noticesOf(undefined, t.db.get("NOTIFY_DM", sk)!, at, "stream-1");
    expect(notice).toMatchObject({ kind: "attention_dm", attentionKey: sk });
    await t.deliver(notice!);
    await t.deliver(notice!, "m2");
    expect(t.denied).toEqual([]);
    expect(t.post).toHaveBeenCalledOnce();
    expect(t.db.get("NOTIFY_DM", sk)).toMatchObject({ status: "SENT" });
    // Without its grant the row is refused, as on staging.
    const refused = notifier({ without: (statement) => grantsKey(statement, "NOTIFY_DM") });
    refused.db.set({ pk: "NOTIFY_DM", sk, entityType: "TASK_ATTENTION_DM", status: "PENDING", orgId: TEST_ORG, slackUserId: "U0MEMBER01", text: "x", at });
    await refused.deliver(notice!);
    expect(refused.denied).toEqual(["GetItem NOTIFY_DM"]);
    expect(refused.post).not.toHaveBeenCalled();
  });

  it("a settings-proof failure is sent once with its reason as plain text, under a marker of the notifier's own", async () => {
    const t = notifier();
    const item = (saved: Record<string, unknown>) => ({ pk: `ORG#${TEST_ORG}#PROJECT#web`, sk: "SETTINGS_PROOF", entityType: "PROJECT_SETTINGS_PROOF", orgId: TEST_ORG, project: "web", saved });
    const failed = { status: "failed", checkRequestId: "c1", noticeAt: at, slackUserId: "U0MAYA0001", reason: "setup step 0 (npm ci) failed: <http://x|click> and <!channel> & more" };
    const [notice] = noticesOf(item({ status: "checking", checkRequestId: "c1", slackUserId: "U0MAYA0001" }), item(failed), at, "stream-1");
    expect(notice).toMatchObject({ kind: "settings_proof", proofProject: "web" });
    await t.deliver(notice!);
    await t.deliver(notice!, "m2");
    const [again] = noticesOf(undefined, item(failed), at, "stream-replay");
    await t.deliver(again!, "m3");
    expect(t.denied).toEqual([]);
    expect(t.post).toHaveBeenCalledOnce();
    const text = t.post.mock.calls[0]![0].text;
    expect(text).toContain("&lt;http://x|click&gt;");
    expect(text).toContain("&lt;!channel&gt; &amp; more");
    expect(text).not.toMatch(/<http|<!channel/u);
    expect([...t.db.items.keys()].filter((key) => key.includes("PROJECT#"))).toEqual([]);
  });

  it("the role's statements for these messages carry the Null guard", () => {
    const wanted = ["NOTIFY_DM", "NOTIFY_SETTINGS_PROOF#*", "ORG#org_????????????????????", "ORG#org_????????????????????#MEMBER#*"];
    for (const key of wanted) {
      const found = statements.filter((statement) => grantsKey(statement, key));
      expect(found, key).toHaveLength(1);
      expect(found[0]!.Condition?.Null, key).toEqual({ "dynamodb:LeadingKeys": "false" });
      expect(list(found[0]!.Action).every((action) => action === "dynamodb:GetItem" || action === "dynamodb:UpdateItem" || action === "dynamodb:PutItem"), key).toBe(true);
    }
  });
});
