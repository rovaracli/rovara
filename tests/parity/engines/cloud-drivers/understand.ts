// Cloud drivers: Understand asks the owner questions, the owner answers, planning goes on with the answers (area 2). Cloud runs Understand on a Rovara Code
// version 2 task (definition 1.1.0), started on the app's route; the Slack journey harness's Quick path has no Understand step. So this driver runs Cloud's
// own developer-task broker with Rovara Code v2 live (tests/support/rovara-code-questions-broker.ts, as Cloud's own answer suites do), answers on the
// route the web and the CLI use (`POST /v1/app/sessions/{id}/answers`), and records what it saw in the features facet.
import { randomUUID } from "node:crypto";
import { UNDERSTAND_ARTIFACT_NAME } from "@rovara-code/contracts";
import { MAYA, questionsBroker } from "../../../support/rovara-code-questions-broker.js";
import type { CloudContext, CloudOptions } from "../cloud-context.js";
import type { StepDriver } from "../drivers.js";
import { stateWord } from "../core-context.js";
import { ANSWERS, QUESTIONS, READY, askedWords, promptWords } from "../understand-support/words.js";

const PREPARED = { result: { preparedBase: [{ repositoryId: "demo", baseCommitSha: "e".repeat(40) }] } };

export const UNDERSTAND_DRIVERS: Record<string, StepDriver<CloudContext, CloudOptions>> = {
  "feature:understand.questions": {
    async run(ctx) {
      const h = await questionsBroker();
      const words = ctx.extra.features;
      const meta = (taskId: string) => h.meta(taskId);
      const understands = (workspaceId: string) => h.operations(workspaceId).filter((item) => item.workflowMode === "UNDERSTAND");
      const plans = (workspaceId: string) => h.operations(workspaceId).filter((item) => item.workflowMode === "PLAN");
      const promptOf = (operationId: string): string | undefined =>
        (h.db.find((item) => item.entityType === "OUTBOX" && item.operationId === operationId)[0]?.invocation as { payload?: { prompt?: string } } | undefined)?.payload?.prompt;

      const started = await h.dev(MAYA, "POST", "/v1/app/projects/payments/code", { requestId: randomUUID(), input: { text: "The items list is getting unwieldy. Add pagination." } });
      if (started.status !== 202) throw new Error(`Cloud did not start the Rovara Code task: ${JSON.stringify(started.body).slice(0, 200)}`);
      const taskId = (started.body.task as { taskId: string }).taskId;
      const workspaceId = meta(taskId).workspaceId;
      await h.finish(workspaceId, String(h.operations(workspaceId).find((item) => item.kind === "prepare")!.id), "SUCCEEDED", PREPARED);
      words.push(`after-start:${stateWord(meta(taskId).workflow)}`);
      const first = String(understands(workspaceId).at(-1)!.id);
      await h.artifact(workspaceId, first, UNDERSTAND_ARTIFACT_NAME, JSON.stringify(QUESTIONS));
      await h.finish(workspaceId, first, "SUCCEEDED", { result: { workflowMode: "UNDERSTAND" } });
      words.push(askedWords(meta(taskId).workflow.intent?.assessment ?? QUESTIONS));
      words.push(`after-questions:${stateWord(meta(taskId).workflow)}`);

      const answered = await h.dev(MAYA, "POST", `/v1/app/sessions/${meta(taskId).sessionId}/answers`, { requestId: randomUUID(), round: 1, answers: ANSWERS });
      words.push(`answer:${answered.status === 200 ? "accepted" : `refused:${String(answered.status)}`}`);
      words.push(`after-answer:${stateWord(meta(taskId).workflow)}`);
      const second = understands(workspaceId).at(-1);
      words.push(promptWords("understand-again-prompt", second === undefined || String(second.id) === first ? undefined : promptOf(String(second.id))));

      if (second !== undefined && String(second.id) !== first) {
        await h.artifact(workspaceId, String(second.id), UNDERSTAND_ARTIFACT_NAME, JSON.stringify(READY));
        await h.finish(workspaceId, String(second.id), "SUCCEEDED", { result: { workflowMode: "UNDERSTAND" } });
        if (plans(workspaceId).length === 0) await h.handler({ source: "agentx.workflow-dispatch-recovery" });
      }
      const plan = plans(workspaceId).at(-1);
      const planPrompt = plan === undefined ? undefined : promptOf(String(plan.id));
      words.push(`plan-prompt:${planPrompt === undefined ? "no-step" : planPrompt.includes("25 items") ? "carries-answer" : "no-answer"}`);
      words.push(`after-ready:${stateWord(meta(taskId).workflow)}`);
    },
  },
};
