// Second review (lane cr-settings, switch `cr`): the evidence that lets a model block, and the writers of it. Owner decision 2026-11-02:
//   - The replay run (what the quality suite measured) and the verdict (which run a model rests on, and the shadow window) are written ONLY by Rovara staff in Public and by the install's administrator in
//     Enterprise (the admin pool; `aws/broker/second-review-evidence-routes.ts`). Never by a project, a member or a company admin.
//   - The shadow window a verdict stores is the SPAN OF THE ROWS ACTUALLY COUNTED (the first and the last answered opinion in the window the writer named), not the window the writer typed: a typed window of 14 days over
//     rows from one day is a one-day shadow, and fails the bar.
//   - A verdict stores EVIDENCE, never a pass: `holds` is recomputed on every read from the stored replay run (`summarizeSecondReviewReplay`) and the shadow window (`secondReviewShadowPassed`), by
//     `secondReviewVerdictHolds`. The shadow counts are not typed in by the writer: the broker counts them itself from the company's own track record (`second-review-track.ts`) for the window the writer names,
//     so the evidence cannot say more than the company's tasks showed.
//   - A company admin can only WITHDRAW a verdict (the model then stops blocking at once), and cannot bring one back: a new verdict is written by staff.
// Every write is one transaction with its audit event, so evidence never changes unaudited.
import { GetCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { SecondReviewReplayRunSchema, SecondReviewVerdictSchema, secondReviewModelKey, secondReviewShadowPassed, secondReviewVerdictHolds, summarizeSecondReviewReplay, type SecondReviewModelRef, type SecondReviewReplayRun, type SecondReviewReplaySummary, type SecondReviewVerdict } from "@rovara-code/contracts";
import { readTrackRecord } from "../rovara-code/second-review-track.js";
import type { ModeAudit } from "./second-review-mode.js";
import { secondReviewReplayKey, secondReviewVerdictKey, type SecondReviewSettings, type SettingsTable } from "./second-review-settings.js";

/** Whether the evidence on record lets `model` run in `on` NOW (recomputed; a withdrawn, missing or failing verdict is false). */
export function verdictHoldsFor(settings: Pick<SecondReviewSettings, "verdicts" | "replayRuns">, model: SecondReviewModelRef): boolean {
  const key = secondReviewModelKey(model);
  return settings.verdicts.some((verdict) => verdict.model === key && secondReviewVerdictHolds(verdict, settings.replayRuns.find((run) => run.runId === verdict.replayRunId)));
}

export type EvidenceFailure = "invalid" | "audit_unavailable" | "run_exists" | "run_missing" | "model_mismatch" | "window_invalid" | "no_shadow_evidence" | "not_found" | "already_withdrawn" | "conflict";
export interface EvidenceDeps { table: SettingsTable; audit: ModeAudit; now(): number }
const errorName = (error: unknown): string => (error instanceof Error ? error.name : "unknown");
const orgTarget = (orgId: string) => ({ kind: "org" as const, id: orgId.slice(0, 100) });

async function commit(deps: EvidenceDeps, items: NonNullable<ConstructorParameters<typeof TransactWriteCommand>[0]["TransactItems"]>, audit: NonNullable<ReturnType<ModeAudit["pending"]>>): Promise<"ok" | "cancelled"> {
  try { await deps.table.documentClient.send(new TransactWriteCommand({ TransactItems: [...items, audit.put] })); } catch (error) {
    if (errorName(error) === "TransactionCanceledException" || errorName(error) === "ConditionalCheckFailedException") return "cancelled";
    throw error;
  }
  await audit.flush();
  return "ok";
}

/** Stores a replay run, once: a run id is never written twice (it is the evidence a verdict names, so it cannot change under it). The pass is not stored; the summary returned is scored now. */
export async function recordReplayRun(deps: EvidenceDeps, input: { orgId: string; run: unknown; by: string }): Promise<{ ok: true; summary: SecondReviewReplaySummary } | { ok: false; code: EvidenceFailure }> {
  const parsed = SecondReviewReplayRunSchema.safeParse(input.run);
  if (!parsed.success) return { ok: false, code: "invalid" };
  const run = parsed.data;
  const summary = summarizeSecondReviewReplay(run.cases);
  const at = deps.now();
  const audit = deps.audit.pending({ action: "company.second_review_replay_recorded", target: orgTarget(input.orgId), facts: { runId: run.runId, cases: run.cases.length, passed: summary.passed } }, input.by, at);
  if (audit === undefined) return { ok: false, code: "audit_unavailable" };
  const result = await commit(deps, [{ Put: { TableName: deps.table.tableName, Item: { ...secondReviewReplayKey(input.orgId, run.runId), entityType: "SECOND_REVIEW_REPLAY", run, createdAt: at, createdBy: input.by }, ConditionExpression: "attribute_not_exists(pk)" } }], audit);
  return result === "ok" ? { ok: true, summary } : { ok: false, code: "run_exists" };
}

export interface VerdictRecord { verdict: SecondReviewVerdict; holds: boolean; replay: SecondReviewReplaySummary; shadow: { days: number; findings: number; agreed: number; reviews: number; passed: boolean } }

/**
 * Stores the evidence for one model: the replay run it rests on (already stored) and a shadow window. The shadow counts are the broker's own, from the company's track record for that window. The window must start
 * after the run and must not end in the future. The answer carries what holds NOW, computed for the writer's information; it is not stored.
 */
export async function recordVerdict(deps: EvidenceDeps, input: { orgId: string; model: SecondReviewModelRef; replayRunId: string; startedAt: string; endedAt: string; by: string }): Promise<({ ok: true } & VerdictRecord) | { ok: false; code: EvidenceFailure }> {
  const key = secondReviewModelKey(input.model);
  const at = deps.now();
  const started = Date.parse(input.startedAt), ended = Date.parse(input.endedAt);
  if (Number.isNaN(started) || Number.isNaN(ended) || ended < started || ended > at) return { ok: false, code: "window_invalid" };
  // Write the verdict only against a run that exists and is this model's.
  const stored = (await deps.table.documentClient.send(new GetCommand({ TableName: deps.table.tableName, Key: secondReviewReplayKey(input.orgId, input.replayRunId), ConsistentRead: true })) as { Item?: { run?: unknown } }).Item;
  const parsedRun = SecondReviewReplayRunSchema.safeParse(stored?.run);
  if (!parsedRun.success) return { ok: false, code: "run_missing" };
  const run: SecondReviewReplayRun = parsedRun.data;
  if (secondReviewModelKey(run.candidate) !== key) return { ok: false, code: "model_mismatch" };
  if (started <= Date.parse(run.ranAt)) return { ok: false, code: "window_invalid" };
  const counted = await readTrackRecord(deps.table, input.orgId, key, { from: new Date(started).toISOString(), to: new Date(ended).toISOString() });
  if (counted.reviews === 0 || counted.firstAt === undefined || counted.lastAt === undefined) return { ok: false, code: "no_shadow_evidence" };
  // The window the evidence rests on is what was counted: from the first to the last row, never the span the writer typed.
  const verdict = SecondReviewVerdictSchema.safeParse({
    model: key, replayRunId: run.runId, baseline: run.baseline,
    shadow: { startedAt: counted.firstAt, endedAt: counted.lastAt, findings: counted.findings, agreed: counted.agreed, reviews: counted.reviews },
    createdAt: new Date(at).toISOString(), createdBy: input.by,
  });
  if (!verdict.success) return { ok: false, code: "invalid" };
  const shadow = { days: counted.days, findings: counted.findings, agreed: counted.agreed, reviews: counted.reviews };
  const audit = deps.audit.pending({ action: "company.second_review_verdict_recorded", target: orgTarget(input.orgId), facts: { model: key.slice(0, 128), runId: run.runId, days: shadow.days, findings: shadow.findings, agreed: shadow.agreed } }, input.by, at);
  if (audit === undefined) return { ok: false, code: "audit_unavailable" };
  const result = await commit(deps, [{ Put: { TableName: deps.table.tableName, Item: { ...secondReviewVerdictKey(input.orgId, key), entityType: "SECOND_REVIEW_VERDICT", verdict: verdict.data } } }], audit);
  if (result !== "ok") return { ok: false, code: "conflict" };
  return { ok: true, verdict: verdict.data, holds: secondReviewVerdictHolds(verdict.data, run), replay: summarizeSecondReviewReplay(run.cases), shadow: { ...shadow, passed: secondReviewShadowPassed(shadow) } };
}

/** A company admin withdraws a model's verdict: the model stops blocking at once. Withdrawing twice is refused; nothing here can bring a verdict back. */
export async function withdrawVerdict(deps: EvidenceDeps, input: { orgId: string; model: SecondReviewModelRef; by: string }): Promise<{ ok: true } | { ok: false; code: EvidenceFailure }> {
  const key = secondReviewModelKey(input.model);
  const at = deps.now();
  const audit = deps.audit.pending({ action: "company.second_review_verdict_withdrawn", target: orgTarget(input.orgId), facts: { model: key.slice(0, 128) } }, input.by, at);
  if (audit === undefined) return { ok: false, code: "audit_unavailable" };
  const when = new Date(at).toISOString();
  const result = await commit(deps, [{ Update: {
    TableName: deps.table.tableName, Key: secondReviewVerdictKey(input.orgId, key), UpdateExpression: "SET #v.#wa = :when, #v.#wb = :by",
    ConditionExpression: "attribute_exists(pk) AND attribute_not_exists(#v.#wa)", ExpressionAttributeNames: { "#v": "verdict", "#wa": "withdrawnAt", "#wb": "withdrawnBy" }, ExpressionAttributeValues: { ":when": when, ":by": input.by },
  } }], audit);
  if (result === "ok") return { ok: true };
  // Refused: no such verdict, or it is withdrawn already.
  const there = (await deps.table.documentClient.send(new GetCommand({ TableName: deps.table.tableName, Key: secondReviewVerdictKey(input.orgId, key), ConsistentRead: true })) as { Item?: unknown }).Item;
  return { ok: false, code: there === undefined ? "not_found" : "already_withdrawn" };
}

/** What the settings page shows about the evidence for one model: whether it holds now (recomputed), and the numbers behind it. No person's id and no text. */
export interface EvidenceView {
  model: SecondReviewModelRef;
  holds: boolean;
  verdict: { recordedAt: string; withdrawn: boolean; shadowDays: number; shadowFindings: number; shadowAgreed: number; shadowPassed: boolean } | null;
  replay: SecondReviewReplaySummary | null;
}
export function evidenceViewOf(settings: Pick<SecondReviewSettings, "verdicts" | "replayRuns">, model: SecondReviewModelRef): EvidenceView {
  const key = secondReviewModelKey(model);
  const verdict = settings.verdicts.find((entry) => entry.model === key);
  const run = verdict === undefined ? undefined : settings.replayRuns.find((entry) => entry.runId === verdict.replayRunId);
  const days = verdict === undefined ? 0 : Math.max(0, Math.floor((Date.parse(verdict.shadow.endedAt) - Date.parse(verdict.shadow.startedAt)) / 86_400_000));
  return {
    model: { provider: model.provider, modelId: model.modelId }, holds: verdictHoldsFor(settings, model),
    verdict: verdict === undefined ? null : { recordedAt: verdict.createdAt, withdrawn: verdict.withdrawnAt !== undefined, shadowDays: days, shadowFindings: verdict.shadow.findings, shadowAgreed: verdict.shadow.agreed,
      shadowPassed: secondReviewShadowPassed({ days, findings: verdict.shadow.findings, agreed: verdict.shadow.agreed, ...(verdict.shadow.reviews === undefined ? {} : { reviews: verdict.shadow.reviews }) }) },
    replay: run === undefined ? null : summarizeSecondReviewReplay(run.cases),
  };
}
