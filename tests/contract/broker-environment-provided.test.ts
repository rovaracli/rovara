// Final review C1: the broker's variables were cut to fit Lambda's 4 KB (names in one variable, URLs and ARNs built, constants derived), so this
// pins that every variable it read before it is still there when it starts, and that every variable its code reads is provided or optional.
import { readFileSync } from "node:fs";
import { Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { buildAgentXApp } from "../../infra/lib/app.js";
import { hydrateBrokerEnvironment, type MutableEnvironment } from "../../packages/broker/src/aws/broker-environment.js";
import { DEPLOY_PARAMETER_VALUES, lambdaEnvironments, type Template as ResolvableTemplate } from "../support/lambda-environment-size.js";
import { skipLambdaBundling } from "../support/skip-bundling.js";
import { brokerSourceFiles } from "../support/broker-source.js";

skipLambdaBundling();

/** The broker's variables on a cloud install at 0228382c, before the fix (58 of them). */
const BEFORE_C1 = [
  "STATE_TABLE_NAME", "AGENTX_PROJECT_SETUP_RUNTIME_CATALOG_ID", "AGENTX_E2E_FEATURE_RUNTIME_CATALOG_ID", "ARTIFACT_BUCKET_NAME", "OIDC_ISSUER", "ADMIN_CLAIM", "ADMIN_VALUES",
  "CALLBACK_SIGNING_KEY", "GITHUB_APP_CREDENTIAL_REF", "GITHUB_APP_ID", "GITHUB_APP_PRIVATE_KEY_SECRET_ARN", "CONNECTOR_SECRET_PREFIX", "CONNECTOR_SECRETS_ROLE_ARN", "AGENTX_ENV",
  "AGENT_PROJECT_ALLOW_LIST_ID", "SWEBENCH_SETTINGS_PREFIX", "PLAN_EVIDENCE_FUNCTION_NAME", "SLACK_REQUEST_QUEUE_URL", "TURN_RECORDS_TABLE_NAME", "AGENTX_METRICS_NAMESPACE",
  "SLACK_ORCHESTRATOR_ROLE_ARN", "SLACK_MEMBER_WORKSPACE_LIMIT", "SLACK_ORGANIZATION_WORKSPACE_LIMIT", "DEVELOPER_NOTICE_EMAIL_FROM", "DEVELOPER_NOTICE_EMAIL_REGION",
  "DEVELOPER_TOKEN_ISSUER", "DEVELOPER_SIGNIN_TABLE_NAME", "DEVELOPER_IDENTITY_FUNCTION_ARN", "SLACK_TEAM_ID", "DEVELOPER_SIGNIN_SLACK", "DEVELOPER_OIDC_ISSUER",
  "DEVELOPER_SIGNIN_SLACK_SINCE", "DEVELOPER_OIDC_SINCE", "MCP_CONFIRM_ELICITATION", "DEVELOPER_CLOUD_ISSUER", "ROVARA_WEB_ORIGIN", "DEVELOPER_GITHUB_CLIENT_ID",
  "AGENTX_TASK_PEOPLE_CHANGES_ENABLED", "AGENTX_TASK_PEOPLE_PUBLIC_INVITATIONS_ENABLED", "AGENTX_TASK_PEOPLE_PRIVATE_INVITATIONS_ENABLED", "AGENTX_WORKFLOW_DEPENDENCIES_ENABLED",
  "CHATGPT_CONNECTION_KEY_ARN", "AGENTX_ALARM_PREFIX", "HEALTH_DEAD_LETTER_QUEUES", "SLACK_THREADS_TABLE_NAME", "AUDIT_INTAKE_QUEUE_URL", "AUDIT_LEDGER_TABLE_NAME",
  "AUDIT_SEALS_TABLE_NAME", "AUDIT_KEYS_TABLE_NAME", "AUDIT_EXPORTS_BUCKET_NAME", "AUDIT_EXPORT_FUNCTION_NAME", "AUDIT_VAULT_KEY_ARN", "EC2_WORKER_LAUNCH_TEMPLATE_ID",
  "EC2_WORKER_SUBNETS", "MODEL_ACCESS_FUNCTION_NAME", "MODEL_PROXY_URL", "PROVISIONER_ARN", "DELETER_ARN",
] as const;

/** Variables the broker's code reads that the control plane does not always provide, each for a reason. */
const OPTIONAL = new Map<string, string>([
  ["AWS_REGION", "Lambda sets it for every function"],
  ["DEVELOPER_IDENTITY_FUNCTION_ARN", "the sign-in function by ARN, which still works where an environment gives one instead of DEVELOPER_IDENTITY_FUNCTION_NAME"],
  ["AGENTX_RELEASE_VERSION", "set by the release, for the health route; absent on an install made from source"],
  ["MODEL_SOURCE_TRUST_PRINCIPALS", "an operator's list of Bedrock roles to trust; empty by default"],
  ["ROVARA_MODEL_ENDPOINT_CIDRS", "Enterprise only: the private ranges a custom model endpoint may resolve into; set by the install (infra/lib/model-endpoints.ts) and absent when the setting is left out (public addresses only)"],
  ["ROVARA_VPC_CIDRS", "Enterprise only: the network Rovara itself runs in, set by the install with the private ranges (model endpoints, private MCP) and absent when they are left out"],
]);

const REGION = "ap-southeast-4";

function brokerEnvironment(env: string, context: Record<string, unknown>): Record<string, string> {
  const app = buildAgentXApp({ agentxEnv: env, ...context });
  for (const stack of app.node.children.filter((child): child is Stack => Stack.isStack(child))) {
    const found = lambdaEnvironments(Template.fromStack(stack).toJSON() as ResolvableTemplate, { env, stackName: stack.stackName, parameterValues: DEPLOY_PARAMETER_VALUES })
      .find((entry) => /^Broker[0-9A-F]{8}$/.test(entry.logicalId));
    if (found !== undefined) return found.variables;
  }
  throw new Error("no broker");
}

/** The names a source file reads from an environment: process.env.X, requiredEnvironment("X"), and env.X or environment.X on a record that is given one. */
function readsOf(path: string): string[] {
  const text = readFileSync(path, "utf8");
  const names = new Set<string>();
  for (const pattern of [/process\.env\.([A-Z][A-Z0-9_]+)/g, /process\.env\["([A-Z][A-Z0-9_]+)"\]/g, /requiredEnvironment\("([A-Z][A-Z0-9_]+)"\)/g, /\b(?:env|environment)\.([A-Z][A-Z0-9_]+)\b/g]) {
    for (const match of text.matchAll(pattern)) names.add(match[1]!);
  }
  return [...names].sort();
}

describe("what the broker reads is still there when it starts (final review C1)", () => {
  for (const env of ["staging", "a1234567890123456789"]) {
    describe(`a cloud install, environment ${env}`, () => {
      const given = brokerEnvironment(env, { agentxCloud: true });
      const started: MutableEnvironment = { ...given, AWS_REGION: REGION };
      hydrateBrokerEnvironment(started);

      it("has every variable it had before, once its names are put back (the sign-in function is reached by name, not by ARN)", () => {
        const missing = BEFORE_C1.filter((name) => (started[name] ?? "") === "" && !["DEVELOPER_IDENTITY_FUNCTION_ARN"].includes(name)
          // These are empty on an install that leaves the optional setting out, as before.
          && !["GITHUB_APP_ID", "DEVELOPER_NOTICE_EMAIL_FROM", "DEVELOPER_NOTICE_EMAIL_REGION", "DEVELOPER_OIDC_ISSUER", "SLACK_TEAM_ID", "DEVELOPER_GITHUB_CLIENT_ID"].includes(name));
        expect(missing).toEqual([]);
        expect(started.DEVELOPER_IDENTITY_FUNCTION_NAME).toBeTruthy();
      });

      it("has the names, URLs and ARNs it had, to the text it had them in", () => {
        const account = given.AGENTX_ACCOUNT_ID!;
        expect(started.SLACK_REQUEST_QUEUE_URL).toMatch(new RegExp(`^https://sqs\\.${REGION}\\.amazonaws\\.com/${account}/agentx-${env}-control-plane-`));
        expect(started.AUDIT_INTAKE_QUEUE_URL).toBe(`https://sqs.${REGION}.amazonaws.com/${account}/agentx-${env}-audit-intake.fifo`);
        expect(started.AUDIT_VAULT_KEY_ARN).toMatch(new RegExp(`^arn:aws:kms:${REGION}:${account}:key/[0-9a-f-]{36}$`));
        expect(started.CHATGPT_CONNECTION_KEY_ARN).toMatch(new RegExp(`^arn:aws:kms:${REGION}:${account}:key/[0-9a-f-]{36}$`));
        expect(started.PROVISIONER_ARN).toMatch(new RegExp(`^arn:aws:states:${REGION}:${account}:stateMachine:agentx-${env}-control-plane-`));
        expect(started.DELETER_ARN).toMatch(new RegExp(`^arn:aws:states:${REGION}:${account}:stateMachine:agentx-${env}-control-plane-`));
        // (A role's name is cut at 64 characters, so for a long environment name only its start is the same.)
        expect(started.SLACK_ORCHESTRATOR_ROLE_ARN).toMatch(new RegExp(`^arn:aws:iam::${account}:role/agentx/${env}/agentx-${env}-control-plane-`));
        expect(started.CONNECTOR_SECRETS_ROLE_ARN).toBe(`arn:aws:iam::${account}:role/agentx/${env}/agentx-${env}-connector-secrets`);
        expect(started.DEVELOPER_CLOUD_ISSUER).toBe(`https://cognito-idp.${REGION}.amazonaws.com/${REGION}_AbCdEfGhI`);
        expect(started.DEVELOPER_TOKEN_ISSUER).toBe(`https://abcdefghij.execute-api.${REGION}.amazonaws.com/v1/auth`);
        expect(Object.keys(JSON.parse(started.HEALTH_DEAD_LETTER_QUEUES!) as object)).toEqual(["dispatch", "slack-requests", "developer-notices", "developer-notice-stream"]);
        for (const url of Object.values(JSON.parse(started.HEALTH_DEAD_LETTER_QUEUES!) as Record<string, string>)) expect(url).toMatch(new RegExp(`^https://sqs\\.${REGION}\\.amazonaws\\.com/${account}/agentx-${env}-control-plane-`));
        expect([started.CONNECTOR_SECRET_PREFIX, started.SWEBENCH_SETTINGS_PREFIX, started.AGENTX_ALARM_PREFIX, started.AGENTX_METRICS_NAMESPACE])
          .toEqual([`agentx/${env}/connectors/`, `/agentx/${env}/`, `agentx-${env}-`, `AgentX/${env}`]);
        expect([started.AGENTX_PROJECT_SETUP_RUNTIME_CATALOG_ID, started.AGENTX_E2E_FEATURE_RUNTIME_CATALOG_ID]).toEqual([`agentx-${env}-project-setup-runtime-v1`, `agentx-${env}-e2e-mock-runtime-v1`]);
      });

      it("provides, or marks optional, every variable the broker's code reads", () => {
        const files = [
          ...brokerSourceFiles(),
          "packages/broker/src/aws/workflow-dependencies-configuration.ts",
          "packages/broker/src/org/resolve.ts",
          "packages/broker/src/org/cloud-projects.ts",
          "packages/broker/src/org/invite-url.ts",
        ];
        const reads = new Set(files.flatMap(readsOf));
        // A name in prose or a type is not a read; the files are written with the real ones in capitals.
        const unprovided = [...reads].filter((name) => !(name in started) && !OPTIONAL.has(name) && !/^(AWS_|NODE_)/.test(name));
        expect(unprovided).toEqual([]);
      });
    });
  }
});
