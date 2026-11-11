// Plan 5 Task 8 (I15): the realtime events API. A named environment has one AppSync Events API, `agentx-<env>-realtime`, with the namespace `rovara`, a Lambda authorizer
// for connect and subscribe, IAM for publish and logging off; only the broker and the outbox publisher may publish, and only to the namespace; the authorizer may read the
// State table and the token key's public half and nothing more; the broker's grants stay in their named policies under the size they were held to, and its variables
// under Lambda's 4 KB. The legacy install has none of it.
import { Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { beforeAll, describe, expect, it } from "vitest";
import { APPSYNC_EVENTS_ACTIONS, APPSYNC_EVENTS_UNSCOPED_ACTIONS, BROKER_NAMES } from "@agentx/cloud-contracts";
import { buildAgentXApp } from "../../infra/lib/app.js";
import { hydrateBrokerEnvironment, type MutableEnvironment } from "../../packages/broker/src/aws/broker-environment.js";
import { realtimeSocketEndpoint } from "../../packages/broker/src/realtime/token.js";
import { defaultBoundaryStatements, serviceRoleStatements } from "../../infra/lib/access-policies.js";
import { APPSYNC_API_ID, APPSYNC_DNS_PREFIX, DEPLOY_PARAMETER_VALUES, LAMBDA_ENVIRONMENT_LIMIT_BYTES, LAMBDA_RESOLVER_REGION, lambdaEnvironments, type Template as ResolvableTemplate } from "../support/lambda-environment-size.js";
import { skipLambdaBundling } from "../support/skip-bundling.js";

skipLambdaBundling();

type Json = Record<string, unknown>;
type Resource = { Type: string; Properties: Json };
type Statement = { Sid?: string; Effect: string; Action: string | string[]; Resource?: unknown; Condition?: unknown };
const ofType = (template: { Resources: Record<string, Resource> }, type: string) => Object.entries(template.Resources).filter(([, resource]) => resource.Type === type);
const actionsOf = (statement: Statement) => [statement.Action].flat();
const statementsOf = (policy: Resource) => (policy.Properties.PolicyDocument as { Statement: Statement[] }).Statement;
/** The role a policy resource belongs to, as the logical id without its hash. */
const rolesOfPolicy = (policy: Resource) => ((policy.Properties.Roles ?? []) as Array<{ Ref: string }>).map((role) => role.Ref.replace(/[0-9A-F]{8}$/, ""));

let named: ResolvableTemplate & { Resources: Record<string, Resource> };
let namedStack: Stack;
let legacy: { Resources: Record<string, Resource> };

beforeAll(() => {
  namedStack = buildAgentXApp({ agentxEnv: "staging" }).node.children.filter((child): child is Stack => Stack.isStack(child)).find((stack) => stack.stackName === "agentx-staging-control-plane")!;
  named = Template.fromStack(namedStack).toJSON() as typeof named;
  legacy = Template.fromStack(buildAgentXApp().node.children.filter((child): child is Stack => Stack.isStack(child)).find((stack) => stack.stackName === "AgentXControlPlane")!).toJSON() as typeof legacy;
}, 300_000);

describe("the events API", () => {
  it("is one API named agentx-<env>-realtime with one namespace, rovara, the authorizer for connect and subscribe, IAM for publish, and logging off", () => {
    const apis = ofType(named, "AWS::AppSync::Api");
    expect(apis).toHaveLength(1);
    const [apiId, api] = apis[0]!;
    expect(api.Properties.Name).toBe("agentx-staging-realtime");
    expect(api.Properties.EventConfig).toMatchObject({
      ConnectionAuthModes: [{ AuthType: "AWS_LAMBDA" }],
      DefaultPublishAuthModes: [{ AuthType: "AWS_IAM" }],
      DefaultSubscribeAuthModes: [{ AuthType: "AWS_LAMBDA" }],
    });
    const eventConfig = api.Properties.EventConfig as Json;
    expect(eventConfig.AuthProviders).toEqual([
      { AuthType: "AWS_LAMBDA", LambdaAuthorizerConfig: { AuthorizerResultTtlInSeconds: 0, AuthorizerUri: { "Fn::GetAtt": [expect.stringMatching(/^RealtimeAuthorizer[0-9A-F]{8}$/) as string, "Arn"] } } },
      { AuthType: "AWS_IAM" },
    ]);
    // Logging is off: no log configuration on the API and no log role for it.
    expect(eventConfig.LogConfig).toBeUndefined();
    expect(JSON.stringify(api.Properties)).not.toContain("LogConfig");
    const namespaces = ofType(named, "AWS::AppSync::ChannelNamespace");
    expect(namespaces).toHaveLength(1);
    expect(namespaces[0]![1].Properties).toMatchObject({ Name: "rovara", ApiId: { "Fn::GetAtt": [apiId, "ApiId"] }, PublishAuthModes: [{ AuthType: "AWS_IAM" }], SubscribeAuthModes: [{ AuthType: "AWS_LAMBDA" }] });
    expect(ofType(named, "AWS::AppSync::GraphQLApi")).toEqual([]);
    expect(ofType(named, "AWS::AppSync::ApiKey")).toEqual([]);
  });

  it("lets appsync.amazonaws.com invoke the authorizer for this API only", () => {
    const [apiId] = ofType(named, "AWS::AppSync::Api")[0]!;
    const [authorizerId] = ofType(named, "AWS::Lambda::Function").find(([id]) => /^RealtimeAuthorizer[0-9A-F]{8}$/.test(id))!;
    const permissions = ofType(named, "AWS::Lambda::Permission").filter(([, resource]) => resource.Properties.Principal === "appsync.amazonaws.com");
    expect(permissions.length).toBeGreaterThan(0);
    for (const [, permission] of permissions) {
      expect(permission.Properties).toMatchObject({ Action: "lambda:InvokeFunction", FunctionName: { "Fn::GetAtt": [authorizerId, "Arn"] }, SourceArn: { "Fn::GetAtt": [apiId, "ApiArn"] } });
    }
  });

  it("is not in the legacy install", () => {
    expect(ofType(legacy, "AWS::AppSync::Api")).toEqual([]);
    expect(JSON.stringify(legacy)).not.toMatch(/appsync|Realtime|REALTIME/);
  });
});

describe("who may publish and who may read", () => {
  it("allows appsync:EventPublish only on the namespace's ARN, and only to the broker and the outbox publisher", () => {
    const [namespaceId] = ofType(named, "AWS::AppSync::ChannelNamespace")[0]!;
    const holders = [...ofType(named, "AWS::IAM::Policy"), ...ofType(named, "AWS::IAM::ManagedPolicy")].flatMap(([, policy]) => statementsOf(policy)
      .filter((statement) => actionsOf(statement).some((action) => action.startsWith("appsync:") || action === "*"))
      .map((statement) => ({ policy, statement })));
    expect(holders.length).toBeGreaterThanOrEqual(2);
    for (const { statement } of holders) {
      expect(actionsOf(statement)).toEqual(["appsync:EventPublish"]);
      expect(statement.Effect).toBe("Allow");
      expect(statement.Resource).toEqual({ "Fn::GetAtt": [namespaceId, "ChannelNamespaceArn"] });
    }
    // The broker's role holds it in its named managed policy; the outbox publisher's in its own policy. No other role does.
    const roles = holders.map(({ policy }) => (policy.Type === "AWS::IAM::ManagedPolicy"
      ? ((policy.Properties.Roles ?? []) as Array<{ Ref: string }>).map((role) => role.Ref) : rolesOfPolicy(policy)).map((id) => id.replace(/[0-9A-F]{8}$/, "")).join());
    expect(roles.sort()).toEqual(["BrokerServiceRole", "OutboxPublisherServiceRole"]);
    // And nobody may publish to the whole API or subscribe or connect over IAM.
    expect(JSON.stringify(named.Resources)).not.toMatch(/appsync:(EventSubscribe|EventConnect|\*)/);
  });

  it("gives the authorizer's role exactly the State table's GetItem and Query and the token key's GetPublicKey", () => {
    const policies = ofType(named, "AWS::IAM::Policy").filter(([, policy]) => rolesOfPolicy(policy).includes("RealtimeAuthorizerServiceRole"));
    expect(policies).toHaveLength(1);
    // CDK adds the X-Ray write statement of every traced function; nothing else is on top of the two grants.
    const statements = statementsOf(policies[0]![1]).filter((statement) => !actionsOf(statement).every((action) => action.startsWith("xray:")));
    const [stateId] = ofType(named, "AWS::DynamoDB::Table").find(([id]) => /^State[0-9A-F]{8}$/.test(id))!;
    const [keyId] = ofType(named, "AWS::KMS::Key").find(([, key]) => key.Properties.KeySpec === "RSA_2048")!;
    expect(statements).toEqual([
      { Effect: "Allow", Action: ["dynamodb:GetItem", "dynamodb:Query"], Resource: { "Fn::GetAtt": [stateId, "Arn"] } },
      { Effect: "Allow", Action: "kms:GetPublicKey", Resource: { "Fn::GetAtt": [keyId, "Arn"] } },
    ]);
    // No Secrets Manager access, and no other managed policy attached to the role.
    const role = ofType(named, "AWS::IAM::Role").find(([id]) => /^RealtimeAuthorizerServiceRole[0-9A-F]{8}$/.test(id))![1];
    expect(JSON.stringify(role.Properties.Policies ?? [])).not.toContain("secretsmanager");
    expect(ofType(named, "AWS::IAM::ManagedPolicy").filter(([, policy]) => JSON.stringify(policy.Properties.Roles).includes("RealtimeAuthorizer"))).toEqual([]);
    // The authorizer is told which table and key, and nothing else.
    const authorizer = ofType(named, "AWS::Lambda::Function").find(([id]) => /^RealtimeAuthorizer[0-9A-F]{8}$/.test(id))![1];
    expect(Object.keys((authorizer.Properties.Environment as { Variables: Json }).Variables).sort()).toEqual(["DEVELOPER_TOKEN_KEY_ARN", "STATE_TABLE_NAME"]);
  });

  it("keeps the token key's signing to the sign-in function and lets the authorizer read only its public half", () => {
    const [keyId, key] = ofType(named, "AWS::KMS::Key").find(([, resource]) => resource.Properties.KeySpec === "RSA_2048")!;
    const denies = (key.Properties.KeyPolicy as { Statement: Statement[] }).Statement.filter((statement) => statement.Effect === "Deny");
    const sign = denies.find((statement) => actionsOf(statement).includes("kms:Sign"))!;
    const read = denies.find((statement) => actionsOf(statement).includes("kms:GetPublicKey"))!;
    expect(actionsOf(sign)).toEqual(["kms:Sign"]);
    expect(actionsOf(read)).toEqual(["kms:GetPublicKey"]);
    expect(JSON.stringify(sign.Condition)).not.toContain("RealtimeAuthorizer");
    expect(JSON.stringify(read.Condition)).toContain("RealtimeAuthorizerServiceRole");
    expect(keyId).toMatch(/TokenKey/);
  });
});

describe("the broker", () => {
  it("keeps each named grant policy at or under 5,500 characters, and puts nothing of Plan 5 in the orchestration policy", () => {
    const policies = ofType(named, "AWS::IAM::ManagedPolicy").filter(([, policy]) => /^agentx-staging-broker-(state|orchestration|integrations)$/.test(String(policy.Properties.ManagedPolicyName)));
    expect(policies.map(([, policy]) => policy.Properties.ManagedPolicyName).sort()).toEqual(["agentx-staging-broker-integrations", "agentx-staging-broker-orchestration", "agentx-staging-broker-state"]);
    for (const [, policy] of policies) expect(JSON.stringify(policy.Properties.PolicyDocument).length, String(policy.Properties.ManagedPolicyName)).toBeLessThanOrEqual(5_500);
    const orchestration = policies.find(([, policy]) => policy.Properties.ManagedPolicyName === "agentx-staging-broker-orchestration")![1];
    expect(JSON.stringify(orchestration.Properties.PolicyDocument)).not.toMatch(/appsync|Realtime/);
    const integrations = policies.find(([, policy]) => policy.Properties.ManagedPolicyName === "agentx-staging-broker-integrations")![1];
    expect(statementsOf(integrations).filter((statement) => actionsOf(statement).some((action) => action.startsWith("appsync:")))).toHaveLength(1);
  });

  it("is given the API's DNS prefix in its names, builds the endpoint from it, and stays under 4 KB of variables on every environment name", () => {
    expect(BROKER_NAMES.realtimeApi).toEqual({ code: "rt", variable: "REALTIME_HTTP_ENDPOINT", kind: "eventApiEndpoint" });
    const [apiId] = ofType(named, "AWS::AppSync::Api")[0]!;
    const [, broker] = ofType(named, "AWS::Lambda::Function").find(([id]) => /^Broker[0-9A-F]{8}$/.test(id))!;
    const variables = (broker.Properties.Environment as { Variables: Json }).Variables;
    expect(JSON.stringify(variables.AGENTX_NAMES)).toMatch(/[",]rt=/);
    expect(JSON.stringify(variables.AGENTX_NAMES)).toContain(`"${apiId}","Dns.Http"`);
    expect(variables.REALTIME_HTTP_ENDPOINT).toBeUndefined();
    for (const env of ["staging", "a1234567890123456789"]) {
      const stack = buildAgentXApp({ agentxEnv: env, agentxCloud: true }).node.children.filter((child): child is Stack => Stack.isStack(child)).find((s) => s.stackName === `agentx-${env}-control-plane`)!;
      const found = lambdaEnvironments(Template.fromStack(stack).toJSON() as ResolvableTemplate, { env, stackName: stack.stackName, parameterValues: DEPLOY_PARAMETER_VALUES }).find((entry) => /^Broker[0-9A-F]{8}$/.test(entry.logicalId))!;
      expect(found.bytes, env).toBeLessThanOrEqual(LAMBDA_ENVIRONMENT_LIMIT_BYTES);
    }
  }, 300_000);

  it("is given the DNS prefix of the API's HTTP host (Dns.Http), not its id, so the endpoint it builds and the socket address it answers with are hosts that exist (staging 0.4.3)", () => {
    const [apiLogicalId] = ofType(named, "AWS::AppSync::Api")[0]!;
    const [, broker] = ofType(named, "AWS::Lambda::Function").find(([id]) => /^Broker[0-9A-F]{8}$/.test(id))!;
    const raw = JSON.stringify((broker.Properties.Environment as { Variables: Json }).Variables.AGENTX_NAMES);
    // The template takes the prefix from the attribute the Events API publishes its host in, and never from the API's id.
    expect(raw).toContain(`"Fn::GetAtt":["${apiLogicalId}","Dns.Http"]`);
    expect(raw).not.toContain(`"${apiLogicalId}","ApiId"`);
    const found = lambdaEnvironments(named, { env: "staging", stackName: namedStack.stackName, parameterValues: DEPLOY_PARAMETER_VALUES }).find((entry) => /^Broker[0-9A-F]{8}$/.test(entry.logicalId))!;
    const environment: MutableEnvironment = { AWS_REGION: LAMBDA_RESOLVER_REGION, AGENTX_ACCOUNT_ID: "123456789012", AGENTX_ENV: "staging", AGENTX_NAMES: found.variables.AGENTX_NAMES };
    hydrateBrokerEnvironment(environment);
    expect(APPSYNC_DNS_PREFIX).not.toBe(APPSYNC_API_ID);
    expect(environment.REALTIME_HTTP_ENDPOINT).toBe(`https://${APPSYNC_DNS_PREFIX}.appsync-api.${LAMBDA_RESOLVER_REGION}.amazonaws.com/event`);
    expect(realtimeSocketEndpoint(environment.REALTIME_HTTP_ENDPOINT!)).toBe(`wss://${APPSYNC_DNS_PREFIX}.appsync-realtime-api.${LAMBDA_RESOLVER_REGION}.amazonaws.com/event/realtime`);
    // The outbox publisher's host, which was always right, is the same host the broker now publishes to.
    const publisher = lambdaEnvironments(named, { env: "staging", stackName: namedStack.stackName, parameterValues: DEPLOY_PARAMETER_VALUES }).find((entry) => /^OutboxPublisher[0-9A-F]{8}$/.test(entry.logicalId))!;
    expect(publisher.variables.REALTIME_HTTP_ENDPOINT).toBe(environment.REALTIME_HTTP_ENDPOINT);
  });

  it("gives the outbox publisher the API's whole HTTP endpoint", () => {
    const [, publisher] = ofType(named, "AWS::Lambda::Function").find(([id]) => /^OutboxPublisher[0-9A-F]{8}$/.test(id))!;
    const variables = (publisher.Properties.Environment as { Variables: Json }).Variables;
    const [apiId] = ofType(named, "AWS::AppSync::Api")[0]!;
    expect(variables.REALTIME_HTTP_ENDPOINT).toEqual({ "Fn::Join": ["", ["https://", { "Fn::GetAtt": [apiId, "Dns.Http"] }, "/event"]] });
  });
});

describe("the access policies", () => {
  const scope = { env: "staging", partition: "aws", region: "us-east-1", account: "123456789012", artifactBucketArn: "arn:aws:s3:::b", pullThroughPrefix: "agentx-staging", cloudFormationRoleName: "agentx-staging-cloudformation" };

  it("list the AppSync Events create, update, delete, get and tag actions for the API and its namespaces, and nothing wider", () => {
    // CreateApi and ListApis take no resource type: their own statement on "*" in the deploy region (access-policies.test.ts).
    expect([...APPSYNC_EVENTS_ACTIONS, ...APPSYNC_EVENTS_UNSCOPED_ACTIONS].sort()).toEqual([
      "appsync:CreateApi", "appsync:CreateChannelNamespace", "appsync:DeleteApi", "appsync:DeleteChannelNamespace", "appsync:GetApi", "appsync:GetChannelNamespace",
      "appsync:ListApis", "appsync:ListTagsForResource", "appsync:TagResource", "appsync:UntagResource", "appsync:UpdateApi", "appsync:UpdateChannelNamespace",
    ]);
    for (const statements of [serviceRoleStatements(scope), defaultBoundaryStatements(scope)]) {
      const statement = statements.find((st) => st.Sid === "AppSyncEvents")!;
      expect(statement).toEqual({ Sid: "AppSyncEvents", Effect: "Allow", Action: [...APPSYNC_EVENTS_ACTIONS], Resource: "arn:aws:appsync:us-east-1:123456789012:apis/*" });
      expect(statements.flatMap((st) => st.Action).filter((action) => action.startsWith("appsync:") && action !== "appsync:EventPublish").sort()).toEqual([...APPSYNC_EVENTS_ACTIONS, ...APPSYNC_EVENTS_UNSCOPED_ACTIONS].sort());
    }
    // The boundary lets the broker and the outbox publisher publish to the namespace and nothing else; the service role does not publish.
    expect(defaultBoundaryStatements(scope).find((st) => st.Sid === "AppSyncEventsPublish")).toEqual({
      Sid: "AppSyncEventsPublish", Effect: "Allow", Action: ["appsync:EventPublish"], Resource: "arn:aws:appsync:us-east-1:123456789012:apis/*/channelNamespace/rovara",
    });
    expect(serviceRoleStatements(scope).flatMap((st) => st.Action)).not.toContain("appsync:EventPublish");
    // The service role's lambda:* already covers lambda:AddPermission and lambda:RemovePermission (the authorizer's invoke permission).
    expect(serviceRoleStatements(scope).find((st) => st.Sid === "Services")!.Action).toContain("lambda:*");
  });
});
