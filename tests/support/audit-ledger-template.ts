import { expect } from "vitest";

type Resource = { Type: string; Properties?: Record<string, unknown> };

/** Whether the template has the Audit Ledger, which a named control plane has and a legacy one does not. */
export const hasAuditLedger = (template: unknown): boolean => Object.keys((template as { Resources?: object }).Resources ?? {}).some((id) => id.startsWith("AuditLedger"));

/**
 * The Audit Ledger adds, to a named control plane, one construct's resources (AuditLedger*, the appender function among
 * them) and the appender's role with the policy CDK attaches to it (AuditAppenderRole*), and nothing else but the environment variables the broker is given and the sign-in
 * function's one (Task 18: the intake queue's URL) (Task 6: the intake queue's
 * URL; Task 11: the names it reads the ledger by; the grants are policies of their own, inside the construct) and, since Task 5b, the AuditLockProfile parameter
 * with its AuditLockIsTrial condition (nothing outside the ledger uses them). No other parameter, output or grant on an existing
 * resource. The inventory is checked here to be exactly this, then taken out, so the rest of the template must still
 * match the recorded snapshot or digest. audit-ledger-infrastructure.test.ts checks the resources themselves.
 */
export function withoutAuditLedger(template: unknown): unknown {
  const resources = (template as { Resources: Record<string, Resource> }).Resources;
  const ids = Object.keys(resources).filter((id) => id.startsWith("AuditLedger") || id.startsWith("AuditAppenderRole"));
  expect(ids.map((id) => `${resources[id]!.Type} ${id.replace(/[0-9A-F]{8}$/, "").replace(/(SqsEventSource).+$/, "$1")}`).sort()).toStrictEqual([
    "AWS::CloudWatch::Alarm AuditLedgerAuditChainMismatchAlarm",
    "AWS::CloudWatch::Alarm AuditLedgerAuditIntakeBacklogAlarm",
    "AWS::CloudWatch::Alarm AuditLedgerAuditIntakeDeadLettersAlarm",
    "AWS::CloudWatch::Alarm AuditLedgerAuditLockDriftAlarm",
    "AWS::CloudWatch::Alarm AuditLedgerAuditObjectConflictAlarm",
    "AWS::CloudWatch::Alarm AuditLedgerAuditPendingStuckAlarm",
    "AWS::CloudWatch::Alarm AuditLedgerAuditRecordFailedAlarm",
    "AWS::CloudWatch::Alarm AuditLedgerAuditSealOverdueAlarm",
    "AWS::CloudWatch::Alarm AuditLedgerAuditShredFailedAlarm",
    "AWS::CloudWatch::Alarm AuditLedgerAuditTimestampFailedAlarm",
    "AWS::DynamoDB::Table AuditLedgerAuditKeysTable",
    "AWS::DynamoDB::Table AuditLedgerAuditLedgerTable",
    "AWS::DynamoDB::Table AuditLedgerAuditSealsTable",
    "AWS::IAM::Policy AuditAppenderRoleDefaultPolicy",
    "AWS::IAM::Policy AuditLedgerAuditAnchorPolicy",
    "AWS::IAM::Policy AuditLedgerAuditAnchorRoleDefaultPolicy",
    "AWS::IAM::Policy AuditLedgerAuditAppenderPolicy",
    "AWS::IAM::Policy AuditLedgerAuditBrokerOutboxPolicy",
    "AWS::IAM::Policy AuditLedgerAuditBrokerReadPolicy",
    "AWS::IAM::Policy AuditLedgerAuditExportPolicy",
    "AWS::IAM::Policy AuditLedgerAuditExportRoleDefaultPolicy",
    "AWS::IAM::Policy AuditLedgerAuditSignInOutboxPolicy",
    "AWS::IAM::Role AuditAppenderRole",
    "AWS::IAM::Role AuditLedgerAuditAnchorRole",
    "AWS::IAM::Role AuditLedgerAuditDrainSchedulerRole",
    "AWS::IAM::Role AuditLedgerAuditEpochSchedulerRole",
    "AWS::IAM::Role AuditLedgerAuditExportRole",
    "AWS::KMS::Alias AuditLedgerAuditVaultKeyAlias",
    "AWS::KMS::Key AuditLedgerAuditVaultKey",
    "AWS::Lambda::EventInvokeConfig AuditLedgerAuditExportEventInvokeConfig",
    "AWS::Lambda::EventSourceMapping AuditLedgerAuditAppenderSqsEventSource",
    "AWS::Lambda::Function AuditLedgerAuditAnchor",
    "AWS::Lambda::Function AuditLedgerAuditAppender",
    "AWS::Lambda::Function AuditLedgerAuditExport",
    "AWS::Logs::LogGroup AuditLedgerAuditAnchorLogs",
    "AWS::Logs::LogGroup AuditLedgerAuditAppenderLogs",
    "AWS::Logs::LogGroup AuditLedgerAuditExportLogs",
    "AWS::Logs::MetricFilter AuditLedgerAuditChainMismatchMetric",
    "AWS::Logs::MetricFilter AuditLedgerAuditEpochSealedMetric",
    "AWS::Logs::MetricFilter AuditLedgerAuditLockDriftMetric",
    "AWS::Logs::MetricFilter AuditLedgerAuditObjectConflictMetric",
    "AWS::Logs::MetricFilter AuditLedgerAuditPendingStuckMetric",
    "AWS::Logs::MetricFilter AuditLedgerAuditRecordFailedMetric",
    "AWS::Logs::MetricFilter AuditLedgerAuditShredFailedMetric",
    "AWS::Logs::MetricFilter AuditLedgerAuditTimestampFailedMetric",
    "AWS::S3::Bucket AuditLedgerAuditExportsBucket",
    "AWS::S3::Bucket AuditLedgerAuditLedgerBucket",
    "AWS::S3::BucketPolicy AuditLedgerAuditExportsBucketPolicy",
    "AWS::S3::BucketPolicy AuditLedgerAuditLedgerBucketPolicy",
    "AWS::SQS::Queue AuditLedgerAuditIntakeDeadLetterQueue",
    "AWS::SQS::Queue AuditLedgerAuditIntakeQueue",
    "AWS::SQS::QueuePolicy AuditLedgerAuditIntakeDeadLetterQueuePolicy",
    "AWS::SQS::QueuePolicy AuditLedgerAuditIntakeQueuePolicy",
    "AWS::Scheduler::Schedule AuditLedgerAuditDrainSchedule",
    "AWS::Scheduler::Schedule AuditLedgerAuditEpochSchedule",
  ]);
  for (const id of ids) delete resources[id];
  // Task 5b: the lock profile parameter and the one condition on it; both are used only by the ledger resources removed above.
  const { Parameters: parameters, Conditions: conditions } = template as { Parameters?: Record<string, unknown>; Conditions?: Record<string, unknown> };
  expect(parameters?.AuditLockProfile).toBeDefined();
  expect(conditions?.AuditLockIsTrial).toBeDefined();
  delete parameters!.AuditLockProfile;
  delete conditions!.AuditLockIsTrial;
  expect(JSON.stringify(template)).not.toMatch(/AuditLockIsTrial|AuditLockProfile/);
  // Task 6 and Task 11: the changes to an existing resource, all on the broker: the intake queue URL, and the names the reader and
  // the export builder are given (the ledger, seals and keys tables, the two buckets and the vault key's ARN).
  const brokers = Object.entries(resources).filter(([id, resource]) => resource.Type === "AWS::Lambda::Function" && /^Broker[0-9A-F]{8}$/.test(id));
  expect(brokers).toHaveLength(1);
  const variables = (brokers[0]![1].Properties as { Environment: { Variables: Record<string, unknown> } }).Environment.Variables;
  const added = ["AUDIT_INTAKE_QUEUE_URL", "AUDIT_LEDGER_TABLE_NAME", "AUDIT_SEALS_TABLE_NAME", "AUDIT_KEYS_TABLE_NAME", "AUDIT_EXPORT_FUNCTION_NAME", "AUDIT_EXPORTS_BUCKET_NAME", "AUDIT_VAULT_KEY_ARN"];
  expect(Object.keys(variables).filter((name) => name.startsWith("AUDIT_")).sort()).toStrictEqual([...added].sort());
  for (const name of added) delete variables[name];
  // Task 18: the sign-in function is given the intake queue's URL too (its grants are the policy removed above), and no other variable.
  const signIns = Object.entries(resources).filter(([id, resource]) => resource.Type === "AWS::Lambda::Function" && /^DeveloperSignInFunction[0-9A-F]{8}$/.test(id));
  expect(signIns).toHaveLength(1);
  const signInVariables = (signIns[0]![1].Properties as { Environment: { Variables: Record<string, unknown> } }).Environment.Variables;
  expect(Object.keys(signInVariables).filter((name) => name.startsWith("AUDIT_"))).toStrictEqual(["AUDIT_INTAKE_QUEUE_URL"]);
  delete signInVariables.AUDIT_INTAKE_QUEUE_URL;
  return template;
}
