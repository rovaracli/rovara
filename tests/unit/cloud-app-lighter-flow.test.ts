// S3-9 (DEFERRED S3-LIGHTER-FLOW-REVIEWER): the lighter flow on a CORE task, through the Cloud root. A real core task is driven through the rig (Cloud's runtime, the real task flow, Cloud's merge-tracking
// job and Code's merge gate) with the reviewer ports given as fakes: a small change skips its planning steps and is cleared by the reviewer's questions; a change that grew gets the grown tier's reviews;
// a provider that is down or a payer whose budget is used up leaves the change "couldn't check", with no call made and no merge.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { UNDERSTAND_ARTIFACT_NAME, createCandidateManifest, type Payer, type WorkflowSnapshot } from "@rovara-code/contracts";
import { createCallbackService } from "@rovara-code/broker";
import { tierGate } from "@rovara-code/broker/core/merge";
import { TIER_QUESTIONS } from "../../vendor/rovara-code/packages/broker/src/core/decisions/tier-reviewer.js";
import { CORE_JOBS } from "../../packages/broker/src/cloud/app/index.js";
import type { TierReviewPorts, TierReviewPurpose } from "../../packages/broker/src/cloud/app/index.js";
import { createCloudIdentityProvider } from "../../packages/broker/src/cloud/adapters/people/index.js";
import { PEOPLE_ORG } from "../support/cloud-people-world.js";
import { rig, type Rig } from "../support/cloud-core-rig.js";
import { memoryCallLedger } from "../support/tier-review-calls.js";
import { planAnswer, planDocument } from "../support/plan-documents.js";

const PAYER: Payer = { kind: "project", project: "payments" };
const SONNET = { provider: "anthropic", modelId: "claude-sonnet-4-6" };

interface Calls { meteredTasks: string[]; calls: Array<{ taskId: string; purpose: TierReviewPurpose; payer: Payer; holdUsd: number }> }

/** Fake ports: the task's payer, a company-billed route, the payer's room and the one call (a reviewer that answers every question no and finds nothing). */
function ports(calls: Calls, options: { provider?: "down"; budget?: "used_up"; questionsYes?: string[] } = {}): TierReviewPorts {
  return {
    task: async (taskId) => { calls.meteredTasks.push(taskId); return { project: "payments", payer: PAYER }; },
    route: async () => (options.provider === "down" ? undefined : { model: SONNET, alias: "org-src-sonnet", sourceId: "src_aaaaaaaaaaaaaaaaaaaa", api: "anthropic-messages" }),
    room: async () => { if (options.budget === "used_up") throw Object.assign(new Error("the month is used up"), { code: "ORG_BUDGET_EXCEEDED" }); return 10; },
    calls: memoryCallLedger(),
    call: async ({ taskId, purpose, payer, holdUsd, sent }) => {
      await sent();
      calls.calls.push({ taskId, purpose, payer, holdUsd });
      if (purpose === "questions") return JSON.stringify(TIER_QUESTIONS.map((question) => ({ id: question.id, yes: (options.questionsYes ?? []).includes(question.id), reason: (options.questionsYes ?? []).includes(question.id) ? "it touches that" : "" })));
      return JSON.stringify({ findings: [] });
    },
  };
}

/** A company with Understand first (the recipe's plan check and `rv` on: a version 1.1.0 task, whose plan is structured and so can be estimated small) and the reviewer ports. */
const lighter = (calls: Calls, options: Parameters<typeof ports>[1] = {}) => ({ tierReview: () => ports(calls, options), settingsEnv: { AGENTX_ROVARA_CODE_V2_ENABLED: "true" }, recipeStepKinds: ["plan_critic"] });

const plan = (files: readonly string[]) => planAnswer(planDocument({
  title: "A small change",
  why: [{ text: "The page should answer a health check.", author: "Dana" }],
  notChanging: ["The rest of the page stays as it is."],
  risks: ["A typo in the answer would show on the page."],
  claims: [
    ...files.map((path, index) => ({ id: String(index + 1), text: `The change to ${path} does what was asked.`, evidence: [{ kind: "code" as const, path, startLine: 1, endLine: 2, note: "Here." }] })),
    { id: String(files.length + 1), text: "A test proves it." },
  ],
  decisions: [],
}), { checks: { checks: [], none_reason: "A fixture change needs no automated checks." } });

const CHECKS = { status: "not_verified", notVerifiedReason: "no_checks", source: "none", preambleVersion: "1", preambleSha256: "a".repeat(64), checks: [], extraTry: "not_needed", agentClaim: "none" };
const candidateOf = (tree: string, base: string, commit: string) => [{ repositoryId: "demo", commitSha: commit, treeSha: tree, baseCommitSha: base }];

interface Driven { taskId: string; skipped: readonly string[]; stagesSeen: string[] }

/** Starts a core task as the owner and drives it with a fake worker through preparation, the plan, the build of `files`, the review and the pull request. */
async function drive(r: Rig, files: Record<string, string | null>, planned: readonly string[] = ["src/health.ts"]): Promise<Driven> {
  const runtime = await r.app.runtimeFor(PEOPLE_ORG);
  const owner = r.people.people.owner;
  const principal = (await createCloudIdentityProvider(r.people.routes).getPrincipal(PEOPLE_ORG, owner.developerId))!;
  const started = await runtime.flow.start({ principal, client: "app" }, { requestId: randomUUID(), project: "payments", instructions: "Add a /health endpoint in src/health.ts", workflow: true, workflowPath: "QUICK" });
  const taskId = started.task.taskId;
  const registry = await r.app.registry();
  const callbacks = createCallbackService({ flow: runtime.flow.deps, blobs: registry.require("object-storage"), grants: { exchange: async () => { throw new Error("unused"); } } });
  const model = r.world.hostModel;
  const base = model.headOf("main");
  const seen = new Set<string>();
  const stagesSeen: string[] = [];
  let built: { commit: string; tree: string } | undefined;
  for (let round = 0; round < 20; round += 1) {
    await runtime.flow.relayOnce();
    await runtime.flow.dispatchOnce({ maxMessages: 5, waitSeconds: 0 });
    await runtime.flow.sweepOnce();
    const task = await r.world.store.get({ pk: `DEVTASK#${taskId}`, sk: "META" });
    const workflow = task?.["workflow"] as unknown as WorkflowSnapshot;
    if (stagesSeen.at(-1) !== workflow.stage) stagesSeen.push(workflow.stage);
    if ((workflow.pullRequests ?? []).length > 0) return { taskId, skipped: workflow.flow?.skippedSteps ?? [], stagesSeen };
    const workspace = await r.world.store.get({ pk: `WORKSPACE#${task!["workspaceId"] as string}`, sk: "META" });
    const machineId = (workspace?.["machine"] as { machineId?: string } | undefined)?.machineId;
    const jobs = machineId === undefined ? [] : r.world.machines.delivered(machineId).filter((job) => !seen.has(job.operationId));
    for (const job of jobs) {
      seen.add(job.operationId);
      const post = async (action: string, body: unknown) => {
        const answer = await callbacks({ method: "POST", path: `/v1/internal/workspaces/${job.workspaceId}/operations/${job.operationId}/${action}`, headers: { "x-agentx-callback-capability": job.callbackCapability, "content-type": "application/json" }, body: JSON.stringify(body) });
        expect(answer.statusCode, `${action}: ${answer.body}`).toBe(200);
      };
      const mode = (job.payload as { workflowMode?: string }).workflowMode;
      const publishing = (job.payload as { headBranch?: unknown }).headBranch !== undefined;
      if (mode === undefined && !publishing) {
        await post("result", { status: "SUCCEEDED", result: { preparedBase: [{ repositoryId: "demo", baseCommitSha: base }] } });
      } else if (mode === "UNDERSTAND") {
        await post("artifacts", { name: UNDERSTAND_ARTIFACT_NAME, mediaType: "application/json", content: JSON.stringify({ kind: "ready", path: "QUICK", restatement: "Add a /health endpoint that answers 200.", assumptions: [] }) });
        await post("result", { status: "SUCCEEDED" });
      } else if (mode === "PLAN") {
        await post("artifacts", { name: "plan.md", mediaType: "text/markdown", content: plan(planned) });
        await post("result", { status: "SUCCEEDED" });
      } else if (mode === "IMPLEMENT") {
        const commit = model.commit("work", files);
        built = { commit, tree: model.revision(commit).tree };
        const candidate = candidateOf(built.tree, base, commit);
        await post("result", { status: "SUCCEEDED", result: { conversationId: "conversation", checks: CHECKS, workflowCandidateRepositories: candidate, workflowCheckCandidateRepositories: candidate } });
      } else if (mode === "REVIEW") {
        const roles = ((job.payload as { workflowReviewers?: string[] }).workflowReviewers ?? ["CRITIC", "SECURITY"]) as Array<"CRITIC" | "SECURITY">;
        const candidate = candidateOf(built!.tree, base, built!.commit);
        const candidateDigest = createCandidateManifest(candidate).digest;
        await post("result", { status: "SUCCEEDED", result: { conversationId: "conversation", workflowCandidateRepositories: candidate,
          workflowReviews: roles.map((role) => ({ operationId: job.operationId, candidateDigest, role, provider: "examplehost-model", version: "1", readOnly: true, recordedAt: new Date(r.world.clock.now).toISOString(), status: "PASS", findings: [], ...(role === "CRITIC" ? { risk: "low" } : {}) })) } });
      } else {
        const payload = job.payload as Record<string, unknown>;
        const headBranch = String(payload["headBranch"]);
        model.branches.set(headBranch, built!.commit);
        const url = "https://github.com/example/demo.git";
        await post("pull-request", { repository: "demo", repositoryUrl: url, headBranch, baseBranch: "main", commit: built!.commit, title: payload["title"], body: payload["body"] });
        const cr = model.changeRequests.find((entry) => entry.sourceBranch === headBranch)!;
        await post("result", { status: "SUCCEEDED", result: { repository: "demo", number: Number(cr.id), url: model.crUrl(cr.id), headBranch, baseBranch: "main", commit: built!.commit, checks: [], reconciled: false, draft: true } });
      }
      r.world.machines.finish(machineId!, job.operationId);
    }
  }
  const last = (await r.world.store.get({ pk: `DEVTASK#${taskId}`, sk: "META" }))?.["workflow"] as unknown as WorkflowSnapshot;
  throw new Error(`the task never published (stages: ${stagesSeen.join(" > ")}; flow ${JSON.stringify(last.flow)}; path ${last.path} v${last.definitionVersion}; ${JSON.stringify((last as unknown as {artifacts?: unknown}).artifacts ?? Object.keys(last)).slice(0, 1500)})`);
}

/** Cloud's scheduled jobs for the company as the schedules run them: the merge-tracking sweep (the broker), then the tier pass (its own function, a 14-minute budget), a few times. Answers the tier passes' reports. */
async function mergeTrackingJob(r: Rig, times = 3, tierBudgetMs = 14 * 60_000): Promise<Array<Record<string, unknown>>> {
  const runtime = await r.app.runtimeFor(PEOPLE_ORG);
  const sweep = CORE_JOBS.find((entry) => entry.name === "merge-tracking")!;
  const tier = CORE_JOBS.find((entry) => entry.name === "tier-checks")!;
  const reports: Array<Record<string, unknown>> = [];
  for (let index = 0; index < times; index += 1) {
    r.world.clock.advance(300);
    const swept = await sweep.run(runtime, 50_000);
    // H1c: the sweep no longer runs the tier pass.
    expect(swept).not.toHaveProperty("tierChecks");
    reports.push(await tier.run(runtime, tierBudgetMs));
  }
  return reports;
}

/** Code's merge gate, as the press runs it, on the pull request's current head: undefined lets the merge through, else its refusal. */
async function gate(r: Rig, taskId: string): Promise<string | undefined> {
  const store = r.world.store;
  const record = (await store.get({ pk: `DEVTASK#${taskId}`, sk: "META" }))!;
  const workflow = record["workflow"] as unknown as WorkflowSnapshot;
  const targets = (workflow.pullRequests ?? []).filter((pr) => pr.state !== "MERGED").map((pr) => {
    const cr = r.world.hostModel.changeRequests.find((entry) => entry.id === String(pr.number))!;
    return { host: r.world.host, repositoryId: pr.repositoryId, repositoryUrl: "https://github.com/example/demo.git", number: pr.number, headSha: r.world.hostModel.headRevisionOf(cr) };
  });
  const deps = { store, now: () => r.world.clock.now, host: { loadTask: async () => ({ ...(await store.get({ pk: `DEVTASK#${taskId}`, sk: "META" }))!, orgId: PEOPLE_ORG }), log: () => undefined } } as never;
  try {
    await tierGate(deps, { ...record, orgId: PEOPLE_ORG } as never, targets, { orgId: PEOPLE_ORG }, workflow.flow?.tier?.level);
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

const SMALL = { "src/health.ts": "export const health = 200;\n" };

describe("S3-9: the lighter flow on a core task, with Cloud's reviewer", () => {
  it("is OFF without the reviewer ports (as before S3-9): the core task runs the whole plan and waits at its plan review", async () => {
    const r = await rig();
    const runtime = await r.app.runtimeFor(PEOPLE_ORG);
    expect((runtime.flow.deps as { lighterFlow?: boolean }).lighterFlow).not.toBe(true);
    expect(runtime.flow.deps.tierReviewCall).toBeUndefined();
  });

  it("follows the company's switch back: LIGHTER_FLOW_ENABLED=false keeps the reviewer (owed questions) and turns the skip off", async () => {
    const calls: Calls = { meteredTasks: [], calls: [] };
    const r = await rig({ tierReview: () => ports(calls), settingsEnv: { LIGHTER_FLOW_ENABLED: "false" } });
    const runtime = await r.app.runtimeFor(PEOPLE_ORG);
    expect(runtime.flow.deps.lighterFlow).toBe(false);
    expect(runtime.flow.deps.tierReviewCall).toBeTypeOf("function");
    expect(runtime.flow.deps.tierReviewMeter).toBeTypeOf("function");
  });

  it("a small change skips its planning steps; Cloud's merge-tracking job asks the reviewer through the metered call, charged to the task's payer, and the merge gate lets it through", async () => {
    const calls: Calls = { meteredTasks: [], calls: [] };
    const r = await rig(lighter(calls));
    const t = await drive(r, SMALL);
    expect(t.stagesSeen).not.toContain("PLAN_REVIEW");
    expect(t.skipped).toEqual(expect.arrayContaining(["plan_check", "plan_approval"]));
    // Before the tier pass the reviewer's questions are owed: no merge.
    expect(await gate(r, t.taskId)).toBeDefined();
    const reports = await mergeTrackingJob(r);
    expect(reports.some((report) => typeof report["tierChecks"] === "number" && report["tierChecks"] > 0)).toBe(true);
    const questions = calls.calls.filter((call) => call.purpose === "questions");
    expect(questions.length).toBeGreaterThanOrEqual(1);
    expect(questions.every((call) => call.taskId === t.taskId && call.payer.kind === "project" && call.holdUsd > 0)).toBe(true);
    expect(calls.meteredTasks.every((taskId) => taskId === t.taskId)).toBe(true);
    expect(await gate(r, t.taskId)).toBeUndefined();
  });

  it("a change that grew after the build (the reviewer says it touches auth) gets the grown tier's code and security reviews through the metered call", async () => {
    const calls: Calls = { meteredTasks: [], calls: [] };
    const r = await rig(lighter(calls, { questionsYes: ["auth"] }));
    const t = await drive(r, SMALL);
    await mergeTrackingJob(r, 4);
    const purposes = calls.calls.map((call) => call.purpose);
    expect(purposes).toContain("questions");
    expect(purposes).toContain("code_review");
    expect(purposes).toContain("security_review");
    expect(calls.calls.every((call) => call.taskId === t.taskId)).toBe(true);
  });

  it("the company's provider is down (no company-billed source serves a model): couldn't check, NO call is made, and the merge is refused", async () => {
    const calls: Calls = { meteredTasks: [], calls: [] };
    const r = await rig(lighter(calls, { provider: "down" }));
    const t = await drive(r, SMALL);
    await mergeTrackingJob(r);
    expect(calls.meteredTasks.length).toBeGreaterThan(0);
    expect(calls.calls).toEqual([]);
    const flow = ((await r.world.store.get({ pk: `DEVTASK#${t.taskId}`, sk: "META" }))!["workflow"] as unknown as WorkflowSnapshot).flow;
    // The floor failed closed: the reviewer counts as unavailable, so the change is risky, never cleared.
    expect(flow?.tier?.reasons.map((reason) => reason.code)).toContain("reviewer_unavailable");
    expect(await gate(r, t.taskId)).toBeDefined();
  });

  it("H1a: a tier pass with less than 140 s of budget (as on the broker's 50 s) starts no reviewer call: the meter refuses, zero calls, the merge is refused", async () => {
    const calls: Calls = { meteredTasks: [], calls: [] };
    const r = await rig(lighter(calls));
    const t = await drive(r, SMALL);
    await mergeTrackingJob(r, 3, 50_000);
    expect(calls.calls).toEqual([]);
    expect(await gate(r, t.taskId)).toBeDefined();
  });

  it("H1c: the tier pass is its own job, run only by the tier pass's function (never the broker's)", () => {
    const tier = CORE_JOBS.find((entry) => entry.name === "tier-checks")!;
    expect(tier).toMatchObject({ area: "merge", host: "tier-checks", trigger: { kind: "schedule", rate: "rate(5 minutes)" } });
    expect(CORE_JOBS.filter((entry) => entry.host === "tier-checks").map((entry) => entry.name)).toEqual(["tier-checks"]);
  });

  it("the payer's month is used up: the meter refuses before any call (zero calls), and the merge is refused", async () => {
    const calls: Calls = { meteredTasks: [], calls: [] };
    const r = await rig(lighter(calls, { budget: "used_up" }));
    const t = await drive(r, SMALL);
    await mergeTrackingJob(r);
    expect(calls.meteredTasks.length).toBeGreaterThan(0);
    expect(calls.calls).toEqual([]);
    expect(await gate(r, t.taskId)).toBeDefined();
  });
});
