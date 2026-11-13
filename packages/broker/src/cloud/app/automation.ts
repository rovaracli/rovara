// Convergence S0-143c (owner decision 143c): the core's automation switch is Cloud's `chains` feature, and turning it off stops what already runs.
//
// The switch. Code's core reads an `AutomationSwitch` at the unattended door on every start (vendor core/automation/run-seam.ts): off, every automatic start is refused with
// NOT_AVAILABLE_HERE: a trigger's event or schedule, a chain's next step, an automatic job. Cloud's switch is the `chains` name in WEB_FEATURES
// (chains/automations-gate.ts). `cloudAutomationSwitch` is that switch in the core's shape, read on every use. Cloud's own engine reads the same switch now
// (`ChainRunnerDependencies.automations`), so the two engines agree: off is off for a new start on either.
//
// The stop. Refusing a start leaves the runs already started. `stopAutomationsWhenOff` ends them, from a scheduled job (the `automation-stop` job, once a minute), at a safe point:
//   - a chain run is cancelled through the core's own `cancelChainRun`: the run ends `cancelled`, its running step's task is asked to stop and a late end of that task is ignored;
//   - a run a trigger or a schedule started on its own (an open unattended run that is no chain's step) has its task stopped, and the core's `sweepUnattendedRuns` then settles
//     its reservation when the task has ended;
//   - a safe point (`automationStopSafe`, shared with Cloud's engine) is any moment that leaves no work half done. A task that is opening or updating its pull request, or merging the
//     base into its branch, is left until the next pass, and a run is never started further meanwhile (the door refuses). Nothing is ever merged by a stop: a merge is a person's act.
// On again resumes nothing by itself: a cancelled run stays cancelled, and a deferred stop has nothing to do once the switch is on (the pass does nothing while it is on).
import { automationIsOn, sweepUnattendedRuns, type AutomationSwitch, type UnattendedStartDeps } from "@rovara-code/broker/core/automation";
import { OPEN_CHAIN_RUNS_PK, cancelChainRun, isTerminalStatus, readChainRun, readStepAttempts, type ChainRunnerDeps } from "@rovara-code/broker/core/chains";
import { orgScoped, queryAll, type DocumentStore, type OrgId } from "@rovara-code/contracts";
import { automationStopSafe, automationsEnabled } from "../../chains/automations-gate.js";

/** Cloud's switch (WEB_FEATURES `chains`) in the core's shape. Read on every use, so a switch that changes needs no restart. */
export function cloudAutomationSwitch(env: () => NodeJS.ProcessEnv = () => process.env): AutomationSwitch {
  return { enabled: () => automationsEnabled(env()) };
}

/** The partition of a company's open unattended runs (vendor core/automation/run-seam.ts OPEN_RUN_PARTITION; a test reads the vendored source to hold the two together). */
export const OPEN_UNATTENDED_RUNS = "UNATTENDED_RUN_OPEN";

export interface AutomationStopDeps {
  automation: AutomationSwitch;
  companyId: OrgId;
  store: DocumentStore;
  /** The core's chain runner (it cancels a run and stops its running step's task). */
  chains: ChainRunnerDeps;
  /** The core's unattended door (its store, task view and admission settle a stopped run's reservation). */
  unattended: UnattendedStartDeps;
  /** The task's workflow as stored (`{ stage, state }`), or undefined when it has none or is gone: the safe point is read from it. */
  taskWorkflow(taskId: string): Promise<{ stage?: unknown; state?: unknown } | undefined>;
  log?: (entry: Record<string, unknown>) => void;
}

export interface AutomationStopReport {
  /** `on`: nothing was done. */
  switch: "on" | "off";
  chainRunsCancelled: number;
  runsStopped: number;
  /** Runs left for the next pass because their task is not at a safe point. */
  deferred: number;
  /** Reservations settled for runs whose task had ended. */
  settled: number;
}

const BY = "automations turned off";

/** One pass. While the switch is on it does nothing at all. */
export async function stopAutomationsWhenOff(deps: AutomationStopDeps): Promise<AutomationStopReport> {
  const report: AutomationStopReport = { switch: "off", chainRunsCancelled: 0, runsStopped: 0, deferred: 0, settled: 0 };
  if (await automationIsOn(deps.automation)) return { ...report, switch: "on" };
  const log = deps.log ?? (() => undefined);
  const safe = async (taskId: string): Promise<boolean> => automationStopSafe(await deps.taskWorkflow(taskId).catch(() => ({ stage: "PULL_REQUEST", state: "RUNNING" }))); // a task that cannot be read is not known to be safe

  // The chain runs of this company.
  for (const row of await queryAll(deps.store, { pk: OPEN_CHAIN_RUNS_PK })) {
    if (row["orgId"] !== deps.companyId || typeof row["runId"] !== "string") continue;
    try {
      const run = await readChainRun(deps.chains, deps.companyId, row["runId"]);
      if (run === undefined || isTerminalStatus(run.status)) continue;
      const attempt = run.currentSeq === 0 ? undefined : (await readStepAttempts(deps.chains, deps.companyId, run.runId)).find((candidate) => candidate.seq === run.currentSeq);
      if (attempt?.taskId !== undefined && (attempt.status === "running" || attempt.status === "starting") && !(await safe(attempt.taskId))) { report.deferred += 1; continue; }
      await cancelChainRun(deps.chains, deps.companyId, run.runId, BY);
      report.chainRunsCancelled += 1;
    } catch (error) {
      log({ event: "automation_stop.chain_run_failed", error: error instanceof Error ? error.name : "unknown" });
    }
  }

  // The runs a trigger or a schedule started on their own (a chain's step is its run's, above).
  for (const row of await queryAll(deps.store, { pk: orgScoped(deps.companyId, OPEN_UNATTENDED_RUNS) })) {
    const taskId = row["taskId"];
    if (typeof taskId !== "string" || row["origin"] === "chain") continue;
    try {
      const state = await deps.unattended.tasks?.read(taskId);
      if (state === undefined || state.end !== undefined) continue; // over: the sweep below settles it
      if (!(await safe(taskId))) { report.deferred += 1; continue; }
      await deps.unattended.tasks?.cancel(taskId);
      report.runsStopped += 1;
    } catch (error) {
      log({ event: "automation_stop.run_failed", error: error instanceof Error ? error.name : "unknown" });
    }
  }
  report.settled = (await sweepUnattendedRuns(deps.unattended)).settled;
  return report;
}
