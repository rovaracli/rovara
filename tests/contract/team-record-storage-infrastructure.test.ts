import { App, Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { actionsOf, policiesOf, statementJson } from "../support/team-record-cdk.js";
import { teamRecordParameters } from "../../infra/lib/team-record-edition.js";
import { TeamRecordStorage } from "../../infra/lib/team-record-storage.js";

const KMS = "arn:aws:kms:us-west-2:111122223333:key/11111111-2222-3333-4444-555555555555";

const ROLE = "arn:aws:iam::111122223333:role/analyst";

describe("team record install parameters", () => {
  it("defaults to a Public cell: Titan V2, 1024 dimensions, lake on, no key, no analysts", () => {
    expect(teamRecordParameters({})).toEqual({
      edition: "public", embeddingModelId: "amazon.titan-embed-text-v2:0", dimension: 1024, kmsKeyArn: undefined, lakeEnabled: true, athenaUsers: [], enterpriseWorkspaceId: undefined,
    });
  });
  it("Enterprise needs their key and their workspace; Public must not name a workspace or analysts", () => {
    expect(() => teamRecordParameters({ edition: "enterprise", enterpriseWorkspaceId: "acme" })).toThrow(/needs kmsKeyArn/);
    expect(() => teamRecordParameters({ edition: "enterprise", kmsKeyArn: KMS })).toThrow(/enterpriseWorkspaceId/);
    expect(() => teamRecordParameters({ edition: "public", enterpriseWorkspaceId: "acme" })).toThrow(/Enterprise only/);
    expect(() => teamRecordParameters({ edition: "public", athenaUsers: [ROLE] })).toThrow(/Enterprise only/);
    expect(teamRecordParameters({ edition: "enterprise", kmsKeyArn: KMS, enterpriseWorkspaceId: "acme", athenaUsers: `${ROLE}` }).athenaUsers).toEqual([ROLE]);
  });
  it("refuses an unsupported embedding model, a key alias, a non-role principal, and analysts without a lake", () => {
    expect(() => teamRecordParameters({ embeddingModelId: "anthropic.claude" })).toThrow(/not supported/);
    expect(teamRecordParameters({ embeddingModelId: "cohere.embed-english-v3" }).embeddingModelId).toBe("cohere.embed-english-v3");
    expect(() => teamRecordParameters({ kmsKeyArn: "arn:aws:kms:us-west-2:111122223333:alias/x" })).toThrow(/KMS key ARN/);
    const enterprise = { edition: "enterprise", kmsKeyArn: KMS, enterpriseWorkspaceId: "acme" };
    expect(() => teamRecordParameters({ ...enterprise, athenaUsers: ["arn:aws:iam::111122223333:user/bob"] })).toThrow(/role ARNs/);
    expect(() => teamRecordParameters({ ...enterprise, athenaUsers: [ROLE], lakeEnabled: false })).toThrow(/needs the lake/);
    expect(() => teamRecordParameters({ lakeEnabled: "maybe" })).toThrow(/true or false/);
  });
});

describe("team record storage per edition", () => {
  const build = (context: Record<string, unknown>, extra: Partial<ConstructorParameters<typeof TeamRecordStorage>[2]> = {}) => {
    const stack = new Stack(new App(), "T", { env: { account: "111122223333", region: "us-west-2" } });
    const storage = new TeamRecordStorage(stack, "S", { namePrefix: "rovara-test", context, ...extra });
    return { stack, storage, template: Template.fromStack(stack) };
  };
  const actions = (b: ReturnType<typeof build>) => actionsOf(b.storage.brokerStatements());

  it("Public: vector buckets without a pinned index, the lake, run-time index creation, and no analyst policy", () => {
    const b = build({});
    b.template.resourceCountIs("AWS::S3Vectors::VectorBucket", 1);
    b.template.resourceCountIs("AWS::S3Vectors::Index", 0);
    b.template.resourceCountIs("AWS::S3Tables::Table", 4);
    b.template.resourceCountIs("AWS::IAM::Policy", 0);
    expect(actions(b)).toContain("s3vectors:CreateIndex");
    expect(b.storage.environment).toMatchObject({ ROVARA_EDITION: "public", TEAM_RECORD_LAKE_ENABLED: "true", TEAM_RECORD_VECTOR_BUCKETS: "rovara-test-record-vectors" });
  });

  it("Enterprise: one bucket with its pinned index, their key everywhere, no run-time index creation, analysts get read-only SQL", () => {
    const b = build({ edition: "enterprise", kmsKeyArn: KMS, enterpriseWorkspaceId: "acme", athenaUsers: [ROLE] });
    b.template.resourceCountIs("AWS::S3Vectors::VectorBucket", 1);
    b.template.resourceCountIs("AWS::S3Vectors::Index", 1);
    expect(actions(b)).not.toContain("s3vectors:CreateIndex");
    const policies = policiesOf(b.template);
    expect(policies).toHaveLength(1);
    const analystActions = policies[0]!.Properties.PolicyDocument.Statement.flatMap((s) => [s.Action].flat());
    expect(analystActions).toContain("athena:StartQueryExecution");
    expect(analystActions).not.toContain("s3tables:PutTableData");
    expect(analystActions).not.toContain("s3tables:UpdateTableMetadataLocation");
    expect(analystActions.some((a) => a.startsWith("s3vectors:"))).toBe(false);
    expect(policies[0]!.Properties.Roles).toEqual(["analyst"]);
  });

  it("I-6: with a customer key the stack prints the key-policy statements for S3 Tables maintenance and S3 Vectors indexing; without one it prints nothing", () => {
    const withKey = build({ edition: "enterprise", kmsKeyArn: KMS, enterpriseWorkspaceId: "acme" });
    const outputs = withKey.template.toJSON().Outputs as Record<string, { Value: unknown }>;
    const value = JSON.stringify(outputs[Object.keys(outputs).find((name) => name.includes("KmsKeyPolicyStatements"))!]!.Value);
    expect(value).toContain("maintenance.s3tables.amazonaws.com");
    expect(value).toContain("indexing.s3vectors.amazonaws.com");
    expect(value).toContain("kms:GenerateDataKey");
    expect(value).toContain("aws:SourceAccount");
    expect(build({}).template.toJSON().Outputs).toBeUndefined();
  });

  it("M-14: analysts cannot stop the broker's queries", () => {
    const b = build({ edition: "enterprise", kmsKeyArn: KMS, enterpriseWorkspaceId: "acme", athenaUsers: [ROLE] });
    const analystActions = policiesOf(b.template)[0]!.Properties.PolicyDocument.Statement.flatMap((s) => [s.Action].flat());
    expect(analystActions).not.toContain("athena:StopQueryExecution");
  });

  it("lakeEnabled false leaves no tables, workgroup or Athena rights", () => {
    const b = build({ lakeEnabled: false });
    b.template.resourceCountIs("AWS::S3Tables::TableBucket", 0);
    b.template.resourceCountIs("AWS::Athena::WorkGroup", 0);
    expect(actions(b).some((a) => a.startsWith("athena:") || a.startsWith("s3tables:"))).toBe(false);
    expect(b.storage.environment.TEAM_RECORD_LAKE_ENABLED).toBe("false");
    expect(b.storage.environment.TEAM_RECORD_TABLE_BUCKET).toBeUndefined();
  });

  it("limits Bedrock to InvokeModel on the one embedding model; a region-prefixed model also gets its inference profile", () => {
    const plain = statementJson(build({}).storage.embeddingStatements()[0]!);
    expect(plain.Action).toBe("bedrock:InvokeModel");
    expect(JSON.stringify(plain.Resource)).toContain("foundation-model/amazon.titan-embed-text-v2:0");
    const prefixed = build({ embeddingModelId: "us.amazon.titan-embed-text-v2:0" }).storage;
    const resources = JSON.stringify(statementJson(prefixed.embeddingStatements()[0]!).Resource);
    expect(resources).toContain("inference-profile/us.amazon.titan-embed-text-v2:0");
    expect(resources).toContain("foundation-model/amazon.titan-embed-text-v2:0");
  });

  it("gives the broker no right to delete buckets, indexes, tables or workgroups", () => {
    const list = actions(build({ edition: "enterprise", kmsKeyArn: KMS, enterpriseWorkspaceId: "acme" }));
    expect(list.filter((a) => /Delete(Index|VectorBucket|Table|TableBucket|Namespace|WorkGroup)|Create(WorkGroup|Table)/.test(a))).toEqual([]);
  });

  it("refuses a bad name prefix and an out-of-range bucket count", () => {
    expect(() => build({}, { namePrefix: "Bad Prefix" })).toThrow(/namePrefix/);
    expect(() => build({}, { publicVectorBucketCount: 0 })).toThrow(/must be 1/);
    expect(() => build({}, { publicVectorBucketCount: 2 })).toThrow(/must be 1/);
  });
});
