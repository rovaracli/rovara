// Core drivers: Second review, design review, e2e, parallel parts, lessons (areas 8, 9, 10, 11, 14).
//
// parallel-parts (area 11): the same Full task as Cloud's journey. The fake worker answers each phase's plan (the coding plan carries the three-part
// graph), the owner approves each on the local pages, and the coding run reports the parts' checkpoints the way the real worker does (A and B start
// before either finishes, C starts on the tree both were merged into) through the REAL events callback, then its result on the integrated tree. The
// reviews and the publication reuse the task-flow drivers.
import { UNDERSTAND_ARTIFACT_NAME, createCandidateManifest, type WorkerInvocation } from "@rovara-code/contracts";
import type { FakeWorldOptions } from "../../../support/cloud-core-fakes.js";
import { checkReport, type CoreContext } from "../core-context.js";
import type { StepDriver } from "../drivers.js";
import { PART_A, PART_B, PART_C, PART_FILES, partsPlan } from "../features-a-support/parts.js";
import { TASK_FLOW_DRIVERS } from "./task-flow.js";

type Driver = StepDriver<CoreContext, FakeWorldOptions>;

const unsupported = (why: string): Driver => ({ supports: () => ({ unsupported: why }), run: () => Promise.reject(new Error(why)) });

const phaseOf = (job: WorkerInvocation): "requirements" | "design" | "plan" => {
  const phase = (job.payload as { workflowPhase?: string }).workflowPhase;
  return phase === "REQUIREMENTS" ? "requirements" : phase === "DESIGN" ? "design" : "plan";
};

interface Dependencies { approval: { graphDigest: string; runId: string; workflowRevision: number }; sequenceStart: number }

export const FEATURES_A_DRIVERS: Record<string, Driver> = {
  "feature:parallel-parts": {
    // Cloud's journey project checks the integrated tree with `node integration.mjs`; the core's project gets the same check.
    async prepare(ctx, scenario) {
      ctx.project = { ...ctx.project, readiness: [{ cwd: "repo/demo", executable: "node", args: ["integration.mjs"], timeoutSeconds: 30 }] };
      // features-a-parallel-parts-understand: the core runs Understand first (Code's default), the one setting under which its Full path advances
      // past the requirements today (known difference parallel-parts/transitions). Runs after the start driver's settings, so it wins.
      if (scenario.id.endsWith("-understand")) ctx.runtime.app.flow.deps.understandFirst = true;
    },
    async run(ctx) {
      // Plans and approvals until the coding run is handed to the worker (requirements, design, coding plan on the Full path).
      let coding: WorkerInvocation | undefined;
      for (let round = 0; round < 12 && coding === undefined; round += 1) {
        const job = await ctx.nextJob();
        if (job === undefined) {
          const task = await ctx.readTask();
          const workflow = task?.workflow as { stage?: string; state?: string } | undefined;
          if (workflow?.stage === "PLAN_REVIEW" && workflow.state === "WAITING") { await ctx.decidePlan("approve"); continue; }
          return; // stalled: the transitions show where
        }
        const mode = ctx.modeOf(job);
        if (mode === "UNDERSTAND") {
          await ctx.callback(job, "artifacts", { name: UNDERSTAND_ARTIFACT_NAME, mediaType: "application/json", content: JSON.stringify({ kind: "ready", path: "FULL", restatement: "Add a shared greeting service.", assumptions: [] }) });
          await ctx.callback(job, "result", { status: "SUCCEEDED" });
        } else if (mode === "PLAN") {
          await ctx.callback(job, "artifacts", { name: "plan.md", mediaType: "text/markdown", content: partsPlan(ctx.task.taskId, phaseOf(job)) });
          await ctx.callback(job, "result", { status: "SUCCEEDED" });
        } else if (mode === "IMPLEMENT") {
          coding = job;
        } else {
          ctx.task.pending = job;
          return;
        }
      }
      if (coding === undefined) return;
      const dependencies = (coding.payload as { workflowDependencies?: Dependencies }).workflowDependencies;
      const model = ctx.world.hostModel;
      if (dependencies === undefined) {
        // The core built the plan as one piece: the result is the whole change (the transitions and the missing checkpoints show the difference).
        ctx.task.commit = model.commit("work", Object.assign({}, ...Object.values(PART_FILES)) as Record<string, string>);
        ctx.task.tree = model.revision(ctx.task.commit).tree;
        ctx.task.codingJob = coding;
        await ctx.sendCoding("passed");
      } else {
        // The parts, as the real worker reports them: A and B side by side on the base, then C on the tree both were merged into.
        const base = model.revision(ctx.task.base).tree;
        let sequence = dependencies.sequenceStart;
        const event = (itemId: string, state: string, baseTreeSha: string, extra: Record<string, unknown> = {}) => {
          sequence += 1;
          const at = ctx.clock.now().toISOString();
          return { type: "progress", timestamp: at, payload: { workItemProgress: { schemaVersion: 1, graphDigest: dependencies.approval.graphDigest, runId: dependencies.approval.runId, itemId, sequence, state, operationId: coding.operationId, baseTreeSha, at, producer: "agentx-worker", ...extra } } };
        };
        const afterA = model.commit("work", PART_FILES[PART_A]!);
        const afterAB = model.commit("work", PART_FILES[PART_B]!);
        const treeA = model.revision(afterA).tree;
        const treeAB = model.revision(afterAB).tree;
        await ctx.callback(coding, "events", { events: [event(PART_A, "STARTED", base), event(PART_B, "STARTED", base)] });
        await ctx.callback(coding, "events", { events: [event(PART_A, "IMPLEMENTED", base, { candidateTreeSha: treeA, integratedTreeSha: treeA })] });
        await ctx.callback(coding, "events", { events: [event(PART_B, "IMPLEMENTED", base, { candidateTreeSha: treeAB, integratedTreeSha: treeAB })] });
        await ctx.callback(coding, "events", { events: [event(PART_C, "STARTED", treeAB)] });
        ctx.task.commit = model.commit("work", PART_FILES[PART_C]!);
        ctx.task.tree = model.revision(ctx.task.commit).tree;
        await ctx.callback(coding, "events", { events: [event(PART_C, "IMPLEMENTED", treeAB, { candidateTreeSha: ctx.task.tree, integratedTreeSha: ctx.task.tree })] });
        // The run's result names its ordered work: each part's last acknowledged checkpoint in the plan's order, the run, and the combined candidate.
        const stored = ((await ctx.readTask())?.workflow as { workflowDependenciesProgress?: Array<Record<string, unknown>> } | undefined)?.workflowDependenciesProgress ?? [];
        const lastOf = (itemId: string) => [...stored].reverse().find((entry) => entry.itemId === itemId);
        const workflowDependenciesResult = {
          schemaVersion: 1, taskId: ctx.task.taskId, graphDigest: dependencies.approval.graphDigest, runId: dependencies.approval.runId, operationId: coding.operationId,
          workflowRevision: dependencies.approval.workflowRevision, status: "SUCCEEDED", items: [PART_A, PART_B, PART_C].map(lastOf), candidateDigest: createCandidateManifest(ctx.candidate()).digest, at: ctx.clock.now().toISOString(),
        };
        await ctx.callback(coding, "result", { status: "SUCCEEDED", result: { conversationId: "conversation", checks: checkReport("passed"), workflowCandidateRepositories: ctx.candidate(), workflowCheckCandidateRepositories: ctx.candidate(), workflowDependenciesResult } });
      }
      // Then the reviews and the publication, as on any task.
      await TASK_FLOW_DRIVERS.reviews!.run(ctx, { do: "reviews", outcome: "pass" }, undefined);
      await TASK_FLOW_DRIVERS.published!.run(ctx, { do: "published" }, undefined);
    },
  },
  "feature:second-review": unsupported("the core's second review (core/second-review, local app `secondReview.apply`) offers a second reviewer only among models the install holds keys for, and the parity core context starts the local runtime with an empty environment (no provider keys): every opinion is `unavailable`. Needs core-context to accept an environment (shared change)"),
  "feature:design-review": unsupported("the core's design review (core/design-review) needs the switch `ROVARA_DESIGN_REVIEW` in the runtime's environment, design-review sources and reviewer jobs answered with mockups; the parity core context takes no environment (shared change), and Cloud's side has no driver either"),
  "feature:e2e": unsupported("the core's application checks (core/e2e) need the e2e local authority, a candidate export upload and round results the fake worker would have to forge with verified evidence; with no Cloud driver to compare against it is left for the lane that builds Cloud's"),
  "feature:lessons": unsupported("the core's lessons (local app `lessons`, ROVARA_LESSONS) capture from the code host and need the learning port; Cloud's lessons need its team record. Neither engine has a driver; the comparison needs the learning adapter (X2) wired on Cloud's side first"),
};
