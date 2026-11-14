// TE-F1e IAM proof (the 0.5.15 lesson): what the synthesized templates of a named environment give the ProductModelEgress function, its role, its key and the worker role. A published template is the placeholder
// environment's with the name replaced, and nothing here depends on the name, so every environment name below must give the same shape. Asserted: NO VpcConfig, NO Function URL, NO Lambda permission (resource
// policy) for anyone, reserved concurrency set, memory within account-limits.ts, the role has no Secrets Manager action and holds DynamoDB only on its key prefixes, the key's Sign is denied to all but the
// dispatcher, and the worker role names exactly this one function ARN with no wildcard. The legacy deployment has none of it.
import { Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { buildAgentXApp } from "../../infra/lib/app.js";
import { ASSUMED_LAMBDA_MEMORY_LIMIT_MB } from "../../infra/lib/account-limits.js";
import { PRODUCT_MODEL_EGRESS_RESERVED_CONCURRENCY } from "../../infra/lib/product-model-egress.js";
import { skipLambdaBundling } from "../support/skip-bundling.js";

skipLambdaBundling();

type Resource = { Type: string; Properties: Record<string, unknown>; Condition?: string };
type Statement = { Sid?: string; Effect: string; Action: string | string[]; Resource?: unknown; Condition?: Record<string, Record<string, unknown>>; Principal?: unknown };
const list = (value: string | string[] | undefined): string[] => (value === undefined ? [] : Array.isArray(value) ? value : [value]);
const text = (value: unknown): string => JSON.stringify(value);

function templates(context: Record<string, string>): Record<string, Record<string, Resource>> {
  const out: Record<string, Record<string, Resource>> = {};
  for (const stack of buildAgentXApp(context).node.children.filter((child): child is Stack => Stack.isStack(child))) out[stack.node.id] = Template.fromStack(stack).toJSON().Resources as Record<string, Resource>;
  return out;
}
const policiesOf = (resources: Record<string, Resource>, roleId: string): Statement[] =>
  Object.values(resources).filter((resource) => resource.Type === "AWS::IAM::Policy" && text(resource.Properties.Roles).includes(roleId)).flatMap((resource) => (resource.Properties.PolicyDocument as { Statement: Statement[] }).Statement);

describe("ProductModelEgress infrastructure", () => {
  for (const env of ["staging", "a1234567890123456789"]) {
    describe(`named environment ${env}`, () => {
      const all = templates({ agentxEnv: env, agentxCloud: "true" });
      const control = all.AgentXControlPlane!;
      const functionId = Object.keys(control).find((id) => control[id]!.Type === "AWS::Lambda::Function" && control[id]!.Properties.FunctionName === `agentx-${env}-product-model-egress`)!;
      const fn = control[functionId]!;
      const roleId = (fn.Properties.Role as { "Fn::GetAtt": [string, string] })["Fn::GetAtt"][0];
      const role = control[roleId]!;

      it("is a function outside the VPC with no Function URL, no resource policy, reserved concurrency and memory within the account limit", () => {
        expect(functionId).toBeDefined();
        expect(fn.Properties.VpcConfig).toBeUndefined();
        // A stack parameter (default 20), so an install whose account cannot take 20 lowers it without a code change; the install preflight refuses one that does not fit.
        expect(fn.Properties.ReservedConcurrentExecutions).toEqual({ Ref: "ProductModelEgressReservedConcurrency" });
        expect(fn.Properties.MemorySize as number).toBeLessThanOrEqual(ASSUMED_LAMBDA_MEMORY_LIMIT_MB);
        expect(fn.Properties.Timeout).toBe(600);
        for (const stack of Object.values(all)) {
          for (const resource of Object.values(stack)) {
            expect(resource.Type).not.toBe("AWS::Lambda::Url");
            if (resource.Type === "AWS::Lambda::Permission" || resource.Type === "AWS::Lambda::EventInvokeConfig" || resource.Type === "AWS::Lambda::EventSourceMapping") expect(text(resource.Properties).includes(functionId)).toBe(false);
            if (resource.Type === "AWS::ApiGatewayV2::Integration") expect(text(resource.Properties).includes(functionId)).toBe(false);
          }
        }
        expect(Object.keys((fn.Properties.Environment as { Variables: Record<string, unknown> }).Variables).sort()).toEqual(["AGENTX_ACCOUNT_ID", "AGENTX_ENV", "PRODUCT_MODEL_EGRESS_KEY_ARN", "ROVARA_EDITION", "STATE_TABLE_NAME"]);
      });

      it("takes its reserved concurrency from a Number parameter, default 20, between 1 and 1000", () => {
        const parameters = buildAgentXApp({ agentxEnv: env, agentxCloud: "true" }).node.children.filter((child): child is Stack => Stack.isStack(child)).find((stack) => stack.node.id === "AgentXControlPlane")!;
        const parameter = (Template.fromStack(parameters).toJSON().Parameters as Record<string, Record<string, unknown>>).ProductModelEgressReservedConcurrency;
        expect(parameter).toMatchObject({ Type: "Number", Default: PRODUCT_MODEL_EGRESS_RESERVED_CONCURRENCY, MinValue: 1, MaxValue: 1000 });
      });

      it("has a fixed-name role under the environment path, trusted by Lambda only, with the boundary", () => {
        expect(role.Properties.RoleName).toBe(`agentx-${env}-connector-secrets-product-egress`);
        expect(role.Properties.Path).toBe(`/agentx/${env}/`);
        expect(role.Properties.PermissionsBoundary).toBeDefined();
        expect(text(role.Properties.AssumeRolePolicyDocument)).toContain("lambda.amazonaws.com");
        expect(role.Properties.ManagedPolicyArns).toBeUndefined();
        expect(role.Properties.Policies).toBeUndefined();
      });

      it("holds no Secrets Manager action, DynamoDB only on its prefixes (read-only on the operation records), and STS only on ProductAiSecretsRole", () => {
        const statements = policiesOf(control, roleId);
        const actions = statements.flatMap((statement) => list(statement.Action));
        expect(actions.some((action) => action.startsWith("secretsmanager:"))).toBe(false);
        expect(actions.some((action) => action.endsWith("*"))).toBe(false);
        expect(statements.every((statement) => statement.Effect === "Allow")).toBe(true);
        const bySid = new Map(statements.filter((statement) => statement.Sid !== undefined).map((statement) => [statement.Sid!, statement]));
        const write = bySid.get("ProductAiMeterInState")!;
        expect(list(write.Action).sort()).toEqual(["dynamodb:ConditionCheckItem", "dynamodb:DeleteItem", "dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:Query", "dynamodb:UpdateItem"]);
        expect(write.Condition).toEqual({ "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["product-ai-meter#*"] }, Null: { "dynamodb:LeadingKeys": "false" } });
        // F1-d's source items are READ only (REVIEW-1 L-5): no write action may reach a `product-ai#` key.
        const sources = bySid.get("ReadProductAiSources")!;
        expect(list(sources.Action).sort()).toEqual(["dynamodb:GetItem", "dynamodb:Query"]);
        expect(sources.Condition).toEqual({ "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["product-ai#*"] }, Null: { "dynamodb:LeadingKeys": "false" } });
        for (const statement of statements) {
          const keys = text(statement.Condition);
          if (list(statement.Action).some((action) => /^dynamodb:(Put|Update|Delete|ConditionCheck)/u.test(action))) expect(keys.includes("product-ai#") || keys.includes("product-ai*"), statement.Sid).toBe(false);
        }
        const read = bySid.get("ReadOperationRecords")!;
        expect(list(read.Action)).toEqual(["dynamodb:GetItem"]);
        expect(read.Condition).toEqual({ "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["WORKSPACE#*", "DEVTASK#*"] }, Null: { "dynamodb:LeadingKeys": "false" } });
        for (const statement of [write, sources, read]) expect(text(statement.Resource)).toMatch(/^\{"Fn::GetAtt":\["State[0-9A-F]{8}","Arn"\]\}$/u);
        const sts = bySid.get("AssumeProductAiSecretsRole")!;
        expect(list(sts.Action).sort()).toEqual(["sts:AssumeRole", "sts:TagSession"]);
        expect(text(sts.Resource)).toContain(`:role/agentx/${env}/agentx-${env}-connector-secrets-product-ai"`);
        expect(text(sts.Resource)).not.toContain("*");
        expect(list(bySid.get("ReadCapabilityPublicKey")!.Action)).toEqual(["kms:GetPublicKey"]);
        // Every DynamoDB statement is one of the two above; logs are its own group's.
        const dynamo = statements.filter((statement) => list(statement.Action).some((action) => action.startsWith("dynamodb:")));
        expect(dynamo).toHaveLength(3);
      });

      it("signs capabilities with a P-256 key whose Sign is denied to every principal but the dispatcher", () => {
        const keyId = Object.keys(control).find((id) => id.startsWith("ProductModelEgressSigningKey") && control[id]!.Type === "AWS::KMS::Key")!;
        const key = control[keyId]!;
        expect(key.Properties.KeySpec).toBe("ECC_NIST_P256");
        expect(key.Properties.KeyUsage).toBe("SIGN_VERIFY");
        const policy = (key.Properties.KeyPolicy as { Statement: Statement[] }).Statement;
        const deny = policy.find((statement) => statement.Sid === "SignOnlyAsDispatcher")!;
        expect(deny).toMatchObject({ Effect: "Deny", Action: "kms:Sign", Principal: { AWS: "*" } });
        expect(text(deny.Condition)).toMatch(/ArnNotEquals.*aws:PrincipalArn.*Dispatcher/u);
        const dispatcherId = Object.keys(control).find((id) => id.startsWith("Dispatcher") && control[id]!.Type === "AWS::Lambda::Function")!;
        const dispatcherRole = (control[dispatcherId]!.Properties.Role as { "Fn::GetAtt": [string, string] })["Fn::GetAtt"][0];
        expect(policiesOf(control, dispatcherRole).some((statement) => list(statement.Action).includes("kms:Sign") && text(statement.Resource).includes(keyId))).toBe(true);
        // No other role may sign with it.
        const signers = Object.values(control).filter((resource) => resource.Type === "AWS::IAM::Policy" && (resource.Properties.PolicyDocument as { Statement: Statement[] }).Statement.some((statement) => list(statement.Action).includes("kms:Sign") && text(statement.Resource).includes(keyId)));
        expect(signers).toHaveLength(1);
      });

      it("gives the worker role ONE statement: lambda:InvokeFunction on exactly this function's ARN, no wildcard, no qualifier", () => {
        const foundation = all.AgentXFoundation ?? Object.values(all).find((resources) => Object.values(resources).some((resource) => text(resource.Properties).includes("InvokeProductModelEgress")))!;
        const statements = Object.values(foundation).filter((resource) => resource.Type === "AWS::IAM::Policy").flatMap((resource) => (resource.Properties.PolicyDocument as { Statement: Statement[] }).Statement);
        const invoke = statements.filter((statement) => list(statement.Action).some((action) => action.startsWith("lambda:")));
        expect(invoke).toHaveLength(1);
        expect(invoke[0]!.Sid).toBe("InvokeProductModelEgress");
        expect(list(invoke[0]!.Action)).toEqual(["lambda:InvokeFunction"]);
        const arn = text(invoke[0]!.Resource);
        expect(arn).toContain(`:function:agentx-${env}-product-model-egress"`);
        expect(arn).not.toContain("*");
      });
    });
  }

  it("the legacy deployment has none of it", () => {
    const all = templates({});
    for (const resources of Object.values(all)) {
      expect(text(resources).includes("product-model-egress")).toBe(false);
      expect(text(resources).includes("InvokeProductModelEgress")).toBe(false);
    }
  });
});
