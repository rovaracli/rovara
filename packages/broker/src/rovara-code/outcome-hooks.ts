// Track record (v1.2, slice 1): where the broker records and scores a claim. Each claim is a sample in the outcome store (outcomes.ts); this file knows WHEN: after a plan decision commits, when a
// pull request is published, when a person asks for changes, when the pull request merges or closes, and when the task closes with samples still open.
//
// Every function here is best effort and never throws: a failed write is logged with a fixed code and counted on a metric (`OutcomeWriteFailed`), and the flow it records goes on. Only the broker
// calls them, from its own state (the workflow it saved, GitHub's own answer); nothing a worker or an agent sends reaches them.
//
// Finding a pending sample. A sample's key starts with its creation time, so the first write of a candidate's samples also writes one small pointer item under the task
// (`DEVTASK#<taskId>` / `OUTCOME_KEYS#<round>`, holding that creation time). A key is then rebuilt from the pointer, the claim and the round, and nothing a whole-workflow write does can lose it
// (the keys are not in the workflow, which other writers replace as a whole). The pointer is written once and kept; a retry reuses its creation time, so a retry is the same sample.
import { GetCommand, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import {
  INDEX_EXPIRY_ATTRIBUTE, OUTCOME_PENDING_KEPT_DAYS, ROVARA_CODE_AGENT_ID, outcomeSampleKey, outcomeStageOf,
  type OrgId, type OutcomeClaim, type OutcomeReason, type OutcomeSample, type OutcomeSampleKey, type OutcomeState, type WorkflowCritique, type WorkflowSnapshot,
} from "@agentx/contracts";
import { NOT_EXISTS, errorName } from "../agents/table-writes.js";
import type { TaskAgentRef } from "../agents/roster.js";
import type { TestProofRead } from "../developer/test-proof-lines.js";
import { readCi } from "./merge-tracking.js";
import { OUTCOME_WRITE_FAILED_METRIC, recordOutcomeSample, scoreOutcomeSample, type OutcomeDependencies } from "./outcomes.js";
import type { PullRequestStatus } from "../github-pull-status.js";

/** What the hooks need of a task. */
export interface OutcomeTask {
  taskId: string;
  orgId?: OrgId | undefined;
  project: string;
  agent?: { agentId?: string | undefined; version?: TaskAgentRef["version"] | undefined; digest?: string | undefined } | undefined;
}

const DAY_SECONDS = 24 * 60 * 60;
/** The claims about a candidate that wait for what happens to its pull request. */
const REVIEW_CLAIMS: readonly OutcomeClaim[] = ["review_pass:CRITIC", "review_pass:SECURITY"];
const PENDING_CLAIMS: readonly OutcomeClaim[] = [...REVIEW_CLAIMS, "proves_change", "risk_low"];

/** The round of a review, proof or risk sample: the candidate it is about. */
export const outcomeRoundOf = (candidateDigest: string): string => candidateDigest.slice(0, 16);

const pointerKey = (taskId: string, round: string) => ({ pk: `DEVTASK#${taskId}`, sk: `OUTCOME_KEYS#${round}` });
const POINTER_PREFIX = "OUTCOME_KEYS#";

/** The dependencies of the hooks from a table client, a logger and the broker's metric line (an embedded-format line CloudWatch turns into a count). */
export function outcomeDepsOf(table: { documentClient: { send(command: unknown): Promise<unknown> }; tableName: string }, log?: (event: string, fields: Record<string, unknown>) => void): OutcomeDependencies {
  return {
    ddb: table.documentClient, tableName: table.tableName,
    log: log ?? ((event, fields) => console.log(JSON.stringify({ component: "broker", level: "warn", event, ...fields }))),
    metric: (name, value = 1) => console.log(JSON.stringify({
      _aws: { Timestamp: Date.now(), CloudWatchMetrics: [{ Namespace: process.env.AGENTX_METRICS_NAMESPACE || "AgentX", Dimensions: [[]], Metrics: [{ Name: name, Unit: "Count" }] }] },
      component: "broker", event: "metric", [name]: value,
    })),
  };
}

function noteFailure(deps: OutcomeDependencies, what: string, error: unknown): void {
  try {
    deps.log?.(`outcomes.${what}_failed`, { error: errorName(error) ?? "unknown" });
    deps.metric?.(OUTCOME_WRITE_FAILED_METRIC, 1);
  } catch {
    // Logging and counting never fail the flow either.
  }
}

const agentOf = (task: OutcomeTask): OutcomeSample["agent"] => ({
  id: task.agent?.agentId ?? ROVARA_CODE_AGENT_ID, version: String(task.agent?.version ?? 0), digest: task.agent?.digest ?? "none",
});

// ---- the plan check

export type PlanDecision = "APPROVE" | "SKIP" | "REQUEST_CHANGES" | "REJECT";

/**
 * The plan check's claim "ready" for the plan revision a person has just decided, written after the decision committed (so a stale or failed decision writes nothing) and already scored: the
 * person's decision is the outcome. `critique` is the plan check as it was before the decision (a request for changes drops it from the workflow). The claim exists only when the check
 * finished and its last answer was "ok"; a check that stopped at a limit, never ran or asked for a revision makes none. `at` is the decision's own time, so a repeat writes the same item.
 */
export async function recordPlanOutcome(
  deps: OutcomeDependencies, task: OutcomeTask, input: { critique: WorkflowCritique | undefined; revision: number; decision: PlanDecision; at: string },
): Promise<void> {
  try {
    const last = input.critique?.status === "done" ? input.critique.critiques.at(-1) : undefined;
    if (last === undefined || last.verdict !== "ok" || task.orgId === undefined) return;
    const [state, reason]: [OutcomeState, OutcomeReason] = input.decision === "APPROVE" ? ["held", "plan_approved"]
      : input.decision === "SKIP" ? ["held", "plan_skipped"]
        : input.decision === "REQUEST_CHANGES" ? ["not_held", "plan_changes_requested"] : ["not_held", "plan_rejected"];
    await recordOutcomeSample(deps, {
      orgId: task.orgId, project: task.project, stage: "plan_critic", taskId: task.taskId, claim: "plan_ready", round: String(input.revision),
      state, reason, agent: agentOf(task), model: `${last.model.provider}/${last.model.modelId}`.slice(0, 300), createdAt: input.at, scoredAt: input.at,
    });
  } catch (error) {
    noteFailure(deps, "plan", error);
  }
}

// ---- publication

/** The creation time every sample of a candidate shares: kept in the candidate's pointer item, written once. */
async function creationTimeOf(deps: OutcomeDependencies, task: OutcomeTask, round: string, now: string): Promise<string> {
  const key = pointerKey(task.taskId, round);
  const read = async () => (await deps.ddb.send(new GetCommand({ TableName: deps.tableName, Key: key, ConsistentRead: true })) as { Item?: { createdAt?: unknown } }).Item?.createdAt;
  const stored = await read();
  if (typeof stored === "string") return stored;
  try {
    await deps.ddb.send(new PutCommand({
      TableName: deps.tableName,
      Item: { ...key, entityType: "OUTCOME_KEYS", taskId: task.taskId, round, createdAt: now, [INDEX_EXPIRY_ATTRIBUTE]: Math.floor(Date.parse(now) / 1000) + OUTCOME_PENDING_KEPT_DAYS * DAY_SECONDS },
      ConditionExpression: NOT_EXISTS,
    }));
    return now;
  } catch (error) {
    // Another call got there first: its time stands.
    const again = await read();
    if (typeof again === "string") return again;
    throw error;
  }
}

/**
 * The claims of a published candidate: pending `review_pass:<role>` for each passing review of that candidate, `proves_change` when the proof for it has a proving item, and `risk_low` when its risk is
 * low. A proof that could not be read (either way) is not a silent zero: it is its own sample, scored `no_outcome`. All of them are keyed by the candidate, so a repeat of the publication is the
 * same samples. Call it once the publication is accepted, never before.
 */
export async function recordPublicationOutcomes(
  deps: OutcomeDependencies, task: OutcomeTask, input: { workflow: WorkflowSnapshot; proof: TestProofRead; now: string },
): Promise<void> {
  try {
    const candidate = input.workflow.candidate?.digest;
    if (candidate === undefined || task.orgId === undefined) return;
    const round = outcomeRoundOf(candidate);
    const reviews = (input.workflow.reviews ?? []).filter((report) => report.status === "PASS" && report.candidateDigest === candidate);
    const risk = input.workflow.risk?.level === "low" && input.workflow.risk.candidateDigest === candidate;
    const proves = "verdicts" in input.proof && input.proof.verdicts.includes("proves_change");
    const unreadable = "unavailable" in input.proof;
    if (reviews.length === 0 && !risk && !proves && !unreadable) return;
    const createdAt = await creationTimeOf(deps, task, round, input.now);
    const base = { orgId: task.orgId, project: task.project, taskId: task.taskId, round, agent: agentOf(task), createdAt } as const;
    const modelOf = (report: (typeof reviews)[number]) => `${report.provider}/${report.version}`.slice(0, 300);
    for (const report of reviews) {
      await recordOutcomeSample(deps, { ...base, stage: "review", claim: `review_pass:${report.role}`, state: "pending", model: modelOf(report) });
    }
    const critic = reviews.find((report) => report.role === "CRITIC");
    if (risk) await recordOutcomeSample(deps, { ...base, stage: "risk", claim: "risk_low", state: "pending", model: critic === undefined ? "rovara" : modelOf(critic) });
    if (proves) await recordOutcomeSample(deps, { ...base, stage: "check", claim: "proves_change", state: "pending", model: "test-proof" });
    if (unreadable) {
      await recordOutcomeSample(deps, { ...base, stage: "check", claim: "proves_change", state: "no_outcome", reason: "proof_unavailable", model: "test-proof", scoredAt: createdAt });
    }
  } catch (error) {
    noteFailure(deps, "publication", error);
  }
}

// ---- scoring

/** The keys of a candidate's samples for the given claims (each may not exist: scoring a missing one does nothing). */
async function keysOf(deps: OutcomeDependencies, task: OutcomeTask, round: string, claims: readonly OutcomeClaim[]): Promise<Array<{ claim: OutcomeClaim; key: OutcomeSampleKey }>> {
  if (task.orgId === undefined) return [];
  const stored = (await deps.ddb.send(new GetCommand({ TableName: deps.tableName, Key: pointerKey(task.taskId, round), ConsistentRead: true })) as { Item?: { createdAt?: unknown } }).Item?.createdAt;
  if (typeof stored !== "string") return [];
  const orgId = task.orgId;
  return claims.map((claim) => ({ claim, key: outcomeSampleKey(orgId, task.project, outcomeStageOf(claim), stored, task.taskId, claim, round) }));
}

type Score = { state: Exclude<OutcomeState, "pending">; reason: OutcomeReason; unreviewedMerge?: true; pr?: OutcomeSample["pr"] };

async function scoreClaims(deps: OutcomeDependencies, task: OutcomeTask, round: string, scores: ReadonlyArray<[OutcomeClaim, Score]>, scoredAt: string): Promise<void> {
  const keys = await keysOf(deps, task, round, scores.map(([claim]) => claim));
  for (const { claim, key } of keys) {
    const score = scores.find(([wanted]) => wanted === claim)![1];
    await scoreOutcomeSample(deps, key, { ...score, scoredAt });
  }
}

/** A person asked for changes on a pull request of this candidate, or started a feedback round on it: its review and risk samples did not hold (first sight wins; a later approval does not undo it). */
export async function scoreChangesRequested(
  deps: OutcomeDependencies, task: OutcomeTask, input: { candidateDigest: string; reason: "changes_requested_by_person" | "feedback_round_by_person"; now: string },
): Promise<void> {
  try {
    const score: Score = { state: "not_held", reason: input.reason };
    await scoreClaims(deps, task, outcomeRoundOf(input.candidateDigest), [...REVIEW_CLAIMS, "risk_low"].map((claim) => [claim, score] as [OutcomeClaim, Score]), input.now);
  } catch (error) {
    noteFailure(deps, "changes_requested", error);
  }
}

/**
 * What a candidate's pull requests did, scored once all of them are over. `status` is GitHub's answer for the pull request that just ended, read now: its state, its checks (read fresh, not from the
 * tracking item) and its reviews. A candidate with several pull requests waits until every one is merged or closed; then it is "merged" when any of them merged (this pull request's merge
 * commit and time are kept), else "closed unmerged". A pull request still open (here or in the workflow) scores nothing. `mergeCommit` and `mergedAt` come from the pull request read; a merge time GitHub
 * did not give is the time of this observation.
 */
export async function scoreEndedPullRequest(
  deps: OutcomeDependencies, task: OutcomeTask & { workflow: WorkflowSnapshot },
  input: { repositoryId: string; number: number; status: PullRequestStatus; mergeCommit?: string | undefined; mergedAt?: string | undefined; now: string },
): Promise<void> {
  try {
    const { status } = input;
    if (status.state === "open") return;
    const own = task.workflow.pullRequests?.find((entry) => entry.repositoryId === input.repositoryId && entry.number === input.number);
    if (own === undefined) return;
    const group = (task.workflow.pullRequests ?? []).filter((entry) => entry.candidateDigest === own.candidateDigest);
    const others = group.filter((entry) => entry !== own);
    if (others.some((entry) => entry.state !== "MERGED" && entry.state !== "CLOSED")) return;
    const merged = status.state === "merged" || others.some((entry) => entry.state === "MERGED");
    const round = outcomeRoundOf(own.candidateDigest);
    if (!merged) {
      const closed: Score = { state: "closed_unmerged", reason: "closed_unmerged" };
      await scoreClaims(deps, task, round, PENDING_CLAIMS.map((claim) => [claim, closed] as [OutcomeClaim, Score]), input.now);
      return;
    }
    // Reviews by people, as GitHub shows them now: a person's approval or request for changes (bots do not count). A person's latest word of changes requested stands.
    const latest = new Map<string, PullRequestStatus["reviews"][number]>();
    for (const review of [...status.reviews].sort((left, right) => left.submittedAt.localeCompare(right.submittedAt))) {
      if (review.userType !== "User" || review.state === "COMMENTED" || review.state === "PENDING") continue;
      latest.set(review.githubUserId, review);
    }
    const people = [...latest.values()].filter((review) => review.state === "APPROVED" || review.state === "CHANGES_REQUESTED");
    const changesRequested = people.some((review) => review.state === "CHANGES_REQUESTED");
    const reviewed = people.length > 0;
    const mergeCommit = input.mergeCommit !== undefined && /^[a-f0-9]{40,64}$/u.test(input.mergeCommit) ? input.mergeCommit : undefined;
    const mergedAt = input.mergedAt !== undefined && Number.isFinite(Date.parse(input.mergedAt)) ? new Date(input.mergedAt).toISOString() : input.now;
    const pr = { repositoryId: input.repositoryId, number: input.number, ...(mergeCommit === undefined ? {} : { mergeCommit }), mergedAt };
    const held: Score = changesRequested ? { state: "not_held", reason: "changes_requested_by_person", pr }
      : { state: "held", reason: reviewed ? "merged_no_changes_requested" : "merged_without_person_review", pr };
    const reviewScore: Score = changesRequested || reviewed ? held : { ...held, unreviewedMerge: true };
    // Nothing reported at all is "no CI" at the merge (there is no waiting for it any more); otherwise the tracking pass's own reading of the checks.
    const ci = status.checks.length === 0 ? "none" : readCi(status, { checksEverSeen: true, lastRovaraPushAt: undefined, now: Date.parse(input.now) }).ci;
    const proof: Score = status.checksUnavailable === true ? { state: "no_outcome", reason: "ci_none", pr }
      : ci === "passing" ? { state: "held", reason: "ci_passing", pr } : ci === "failing" ? { state: "not_held", reason: "ci_failing", pr }
        : { state: "no_outcome", reason: ci === "pending" ? "ci_pending" : "ci_none", pr };
    await scoreClaims(deps, task, round, [
      ...REVIEW_CLAIMS.map((claim) => [claim, reviewScore] as [OutcomeClaim, Score]),
      ["risk_low", held], ["proves_change", proof],
    ], input.now);
  } catch (error) {
    noteFailure(deps, "merge", error);
  }
}

/**
 * The task is over (closed, or finished with its pull request merged): every sample still open becomes `no_outcome`, except those a pull request's own end scores (a merged pull request's
 * candidate is left to the merge; a closed one is scored closed unmerged here if its own hook has not).
 */
export async function settleTaskOutcomes(deps: OutcomeDependencies, task: OutcomeTask & { workflow?: WorkflowSnapshot | undefined }, now: string): Promise<void> {
  try {
    if (task.orgId === undefined) return;
    let start: Record<string, unknown> | undefined;
    do {
      const page = await deps.ddb.send(new QueryCommand({
        TableName: deps.tableName, ConsistentRead: true, KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
        ExpressionAttributeValues: { ":pk": `DEVTASK#${task.taskId}`, ":prefix": POINTER_PREFIX }, ...(start === undefined ? {} : { ExclusiveStartKey: start }),
      })) as { Items?: Array<{ round?: unknown }>; LastEvaluatedKey?: Record<string, unknown> };
      for (const item of page.Items ?? []) {
        if (typeof item.round !== "string") continue;
        const prs = (task.workflow?.pullRequests ?? []).filter((entry) => outcomeRoundOf(entry.candidateDigest) === item.round);
        if (prs.some((entry) => entry.state === "MERGED")) continue;
        const score: Score = prs.length > 0 && prs.every((entry) => entry.state === "CLOSED") ? { state: "closed_unmerged", reason: "closed_unmerged" } : { state: "no_outcome", reason: "task_closed" };
        await scoreClaims(deps, task, item.round, PENDING_CLAIMS.map((claim) => [claim, score] as [OutcomeClaim, Score]), now);
      }
      start = page.LastEvaluatedKey;
    } while (start !== undefined);
  } catch (error) {
    noteFailure(deps, "settle", error);
  }
}
