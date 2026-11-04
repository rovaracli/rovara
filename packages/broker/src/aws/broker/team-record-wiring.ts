// Part of the broker (split out of ../broker.ts): the Team record's call sites. Everything here is an optional chain on `dependencies.teamRecord`, which is `undefined` unless the install was deployed with the
// record's switch on (`TEAM_RECORD_ENABLED=1`, team-record/runtime.ts). With it off no function in this file reads, writes, schedules or even builds a client: the handler's branches answer "off" and return.
import { teamRecordOpsQueueName } from "@agentx/contracts";
import { registerTaskEndHandler } from "../../agents/task-end.js";
import { recordListenerOf, recordTaskEndHandler, registerRovaraRecordListener } from "../../lessons/record-events.js";
import { registerHumanSendBackListener, sendBackToRecord, } from "../../lessons/send-back-events.js";
import { TEAM_RECORD_SLACK_SOURCE, type SlackForwardEvent } from "../../team-record/slack-forward.js";
import { TEAM_RECORD_REMOVAL_SOURCE, type RemovalFallback, type RemovalFallbackEvent } from "../../team-record/ops-queue.js";
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
  // The tap swallows its own errors into "failed". A failed record is THROWN so that Lambda runs the asynchronous invoke again (twice, one and two minutes later); a handler that returns is never retried.
  if (outcome.outcome === "ignored" && outcome.reason === "failed") throw Object.assign(new Error("team record slack event failed"), { name: "TeamRecordSlackFailed" });
  return { outcome: outcome.outcome };
}

let removeSendBack: (() => void) | undefined;
/** The other four events (a remembered note, a plan's outcome, a published review's outcome, the end of the task): one listener and the task-end handler (`lessons/record-events.ts`). */
let removeRovaraEvents: Array<() => void> = [];
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
  // The rest of Rovara's own events, the same way: late-bound to the latest runtime, registered once per process and only where the record is on.
  if (removeRovaraEvents.length === 0) {
    removeRovaraEvents = [
      registerRovaraRecordListener(async (event) => {
        const emitter = current?.teamRecord?.emitter;
        if (emitter !== undefined) await recordListenerOf(emitter)(event);
      }),
      registerTaskEndHandler(recordTaskEndHandler()),
    ];
  }
}

/** Whether the send-back listener is registered (it is only where the record is on). */
export const teamRecordEmitterInstalled = (): boolean => removeSendBack !== undefined;

/** Takes the listener off again (for the tests that install it; a deployed broker never does). */
export function uninstallTeamRecordEmitter(): void {
  removeSendBack?.();
  removeSendBack = undefined;
  for (const remove of removeRovaraEvents) remove();
  removeRovaraEvents = [];
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

/** A batch from the record's durable queue (`agentx-<env>-team-record-ops`): an SQS event whose every record comes from that queue. */
export interface QueueBatchEvent { Records: Array<{ eventSource: string; eventSourceARN: string; messageId: string; body: string; attributes?: { ApproximateReceiveCount?: string } }> }

export function isTeamRecordQueueEvent(event: unknown, environment: Record<string, string | undefined> = process.env): event is QueueBatchEvent {
  const name = environment.AGENTX_ENV;
  if (event === null || typeof event !== "object" || "requestContext" in event || name === undefined || name === "") return false;
  const records = (event as { Records?: unknown }).Records;
  return Array.isArray(records) && records.length > 0 && records.every((record: { eventSource?: unknown; eventSourceARN?: unknown }) => record?.eventSource === "aws:sqs" && typeof record.eventSourceARN === "string" && record.eventSourceARN.endsWith(`:${teamRecordOpsQueueName(name)}`));
}

/** Drains the batch. Where the record is off the whole batch is reported as failed, so no message is lost to a broker that cannot apply it. */
export async function drainTeamRecordQueue(dependencies: HasTeamRecord, event: QueueBatchEvent, context?: { getRemainingTimeInMillis?: () => number }): Promise<{ batchItemFailures: Array<{ itemIdentifier: string }> }> {
  if (dependencies.teamRecord === undefined) return { batchItemFailures: event.Records.map((record) => ({ itemIdentifier: record.messageId })) };
  // The drain stops with time to spare (TRW-5 S1): a batch the function times out in would raise every message's receive count with no code run.
  const remainingMs = context?.getRemainingTimeInMillis;
  return dependencies.teamRecord.drain(
    event.Records.map((record) => ({ messageId: record.messageId, body: record.body, receiveCount: Number(record.attributes?.ApproximateReceiveCount ?? "1") || 1 })),
    remainingMs === undefined ? {} : { remainingMs: () => remainingMs.call(context) },
  );
}

/** A delete the broker sent to itself because neither the table nor the durable queue took it (TRW-5 S2). Never an HTTP request. */
export function isTeamRecordRemovalEvent(event: unknown): event is RemovalFallbackEvent {
  return event !== null && typeof event === "object" && !("requestContext" in event) && (event as { source?: unknown }).source === TEAM_RECORD_REMOVAL_SOURCE
    && typeof (event as { workspaceId?: unknown }).workspaceId === "string" && typeof (event as { system?: unknown }).system === "string";
}

/** Applies it. THROWS when it could not (a handler that returns is never retried; Lambda retries a thrown asynchronous invoke twice, then the failure destination keeps it). Answers off where the record is off. */
export async function applyTeamRecordRemoval(dependencies: HasTeamRecord, event: RemovalFallbackEvent): Promise<{ skipped: true; reason: "off" } | { applied: true }> {
  if (dependencies.teamRecord === undefined) return { skipped: true, reason: "off" };
  await dependencies.teamRecord.removal(event);
  return { applied: true };
}

/** The broker's side of the fallback: sends the removal to this same function as an asynchronous Event (ids and fixed words only). `send` is the Lambda client's invoke. */
export function removalFallbackThroughLambda(send: (input: { InvocationType: "Event"; Payload: Uint8Array }) => Promise<{ StatusCode?: number | undefined }>): RemovalFallback {
  return async (event) => {
    const response = await send({ InvocationType: "Event", Payload: Buffer.from(JSON.stringify(event)) });
    if (response.StatusCode !== 202) throw new Error("the removal was not handed over");
  };
}

/** The Slack side of the Team record's links (TRW-4): a person's Slack user ids (for erase) and the person a Slack user id is (for the rule that a row is stored only for a linked author). Both read the sign-in store's Slack identity links. */
export function slackLinksOf(store: { slackUserIdsOf(developerId: string): Promise<string[]>; developerOfSlackUser(slackUserId: string): Promise<string | undefined> }): { slackUserIdsOf: (developerId: string) => Promise<string[]>; developerOfSlackUser: (slackUserId: string) => Promise<string | undefined> } {
  return { slackUserIdsOf: (developerId) => store.slackUserIdsOf(developerId), developerOfSlackUser: (slackUserId) => store.developerOfSlackUser(slackUserId) };
}
