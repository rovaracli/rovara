// packages/contracts/src/admin.ts
// Spec 025 phase 25d: the admin read routes' shapes (FR-038) and the records of the derived
// failure and usage indexes (A5). The wire schemas are not strict: a newer control plane may add
// fields, and an older CLI must still read the answer. zod 4 strips unknown keys from a plain
// object, so each top-level response schema is `.passthrough()` to keep them.
import { z } from "zod";
import { AdminHealthCheckSchema } from "@rovara-code/contracts";

/**
 * Issue 206: the suffix of every alarm a named environment can create (`agentx-<env>-<suffix>`). The
 * admin health probe asks CloudWatch for exactly these names, because a call that names its alarms
 * is authorized against each alarm's ARN while a prefix listing is authorized against *. The infra
 * refuses to synthesize a named environment with an alarm missing from this list, and
 * tests/contract/admin-health-infrastructure.test.ts checks the list against a named app's alarms.
 */
export const HEALTH_ALARM_SUFFIXES = [
  "AuditChainMismatch", "AuditIntakeBacklog", "AuditIntakeDeadLetters", "AuditLockDrift", "AuditObjectConflict", "AuditPendingStuck", "AuditRecordFailed", "AuditSealOverdue", "AuditShredFailed", "AuditTimestampFailed",
  "BedrockThrottling", "ChainScheduleDeadLetters", "ChainWriteApproverSelectorFailed", "CheckerFailures", "ClassifierThrottling", "ConnectorBroken", "ConnectorNotConnected", "CoreTierChecksErrors",
  "DeveloperNoticeDeadLetters", "DeveloperNoticeStreamFailures", "DispatchDeadLetters", "EmptyResponses",
  "EvalBatchTickErrors", "EvalBatchWatcherErrors", "EvalExecutionsFailed", "LessonsReflectDeadLetters", "LessonsWorkerErrors", "LessonsWorkerThrottles",
  "ReconcilerLostInstances", "ReconcilerQualifiedAmiReadFailures", "ReconcilerQuarantinedVolumes", "ReconcilerStuckProvisioning", "RecordingFailures",
  "RuntimeRequalifyAgeUnreadable", "RuntimeRequalifyMachineFailures", "RuntimeRequalifyStale", "RuntimeRequalifyStepErrors",
  "SessionDeleterFailures", "SessionProvisionerFailures", "SessionReaperErrors", "SessionReconcilerErrors",
  "SlackDeadLetters", "SlackDeliveryFailed", "SlackHandOffFailures", "SlowTurns", "StuckCancels", "StuckSetupChecks",
  "TeamRecordEraseSweepFailed", "TeamRecordKeywordIndexFailed", "TeamRecordKeywordIndexGateFailed", "TeamRecordKeywordIndexJobFailed", "TeamRecordKeywordIndexOverdue", "TeamRecordRedeliveryStateConflict", "TeamRecordRepoCheckNoTime", "TeamRecordRepoCheckRefused", "TeamRecordSweepProblem", "TeamRecordTombstoneFailed",
  "TestAlarm", "TurnErrors", "UnwaitedTaskFailures",
] as const;
/** The listed alarms an environment creates only on Amazon Bedrock (or, for RuntimeRequalify*, only with the automatic renewal on; or, for CoreTierChecks*, Lessons* and TeamRecord*, only with the Team record switch on), so their absence is expected. */
export const HEALTH_ALARM_CONDITIONAL_SUFFIXES = ["BedrockThrottling", "ClassifierThrottling", "CoreTierChecksErrors", "LessonsReflectDeadLetters", "LessonsWorkerErrors", "LessonsWorkerThrottles", "RuntimeRequalifyAgeUnreadable", "RuntimeRequalifyMachineFailures", "RuntimeRequalifyStale", "RuntimeRequalifyStepErrors",
  "TeamRecordEraseSweepFailed", "TeamRecordKeywordIndexFailed", "TeamRecordKeywordIndexGateFailed", "TeamRecordKeywordIndexJobFailed", "TeamRecordKeywordIndexOverdue", "TeamRecordRedeliveryStateConflict", "TeamRecordRepoCheckNoTime", "TeamRecordRepoCheckRefused", "TeamRecordSweepProblem", "TeamRecordTombstoneFailed"] as const satisfies ReadonlyArray<typeof HEALTH_ALARM_SUFFIXES[number]>;
/**
 * HEALTH-COND-1: the conditional alarms the Team record's switch creates (the core tier pass function's one, the lessons worker's three and the record's ten). With the switch ON they are required, so a missing one shows MISSING on Health; with it OFF they are
 * not expected. The other conditional alarms (Bedrock-only, the automatic renewal's) stay conditional either way.
 */
type TeamRecordAlarmSuffix = Extract<typeof HEALTH_ALARM_CONDITIONAL_SUFFIXES[number], `CoreTierChecks${string}` | `Lessons${string}` | `TeamRecord${string}`>;
export const HEALTH_ALARM_TEAM_RECORD_SUFFIXES: readonly TeamRecordAlarmSuffix[] = HEALTH_ALARM_CONDITIONAL_SUFFIXES.filter((suffix): suffix is TeamRecordAlarmSuffix => suffix.startsWith("CoreTierChecks") || suffix.startsWith("Lessons") || suffix.startsWith("TeamRecord"));
export const AdminHealthResponseSchema = z.object({
  version: z.object({ developerApi: z.string(), adminApi: z.string(), release: z.string().optional() }),
  alarms: z.array(z.object({ name: z.string(), state: z.string() })),
  alarmsCheck: AdminHealthCheckSchema,
  deadLetterQueues: z.array(z.object({ name: z.string(), depth: z.number().int().nonnegative().nullable() })),
  /** R18: the queues' own check; optional so an older control plane's answer still parses. */
  deadLetterQueuesCheck: AdminHealthCheckSchema.optional(),
  slack: AdminHealthCheckSchema,
  github: AdminHealthCheckSchema,
  /** SRL-6: erase second passes that failed and source deletes no durable path accepted, last 24 hours. Optional: absent where the team record is off, and from an older control plane's answer. */
  teamRecordCheck: AdminHealthCheckSchema.optional(),
  /** Slack direct messages about tasks that were not delivered (retried) or were too old to send; present only when there are some, or the read failed. */
  attentionDmCheck: AdminHealthCheckSchema.optional(),
  workerModes: z.array(z.object({
    mode: z.string(),
    configured: z.boolean(),
    latestDispatchFailure: z.object({ at: z.string(), operationId: z.string(), error: z.string() }).optional(),
  })),
  workspaces: z.record(z.string(), z.number().int().nonnegative()),
  workspacesTruncated: z.boolean(),
}).passthrough();
export type AdminHealthResponse = z.infer<typeof AdminHealthResponseSchema>;
