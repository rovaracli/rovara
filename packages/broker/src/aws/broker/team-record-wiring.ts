// Part of the broker (split out of ../broker.ts): the Team record's call sites. Everything here is an optional chain on `dependencies.teamRecord`, which is `undefined` unless the install was deployed with the
// record's switch on (`TEAM_RECORD_ENABLED=1`, team-record/runtime.ts). With it off no function in this file reads, writes, schedules or even builds a client: the handler's branches answer "off" and return.
import { registerHumanSendBackListener, sendBackToRecord, } from "../../lessons/send-back-events.js";
import { TEAM_RECORD_SLACK_SOURCE, type SlackForwardEvent } from "../../team-record/slack-forward.js";
import { TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { auditPending, type AuditDeps } from "../../audit/outbox.js";
import { flushAuditEvents } from "../../audit/flush.js";
import type { RecordAuditSink } from "../../team-record/audit.js";
import type { TeamRecordJobSummary } from "../../team-record/runtime.js";
import type { AwsBrokerDependencies } from "./definitions.js";

/** The source the scheduler's team-record events carry (infra/lib/team-record-wiring.ts `TEAM_RECORD_JOB_SOURCE`). */
/** What the call sites need of the broker's dependencies: the runtime, or nothing (the record is off). */
export type HasTeamRecord = { teamRecord?: AwsBrokerDependencies["teamRecord"] | undefined };

export const TEAM_RECORD_JOB_SOURCE = "agentx.team-record";
const JOBS = new Set(["hourly", "nightly"]);

export function isTeamRecordJobEvent(event: unknown): event is { source: typeof TEAM_RECORD_JOB_SOURCE; job: "hourly" | "nightly" } {
  return event !== null && typeof event === "object" && !("requestContext" in event)
    && (event as { source?: unknown }).source === TEAM_RECORD_JOB_SOURCE && JOBS.has((event as { job?: unknown }).job as string);
}

/** A verified Slack event the ingress forwarded by a direct invoke (team-record/slack-forward.ts). Never an HTTP request (no `requestContext`). */
export function isTeamRecordSlackEvent(event: unknown): event is SlackForwardEvent {
  return event !== null && typeof event === "object" && !("requestContext" in event)
    && (event as { source?: unknown }).source === TEAM_RECORD_SLACK_SOURCE && typeof (event as { payload?: unknown }).payload === "object" && (event as { payload?: unknown }).payload !== null;
}

export type TeamRecordJobAnswer = { skipped: true; reason: "off" } | { skipped?: undefined; job: string; summary: TeamRecordJobSummary };

/** A scheduled job. Answers `skipped` and does nothing where the record is off. */
export async function runTeamRecordJob(dependencies: HasTeamRecord, event: { job: "hourly" | "nightly" }): Promise<TeamRecordJobAnswer> {
  if (dependencies.teamRecord === undefined) return { skipped: true, reason: "off" };
  return { job: event.job, summary: await dependencies.teamRecord.jobs.run(event.job) };
}

/** A forwarded Slack event. Answers `skipped` and does nothing where the record is off. The tap decides, from the source rows and the mode, whether anything is recorded. */
export async function recordSlackForward(dependencies: HasTeamRecord, event: SlackForwardEvent): Promise<{ skipped: true; reason: "off" } | { outcome: string }> {
  if (dependencies.teamRecord === undefined) return { skipped: true, reason: "off" };
  const outcome = await dependencies.teamRecord.taps.slack({ payload: event.payload, ...(event.channel === undefined ? {} : { channel: event.channel }) });
  return { outcome: outcome.outcome };
}

let removeSendBack: (() => void) | undefined;
let current: HasTeamRecord | undefined;

/**
 * At broker start (`broker/handler.ts`): a human send-back is written to the record as a `rovara.send_back` row naming the person who sent it. One listener per process, reading the latest broker's runtime; none
 * where the record is off. (The learning wiring registers its own listener where it has `learning` dependencies; both write the same row id and version, so a send-back is one row.)
 */
export function installTeamRecordEmitter(dependencies: HasTeamRecord): void {
  current = dependencies;
  if (dependencies.teamRecord === undefined) return;
  removeSendBack ??= registerHumanSendBackListener(async (event) => {
    const emitter = current?.teamRecord?.emitter;
    if (emitter !== undefined) await sendBackToRecord(emitter)(event);
  });
}

/** Whether the send-back listener is registered (it is only where the record is on). */
export const teamRecordEmitterInstalled = (): boolean => removeSendBack !== undefined;

/** Takes the listener off again (for the tests that install it; a deployed broker never does). */
export function uninstallTeamRecordEmitter(): void {
  removeSendBack?.();
  removeSendBack = undefined;
  current = undefined;
}

/**
 * The record's audit events (record.tombstoned, record.erased, lesson.withdrawn) through the broker's audit ledger: the pending item is written, then sent. A failure is the caller's to ignore
 * (`purge.ts` never lets a failed audit write block a delete: the delete is the privacy duty). Absent where the install has no ledger.
 */
export function recordAuditSinkOf(audit: AuditDeps["audit"], documentClient: { send(command: unknown): Promise<unknown> }): RecordAuditSink | undefined {
  if (audit === undefined) return undefined;
  return async (event) => {
    const items = auditPending({ audit }, event);
    if (items.length > 0) await documentClient.send(new TransactWriteCommand({ TransactItems: items }));
    await flushAuditEvents({ audit }, [event]);
  };
}
