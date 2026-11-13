// Core drivers: Understand asks the owner questions, the owner answers, planning goes on with the answers (area 2). The core runs Understand first by
// default (Code's flow option; the composition root maps it from Cloud's settings, S0-Q2): this driver leaves it on, starts a task on the core's own
// route, answers the UNDERSTAND job with questions, answers them on the core's session route (`POST /v1/app/sessions/{id}/answers`, the same path as
// Cloud's), and records what it saw in the features facet in the words the Cloud driver uses.
import { UNDERSTAND_ARTIFACT_NAME, type WorkerInvocation } from "@rovara-code/contracts";
import type { FakeWorldOptions } from "../../../support/cloud-core-fakes.js";
import { stateWord, type CoreContext } from "../core-context.js";
import type { StepDriver } from "../drivers.js";
import { ANSWERS, QUESTIONS, READY, askedWords, promptWords } from "../understand-support/words.js";

const promptOf = (job: WorkerInvocation | undefined): string | undefined => (job?.payload as { prompt?: string } | undefined)?.prompt;

export const UNDERSTAND_DRIVERS: Record<string, StepDriver<CoreContext, FakeWorldOptions>> = {
  "feature:understand.questions": {
    async prepare(ctx) {
      ctx.runtime.app.flow.deps.understandFirst = true;
      ctx.runtime.app.flow.deps.planCheck = false;
      ctx.runtime.app.flow.deps.autofix = { enabled: false };
      return Promise.resolve();
    },
    async run(ctx) {
      const words = ctx.extra.features;
      const workflow = async () => ((await ctx.readTask())?.workflow ?? {}) as { stage?: string; state?: string; blockReason?: string; intent?: { assessment?: typeof QUESTIONS } };
      await ctx.api("/v1/admin/projects", { method: "POST", body: ctx.project });
      const started = await ctx.api("/v1/dev/tasks", { method: "POST", body: { requestId: "33333333-3333-4333-8333-333333333333", project: "payments", instructions: "The items list is getting unwieldy. Add pagination.", workflow: true } });
      if (started.status !== 201) throw new Error(`the core refused the start: ${JSON.stringify(started.body).slice(0, 200)}`);
      ctx.task.taskId = (started.body.task as { taskId: string }).taskId;
      const record = await ctx.readTask();
      ctx.task.workspaceId = typeof record?.workspaceId === "string" ? record.workspaceId : "";
      const prepare = await ctx.take();
      await ctx.callback(prepare, "result", { status: "SUCCEEDED", result: { preparedBase: [{ repositoryId: "demo", baseCommitSha: ctx.task.base }] } });
      words.push(`after-start:${stateWord(await workflow())}`);

      const first = await ctx.take();
      await ctx.callback(first, "artifacts", { name: UNDERSTAND_ARTIFACT_NAME, mediaType: "application/json", content: JSON.stringify(QUESTIONS) });
      await ctx.callback(first, "result", { status: "SUCCEEDED" });
      words.push(askedWords((await workflow()).intent?.assessment ?? QUESTIONS));
      words.push(`after-questions:${stateWord(await workflow())}`);
      await ctx.runtime.tick();

      const sessionId = String((await ctx.readTask())?.sessionId);
      const answered = await ctx.api(`/v1/app/sessions/${sessionId}/answers`, { method: "POST", body: { requestId: "44444444-4444-4444-8444-444444444444", round: 1, answers: ANSWERS } });
      words.push(`answer:${answered.status === 200 ? "accepted" : `refused:${String(answered.status)}`}`);
      const second = await ctx.nextJob();
      words.push(`after-answer:${stateWord(await workflow())}`);
      words.push(promptWords("understand-again-prompt", ctx.modeOf(second ?? first) === "UNDERSTAND" && second !== undefined ? promptOf(second) : undefined));

      let plan: WorkerInvocation | undefined;
      if (second !== undefined && ctx.modeOf(second) === "UNDERSTAND") {
        await ctx.callback(second, "artifacts", { name: UNDERSTAND_ARTIFACT_NAME, mediaType: "application/json", content: JSON.stringify(READY) });
        await ctx.callback(second, "result", { status: "SUCCEEDED" });
        plan = await ctx.nextJob();
      }
      const planPrompt = plan !== undefined && ctx.modeOf(plan) === "PLAN" ? promptOf(plan) : undefined;
      words.push(`plan-prompt:${planPrompt === undefined ? "no-step" : planPrompt.includes("25 items") ? "carries-answer" : "no-answer"}`);
      words.push(`after-ready:${stateWord(await workflow())}`);
    },
  },
};
