// Hotfix 0.5.4: closing a task's compute failed on every cloud install. The broker's environment arrives packed (AGENTX_NAMES, AGENTX_SETTINGS) and
// broker-environment-init.ts unpacks it, but `aws/broker/runtime-clients.ts` read STATE_TABLE_NAME and DELETER_ARN when it was loaded, and the
// developer-routes import chain reached it before the unpacking ran, so the EC2 session manager held an empty table name and an empty deleter ARN.
// This loads the real broker entry module the way the Lambda does: the environment is what the control plane gives the broker (the synthesized
// function's variables, only the packed ones), plus the region and account Lambda gives it.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { BROKER_NAMES, BROKER_NAMES_VARIABLE, BROKER_SETTINGS, BROKER_SETTINGS_VARIABLE } from "@agentx/contracts";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { hydrateBrokerEnvironment, type MutableEnvironment } from "../../packages/broker/src/aws/broker-environment.js";
import { brokerVariables } from "../support/broker-packed-variables.js";
import { skipLambdaBundling } from "../support/skip-bundling.js";

skipLambdaBundling();

const REGION = "ap-southeast-4";
const ACCOUNT = "123456789012";

/** The accessor changed from a constant (v0.5.3) to a function; this reads either, so the test fails on an assertion and not on a missing name. */
type Ec2SessionsExport = unknown;
const sessionsOf = (exported: Ec2SessionsExport): { get(workspaceId: string): Promise<unknown>; dependencies: { tableName: string; executions: { provisionerArn: string; deleterArn: string } } } =>
  (typeof exported === "function" ? (exported as () => unknown)() : exported) as never;

describe("the EC2 session manager the broker closes compute with, loaded from the packed environment", () => {
  const saved = { ...process.env };
  const packed = brokerVariables();
  const expected: MutableEnvironment = { ...packed, AWS_REGION: REGION, AGENTX_ACCOUNT_ID: ACCOUNT };
  hydrateBrokerEnvironment(expected);

  beforeAll(() => {
    // Only what the control plane passes: the packed variables and the plain ones, and none of the names that are packed.
    for (const spec of [...Object.values(BROKER_NAMES), ...Object.values(BROKER_SETTINGS)]) delete process.env[spec.variable];
    Object.assign(process.env, packed, { AWS_REGION: REGION, AGENTX_ACCOUNT_ID: ACCOUNT });
  });
  afterAll(() => {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
    vi.restoreAllMocks();
  });

  it("starts from an environment that has the names only packed", () => {
    expect(process.env[BROKER_NAMES_VARIABLE]).toBeDefined();
    expect(process.env[BROKER_SETTINGS_VARIABLE]).toBeDefined();
    expect(process.env.STATE_TABLE_NAME).toBeUndefined();
    expect(process.env.DELETER_ARN).toBeUndefined();
    expect(expected.STATE_TABLE_NAME).toBeTruthy();
    expect(expected.DELETER_ARN).toMatch(/^arn:aws:states:/);
  });

  it("uses the state table and the deleter state machine the packed names give, after the real broker module is loaded", async () => {
    vi.resetModules();
    await import("../../packages/broker/src/aws/broker.js");
    const clients = await import("../../packages/broker/src/aws/broker/runtime-clients.js");
    const sessions = sessionsOf((clients as Record<string, unknown>).ec2Sessions);
    expect(sessions.dependencies.tableName).toBe(expected.STATE_TABLE_NAME);
    expect(sessions.dependencies.executions.deleterArn).toBe(expected.DELETER_ARN);
    expect(sessions.dependencies.executions.provisionerArn).toBe(expected.PROVISIONER_ARN);

    // And the first thing a close does, reading the session, goes to that table.
    const send = vi.spyOn(DynamoDBDocumentClient.prototype, "send").mockImplementation((async () => ({})) as never);
    await sessions.get("workspace-1");
    expect((send.mock.calls[0]![0] as { input: { TableName: string } }).input.TableName).toBe(expected.STATE_TABLE_NAME);
  }, 120_000);
});
