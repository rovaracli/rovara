import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { Code } from "aws-cdk-lib/aws-lambda";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { CloudWebStack } from "../../infra/lib/cloud-web.js";
import { globMatch, resolvedBoundaries, roleCases, type CfnTemplate } from "../../infra/lib/cloud-boundary-check.js";
import { meterPartition } from "../../packages/cloud-server/src/gateway-meter-read.js";

const built = mkdtempSync(join(tmpdir(), "cloud-meter-"));
mkdirSync(join(built, "assets"));
writeFileSync(join(built, "index.html"), "<!doctype html>");
writeFileSync(join(built, "assets/index-abc.js"), "export {};");
afterAll(() => rmSync(built, { recursive: true, force: true }));
const scope = { env: "staging", partition: "aws", region: "us-east-1", account: "123456789012" };
const stackName = "rovara-cloud-staging-web";
const template = Template.fromStack(new CloudWebStack(new App(), "RovaraCloudWeb", {
  environmentName: scope.env, stackName, env: { region: scope.region, account: scope.account },
  appDirectory: built, code: Code.fromInline("export const handler = async () => ({});"),
})).toJSON() as CfnTemplate & { Parameters: Record<string, unknown> };
type Statement = { Sid?: string; Effect: string; Action: string | string[]; Resource: unknown; Condition?: Record<string, Record<string, unknown>> };
const resources = template.Resources as Record<string, { Type: string; Properties: Record<string, unknown> }>;
const server = Object.values(resources).find((r) => r.Type === "AWS::Lambda::Function" && JSON.stringify(r.Properties).includes("CLOUD_TABLE"))!.Properties;
const role = (server.Role as { "Fn::GetAtt": string[] })["Fn::GetAtt"][0]!;
const policies = Object.values(resources).filter((r) => r.Type === "AWS::IAM::Policy");
const statements = policies.flatMap((p) => (p.Properties.PolicyDocument as { Statement: Statement[] }).Statement);
const expectedArn = { "Fn::Join": ["", ["arn:", { Ref: "AWS::Partition" }, ":dynamodb:us-east-1:123456789012:table/", { Ref: "GatewayMeterTableName" }]] };

// The existing boundary checker resolves CloudFormation ARNs and IAM wildcards but does not evaluate conditions.
// Model only the two operators used here; unknown operators fail the test instead of silently allowing access.
function conditionsMatch(condition: Statement["Condition"], keys: string[] | undefined): boolean {
  return Object.entries(condition ?? {}).every(([operator, entries]) => Object.entries(entries).every(([key, expected]) => {
    expect(key).toBe("dynamodb:LeadingKeys");
    if (operator === "Null") return (keys === undefined || keys.length === 0) === (expected === "true");
    if (operator === "ForAllValues:StringLike") return (keys ?? []).every((value) => [expected].flat().some((pattern) => globMatch(String(pattern), value)));
    throw new Error(`unsupported condition operator: ${operator}`);
  }));
}

describe("Cloud reads the gateway's meter only by company item keys", () => {
  it("grants exactly the two item reads on the meter ARN, with LeadingKeys and Null, only to the server", () => {
    const grant = statements.find((s) => s.Sid === "GatewayMeterCompanyReads");
    expect(grant).toEqual({
      Sid: "GatewayMeterCompanyReads", Effect: "Allow", Action: ["dynamodb:GetItem", "dynamodb:BatchGetItem"], Resource: expectedArn,
      Condition: { "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["CO#*"] }, Null: { "dynamodb:LeadingKeys": "false" } },
    });
    const onMeter = statements.filter((s) => JSON.stringify(s.Resource).includes("GatewayMeterTableName") || s.Resource === "*");
    expect(onMeter).toEqual([grant]);
    expect(policies.filter((p) => (p.Properties.PolicyDocument as { Statement: Statement[] }).Statement.includes(grant!)).map((p) => p.Properties.Roles)).toEqual([[{ Ref: role }]]);
    const variables = (server.Environment as { Variables: Record<string, unknown> }).Variables;
    expect(variables.CLOUD_GATEWAY_METER_TABLE).toEqual({ Ref: "GatewayMeterTableName" });
    // The reader derives <CodeUrl>/v1/auth, the same issuer the gateway must trust.
    expect(variables.ROVARA_CODE_URL).toEqual({ Ref: "CodeUrl" });
    expect(template.Parameters.GatewayMeterTableName).toMatchObject({ Type: "String", AllowedPattern: "^[A-Za-z0-9_.-]{3,255}$" });
    const boundary = (resources.RoleBoundary!.Properties.PolicyDocument as { Statement: Statement[] }).Statement;
    expect(boundary.filter((s) => JSON.stringify(s.Resource).includes("GatewayMeterTableName"))).toEqual([grant]);
  });

  it("intersects the synthesized identity policy and boundary: company reads allowed; other keys, tables and actions denied", () => {
    const stacks = [{ stackName, template }];
    const allCases = roleCases(stacks, scope);
    const cases = allCases.filter((c) => c.role === role);
    const boundary = resolvedBoundaries(stacks, scope)[stackName]!.Statement;
    const meter = `arn:aws:dynamodb:us-east-1:123456789012:table/rovara-cloud-staging-gateway-Meter-SAMPLE0000AA`;
    expect(allCases.filter((c) => globMatch(c.resource, meter)).map((c) => ({ role: c.role, action: c.action, resource: c.resource }))).toEqual([
      { role, action: "dynamodb:GetItem", resource: meter }, { role, action: "dynamodb:BatchGetItem", resource: meter },
    ]);
    const allowed = (action: string, keys: string[] | undefined, resource = meter) => {
      const matches = (s: { Action?: string | string[]; Resource?: unknown; Condition?: unknown }) => [s.Action ?? []].flat().some((a) => globMatch(a, action))
        && [s.Resource].flat().some((r) => typeof r === "string" && globMatch(r, resource)) && conditionsMatch(s.Condition as Statement["Condition"], keys);
      const identity = cases.some((c) => globMatch(c.action, action) && globMatch(c.resource, resource)
        && conditionsMatch(statements.find((s) => s.Sid === "GatewayMeterCompanyReads")?.Condition, keys));
      return identity && boundary.some((s) => s.Effect === "Allow" && matches(s)) && !boundary.some((s) => s.Effect === "Deny" && matches(s));
    };
    const a = meterPartition("https://code.example/v1/auth", `org_${"a".repeat(20)}`);
    const b = meterPartition("https://code.example/v1/auth", `org_${"b".repeat(20)}`);
    for (const action of ["dynamodb:GetItem", "dynamodb:BatchGetItem"]) {
      expect(allowed(action, [a])).toBe(true);
      expect(allowed(action, [b])).toBe(true);
      expect(allowed(action, [a, b])).toBe(true);
      for (const keys of [["OTHER#c"], [a, "OTHER#c"], [], undefined]) expect(allowed(action, keys)).toBe(false);
      expect(allowed(action, [a], `${meter}/index/anything`)).toBe(false);
      expect(allowed(action, [a], meter.replace("Meter-", "Ledger-"))).toBe(false);
    }
    for (const action of ["dynamodb:Scan", "dynamodb:Query", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem", "dynamodb:BatchWriteItem"]) expect(allowed(action, [a])).toBe(false);
  });
});
