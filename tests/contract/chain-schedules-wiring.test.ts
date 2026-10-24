// Plan 4 Task 26: how schedules reach the deployed broker. The names the control plane passes become the scheduler's settings; an invocation by the scheduler (an event with no
// request context) is the broker's own and nothing arriving through the API is; a fault that may pass is thrown, not answered, because only a thrown error makes the scheduler
// try again and then leave the slot in the dead-letter queue; and the 5-minute sweep drains the dead letters and repairs schedules that are still pending.
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { hydrateBrokerEnvironment } from "../../packages/broker/src/aws/broker-environment.js";
import { createChainScheduler, scheduleSettingsFromEnvironment } from "../../packages/broker/src/triggers/schedules.js";
import { createDeveloperTaskBroker, type DeveloperTaskBrokerHarness } from "../support/developer-task-broker.js";
import { FakeSchedulerClient } from "../support/fake-scheduler.js";
import { TEST_ORG } from "../support/orgs.js";
import { loadSlackBroker } from "../support/slack-broker.js";

beforeAll(async () => { await loadSlackBroker(); });
afterEach(() => undefined);

const SCOPE = { AWS_REGION: "us-west-2", AGENTX_ACCOUNT_ID: "123456789012", AGENTX_ENV: "staging", AWS_LAMBDA_FUNCTION_NAME: "agentx-staging-broker-ABC" };
const names = (value: Record<string, string>) => ({ ...SCOPE, AGENTX_NAMES: JSON.stringify(value) });

describe("the settings the broker builds from its environment", () => {
  it("builds the role's ARN in the environment's path and the queue's URL from the two names, and reads its own function's name from Lambda", () => {
    const env: Record<string, string | undefined> = names({ cs: "ChainRole-ABC123", cq: "ChainDead-XYZ789" });
    hydrateBrokerEnvironment(env);
    expect(env["CHAIN_SCHEDULE_ROLE_ARN"]).toBe("arn:aws:iam::123456789012:role/agentx/staging/ChainRole-ABC123");
    expect(env["CHAIN_SCHEDULE_QUEUE_URL"]).toBe("https://sqs.us-west-2.amazonaws.com/123456789012/ChainDead-XYZ789");
    expect(scheduleSettingsFromEnvironment(env)).toEqual({
      groupName: "agentx-staging-chain-triggers",
      roleArn: "arn:aws:iam::123456789012:role/agentx/staging/ChainRole-ABC123",
      functionArn: "arn:aws:lambda:us-west-2:123456789012:function:agentx-staging-broker-ABC",
      queueArn: "arn:aws:sqs:us-west-2:123456789012:ChainDead-XYZ789",
      queueUrl: "https://sqs.us-west-2.amazonaws.com/123456789012/ChainDead-XYZ789",
    });
  });

  it("builds the China partition's ARNs from the region", () => {
    const env: Record<string, string | undefined> = { ...names({ cs: "R", cq: "Q" }), AWS_REGION: "cn-north-1" };
    hydrateBrokerEnvironment(env);
    expect(scheduleSettingsFromEnvironment(env)).toMatchObject({
      roleArn: "arn:aws-cn:iam::123456789012:role/agentx/staging/R", functionArn: "arn:aws-cn:lambda:cn-north-1:123456789012:function:agentx-staging-broker-ABC", queueArn: "arn:aws-cn:sqs:cn-north-1:123456789012:Q",
    });
  });

  it.each(["CHAIN_SCHEDULE_ROLE_ARN", "CHAIN_SCHEDULE_QUEUE_URL", "AGENTX_ENV", "AWS_REGION", "AGENTX_ACCOUNT_ID", "AWS_LAMBDA_FUNCTION_NAME"])("gives no settings (so no schedule is made, and a trigger stays pending) when %s is missing", (missing) => {
    const env: Record<string, string | undefined> = names({ cs: "R", cq: "Q" });
    hydrateBrokerEnvironment(env);
    delete env[missing];
    expect(scheduleSettingsFromEnvironment(env)).toBeUndefined();
  });

  it("gives no settings for a queue URL that is not an SQS queue's, whatever it names", () => {
    const env: Record<string, string | undefined> = { ...names({ cs: "R", cq: "Q" }) };
    hydrateBrokerEnvironment(env);
    env["CHAIN_SCHEDULE_QUEUE_URL"] = "https://evil.example.com/123456789012/Q";
    expect(scheduleSettingsFromEnvironment(env)).toBeUndefined();
  });
});

describe("the scheduler's invocation, through the deployed broker's handler", () => {
  const SLOT = () => new Date(Date.now() - 5_000).toISOString();
  const event = (over: Record<string, unknown> = {}) => ({ source: "agentx.chain-schedule", orgId: TEST_ORG, triggerId: "ctr_00000000000000000001", scheduledAt: SLOT(), ...over });
  const settings = { groupName: "agentx-staging-chain-triggers", roleArn: "arn:aws:iam::123456789012:role/r", functionArn: "arn:aws:lambda:us-east-1:123456789012:function:f", queueArn: "arn:aws:sqs:us-east-1:123456789012:q", queueUrl: "https://sqs.us-east-1.amazonaws.com/123456789012/q" };
  const bodyOf = (reply: unknown) => JSON.parse((reply as { body: string }).body) as Record<string, unknown>;
  async function broker(extra: Record<string, unknown> = {}) {
    const client = new FakeSchedulerClient();
    const scheduler = createChainScheduler({ client, settings });
    const h: DeveloperTaskBrokerHarness = await createDeveloperTaskBroker({ brokerExtra: { agents: { triggerSchedules: scheduler }, ...extra } });
    return { h, client, scheduler };
  }

  it("answers an invocation for a trigger that is not there as stale, and deletes the schedule its own input names", async () => {
    const { h, client, scheduler } = await broker();
    await scheduler.put({ orgId: TEST_ORG, triggerId: "ctr_00000000000000000001", spec: { kind: "schedule", schedule: { kind: "daily", at: "09:00" }, timezone: "UTC", missed: "run_once" } });
    const reply = await h.handler(event());
    expect(reply).toMatchObject({ statusCode: 200 });
    expect(bodyOf(reply)).toMatchObject({ outcome: "stale" });
    expect(client.get(settings.groupName, "ctr_00000000000000000001")).toBeUndefined();
  });

  it("does not treat a request that came through the API as the scheduler's, whatever its body says", async () => {
    const { h, client, scheduler } = await broker();
    await scheduler.put({ orgId: TEST_ORG, triggerId: "ctr_00000000000000000001", spec: { kind: "schedule", schedule: { kind: "daily", at: "09:00" }, timezone: "UTC", missed: "run_once" } });
    const http = { ...event(), requestContext: { http: { method: "POST", path: "/v1/anything" } }, rawPath: "/v1/anything", headers: {}, body: JSON.stringify(event()) };
    const reply = await h.handler(http as never).catch(() => undefined);
    expect(JSON.stringify(reply ?? {})).not.toContain("stale");
    expect(client.get(settings.groupName, "ctr_00000000000000000001")).toBeDefined();
    expect(client.commands("GetScheduleCommand")).toEqual([]);
  });

  it("throws, so the scheduler tries again, where schedules are not set up in this deployment", async () => {
    const { h } = await broker({ agents: undefined });
    await expect(h.handler(event())).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
  });

  it("throws a fault that may pass, rather than answering it", async () => {
    const { h } = await broker();
    h.db.injectFault({ command: "GetCommand", match: (input) => JSON.stringify(input).includes("TRIGGER#"), error: { name: "ProvisionedThroughputExceededException" } });
    await expect(h.handler(event())).rejects.toThrow();
  });

  it("answers an input that is not a slot without reading anything", async () => {
    const { h } = await broker();
    const reply = await h.handler(event({ scheduledAt: "<aws.scheduler.scheduled-time>" }));
    expect(bodyOf(reply)).toMatchObject({ outcome: "stale", reason: "invalid" });
  });
});
