import { expect } from "vitest";

type Resource = { Type: string; Properties?: Record<string, unknown> };

/** Whether the template has the Audit Ledger, which a named control plane has and a legacy one does not. */
export const hasAuditLedger = (template: unknown): boolean => Object.keys((template as { Resources?: object }).Resources ?? {}).some((id) => id.startsWith("AuditLedger"));

/**
 * The Audit Ledger (Task 5 of its plan) adds, to a named control plane, one construct's resources (AuditLedger*) and
 * the appender's bare role (AuditAppenderRole*), and nothing else: no parameter, output, environment variable or
 * grant on an existing resource. The inventory is checked here to be exactly this, then taken out, so the rest of
 * the template must still match the recorded snapshot or digest. audit-ledger-infrastructure.test.ts checks the
 * resources themselves.
 */
export function withoutAuditLedger(template: unknown): unknown {
  const resources = (template as { Resources: Record<string, Resource> }).Resources;
  const ids = Object.keys(resources).filter((id) => id.startsWith("AuditLedger") || id.startsWith("AuditAppenderRole"));
  expect(ids.map((id) => `${resources[id]!.Type} ${id.replace(/[0-9A-F]{8}$/, "")}`).sort()).toStrictEqual([
    "AWS::DynamoDB::Table AuditLedgerAuditKeysTable",
    "AWS::DynamoDB::Table AuditLedgerAuditLedgerTable",
    "AWS::DynamoDB::Table AuditLedgerAuditSealsTable",
    "AWS::IAM::Role AuditAppenderRole",
    "AWS::KMS::Alias AuditLedgerAuditVaultKeyAlias",
    "AWS::KMS::Key AuditLedgerAuditVaultKey",
    "AWS::S3::Bucket AuditLedgerAuditExportsBucket",
    "AWS::S3::Bucket AuditLedgerAuditLedgerBucket",
    "AWS::S3::BucketPolicy AuditLedgerAuditExportsBucketPolicy",
    "AWS::S3::BucketPolicy AuditLedgerAuditLedgerBucketPolicy",
    "AWS::SQS::Queue AuditLedgerAuditIntakeDeadLetterQueue",
    "AWS::SQS::Queue AuditLedgerAuditIntakeQueue",
    "AWS::SQS::QueuePolicy AuditLedgerAuditIntakeDeadLetterQueuePolicy",
    "AWS::SQS::QueuePolicy AuditLedgerAuditIntakeQueuePolicy",
  ]);
  for (const id of ids) delete resources[id];
  return template;
}
