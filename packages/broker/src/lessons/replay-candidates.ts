// Lane 7 (DECISIONS 49): the candidates for the replay's task choice, from items the operator exported from the State table (the same input as `scripts/export-replay-tasks.ts`: unmarshalled plain items, one
// `DEVTASK#<id>` / `META` item per task). Pure and read-only. A task's member corrections are counted from what the task record itself holds (the human send-backs in its decision history, by the same rule the
// lessons use, `human-send-backs.ts`), plus the counts the operator adds from the Team record for what the task record cannot hold (review comments that read as corrections, human edits, a revert).
// A task that is not a finished piece of a person's work is skipped and counted by reason: an automatic run, a setup draft, an unfinished task, and an EVAL OR REPLAY RUN (a replay is never a past task).
import { isHumanSendBack } from "./human-send-backs.js";
import { isEvalRunMark } from "./eval-run.js";
import type { ReplayCandidate } from "./replay-select.js";

export interface ExtraCorrections { prComments?: number; humanEdits?: number; reverts?: number }
export interface CandidateInput {
  items: readonly unknown[];
  /** Counts from the Team record by task id. Absent: the task record's send-backs only. */
  corrections?: Readonly<Record<string, ExtraCorrections>>;
}
export const CANDIDATE_SKIP_REASONS = ["not_a_work_task", "eval_run", "no_workflow", "not_finished", "no_repository", "no_time", "wrong_org"] as const;
export type CandidateSkipReason = (typeof CANDIDATE_SKIP_REASONS)[number];
export interface CandidateExport { candidates: ReplayCandidate[]; skipped: Record<CandidateSkipReason, number>; ignoredItems: number }

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const count = (n: unknown): number => (typeof n === "number" && Number.isInteger(n) && n > 0 ? n : 0);

export function candidatesFromItems(input: CandidateInput, options: { orgId?: string } = {}): CandidateExport {
  const skipped = Object.fromEntries(CANDIDATE_SKIP_REASONS.map((reason) => [reason, 0])) as Record<CandidateSkipReason, number>;
  const candidates: ReplayCandidate[] = [];
  let ignoredItems = 0;
  for (const item of input.items) {
    if (!isObject(item) || typeof item["pk"] !== "string" || !item["pk"].startsWith("DEVTASK#") || item["sk"] !== "META") { ignoredItems += 1; continue; }
    const taskId = item["taskId"];
    if (typeof taskId !== "string" || taskId === "") { ignoredItems += 1; continue; }
    const skip = (reason: CandidateSkipReason): void => { skipped[reason] += 1; };
    if (options.orgId !== undefined && item["orgId"] !== options.orgId) { skip("wrong_org"); continue; }
    if (isEvalRunMark(item["evalRun"])) { skip("eval_run"); continue; }
    if (item["automatic"] !== undefined || item["purpose"] !== undefined) { skip("not_a_work_task"); continue; }
    const workflow = item["workflow"];
    if (!isObject(workflow)) { skip("no_workflow"); continue; }
    const outcome = workflow["outcome"] === "MERGED" ? "merged" : workflow["outcome"] === "CLOSED" || workflow["outcome"] === "REJECTED" ? "closed" : undefined;
    if (outcome === undefined) { skip("not_finished"); continue; }
    const pullRequests = Array.isArray(workflow["pullRequests"]) ? workflow["pullRequests"].filter(isObject) : [];
    const reviewBase = Array.isArray(workflow["reviewBase"]) ? workflow["reviewBase"].filter(isObject) : [];
    const repository = [...pullRequests, ...reviewBase].map((entry) => entry["repositoryId"]).find((id): id is string => typeof id === "string" && id !== "");
    if (repository === undefined) { skip("no_repository"); continue; }
    const at = typeof item["createdAt"] === "string" ? Date.parse(item["createdAt"]) : Number.NaN;
    if (!Number.isFinite(at)) { skip("no_time"); continue; }
    if (typeof item["project"] !== "string" || item["project"] === "") { skip("not_a_work_task"); continue; }
    const decisions = Array.isArray(workflow["decisions"]) ? workflow["decisions"].filter(isObject) : [];
    const sendBacks = decisions.filter((d) => isHumanSendBack({ source: d["source"] as never, decision: d["decision"] as never, actorRole: d["actorRole"] as never })).length;
    const extra = input.corrections?.[taskId];
    candidates.push({ taskId, project: item["project"], repository, at, outcome, memberCorrections: sendBacks + count(extra?.prComments) + count(extra?.humanEdits) + count(extra?.reverts) });
  }
  candidates.sort((a, b) => (a.taskId < b.taskId ? -1 : 1));
  return { candidates, skipped, ignoredItems };
}
