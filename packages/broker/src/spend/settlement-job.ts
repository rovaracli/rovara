// Plan 3 Task 30: the scheduled settlement run (`{ source: "agentx.spend-settlement" }`, every 5 minutes). It is a list of independent jobs: one that
// fails never stops the others, and each is reported on its own. Task 30 adds the spend sweep; the approval expiry (Task 21), the member-merge drain
// (Task 11) and the owner-request escalation (Task 32) join the same list (PF13).
import { DeleteCommand, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { sweepSpend, type LedgerDependencies } from "./ledger.js";

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
 * Sweeps pages of open keys until the end or until `budgetMs` has passed (the broker's function has 30 seconds). Where a run stops, the cursor is
 * saved, and the next run starts there, so keys late in the index are not starved by a long front; reaching the end clears it.
 */
export async function runSpendSweep(deps: LedgerDependencies, options: { budgetMs: number }): Promise<SweepRun> {
  const started = deps.now();
  const saved = ((await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: CURSOR_KEY, ConsistentRead: true }))) as { Item?: { cursor?: unknown } }).Item?.cursor;
  let cursor = typeof saved === "string" ? saved : undefined;
  const run: SweepRun = { pages: 0, settled: 0, finalized: 0, failed: 0, complete: false };
  for (;;) {
    const page = await sweepSpend(deps, deps.now(), cursor);
    run.pages += 1;
    run.settled += page.settled;
    run.finalized += page.finalized;
    run.failed += page.failed;
    cursor = page.next;
    if (cursor === undefined) {
      run.complete = true;
      if (saved !== undefined) await deps.documentClient.send(new DeleteCommand({ TableName: deps.tableName, Key: CURSOR_KEY }));
      return run;
    }
    if (deps.now() - started >= options.budgetMs) {
      await deps.documentClient.send(new PutCommand({ TableName: deps.tableName, Item: { ...CURSOR_KEY, entityType: "SPEND_SWEEP_CURSOR", cursor, at: new Date(deps.now()).toISOString() } }));
      return run;
    }
  }
}
