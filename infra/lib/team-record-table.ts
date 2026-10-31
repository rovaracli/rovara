// The hot table of the Team record (design 4.2, task R2): `TeamRecord`, one table per install (Enterprise: the customer's account) or per cell (Public).
// On-demand, point-in-time recovery, TTL on `indexExpiresAt`, encryption with the install's KMS key when it has one, retained when the stack goes, deletion protection.
// Why its own table and not the State table: the State table's TTL only works in named environments, and the deletion guarantees here are central.
// Four indexes: GSI1 by source item (a delete at the source), GSI2 by developer (erase), GSI3 by scope (a deleted channel, a membership change), GSI4 by source identity (erase a person with no developer id).
// The vector bucket and the lake are the storage lane's constructs (`team-record-storage.ts`); the stack that wires them also instantiates this one.
import { RemovalPolicy, aws_dynamodb as dynamodb, aws_iam as iam, aws_kms as kms } from "aws-cdk-lib";
import { Construct } from "constructs";
import { INDEX_EXPIRY_ATTRIBUTE, TEAM_RECORD_GSI1, TEAM_RECORD_GSI2, TEAM_RECORD_GSI3, TEAM_RECORD_GSI4 } from "@agentx/contracts";

const TABLE_NAME = /^[A-Za-z0-9_.-]{3,255}$/;

export interface TeamRecordTableProps {
  /** An explicit table name (for example `rovara-staging-team-record`). Without one CloudFormation names it. */
  readonly tableName?: string;
  /** The customer's key (Enterprise) or the cell's key (Public). Without it the table uses an AWS-managed key. */
  readonly kmsKeyArn?: string;
}

export class TeamRecordTable extends Construct {
  readonly table: dynamodb.Table;

  constructor(scope: Construct, id: string, props: TeamRecordTableProps = {}) {
    super(scope, id);
    if (props.tableName !== undefined && !TABLE_NAME.test(props.tableName)) throw new Error(`team-record table: ${props.tableName} is not a valid table name`);
    if (props.kmsKeyArn !== undefined && !/^arn:aws[a-z-]*:kms:[a-z0-9-]+:\d{12}:key\/[0-9a-f-]{36}$/.test(props.kmsKeyArn)) throw new Error("team-record table: kmsKeyArn is not a KMS key ARN");
    this.table = new dynamodb.Table(this, "Table", {
      ...(props.tableName === undefined ? {} : { tableName: props.tableName }),
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "sk", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      ...(props.kmsKeyArn === undefined
        ? { encryption: dynamodb.TableEncryption.AWS_MANAGED }
        : { encryption: dynamodb.TableEncryption.CUSTOMER_MANAGED, encryptionKey: kms.Key.fromKeyArn(this, "Key", props.kmsKeyArn) }),
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      timeToLiveAttribute: INDEX_EXPIRY_ATTRIBUTE,
      deletionProtection: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    for (const index of [TEAM_RECORD_GSI1, TEAM_RECORD_GSI2, TEAM_RECORD_GSI3, TEAM_RECORD_GSI4]) {
      this.table.addGlobalSecondaryIndex({ indexName: index.index, partitionKey: { name: index.partition, type: dynamodb.AttributeType.STRING }, projectionType: dynamodb.ProjectionType.ALL });
    }
  }

  /** What the broker's role needs: every item action the record code uses, on the table and its indexes. No scan, no table-level delete. */
  brokerStatements(): iam.PolicyStatement[] {
    return [
      new iam.PolicyStatement({
        sid: "TeamRecordTable",
        actions: ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem", "dynamodb:Query", "dynamodb:BatchGetItem", "dynamodb:BatchWriteItem", "dynamodb:ConditionCheckItem"],
        resources: [this.table.tableArn, `${this.table.tableArn}/index/*`],
      }),
    ];
  }
}
