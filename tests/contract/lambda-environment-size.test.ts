// Lambda holds all of a function's environment variables, keys and values together, to 4,096 bytes of JSON, and only the deploy says
// so: "Lambda was unable to configure your environment variables because the environment variables you have provided exceeded the 4KB
// limit". The broker's environment was past it on the first staging deploy of Plan 3 (final review C1, about 5,000 bytes against a
// limit of 4,096). This resolves every synthesized Lambda's environment with the longest names CloudFormation can generate and holds
// each one under a ceiling with margin, so that a later plan cannot drift past the limit unseen.
import { Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { buildAgentXApp } from "../../infra/lib/app.js";
import { skipLambdaBundling } from "../support/skip-bundling.js";
import { DEPLOY_PARAMETER_VALUES, LAMBDA_ENVIRONMENT_LIMIT_BYTES, environmentBytes, lambdaEnvironments, type LambdaEnvironment, type Template as ResolvableTemplate } from "../support/lambda-environment-size.js";

skipLambdaBundling();

/** Below Lambda's 4,096 with room for a name that CloudFormation lengthens, a new variable or two, and the measuring being an estimate. */
const CEILING_BYTES = 3800;
/**
 * The broker keeps at least this much room under the ceiling (ENV-ROOM, owner decision 2026-10-24): it reached the ceiling again after the merge of Plans 4 and 5, because tasks
 * kept adding variables. A task that eats the room fails the test below; the fix is to derive the value, not to add an environment variable.
 */
const BROKER_HEADROOM_BYTES = 400;
const DERIVE_DONT_ADD = [
  "Derive it, don't add an environment variable.",
  "A name or ARN that follows the agentx-<env>-... naming is built at run time from AGENTX_ENV, AWS_REGION and the account: add it to DERIVED_BROKER_VARIABLES in packages/contracts/src/derived-names.ts",
  "(the module CDK names the resource with and broker-environment.ts reads), not to the function's environment.",
  "A generated name or an id goes in AGENTX_NAMES (BROKER_NAMES), a constrained setting in AGENTX_SETTINGS (BROKER_SETTINGS), both in packages/contracts/src/broker-names.ts.",
].join(" ");
/** An environment name of the longest length the installer accepts (20 characters), and the usual one. */
const LONGEST_ENVIRONMENT = "a1234567890123456789";
const ENVIRONMENTS = [LONGEST_ENVIRONMENT, "staging"] as const;

function environmentsOf(env: string | undefined, context: Record<string, unknown>, parameterValues: Record<string, string> = DEPLOY_PARAMETER_VALUES): Array<LambdaEnvironment & { stack: string }> {
  const app = buildAgentXApp({ ...(env === undefined ? {} : { agentxEnv: env }), ...context });
  const found: Array<LambdaEnvironment & { stack: string }> = [];
  for (const stack of app.node.children.filter((child): child is Stack => Stack.isStack(child))) {
    const template = Template.fromStack(stack).toJSON() as ResolvableTemplate;
    for (const environment of lambdaEnvironments(template, { env: env ?? "production", stackName: stack.stackName, parameterValues })) found.push({ ...environment, stack: stack.stackName });
  }
  return found;
}

describe("a Lambda function's environment stays under Lambda's 4 KB limit", () => {
  for (const env of ENVIRONMENTS) {
    for (const [label, context] of [["cloud", { agentxCloud: true }], ["self-hosted", {}]] as const) {
      describe(`${label}, environment ${env}`, () => {
        const functions = environmentsOf(env, context);

        it("finds the control plane's functions", () => {
          expect(functions.map((entry) => entry.logicalId).some((id) => id.startsWith("Broker"))).toBe(true);
          expect(functions.length).toBeGreaterThan(10);
        });

        it(`holds every function under ${CEILING_BYTES} bytes of compact JSON`, () => {
          const sizes = Object.fromEntries(functions.map((entry) => [`${entry.stack}/${entry.logicalId}`, entry.bytes]));
          const over = Object.entries(sizes).filter(([, bytes]) => bytes > CEILING_BYTES);
          expect(over, `over ${CEILING_BYTES}: ${JSON.stringify(sizes)}`).toEqual([]);
          expect(Math.max(...Object.values(sizes))).toBeLessThan(LAMBDA_ENVIRONMENT_LIMIT_BYTES);
        });
      });
    }
  }
});

describe("the broker keeps room (ENV-ROOM)", () => {
  for (const env of ENVIRONMENTS) {
    for (const [label, context] of [["cloud", { agentxCloud: true }], ["self-hosted", {}]] as const) {
      it(`keeps ${BROKER_HEADROOM_BYTES} bytes under ${CEILING_BYTES}, cloud or not: ${label}, environment ${env}`, () => {
        const broker = environmentsOf(env, context).find((entry) => /^Broker[0-9A-F]{8}$/.test(entry.logicalId));
        expect(broker, "the control plane has a broker").toBeDefined();
        const headroom = CEILING_BYTES - broker!.bytes;
        expect(headroom, `The broker's environment is ${broker!.bytes} bytes, ${headroom} under ${CEILING_BYTES}; it must keep ${BROKER_HEADROOM_BYTES}. ${DERIVE_DONT_ADD}`).toBeGreaterThanOrEqual(BROKER_HEADROOM_BYTES);
      });
    }
  }
});

describe("the legacy install (no environment name), whose templates this fix leaves as they were", () => {
  const functions = environmentsOf(undefined, {});

  it(`holds every function under ${CEILING_BYTES} bytes of compact JSON`, () => {
    expect(functions.map((entry) => entry.logicalId).some((id) => id.startsWith("Broker"))).toBe(true);
    const over = functions.filter((entry) => entry.bytes > CEILING_BYTES).map((entry) => `${entry.logicalId}: ${entry.bytes}`);
    expect(over).toEqual([]);
  });
});

describe("the measuring", () => {
  it("counts the compact JSON of the variable map, in bytes", () => {
    expect(environmentBytes({ A: "1" })).toBe('{"A":"1"}'.length);
    expect(environmentBytes({ NAME: "é" })).toBe(Buffer.byteLength('{"NAME":"é"}'));
  });

  it("gives a function name CloudFormation generates the stack's name, the logical id and 13 random characters, cut at 64", () => {
    const template: ResolvableTemplate = { Resources: {
      Long: { Type: "AWS::Lambda::Function", Properties: {} },
      Reader: { Type: "AWS::Lambda::Function", Properties: { Environment: { Variables: { NAME: { Ref: "Long" } } } } },
    } };
    const [entry] = lambdaEnvironments(template, { env: "x", stackName: "agentx-x-control-plane" });
    expect(entry!.variables.NAME).toBe("agentx-x-control-plane-Long-A1B2C3D4E5F6G");
    const capped = lambdaEnvironments({ Resources: { ...template.Resources, ["L".repeat(80)]: template.Resources.Long! } }, { env: "x", stackName: "agentx-x-control-plane" });
    expect(capped).toHaveLength(1);
  });

  it("takes a fixed name where the template sets one, a queue's URL for its Ref and a role's path into its ARN", () => {
    const template: ResolvableTemplate = { Resources: {
      Queue: { Type: "AWS::SQS::Queue", Properties: { QueueName: "agentx-x-audit-intake.fifo" } },
      Role: { Type: "AWS::IAM::Role", Properties: { RoleName: "agentx-x-role" } },
      Reader: { Type: "AWS::Lambda::Function", Properties: { Environment: { Variables: {
        URL: { Ref: "Queue" },
        ROLE: { "Fn::GetAtt": ["Role", "Arn"] },
        NAME: { "Fn::GetAtt": ["Queue", "QueueName"] },
      } } } },
    } };
    const [entry] = lambdaEnvironments(template, { env: "x", stackName: "agentx-x-control-plane" });
    expect(entry!.variables).toEqual({
      URL: "https://sqs.ap-southeast-4.amazonaws.com/123456789012/agentx-x-audit-intake.fifo",
      ROLE: "arn:aws:iam::123456789012:role/agentx/x/agentx-x-role",
      NAME: "agentx-x-audit-intake.fifo",
    });
  });
});
