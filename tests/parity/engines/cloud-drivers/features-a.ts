// Cloud drivers: Second review, design review, e2e, parallel parts, lessons (areas 8, 9, 10, 11, 14).
//
// parallel-parts (area 11) follows Cloud's own journey (tests/contract/rovara-code-parallel-parts-journey.test.ts): a Full task made a Rovara Code
// version 2 task (definition 1.1.0) before its plans are approved, three approvals, the real worker building A and B side by side and C on both, the
// project's readiness check run on the integrated tree, one pull request.
//
// The other four features have no driver on Cloud's path yet; each `supports` says what is missing.
import type { WorkflowE2E } from "../../../support/workflow-e2e.js";
import type { CloudContext, CloudOptions } from "../cloud-context.js";
import type { StepDriver } from "../drivers.js";
import { PART_FILES, partsPlan } from "../features-a-support/parts.js";
import type { Step } from "../../harness/types.js";

type Driver = StepDriver<CloudContext, CloudOptions>;

/** The harness under the scenario, known once it starts (the faux planner names the task's id in the graph). */
const current: { e2e?: WorkflowE2E } = {};

function itemEdits(latest: string): Array<{ path: string; content: string }> {
  const title = latest.match(/Current approved item[^\n]*\nTitle: (.*)/)?.[1];
  // Parts built side by side work in a folder whose root is the repository; one after another they work in the workspace (repo/demo).
  const where = (file: string) => `${/built at the same time/.test(latest) ? "" : "repo/demo/"}${file}`;
  const part = title?.startsWith("A:") === true ? PART_FILES["11111111-1111-4111-8111-111111111111"] : title?.startsWith("B:") === true ? PART_FILES["22222222-2222-4222-8222-222222222222"] : title?.startsWith("C:") === true ? PART_FILES["33333333-3333-4333-8333-333333333333"] : undefined;
  return Object.entries(part ?? {}).map(([file, content]) => ({ path: where(file), content }));
}

const unsupported = (why: string): Driver => ({ supports: () => ({ unsupported: why }), run: () => Promise.reject(new Error(why)) });

export const FEATURES_A_DRIVERS: Record<string, Driver> = {
  "feature:parallel-parts": {
    options: () => ({
      readiness: [{ cwd: "repo/demo", executable: "node", args: ["integration.mjs"], timeoutSeconds: 30 }],
      realProjectCommands: true,
      model: {
        plan: (latest: string) => partsPlan(current.e2e!.taskId(), /writing the requirements/i.test(latest) ? "requirements" : /writing the design/i.test(latest) ? "design" : "plan"),
        edits: itemEdits,
      },
    }),
    async prepare(ctx) { current.e2e = ctx.e2e; },
    async run(ctx) {
      const e2e = ctx.e2e;
      // A version 2 task, as an org on Rovara Code version 2 has it (the journey's own step: Cloud's v1 path refuses a graph without the install switch).
      const key = { pk: `DEVTASK#${e2e.taskId()}`, sk: "META" };
      const task = e2e.db.get(key.pk, key.sk) as { workflow: Record<string, unknown> };
      e2e.db.set({ ...key, ...task, workflow: { ...task.workflow, definitionVersion: "1.1.0" } });
      // Requirements, design and the coding plan, each approved (a modal may ask for the optional checks).
      for (let index = 0; index < 3; index += 1) {
        if (e2e.slack.lastPostWithAction("agentx_workflow_approve") === undefined) break;
        const views = e2e.slack.views.length;
        await e2e.click("agentx_workflow_approve");
        if (e2e.slack.views.length > views) await e2e.submitView();
        await e2e.settle();
      }
      const progress = ((e2e.workflow() as unknown as { workflowDependenciesProgress?: Array<{ itemId: string; state: string }> }).workflowDependenciesProgress ?? []);
      ctx.memo.partsProgress = progress.map((entry) => `${entry.itemId.slice(0, 1)}:${entry.state}`);
    },
  },
  "feature:second-review": unsupported("Cloud's second review (switch `cr`, packages/broker/src/rovara-code/second-review*.ts) is not reachable through the journey harness: it needs a company setting, a second model of another AI company the faux model answers as that company, and the model proxy's call record; no journey suite drives it today"),
  "feature:design-review": unsupported("Cloud's design review (switch `dr`, packages/broker/src/design-review/) runs fresh-context reviewer runs on the worker with mockups and a cost hold; the journey harness has no design-review program or reviewer script (its suites use tests/support/design-review-world.ts, not the journey)"),
  "feature:e2e": unsupported("Cloud's application checks (packages/broker/src/e2e/, workflow-e2e-*.ts) need an E2E-capable worker run with a candidate export, accounts and a browser; the journey harness's `e2ePolicy` option only exercises publication admission, not the rounds"),
  "feature:lessons": unsupported("Cloud's lessons need the team record (switches `tn`, `ll`), the embedder and lesson approvals (tests/support/learning-world.ts); the journey harness has no team record, so no lesson can be captured, approved or loaded through it"),
};

export type { Step };
