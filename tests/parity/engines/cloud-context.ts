// The parity suite's CLOUD engine context: Cloud's own path, end to end, through the workflow journey harness (tests/support/workflow-e2e.ts): a signed
// Slack mention through the real slack-ingress and broker, the real notifier on a strict Slack double, and a real worker running run-task on the faux model
// against a real git repository, GitHub faked. Step drivers (cloud-drivers/*.ts) act on this context.
//
// The faux model is scripted from the scenario before it starts (the plan, a revised plan, the coder's edits); each driver may add harness options
// (`options`). Every write to the table is watched, so the transitions are every state the task passed through, whatever the granularity of the steps.
import { createWorkflowE2E, type WorkflowE2E } from "../../support/workflow-e2e.js";
import { keyFamily } from "../harness/normalize.js";
import type { PlanSpec, Scenario, Step } from "../harness/types.js";
import { planTextOf, stateWord } from "./core-context.js";

export type CloudOptions = NonNullable<Parameters<typeof createWorkflowE2E>[0]>;

export interface CloudContext {
  scenario: Scenario;
  e2e: WorkflowE2E;
  states: string[];
  keys: Set<string>;
  decisions: string[];
  extra: { messages: string[]; spend: string[]; audit: string[]; codeHost: string[] };
  /** Free state a driver keeps between its steps. */
  memo: Record<string, unknown>;
}

/** The harness options every scenario needs: the planner and coder scripted from its steps. */
export function baseOptions(scenario: Scenario): CloudOptions {
  const plans = scenario.steps.flatMap((step) => (step.do === "plan.proposed" ? [step.plan] : step.do === "plan.requestChanges" ? [step.revised] : []));
  const notes = scenario.steps.flatMap((step) => (step.do === "plan.requestChanges" ? [step.note] : []));
  const coding = scenario.steps.find((step): step is Extract<Step, { do: "coding.done" }> => step.do === "coding.done");
  const firstPlan: PlanSpec = plans[0] ?? { title: "Add greet(name)", claims: ["Add greet to greeting.ts.", "A test in greeting.test.ts proves greet(\"Maya\") returns Hello, Maya."] };
  return {
    model: {
      plan: (latest) => planTextOf(notes.some((note) => latest.includes(note)) && plans[1] !== undefined ? plans[1] : firstPlan),
      edits: Object.entries(coding?.files ?? {}).map(([path, content]) => ({ path: `repo/demo/${path}`, content })),
    },
  };
}

export async function createCloudContext(scenario: Scenario, options: CloudOptions): Promise<CloudContext> {
  const e2e = await createWorkflowE2E(options);
  const ctx: CloudContext = { scenario, e2e, states: [], keys: new Set(), decisions: [], extra: { messages: [], spend: [], audit: [], codeHost: [] }, memo: {} };
  e2e.db.onWrite((change) => {
    const item = change.after ?? change.before;
    if (item === undefined) return;
    ctx.keys.add(keyFamily(String(item.pk), String(item.sk)));
    const workflow = change.after?.workflow as { stage?: string; state?: string; blockReason?: string; decisions?: Array<{ decision: string }> } | undefined;
    if (String(item.pk).startsWith("DEVTASK#") && item.sk === "META" && workflow?.stage !== undefined) {
      ctx.states.push(stateWord(workflow));
      ctx.decisions = (workflow.decisions ?? []).map((decision) => decision.decision);
    }
  });
  return ctx;
}
