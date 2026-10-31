import { App, Stack, aws_iam as iam } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { teamRecordVectorIndexName } from "@agentx/contracts";
import { actionsOf, policiesOf, statementJson } from "../support/team-record-cdk.js";
import { TeamRecordVectors } from "../../infra/lib/team-record-vectors.js";

const KMS = "arn:aws:kms:us-west-2:111122223333:key/11111111-2222-3333-4444-555555555555";

function stackWith(build: (stack: Stack) => void): Template {
  const stack = new Stack(new App(), "T", { env: { account: "111122223333", region: "us-west-2" } });
  build(stack);
  return Template.fromStack(stack);
}

describe("team record vector buckets", () => {
  it("creates a retained vector bucket, KMS-encrypted when a key is given", () => {
    const template = stackWith((stack) => new TeamRecordVectors(stack, "V", { bucketNames: ["rovara-record-vectors-a"], kmsKeyArn: KMS }));
    template.resourceCountIs("AWS::S3Vectors::VectorBucket", 1);
    template.hasResourceProperties("AWS::S3Vectors::VectorBucket", {
      VectorBucketName: "rovara-record-vectors-a",
      EncryptionConfiguration: { SseType: "aws:kms", KmsKeyArn: KMS },
    });
    for (const resource of Object.values(template.findResources("AWS::S3Vectors::VectorBucket"))) expect(resource.DeletionPolicy).toBe("Retain");
    // Public cells make the per-workspace indexes at run time.
    template.resourceCountIs("AWS::S3Vectors::Index", 0);
  });

  it("uses S3-managed keys without a customer key", () => {
    const template = stackWith((stack) => new TeamRecordVectors(stack, "V", { bucketNames: ["rovara-record-vectors"] }));
    template.hasResourceProperties("AWS::S3Vectors::VectorBucket", { EncryptionConfiguration: { SseType: "AES256" } });
  });

  it("Enterprise pins its one workspace index: cosine, 1024 float32, ref the only non-filterable key", () => {
    const template = stackWith((stack) => new TeamRecordVectors(stack, "V", { bucketNames: ["rovara-record-vectors"], enterpriseWorkspaceId: "acme", kmsKeyArn: KMS }));
    template.hasResourceProperties("AWS::S3Vectors::Index", {
      IndexName: teamRecordVectorIndexName("acme"),
      DataType: "float32",
      Dimension: 1024,
      DistanceMetric: "cosine",
      MetadataConfiguration: { NonFilterableMetadataKeys: ["ref"] },
      EncryptionConfiguration: { SseType: "aws:kms", KmsKeyArn: KMS },
    });
  });

  it("refuses bad names, duplicates, and several buckets for an Enterprise install", () => {
    const build = (props: ConstructorParameters<typeof TeamRecordVectors>[2]) => () => stackWith((stack) => new TeamRecordVectors(stack, "V", props));
    expect(build({ bucketNames: [] })).toThrow(/at least one/);
    expect(build({ bucketNames: ["Bad_Name"] })).toThrow(/not a valid/);
    expect(build({ bucketNames: ["aaa-bucket", "bbb-bucket"] })).toThrow(/exactly one vector bucket/);
    expect(build({ bucketNames: ["aaa-bucket", "bbb-bucket"], enterpriseWorkspaceId: "acme" })).toThrow(/exactly one vector bucket/);
  });

  it("I-8: with a broker principal the data rights sit on a role the broker assumes, and the broker role itself gets only AssumeRole", () => {
    const stack = new Stack(new App(), "T", { env: { account: "111122223333", region: "us-west-2" } });
    const vectors = new TeamRecordVectors(stack, "V", { bucketNames: ["rovara-record-vectors"], brokerPrincipal: new iam.AccountRootPrincipal() });
    expect(actionsOf(vectors.brokerStatements())).toEqual(["sts:AssumeRole"]);
    expect(actionsOf(vectors.brokerIndexCreationStatements())).toEqual([]);
    const template = Template.fromStack(stack);
    const policies = policiesOf(template);
    expect(policies).toHaveLength(1);
    const roleActions = policies[0]!.Properties.PolicyDocument.Statement.flatMap((s) => [s.Action].flat());
    expect(roleActions).toEqual(expect.arrayContaining(["s3vectors:QueryVectors", "s3vectors:CreateIndex"]));
    template.hasResourceProperties("AWS::IAM::Role", { MaxSessionDuration: 3600 });
  });

  it("grants the broker data actions on index ARNs only; index creation is a separate grant", () => {
    const stack = new Stack(new App(), "T", { env: { account: "111122223333", region: "us-west-2" } });
    const vectors = new TeamRecordVectors(stack, "V", { bucketNames: ["rovara-record-vectors"] });
    const data = actionsOf(vectors.brokerStatements());
    expect(data).toEqual(expect.arrayContaining(["s3vectors:QueryVectors", "s3vectors:GetVectors", "s3vectors:PutVectors", "s3vectors:DeleteVectors"]));
    expect(data).not.toContain("s3vectors:CreateIndex");
    expect(data).not.toContain("s3vectors:DeleteIndex");
    expect(actionsOf(vectors.brokerIndexCreationStatements())).toEqual(["s3vectors:CreateIndex"]);
    expect(JSON.stringify(stack.resolve(vectors.brokerStatements().map((s) => statementJson(s).Resource)))).toContain("/index/*");
  });
});
