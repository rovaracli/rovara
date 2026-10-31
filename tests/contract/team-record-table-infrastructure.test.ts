import { App, Stack } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { TeamRecordTable } from "../../infra/lib/team-record-table.js";

const KMS = "arn:aws:kms:us-west-2:111122223333:key/11111111-2222-3333-4444-555555555555";
function build(props?: ConstructorParameters<typeof TeamRecordTable>[2]): { template: Template; construct: TeamRecordTable } {
  const stack = new Stack(new App(), "T", { env: { account: "111122223333", region: "us-west-2" } });
  const construct = new TeamRecordTable(stack, "Record", props);
  return { template: Template.fromStack(stack), construct };
}

describe("TeamRecord table", () => {
  it("is on-demand with PITR, TTL on indexExpiresAt, deletion protection and retained", () => {
    const { template } = build({ tableName: "rovara-staging-team-record" });
    template.resourceCountIs("AWS::DynamoDB::Table", 1);
    template.hasResourceProperties("AWS::DynamoDB::Table", {
      TableName: "rovara-staging-team-record",
      BillingMode: "PAY_PER_REQUEST",
      KeySchema: [{ AttributeName: "pk", KeyType: "HASH" }, { AttributeName: "sk", KeyType: "RANGE" }],
      PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
      TimeToLiveSpecification: { AttributeName: "indexExpiresAt", Enabled: true },
      DeletionProtectionEnabled: true,
      SSESpecification: { SSEEnabled: true },
    });
    for (const resource of Object.values(template.findResources("AWS::DynamoDB::Table"))) {
      expect(resource.DeletionPolicy).toBe("Retain");
      expect(resource.UpdateReplacePolicy).toBe("Retain");
    }
  });

  it("has the five indexes, each keyed by one attribute and projecting everything", () => {
    const { template } = build();
    template.hasResourceProperties("AWS::DynamoDB::Table", {
      GlobalSecondaryIndexes: Match.arrayWith([
        Match.objectLike({ IndexName: "gsi1", KeySchema: [{ AttributeName: "gsi1pk", KeyType: "HASH" }], Projection: { ProjectionType: "ALL" } }),
        Match.objectLike({ IndexName: "gsi2", KeySchema: [{ AttributeName: "gsi2pk", KeyType: "HASH" }], Projection: { ProjectionType: "ALL" } }),
        Match.objectLike({ IndexName: "gsi3", KeySchema: [{ AttributeName: "gsi3pk", KeyType: "HASH" }, { AttributeName: "gsi3sk", KeyType: "RANGE" }], Projection: { ProjectionType: "ALL" } }),
        Match.objectLike({ IndexName: "gsi4", KeySchema: [{ AttributeName: "gsi4pk", KeyType: "HASH" }], Projection: { ProjectionType: "ALL" } }),
        Match.objectLike({ IndexName: "gsi5", KeySchema: [{ AttributeName: "gsi5pk", KeyType: "HASH" }, { AttributeName: "textDueAt", KeyType: "RANGE" }], Projection: { ProjectionType: "ALL" } }),
      ]),
    });
    const table = Object.values(template.findResources("AWS::DynamoDB::Table"))[0] as { Properties: { GlobalSecondaryIndexes: unknown[] } };
    expect(table.Properties.GlobalSecondaryIndexes).toHaveLength(5);
  });

  it("uses the customer's KMS key when given one, and an AWS-managed key otherwise", () => {
    build({ kmsKeyArn: KMS }).template.hasResourceProperties("AWS::DynamoDB::Table", { SSESpecification: { SSEEnabled: true, SSEType: "KMS", KMSMasterKeyId: KMS } });
    const managed = Object.values(build().template.findResources("AWS::DynamoDB::Table"))[0] as { Properties: { SSESpecification: unknown } };
    expect(managed.Properties.SSESpecification).toEqual({ SSEEnabled: true });
  });

  it("refuses a bad name or key", () => {
    expect(() => build({ tableName: "x" })).toThrow(/not a valid table name/);
    expect(() => build({ kmsKeyArn: "arn:aws:s3:::bucket" })).toThrow(/KMS key ARN/);
  });

  it("gives the broker item actions on the table and its indexes, and no scan", () => {
    const { construct } = build();
    const [statement] = construct.brokerStatements();
    const json = JSON.stringify(statement!.toStatementJson());
    expect(json).toContain("dynamodb:Query");
    expect(json).toContain("dynamodb:PutItem");
    expect(json).not.toContain("dynamodb:Scan");
    expect(json).not.toContain("dynamodb:DeleteTable");
    expect(json).toContain("/index/*");
  });
});
