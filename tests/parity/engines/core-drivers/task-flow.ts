// Core drivers for the task flow and the build step: start, plan, decisions on the plan, coding, checks, reviews, the publication, a stop, a race.
import { createCandidateManifest } from "@rovara-code/contracts";
import type { CoreContext } from "../core-context.js";
import type { StepDriver } from "../drivers.js";
import type { FakeWorldOptions } from "../../../support/cloud-core-fakes.js";
import type { Step } from "../../harness/types.js";

type Driver = StepDriver<CoreContext, FakeWorldOptions>;
const as = <K extends Step["do"]>(step: Step, kind: K): Extract<Step, { do: K }> => {
  if (step.do !== kind) throw new Error(`a ${kind} driver was handed a ${step.do} step`);
  return step as Extract<Step, { do: K }>;
};

export const TASK_FLOW_DRIVERS: Record<string, Driver> = {
  start: {
    // The composition root maps Cloud's own settings onto the core's flow options (S0-Q2): Cloud's journey install runs the Quick path with no Understand
    // step and no plan check, so the core is set the same way. `coreUsesCodeDefaults` leaves Code's defaults (code-defaults-quick shows the difference).
    async prepare(ctx, scenario) {
      if (scenario.coreUsesCodeDefaults !== true) {
        ctx.runtime.app.flow.deps.understandFirst = false;
        ctx.runtime.app.flow.deps.planCheck = false;
      }
      // Cloud's automatic fix switch (`af`) maps onto the core's autofix option, set as the Cloud engine sets it for a scenario with a failing check or review findings.
      // Cloud's `af` is off by default and Code's autofix is on by default (core/build-step/autofix.ts reads `enabled !== false`), so every other
      // scenario runs the core with it off, as Cloud runs (S0-Q2). `feature: autofix-on` (merge lane) turns it on for its scenario.
      const autofixOn = scenario.steps.some((step) => (step.do === "checks" && step.outcome === "fail") || (step.do === "reviews" && step.outcome === "findings") || (step.do === "feature" && step.name === "autofix-on"));
      ctx.runtime.app.flow.deps.autofix = autofixOn ? { enabled: true, capUsd: 5, roundEstimateUsd: 1 } : { enabled: false };
    },
    async run(ctx, step) {
      const start = as(step, "start");
      await ctx.api("/v1/admin/projects", { method: "POST", body: ctx.project });
      const started = await ctx.api("/v1/dev/tasks", { method: "POST", body: { requestId: "11111111-1111-4111-8111-111111111111", project: "payments", instructions: start.request, workflow: true, ...(start.path === undefined ? {} : { workflowPath: start.path }) } });
      if (started.status !== 201) {
        // A refused start is an outcome (a spend limit, a workspace limit): recorded, the scenario ends.
        ctx.extra.spend.push(`start_refused:${String((started.body.error as { code?: string } | undefined)?.code)}`);
        throw new StartRefused(JSON.stringify(started.body).slice(0, 200));
      }
      ctx.task.taskId = (started.body.task as { taskId: string }).taskId;
      const record = await ctx.readTask();
      ctx.task.workspaceId = typeof record?.workspaceId === "string" ? record.workspaceId : "";
      const prepare = await ctx.take();
      await ctx.callback(prepare, "result", { status: "SUCCEEDED", result: { preparedBase: [{ repositoryId: "demo", baseCommitSha: ctx.task.base }] } });
    },
  },
  "plan.proposed": { run: (ctx, step) => ctx.answerPlanning(as(step, "plan.proposed").plan) },
  "plan.approve": { run: (ctx) => ctx.decidePlan("approve") },
  "plan.requestChanges": {
    async run(ctx, step) {
      const changes = as(step, "plan.requestChanges");
      await ctx.decidePlan("changes", changes.note);
      await ctx.answerPlanning(changes.revised);
    },
  },
  "coding.done": {
    async run(ctx, step, next) {
      ctx.task.codingJob = await ctx.take();
      ctx.task.commit = ctx.world.hostModel.commit("work", { ...as(step, "coding.done").files });
      ctx.task.tree = ctx.world.hostModel.revision(ctx.task.commit).tree;
      // The coding run's result carries its checks' report: it is sent by the next `checks` step, or now (passing) when no `checks` step follows.
      if (next?.do !== "checks") await ctx.sendCoding("passed");
    },
  },
  checks: {
    async run(ctx, step, next) {
      const checks = as(step, "checks");
      // A check that fails and then passes inside one coding run is the worker's one extra try (FR-006): the run reports it passed, with the extra try
      // given, as the real worker does. A check that fails with no pass after it is reported failed.
      if (checks.outcome === "fail" && next?.do === "checks" && next.outcome === "pass") { await ctx.sendCoding("passed", "given"); ctx.task.skipNext = true; return; }
      if (ctx.task.skipNext === true) { delete ctx.task.skipNext; return; }
      ctx.task.codingJob ??= await ctx.take();
      await ctx.sendCoding(checks.outcome === "pass" ? "passed" : "failed");
    },
  },
  reviews: {
    async run(ctx, step) {
      const findings = as(step, "reviews").outcome === "findings";
      const job = await ctx.take();
      const digest = createCandidateManifest(ctx.candidate()).digest;
      const report = (role: "CRITIC" | "SECURITY") => ({
        operationId: job.operationId, candidateDigest: digest, role, provider: "examplehost-model", version: "1", readOnly: true, recordedAt: ctx.clock.now().toISOString(),
        status: findings && role === "CRITIC" ? "FINDINGS" : "PASS",
        findings: findings && role === "CRITIC" ? [{ text: "greet does not trim the name.", origin: "INTRODUCED", severity: "HIGH", file: "greeting.ts", line: 2 }] : [],
        ...(role === "CRITIC" ? { risk: "low" } : {}),
      });
      await ctx.callback(job, "result", { status: "SUCCEEDED", result: { conversationId: "conversation", workflowCandidateRepositories: ctx.candidate(), workflowReviews: [report("CRITIC"), report("SECURITY")] } });
    },
  },
  published: {
    async run(ctx) {
      const job = await ctx.take();
      const model = ctx.world.hostModel;
      const payload = job.payload as Record<string, unknown>;
      const headBranch = String(payload.headBranch);
      model.branches.set(headBranch, ctx.task.commit);
      await ctx.callback(job, "pull-request", { repository: "demo", repositoryUrl: model.url, headBranch, baseBranch: "main", commit: ctx.task.commit, title: payload.title, body: payload.body });
      await ctx.callback(job, "result", { status: "SUCCEEDED", result: { repository: "demo", number: 1, url: model.crUrl("1"), headBranch, baseBranch: "main", commit: ctx.task.commit, checks: [], reconciled: false, draft: true } });
    },
  },
  "task.stop": {
    async run(ctx) {
      const stopped = await ctx.api(`/v1/dev/tasks/${ctx.task.taskId}/cancel`, { method: "POST", body: { requestId: "22222222-2222-4222-8222-222222222222" } });
      if (stopped.status !== 200) throw new Error(`the core refused the stop (${String(stopped.status)}): ${JSON.stringify(stopped.body).slice(0, 200)}`);
      await ctx.runtime.tick();
    },
  },
};

/** A start the core refused: the scenario's outcome, not a crash (the engine ends the run and reports what it saw). */
export class StartRefused extends Error {}
