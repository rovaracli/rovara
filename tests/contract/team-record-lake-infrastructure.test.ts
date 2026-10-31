import { App, Stack } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { LAKE_TABLES } from "@agentx/contracts";
import { actionsOf, statementJson, tablesOf } from "../support/team-record-cdk.js";
import { ATHENA_BYTES_CUTOFF_MIN, PHYSICAL_DELETE_BOUND_DAYS, TeamRecordLake } from "../../infra/lib/team-record-lake.js";

const KMS = "arn:aws:kms:us-west-2:111122223333:key/11111111-2222-3333-4444-555555555555";

function stackWith(build: (stack: Stack) => void): Template {
  const stack = new Stack(new App(), "T", { env: { account: "111122223333", region: "us-west-2" } });
  build(stack);
  return Template.fromStack(stack);
}

describe("team record lake", () => {
  const lake = (extra: Partial<ConstructorParameters<typeof TeamRecordLake>[2]> = {}) =>
    stackWith((stack) => new TeamRecordLake(stack, "L", { tableBucketName: "rovara-record-lake", workGroupName: "rovara-record", ...extra }));

  it("creates a retained table bucket, the record namespace and the four Iceberg tables with lowercase names", () => {
    const template = lake();
    template.hasResourceProperties("AWS::S3Tables::TableBucket", {
      TableBucketName: "rovara-record-lake",
      UnreferencedFileRemoval: { Status: "enabled", UnreferencedDays: 2, NoncurrentDays: 3 },
    });
    template.hasResourceProperties("AWS::S3Tables::Namespace", { Namespace: "record" });
    template.resourceCountIs("AWS::S3Tables::Table", 4);
    const tables = tablesOf(template);
    expect(tables.map((t) => t.Properties.TableName).sort()).toEqual(["events", "facts", "lessons_history", "outcomes"]);
    for (const table of tables) {
      expect(table.DeletionPolicy).toBe("Retain");
      expect(table.Properties.OpenTableFormat).toBe("ICEBERG");
      for (const field of table.Properties.IcebergMetadata.IcebergSchema.SchemaFieldList) expect(field.Name).toBe(field.Name.toLowerCase());
    }
  });

  it("partitions every table by identity(workspace_id) and month(time), on real column ids", () => {
    const template = lake();
    for (const spec of LAKE_TABLES) {
      const resource = tablesOf(template).find((table) => table.Properties.TableName === spec.name)!;
      const fields = resource.Properties.IcebergMetadata.IcebergPartitionSpec.Fields;
      const byName = (name: string) => spec.columns.find((c) => c.name === name)!;
      expect(fields).toEqual([
        { SourceId: byName("workspace_id").id, Transform: "identity", Name: "workspace_id" },
        { SourceId: byName(spec.timeColumn).id, Transform: "month", Name: `${spec.timeColumn}_month` },
      ]);
      expect(byName(spec.timeColumn).type).toBe("timestamp");
    }
  });

  it("keeps snapshot expiry and compaction on, and sets no override that would block physical deletes", () => {
    const template = lake();
    for (const resource of tablesOf(template)) {
      expect(resource.Properties.SnapshotManagement).toEqual({ Status: "enabled", MaxSnapshotAgeHours: 48, MinSnapshotsToKeep: 1 });
      expect(resource.Properties.Compaction.Status).toBe("enabled");
      // Only these top-level properties: no Iceberg table properties or tags that could pin old snapshots.
      expect(Object.keys(resource.Properties).sort()).toEqual(["Compaction", "IcebergMetadata", "Namespace", "OpenTableFormat", "SnapshotManagement", "TableBucketARN", "TableName"]);
    }
  });

  it("I-5: the settings add up to a physical delete within the 15 days the DPA promises, compaction lag included", () => {
    expect(PHYSICAL_DELETE_BOUND_DAYS).toBeLessThanOrEqual(15);
    const template = lake();
    const bucket = Object.values(template.findResources("AWS::S3Tables::TableBucket"))[0] as unknown as { Properties: { UnreferencedFileRemoval: { UnreferencedDays: number; NoncurrentDays: number } } };
    const table = tablesOf(template)[0]!.Properties.SnapshotManagement as { MaxSnapshotAgeHours: number };
    const days = 1 + 7 + table.MaxSnapshotAgeHours / 24 + bucket.Properties.UnreferencedFileRemoval.UnreferencedDays + bucket.Properties.UnreferencedFileRemoval.NoncurrentDays;
    expect(days).toBeLessThanOrEqual(15);
  });

  it("gives the Athena workgroup a bytes-scanned limit, enforced settings and an encrypted results bucket that expires in 7 days", () => {
    const template = lake();
    template.hasResourceProperties("AWS::Athena::WorkGroup", {
      Name: "rovara-record",
      WorkGroupConfiguration: Match.objectLike({
        EnforceWorkGroupConfiguration: true,
        BytesScannedCutoffPerQuery: 2 * 1024 * 1024 * 1024,
        EngineVersion: { SelectedEngineVersion: "Athena engine version 3" },
        ResultConfiguration: Match.objectLike({ EncryptionConfiguration: { EncryptionOption: "SSE_S3" } }),
      }),
    });
    template.hasResourceProperties("AWS::S3::Bucket", {
      LifecycleConfiguration: { Rules: [Match.objectLike({ ExpirationInDays: 7, Status: "Enabled" })] },
      PublicAccessBlockConfiguration: Match.objectLike({ BlockPublicAcls: true, RestrictPublicBuckets: true }),
    });
  });

  it("uses the customer's key for table bucket, workgroup results and results bucket", () => {
    const template = lake({ kmsKeyArn: KMS });
    template.hasResourceProperties("AWS::S3Tables::TableBucket", { EncryptionConfiguration: { SSEAlgorithm: "aws:kms", KMSKeyArn: KMS } });
    template.hasResourceProperties("AWS::Athena::WorkGroup", { WorkGroupConfiguration: Match.objectLike({ ResultConfiguration: Match.objectLike({ EncryptionConfiguration: { EncryptionOption: "SSE_KMS", KmsKey: KMS } }) }) });
    template.hasResourceProperties("AWS::S3::Bucket", { BucketEncryption: { ServerSideEncryptionConfiguration: [Match.objectLike({ ServerSideEncryptionByDefault: { SSEAlgorithm: "aws:kms", KMSMasterKeyID: KMS } })] } });
    template.resourceCountIs("AWS::KMS::Key", 0);
  });

  it("refuses a bytes-scanned limit under 10 MB and a bad bucket name", () => {
    expect(() => lake({ bytesScannedCutoffPerQuery: ATHENA_BYTES_CUTOFF_MIN - 1 })).toThrow(/at least 10 MB/);
    expect(() => lake({ tableBucketName: "Bad_Name" })).toThrow(/not valid/);
  });

  it("scopes the broker's Athena rights to the one workgroup and the lake rights to the one table bucket", () => {
    const stack = new Stack(new App(), "T", { env: { account: "111122223333", region: "us-west-2" } });
    const construct = new TeamRecordLake(stack, "L", { tableBucketName: "rovara-record-lake", workGroupName: "rovara-record" });
    const statements = construct.brokerStatements();
    const athena = statements.find((s) => s.sid === "TeamRecordAthena")!;
    expect(JSON.stringify(stack.resolve(statementJson(athena).Resource))).toContain("workgroup/rovara-record");
    expect(actionsOf([athena])).not.toContain("athena:CreateWorkGroup");
    const tables = statements.find((s) => s.sid === "TeamRecordLakeTables")!;
    expect(actionsOf([tables])).not.toContain("s3tables:DeleteTable");
    expect(actionsOf([tables])).not.toContain("s3tables:DeleteNamespace");
  });
});
