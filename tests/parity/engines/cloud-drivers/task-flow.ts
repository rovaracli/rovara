// Cloud drivers for the task flow and the build step. After the plan's approval Cloud's path runs coding, checks, reviews and the publication by itself
// (the real worker on the faux model), so those steps only let it run (`settle`); what they script is set up front in the harness options.
import { randomUUID } from "node:crypto";
import { bearerFor } from "../../../support/developer-task-broker.js";
import { E2E_CHECK, SLACK_MAYA } from "../../../support/workflow-e2e.js";
import { baseOptions, type CloudContext, type CloudOptions } from "../cloud-context.js";
import { reviewerReply } from "../../../support/faux-scripts.js";
import { reviewerFindings } from "../../../support/model-fixtures.js";
import type { StepDriver } from "../drivers.js";
import type { Step } from "../../harness/types.js";

type Driver = StepDriver<CloudContext, CloudOptions>;
/** The finding `reviewerFindings(1)` writes; the send-back prompt carries it. */
const FINDING_TEXT = "the greeting is not trimmed";
const settle: Driver = { run: async (ctx) => { await ctx.e2e.settle(); } };

/** Calls one of the broker's developer routes as Maya (Slack sign-in), as the journey suites do. */
export async function asMaya(ctx: CloudContext, method: string, path: string, body: unknown = {}): Promise<{ statusCode: number; body: string }> {
  const answer = await ctx.e2e.handler({
    version: "2.0", rawPath: path, rawQueryString: "", headers: { authorization: await bearerFor(SLACK_MAYA), "content-type": "application/json" },
    requestContext: { requestId: randomUUID(), http: { method } }, body: JSON.stringify(body), isBase64Encoded: false,
  });
  return { statusCode: answer.statusCode, body: answer.body };
}

export const TASK_FLOW_DRIVERS: Record<string, Driver> = {
  start: {
    async run(ctx, step) {
      const start = step as Extract<Step, { do: "start" }>;
      if (await ctx.e2e.mention(`${start.path === "FULL" ? "full" : "quick"}: ${start.request}`) !== 200) throw new Error("Cloud refused the mention");
      await ctx.e2e.settle();
    },
  },
  "plan.proposed": { run: async () => undefined }, // the planner ran on the mention's settle
  "plan.approve": { run: async (ctx) => { await ctx.e2e.click("agentx_workflow_approve"); await ctx.e2e.settle(); } },
  "plan.requestChanges": {
    async run(ctx, step) {
      await ctx.e2e.click("agentx_workflow_changes");
      await ctx.e2e.submitView({ workflow_feedback: { reason: { value: (step as Extract<Step, { do: "plan.requestChanges" }>).note } } });
      await ctx.e2e.settle();
    },
  },
  "coding.done": settle,
  checks: {
    // The journey worker runs the project check once after the change (no baseline run): run 0 is that run, later runs are reruns after a fix. A fail
    // followed by a pass fails run 0 only; a fail with no pass after it fails every run. The automatic fix (`af`) is on, as the core runs it.
    options(scenario) {
      const fails = scenario.steps.some((step) => step.do === "checks" && step.outcome === "fail");
      if (!fails) return {};
      const once = scenario.steps.some((step, index) => step.do === "checks" && step.outcome === "fail" && scenario.steps[index + 1]?.do === "checks" && (scenario.steps[index + 1] as { outcome?: string }).outcome === "pass");
      let runs = 0;
      return {
        autofix: { enabled: true, capUsd: 5, roundEstimateUsd: 1 },
        checkResult: (command) => {
          if (command.executable !== E2E_CHECK.executable || command.args.join(" ") !== E2E_CHECK.args.join(" ")) return undefined;
          const run = runs++;
          return (once ? run === 0 : true) ? { exitCode: 1, stdout: "", stderr: "1 failing" } : undefined;
        },
      };
    },
    run: async (ctx) => { await ctx.e2e.settle(); },
  },
  reviews: {
    // A `findings` round: the code reviewer finds one HIGH problem once, then passes (`reviewerFindings` + `reviewerReply.pass`), and Rovara's automatic fix
    // (`af`, on as the core runs it) sends the work back. The coder writes the scenario's first `coding.done` files, and its second ones once it is told
    // the finding (the send-back's prompt carries the finding's text).
    options(scenario) {
      if (!scenario.steps.some((step) => step.do === "reviews" && step.outcome === "findings")) return {};
      const base = baseOptions(scenario).model!;
      const rounds = scenario.steps.filter((step): step is Extract<Step, { do: "coding.done" }> => step.do === "coding.done").map((step) => Object.entries(step.files).map(([path, content]) => ({ path: `repo/demo/${path}`, content })));
      const finding = reviewerFindings(1, { severity: "HIGH" });
      return {
        autofix: { enabled: true, capUsd: 5, roundEstimateUsd: 1 },
        model: { ...base, reviews: { CODE: [...(finding.CODE ?? []), reviewerReply.pass()] }, edits: (latest: string) => (latest.includes(FINDING_TEXT) ? rounds[1] ?? rounds[0] ?? [] : rounds[0] ?? []) },
      };
    },
    run: async (ctx) => { await ctx.e2e.settle(); },
  },
  published: settle,
  "task.stop": {
    async run(ctx) {
      const stopped = await asMaya(ctx, "POST", `/v1/dev/tasks/${ctx.e2e.taskId()}/cancel`, { requestId: randomUUID() });
      if (stopped.statusCode !== 200) throw new Error(`Cloud refused the stop (${String(stopped.statusCode)}): ${stopped.body.slice(0, 200)}`);
      await ctx.e2e.settle();
    },
  },
};
