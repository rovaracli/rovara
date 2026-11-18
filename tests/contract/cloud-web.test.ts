import { App } from "aws-cdk-lib";
import { Code } from "aws-cdk-lib/aws-lambda";
import { Match, Template } from "aws-cdk-lib/assertions";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CLOUD_TABLE, COMPANY_TABLE } from "../../packages/cloud-server/src/index.js";
import { CLOUD_WEB_STARTED_BY_INDEX, CLOUD_WEB_TABLE_ACCESS, CloudWebStack, cloudWebStackName } from "../../infra/lib/cloud-web.js";
import { CLOUD_APP_CLIENT_ID } from "../../infra/lib/cloud-app.js";
import { buildAgentXApp } from "../../infra/lib/app.js";
import { TransactWriteCommand, type TransactWriteCommandInput } from "@aws-sdk/lib-dynamodb";
import { DynamoCompanyStore } from "../../packages/cloud-server/src/company-dynamo.js";
import { DynamoCloudAuditStore } from "../../packages/cloud-server/src/dynamo-stores.js";
import { recordCloudAction } from "../../packages/cloud-server/src/audit-log.js";

// A built app with one page shell and one asset, as packages/web/dist/app has.
const built = (() => {
  const dir = mkdtempSync(join(tmpdir(), "cloud-web-app-"));
  mkdirSync(join(dir, "assets"));
  writeFileSync(join(dir, "index.html"), "<!doctype html>");
  writeFileSync(join(dir, "assets", "index-abc.js"), "export {};");
  return dir;
})();
const synth = (environmentName: string) => Template.fromStack(new CloudWebStack(new App(), "RovaraCloudWeb", {
  environmentName, env: { region: "us-east-1" }, appDirectory: built, code: Code.fromInline("export const handler = async () => ({});"),
}));

describe("Rovara Cloud on CloudFront, Lambda and DynamoDB (Rovara-cloud#11)", () => {
  const template = synth("production");
  const resources = template.toJSON().Resources as Record<string, { Type: string; Properties: Record<string, unknown>; DeletionPolicy?: string }>;
  const idOf = (type: string, where: (properties: Record<string, unknown>) => boolean = () => true) => Object.entries(resources).find(([, each]) => each.Type === type && where(each.Properties))![0];
  const server = () => Object.values(resources).find((each) => each.Type === "AWS::Lambda::Function" && JSON.stringify(each.Properties).includes("CLOUD_TABLE"))!.Properties;

  it("sends the app's files to S3 and everything else to the function, caching only the files", () => {
    const distribution = Object.values(template.findResources("AWS::CloudFront::Distribution"))[0]!.Properties as { DistributionConfig: Record<string, unknown> };
    const config = distribution.DistributionConfig as { DefaultCacheBehavior: Record<string, unknown>; CacheBehaviors: Array<Record<string, unknown>>; Origins: Array<Record<string, unknown>> };
    // The managed policies: CachingDisabled and AllViewerExceptHostHeader for the function, CachingOptimized for the files.
    expect(config.DefaultCacheBehavior).toMatchObject({ CachePolicyId: "4135ea2d-6df8-44a3-9df3-4b5a84be39ad", OriginRequestPolicyId: "b689b0a8-53d0-40ab-baf2-68738e2966ac", ViewerProtocolPolicy: "redirect-to-https" });
    expect(config.DefaultCacheBehavior.AllowedMethods).toEqual(expect.arrayContaining(["GET", "HEAD", "OPTIONS", "PUT", "PATCH", "POST", "DELETE"]));
    expect(config.CacheBehaviors).toHaveLength(1);
    expect(config.CacheBehaviors[0]).toMatchObject({ PathPattern: "/app/assets/*", CachePolicyId: "658327ea-f89d-4fab-a63d-7e88639e58f6", ViewerProtocolPolicy: "redirect-to-https" });
    // The function's own address is not one people use: CloudFront reaches it, and the files bucket only through its access control.
    expect(JSON.stringify(config.Origins)).toContain(idOf("AWS::Lambda::Url"));
    expect(config.Origins.some((origin) => "OriginAccessControlId" in origin)).toBe(true);
    template.hasResourceProperties("AWS::S3::Bucket", { PublicAccessBlockConfiguration: { BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true } });
  });

  it("takes requests only from its own CloudFront distribution: IAM auth on the function URL, signed by origin access control", () => {
    const urlId = idOf("AWS::Lambda::Url");
    template.hasResourceProperties("AWS::Lambda::Url", { AuthType: "AWS_IAM" });
    template.resourcePropertiesCountIs("AWS::Lambda::Url", { AuthType: "NONE" }, 0);
    // A Lambda origin access control that always signs with SigV4.
    const controls = template.findResources("AWS::CloudFront::OriginAccessControl");
    const lambdaControl = Object.entries(controls).find(([, each]) => (each.Properties as { OriginAccessControlConfig: { OriginAccessControlOriginType: string } }).OriginAccessControlConfig.OriginAccessControlOriginType === "lambda");
    expect(lambdaControl).toBeDefined();
    expect((lambdaControl![1].Properties as { OriginAccessControlConfig: unknown }).OriginAccessControlConfig).toMatchObject({ SigningBehavior: "always", SigningProtocol: "sigv4" });
    // The function's origin in the distribution uses it.
    const config = (Object.values(template.findResources("AWS::CloudFront::Distribution"))[0]!.Properties as { DistributionConfig: { Origins: Array<Record<string, unknown>> } }).DistributionConfig;
    const functionOrigin = config.Origins.find((origin) => JSON.stringify(origin.DomainName).includes(urlId))!;
    expect(functionOrigin.OriginAccessControlId).toEqual({ "Fn::GetAtt": [lambdaControl![0], "Id"] });
    // Invoke rights: only CloudFront, only for this distribution, and nothing public.
    const distributionId = idOf("AWS::CloudFront::Distribution");
    const permissions = Object.values(template.findResources("AWS::Lambda::Permission")).map((each) => each.Properties as Record<string, unknown>);
    expect(permissions.map((each) => each.Action).sort()).toEqual(["lambda:InvokeFunction", "lambda:InvokeFunctionUrl"]);
    for (const permission of permissions) {
      expect(permission.Principal).toBe("cloudfront.amazonaws.com");
      expect(permission.SourceArn).toEqual({ "Fn::Join": ["", ["arn:", { Ref: "AWS::Partition" }, ":cloudfront::", { Ref: "AWS::AccountId" }, ":distribution/", { Ref: distributionId }]] });
      expect(permission).not.toHaveProperty("FunctionUrlAuthType", "NONE");
    }
    expect(permissions.find((each) => each.Action === "lambda:InvokeFunction")).toMatchObject({ InvokedViaFunctionUrl: true });
    // The payload hash a signed write needs reaches CloudFront's signer: all viewer headers but Host go to the function.
    expect((config as unknown as { DefaultCacheBehavior: Record<string, unknown> }).DefaultCacheBehavior.OriginRequestPolicyId).toBe("b689b0a8-53d0-40ab-baf2-68738e2966ac");
  });

  it("gives the server only the table's item actions its stores use, each on its own key prefix, and no Scan", () => {
    const role = (server().Role as { "Fn::GetAtt": [string, string] })["Fn::GetAtt"][0];
    // The State table is the one with the startedBy index (the company table has none).
    const stateTable = idOf("AWS::DynamoDB::GlobalTable", (properties) => JSON.stringify(properties).includes("GlobalSecondaryIndexes"));
    const tableArn = { "Fn::GetAtt": [stateTable, "Arn"] };
    type Statement = { Effect: string; Action: string | string[]; Resource: unknown; Condition?: unknown };
    const statements = Object.values(template.findResources("AWS::IAM::Policy"))
      .filter((each) => JSON.stringify((each.Properties as { Roles: unknown }).Roles).includes(role))
      .flatMap((each) => (each.Properties as { PolicyDocument: { Statement: Statement[] } }).PolicyDocument.Statement);
    const onTable = statements.filter((statement) => [statement.Action].flat().some((action) => action.startsWith("dynamodb:")) && JSON.stringify(statement.Resource).includes(`"${stateTable}"`));
    expect(onTable).toEqual([
      ...[
        ["SIGNIN#", ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem"]],
        ["PENDING#", ["dynamodb:PutItem", "dynamodb:DeleteItem"]],
        ["SESSION#", ["dynamodb:PutItem", "dynamodb:Query"]],
        ["REQUEST#", ["dynamodb:GetItem", "dynamodb:PutItem"]],
        ["PRESENCE#", ["dynamodb:PutItem", "dynamodb:Query"]],
        ["AUDIT#", ["dynamodb:PutItem", "dynamodb:Query"]],
        ["AUDITID#", ["dynamodb:PutItem"]],
      ].map(([prefix, actions]) => ({
        // CloudFormation renders a single action as a string.
        Effect: "Allow", Action: (actions as string[]).length === 1 ? (actions as string[])[0] : actions, Resource: tableArn,
        Condition: { "ForAllValues:StringLike": { "dynamodb:LeadingKeys": `${prefix as string}*` }, Null: { "dynamodb:LeadingKeys": "false" } },
      })),
      { Effect: "Allow", Action: "dynamodb:Query", Resource: { "Fn::Join": ["", [tableArn, `/index/${CLOUD_TABLE.startedByIndex}`]] } },
    ]);
    const all = onTable.flatMap((statement) => [statement.Action].flat());
    for (const refused of ["dynamodb:Scan", "dynamodb:BatchGetItem", "dynamodb:BatchWriteItem", "dynamodb:ConditionCheckItem", "dynamodb:GetRecords", "dynamodb:GetShardIterator", "dynamodb:DescribeTable", "dynamodb:*"]) expect(all).not.toContain(refused);
    // No other statement names the table at all.
    expect(statements.filter((statement) => !onTable.includes(statement) && JSON.stringify(statement.Resource).includes(stateTable))).toEqual([]);
  });

  it("names the same key prefixes the server's stores use (a new prefix in the stores needs its rights here)", () => {
    const sources = ["packages/cloud-server/src/dynamo-stores.ts", "packages/cloud-server/src/session-table.ts"].map((file) => readFileSync(file, "utf8")).join("\n");
    const used = new Set([...sources.matchAll(/(?:\bpk:|":pk":)\s*`([A-Z]+#)/gu)].map((match) => match[1]!));
    // STARTED# is the startedBy index's partition (gsi1pk), read through the index statement only.
    expect([...used].sort()).toEqual([...CLOUD_WEB_TABLE_ACCESS.map((each) => each.prefix), "STARTED#"].sort());
    expect(sources).toContain("gsi1pk: `STARTED#");
    expect(CLOUD_WEB_STARTED_BY_INDEX).toBe(CLOUD_TABLE.startedByIndex);
  });

  it("adds each release's files and deletes none, so a page opened before a release still finds its chunks", () => {
    template.hasResourceProperties("Custom::CDKBucketDeployment", { Prune: false, DestinationBucketKeyPrefix: "app/assets/", SystemMetadata: { "cache-control": "public, max-age=31536000, immutable" } });
  });

  it("keeps its state in one table shaped as the stores read it, kept and recoverable", () => {
    template.hasResourceProperties("AWS::DynamoDB::GlobalTable", {
      KeySchema: [{ AttributeName: CLOUD_TABLE.partitionKey, KeyType: "HASH" }, { AttributeName: CLOUD_TABLE.sortKey, KeyType: "RANGE" }],
      TimeToLiveSpecification: { AttributeName: CLOUD_TABLE.ttlAttribute, Enabled: true },
      GlobalSecondaryIndexes: [Match.objectLike({ IndexName: CLOUD_TABLE.startedByIndex, KeySchema: [{ AttributeName: CLOUD_TABLE.startedByKey, KeyType: "HASH" }, { AttributeName: CLOUD_TABLE.startedBySort, KeyType: "RANGE" }] })],
      Replicas: [Match.objectLike({ DeletionProtectionEnabled: true, PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true } })],
    });
    template.hasResource("AWS::DynamoDB::GlobalTable", { DeletionPolicy: "Retain" });
  });

  it("runs the server on Lambda with the settings it reads, and the same client secret as the Fargate app", () => {
    expect(server()).toMatchObject({ Runtime: "nodejs22.x", Architectures: ["arm64"], MemorySize: 1024, Timeout: 30 });
    const variables = (server().Environment as { Variables: Record<string, unknown> }).Variables;
    expect(variables).toMatchObject({
      ROVARA_CODE_URL: { Ref: "CodeUrl" }, ROVARA_CLIENT_ID: CLOUD_APP_CLIENT_ID, CLOUD_TABLE: { Ref: idOf("AWS::DynamoDB::GlobalTable") },
      CLOUD_ORIGIN_PARAMETER: "/rovara-cloud/production/web/origin", CLOUD_CLIENT_SECRET_ID: "rovara-cloud/production/code-client-secret", CLOUD_APP_DIRECTORY: "/var/task/app",
    });
    template.resourceCountIs("AWS::SecretsManager::Secret", 0);
    // Sign-ins are sealed with this stack's own key, which only the function's role may use, and only for sign-ins.
    expect(variables.CLOUD_SESSIONS_KEY_ID).toEqual({ "Fn::GetAtt": [idOf("AWS::KMS::Key"), "Arn"] });
    template.hasResource("AWS::KMS::Key", { Properties: Match.objectLike({ EnableKeyRotation: true }), DeletionPolicy: "Retain" });
    const role = (server().Role as { "Fn::GetAtt": [string, string] })["Fn::GetAtt"][0];
    const statements = (Object.values(template.findResources("AWS::KMS::Key"))[0]!.Properties as { KeyPolicy: { Statement: Array<{ Sid?: string; Principal: unknown; Action: string | string[] }> } }).KeyPolicy.Statement;
    const actions = (statement: { Action: string | string[] }) => [statement.Action].flat();
    expect(statements.filter((statement) => actions(statement).some((action) => /^kms:(Decrypt|GenerateDataKey|Encrypt|CreateGrant|Create\*|\*)/u.test(action)))).toEqual([
      expect.objectContaining({ Sid: "OnlyCloudsServerSeals", Principal: { AWS: { "Fn::GetAtt": [role, "Arn"] } }, Action: ["kms:GenerateDataKey", "kms:Decrypt"], Condition: { StringEquals: { "kms:EncryptionContext:purpose": "rovara-cloud-session" } } }),
    ]);
    template.hasResourceProperties("AWS::SSM::Parameter", { Name: "/rovara-cloud/production/web/origin", Value: Match.objectLike({ "Fn::Join": ["", ["https://", Match.anyValue()]] }) });
  });

  it("keeps company data in a table of its own, kept and recoverable, granted to the server item by item", () => {
    const companies = idOf("AWS::DynamoDB::GlobalTable", (properties) => JSON.stringify(properties).includes("SSESpecification") && !JSON.stringify(properties).includes("GlobalSecondaryIndexes"));
    expect(resources[companies]!.DeletionPolicy).toBe("Retain");
    expect(resources[companies]!.Properties).toMatchObject({
      KeySchema: [{ AttributeName: COMPANY_TABLE.partitionKey, KeyType: "HASH" }, { AttributeName: COMPANY_TABLE.sortKey, KeyType: "RANGE" }],
      TimeToLiveSpecification: { AttributeName: COMPANY_TABLE.ttlAttribute, Enabled: true },
      SSESpecification: { SSEEnabled: true, SSEType: "KMS" },
      Replicas: [expect.objectContaining({ DeletionProtectionEnabled: true, PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true } })],
    });
    const variables = (server().Environment as { Variables: Record<string, unknown> }).Variables;
    expect(variables.COMPANY_TABLE).toEqual({ Ref: companies });
    // DEC 253z: the company comes only from Code's access check. No deployment-wide company setting, and no parameter to pass one.
    expect(Object.keys(variables)).not.toContain("CLOUD_COMPANY_ID");
    expect(Object.keys((template.toJSON() as { Parameters: Record<string, unknown> }).Parameters)).not.toContain("CompanyId");
    // DEC 254zzz27: exactly five actions, on this table only, attached to the web server role.
    type Statement = { Effect: string; Action: string | string[]; Resource: unknown; Condition?: unknown };
    const policies = Object.values(template.findResources("AWS::IAM::Policy"));
    const statements = policies.flatMap((policy) => (policy.Properties as { PolicyDocument: { Statement: Statement[] } }).PolicyDocument.Statement);
    const onCompanies = statements.filter((statement) => JSON.stringify(statement.Resource).includes(companies));
    const expected = { Effect: "Allow", Action: ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:DeleteItem", "dynamodb:Query", "dynamodb:ConditionCheckItem"], Resource: { "Fn::GetAtt": [companies, "Arn"] } };
    expect(onCompanies).toEqual([expected]);
    const companyPolicies = policies.filter((policy) => (policy.Properties as { PolicyDocument: { Statement: Statement[] } }).PolicyDocument.Statement.includes(onCompanies[0]!));
    expect(companyPolicies).toHaveLength(1);
    expect((companyPolicies[0]!.Properties as { Roles: unknown }).Roles).toEqual([{ Ref: (server().Role as { "Fn::GetAtt": [string, string] })["Fn::GetAtt"][0] }]);
    // The existing boundary already permits this action; no other identity-policy statement may gain it.
    expect(statements.filter((statement) => [statement.Action].flat().includes("dynamodb:ConditionCheckItem"))).toEqual([expected]);
  });

  it.each(["project_month", "person_month"] as const)("covers every actual %s save, replacement, removal and audit transaction item", async (kind) => {
    const variables = (server().Environment as { Variables: Record<string, { Ref: string }> }).Variables;
    const companies = variables.COMPANY_TABLE!.Ref;
    const state = variables.CLOUD_TABLE!.Ref;
    const role = (server().Role as { "Fn::GetAtt": [string, string] })["Fn::GetAtt"][0];
    type Statement = { Effect: string; Action: string | string[]; Resource: unknown; Condition?: unknown };
    const statements = Object.values(template.findResources("AWS::IAM::Policy"))
      .filter((policy) => (policy.Properties as { Roles: Array<{ Ref: string }> }).Roles.some((r) => r.Ref === role))
      .flatMap((policy) => (policy.Properties as { PolicyDocument: { Statement: Statement[] } }).PolicyDocument.Statement);
    const transactions: TransactWriteCommandInput[] = [];
    const db = { send: async (command: TransactWriteCommand) => {
      expect(command).toBeInstanceOf(TransactWriteCommand);
      transactions.push(command.input);
      return {};
    } };
    const store = new DynamoCompanyStore(db as never, companies);
    const companyId = `org_${"a".repeat(20)}`;
    const id = kind === "project_month" ? "example" : `dev_${"b".repeat(20)}`;
    const limit = { companyId, kind, id, monthlyUsdMicros: 10_000_000, updatedAt: "2026-11-18T12:00:00.000Z", updatedBy: "admin" };
    await store.putSpendLimit(limit, { override: undefined, settingsVersion: 0 });
    const basis = { override: { version: 1, monthlyUsdMicros: 10_000_000 }, settingsVersion: 2 };
    await store.putSpendLimit({ ...limit, monthlyUsdMicros: 5_000_000 }, basis);
    await store.removeSpendLimit(companyId, kind, id, basis);
    await recordCloudAction(new DynamoCloudAuditStore(db as never, state), {
      companyId, actor: { developerId: "admin", name: "Admin", type: "person" }, action: "company.budget.changed", via: "web", subject: `spend_limit:${kind}:${id}`,
    }, () => new Date(limit.updatedAt));
    expect(transactions).toHaveLength(4);
    const actions = { Put: "dynamodb:PutItem", Update: "dynamodb:UpdateItem", Delete: "dynamodb:DeleteItem", ConditionCheck: "dynamodb:ConditionCheckItem" } as const;
    for (const transaction of transactions) {
      expect(transaction.TransactItems).toHaveLength(2);
      for (const item of transaction.TransactItems!) {
        expect(Object.keys(item)).toHaveLength(1);
        const operation = Object.keys(item)[0] as keyof typeof actions;
        expect(actions[operation]).toBeDefined();
        const write = item[operation]!;
        expect([companies, state]).toContain(write.TableName);
        const key = "Item" in write ? write.Item : "Key" in write ? write.Key : undefined;
        expect(typeof key?.pk).toBe("string");
        const grants = statements.filter((statement) => statement.Effect === "Allow"
          && [statement.Action].flat().includes(actions[operation])
          && JSON.stringify(statement.Resource) === JSON.stringify({ "Fn::GetAtt": [write.TableName, "Arn"] }));
        const covered = grants.some((statement) => {
          if (write.TableName === companies) return statement.Condition === undefined;
          // State writes must also satisfy the same LeadingKeys and non-null conditions the role carries.
          const prefix = (key!.pk as string).split("#")[0];
          return JSON.stringify(statement.Condition) === JSON.stringify({ "ForAllValues:StringLike": { "dynamodb:LeadingKeys": `${prefix}#*` }, Null: { "dynamodb:LeadingKeys": "false" } });
        });
        expect(covered, `${operation} on ${write.TableName}/${key!.pk as string} needs ${actions[operation]}`).toBe(true);
      }
    }
  });

  it("lets the function read its address by name, so its role doesn't wait for the distribution that waits for it", () => {
    const policies = JSON.stringify(template.findResources("AWS::IAM::Policy"));
    expect(policies).toContain(":parameter/rovara-cloud/production/web/origin");
    expect(policies).not.toContain(idOf("AWS::SSM::Parameter"));
  });

  it("exports nothing of its own: the table's two exports kept for the move are gone (CloudFront's domain is exported only for the first address that imports it)", () => {
    const exports = Object.values(template.toJSON().Outputs as Record<string, { Export?: { Name: string } }>).flatMap((each) => (each.Export === undefined ? [] : [each.Export.Name]));
    expect(exports).toEqual([]);
  });

  it("prints how to register a new environment with Code, and where its secret is", () => {
    const outputs = template.toJSON().Outputs as Record<string, { Value: unknown; Export?: unknown }>;
    expect(Object.keys(outputs).filter((name) => outputs[name]!.Export === undefined).sort()).toEqual(["CallbackUrl", "ClientSecretName", "CloudUrl", "CompanyTableName", "RegisterWithCode", "TableName"]);
    const register = JSON.stringify(outputs.RegisterWithCode!.Value);
    expect(register).toContain(`admin sign-in-client add ${CLOUD_APP_CLIENT_ID} --name \\"Rovara Cloud\\" --audience ${CLOUD_APP_CLIENT_ID} --redirect `);
    expect(register).toContain("--confidential --full-access --scope projects:members,projects:create --secret-file rovara-cloud-secret.txt");
    expect(outputs.ClientSecretName!.Value).toBe("rovara-cloud/production/code-client-secret");
  });

  it("is named under rovara-cloud, refuses a name the environment rules refuse, and comes with the Fargate app under -c rovaraCloudApp", () => {
    expect(cloudWebStackName("production")).toBe("rovara-cloud-production-web");
    expect(() => synth("abcdefghijklmno")).toThrow(/at most 14 characters/);
    const app = buildAgentXApp({ rovaraCloudApp: "production", agentxRegion: "us-east-1" });
    const stacks = app.node.children.filter((each) => "stackName" in each) as Array<{ stackName: string }>;
    expect(stacks.map((each) => each.stackName).sort()).toEqual(["rovara-cloud-production-app", "rovara-cloud-production-web"]);
    // Cloud's first address redirects here (#11), so this one deploys first.
    const fargate = stacks.find((each) => each.stackName === "rovara-cloud-production-app") as unknown as { dependencies: Array<{ stackName: string }> };
    expect(fargate.dependencies.map((each) => each.stackName)).toEqual(["rovara-cloud-production-web"]);
  });
});
