// R4: the lake of the Team record (design learning-v2-team-record.md 4.9.1): an S3 Tables bucket with the `record` namespace and four
// Iceberg tables, plus an Athena workgroup with a bytes-scanned limit and a results bucket that expires after 7 days.
//
// Not created here (one-time, per account and region): the S3 Tables analytics integration that makes the bucket visible to Athena as
// the `s3tablescatalog/<bucket>` catalog, and any Lake Formation grants it needs. See report.md "Needs the test environment".
import { type CfnTag, Duration, RemovalPolicy, Stack, aws_iam as iam, aws_kms as kms, aws_s3 as s3 } from "aws-cdk-lib";
import { CfnWorkGroup } from "aws-cdk-lib/aws-athena";
import { CfnNamespace, CfnTable, CfnTableBucket } from "aws-cdk-lib/aws-s3tables";
import { Construct } from "constructs";
import { LAKE_NAMESPACE, LAKE_TABLES } from "@agentx/contracts";

const TABLE_BUCKET_NAME = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;
/**
 * Maintenance numbers, tuned so a lake delete is physically gone within the DPA promise of about 15 days (review I-5). The chain is:
 * DELETE writes position deletes (hourly job, up to 1 day) -> compaction rewrites the data file (allowance 7 days, [verify] the real lag and
 * that S3 Tables rewrites a file already at the target size) -> the old snapshot expires (48 hours) -> the unreferenced file is marked
 * (2 days) -> and deleted (3 days later). The S3 Tables defaults (120 h, 3 d, 10 d) add up to 18 days before compaction lag.
 * [verify] The lowest values S3 Tables accepts for these three settings.
 */
export const SNAPSHOT_MAX_AGE_HOURS = 48;
export const UNREFERENCED_DAYS = 2;
export const NONCURRENT_DAYS = 3;
export const DELETE_JOB_DAYS = 1;
export const COMPACTION_ALLOWANCE_DAYS = 7;
/**
 * Worst-case days from a source delete to the bytes being gone, with the allowance above. This is a DESIGN TARGET, not a measurement: the
 * 7-day compaction allowance is an assumption until the test environment shows the real lag (review N-5). The DPA quotes it as a target.
 */
export const PHYSICAL_DELETE_BOUND_DAYS = DELETE_JOB_DAYS + COMPACTION_ALLOWANCE_DAYS + SNAPSHOT_MAX_AGE_HOURS / 24 + UNREFERENCED_DAYS + NONCURRENT_DAYS;
export const ATHENA_RESULTS_EXPIRY_DAYS = 7;
/** Athena's lowest bytes-scanned limit is 10 MB. The default here is 2 GB per query: the stats templates scan megabytes. */
export const ATHENA_BYTES_CUTOFF_MIN = 10 * 1024 * 1024;
export const ATHENA_BYTES_CUTOFF_DEFAULT = 2 * 1024 * 1024 * 1024;

export interface TeamRecordLakeProps {
  readonly tableBucketName: string;
  readonly workGroupName: string;
  readonly kmsKeyArn?: string;
  readonly bytesScannedCutoffPerQuery?: number;
  readonly tags?: readonly CfnTag[];
}

export class TeamRecordLake extends Construct {
  readonly tableBucket: CfnTableBucket;
  readonly namespace: CfnNamespace;
  readonly tables: Record<string, CfnTable>;
  readonly workGroup: CfnWorkGroup;
  readonly resultsBucket: s3.Bucket;
  readonly tableBucketName: string;
  readonly workGroupName: string;
  private readonly kmsKeyArn: string | undefined;

  constructor(scope: Construct, id: string, props: TeamRecordLakeProps) {
    super(scope, id);
    if (!TABLE_BUCKET_NAME.test(props.tableBucketName)) throw new Error("team-record lake: the table bucket name is not valid");
    const cutoff = props.bytesScannedCutoffPerQuery ?? ATHENA_BYTES_CUTOFF_DEFAULT;
    if (!Number.isSafeInteger(cutoff) || cutoff < ATHENA_BYTES_CUTOFF_MIN) throw new Error("team-record lake: the bytes-scanned limit must be a whole number of at least 10 MB");
    this.tableBucketName = props.tableBucketName;
    this.workGroupName = props.workGroupName;
    this.kmsKeyArn = props.kmsKeyArn;
    const tags = props.tags === undefined ? undefined : [...props.tags];

    this.tableBucket = new CfnTableBucket(this, "TableBucket", {
      tableBucketName: props.tableBucketName,
      encryptionConfiguration: props.kmsKeyArn === undefined ? { sseAlgorithm: "AES256" } : { sseAlgorithm: "aws:kms", kmsKeyArn: props.kmsKeyArn },
      unreferencedFileRemoval: { status: "Enabled", unreferencedDays: UNREFERENCED_DAYS, noncurrentDays: NONCURRENT_DAYS },
      ...(tags === undefined ? {} : { tags }),
    });
    this.tableBucket.applyRemovalPolicy(RemovalPolicy.RETAIN);

    this.namespace = new CfnNamespace(this, "Namespace", { tableBucketArn: this.tableBucket.attrTableBucketArn, namespace: LAKE_NAMESPACE });
    this.namespace.applyRemovalPolicy(RemovalPolicy.RETAIN);

    this.tables = {};
    for (const table of LAKE_TABLES) {
      const idOf = (column: string): number => {
        const found = table.columns.find((candidate) => candidate.name === column);
        if (found === undefined) throw new Error(`team-record lake: ${table.name} has no column ${column}`);
        return found.id;
      };
      const resource = new CfnTable(this, `Table-${table.name}`, {
        tableBucketArn: this.tableBucket.attrTableBucketArn,
        namespace: LAKE_NAMESPACE,
        tableName: table.name,
        openTableFormat: "ICEBERG",
        icebergMetadata: {
          icebergSchema: { schemaFieldList: table.columns.map((column) => ({ id: column.id, name: column.name, type: column.type, required: column.required === true })) },
          // identity(workspace_id) keeps a workspace's rows together and makes the per-workspace delete cheap; month(...) bounds a scan in time.
          icebergPartitionSpec: {
            fields: [
              { sourceId: idOf("workspace_id"), transform: "identity", name: "workspace_id" },
              { sourceId: idOf(table.timeColumn), transform: "month", name: `${table.timeColumn}_month` },
            ],
          },
        },
        // Snapshot expiry and compaction are what physically remove deleted rows (design 4.4.3). Never turned off, no retention overrides.
        snapshotManagement: { status: "enabled", maxSnapshotAgeHours: SNAPSHOT_MAX_AGE_HOURS, minSnapshotsToKeep: 1 },
        compaction: { status: "enabled", targetFileSizeMb: 512 },
        ...(tags === undefined ? {} : { tags }),
      });
      resource.addDependency(this.namespace);
      resource.applyRemovalPolicy(RemovalPolicy.RETAIN);
      this.tables[table.name] = resource;
    }

    this.resultsBucket = new s3.Bucket(this, "AthenaResults", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      encryption: props.kmsKeyArn === undefined ? s3.BucketEncryption.S3_MANAGED : s3.BucketEncryption.KMS,
      ...(props.kmsKeyArn === undefined ? {} : { encryptionKey: kms.Key.fromKeyArn(this, "ResultsKey", props.kmsKeyArn) }),
      lifecycleRules: [{ expiration: Duration.days(ATHENA_RESULTS_EXPIRY_DAYS), abortIncompleteMultipartUploadAfter: Duration.days(1) }],
      removalPolicy: RemovalPolicy.RETAIN,
    });

    const resultsLocation = `s3://${this.resultsBucket.bucketName}/results/`;
    this.workGroup = new CfnWorkGroup(this, "WorkGroup", {
      name: props.workGroupName,
      description: "Rovara Team record lake: templated queries only",
      recursiveDeleteOption: false,
      workGroupConfiguration: {
        enforceWorkGroupConfiguration: true,
        publishCloudWatchMetricsEnabled: true,
        bytesScannedCutoffPerQuery: cutoff,
        engineVersion: { selectedEngineVersion: "Athena engine version 3" },
        resultConfiguration: {
          outputLocation: resultsLocation,
          encryptionConfiguration: props.kmsKeyArn === undefined ? { encryptionOption: "SSE_S3" } : { encryptionOption: "SSE_KMS", kmsKey: props.kmsKeyArn },
        },
      },
      ...(tags === undefined ? {} : { tags }),
    });
  }

  /** Athena catalog name of the table bucket once the account's S3 Tables integration is on. */
  get catalogName(): string {
    return `s3tablescatalog/${this.tableBucketName}`;
  }

  /** Read-only SQL for the customer's own admins (Enterprise): query the workgroup and read the tables, change nothing. */
  analystStatements(): iam.PolicyStatement[] {
    // Analysts cannot write tables, and cannot stop the broker's own queries (the hourly delete runs) either (review M-14).
    const writes = new Set(["s3tables:UpdateTableMetadataLocation", "s3tables:PutTableData", "athena:StopQueryExecution"]);
    return this.brokerStatements()
      .map((statement) => {
        const json = statement.toStatementJson() as { Sid: string; Action: string | string[] };
        const actions = [json.Action].flat().filter((action) => !writes.has(action));
        return new iam.PolicyStatement({ sid: json.Sid.replace("TeamRecord", "TeamRecordAnalyst"), actions, resources: statement.resources, effect: statement.effect });
      });
  }

  /**
   * What the broker role needs to run templated queries and write archive and delete statements through Athena.
   * [unverified] The Glue and S3 Tables action lists follow the AWS S3 Tables and Athena pages; confirm the least-privilege set in the test environment.
   */
  brokerStatements(): iam.PolicyStatement[] {
    const stack = Stack.of(this);
    const workGroupArn = stack.formatArn({ service: "athena", resource: "workgroup", resourceName: this.workGroupName });
    const catalogArn = stack.formatArn({ service: "glue", resource: "catalog" });
    const statements = [
      new iam.PolicyStatement({
        sid: "TeamRecordAthena",
        actions: ["athena:StartQueryExecution", "athena:GetQueryExecution", "athena:GetQueryResults", "athena:StopQueryExecution"],
        resources: [workGroupArn],
      }),
      new iam.PolicyStatement({
        sid: "TeamRecordLakeTables",
        actions: [
          "s3tables:GetTableBucket", "s3tables:GetNamespace", "s3tables:GetTable", "s3tables:GetTableMetadataLocation",
          "s3tables:UpdateTableMetadataLocation", "s3tables:GetTableData", "s3tables:PutTableData",
        ],
        resources: [this.tableBucket.attrTableBucketArn, `${this.tableBucket.attrTableBucketArn}/table/*`],
      }),
      new iam.PolicyStatement({
        sid: "TeamRecordGlueCatalog",
        actions: ["glue:GetCatalog", "glue:GetDatabase", "glue:GetDatabases", "glue:GetTable", "glue:GetTables"],
        // Fix round 1, S3: the record's own database (the `record` namespace of the table bucket's federated catalog) and its tables, not every database and table of the account.
        // [verify] the exact federated ARN form (`database/s3tablescatalog/<bucket>/<namespace>`, `table/s3tablescatalog/<bucket>/<namespace>/<table>`) in the test environment: run one templated query and one archive insert.
        resources: [
          catalogArn, `${catalogArn}/s3tablescatalog`, `${catalogArn}/s3tablescatalog/${this.tableBucketName}`,
          stack.formatArn({ service: "glue", resource: "database", resourceName: `s3tablescatalog/${this.tableBucketName}/${LAKE_NAMESPACE}` }),
          stack.formatArn({ service: "glue", resource: "table", resourceName: `s3tablescatalog/${this.tableBucketName}/${LAKE_NAMESPACE}/*` }),
        ],
      }),
      new iam.PolicyStatement({ sid: "TeamRecordLakeFormationData", actions: ["lakeformation:GetDataAccess"], resources: ["*"] }),
      new iam.PolicyStatement({
        sid: "TeamRecordAthenaResults",
        actions: ["s3:GetObject", "s3:PutObject", "s3:GetBucketLocation", "s3:ListBucket", "s3:AbortMultipartUpload"],
        resources: [this.resultsBucket.bucketArn, `${this.resultsBucket.bucketArn}/results/*`],
      }),
    ];
    if (this.kmsKeyArn !== undefined) {
      statements.push(new iam.PolicyStatement({ sid: "TeamRecordLakeKms", actions: ["kms:Decrypt", "kms:GenerateDataKey", "kms:DescribeKey"], resources: [this.kmsKeyArn] }));
    }
    return statements;
  }
}
