// Core drivers: merge tracking, branch sync, merge conflicts (areas 12, 41).
//
// The core's merge tracking reads the code host (the vendored FakeCodeHost over its FakeHostModel) in `runtime.tick()`, at most once per poll interval, so
// each pass first moves the engine's clock past it. GitHub's side is the fake host: a person's approval is a review on the change request, a merge is the
// host's own `merge`, a moved base is a commit on `main`, a conflict is the change request's `conflicts` flag. The fake host has no "behind" word of its
// own, so merge-support/core-host.ts reports `behind` (behindBy 1) while the branch's head does not hold the base's head, as GitHub would.
import { change, createCandidateManifest, type WorkerInvocation, type WorkflowProgram } from "@rovara-code/contracts";
import type { FakeWorldOptions } from "../../../support/cloud-core-fakes.js";
import type { CoreContext } from "../core-context.js";
import { checkReport } from "../core-context.js";
import type { StepDriver } from "../drivers.js";
import { approveOnHost, reportBehind } from "../merge-support/core-host.js";
import { applyJourneySettings } from "../core-settings.js";

type Driver = StepDriver<CoreContext, FakeWorldOptions>;

const UPSTREAM = { "upstream.ts": "export const upstream = 1;\n" };
const CONFLICTING = { "greeting.ts": "export function greet(name: string): string {\n  return 'Hi ' + name;\n}\n" };
const RESOLVED = { "greeting.ts": "export function greet(name: string): string {\n  return `Hi, ${name}`;\n}\n" };
const prepared = new WeakSet<CoreContext>();
/** Tasks whose conflict the coder resolved (the next base merge holds the resolution and pushes). */
const resolved = new WeakSet<CoreContext>();

/** One tracking pass: the clock past the poll interval (and the heartbeat), then the timers' work. */
async function trackingPass(ctx: CoreContext): Promise<void> {
  ctx.clock.advance(16 * 60_000);
  await ctx.runtime.tick();
}

/**
 * Answers whatever the core hands the worker after a tracking pass, until it hands nothing: a coding round (a conflict fix) with the resolved files, the
 * reviews (passing), and a maintenance push (a base merge or a fix pushed to the open pull request) as the worker does it on the host.
 */
async function answerMaintenance(ctx: CoreContext, word: string): Promise<void> {
  const model = ctx.world.hostModel;
  for (let round = 0; round < 8; round += 1) {
    const job: WorkerInvocation | undefined = await ctx.nextJob();
    if (job === undefined) {
      await trackingPass(ctx);
      const after = await ctx.nextJob();
      if (after === undefined) return;
      ctx.task.pending = after;
      continue;
    }
    const mode = ctx.modeOf(job);
    const cr = model.changeRequests[0]!;
    if (process.env.PARITY_DEBUG === "1") console.log(JSON.stringify({ parity: "core.merge.job", kind: job.kind, mode, action: (job.payload as { action?: unknown }).action }));
    if (mode === "IMPLEMENT") {
      // The conflict round: the coder resolves the file in the merged workspace; the worker pushes the merge commit (old head, base) holding the resolution later.
      resolved.add(ctx);
      const merged = mergeCommit(ctx, model.headRevisionOf(cr), model.headOf("main"), RESOLVED);
      ctx.task.commit = merged;
      ctx.task.tree = model.revision(merged).tree;
      ctx.task.base = model.headOf("main");
      await ctx.callback(job, "result", { status: "SUCCEEDED", result: { conversationId: "conversation", checks: checkReport("passed"), workflowCandidateRepositories: ctx.candidate(), workflowCheckCandidateRepositories: ctx.candidate() } });
    } else if (mode === "CHECKS") {
      // The checks on the merged (or fixed) code: the project's check passes.
      await ctx.callback(job, "result", { status: "SUCCEEDED", result: { conversationId: "conversation", checks: checkReport("passed"), workflowCandidateRepositories: ctx.candidate(), workflowCheckCandidateRepositories: ctx.candidate() } });
    } else if (mode === "REVIEW") {
      const digest = createCandidateManifest(ctx.candidate()).digest;
      const report = (role: "CRITIC" | "SECURITY") => ({ operationId: job.operationId, candidateDigest: digest, role, provider: "examplehost-model", version: "1", readOnly: true, recordedAt: ctx.clock.now().toISOString(), status: "PASS", findings: [], ...(role === "CRITIC" ? { risk: "low" } : {}) });
      await ctx.callback(job, "result", { status: "SUCCEEDED", result: { conversationId: "conversation", workflowCandidateRepositories: ctx.candidate(), workflowReviews: [report("CRITIC"), report("SECURITY")] } });
    } else if (job.kind === "maintain" || mode === "SYNC") {
      const payload = job.payload as Record<string, unknown>;
      const action = typeof payload.action === "string" ? payload.action : "sync";
      const previous = model.headRevisionOf(cr);
      const baseHead = model.headOf("main");
      const lifecycle = (commit: string, extra: Record<string, unknown> = {}) => ({ action, repository: "demo", number: 1, url: model.crUrl("1"), state: "open", headBranch: cr.sourceBranch, baseBranch: "main", previousCommit: previous, commit, treeSha: model.revision(commit).tree, checks: [], reconciled: false, ...extra });
      if (action === "sync" && cr.conflicts && !resolved.has(ctx)) {
        // The worker's merge of the base stops on the conflict: nothing is pushed, and the result names the files (core/branch-sync/branch-sync.ts reads `conflicts`).
        await ctx.callback(job, "result", { status: "SUCCEEDED", result: lifecycle(previous, { conflicts: ["greeting.ts"] }) });
        continue;
      }
      // A base merge (or a resolved conflict's merge) is a merge commit of the old head and the base's head, holding the resolution; an appended fix is the fix's commit.
      const pushed = action === "sync" && !resolved.has(ctx) ? mergeCommit(ctx, previous, baseHead, {}) : ctx.task.commit;
      model.branches.set(cr.sourceBranch, pushed);
      if (action === "sync" || resolved.has(ctx)) cr.conflicts = false;
      await ctx.callback(job, "pull-request-update", { repository: "demo", pullRequestNumber: 1, action, headBranch: cr.sourceBranch, baseBranch: "main", previousCommit: previous, commit: pushed });
      await ctx.callback(job, "result", { status: "SUCCEEDED", result: lifecycle(pushed) });
      // The candidate is now the pushed head, on the new base.
      ctx.task.commit = pushed;
      ctx.task.tree = model.revision(pushed).tree;
      if (action === "sync") ctx.task.base = baseHead;
      ctx.extra.codeHost.push(word);
    } else {
      throw new Error(`the merge driver got a job it does not answer: ${mode}`);
    }
  }
}

/** The worker's merge of the base into the branch, as a revision with both parents and the union of the files (the base's files under the head's). */
function mergeCommit(ctx: CoreContext, head: string, base: string, resolution: Readonly<Record<string, string>>): string {
  const model = ctx.world.hostModel;
  const files = new Map(model.revision(base).files);
  for (const [path, content] of model.revision(head).files) files.set(path, content);
  for (const [path, content] of Object.entries(resolution)) files.set(path, content);
  return model.makeRevision([head, base], files).sha;
}

function shared(): Pick<Driver, "prepare"> {
  return {
    prepare(ctx, scenario) {
      if (prepared.has(ctx)) return Promise.resolve();
      prepared.add(ctx);
      reportBehind(ctx.world.host, ctx.world.hostModel);
      // Cloud's automatic fix switch (`fx`) and the rest map onto the core's flow options through the root's mapping (S0-Q2); a merge scenario without `autofix-on` runs with it off, as Cloud's journey does.
      applyJourneySettings(ctx.runtime.app.flow.deps, scenario, {}, ctx.companyId);
      return Promise.resolve();
    },
  };
}

/** The program Cloud's version 2 tasks run (the same one the Cloud merge drivers give the task). */
const PROGRAM: WorkflowProgram = { steps: [
  { id: "plan", kind: "plan" }, { id: "plan_critic", kind: "plan_critic" }, { id: "build", kind: "build" }, { id: "check", kind: "check" },
  { id: "review", kind: "review", reviewers: ["code", "security"], onFindings: { backTo: "build", maxRounds: 3 } }, { id: "pull_request", kind: "pull_request" },
] };

/**
 * The task on Rovara Code version 2 (workflow definition 1.1.0) with its program, the way the Cloud merge drivers move theirs (the branch-sync journeys'
 * technique). With Cloud's Quick settings mapped (no Understand), the core starts a task on definition 1.0.0 too, and merge tracking (`tracksMerge`,
 * core/merge/merge-tracking.ts) follows only 1.1.0 tasks; both engines are moved the same way so they are compared on the version 2 path.
 */
async function toVersion2(ctx: CoreContext): Promise<void> {
  await ctx.store.update({ key: { pk: `DEVTASK#${ctx.task.taskId}`, sk: "META" }, ops: [change.set(["workflow", "definitionVersion"], "1.1.0"), change.set(["workflow", "program"], PROGRAM as never), change.set(["workflow", "programStepId"], "pull_request")] });
}

/** The pull request after its publication: a person approves it on the host, and the first tracking pass marks it ready (as Cloud's does). */
async function approvedAndTracked(ctx: CoreContext): Promise<void> {
  await toVersion2(ctx);
  approveOnHost(ctx.world.hostModel, "1");
  await trackingPass(ctx);
  if (process.env.PARITY_DEBUG === "1") await debugTracking(ctx, "after first pass");
}

async function debugTracking(ctx: CoreContext, label: string): Promise<void> {
  const recovery = (await ctx.store.query({ pk: "WORKFLOW_MERGE_RECOVERY" })).items;
  const items = (await ctx.store.query({ pk: `DEVTASK#${ctx.task.taskId}`, sk: { op: "beginsWith", prefix: "MERGE_TRACKING#" } })).items;
  const cr = ctx.world.hostModel.changeRequests[0];
  console.log(JSON.stringify({ parity: "core.merge", label, now: ctx.clock.now().toISOString(), recovery, items, cr: { draft: cr?.draft, state: cr?.state, reviews: cr?.reviews.length } }).slice(0, 3000));
}

export const MERGE_DRIVERS: Record<string, Driver> = {
  // Cloud's automatic fix switch (`af`) on for this scenario: the core's autofix on (its default). A setting, so the step itself does nothing.
  "feature:autofix-on": {
    prepare(ctx) { ctx.runtime.app.flow.deps.autofix = { enabled: true, capUsd: 5, roundEstimateUsd: 1 }; return Promise.resolve(); },
    run: () => Promise.resolve(),
  },
  "pr.merged": {
    ...shared(),
    async run(ctx) {
      await approvedAndTracked(ctx);
      const model = ctx.world.hostModel;
      const cr = model.changeRequests[0]!;
      // A person merges it on the host. A draft cannot be merged: if tracking has not marked it ready, the person does (GitHub's "Ready for review").
      if (cr.draft) { model.markReady(cr.id); ctx.extra.codeHost.push("marked_ready_by_person"); }
      const merged = model.merge(cr.id, { revision: model.headRevisionOf(cr), method: "squash" });
      if (merged.outcome !== "merged") throw new Error(`the fake host refused the merge: ${JSON.stringify(merged)}`);
      await trackingPass(ctx);
      await trackingPass(ctx);
    },
  },
  "base.moved": {
    ...shared(),
    async run(ctx) {
      await approvedAndTracked(ctx);
      ctx.world.hostModel.commit("main", UPSTREAM);
      await trackingPass(ctx);
      await answerMaintenance(ctx, "push_base_merge");
    },
  },
  "merge.conflict": {
    ...shared(),
    async run(ctx) {
      await approvedAndTracked(ctx);
      const model = ctx.world.hostModel;
      model.commit("main", CONFLICTING);
      model.changeRequests[0]!.conflicts = true;
      await trackingPass(ctx);
      await answerMaintenance(ctx, "push_conflict_fix");
    },
  },
};
