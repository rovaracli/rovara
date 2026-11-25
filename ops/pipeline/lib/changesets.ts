// Change sets by name (L2-STAGE-CLI-INTERFACE.md 4): preview with cdk --no-execute, record names only, verify id and template hash, execute BY NAME.
// Ported from the staging pack's deploy.sh (verify_change_set, the execute loop, the tidy) for the Cloud stacks.
import { StageError } from "../types.ts";
import type { ChangeCounts, ChangeRow, ChangeSetRecord, Ports, StackPart } from "../types.ts";

export function countRows(rows: readonly ChangeRow[]): ChangeCounts {
  const counts: ChangeCounts = { add: 0, modify: 0, remove: 0, replace: 0 };
  for (const row of rows) {
    if (row.action === "Add") counts.add += 1;
    else if (row.action === "Modify") counts.modify += 1;
    else if (row.action === "Remove") counts.remove += 1;
    if (row.replacement === "True" || row.replacement === "Conditional") counts.replace += 1;
  }
  return counts;
}

const NO_CHANGES = /didn't contain changes|did not contain changes|no updates are to be performed/iu;
const SETTLED = ["UPDATE_COMPLETE", "CREATE_COMPLETE"];

export interface PreviewArgs {
  ports: Ports;
  dir: string;
  changeSetName: string;
  /** The stacks of one cdk call, in order: the part, the stack name and the cdk stack id. */
  stacks: ReadonlyArray<{ part: StackPart; stack: string; stackId: string }>;
  context: Record<string, string>;
  /** Handed to EACH stack of the call by name (every stack named here must declare all of them). */
  parameters: Record<string, string>;
  log: (line: string) => void;
}

/** Creates (never executes) one change set per stack and records it. A stack with no change set is `noChanges`. */
export async function previewChangeSets(args: PreviewArgs): Promise<ChangeSetRecord[]> {
  try {
    return await previewChangeSetsInner(args);
  } catch (error) {
    // A preview that failed (cdk refused, a change set is missing or FAILED for a real reason) leaves nothing behind that a later run or a person could mistake for a usable one.
    await discardChangeSets(args.ports, args.stacks.map((s) => s.stack), args.changeSetName, args.log);
    throw error;
  }
}

async function previewChangeSetsInner(args: PreviewArgs): Promise<ChangeSetRecord[]> {
  const { ports } = args;
  await ports.cdk.deployNoExecute({ dir: args.dir, stacks: args.stacks.map((s) => ({ stackId: s.stackId, stackName: s.stack, parameters: args.parameters })), changeSetName: args.changeSetName, context: args.context });
  const records: ChangeSetRecord[] = [];
  for (const { part, stack } of args.stacks) {
    const found = await ports.cfn.describeChangeSet(stack, args.changeSetName);
    const previewedAt = ports.clock.now().toISOString();
    // `cdk deploy --no-execute` always leaves a change set: CloudFormation's own "didn't contain changes" answer (FAILED) is the only way a stack is "no changes".
    // A change set that is absent after a successful cdk call is unexpected, and never counts as "nothing to do".
    if (found === null) throw new StageError("CHANGE_SET_MISMATCH", `${stack}: cdk succeeded but the change set ${args.changeSetName} does not exist`);
    if (found.status === "FAILED" && NO_CHANGES.test(found.statusReason ?? "")) {
      args.log(`${stack}: no changes`);
      records.push({ part, stack, changeSetName: args.changeSetName, changeSetId: null, noChanges: true, status: found.status, executionStatus: found.executionStatus, templateSha256: null, rows: [], counts: countRows([]), previewedAt, executedAt: null, finalStatus: null });
      continue;
    }
    if (found.status !== "CREATE_COMPLETE") throw new StageError("CHANGE_SET_MISMATCH", `${stack}: the change set ${args.changeSetName} is ${found.status} (${found.statusReason ?? "no reason given"})`);
    const templateSha256 = await ports.cfn.templateSha256(stack, args.changeSetName);
    const counts = countRows(found.rows);
    args.log(`${stack}: change set ${args.changeSetName} ${found.id.slice(-12)}: +${counts.add} ~${counts.modify} -${counts.remove} replace ${counts.replace}`);
    records.push({ part, stack, changeSetName: args.changeSetName, changeSetId: found.id, noChanges: false, status: found.status, executionStatus: found.executionStatus, templateSha256, rows: found.rows, counts, previewedAt, executedAt: null, finalStatus: null });
  }
  return records;
}

/** Re-reads the change set and refuses unless it is exactly the recorded one (id, status, template hash). Returns the live execution status. */
export async function verifyRecorded(ports: Ports, record: ChangeSetRecord): Promise<string> {
  const live = await ports.cfn.describeChangeSet(record.stack, record.changeSetName);
  if (live === null) throw new StageError("CHANGE_SET_MISMATCH", `${record.stack}: the change set ${record.changeSetName} cannot be read`);
  if (live.id !== record.changeSetId) throw new StageError("CHANGE_SET_MISMATCH", `${record.stack}: the change set in CloudFormation is not the one previewed (different id)`);
  if (live.executionStatus === "EXECUTE_COMPLETE" || live.executionStatus === "EXECUTE_IN_PROGRESS") return live.executionStatus;
  if (live.status !== "CREATE_COMPLETE" || live.executionStatus !== "AVAILABLE") throw new StageError("CHANGE_SET_MISMATCH", `${record.stack}: the change set is ${live.status}/${live.executionStatus}, not available (the environment changed after the preview)`);
  const hash = await ports.cfn.templateSha256(record.stack, record.changeSetName);
  if (hash !== record.templateSha256) throw new StageError("CHANGE_SET_MISMATCH", `${record.stack}: the change set's template is not the one previewed`);
  return live.executionStatus;
}

export interface ExecuteArgs {
  ports: Ports;
  records: readonly ChangeSetRecord[];
  settleTimeoutSeconds: number;
  log: (line: string) => void;
}

/**
 * Executes the recorded change sets in order, one stack at a time: verify immediately before each execute, execute BY NAME, wait,
 * require a settled stack, and confirm the change set of that name is still the recorded one. A change set already executing or executed
 * (a retried action) is waited for, not executed again. Returns updated records.
 */
export async function executeRecorded(args: ExecuteArgs): Promise<ChangeSetRecord[]> {
  const { ports } = args;
  const out: ChangeSetRecord[] = [];
  for (const record of args.records) {
    if (record.noChanges) { args.log(`${record.stack}: no changes, nothing to execute`); out.push(record); continue; }
    const before = await verifyRecorded(ports, record);
    const stack = await ports.cfn.describeStack(record.stack);
    if (before === "AVAILABLE" && (stack === null || !SETTLED.includes(stack.status))) throw new StageError("REFUSED", `${record.stack} is ${stack?.status ?? "absent"}, not settled: nothing is executed on it`);
    if (before === "AVAILABLE") {
      args.log(`${record.stack}: executing ${record.changeSetName}`);
      await ports.cfn.executeChangeSet(record.stack, record.changeSetName);
    } else args.log(`${record.stack}: ${record.changeSetName} is already ${before}; waiting for it`);
    const finalStatus = await ports.cfn.waitSettled(record.stack, args.settleTimeoutSeconds);
    const after = await ports.cfn.describeChangeSet(record.stack, record.changeSetName);
    if (after === null || after.id !== record.changeSetId) throw new StageError("CHANGE_SET_MISMATCH", `${record.stack}: after the execute, ${record.changeSetName} is not the recorded change set`);
    if (!SETTLED.includes(finalStatus)) throw new StageError("DEPLOY_FAILED", `${record.stack} ended as ${finalStatus} (CloudFormation rolled the update back; read the stack events)`);
    out.push({ ...record, executedAt: ports.clock.now().toISOString(), finalStatus });
    args.log(`${record.stack}: ${finalStatus}`);
  }
  return out;
}

/** Deletes this run's change sets and other `rovara-pipeline-*` ones that are no longer usable. One that is still AVAILABLE belongs to a newer execution: left alone. */
export async function tidyChangeSets(ports: Ports, stacks: readonly string[], thisName: string, log: (line: string) => void): Promise<void> {
  for (const stack of stacks) {
    let names: string[];
    try { names = await ports.cfn.listChangeSetNames(stack); } catch { log(`could not list the change sets of ${stack}`); continue; }
    for (const name of names.filter((n) => n.startsWith("rovara-pipeline-"))) {
      if (name !== thisName) {
        const other = await ports.cfn.describeChangeSet(stack, name);
        if (other === null || other.executionStatus === "AVAILABLE") continue;
      }
      try { await ports.cfn.deleteChangeSet(stack, name); log(`tidied ${name} on ${stack}`); } catch { log(`could not delete ${name} on ${stack}`); }
    }
  }
}

/**
 * Deletes this run's change set (by name) on each stack, best effort and never throwing: the cleanup after a failed step. A change set that is executing or has executed
 * is left alone (it is the stack's history, and CloudFormation refuses to delete one that is executing); one that is only AVAILABLE, FAILED or empty is deleted, because nothing
 * will execute it now (the run is failing closed).
 */
export async function discardChangeSets(ports: Ports, stacks: readonly string[], name: string, log: (line: string) => void): Promise<void> {
  for (const stack of stacks) {
    try {
      const found = await ports.cfn.describeChangeSet(stack, name);
      if (found === null) continue;
      if (found.executionStatus.startsWith("EXECUTE_")) { log(`${stack}: ${name} is ${found.executionStatus}; not deleted`); continue; }
      await ports.cfn.deleteChangeSet(stack, name);
      log(`${stack}: deleted the unexecuted change set ${name} (the step failed)`);
    } catch { log(`${stack}: could not tidy the change set ${name} after the failure`); }
  }
}
