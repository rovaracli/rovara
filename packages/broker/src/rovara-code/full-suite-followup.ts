// Proof and test environment E7 (design proof-test-env, section 4.5 and owner question Q3): when test selection fell back to the full suite and the full suite cannot fit the round, the pull request is published
// as "full suite pending", a follow-up full run on that exact commit is queued, and its result updates the pull request and the merge card. This module is the follow-up's state, its bounds, the lines it adds to
// the pull request, and the rule the merge card applies. The run itself is the worker's CHECKS mode on the commit; starting it, and putting the line in the pull request body, are wiring in the hot file (H5).
//
// Rules:
//   - one follow-up per task and commit (the key says so, and queueing twice is the same follow-up); a new commit supersedes the older follow-up, whose result is then refused;
//   - a result is accepted only for the commit it names, from a follow-up still waiting for it, and only once;
//   - a day's follow-ups per project are capped, so a busy project cannot run the whole suite on every push without bound; over the cap the pull request says "not run" instead of "pending";
//   - one that has waited longer than the run could take reads as expired, never as passed;
//   - merge stays allowed while pending, on a MEDIUM card (Q3 option a), unless the company chose to block until it passes (option b); a failed follow-up is a HIGH card and merging needs the person to say so again.
import { GetCommand, PutCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { INDEX_EXPIRY_ATTRIBUTE, agentXError, projectPk, type DecisionRisk, type EvidenceSelectionSchema, type OrgId } from "@agentx/contracts";
import type { z } from "zod";
import { inertLine } from "./inert-text.js";

type Send = { send(command: unknown): Promise<unknown> };
type EvidenceSelection = z.infer<typeof EvidenceSelectionSchema>;

export interface FollowupDeps {
  documentClient: Send;
  tableName: string;
  now(): number;
  /**
   * Charges the follow-up to the project's budget (owner Q10; the broker binds it to `admitWork` with the project as payer, shown as "full-suite follow-up"). Throws the scope's own error when a budget has no room.
   * Nothing is queued without it.
   */
  admit(input: { orgId: OrgId; project: string; taskId: string; purpose: "full_suite_followup" }): Promise<void>;
}
const BUDGET_CODES: ReadonlySet<string> = new Set(["ORG_BUDGET_EXCEEDED", "BUDGET_EXCEEDED", "PROJECT_BUDGET_EXCEEDED", "AGENT_BUDGET_EXCEEDED", "AGENT_BUDGET_REQUIRED", "CHAIN_BUDGET_EXCEEDED", "CHAIN_BUDGET_REQUIRED", "TEST_ALLOWANCE_USED", "TRIAL_LOCKED", "MACHINE_TIME_EXCEEDED"]);

export const FOLLOWUP_DAILY_CAP = 20;
/** A follow-up that has not reported in this long is over: the full suite does not take longer than this. */
export const FOLLOWUP_MAX_RUN_MS = 4 * 3_600_000;
const TTL_MS = 30 * 24 * 3_600_000;

export const FOLLOWUP_STATES = ["queued", "running", "passed", "failed", "superseded"] as const;
export type FollowupState = (typeof FOLLOWUP_STATES)[number];
/** What a reader sees: the stored state, or `expired` for one that waited too long, or `not_queued` when the daily cap kept it from being queued. */
export type FollowupView = "queued" | "running" | "passed" | "failed" | "superseded" | "expired" | "not_queued";

export interface FollowupResult { passed: number; failed: number; total: number; flaky: number; finishedAt: string }
export interface Followup { state: FollowupView; candidateDigest: string; headSha: string; queuedAt: string; result?: FollowupResult }

type Item = Record<string, unknown>;
const DIGEST = /^[a-f0-9]{64}$/u;
const SHA = /^[a-f0-9]{40}$/u;
const TASK = /^[A-Za-z0-9_-]{1,100}$/u;
const keyOf = (orgId: OrgId, project: string, sk: string) => ({ pk: projectPk(orgId, project), sk });
const itemKey = (orgId: OrgId, project: string, taskId: string, digest: string) => keyOf(orgId, project, `FULLRUN#${taskId}#${digest.slice(0, 16)}`);
const latestKey = (orgId: OrgId, project: string, taskId: string) => keyOf(orgId, project, `FULLRUN_LATEST#${taskId}`);
const dayKey = (orgId: OrgId, project: string, ms: number) => keyOf(orgId, project, `FULLRUN_DAY#${new Date(ms).toISOString().slice(0, 10)}`);
const errorName = (error: unknown): string => (error instanceof Error ? error.name : "unknown");
const cancelled = (error: unknown): boolean => errorName(error) === "TransactionCanceledException" || errorName(error) === "ConditionalCheckFailedException";

function check(input: { taskId: string; candidateDigest: string; headSha?: string }): void {
  if (!TASK.test(input.taskId) || !DIGEST.test(input.candidateDigest) || (input.headSha !== undefined && !SHA.test(input.headSha))) throw agentXError("CONFIG_INVALID", "the follow-up names a task, a commit and a code digest");
}

/**
 * Whether a task's evidence calls for a follow-up: the selection fell back to the full suite (a fixed reason is recorded) AND a test check did not finish in the round. A selection that ran the full suite by choice, or
 * a round that finished, needs none.
 */
export function needsFullSuiteFollowup(input: { selection: Pick<EvidenceSelection, "method" | "fallbackReason"> | undefined; testChecks: ReadonlyArray<{ after: "passed" | "failed" | "timed_out" | "unknown" | "not_run" }> }): boolean {
  if (input.selection === undefined || input.selection.method !== "full" || input.selection.fallbackReason === undefined) return false;
  return input.testChecks.some((check) => check.after === "not_run" || check.after === "timed_out" || check.after === "unknown");
}

export type QueueOutcome = { queued: true; replayed: boolean } | { queued: false; reason: "daily_cap" | "budget" };

/** Queues the follow-up for a commit, idempotently. A newer commit takes the task's pointer, so an older follow-up's result is refused. Bounded by the project's daily cap. */
export async function queueFullSuiteFollowup(deps: FollowupDeps, input: { orgId: OrgId; project: string; taskId: string; candidateDigest: string; headSha: string }): Promise<QueueOutcome> {
  check(input);
  const now = deps.now();
  const key = itemKey(input.orgId, input.project, input.taskId, input.candidateDigest);
  const existing = (await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: key, ConsistentRead: true })) as { Item?: Item }).Item;
  if (existing !== undefined) {
    // Same task and commit: the same follow-up (also after it finished: it is not run twice).
    await deps.documentClient.send(new PutCommand({ TableName: deps.tableName, Item: { ...latestKey(input.orgId, input.project, input.taskId), entityType: "FULLRUN_LATEST", digest: input.candidateDigest, [INDEX_EXPIRY_ATTRIBUTE]: Math.floor((now + TTL_MS) / 1000) } }));
    return { queued: true, replayed: true };
  }
  try {
    await deps.admit({ orgId: input.orgId, project: input.project, taskId: input.taskId, purpose: "full_suite_followup" });
  } catch (error) {
    const code = (error as { code?: unknown } | undefined)?.code;
    if (typeof code === "string" && BUDGET_CODES.has(code)) return { queued: false, reason: "budget" };
    throw error;
  }
  try {
    await deps.documentClient.send(new TransactWriteCommand({
      TransactItems: [
        {
          Put: {
            TableName: deps.tableName,
            Item: { ...key, entityType: "FULLRUN", orgId: input.orgId, project: input.project, taskId: input.taskId, candidateDigest: input.candidateDigest, headSha: input.headSha, state: "queued", queuedAtMs: now, queuedAt: new Date(now).toISOString(), [INDEX_EXPIRY_ATTRIBUTE]: Math.floor((now + TTL_MS) / 1000) },
            ConditionExpression: "attribute_not_exists(pk)",
          },
        },
        {
          Update: {
            TableName: deps.tableName, Key: dayKey(input.orgId, input.project, now),
            UpdateExpression: "SET entityType = :type, #expires = :expires ADD #count :one",
            ConditionExpression: "attribute_not_exists(#count) OR #count < :cap",
            ExpressionAttributeNames: { "#count": "count", "#expires": INDEX_EXPIRY_ATTRIBUTE },
            ExpressionAttributeValues: { ":type": "FULLRUN_DAY", ":one": 1, ":cap": FOLLOWUP_DAILY_CAP, ":expires": Math.floor((now + 3 * 86_400_000) / 1000) },
          },
        },
        { Put: { TableName: deps.tableName, Item: { ...latestKey(input.orgId, input.project, input.taskId), entityType: "FULLRUN_LATEST", digest: input.candidateDigest, [INDEX_EXPIRY_ATTRIBUTE]: Math.floor((now + TTL_MS) / 1000) } } },
      ],
    }));
  } catch (error) {
    if (cancelled(error)) {
      const raced = (await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: key, ConsistentRead: true })) as { Item?: Item }).Item;
      return raced !== undefined ? { queued: true, replayed: true } : { queued: false, reason: "daily_cap" };
    }
    throw error;
  }
  return { queued: true, replayed: false };
}

async function transition(deps: FollowupDeps, input: { orgId: OrgId; project: string; taskId: string; candidateDigest: string }, from: readonly string[], set: Record<string, unknown>): Promise<boolean> {
  check(input);
  const latest = (await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: latestKey(input.orgId, input.project, input.taskId), ConsistentRead: true })) as { Item?: Item }).Item;
  // A newer commit has taken the pointer: this follow-up is superseded and its result is not wanted.
  if (latest?.digest !== input.candidateDigest) return false;
  const names = Object.keys(set);
  try {
    await deps.documentClient.send(new UpdateCommand({
      TableName: deps.tableName, Key: itemKey(input.orgId, input.project, input.taskId, input.candidateDigest),
      UpdateExpression: `SET ${names.map((name, index) => `#n${String(index)} = :v${String(index)}`).join(", ")}`,
      ConditionExpression: `attribute_exists(pk) AND candidateDigest = :digest AND (${from.map((_, index) => `#state = :from${String(index)}`).join(" OR ")})`,
      ExpressionAttributeNames: { "#state": "state", ...Object.fromEntries(names.map((name, index) => [`#n${String(index)}`, name])) },
      ExpressionAttributeValues: { ":digest": input.candidateDigest, ...Object.fromEntries(from.map((state, index) => [`:from${String(index)}`, state])), ...Object.fromEntries(names.map((name, index) => [`:v${String(index)}`, set[name]])) },
    }));
    return true;
  } catch (error) {
    if (errorName(error) === "ConditionalCheckFailedException") return false;
    throw error;
  }
}

/** The worker took the run. False when it is not waiting for one (done, superseded, unknown). */
export const markFollowupRunning = (deps: FollowupDeps, input: { orgId: OrgId; project: string; taskId: string; candidateDigest: string }): Promise<boolean> =>
  transition(deps, input, ["queued"], { state: "running", startedAtMs: deps.now() });

/** Records the full run's result. Accepted once, for the commit the follow-up is for, while it still waits. */
export async function recordFollowupResult(deps: FollowupDeps, input: { orgId: OrgId; project: string; taskId: string; candidateDigest: string; result: FollowupResult }): Promise<boolean> {
  const { passed, failed, total, flaky } = input.result;
  const counts = [passed, failed, total, flaky];
  if (counts.some((count) => !Number.isSafeInteger(count) || count < 0) || total !== passed + failed || total === 0 || flaky > total || !Number.isFinite(Date.parse(input.result.finishedAt))) throw agentXError("CONFIG_INVALID", "the full run's counts do not add up");
  return transition(deps, input, ["queued", "running"], { state: failed === 0 ? "passed" : "failed", result: input.result, finishedAtMs: deps.now() });
}

/** What a reader sees for a commit: the stored state; `expired` when it waited past the longest a run can take; undefined when there is none. A damaged item reads as undefined too (never as passed). */
export async function readFollowup(deps: FollowupDeps, input: { orgId: OrgId; project: string; taskId: string; candidateDigest: string }): Promise<Followup | undefined> {
  check(input);
  const item = (await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: itemKey(input.orgId, input.project, input.taskId, input.candidateDigest), ConsistentRead: true })) as { Item?: Item }).Item;
  if (item === undefined || item.candidateDigest !== input.candidateDigest || typeof item.headSha !== "string" || typeof item.queuedAt !== "string" || typeof item.queuedAtMs !== "number") return undefined;
  const latest = (await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: latestKey(input.orgId, input.project, input.taskId), ConsistentRead: true })) as { Item?: Item }).Item;
  let state = (FOLLOWUP_STATES as readonly string[]).includes(String(item.state)) ? (item.state as FollowupState) : undefined;
  if (state === undefined) return undefined;
  if (latest !== undefined && latest.digest !== input.candidateDigest && (state === "queued" || state === "running")) state = "superseded";
  let view: FollowupView = state;
  if ((state === "queued" || state === "running") && deps.now() - (typeof item.startedAtMs === "number" ? item.startedAtMs : item.queuedAtMs) > FOLLOWUP_MAX_RUN_MS) view = "expired";
  const result = item.result as FollowupResult | undefined;
  return { state: view, candidateDigest: input.candidateDigest, headSha: item.headSha, queuedAt: item.queuedAt, ...(result !== undefined && (state === "passed" || state === "failed") ? { result } : {}) };
}

// ---- the pull request and the merge card

/** The pull request's line for the follow-up, counts and fixed words only. Undefined when there is nothing to say (no follow-up was needed). */
export function followupLine(followup: Followup | undefined, queued: QueueOutcome | undefined): string | undefined {
  if (followup === undefined) {
    if (queued?.queued !== false) return undefined;
    return queued.reason === "budget" ? "Full suite: not run on this commit (the project's AI and compute budget has no room for it)." : "Full suite: not run on this commit (the project's daily limit of full runs was reached).";
  }
  const number = (count: number) => count.toLocaleString("en-US");
  switch (followup.state) {
    case "queued": return "Full suite: pending. A full run on this commit is queued, and this section updates when it finishes.";
    case "running": return "Full suite: pending. A full run on this commit is running, and this section updates when it finishes.";
    case "passed": return `Full suite: passed on this commit (${number(followup.result?.passed ?? 0)} of ${number(followup.result?.total ?? 0)}${(followup.result?.flaky ?? 0) > 0 ? `; ${number(followup.result?.flaky ?? 0)} known flaky` : ""}).`;
    case "failed": return `Full suite: failed on this commit (${number(followup.result?.failed ?? 0)} of ${number(followup.result?.total ?? 0)} failing). See the task page for which.`;
    case "expired": return "Full suite: the follow-up run did not report. It was not run to the end on this commit.";
    case "superseded": return "Full suite: replaced by a run on a newer commit.";
    case "not_queued": return "Full suite: not run on this commit.";
  }
}

/** The line, cut to the proof section's line size and made inert (it holds only counts and fixed words, but a line is a line). */
export const followupLineInert = (line: string | undefined): string | undefined => (line === undefined ? undefined : inertLine(line, 300));

export type FullSuiteMergePolicy = "allow_pending" | "block_until_passed";
export interface FullSuiteMergeGate { allowed: boolean; risk: DecisionRisk; reason: "none_needed" | "pending" | "failed" | "not_run" | "passed" }

/**
 * What the follow-up does to the merge card (Q3). Pending: merge is allowed on a MEDIUM card, or blocked when the company chose `block_until_passed`. Failed: a HIGH card, and merge is not allowed from the card
 * (the person must act on the failure first). Expired, superseded and not-queued mean the full suite was not run on this commit: medium, or blocked under the stricter policy. Passed and none-needed add nothing.
 * `baseRisk` is never lowered.
 */
export function fullSuiteMergeGate(input: { policy: FullSuiteMergePolicy; followup: Followup | undefined; needed: boolean; baseRisk: DecisionRisk }): FullSuiteMergeGate {
  const order: DecisionRisk[] = ["low", "medium", "high"];
  const atLeast = (risk: DecisionRisk): DecisionRisk => (order.indexOf(risk) > order.indexOf(input.baseRisk) ? risk : input.baseRisk);
  if (!input.needed) return { allowed: true, risk: input.baseRisk, reason: "none_needed" };
  const state = input.followup?.state;
  if (state === "passed") return { allowed: true, risk: input.baseRisk, reason: "passed" };
  if (state === "failed") return { allowed: false, risk: atLeast("high"), reason: "failed" };
  const waiting = state === "queued" || state === "running";
  return { allowed: input.policy === "allow_pending", risk: atLeast("medium"), reason: waiting ? "pending" : "not_run" };
}
