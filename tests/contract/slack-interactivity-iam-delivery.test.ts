import { createHmac, randomUUID } from "node:crypto";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { LambdaClient } from "@aws-sdk/client-lambda";
import { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWorkflowSnapshot } from "@agentx/cloud-contracts";
import { WORKFLOW_STOP_ACTION } from "../../packages/cloud-contracts/src/index.js";
import { createAwsSlackInteractivityHandler, QUICK_AUTO_START_STOPPING_TEXT } from "../../packages/broker/src/aws/slack-interactivity.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { STATE_TABLE_LOGICAL_ID, attributeLimit, enforceRolePolicy, list, roleStatements, statementsOnTable, type Statement } from "../support/notifier-role-policy.js";
import { skipLambdaBundling } from "../support/skip-bundling.js";

// SLACK-STOP-IAM (found live on staging, 0.5.15): a Stop press on a request that Quick started on its own (decision 134) failed three times out of three. The interactivity route runs on the Slack
// ingress Lambda; its task read asks for `currentOwner` (the effective owner), and the role's DEVTASK# statement listed five other attributes, so DynamoDB answered AccessDeniedException before the
// press was looked at: Slack said "I couldn't open those plan controls". The tests with an open fake table (and the workflow e2e, which hands the handler its own loadTask) did not see it.
//
// This runs the real production wiring, createAwsSlackInteractivityHandler, with the AWS SDK clients it builds replaced by ones that enforce the Slack ingress role's REAL synthesized policy: the State
// table's statements (key patterns and the Attributes guard) and the Lambda invoke grants.

skipLambdaBundling();

const role = roleStatements("slack-ingress");
/** What the role says about the State table: its threads table and turn records table statements are separate resources. */
const statements = statementsOnTable(role, STATE_TABLE_LOGICAL_ID);

const STATE_TABLE = "state-table";
const SIGNING_SECRET = "8f742231b10e8888abcd99yyyzzz85a5";
const BROKER_FUNCTION = "agentx-test-broker";
const RESPONSE_URL = "https://hooks.slack.com/actions/T0BSHLLUGBD/1/iam";
const thread = { teamId: "T0BSHLLUGBD", channelId: "C0123456789", threadTs: "1695500000.000001" };
const owner = "U0123456789";
const taskId = "33333333-3333-4333-8333-333333333333";

interface Handoff { action: string; input: Record<string, unknown>; invocationType: string }

/** Whether the role has an Allow for lambda:InvokeFunction on the function of this logical ID in the template. */
const mayInvoke = (policy: readonly Statement[], logicalId: string): boolean => policy.some((statement) => statement.Effect === "Allow"
  && list(statement.Action).some((action) => action === "lambda:InvokeFunction") && JSON.stringify(statement.Resource).includes(logicalId));

function slackIngress(policy: readonly Statement[] = statements, lambdaPolicy: readonly Statement[] = role) {
  const state = new FakeDynamoDb();
  const threads = new FakeDynamoDb();
  const denied: string[] = [];
  const enforced = enforceRolePolicy(state, policy, denied);
  // Calls on the State table go through the role's policy; the Slack threads table (a full read-write grant) does not.
  const client = { send: async (command: { input: { TableName?: string } }) => (command.input.TableName === STATE_TABLE ? enforced.send(command) : threads.send(command)) };
  const handoffs: Handoff[] = [];
  const ephemeral: string[] = [];
  vi.spyOn(DynamoDBDocumentClient, "from").mockReturnValue(client as never);
  vi.spyOn(SecretsManagerClient.prototype, "send").mockImplementation((async () => ({ SecretString: JSON.stringify({ signingSecret: SIGNING_SECRET, botToken: "xoxb-iam-test" }) })) as never);
  vi.spyOn(LambdaClient.prototype, "send").mockImplementation((async (command: { constructor: { name: string }; input: { FunctionName: string; InvocationType: string; Payload: Buffer } }) => {
    if (command.constructor.name !== "InvokeCommand") throw new Error(`unexpected Lambda command ${command.constructor.name}`);
    if (command.input.FunctionName !== BROKER_FUNCTION || !mayInvoke(lambdaPolicy, "BrokerE1355FD6")) {
      denied.push(`lambda:InvokeFunction ${command.input.FunctionName}`);
      throw Object.assign(new Error("not authorized to perform lambda:InvokeFunction"), { name: "AccessDeniedException" });
    }
    const event = JSON.parse(Buffer.from(command.input.Payload).toString("utf8")) as Record<string, unknown>;
    handoffs.push({ action: String(event.action), input: event, invocationType: command.input.InvocationType });
    // A direct (RequestResponse) call is the owner check, which the broker answers 200; an asynchronous one is queued.
    return command.input.InvocationType === "Event" ? { StatusCode: 202 } : { StatusCode: 200, Payload: Buffer.from(JSON.stringify({ statusCode: 200, body: "{}" })) };
  }) as never);
  const views: Array<Record<string, unknown>> = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: { body?: string }) => {
    const body = JSON.parse(init?.body ?? "{}") as { text?: string; view?: Record<string, unknown> };
    if (url.endsWith("/api/views.open")) views.push(body.view ?? {});
    else ephemeral.push(body.text ?? "");
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  }));
  const handler = createAwsSlackInteractivityHandler();
  return { state, denied, handoffs, ephemeral, views, handler };
}

function seedTask(db: FakeDynamoDb, extra: Record<string, unknown> = {}): void {
  const now = new Date().toISOString();
  db.set({ pk: `DEVTASK#${taskId}`, sk: "META", entityType: "DEVELOPER_TASK", taskId, slackUserId: owner, title: "Fix the retry bug", project: "payments",
    share: thread, workflow: createWorkflowSnapshot({ taskId, ownerId: "a".repeat(64), now }), currentOwner: { developerId: "a".repeat(64), slackUserId: owner, name: "Maya" }, ...extra });
}

function press(actionId: string, value: Record<string, unknown>) {
  const body = new URLSearchParams({ payload: JSON.stringify({
    type: "block_actions", team: { id: thread.teamId }, user: { id: owner, team_id: thread.teamId },
    container: { type: "message", message_ts: "1695500001.000002", channel_id: thread.channelId, thread_ts: thread.threadTs },
    message: { ts: "1695500001.000002", thread_ts: thread.threadTs, text: "Started this on Quick.", blocks: [] },
    response_url: RESPONSE_URL, trigger_id: "1.2.3",
    actions: [{ action_id: actionId, value: JSON.stringify(value), block_id: "controls", action_ts: "1695500002.000100" }],
  }) }).toString();
  const timestamp = String(Math.floor(Date.now() / 1_000));
  const signature = `v0=${createHmac("sha256", SIGNING_SECRET).update(`v0:${timestamp}:${body}`).digest("hex")}`;
  return { version: "2.0", rawPath: "/v1/slack/interactions", headers: { "X-Slack-Request-Timestamp": timestamp, "X-Slack-Signature": signature, "content-type": "application/x-www-form-urlencoded" },
    body, isBase64Encoded: false, requestContext: { requestId: randomUUID(), http: { method: "POST" } } };
}

const stopPress = () => press(WORKFLOW_STOP_ACTION, { taskId });
/** The Close button of a task's card carries the revision the card showed. */
const closePress = () => press("agentx_workflow_close", { taskId, revision: createWorkflowSnapshot({ taskId, ownerId: "a".repeat(64), now: new Date().toISOString() }).revision });

/** The role's State statements as v0.5.15 had them: the DEVTASK# attribute list without `currentOwner`. */
function withoutCurrentOwner(): Statement[] {
  return statements.map((statement) => {
    const limit = attributeLimit(statement);
    if (limit === undefined || !limit.allowed.includes("currentOwner")) return statement;
    return { ...statement, Condition: { ...statement.Condition, "ForAllValues:StringEquals": { "dynamodb:Attributes": limit.allowed.filter((name) => name !== "currentOwner") } } };
  });
}

const ENV = { AWS_REGION: "us-west-2", STATE_TABLE_NAME: STATE_TABLE, SLACK_THREADS_TABLE_NAME: "threads-table", SLACK_REQUEST_QUEUE_URL: "https://sqs.us-west-2.amazonaws.com/1/q.fifo",
  SLACK_SECRET_ARN: "arn:aws:secretsmanager:us-west-2:1:secret:slack", BROKER_FUNCTION_NAME: BROKER_FUNCTION, SHARED_TASKS: "enabled", AWS_LAMBDA_FUNCTION_NAME: "agentx-test-ingress" };

describe("a Stop press on a task Quick started on its own, served by the Slack ingress Lambda under its real IAM policy", () => {
  beforeEach(() => {
    for (const [name, value] of Object.entries(ENV)) vi.stubEnv(name, value);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

  it("reads the task, asks the broker for the owner check, hands the close over and tells the owner it is stopping", async () => {
    const t = slackIngress();
    seedTask(t.state);
    const answer = await t.handler(stopPress());
    expect(t.denied).toEqual([]);
    expect(answer.statusCode).toBe(200);
    expect(t.handoffs.map((handoff) => [handoff.action, handoff.invocationType])).toEqual([["task-people-authorize", "RequestResponse"], ["workflow-close", "Event"]]);
    expect(t.handoffs[1]!.input).toMatchObject({ taskId, userId: owner, stop: true });
    expect(t.ephemeral).toEqual([QUICK_AUTO_START_STOPPING_TEXT]);
  });

  it("a Close press (the form that closes a task) reads the task under the same policy and opens the confirmation", async () => {
    const t = slackIngress();
    seedTask(t.state);
    const answer = await t.handler(closePress());
    expect(t.denied).toEqual([]);
    expect(answer.statusCode).toBe(200);
    expect(t.handoffs.map((handoff) => [handoff.action, handoff.invocationType])).toEqual([["task-people-authorize", "RequestResponse"]]);
    expect(t.views).toEqual([expect.objectContaining({ callback_id: "agentx_workflow_close_submission" })]);
    expect(t.ephemeral).toEqual([]);
  });

  it("without `currentOwner` the Close press is refused by IAM too (the staging failure at 20:59Z)", async () => {
    const t = slackIngress(withoutCurrentOwner());
    seedTask(t.state);
    await t.handler(closePress());
    expect(t.denied).toEqual([`GetItem DEVTASK#${taskId} attributes pk,sk,slackUserId,share,workflow,currentOwner`]);
    expect(t.views).toEqual([]);
    expect(t.ephemeral.join(" ")).toContain("I couldn't open the close confirmation");
  });

  it("without `currentOwner` in the DEVTASK# attribute list the same press is refused by IAM (the staging failure)", async () => {
    const withoutOwner = withoutCurrentOwner();
    expect(withoutOwner).not.toEqual(statements);
    const t = slackIngress(withoutOwner);
    seedTask(t.state);
    await t.handler(stopPress());
    expect(t.denied).toEqual([`GetItem DEVTASK#${taskId} attributes pk,sk,slackUserId,share,workflow,currentOwner`]);
    expect(t.handoffs).toEqual([]);
    expect(t.ephemeral.join(" ")).toContain("I couldn't open those plan controls");
  });

  it("the DEVTASK# read statement lists exactly the attributes the task read names, is guarded by Null, and grants nothing but GetItem", () => {
    const found = statements.filter((statement) => JSON.stringify(statement.Condition ?? {}).includes("DEVTASK#"));
    expect(found).toHaveLength(1);
    expect(list(found[0]!.Action)).toEqual(["dynamodb:GetItem"]);
    expect(found[0]!.Condition?.Null).toEqual({ "dynamodb:Attributes": "false" });
    expect(attributeLimit(found[0]!)?.allowed).toEqual(["pk", "sk", "slackUserId", "share", "workflow", "currentOwner"]);
  });
});
