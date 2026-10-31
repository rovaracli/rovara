// Typed readers for the CDK template and policy JSON that the Team-record infrastructure tests look at.
import type { aws_iam as iam } from "aws-cdk-lib";
import type { Template } from "aws-cdk-lib/assertions";

export interface StatementJson {
  Sid?: string;
  Action: string | string[];
  Resource: unknown;
}

export const statementJson = (statement: iam.PolicyStatement): StatementJson => statement.toStatementJson() as StatementJson;
export const actionsOf = (statements: readonly iam.PolicyStatement[]): string[] => statements.flatMap((statement) => [statementJson(statement).Action].flat());

export interface TableResource {
  DeletionPolicy?: string;
  Properties: {
    TableName: string;
    OpenTableFormat: string;
    IcebergMetadata: { IcebergSchema: { SchemaFieldList: Array<{ Name: string }> }; IcebergPartitionSpec: { Fields: unknown[] } };
    SnapshotManagement: unknown;
    Compaction: { Status: string };
  };
}

export const tablesOf = (template: Template): TableResource[] => Object.values(template.findResources("AWS::S3Tables::Table")) as unknown as TableResource[];

export interface PolicyResource {
  Properties: { PolicyDocument: { Statement: StatementJson[] }; Roles: string[] };
}

export const policiesOf = (template: Template): PolicyResource[] => Object.values(template.findResources("AWS::IAM::Policy")) as unknown as PolicyResource[];
