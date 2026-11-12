// The parity suite's CLOUD engine: Cloud's own path, end to end, through the existing workflow journey harness (tests/support/workflow-e2e.ts): a signed
// Slack mention through the real slack-ingress and broker, the real notifier on a strict Slack double, and a real worker running run-task on the faux model
// against a real git repository, GitHub faked.
//
// The faux model is scripted from the scenario before it starts (the plan, a revised plan, the coder's edits, a check's result); a domain step then maps to
// what a person does on Cloud's path (mention, a button, a modal) or, for worker steps, to letting the path run (`settle`). Every write to the table is
// watched, so the transitions are every state the task passed through, whatever the granularity of the steps.
import { randomUUID } from "node:crypto";
import { bearerFor } from "../../support/developer-task-broker.js";
import { createWorkflowE2E, E2E_CHECK, SLACK_MAYA, type WorkflowE2E } from "../../support/workflow-e2e.js";
import { keyFamily } from "../harness/normalize.js";
import type { Facet, Observation, ParityEngine, PlanSpec, Scenario, Step, StepSupport } from "../harness/types.js";
import { planTextOf, stateWord } from "./core.js";

const SUPPORTED: ReadonlySet<Step["do"]> = new Set(["start", "plan.proposed", "plan.approve", "plan.requestChanges", "coding.done", "checks", "reviews", "published", "task.stop", "pr.merged"]);

export class CloudEngine implements ParityEngine {
  readonly name = "cloud";

  supports(step: Step): StepSupport {
    if (step.do === "reviews" && step.outcome === "findings") return { unsupported: "the faux reviewers' findings script is not mapped yet" };
    return SUPPORTED.has(step.do) ? true : { unsupported: "no driver for this step in the Cloud engine yet" };
  }

  observes(facet: Facet): StepSupport {
    if (facet === "spend") return { unsupported: "the journey harness has no spend ledger reader yet" };
    if (facet === "audit") return { unsupported: "Cloud's audit outbox rows are not mapped to event names yet (A7's event map is the source once merged)" };
    return true;
  }

  async run(scenario: Scenario): Promise<Observation> {
    const plans = scenario.steps.flatMap((step) => (step.do === "plan.proposed" ? [step.plan] : step.do === "plan.requestChanges" ? [step.revised] : []));
    const notes = scenario.steps.flatMap((step) => (step.do === "plan.requestChanges" ? [step.note] : []));
    const coding = scenario.steps.find((step): step is Extract<Step, { do: "coding.done" }> => step.do === "coding.done");
    const failChecks = scenario.steps.some((step) => step.do === "checks" && step.outcome === "fail");
    // A fail followed by a pass fails the first run only (the worker's extra try passes); a fail with no pass after it fails every run.
    const failsOnce = scenario.steps.some((step, index) => step.do === "checks" && step.outcome === "fail" && scenario.steps[index + 1]?.do === "checks" && (scenario.steps[index + 1] as { outcome?: string }).outcome === "pass");
    let checkRuns = 0;
    const firstPlan: PlanSpec = plans[0] ?? { title: "No plan", claims: ["Nothing."] };
    const e2e: WorkflowE2E = await createWorkflowE2E({
      model: {
        plan: (latest) => planTextOf(notes.some((note) => latest.includes(note)) && plans[1] !== undefined ? plans[1] : firstPlan),
        edits: Object.entries(coding?.files ?? {}).map(([path, content]) => ({ path: `repo/demo/${path}`, content })),
      },
      // One failing run of the project check, then passing (a check failure the path fixes by itself).
      // The automatic fix on, as the core runs it (a failing check is sent back to the coder): Cloud's switch `af`.
      ...(failChecks ? { autofix: { enabled: true, capUsd: 5, roundEstimateUsd: 1 } } : {}),
      // The journey worker runs the project check once after the change (no baseline run): run 0 is that run, later runs are reruns after a fix.
      checkResult: (command) => {
        if (process.env.PARITY_DEBUG === "1") console.log(JSON.stringify({ parity: "cloud.checkAsked", command: command.executable, args: command.args }));
        if (!failChecks || command.executable !== E2E_CHECK.executable || command.args.join(" ") !== E2E_CHECK.args.join(" ")) return undefined;
        const run = checkRuns++;
        if (process.env.PARITY_DEBUG === "1") console.log(JSON.stringify({ parity: "cloud.check", run, command: command.args }));
        return (failsOnce ? run === 0 : true) ? { exitCode: 1, stdout: "", stderr: "1 failing" } : undefined;
      },
    });
    const states: string[] = [];
    const keys = new Set<string>();
    let decisions: string[] = [];
    e2e.db.onWrite((change) => {
      const item = change.after ?? change.before;
      if (item === undefined) return;
      keys.add(keyFamily(String(item.pk), String(item.sk)));
      const workflow = change.after?.workflow as { stage?: string; state?: string; blockReason?: string; decisions?: Array<{ decision: string }> } | undefined;
      if (String(item.pk).startsWith("DEVTASK#") && item.sk === "META" && workflow?.stage !== undefined) {
        states.push(stateWord(workflow));
        decisions = (workflow.decisions ?? []).map((decision) => decision.decision);
      }
    });
    for (const step of scenario.steps) {
      switch (step.do) {
        case "start":
          if (await e2e.mention(`${step.path === "FULL" ? "full" : "quick"}: ${step.request}`) !== 200) throw new Error("Cloud refused the mention");
          await e2e.settle();
          break;
        case "plan.proposed": break; // the planner ran on the mention's settle
        case "plan.approve": await e2e.click("agentx_workflow_approve"); await e2e.settle(); break;
        case "plan.requestChanges":
          await e2e.click("agentx_workflow_changes");
          await e2e.submitView({ workflow_feedback: { reason: { value: step.note } } });
          await e2e.settle();
          break;
        case "coding.done": case "checks": case "reviews": case "published": await e2e.settle(); break; // the path runs these by itself after the approval
        case "task.stop": {
          const stopped = await e2e.handler({
            version: "2.0", rawPath: `/v1/dev/tasks/${e2e.taskId()}/cancel`, rawQueryString: "", headers: { authorization: await bearerFor(SLACK_MAYA), "content-type": "application/json" },
            requestContext: { requestId: randomUUID(), http: { method: "POST" } }, body: JSON.stringify({ requestId: randomUUID() }), isBase64Encoded: false,
          });
          if (stopped.statusCode !== 200) throw new Error(`Cloud refused the stop (${String(stopped.statusCode)}): ${stopped.body.slice(0, 200)}`);
          await e2e.settle();
          break;
        }
        case "pr.merged": await e2e.githubWebhook(e2e.github.pullRequests[0]!.number, { merged: true }); await e2e.settle(); break;
        default: throw new Error(`the Cloud engine does not drive ${step.do}`);
      }
    }
    return {
      transitions: states, decisions, rows: [...keys],
      messages: e2e.slack.posts.map((post) => `slack:${post.text.split("\n")[0]!.slice(0, 40)}`),
      codeHost: e2e.github.pullRequests.map((pull) => (pull.draft === false ? "open_pr" : "open_draft_pr")),
      spend: [], audit: [],
    };
  }

  dispose(): Promise<void> { return Promise.resolve(); }
}
