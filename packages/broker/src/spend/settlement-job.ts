// Plan 3 Task 30: the scheduled settlement run (`{ source: "agentx.spend-settlement" }`, every 5 minutes). It is a list of independent jobs: one that
// fails never stops the others, and each is reported on its own. Task 30 adds the spend sweep; the approval expiry (Task 21), the member-merge drain
// (Task 11) and the owner-request escalation (Task 32) join the same list (PF13).
import { DeleteCommand, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { sweepSpend, type LedgerDependencies } from "./ledger.js";

/**
 * What each timed job of the scheduled run may take. The broker's function has 30 seconds; the budgets together stay under 27, so a job that ends a little
 * late (a page of work finishing, a call returning) still leaves the function its margin. The short jobs go first, the spend sweep takes what is left of the
 * 27 and resumes from its cursor on the next run, and the key audit is last and has the least. The member-merge drain (Task 11) has 5 seconds and the approvals'
 * sweep (Task 21) 4, both taken out of what the spend sweep had before they joined (18 seconds).
 */
export const SETTLEMENT_BUDGETS_MS = { drain: 5_000, approvals: 4_000, sources: 5_000, spend: 9_000, audit: 4_000 } as const;
export const SETTLEMENT_TOTAL_LIMIT_MS = 27_000;

export interface SettlementJob {
  name: string;
  run(): Promise<unknown>;
}

export type JobReport = { name: string; ok: true; result: unknown } | { name: string; ok: false; error: string };

/** Runs every job, in order, each on its own: a job that throws is reported and the rest still run. */
export async function runSettlementJobs(jobs: readonly SettlementJob[], log: (entry: Record<string, unknown>) => void = () => undefined): Promise<JobReport[]> {
  const reports: JobReport[] = [];
  for (const job of jobs) {
    try {
      reports.push({ name: job.name, ok: true, result: await job.run() });
    } catch (error) {
      const name = error instanceof Error ? error.name : "unknown";
      log({ event: "spend.settlement_job_failed", job: job.name, error: name });
      reports.push({ name: job.name, ok: false, error: name });
    }
  }
  return reports;
}

const CURSOR_KEY = { pk: "SPEND_SWEEP", sk: "CURSOR" } as const;

export interface SweepRun {
  pages: number;
  settled: number;
  finalized: number;
  failed: number;
  /** True when the run reached the end of the open keys; false when its time ran out and the next run resumes from the saved cursor. */
  complete: boolean;
}

/**
 * Sweeps pages of open keys until the end or until `budgetMs` has passed (the broker's function has 30 seconds). The deadline is also handed to each
 * page, which stops before a batch it has no time for, so a slow proxy costs at most one batch of calls past the budget. Where a run stops, the cursor
 * (the last key it took) is saved and the next run starts after it, so no key is starved or skipped; reaching the end clears it.
 */
export async function runSpendSweep(deps: LedgerDependencies, options: { budgetMs: number }): Promise<SweepRun> {
  const deadline = deps.now() + options.budgetMs;
  const saved = ((await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: CURSOR_KEY, ConsistentRead: true }))) as { Item?: { cursor?: unknown } }).Item?.cursor;
  let cursor = typeof saved === "string" ? saved : undefined;
  const run: SweepRun = { pages: 0, settled: 0, finalized: 0, failed: 0, complete: false };
  const save = async (): Promise<void> => {
    if (cursor === undefined) return;
    await deps.documentClient.send(new PutCommand({ TableName: deps.tableName, Item: { ...CURSOR_KEY, entityType: "SPEND_SWEEP_CURSOR", cursor, at: new Date(deps.now()).toISOString() } }));
  };
  for (;;) {
    const page = await sweepSpend(deps, deps.now(), cursor, { deadline });
    run.pages += 1;
    run.settled += page.settled;
    run.finalized += page.finalized;
    run.failed += page.failed;
    cursor = page.next ?? (page.stopped === true ? cursor : undefined);
    if (cursor === undefined) {
      run.complete = true;
      if (saved !== undefined) await deps.documentClient.send(new DeleteCommand({ TableName: deps.tableName, Key: CURSOR_KEY }));
      return run;
    }
    if (page.stopped === true || deps.now() >= deadline) {
      await save();
      return run;
    }
  }
}
