// The parity suite's CLOUD engine context: Cloud's own path, end to end, through the workflow journey harness (tests/support/workflow-e2e.ts): a signed
// Slack mention through the real slack-ingress and broker, the real notifier on a strict Slack double, and a real worker running run-task on the faux model
// against a real git repository, GitHub faked. Step drivers (cloud-drivers/*.ts) act on this context.
//
// The faux model is scripted from the scenario before it starts (the plan, a revised plan, the coder's edits); each driver may add harness options
// (`options`). Every write to the table is watched, so the transitions are every state the task passed through, whatever the granularity of the steps.
import { capturingAuditDeps, type AuditCapture } from "../../support/audit-capture.js";
import { createWorkflowE2E, type WorkflowE2E } from "../../support/workflow-e2e.js";
import { spendWordOf } from "./facets-support/spend.js";
import { keyFamily } from "../harness/normalize.js";
import type { PlanSpec, Scenario, Step } from "../harness/types.js";
import { planTextOf, stateWord } from "./core-context.js";

export type CloudOptions = NonNullable<Parameters<typeof createWorkflowE2E>[0]>;

export interface CloudContext {
  scenario: Scenario;
  e2e: WorkflowE2E;
  /** Cloud's audit outbox, as the broker writes it (the audit facet). */
  audit: AuditCapture;
  /** Audit events the harness's own set-up wrote before the scenario's first step (its project registration): not the scenario's, so not compared (rows are watched from the same point). */
  auditSetup: number;
  /** What Cloud's path did with money, in the core engine's words (the spend facet, facets-support/spend.ts). */
  spend: string[];
  states: string[];
  keys: Set<string>;
  decisions: string[];
  extra: { messages: string[]; spend: string[]; audit: string[]; codeHost: string[]; features: string[] };
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
    // Production gives every task a session at start (aws/broker.ts:653, aws/developer-tasks/start.ts createTaskSessionItems); the journey harness builds the agent-session wiring only when asked.
    agentSessions: true,
    model: {
      plan: (latest) => planTextOf(notes.some((note) => latest.includes(note)) && plans[1] !== undefined ? plans[1] : firstPlan),
      edits: Object.entries(coding?.files ?? {}).map(([path, content]) => ({ path: `repo/demo/${path}`, content })),
    },
  };
}

export async function createCloudContext(scenario: Scenario, options: CloudOptions): Promise<CloudContext> {
  // The Audit Ledger is on, as on a deployed install (the journey harness's default is a legacy install with no ledger). A driver may give its own capture.
  const audit = options.audit ?? capturingAuditDeps();
  const e2e = await createWorkflowE2E({ ...options, audit });
  const ctx: CloudContext = { scenario, e2e, audit, auditSetup: audit.flushed().length + audit.pending().length, spend: [], states: [], keys: new Set(), decisions: [], extra: { messages: [], spend: [], audit: [], codeHost: [], features: [] }, memo: {} };
  e2e.db.onWrite((change) => {
    const item = change.after ?? change.before;
    if (item === undefined) return;
    const spent = spendWordOf(change);
    if (spent !== undefined) ctx.spend.push(spent);
    ctx.keys.add(keyFamily(String(item.pk), String(item.sk)));
    const workflow = change.after?.workflow as { stage?: string; state?: string; blockReason?: string; decisions?: Array<{ decision: string }> } | undefined;
    if (String(item.pk).startsWith("DEVTASK#") && item.sk === "META" && workflow?.stage !== undefined) {
      ctx.states.push(stateWord(workflow));
      ctx.decisions = (workflow.decisions ?? []).map((decision) => decision.decision);
    }
  });
  return ctx;
}

/** The audit actions the scenario's steps made Cloud's path record (the set-up's left out, see `auditSetup`). */
export function scenarioAudit(ctx: CloudContext): string[] {
  return [...ctx.audit.flushed(), ...ctx.audit.pending()].slice(ctx.auditSetup).map((event) => event.action);
}
