// Convergence S0: the core's timers as Cloud schedules (plan finding 5). Code runs these from `setInterval` in one process (relay and dispatch every 2 s,
// merge tracking every 5 s); Cloud runs each from an EventBridge schedule (1-minute minimum, accepted latency) or from the existing stream reader.
//
// One table names every job: its area (it runs only for companies whose switch covers the area), how it is triggered, and what it calls. A new job is
// one row. The schedules themselves are an AWS change (G-AWS) and are NOT in the stack yet; `scheduleEventOf` names the event a schedule would send.
//
// Per-company isolation (DEFERRED OUTBOX-HOOK-COMPANY-SKIP): each company runs in its own try/catch, so one company's failure never skips the others,
// and the order rotates by run so a time budget never defers the same tail companies every time.
import type { CoreRuntime, CoreServiceName } from "./core-runtime.js";
import type { CoreArea } from "./flags.js";

export type JobTrigger = { kind: "schedule"; rate: string } | { kind: "stream"; on: "outbox-insert" };

export interface CoreJob {
  name: string;
  area: CoreArea;
  trigger: JobTrigger;
  run(runtime: CoreRuntime, budgetMs: number): Promise<Record<string, unknown>>;
}

const service = (name: CoreServiceName) => async (runtime: CoreRuntime, budgetMs: number): Promise<Record<string, unknown>> => {
  const wired = runtime.services[name];
  if (wired === undefined) return { skipped: "service_not_wired" };
  return await wired.pass({ budgetMs });
};

export const CORE_JOBS: readonly CoreJob[] = [
  // A2: the outbox relay. The stream reader runs it on an outbox insert; the schedule is the backstop for a missed insert.
  { name: "outbox-relay", area: "flow", trigger: { kind: "stream", on: "outbox-insert" }, run: async (runtime) => ({ ...(await runtime.flow.relayOnce()) }) },
  { name: "outbox-relay-backstop", area: "flow", trigger: { kind: "schedule", rate: "rate(1 minute)" }, run: async (runtime) => ({ ...(await runtime.flow.relayOnce()) }) },
  // The recovery sweep over due workflow dispatch rows (Code: every 2 s).
  { name: "dispatch-sweep", area: "flow", trigger: { kind: "schedule", rate: "rate(1 minute)" }, run: async (runtime) => ({ ...(await runtime.flow.sweepOnce()) }) },
  // Merge tracking's sweep (Cloud also wakes a row from the GitHub webhook).
  { name: "merge-tracking", area: "merge", trigger: { kind: "schedule", rate: "rate(1 minute)" }, run: service("merge-tracking") },
  { name: "session-sweep", area: "flow", trigger: { kind: "schedule", rate: "rate(5 minutes)" }, run: service("session-sweep") },
  { name: "notify-deliver", area: "flow", trigger: { kind: "schedule", rate: "rate(5 minutes)" }, run: service("notify-deliver") },
  // A5 open question 3: a hold whose caller died is charged in full by CloudAdmission.sweepExpiredHolds, on a schedule.
  { name: "admission-hold-sweep", area: "flow", trigger: { kind: "schedule", rate: "rate(15 minutes)" }, run: service("admission-hold-sweep") },
];

export const CORE_SCHEDULE_SOURCE = "agentx.core-job";

export function scheduleEventOf(job: CoreJob): { source: typeof CORE_SCHEDULE_SOURCE; job: string } {
  return { source: CORE_SCHEDULE_SOURCE, job: job.name };
}

export function isCoreJobEvent(event: unknown): event is { source: typeof CORE_SCHEDULE_SOURCE; job: string } {
  return event !== null && typeof event === "object" && (event as { source?: unknown }).source === CORE_SCHEDULE_SOURCE && typeof (event as { job?: unknown }).job === "string";
}

export interface CompanyRunReport {
  companyId: string;
  outcome: "ran" | "failed" | "deferred";
  report?: Record<string, unknown>;
  error?: string;
}

/**
 * Runs `work` for each company, isolated: a throw is recorded for that company only. The start rotates by `rotation` (the caller passes a counter, such
 * as the minute), and a company not reached before the budget runs out is `deferred`, not failed.
 */
export async function runPerCompany(companies: readonly string[], work: (companyId: string) => Promise<Record<string, unknown>>, options: { rotation: number; budgetMs: number; nowMs: () => number }): Promise<CompanyRunReport[]> {
  const count = companies.length;
  if (count === 0) return [];
  const start = ((options.rotation % count) + count) % count;
  const ordered = [...companies.slice(start), ...companies.slice(0, start)];
  const deadline = options.nowMs() + options.budgetMs;
  const reports: CompanyRunReport[] = [];
  for (const companyId of ordered) {
    if (options.nowMs() >= deadline) { reports.push({ companyId, outcome: "deferred" }); continue; }
    try {
      reports.push({ companyId, outcome: "ran", report: await work(companyId) });
    } catch (error) {
      reports.push({ companyId, outcome: "failed", error: error instanceof Error ? error.name : "unknown" });
    }
  }
  return reports;
}
