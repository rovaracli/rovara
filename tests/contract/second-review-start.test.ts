// SR-1, the broker side of starting the second review (switch `cr`): the model picker (the list is the company's own models; same-company entries are greyed out; suggestions come only from the list; the default is
// used while nobody has chosen; a chosen model that stops qualifying is never swapped), the plan, and what the one REVIEW end does with the second report: it never clears or fails a first review, shadow never
// blocks, `on` blocks in the same single Update as the workflow's own transition, and an unavailable second review is flagged and never blocks.
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  SECOND_REVIEW_BLOCK_REASON, SECOND_REVIEW_RESULT_KEY, WORKFLOW_AUTO_SEND_BACK_LIMIT, classifyBlockedWorkflow, configuredSecondReviewMode, narrowedSecondReviewModels, secondReviewDidNotRunLine, secondReviewModelKey, workflowSendBackOffered,
  type ModelIdentifier, type SecondOpinion, type SecondReviewReplayCase, type SecondReviewReplayRun, type SecondReviewVerdict, type WorkflowReviewReport,
} from "@agentx/contracts";
import { WorkflowSnapshotSchema, createCandidateManifest, createWorkflowSnapshot, openReviewFindings, resolveWorkflowReviewFindings, returnWorkflowToImplementationAutomatically, sendBackProblems, type WorkflowSnapshot } from "../../packages/contracts/src/task-workflow-node.js";
import { completedWorkflowItems } from "../../packages/broker/src/aws/broker/workflow-items.js";
import { taskKey } from "../../packages/broker/src/developer/task-records.js";
import { planSecondReview, secondOpinionOf, secondOpinionUnavailable, secondReviewAcknowledgement, secondReviewUnavailableDecision, type SecondReviewPlanInput } from "../../packages/broker/src/rovara-code/second-review.js";
import { defaultModelLine, secondReviewPicker, secondReviewTrackRecord } from "../../packages/broker/src/rovara-code/second-review-picker.js";
import { secondOpinionFromReviewResult, secondReviewMergeWait, secondReviewTaskView, type SecondReviewOperationPlan } from "../../packages/broker/src/rovara-code/second-review-store.js";
import { prepareSecondReview } from "../../packages/broker/src/rovara-code/second-review-start.js";
import type { AwsBrokerDependencies } from "../../packages/broker/src/aws/broker/definitions.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { litellmConfig } from "../../packages/model-proxy/src/litellm-config.js";
import { orgMetaKey, TaskUsageTelemetrySchema, createTaskUsageTelemetry } from "@agentx/contracts";
import { reviewUsageArtifactName } from "../../packages/worker/src/usage.js";
import { acceptSecondReport } from "../../packages/broker/src/rovara-code/second-review.js";

const NOW = "2026-11-02T12:00:00.000Z";
const taskId = "8b579b4b-eaa7-4bf2-87bc-6da86b97c9e6";
const ownerId = "a".repeat(64);
const code = createCandidateManifest([{ repositoryId: "payments", commitSha: "1".repeat(40), treeSha: "1".repeat(40), baseCommitSha: "e".repeat(40) }]);

const OPUS: ModelIdentifier = { provider: "anthropic", modelId: "claude-opus-4-6" };
const SONNET: ModelIdentifier = { provider: "anthropic", modelId: "claude-sonnet-4-6" };
const GPT: ModelIdentifier = { provider: "openrouter", modelId: "openai/gpt-5.5" };
const GPT_FREE: ModelIdentifier = { provider: "openrouter", modelId: "openai/gpt-5.5:free" };
const GEMINI: ModelIdentifier = { provider: "openrouter", modelId: "google/gemini-3-pro" };
const NOVA: ModelIdentifier = { provider: "amazon-bedrock", modelId: "us.amazon.nova-pro-v1:0" };
const MYSTERY: ModelIdentifier = { provider: "openrouter", modelId: "x-ai/grok-9" };

const base = (over: Partial<SecondReviewPlanInput> = {}): SecondReviewPlanInput => ({
  switchOn: true, mode: "shadow", against: [SONNET], project: {}, forbidden: [], sources: [OPUS, SONNET, GPT, GEMINI, NOVA], verdicts: [], replayRuns: [], ...over,
});
const planned = (over: Partial<SecondReviewPlanInput> = {}) => {
  const result = planSecondReview(base(over));
  if (!result.run) throw new Error(`no plan: ${result.reason}`);
  return result;
};
const keys = (models: readonly ModelIdentifier[]) => models.map(secondReviewModelKey);

// ---- evidence that lets a model run in `on`
const replayCases = (): SecondReviewReplayCase[] => {
  const out: SecondReviewReplayCase[] = [];
  const shapes: Array<[boolean, boolean, number]> = [[true, true, 32], [true, false, 8], [false, true, 5], [false, false, 5]];
  for (const [baselineCaught, candidateCaught, count] of shapes) for (let i = 0; i < count; i += 1) out.push({ caseId: `c${String(out.length + 1)}`, kind: "known_defect", baselineCaught, candidateCaught, candidateBlockingFindings: 0, candidateDismissedBlocking: 0 });
  return out.map((entry, index) => ({ ...entry, kind: index < 30 ? "known_defect" as const : "planted_bug" as const }));
};
const proof = (model: ModelIdentifier): { verdicts: SecondReviewVerdict[]; replayRuns: SecondReviewReplayRun[] } => ({
  replayRuns: [{ runId: "run-1", ranAt: "2026-11-01T00:00:00.000Z", candidate: model, baseline: OPUS, cases: replayCases() }],
  verdicts: [{ model: secondReviewModelKey(model), replayRunId: "run-1", baseline: OPUS, shadow: { startedAt: "2026-11-02T00:00:00.000Z", endedAt: "2026-11-16T00:00:00.000Z", findings: 10, agreed: 4, reviews: 10 }, createdAt: "2026-11-20T00:00:00.000Z", createdBy: "staff:alice" }],
});

describe("a task started before the frontier tier keeps its second reviewer's default (legacyRanking)", () => {
  const FABLE: ModelIdentifier = { provider: "anthropic", modelId: "claude-fable-5-1" };
  const OPUS_NEW: ModelIdentifier = { provider: "anthropic", modelId: "claude-opus-5-5" };
  const GPT5: ModelIdentifier = { provider: "openai", modelId: "gpt-5" };
  const tops = (legacyRanking: boolean) => secondReviewPicker({ sources: [OPUS_NEW, FABLE, GPT5, GEMINI], project: {}, forbidden: [], against: [GPT5], legacyRanking }).suggested.map((entry) => entry.model.modelId);
  it("an older task ranks Fable above Opus above Gemini Pro; a new one puts the cheaper Opus first", () => {
    expect(tops(true)).toEqual(["claude-fable-5-1", "claude-opus-5-5", "google/gemini-3-pro"]);
    expect(tops(false)[0]).toBe("claude-opus-5-5");
  });
});

describe("the model picker", () => {
  const picked = secondReviewPicker({ sources: [OPUS, SONNET, GPT, GPT_FREE, GEMINI, NOVA, MYSTERY], project: {}, forbidden: [], against: [SONNET], price: () => ({ inputUsdPerMTok: 2, outputUsdPerMTok: 10 }) });

  it("lists only the models the company can actually use, and none it forbids or its project does not approve", () => {
    expect(keys(picked.entries.map((entry) => entry.model)).sort()).toEqual(keys([OPUS, SONNET, GPT, GPT_FREE, GEMINI, NOVA, MYSTERY]).sort());
    const without = secondReviewPicker({ sources: [OPUS, GPT, GEMINI], project: { approved: [OPUS, GPT] }, forbidden: [GPT], against: [SONNET] });
    expect(keys(without.entries.map((entry) => entry.model))).toEqual(keys([OPUS]));
    // A model the company has no source for is not offered, however strong.
    expect(picked.entries.some((entry) => entry.model.modelId === "gpt-6.1-sol")).toBe(false);
  });

  it("greys out a model from the same company as the builder, with the reason, and one whose maker is unknown", () => {
    const sonnet = picked.entries.find((entry) => entry.model.modelId === SONNET.modelId)!;
    expect(sonnet).toMatchObject({ eligible: false, ineligibleWhy: "same-company", suggested: false });
    expect(picked.entries.find((entry) => entry.model.modelId === OPUS.modelId)).toMatchObject({ eligible: false, ineligibleWhy: "same-company" });
    expect(picked.entries.find((entry) => entry.model.modelId === MYSTERY.modelId)).toMatchObject({ eligible: false, ineligibleWhy: "company-unknown" });
    expect(picked.entries.find((entry) => entry.model.modelId === GPT.modelId)).toMatchObject({ eligible: true, company: "openai" });
  });

  it("suggests two or three eligible entries, with a one-line reason of fixed words, and only from the list", () => {
    expect(picked.suggested.length).toBeGreaterThanOrEqual(2);
    expect(picked.suggested.length).toBeLessThanOrEqual(3);
    for (const entry of picked.suggested) {
      expect(entry.eligible).toBe(true);
      expect(picked.entries).toContain(entry);
      expect(entry.suggestionReason).toMatch(/different AI company/u);
      expect(entry.suggestionReason).not.toMatch(/\n/u);
    }
    // The strongest eligible one first (the critic's capability tiers).
    expect(picked.suggested[0]!.model.modelId).toBe(GPT.modelId);
    expect(picked.suggested.every((entry) => entry.notes.length === 0)).toBe(true);
  });

  it("notes a free variant (the provider may train on the code) and never suggests it", () => {
    const free = picked.entries.find((entry) => entry.model.modelId === GPT_FREE.modelId)!;
    expect(free.notes).toEqual(["the provider may train on the code sent to a free model"]);
    expect(free.suggested).toBe(false);
  });

  it("shows an estimated cost per review from the catalog price and one typical review size", () => {
    const entry = picked.entries.find((candidate) => candidate.model.modelId === GPT.modelId)!;
    expect(entry.costUsd).toBeCloseTo((60_000 * 2 + 4_000 * 10) / 1_000_000, 8);
    expect(secondReviewPicker({ sources: [GPT], project: {}, forbidden: [], against: [SONNET] }).entries[0]!.costUsd).toBeUndefined();
  });

  it("with nothing eligible it suggests nothing (the preview says so)", () => {
    const none = secondReviewPicker({ sources: [OPUS, SONNET], project: {}, forbidden: [], against: [SONNET] });
    expect(none.suggested).toEqual([]);
    expect(none.entries.every((entry) => !entry.eligible)).toBe(true);
  });

  it("says what a model's track record is, from what the team agreed with in shadow", () => {
    const evidence = proof(GPT);
    expect(secondReviewTrackRecord(evidence.verdicts[0]!)).toBe("agreed with your team on 4 of 10 findings over 14 days");
    const withRecord = secondReviewPicker({ sources: [GPT], project: {}, forbidden: [], against: [SONNET], ...evidence });
    expect(withRecord.entries[0]!.trackRecord).toBe("agreed with your team on 4 of 10 findings over 14 days");
  });
});

describe("the plan: choice, default and the company's sources", () => {
  it("uses the top suggestion while nobody has chosen, records it as the default, and says so", () => {
    const plan = planned();
    expect(plan.choice).toBe("default");
    expect(plan.model).toEqual({ provider: GPT.provider, modelId: GPT.modelId });
    expect(defaultModelLine(plan.model, false)).toBe("Using default: openai/gpt-5.5 (change)");
    expect(plan.candidates.length).toBeLessThanOrEqual(2);
  });

  it("a company that chose runs exactly its primary then its backup, in that order, whatever is stronger", () => {
    const plan = planned({ companyModels: [GEMINI, NOVA] });
    expect(plan.choice).toBe("company");
    expect(keys(plan.candidates)).toEqual(keys([GEMINI, NOVA]));
  });

  it("a chosen model that stops qualifying is not swapped for another: nothing runs and it is flagged as such", () => {
    // The builder's company changed: the chosen model (Anthropic) is now the builder's company, though GPT would qualify.
    const result = planSecondReview(base({ companyModels: [SONNET] }));
    expect(result).toMatchObject({ run: false, reason: "choice-not-qualifying", skipped: [{ why: "same-company" }] });
    // Only the backup left: it is the company's own backup, so it runs; the primary is reported as left out.
    const backup = planned({ companyModels: [SONNET, GEMINI] });
    expect(keys(backup.candidates)).toEqual(keys([GEMINI]));
    expect(backup.skipped).toEqual([{ model: { provider: SONNET.provider, modelId: SONNET.modelId }, why: "same-company" }]);
    // A chosen model the company has no source for any more is the same: not swapped.
    expect(planSecondReview(base({ companyModels: [{ provider: "openrouter", modelId: "mistral/large-9" }] }))).toMatchObject({ run: false, reason: "choice-not-qualifying", skipped: [{ why: "not-routable" }] });
    // A choice that could not be read holds nothing: it never falls back to the default.
    expect(planSecondReview(base({ companyModels: [] }))).toMatchObject({ run: false, reason: "choice-not-qualifying" });
  });

  it("when the default stops qualifying the next default is used and the plan says so", () => {
    const first = planned();
    expect(first.defaultChanged).toBeUndefined();
    // GPT is no longer served: the previous default does not fit any more.
    const next = planned({ sources: [OPUS, SONNET, GEMINI, NOVA], previousDefault: { provider: GPT.provider, modelId: GPT.modelId } });
    expect(next.model.modelId).toBe(GEMINI.modelId);
    expect(next.defaultChanged).toBe(true);
    expect(defaultModelLine(next.model, true)).toBe("Using default: google/gemini-3-pro (previous no longer fits)");
    expect(planned({ previousDefault: { provider: GPT.provider, modelId: GPT.modelId } }).defaultChanged).toBeUndefined();
  });

  it("a project may narrow the company's choice to a subset and never widen it", () => {
    expect(narrowedSecondReviewModels({ company: [GPT, GEMINI], project: [GEMINI] }).models).toEqual([GEMINI]);
    expect(narrowedSecondReviewModels({ company: [GPT, GEMINI], project: [GEMINI, GPT] }).models).toEqual([GPT, GEMINI]);
    // A model the company did not name is dropped; naming only such models leaves nothing (never the company's whole list).
    expect(narrowedSecondReviewModels({ company: [GPT], project: [GPT, NOVA] }).models).toEqual([GPT]);
    expect(narrowedSecondReviewModels({ company: [GPT], project: [NOVA] }).models).toEqual([]);
    expect(planSecondReview(base({ companyModels: [GPT], projectModels: [NOVA] }))).toMatchObject({ run: false, reason: "choice-not-qualifying" });
    expect(keys(planned({ companyModels: [GPT, GEMINI], projectModels: [GEMINI, NOVA] }).candidates)).toEqual(keys([GEMINI]));
    // With no company choice the project's list is a subset of the default pool, not a way to name a model outside it.
    expect(keys(planned({ projectModels: [GEMINI, MYSTERY] }).candidates)).toEqual(keys([GEMINI]));
  });

  it("an OpenRouter-only company gets a second reviewer; one with no source from a different company gets 'did not run: no candidate'", () => {
    expect(planned({ against: [SONNET], sources: [SONNET, GPT, GEMINI] }).model.provider).toBe("openrouter");
    const none = planSecondReview(base({ sources: [SONNET, OPUS] }));
    expect(none).toMatchObject({ run: false, reason: "no-candidate" });
    expect(secondReviewDidNotRunLine("no-candidate")).toBe("Second review did not run: no allowed model from a different AI company could be used");
    expect(secondReviewUnavailableDecision({ mode: "on", reason: "no-candidate" })).toMatchObject({ blocks: false, showOnTaskPage: true, showOnPullRequest: true, askOwnerToAcknowledge: true });
    expect(secondReviewUnavailableDecision({ mode: "shadow", reason: "no-candidate" })).toMatchObject({ blocks: false, showOnTaskPage: false, showOnPullRequest: false, askOwnerToAcknowledge: false });
  });

  it("any source, not only Bedrock; a forbidden model and one outside the project's approved list never run", () => {
    expect(planned({ sources: [SONNET, GPT] }).model.provider).toBe("openrouter");
    expect(keys(planned({ forbidden: [GPT] }).candidates)).not.toContain(secondReviewModelKey(GPT));
    expect(keys(planned({ project: { approved: [SONNET, GEMINI] } }).candidates)).toEqual(keys([GEMINI]));
  });

  it("shadow runs at once, with no driving test; `on` needs the track record, else it runs as shadow and says so", () => {
    expect(planned({ mode: "shadow" })).toMatchObject({ mode: "shadow" });
    const unproven = planned({ mode: "on" });
    expect(unproven).toMatchObject({ mode: "shadow", downgraded: "replay-not-passed" });
    const proven = planned({ mode: "on", ...proof(GPT) });
    expect(proven).toMatchObject({ mode: "on", model: { modelId: GPT.modelId } });
    expect(proven.downgraded).toBeUndefined();
    // Evidence for another model, or for another revision, does not let this one block.
    expect(planned({ mode: "on", ...proof(GEMINI) })).toMatchObject({ mode: "on", model: { modelId: GEMINI.modelId } });
    expect(planned({ mode: "on", ...proof({ provider: GPT.provider, modelId: "openai/gpt-5.4" }) })).toMatchObject({ mode: "shadow" });
  });

  it("with the switch off or the mode off, nothing is planned", () => {
    expect(planSecondReview(base({ switchOn: false, mode: "on" }))).toEqual({ run: false, reason: "switch-off" });
    expect(planSecondReview(base({ mode: "off" }))).toEqual({ run: false, reason: "mode-off" });
    expect(configuredSecondReviewMode({})).toBe("off");
  });
});

// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// The one REVIEW end
// ------------------------------------------------------------------------------------------------------------------------------------------------------------

const review = (role: "CRITIC" | "SECURITY", operationId: string, more: Record<string, unknown> = {}) => ({
  operationId, candidateDigest: code.digest, role, provider: "first-co", version: "first-v1", status: "PASS", findings: [], readOnly: true, recordedAt: NOW, ...more,
});
const BLOCKING = { text: "off by one in the loop bound", origin: "INTRODUCED" as const };
const second = (operationId: string, status: WorkflowReviewReport["status"], findings: WorkflowReviewReport["findings"] = [], over: Partial<WorkflowReviewReport> = {}): WorkflowReviewReport => ({
  operationId, candidateDigest: code.digest, role: "CRITIC", provider: GPT.provider, version: GPT.modelId, status, findings, readOnly: true, recordedAt: NOW, ...over,
});
function workflow(extra: Record<string, unknown> = {}): WorkflowSnapshot {
  return WorkflowSnapshotSchema.parse({
    ...createWorkflowSnapshot({ taskId, ownerId, now: NOW, definitionVersion: "1.1.0" }),
    stage: "REVIEW", state: "RUNNING", candidate: code,
    checkPolicy: { required: [{ id: "unit", label: "Unit", command: { cwd: "repo/payments", executable: "npm", args: ["test"], timeoutSeconds: 30 } }], optional: [], selectedOptionalIds: [], proposed: [] },
    verification: { candidateDigest: code.digest, producer: "agentx-broker", environmentId: "ci", recordedAt: NOW, results: [{ checkId: "unit", status: "PASS" }] },
    ...extra,
  });
}
const operationPlan = (mode: "shadow" | "on", over: Partial<SecondReviewOperationPlan> = {}): SecondReviewOperationPlan => {
  const plan = planned({ mode, ...(mode === "on" ? proof(GPT) : {}) });
  return { candidateDigest: code.digest, plan: { mode: plan.mode, company: plan.company, model: plan.model, candidates: plan.candidates, against: plan.against, choice: plan.choice }, ...over };
};

let before: string | undefined;
beforeEach(() => { before = process.env.SECOND_REVIEW_ENABLED; process.env.SECOND_REVIEW_ENABLED = "1"; });
afterEach(() => { if (before === undefined) delete process.env.SECOND_REVIEW_ENABLED; else process.env.SECOND_REVIEW_ENABLED = before; });

async function end(input: { operationId?: string; plan?: SecondReviewOperationPlan | undefined; first: [string, string]; secondResult?: unknown; hasKey?: boolean; status?: string; taskExtra?: Record<string, unknown>; dispatch?: boolean }) {
  const db = new FakeDynamoDb();
  const operationId = input.operationId ?? randomUUID();
  const w = workflow();
  db.set({ ...taskKey(taskId), taskId, workflow: w, ...(input.taskExtra ?? {}) });
  const dependencies = { documentClient: db, tableName: "state" } as unknown as AwsBrokerDependencies;
  const operation = { id: operationId, kind: "task", workflowMode: "REVIEW", ...(input.plan === undefined ? {} : { secondReviewPlan: input.plan }) };
  const result: Record<string, unknown> = {
    workflowCandidateRepositories: code.repositories,
    workflowReviews: [review("CRITIC", operationId, { status: input.first[0], findings: input.first[0] === "FINDINGS" ? [{ text: "first reviewer: missing null check", origin: "INTRODUCED" }] : [] }), review("SECURITY", operationId, { status: input.first[1] })],
  };
  if (input.hasKey !== false && input.secondResult !== undefined) result[SECOND_REVIEW_RESULT_KEY] = typeof input.secondResult === "function" ? (input.secondResult as (id: string) => unknown)(operationId) : input.secondResult;
  const items = await completedWorkflowItems(dependencies, operation as never, { taskId } as never, (input.status ?? "SUCCEEDED") as never, NOW, result);
  const update = (items[0] as { Update: { UpdateExpression: string; ExpressionAttributeValues: Record<string, unknown> } }).Update;
  return {
    items, update, operationId,
    next: update.ExpressionAttributeValues[":workflow"] as WorkflowSnapshot,
    stored: update.ExpressionAttributeValues[":secondOpinion"] as { candidateDigest: string; opinion: SecondOpinion } | undefined,
    publishes: items.some((item) => JSON.stringify(item).includes("PUBLISH")),
  };
}
const answer = (status: WorkflowReviewReport["status"], findings: WorkflowReviewReport["findings"] = []) => (id: string) => ({ tries: 1, report: second(id, status, findings) });

describe("key rule 1: a second review never clears or fails a first review", () => {
  it("a second-review PASS never clears a first-review FINDINGS", async () => {
    const out = await end({ plan: operationPlan("on"), first: ["FINDINGS", "PASS"], secondResult: answer("PASS") });
    expect(out.next).toMatchObject({ stage: "REVIEW", state: "BLOCKED", blockReason: "the code review did not pass" });
    expect(out.next.reviews!.find((entry) => entry.role === "CRITIC")!.status).toBe("FINDINGS");
    expect(out.publishes).toBe(false);
    expect(out.stored!.opinion).toMatchObject({ unavailable: false, blocked: false, mode: "on" });
  });

  it("the second report is not among the workflow's reviews, so the stage still asks for exactly the two", async () => {
    const out = await end({ plan: operationPlan("on"), first: ["PASS", "PASS"], secondResult: answer("PASS") });
    expect(out.next.reviews!.map((entry) => entry.role).sort()).toEqual(["CRITIC", "SECURITY"]);
    expect(out.next.reviews!.every((entry) => entry.version === "first-v1")).toBe(true);
    expect(out.next).toMatchObject({ stage: "PULL_REQUEST", state: "READY" });
  });
});

describe("key rule 2: shadow never blocks, never delays and never reaches the pull request", () => {
  it("a shadow opinion with blocking findings leaves the passing review passing, with the pull request due", async () => {
    const out = await end({ plan: operationPlan("shadow"), first: ["PASS", "PASS"], secondResult: answer("FINDINGS", [BLOCKING]) });
    expect(out.next).toMatchObject({ stage: "PULL_REQUEST", state: "READY" });
    expect(out.publishes).toBe(true);
    expect(out.stored!.opinion).toMatchObject({ mode: "shadow", blocked: false, wouldHaveBlocked: true });
    // The pull request carries nothing of a shadow opinion (and the task page says "not blocking").
    const task = { secondOpinion: out.stored };
    expect(sendBackProblems(out.next)).toEqual([]);
    expect(secondReviewTaskView(task, code.digest)!.lines[0]).toContain("Second opinion (not blocking)");
  });

  it("a shadow review that could not run is silent and changes nothing", async () => {
    const out = await end({ plan: { candidateDigest: code.digest, notRun: { mode: "shadow", reason: "no-candidate" } }, first: ["PASS", "PASS"] });
    expect(out.next).toMatchObject({ stage: "PULL_REQUEST", state: "READY" });
    expect(secondReviewTaskView({ secondOpinion: out.stored }, code.digest)).toBeUndefined();
  });
});

describe("key rule 3: `on` and blocked sends back, within the same cap", () => {
  it("blocks the passing review with the second review's reason, in the SAME single Update, and starts no publication", async () => {
    const out = await end({ plan: operationPlan("on"), first: ["PASS", "PASS"], secondResult: answer("FINDINGS", [BLOCKING]) });
    expect(out.update.ExpressionAttributeValues[":workflow"]).toBeDefined();
    expect(out.update.ExpressionAttributeValues[":secondOpinion"]).toBeDefined();
    expect(out.update.UpdateExpression).toMatch(/workflow = :workflow/u);
    expect(out.update.UpdateExpression).toMatch(/secondOpinion = :secondOpinion/u);
    expect(out.items.filter((item) => "Update" in item && (item as { Update: { Key: unknown } }).Update.Key !== undefined && JSON.stringify((item as { Update: { Key: unknown } }).Update.Key) === JSON.stringify(taskKey(taskId)))).toHaveLength(1);
    expect(out.next).toMatchObject({ stage: "REVIEW", state: "BLOCKED", blockReason: SECOND_REVIEW_BLOCK_REASON });
    expect(out.next.reviews!.every((entry) => entry.status === "PASS")).toBe(true);
    expect(out.publishes).toBe(false);
    expect(out.stored!.opinion).toMatchObject({ mode: "on", blocked: true, blockingCount: 1 });
  });

  it("is a code failure Rovara sends back, offered to the owner too, and the fixer is told the second review's findings", async () => {
    const out = await end({ plan: operationPlan("on"), first: ["PASS", "PASS"], secondResult: answer("FINDINGS", [BLOCKING]) });
    expect(workflowSendBackOffered(out.next)).toBe(true);
    expect(classifyBlockedWorkflow(out.next)).toEqual([{ class: "code", code: "review-findings" }]);
    const problems = sendBackProblems(out.next).filter((problem) => problem.text.startsWith("second review:"));
    expect(problems).toEqual([{ source: "code review", text: `second review: ${BLOCKING.text}` }]);
  });

  it("owner-accepted findings are filtered: the opinion does not block on them and the fixer is not told them", async () => {
    const fingerprint = (await import("@agentx/contracts")).workflowFindingFingerprint("CRITIC", { text: BLOCKING.text });
    const accepted = [{ candidateDigest: code.digest, role: "CRITIC", fingerprint, text: BLOCKING.text, reason: "ok", actorId: ownerId, at: NOW }];
    const db = new FakeDynamoDb();
    const operationId = randomUUID();
    db.set({ ...taskKey(taskId), taskId, workflow: workflow({ acceptedFindings: accepted }) });
    const items = await completedWorkflowItems({ documentClient: db, tableName: "state" } as unknown as AwsBrokerDependencies,
      { id: operationId, kind: "task", workflowMode: "REVIEW", secondReviewPlan: operationPlan("on") } as never, { taskId } as never, "SUCCEEDED", NOW,
      { workflowCandidateRepositories: code.repositories, workflowReviews: [review("CRITIC", operationId), review("SECURITY", operationId)], [SECOND_REVIEW_RESULT_KEY]: answer("FINDINGS", [BLOCKING])(operationId) });
    const update = (items[0] as { Update: { ExpressionAttributeValues: Record<string, unknown> } }).Update;
    expect((update.ExpressionAttributeValues[":workflow"] as WorkflowSnapshot)).toMatchObject({ stage: "PULL_REQUEST", state: "READY" });
    expect((update.ExpressionAttributeValues[":secondOpinion"] as { opinion: SecondOpinion }).opinion).toMatchObject({ blocked: false, wouldHaveBlocked: false });
  });

  it("counts in the same two-round limit as the first review's findings", async () => {
    const out = await end({ plan: operationPlan("on"), first: ["PASS", "PASS"], secondResult: answer("FINDINGS", [BLOCKING]) });
    const spend = { spentUsd: 0, roundEstimateUsd: 1, capUsd: 100 } as never;
    const once = returnWorkflowToImplementationAutomatically(out.next, { expectedRevision: out.next.revision, reason: "second review found problems", spend, now: NOW });
    expect(once.stage).toBe("IMPLEMENT");
    expect(once.decisions.filter((decision) => decision.source === "AUTO_FIX")).toHaveLength(1);
    // The same limit as the first review's findings: two automatic sends back, the third is refused.
    const again = (snapshot: WorkflowSnapshot) => WorkflowSnapshotSchema.parse({ ...snapshot, stage: "REVIEW", state: "BLOCKED", blockReason: SECOND_REVIEW_BLOCK_REASON, candidate: code, revision: snapshot.revision + 1 });
    const twice = returnWorkflowToImplementationAutomatically(again(once), { expectedRevision: again(once).revision, reason: "second review again", spend, now: NOW });
    expect(twice.decisions.filter((decision) => decision.source === "AUTO_FIX")).toHaveLength(WORKFLOW_AUTO_SEND_BACK_LIMIT);
    const third = again(twice);
    expect(() => returnWorkflowToImplementationAutomatically(third, { expectedRevision: third.revision, reason: "and again", spend, now: NOW })).toThrow(/limit/u);
  });
});

describe("the second review's block lives in the workflow (H1)", () => {
  const FIRST = { text: "first reviewer: missing null check", origin: "INTRODUCED" as const };
  const resolve = (workflow: WorkflowSnapshot, resolutions: Array<{ findingId: string; action: "ACCEPT" | "FIX"; note: string }>) =>
    resolveWorkflowReviewFindings(workflow, { requestId: randomUUID(), expectedRevision: workflow.revision, candidateDigest: code.digest, resolutions }, { actorId: ownerId }, { now: NOW });
  const accept = (ids: string[]) => ids.map((findingId) => ({ findingId, action: "ACCEPT" as const, note: "known and fine" }));

  it("is set by the REVIEW end, with the findings, and a passing first review does not hide it", async () => {
    const out = await end({ plan: operationPlan("on"), first: ["PASS", "PASS"], secondResult: answer("FINDINGS", [BLOCKING]) });
    expect(out.next.secondReviewBlock).toEqual({ candidateDigest: code.digest, findings: [{ text: BLOCKING.text }] });
    expect(openReviewFindings(out.next)).toEqual([expect.objectContaining({ role: "CRITIC", text: `second review: ${BLOCKING.text}` })]);
    // A new review that does not block clears it again.
    const db = new FakeDynamoDb();
    const operationId = randomUUID();
    // Retry reviews starts from the code with its earlier reviews cleared.
    const { blockReason: _reason, reviews: _reviews, ...running } = out.next;
    void _reason; void _reviews;
    db.set({ ...taskKey(taskId), taskId, workflow: WorkflowSnapshotSchema.parse({ ...running, state: "RUNNING" }) });
    const items = await completedWorkflowItems({ documentClient: db, tableName: "state" } as unknown as AwsBrokerDependencies, { id: operationId, kind: "task", workflowMode: "REVIEW", secondReviewPlan: operationPlan("on") } as never, { taskId } as never, "SUCCEEDED", NOW,
      { workflowCandidateRepositories: code.repositories, workflowReviews: [review("CRITIC", operationId), review("SECURITY", operationId)], [SECOND_REVIEW_RESULT_KEY]: answer("PASS")(operationId) });
    const after = (items[0] as { Update: { ExpressionAttributeValues: Record<string, unknown> } }).Update.ExpressionAttributeValues[":workflow"] as WorkflowSnapshot;
    expect({ stage: after.stage, state: after.state, reason: after.blockReason }).toEqual({ stage: "PULL_REQUEST", state: "READY", reason: undefined });
    expect(after.secondReviewBlock).toBeUndefined();
  });

  it("accepting the first review's findings does not clear a second-review block: every blocking finding must be answered, and the change cannot become ready with one open", async () => {
    const out = await end({ plan: operationPlan("on"), first: ["FINDINGS", "PASS"], secondResult: answer("FINDINGS", [BLOCKING]) });
    expect(out.next).toMatchObject({ stage: "REVIEW", state: "BLOCKED", blockReason: "the code review did not pass" });
    const open = openReviewFindings(out.next);
    expect(open.map((finding) => finding.text).sort()).toEqual([FIRST.text, `second review: ${BLOCKING.text}`].sort());
    const firstId = open.find((finding) => finding.text === FIRST.text)!.findingId;
    expect(() => resolve(out.next, accept([firstId]))).toThrow(/choose what to do with every blocking finding/u);
    // Even with the first review's findings accepted already, the second review's block holds the change at REVIEW, with the second review's reason.
    const firstAccepted = WorkflowSnapshotSchema.parse({ ...out.next, acceptedFindings: [{ candidateDigest: code.digest, role: "CRITIC", fingerprint: firstId, text: FIRST.text, reason: "ok", actorId: ownerId, at: NOW }] });
    const stillOpen = openReviewFindings(firstAccepted);
    expect(stillOpen.map((finding) => finding.text)).toEqual([`second review: ${BLOCKING.text}`]);
    expect(() => WorkflowSnapshotSchema.parse({ ...firstAccepted, stage: "PULL_REQUEST", state: "READY", blockReason: undefined })).toThrow();
  });

  it("the owner accepts the second review's finding the way a first review's is accepted, and only then is the change ready; sending it back lists it for the coder", async () => {
    const out = await end({ plan: operationPlan("on"), first: ["PASS", "PASS"], secondResult: answer("FINDINGS", [BLOCKING]) });
    const [finding] = openReviewFindings(out.next);
    const fixed = resolve(out.next, [{ findingId: finding!.findingId, action: "FIX", note: "please fix" }]);
    expect(fixed.stage).toBe("IMPLEMENT");
    expect(sendBackProblems(fixed).map((problem) => problem.text)).toContain(`second review: ${BLOCKING.text}`);
    const accepted = resolve(out.next, accept([finding!.findingId]));
    expect(accepted).toMatchObject({ stage: "PULL_REQUEST", state: "READY" });
    expect(accepted.secondReviewBlock).toBeUndefined();
    expect(accepted.acceptedFindings).toEqual([expect.objectContaining({ role: "CRITIC", fingerprint: finding!.findingId })]);
    // The same finding is not blocking any more, anywhere.
    expect(sendBackProblems(accepted)).toEqual([]);
    expect(openReviewFindings(accepted)).toEqual([]);
  });

  it("with the first review passed and one of two second-review findings accepted, the change stays blocked with the second review's reason", async () => {
    const two = [BLOCKING, { text: "second problem", origin: "INTRODUCED" as const }];
    const out = await end({ plan: operationPlan("on"), first: ["PASS", "PASS"], secondResult: answer("FINDINGS", two) });
    const ids = openReviewFindings(out.next).map((finding) => finding.findingId);
    expect(ids).toHaveLength(2);
    expect(() => resolve(out.next, accept([ids[0]!]))).toThrow(/every blocking finding/u);
  });
});

describe("key rule 4: unavailable is flagged and never blocks", () => {
  const unavailable = async (secondResult: unknown, hasKey = true, status = "SUCCEEDED", mode: "shadow" | "on" = "on") =>
    end({ plan: operationPlan(mode), first: ["PASS", "PASS"], secondResult, hasKey, status });

  it("no answer after the tries: the review passes, the opinion says it did not run, and the owner is asked to acknowledge", async () => {
    const out = await unavailable((id: string) => ({ tries: 3, report: second(id, "UNKNOWN", [], { failureReason: "SESSION_FAILED" }) }));
    expect(out.next).toMatchObject({ stage: "PULL_REQUEST", state: "READY" });
    expect(out.stored!.opinion).toMatchObject({ unavailable: true, unavailableReason: "no-answer", blocked: false });
    const view = secondReviewTaskView({ secondOpinion: out.stored }, code.digest)!;
    expect(view).toEqual({ lines: ["Second review did not run: the reviewer gave no usable answer after retrying"], needsAcknowledgement: true, acknowledged: false });
  });

  it("the injected-diff attack (every try fails, even a result with no report at all) is flagged, never blocks", async () => {
    for (const result of [{ tries: 3 }, { tries: 3, report: undefined }, "garbage", null]) {
      const out = await unavailable(result);
      expect(out.next, JSON.stringify(result)).toMatchObject({ stage: "PULL_REQUEST", state: "READY" });
      expect(out.stored!.opinion).toMatchObject({ unavailable: true, unavailableReason: "no-answer", blocked: false });
    }
  });

  it("an older worker (a succeeded review whose result has no second-review key) is flagged 'older worker', never blocks, and is silent in shadow", async () => {
    const onOut = await unavailable(undefined, false);
    expect(onOut.next).toMatchObject({ stage: "PULL_REQUEST", state: "READY" });
    expect(onOut.stored!.opinion).toMatchObject({ unavailable: true, unavailableReason: "older-worker" });
    expect(secondReviewTaskView({ secondOpinion: onOut.stored }, code.digest)!.lines).toEqual(["Second review did not run: the worker that ran the review is not updated for it"]);
    const shadowOut = await unavailable(undefined, false, "SUCCEEDED", "shadow");
    expect(secondReviewTaskView({ secondOpinion: shadowOut.stored }, code.digest)).toBeUndefined();
  });

  it("no candidate, a chosen model that no longer qualifies, and no budget are recorded at the start and flagged the same way", async () => {
    for (const reason of ["no-candidate", "choice-not-qualifying", "budget"] as const) {
      const out = await end({ plan: { candidateDigest: code.digest, notRun: { mode: "on", reason } }, first: ["PASS", "PASS"] });
      expect(out.next).toMatchObject({ stage: "PULL_REQUEST", state: "READY" });
      expect(out.stored!.opinion).toMatchObject({ unavailable: true, unavailableReason: reason, blocked: false, mode: "on" });
      expect(secondReviewTaskView({ secondOpinion: out.stored }, code.digest)!.needsAcknowledgement).toBe(true);
    }
  });

  it("a report from another model, another candidate, another role or the builder's company is not accepted, and nothing blocks", async () => {
    const cases: Array<[Partial<WorkflowReviewReport>, string]> = [
      [{ version: "openai/gpt-4" }, "wrong-model"], [{ candidateDigest: "c".repeat(64) }, "wrong-candidate"], [{ role: "SECURITY" }, "wrong-role"],
    ];
    for (const [over, reason] of cases) {
      const out = await unavailable((id: string) => ({ tries: 1, report: second(id, "FINDINGS", [BLOCKING], over) }));
      expect(out.next, reason).toMatchObject({ stage: "PULL_REQUEST", state: "READY" });
      expect(out.stored!.opinion, reason).toMatchObject({ unavailable: true, unavailableReason: reason, blocked: false });
    }
    // A report from another operation is not this review's.
    const other = await unavailable({ tries: 1, report: second(randomUUID(), "FINDINGS", [BLOCKING]) });
    expect(other.stored!.opinion).toMatchObject({ unavailable: true, unavailableReason: "no-answer" });
  });

  it("a routed model's report names its route alias; it is accepted by that alias and shown as the planned model", () => {
    const plan = operationPlan("on", { routeAliases: { [secondReviewModelKey(GPT)]: "org-route-1" } });
    const id = randomUUID();
    const result = (version: string) => ({ [SECOND_REVIEW_RESULT_KEY]: { tries: 1, report: second(id, "PASS", [], { provider: "rovara-route", version }) } });
    const stored = secondOpinionFromReviewResult({ recorded: plan, operationId: id, terminalStatus: "SUCCEEDED", result: result("org-route-1"), currentCandidateDigest: code.digest, now: NOW });
    expect(stored!.opinion).toMatchObject({ unavailable: false, report: { provider: GPT.provider, version: GPT.modelId } });
    const wrong = secondOpinionFromReviewResult({ recorded: plan, operationId: id, terminalStatus: "SUCCEEDED", result: result("org-route-2"), currentCandidateDigest: code.digest, now: NOW });
    expect(wrong!.opinion).toMatchObject({ unavailable: true, unavailableReason: "wrong-model" });
  });

  it("names the model that reviewed and why", async () => {
    const out = await end({ plan: operationPlan("shadow"), first: ["PASS", "PASS"], secondResult: answer("FINDINGS", [BLOCKING]) });
    const view = secondReviewTaskView({ secondOpinion: out.stored }, code.digest)!;
    expect(view.lines.at(-1)).toBe("Using default: openai/gpt-5.5 (change)");
    const chosen = await end({ plan: operationPlan("shadow", { plan: { ...operationPlan("shadow").plan!, choice: "company" } }), first: ["PASS", "PASS"], secondResult: answer("PASS") });
    expect(secondReviewTaskView({ secondOpinion: chosen.stored }, code.digest) ?? { lines: [] }).toBeDefined();
    expect(chosen.stored!.opinion.choice).toBe("company");
  });
});

describe("key rule 5: stop, crash and close need no new path (one operation, one transition)", () => {
  it("an owner stop, a lost run and a stale sweep end the REVIEW operation as they always did: the same single transition, no opinion written, nothing pending", async () => {
    for (const status of ["CANCELLED", "FAILED", "INTERRUPTED"]) {
      const withPlan = await end({ plan: operationPlan("on"), first: ["PASS", "PASS"], secondResult: answer("FINDINGS", [BLOCKING]), status });
      const without = await end({ plan: undefined, first: ["PASS", "PASS"], status });
      expect(withPlan.next, status).toEqual(without.next);
      expect(withPlan.next.state, status).toBe("BLOCKED");
      expect(withPlan.items, status).toHaveLength(without.items.length);
      expect(withPlan.stored, status).toBeUndefined();
      expect(withPlan.update.UpdateExpression, status).toBe(without.update.UpdateExpression);
    }
  });

  it("there is no second operation, hold or dispatch kind: a planned review is one operation and its end is one Update on the task", async () => {
    const out = await end({ plan: operationPlan("on"), first: ["PASS", "PASS"], secondResult: answer("PASS") });
    const taskUpdates = out.items.filter((item) => "Update" in item);
    expect(taskUpdates).toHaveLength(1);
    expect(JSON.stringify(out.items)).not.toMatch(/SECOND_REVIEW|secondReviewPending/u);
  });
});

describe("key rule 5, by construction: nothing but the dispatch, the one REVIEW end and the key scope knows of a second review's plan", () => {
  it("no stop, cancel, close, stale-operation or recovery code reads the plan or the result key", () => {
    const walk = (directory: string): string[] => readdirSync(directory).flatMap((name) => {
      const path = join(directory, name);
      return statSync(path).isDirectory() ? (name === "node_modules" || name === "dist" ? [] : walk(path)) : /\.ts$/u.test(name) ? [path] : [];
    });
    const users = walk("packages/broker/src").filter((path) => /secondReviewPlan|workflowSecondReview\b|SECOND_REVIEW_RESULT_KEY/u.test(readFileSync(path, "utf8"))).map((path) => path.replace("packages/broker/src/", "")).sort();
    expect(users).toEqual([
      "aws/broker/model-access.ts", "aws/broker/task-operations.ts", "aws/cancellation.ts", "aws/broker/workflow-items.ts", "rovara-code/second-review-store.ts",
    ].sort());
  });
});

describe("key rule 6: with cr off, today's flow exactly", () => {
  it("the REVIEW end writes nothing about a second review, whatever the operation or the task holds", async () => {
    delete process.env.SECOND_REVIEW_ENABLED;
    const operationId = randomUUID();
    const withPlan = await end({ operationId, plan: operationPlan("on"), first: ["PASS", "PASS"], secondResult: answer("FINDINGS", [BLOCKING]) });
    const plain = await end({ operationId, plan: undefined, first: ["PASS", "PASS"] });
    expect(withPlan.next).toEqual(plain.next);
    expect(withPlan.update.UpdateExpression).toBe(plain.update.UpdateExpression);
    expect(Object.keys(withPlan.update.ExpressionAttributeValues)).toEqual(Object.keys(plain.update.ExpressionAttributeValues));
    expect(JSON.stringify(withPlan.update)).not.toMatch(/secondOpinion/u);
    const stale = await end({ plan: undefined, first: ["PASS", "PASS"], taskExtra: { secondOpinion: { candidateDigest: code.digest, opinion: secondOpinionUnavailable({ mode: "on" }, "no-answer"), recordedAt: NOW } } });
    expect(JSON.stringify(stale.update)).not.toMatch(/secondOpinion/u);
    expect(secondReviewTaskView({ secondOpinion: stale.stored }, code.digest)).toBeUndefined();
  });

  it("the dispatch carries no second reviewer and records no plan (the start returns nothing before it reads a thing)", async () => {
    delete process.env.SECOND_REVIEW_ENABLED;
    const poisoned = new Proxy({}, { get() { throw new Error("touched the dependencies"); } }) as unknown as AwsBrokerDependencies;
    const task = { workflow: workflow(), taskId } as never;
    expect(await prepareSecondReview({ dependencies: poisoned, orgId: "org", project: "p", workspaceId: "w", conversationId: "c", task, workflowMode: "REVIEW", agentRun: undefined, workflowReviewers: undefined, firstReviewerModel: OPUS, approved: undefined, routing: undefined })).toEqual({});
  });

  it("with cr on, a review step that is not a version 2 code review still gets none", async () => {
    const poisoned = new Proxy({}, { get() { throw new Error("touched the dependencies"); } }) as unknown as AwsBrokerDependencies;
    const task = { workflow: workflow(), taskId } as never;
    for (const over of [{ workflowMode: "IMPLEMENT" }, { workflowReviewers: ["SECURITY" as const] }, { agentRun: {} }]) {
      expect(await prepareSecondReview({ dependencies: poisoned, orgId: "org", project: "p", workspaceId: "w", conversationId: "c", task, workflowMode: "REVIEW", agentRun: undefined, workflowReviewers: undefined, firstReviewerModel: OPUS, approved: undefined, routing: undefined, ...over })).toEqual({});
    }
  });
});

// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// The start, with the stores behind it
// ------------------------------------------------------------------------------------------------------------------------------------------------------------

describe("the start, with a database behind it", () => {
  const ORG = "org_aaaaaaaaaaaaaaaaaaaa";
  const GPT_ID: ModelIdentifier = { provider: "openai", modelId: "gpt-5.5" };
  function world(settings: Record<string, unknown>, options: { failOperations?: boolean; opinion?: unknown } = {}) {
    const db = new FakeDynamoDb();
    db.set({ ...orgMetaKey(ORG), pk: orgMetaKey(ORG).pk, sk: "SECONDREVIEW#SETTINGS", entityType: "SECOND_REVIEW_SETTINGS", ...settings });
    db.set({ pk: "WORKSPACE#w", sk: "OPERATION#b1", entityType: "OPERATION", kind: "task", conversationId: "c", workflowMode: "IMPLEMENT", status: "SUCCEEDED", model: GPT_ID });
    const client = options.failOperations !== true ? db : { send: async (command: { input?: { ExpressionAttributeValues?: Record<string, unknown> } }) => {
      if (command.input?.ExpressionAttributeValues?.[":prefix"] === "OPERATION#") throw new Error("the table is not answering");
      return db.send(command as never);
    } };
    const task = { taskId, workflow: workflow(), developerId: ownerId, ...(options.opinion === undefined ? {} : { secondOpinion: options.opinion }) } as never;
    return { dependencies: { documentClient: client, tableName: "state" } as unknown as AwsBrokerDependencies, task };
  }
  const start = (w: ReturnType<typeof world>, over: Record<string, unknown> = {}) => prepareSecondReview({ dependencies: w.dependencies, orgId: ORG, project: "web", workspaceId: "w", conversationId: "c", task: w.task, workflowMode: "REVIEW",
    agentRun: undefined, workflowReviewers: undefined, firstReviewerModel: GPT_ID, approved: undefined, routing: {}, ...over });

  it("plans a second reviewer from the company's own models and records it on the operation", async () => {
    const out = await start(world({ default: "shadow" }));
    expect(out.field!.candidates.length).toBeGreaterThan(0);
    expect(out.field!.candidates[0]!.model.provider).toBe("amazon-bedrock");
    expect(out.record).toMatchObject({ candidateDigest: code.digest, plan: { mode: "shadow", choice: "default" } });
  });

  it("M2: an error while planning never fails the dispatch: `on` flags it, shadow stays silent", async () => {
    const on = await start(world({ default: "on" }, { failOperations: true }));
    expect(on).toEqual({ record: { candidateDigest: code.digest, notRun: { mode: "on", reason: "no-candidate" } } });
    expect(await start(world({ default: "shadow" }, { failOperations: true }))).toEqual({});
    // A settings read that fails runs nothing at all.
    const broken = world({ default: "on" });
    (broken.dependencies as unknown as { documentClient: unknown }).documentClient = { send: async () => { throw new Error("down"); } };
    expect(await start(broken)).toEqual({});
  });

  it("L7: by default the payload has no context (the second reviewer sees only the change); same_as_first says so on the wire; cr off is unchanged", async () => {
    const byDefault = await start(world({ default: "shadow" }));
    expect(byDefault.field).not.toHaveProperty("context");
    expect(byDefault.field).toEqual({ candidates: expect.any(Array) as unknown[] });
    const shared = await start(world({ default: "shadow", context: "same_as_first" }));
    expect(shared.field).toMatchObject({ context: "same_as_first" });
    // A stored value that is not one of the two words reads as the narrower.
    expect((await start(world({ default: "shadow", context: "everything" }))).field).not.toHaveProperty("context");
    delete process.env.SECOND_REVIEW_ENABLED;
    expect(await start(world({ default: "on", context: "same_as_first" }))).toEqual({});
  });

  it("L3: the default the task used last time is taken from an opinion that ANSWERED, not from a failed one", async () => {
    const failed = secondOpinionUnavailable({ mode: "shadow", company: "openai", choice: "default" }, "no-answer", second(randomUUID(), "UNKNOWN", [], { provider: "openrouter", version: "x/some-other-model" }));
        const stored = (opinion: SecondOpinion) => ({ candidateDigest: code.digest, opinion, recordedAt: NOW });
    expect((await start(world({ default: "shadow" }, { opinion: stored(failed) }))).record!.plan!.defaultChanged).toBeUndefined();
    // The answered one names a model no longer served: the default moved on, and the plan says so.
    const gone = secondOpinionOf({ plan: planned(), report: second(randomUUID(), "PASS", [], { provider: "openrouter", version: "openai/gpt-5.5" }), currentCandidateDigest: code.digest });
    expect(gone).toMatchObject({ unavailable: false });
    expect((await start(world({ default: "shadow" }, { opinion: stored(gone) }))).record!.plan!.defaultChanged).toBe(true);
  });
});

describe("L2: a routed model's report must also come from the route provider", () => {
  it("an alias on another provider is not the route", () => {
    const plan = planned();
    const aliases = { [secondReviewModelKey(plan.model)]: "org-route-1" };
    const check = (provider: string) => acceptSecondReport({ plan, report: second(randomUUID(), "PASS", [], { provider, version: "org-route-1" }), currentCandidateDigest: code.digest, routeAliases: aliases });
    expect(check("rovara-route")).toEqual({ accepted: true });
    expect(check("openai")).toEqual({ accepted: false, reason: "wrong-model" });
  });
});

describe("M3: the usage event stays the telemetry the activity index reads", () => {
  it("is exactly the telemetry shape for the second reviewer's tries too, which are told apart by their artifact names", () => {
    const usage = createTaskUsageTelemetry({ tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, total: 15 }, cost: 0.01 }, { provider: "openrouter", modelId: "openai/gpt-5.5" }, "SUCCEEDED");
    expect(TaskUsageTelemetrySchema.safeParse(usage).success).toBe(true);
    expect(reviewUsageArtifactName("CRITIC", undefined)).toBe("workflow-review-critic-usage.json");
    expect(reviewUsageArtifactName("CRITIC", 2)).toBe("workflow-second-review-2-usage.json");
  });
});

describe("H2: the merge waits for the owner's acknowledgement", () => {
  const flagged = secondOpinionUnavailable({ mode: "on", company: "openai" }, "no-answer");
  const task = (over: Record<string, unknown> = {}) => ({ secondOpinion: { candidateDigest: code.digest, opinion: flagged, recordedAt: NOW }, workflow: { candidate: { digest: code.digest } }, ...over });

  it("says why, only for an `on` review that did not run, for this code, until acknowledged; cr off waits for nothing", () => {
    expect(secondReviewMergeWait(task())).toMatch(/^Second review did not run: the reviewer gave no usable answer after retrying\. The task owner has to acknowledge it on the task page/u);
    const ack = secondReviewAcknowledgement(flagged, code.digest);
    if (!ack.required) throw new Error("expected an ask");
    expect(secondReviewMergeWait(task({ secondReviewAcknowledged: [ack.key] }))).toBeUndefined();
    expect(secondReviewMergeWait(task({ secondReviewAcknowledged: ["0".repeat(64)] }))).toBeDefined();
    expect(secondReviewMergeWait(task({ secondOpinion: { candidateDigest: code.digest, opinion: secondOpinionUnavailable({ mode: "shadow", company: "openai" }, "no-answer"), recordedAt: NOW } }))).toBeUndefined();
    expect(secondReviewMergeWait(task({ workflow: { candidate: { digest: "d".repeat(64) } } }))).toBeUndefined();
    expect(secondReviewMergeWait({ workflow: { candidate: { digest: code.digest } } })).toBeUndefined();
    delete process.env.SECOND_REVIEW_ENABLED;
    expect(secondReviewMergeWait(task())).toBeUndefined();
  });
});

describe("L1: the model that is named is the model that answers (no router fallbacks)", () => {
  it("Rovara's own proxy config writes no router fallbacks, so a failing second-review alias is never answered by another model", () => {
    const config = litellmConfig({ region: "us-east-1", models: [{ id: "us.anthropic.claude-sonnet-4-6" }] });
    expect(config).not.toMatch(/fallbacks|router_settings/u);
    expect(config).toContain("model_list:");
  });
  // DEFERRED CHECK (SR-1 L1): the broker cannot read a company source's router config at mint time, so for company sources "no router fallbacks on the alias" is checked by hand at setup (listed in the report).
});
