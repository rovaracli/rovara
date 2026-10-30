// Track record (v1.2, slice 1): where the broker records and scores a claim. Each claim is a sample in the outcome store (outcomes.ts); this file knows WHEN: after a plan decision commits, when a
// pull request is published, when a person asks for changes, when the pull request merges or closes, and when the task closes with samples still open.
//
// Every function here is best effort and never throws: a failed write is logged with a fixed code and counted on a metric (`OutcomeWriteFailed`), and the flow it records goes on. Only the broker
// calls them, from its own state (the workflow it saved, GitHub's own answer); nothing a worker or an agent sends reaches them.
//
// Finding a pending sample. A sample's key starts with its creation time, so the first write of a candidate's samples also writes one small pointer item under the task
// (`DEVTASK#<taskId>` / `OUTCOME_KEYS#<round>`, holding that creation time). A key is then rebuilt from the pointer, the claim and the round, and nothing a whole-workflow write does can lose it
// (the keys are not in the workflow, which other writers replace as a whole). The pointer is written once and kept; a retry reuses its creation time, so a retry is the same sample.
import { GetCommand, PutCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import {
  INDEX_EXPIRY_ATTRIBUTE, OUTCOME_PENDING_KEPT_DAYS, ROVARA_CODE_AGENT_ID, outcomeSampleKey, outcomeStageOf,
  type OrgId, type OutcomeClaim, type OutcomeReason, type OutcomeSample, type OutcomeSampleKey, type OutcomeState, type WorkflowCritique, type WorkflowSnapshot,
} from "@agentx/contracts";
import { NOT_EXISTS, errorName } from "../agents/table-writes.js";
import type { TaskAgentRef } from "../agents/roster.js";
import type { TestProofRead } from "../developer/test-proof-lines.js";
import { readCi, readReviews } from "./merge-tracking.js";
import { OUTCOME_WRITE_FAILED_METRIC, recordOutcomeSample, scoreOutcomeSample, type OutcomeDependencies } from "./outcomes.js";
import type { PullRequestStatus } from "../github-pull-status.js";

type Permission = "admin" | "write" | "read" | "none";

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

// ---- the pointer: where a candidate's samples are, and what was seen of its code

interface Pointer {
  createdAt: string;
  /** The heads the candidate's pull request has had (the commit a review is on says which candidate it is about). */
  heads: string[];
  /** The checks were seen passing on the candidate's head. */
  ciPassing: boolean;
}
const HEADS_KEPT = 8;

async function readPointer(deps: OutcomeDependencies, taskId: string, round: string): Promise<Pointer | undefined> {
  const item = (await deps.ddb.send(new GetCommand({ TableName: deps.tableName, Key: pointerKey(taskId, round), ConsistentRead: true })) as { Item?: Record<string, unknown> }).Item;
  if (typeof item?.createdAt !== "string") return undefined;
  const heads = Array.isArray(item.heads) ? item.heads.filter((head): head is string => typeof head === "string") : [];
  return { createdAt: item.createdAt, heads, ciPassing: item.ciPassing === true };
}

/** The creation time every sample of a candidate shares: kept in the candidate's pointer item, written once. */
async function creationTimeOf(deps: OutcomeDependencies, task: OutcomeTask, round: string, now: string): Promise<string> {
  const stored = await readPointer(deps, task.taskId, round);
  if (stored !== undefined) return stored.createdAt;
  try {
    await deps.ddb.send(new PutCommand({
      TableName: deps.tableName,
      Item: { ...pointerKey(task.taskId, round), entityType: "OUTCOME_KEYS", taskId: task.taskId, round, createdAt: now, heads: [], [INDEX_EXPIRY_ATTRIBUTE]: Math.floor(Date.parse(now) / 1000) + OUTCOME_PENDING_KEPT_DAYS * DAY_SECONDS },
      ConditionExpression: NOT_EXISTS,
    }));
    return now;
  } catch (error) {
    // Another call got there first: its time stands.
    const again = await readPointer(deps, task.taskId, round);
    if (again !== undefined) return again.createdAt;
    throw error;
  }
}

/** What the tracking pass saw of a candidate: a head its pull request has had, and checks seen passing on it. Only changes are written. */
async function notePointer(deps: OutcomeDependencies, task: OutcomeTask, round: string, seen: { head?: string | undefined; ciPassing?: true }): Promise<void> {
  const pointer = await readPointer(deps, task.taskId, round);
  if (pointer === undefined) return;
  const heads = seen.head === undefined || pointer.heads.includes(seen.head) ? pointer.heads : [...pointer.heads, seen.head].slice(-HEADS_KEPT);
  const ciPassing = pointer.ciPassing || seen.ciPassing === true;
  if (heads === pointer.heads && ciPassing === pointer.ciPassing) return;
  await deps.ddb.send(new UpdateCommand({
    TableName: deps.tableName, Key: pointerKey(task.taskId, round), UpdateExpression: "SET heads = :heads, ciPassing = :ci", ConditionExpression: "attribute_exists(pk)",
    ExpressionAttributeValues: { ":heads": heads, ":ci": ciPassing },
  }));
}

/** The rounds the task has samples for, with their pointers. */
async function pointersOf(deps: OutcomeDependencies, taskId: string): Promise<Array<{ round: string } & Pointer>> {
  const found: Array<{ round: string } & Pointer> = [];
  let start: Record<string, unknown> | undefined;
  do {
    const page = await deps.ddb.send(new QueryCommand({
      TableName: deps.tableName, ConsistentRead: true, KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
      ExpressionAttributeValues: { ":pk": `DEVTASK#${taskId}`, ":prefix": POINTER_PREFIX }, ...(start === undefined ? {} : { ExclusiveStartKey: start }),
    })) as { Items?: Array<Record<string, unknown>>; LastEvaluatedKey?: Record<string, unknown> };
    for (const item of page.Items ?? []) {
      if (typeof item.round !== "string" || typeof item.createdAt !== "string") continue;
      found.push({ round: item.round, createdAt: item.createdAt, ciPassing: item.ciPassing === true, heads: Array.isArray(item.heads) ? item.heads.filter((head): head is string => typeof head === "string") : [] });
    }
    start = page.LastEvaluatedKey;
  } while (start !== undefined);
  return found;
}

// ---- publication

/**
 * The claims of a published candidate: pending `review_pass:<role>` for each passing review of that candidate, `proves_change` when the proof for it has a proving item, and `risk_low` when its risk is
 * low. A proof that could not be READ is not a silent zero: it is its own sample, scored `no_outcome`; a proof that was never found makes no claim at all. All of them are keyed by the candidate, so a
 * repeat of the publication is the same samples. Call it once the publication is accepted, never before.
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
    const unreadable = "unavailable" in input.proof && input.proof.unavailable === "read_failed";
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
  const stored = (await readPointer(deps, task.taskId, round))?.createdAt;
  if (stored === undefined) return [];
  const orgId = task.orgId;
  return claims.map((claim) => ({ claim, key: outcomeSampleKey(orgId, task.project, outcomeStageOf(claim), stored, task.taskId, claim, round) }));
}

/** Whether any of a candidate's samples is still pending (so a fresh GitHub read is worth making). */
async function anyPending(deps: OutcomeDependencies, task: OutcomeTask, round: string): Promise<boolean> {
  for (const { key } of await keysOf(deps, task, round, PENDING_CLAIMS)) {
    const item = (await deps.ddb.send(new GetCommand({ TableName: deps.tableName, Key: key, ConsistentRead: true })) as { Item?: { state?: unknown } }).Item;
    if (item?.state === "pending") return true;
  }
  return false;
}

type Score = { state: Exclude<OutcomeState, "pending">; reason: OutcomeReason; unreviewedMerge?: true; pr?: OutcomeSample["pr"] };

async function scoreClaims(deps: OutcomeDependencies, task: OutcomeTask, round: string, scores: ReadonlyArray<[OutcomeClaim, Score]>, scoredAt: string): Promise<void> {
  const keys = await keysOf(deps, task, round, scores.map(([claim]) => claim));
  for (const { claim, key } of keys) {
    const score = scores.find(([wanted]) => wanted === claim)![1];
    await scoreOutcomeSample(deps, key, { ...score, scoredAt });
  }
}
const allPending = (score: Score): Array<[OutcomeClaim, Score]> => PENDING_CLAIMS.map((claim) => [claim, score]);

/** A person asked for changes on code of these candidates (a request on a pull request, or a round of fixes their comments started): their review and risk samples did not hold. First sight wins. */
export async function scoreChangesRequested(
  deps: OutcomeDependencies, task: OutcomeTask, input: { rounds: readonly string[]; reason: "changes_requested_by_person" | "feedback_round_by_person"; now: string },
): Promise<void> {
  try {
    const score: Score = { state: "not_held", reason: input.reason };
    for (const round of new Set(input.rounds)) await scoreClaims(deps, task, round, [...REVIEW_CLAIMS, "risk_low"].map((claim) => [claim, score] as [OutcomeClaim, Score]), input.now);
  } catch (error) {
    noteFailure(deps, "changes_requested", error);
  }
}

/** The people (write access or above, not bots) whose latest word on the pull request is "changes requested", and the commit each review is on. */
export async function changesRequestedCommits(status: PullRequestStatus, permission: (login: string) => Promise<Permission>): Promise<string[]> {
  const latest = new Map<string, PullRequestStatus["reviews"][number]>();
  for (const review of [...status.reviews].sort((left, right) => left.submittedAt.localeCompare(right.submittedAt))) {
    if (review.userType !== "User" || review.state === "COMMENTED" || review.state === "PENDING") continue;
    latest.set(review.githubUserId, review);
  }
  const commits: string[] = [];
  for (const review of latest.values()) {
    if (review.state !== "CHANGES_REQUESTED") continue;
    const level = await permission(review.login);
    if (level === "admin" || level === "write") commits.push(review.commitId);
  }
  return commits;
}

/** The candidates a request for changes is about: the one whose head the review is on, else (a head not known) the candidate current when it was seen. */
export async function roundsOfCommits(deps: OutcomeDependencies, task: OutcomeTask, commits: readonly string[], currentRound: string): Promise<string[]> {
  const pointers = await pointersOf(deps, task.taskId);
  const rounds = commits.map((commit) => pointers.find((pointer) => pointer.heads.includes(commit))?.round ?? currentRound);
  return rounds.length === 0 ? [currentRound] : [...new Set(rounds)];
}

/**
 * What the tracking pass sees of the code a candidate published: its head (for telling which candidate a later review is on), and its checks. Failing checks on that head are the proof's own answer
 * ("the tests said they prove the change" and CI failed), scored now, so a fix that replaces the candidate cannot hide them; passing checks are remembered for when it is replaced.
 */
export async function observeCandidateCode(
  deps: OutcomeDependencies, task: OutcomeTask, input: { candidateDigest: string; head: string | undefined; ci: "none" | "pending" | "passing" | "failing"; ciIsOnHead: boolean; now: string },
): Promise<void> {
  try {
    const round = outcomeRoundOf(input.candidateDigest);
    await notePointer(deps, task, round, { head: input.head });
    if (!input.ciIsOnHead) return;
    if (input.ci === "failing") await scoreClaims(deps, task, round, [["proves_change", { state: "not_held", reason: "ci_failing" }]], input.now);
    if (input.ci === "passing") await notePointer(deps, task, round, { ciPassing: true });
  } catch (error) {
    noteFailure(deps, "observe", error);
  }
}

/**
 * A new candidate replaces this one on its pull request: what is still open is settled by what was seen of this one. A round of fixes a person's comments started is "a person asked for changes";
 * the proof is held when its checks were seen passing on the head (failing was scored when seen), else it has no outcome; whatever else is open was never put to a person: `superseded`.
 */
export async function settleSuperseded(deps: OutcomeDependencies, task: OutcomeTask & { workflow: WorkflowSnapshot }, input: { candidateDigest: string; now: string }): Promise<void> {
  try {
    const round = outcomeRoundOf(input.candidateDigest);
    const pointer = await readPointer(deps, task.taskId, round);
    if (pointer === undefined) return;
    const asked = (task.workflow.feedbackDecisions ?? []).some((decision) => decision.decision === "APPROVE" && decision.candidates.some((binding) => binding.candidateDigest === input.candidateDigest));
    if (asked) await scoreChangesRequested(deps, task, { rounds: [round], reason: "feedback_round_by_person", now: input.now });
    const superseded: Score = { state: "no_outcome", reason: "superseded" };
    await scoreClaims(deps, task, round, [["proves_change", pointer.ciPassing ? { state: "held", reason: "ci_passing" } : superseded],
      ...[...REVIEW_CLAIMS, "risk_low"].map((claim) => [claim, superseded] as [OutcomeClaim, Score])], input.now);
  } catch (error) {
    noteFailure(deps, "superseded", error);
  }
}

// ---- a candidate's pull requests end

/** GitHub's answer for one pull request, read now: its status (checks and reviews), the merge commit and time, and a person's permission on its repository. */
export interface EndedPullRequestRead {
  status: PullRequestStatus;
  mergeCommit?: string | undefined;
  mergedAt?: string | undefined;
  permission(login: string): Promise<Permission>;
}
export type EndedPullRequestReader = (repositoryId: string, number: number) => Promise<EndedPullRequestRead>;

const READ_TIMEOUT_MS = 8_000;
/** A GitHub read is bounded: a hung one is a failed one, and what waits on it goes on. */
function bounded<T>(work: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(Object.assign(new Error("read timed out"), { name: "OutcomeReadTimeout" })), READ_TIMEOUT_MS);
    work.then((value) => { clearTimeout(timer); resolve(value); }, (error: unknown) => { clearTimeout(timer); reject(error instanceof Error ? error : new Error("read failed")); });
  });
}

/** What the people who reviewed a pull request said about THIS candidate's code: reviews on its heads only, from people with write access or above (the tracking pass's own rule). */
async function reviewsOn(read: EndedPullRequestRead, heads: readonly string[]): Promise<"changes_requested" | "approved" | "none"> {
  const valid = new Set([...heads, read.status.headSha]);
  const reading = await readReviews({ ...read.status, reviews: read.status.reviews.filter((review) => valid.has(review.commitId)) }, { requested: false, permission: (login) => read.permission(login) });
  return reading.review === "changes_requested" ? "changes_requested" : reading.review === "approved" ? "approved" : "none";
}

/**
 * Scores a candidate whose pull requests are all merged or closed, with at least one merged (`merged` names them; the workflow's merged ones by default). Each merged pull request is read now: its
 * checks decide the proof (any failing: not held; all passing: held; else no outcome), and its reviews (from people with write access, on this candidate's head) decide the reviews and the
 * risk: any request for changes: not held; else held, marked when no person reviewed any of them. The merge commit and time are the first merged pull request's. Nothing is read when
 * no sample of the candidate is open. Never throws: `failed` says a read or a write did not go through.
 */
export async function scoreMergedCandidate(
  deps: OutcomeDependencies, task: OutcomeTask & { workflow: WorkflowSnapshot },
  input: { candidateDigest: string; read: EndedPullRequestReader; now: string; merged?: ReadonlyArray<{ repositoryId: string; number: number }> },
): Promise<"scored" | "nothing" | "failed"> {
  try {
    const round = outcomeRoundOf(input.candidateDigest);
    const group = (task.workflow.pullRequests ?? []).filter((entry) => entry.candidateDigest === input.candidateDigest);
    if (group.length === 0 || group.some((entry) => entry.state !== "MERGED" && entry.state !== "CLOSED")) return "nothing";
    const merged = input.merged ?? group.filter((entry) => entry.state === "MERGED").sort((left, right) => left.repositoryId.localeCompare(right.repositoryId) || left.number - right.number);
    if (merged.length === 0 || !await anyPending(deps, task, round)) return "nothing";
    const heads = (await readPointer(deps, task.taskId, round))?.heads ?? [];
    let failing = false;
    let allPassing = true;
    let anyPending_ = false;
    let changes = false;
    let reviewed = false;
    let first: { repositoryId: string; number: number; mergeCommit: string | undefined; mergedAt: string | undefined } | undefined;
    for (const entry of merged) {
      const read = await bounded(input.read(entry.repositoryId, entry.number));
      const ci = read.status.checksUnavailable === true || read.status.checks.length === 0 ? "none" : readCi(read.status, { checksEverSeen: true, lastRovaraPushAt: undefined, now: Date.parse(input.now) }).ci;
      failing ||= ci === "failing";
      allPassing &&= ci === "passing";
      anyPending_ ||= ci === "pending";
      const said = await bounded(reviewsOn(read, heads));
      changes ||= said === "changes_requested";
      reviewed ||= said !== "none";
      first ??= { repositoryId: entry.repositoryId, number: entry.number, mergeCommit: read.mergeCommit, mergedAt: read.mergedAt };
    }
    const mergeCommit = first?.mergeCommit !== undefined && /^[a-f0-9]{40,64}$/u.test(first.mergeCommit) ? first.mergeCommit : undefined;
    const mergedAt = first?.mergedAt !== undefined && Number.isFinite(Date.parse(first.mergedAt)) ? new Date(first.mergedAt).toISOString() : input.now;
    const pr = { repositoryId: first!.repositoryId, number: first!.number, ...(mergeCommit === undefined ? {} : { mergeCommit }), mergedAt };
    const held: Score = changes ? { state: "not_held", reason: "changes_requested_by_person", pr }
      : { state: "held", reason: reviewed ? "merged_no_changes_requested" : "merged_without_person_review", pr };
    const reviewScore: Score = changes || reviewed ? held : { ...held, unreviewedMerge: true };
    const proof: Score = failing ? { state: "not_held", reason: "ci_failing", pr } : allPassing ? { state: "held", reason: "ci_passing", pr }
      : { state: "no_outcome", reason: anyPending_ ? "ci_pending" : "ci_none", pr };
    await scoreClaims(deps, task, round, [
      ...REVIEW_CLAIMS.map((claim) => [claim, reviewScore] as [OutcomeClaim, Score]),
      ["risk_low", held], ["proves_change", proof],
    ], input.now);
    return "scored";
  } catch (error) {
    noteFailure(deps, "merge", error);
    return "failed";
  }
}

/**
 * The task is over (closed, or finished with its pull requests merged or closed): nothing stays pending.
 * - A candidate with a merged pull request is scored from a fresh read; a read that cannot be made (or fails) is `github_unavailable`.
 * - A candidate whose pull requests are all closed: read again, so a reopened and merged one scores as merged, one still closed is `closed_unmerged`, and one open now has no outcome.
 *   (A close is never scored at the moment it happens: it may be reopened.)
 * - A candidate no pull request holds any more was replaced: `superseded`. Anything else: `task_closed`.
 */
export async function settleTaskOutcomes(
  deps: OutcomeDependencies, task: OutcomeTask & { workflow?: WorkflowSnapshot | undefined }, now: string, read?: EndedPullRequestReader,
): Promise<void> {
  try {
    if (task.orgId === undefined) return;
    for (const pointer of await pointersOf(deps, task.taskId)) {
      try {
        const all = task.workflow?.pullRequests ?? [];
        const prs = all.filter((entry) => outcomeRoundOf(entry.candidateDigest) === pointer.round);
        const withWorkflow = task.workflow === undefined ? undefined : { ...task, workflow: task.workflow };
        if (prs.some((entry) => entry.state === "MERGED") && withWorkflow !== undefined) {
          const result = read === undefined ? "failed" : await scoreMergedCandidate(deps, withWorkflow, { candidateDigest: prs[0]!.candidateDigest, read, now });
          if (result === "failed") await scoreClaims(deps, task, pointer.round, allPending({ state: "no_outcome", reason: "github_unavailable" }), now);
        } else if (prs.length > 0 && prs.every((entry) => entry.state === "CLOSED") && withWorkflow !== undefined) {
          let reads: EndedPullRequestRead[] | undefined;
          if (read !== undefined) reads = await Promise.all(prs.map((entry) => bounded(read(entry.repositoryId, entry.number)))).catch(() => undefined);
          const reopenedMerged = reads === undefined ? [] : prs.filter((_entry, index) => reads[index]!.status.state === "merged");
          if (reopenedMerged.length > 0 && read !== undefined) {
            const result = await scoreMergedCandidate(deps, withWorkflow, { candidateDigest: prs[0]!.candidateDigest, read, now, merged: reopenedMerged });
            if (result === "failed") await scoreClaims(deps, task, pointer.round, allPending({ state: "no_outcome", reason: "github_unavailable" }), now);
          } else if (reads !== undefined && reads.some((one) => one.status.state === "open")) {
            await scoreClaims(deps, task, pointer.round, allPending({ state: "no_outcome", reason: "task_closed" }), now);
          } else {
            await scoreClaims(deps, task, pointer.round, allPending({ state: "closed_unmerged", reason: "closed_unmerged" }), now);
          }
        } else {
          const replaced = prs.length === 0 && all.length > 0;
          await scoreClaims(deps, task, pointer.round, allPending({ state: "no_outcome", reason: replaced ? "superseded" : "task_closed" }), now);
        }
      } catch (error) {
        noteFailure(deps, "settle", error);
      }
    }
  } catch (error) {
    noteFailure(deps, "settle", error);
  }
}
