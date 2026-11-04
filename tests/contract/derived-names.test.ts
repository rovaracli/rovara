// ENV-ROOM (owner decision 2026-10-24): a Lambda's environment is held to 4 KB, so a value the function can compute is not passed. The broker builds each of the
// variables in DERIVED_BROKER_VARIABLES (packages/contracts/src/derived-names.ts) from the environment's name, the region and the account. The module is the one
// place a derived name is written: CDK names the resource with its functions, the broker reads the same functions. This holds the two together: for every derived
// variable that is a role or a queue, the synthesized template has exactly one resource with that name (and, for a role, that path), and what the broker builds
// is that resource's ARN or URL. A resource renamed in CDK without the module, or a variable added to the table for a name nothing creates, fails here.
import { Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { DERIVED_BROKER_VARIABLES, auditIntakeQueueName, BROKER_NAMES_VARIABLE, BROKER_SETTINGS_VARIABLE } from "@agentx/contracts";
import { buildAgentXApp } from "../../infra/lib/app.js";
import { hydrateBrokerEnvironment, type MutableEnvironment } from "../../packages/broker/src/aws/broker-environment.js";
import { skipLambdaBundling } from "../support/skip-bundling.js";

skipLambdaBundling();

type Resource = { Type: string; Properties?: Record<string, unknown> };
const REGION = "ap-southeast-4";
const ACCOUNT = "123456789012";

function resourcesOf(env: string | undefined, context: Record<string, unknown>): Resource[] {
  const app = buildAgentXApp({ ...(env === undefined ? {} : { agentxEnv: env }), ...context });
  return app.node.children.filter((child): child is Stack => Stack.isStack(child))
    .flatMap((stack) => Object.values((Template.fromStack(stack).toJSON() as { Resources: Record<string, Resource> }).Resources));
}

const withName = (resources: Resource[], type: string, property: string, name: string): Resource[] =>
  resources.filter((resource) => resource.Type === type && resource.Properties?.[property] === name);

const hydrated = (env: string, cloud: boolean): MutableEnvironment => {
  const started: MutableEnvironment = { AGENTX_ENV: env, AGENTX_NAMES: "{}", AWS_REGION: REGION, AGENTX_ACCOUNT_ID: ACCOUNT, ...(cloud ? { AGENTX_CLOUD: "true" } : {}) };
  hydrateBrokerEnvironment(started);
  return started;
};

describe("DERIVED_BROKER_VARIABLES", () => {
  it("lists each variable once, and has the roles and queues the broker was given before", () => {
    const names = DERIVED_BROKER_VARIABLES.map((entry) => entry.variable);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toEqual(expect.arrayContaining(["AUDIT_INTAKE_QUEUE_URL", "BROKER_ROLE_ARN", "CONNECTOR_SECRETS_ROLE_ARN", "CHAIN_SCHEDULE_ROLE_ARN", "CHAIN_SCHEDULE_QUEUE_URL"]));
  });

  it("names the audit intake queue agentx-<env>-audit-intake.fifo, as the queue has always been", () => {
    expect(auditIntakeQueueName("staging")).toBe("agentx-staging-audit-intake.fifo");
  });
});

for (const [label, env, context, cloud] of [
  ["cloud", "staging", { agentxCloud: true }, true],
  ["cloud, the longest environment name", "a1234567890123456789", { agentxCloud: true }, true],
  ["named, not cloud", "staging", {}, false],
] as const) {
  describe(`${label}: what the broker derives is what CDK named`, () => {
    const resources = resourcesOf(env, context);
    const started = hydrated(env, cloud);

    for (const entry of DERIVED_BROKER_VARIABLES) {
      const expected = cloud || entry.cloudOnly !== true;
      if (entry.kind === "text") {
        it(`${entry.variable}: derived from the environment's name alone`, () => {
          expect(started[entry.variable]).toBe(entry.value(env));
        });
      } else if (entry.kind === "roleArn") {
        it(`${entry.variable}: ${expected ? "is the ARN of the one role CDK named " + entry.roleName(env) : "is left unbuilt (the role exists, the cloud grant that names it does not)"}`, () => {
          // The role has a fixed name in every named environment (the default boundary names it); only the variable is cloud-only.
          const roles = withName(resources, "AWS::IAM::Role", "RoleName", entry.roleName(env));
          expect(roles).toHaveLength(1);
          const path = roles[0]!.Properties?.Path;
          expect(path, "the role is in the environment's role path").toBe(`/agentx/${env}/`);
          if (!expected) {
            expect(started[entry.variable]).toBeUndefined();
            return;
          }
          expect(started[entry.variable]).toBe(`arn:aws:iam::${ACCOUNT}:role${path as string}${entry.roleName(env)}`);
        });
      } else if (entry.kind === "kmsAliasArn") {
        it(`${entry.variable}: is the ARN of the one key alias CDK named ${entry.alias(env)}`, () => {
          const aliases = withName(resources, "AWS::KMS::Alias", "AliasName", entry.alias(env));
          expect(aliases).toHaveLength(1);
          expect(started[entry.variable]).toBe(`arn:aws:kms:${REGION}:${ACCOUNT}:${entry.alias(env)}`);
        });
      } else {
        it(`${entry.variable}: is the URL of the one queue CDK named ${entry.queueName(env)}`, () => {
          const queues = withName(resources, "AWS::SQS::Queue", "QueueName", entry.queueName(env));
          expect(queues).toHaveLength(1);
          expect(started[entry.variable]).toBe(`https://sqs.${REGION}.amazonaws.com/${ACCOUNT}/${entry.queueName(env)}`);
        });
      }
    }
  });
}

describe("the legacy install, whose templates this leaves as they were", () => {
  const resources = resourcesOf(undefined, {});

  it("is given its variables whole: no names or settings variable, and nothing hydrates", () => {
    const brokers = resources.filter((resource) => resource.Type === "AWS::Lambda::Function")
      .filter((resource) => JSON.stringify(resource.Properties?.Environment ?? {}).includes("OIDC_ISSUER"));
    expect(brokers.length).toBeGreaterThan(0);
    for (const broker of brokers) {
      const variables = (broker.Properties!.Environment as { Variables: Record<string, unknown> }).Variables;
      expect(variables).not.toHaveProperty(BROKER_NAMES_VARIABLE);
      expect(variables).not.toHaveProperty(BROKER_SETTINGS_VARIABLE);
      expect(variables).toHaveProperty("STATE_TABLE_NAME");
      expect(variables).toHaveProperty("SLACK_MEMBER_WORKSPACE_LIMIT");
    }
    const started: MutableEnvironment = { AWS_REGION: REGION, AGENTX_ACCOUNT_ID: ACCOUNT };
    hydrateBrokerEnvironment(started);
    expect(started).toEqual({ AWS_REGION: REGION, AGENTX_ACCOUNT_ID: ACCOUNT });
  });

  it("has no audit intake queue, so no name there to change", () => {
    expect(resources.filter((resource) => resource.Type === "AWS::SQS::Queue" && JSON.stringify(resource.Properties?.QueueName ?? "").includes("audit-intake"))).toEqual([]);
  });
});
