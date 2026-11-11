// Plan 4 Task 8 (R64, R68; the human's rule, Decisions item 7): who approves a write an agent makes in an AUTONOMOUS run of a project-owned chain, a run an event or a
// schedule started. The run's `owner` is fixed when the run starts (R60 needs one person on the task), but the human's rule names the trigger's creator as it is NOW, and
// a trigger's `createdBy` moves when a member leaves or merges (Task 18). So these runs get a rule of their own, `chain_autonomous_writer`, read at the moment someone
// decides: the trigger's current creator while they hold `start_tasks` on the project, or anyone who holds `approve_writes` on it (every maintainer). Nothing is cached, so a
// maintainer added after the approval was made can decide it, and one demoted or removed since cannot. `candidates` only decide who sees the approval listed.
//
// Plan 3's agent-tools call asks the registered selectors for `approvers` just before `decideWrite` (`registerWriteApproverSelector`); `chainWriteApprovers` is Plan 4's.
// Every other write keeps Plan 3's `write_approver`: a person-started run, a member-owned chain's event-started run (its owner is the member), a plain agent run.
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { ChainRunIdSchema, projectAllows, type OrgId } from "@rovara-code/contracts";
import { orgRoleOf } from "../agents/access.js";
import { registerWriteApproverSelector, type WriteApproverRun, type WriteApproverTask } from "../agents/agent-tools-routes.js";
import { registerApproverRule, type AnyApprovalRecord, type ApprovalCaller, type ApprovalDependencies, type ApproverSpec } from "../agents/approvals.js";
import { resolveMember, sameMember } from "../agents/lifecycle.js";
import { writeApproversFor } from "../agents/write-gate.js";
import { taskKey } from "../developer/task-records.js";
import { readChainRun } from "./runner.js";

/** The approver rule the autonomous runs' write approvals name. */
export const CHAIN_WRITER_RULE = "chain_autonomous_writer";

/** What the rule asks of the trigger store (Task 18's): who created the trigger, now. Absent where there are no triggers: (a) is then false and (b) still holds. */
export interface TriggerReader {
  get(orgId: OrgId, triggerId: string): Promise<{ createdBy: string } | undefined>;
}

/** The approvals' dependencies, with the trigger store when the broker has one (it builds it with the trigger code, Task 18). */
type Deps = ApprovalDependencies & { triggers?: TriggerReader | undefined };

/** The member who created the trigger that started the run of the task a write approval is about, now; undefined when any link of that chain is missing. */
async function creatorOf(deps: Deps, record: Extract<AnyApprovalRecord, { kind: "write" }>): Promise<string | undefined> {
  const response = await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: taskKey(record.subject.taskId), ConsistentRead: true })) as { Item?: { orgId?: unknown; chain?: { chainRunId?: unknown } } };
  const task = response.Item;
  // A task partition is global: the record's org is checked on the item.
  if (task?.orgId !== record.orgId) return undefined;
  const runId = ChainRunIdSchema.safeParse(task.chain?.chainRunId);
  if (!runId.success) return undefined;
  const run = await readChainRun(deps, record.orgId, runId.data);
  if (run === undefined || (run.startedBy.kind !== "event" && run.startedBy.kind !== "schedule")) return undefined;
  if (deps.triggers === undefined) {
    // An autonomous run whose trigger can't be read: its creator never decides, only the project's maintainers do. A broker built without the trigger store says so.
    (deps.log ?? ((event, fields) => console.log(JSON.stringify({ component: "broker", event, ...fields }))))("chain_writer.triggers_missing", { orgId: record.orgId, approvalId: record.approvalId, runId: run.runId });
    return undefined;
  }
  return (await deps.triggers.get(record.orgId, run.startedBy.triggerId))?.createdBy;
}

/**
 * Whether `caller` may decide the write approval `record` now. In the record's org, and either (a) the trigger's CURRENT `createdBy` (through `sameMember`) who holds
 * `start_tasks` on the project now, or (b) anyone who holds `approve_writes` on the project now. A missing task, run or trigger makes (a) false; (b) still holds.
 */
export async function writerEligible(deps: ApprovalDependencies, record: AnyApprovalRecord, caller: ApprovalCaller): Promise<boolean> {
  if (record.kind !== "write" || caller.orgId !== record.orgId) return false;
  const orgRole = await orgRoleOf(deps, record.orgId, caller.developerId);
  if (orgRole === undefined) return false;
  const role = await deps.projectMembers.roleOf(record.orgId, record.project, { developerId: await resolveMember(deps, record.orgId, caller.developerId), orgRole });
  if (role === undefined) return false;
  if (projectAllows(role, "approve_writes")) return true;
  if (!projectAllows(role, "start_tasks")) return false;
  const creator = await creatorOf(deps, record);
  return creator !== undefined && sameMember(deps, record.orgId, creator, caller.developerId);
}

/**
 * Plan 4's write-approver selector. It answers only for a write in a chain step whose run an event or a schedule started AND whose chain a project owns; for everything
 * else it answers `undefined`, and Plan 3's `write_approver` applies unchanged. The candidates are the ones Plan 3 lists for any write: the run's owner and every
 * `approve_writes` holder.
 */
export async function chainWriteApprovers(deps: ApprovalDependencies, task: WriteApproverTask, run: WriteApproverRun): Promise<ApproverSpec | undefined> {
  if (task.chain === undefined) return undefined;
  const runId = ChainRunIdSchema.safeParse(task.chain.chainRunId);
  if (!runId.success) return undefined;
  const chainRun = await readChainRun(deps, run.orgId, runId.data);
  // The task says it belongs to a run that can't be read (corrupt or missing): that is a failure, not "not mine". Throwing makes Plan 3 log `write_approver_selector.failed`, which
  // the alarm reads, and the write still falls back to `write_approver`.
  if (chainRun === undefined) throw new Error("the chain run of this task can't be read");
  if ((chainRun.startedBy.kind !== "event" && chainRun.startedBy.kind !== "schedule") || chainRun.chainOwner.kind !== "project") return undefined;
  return { kind: "rule", rule: CHAIN_WRITER_RULE, candidates: await writeApproversFor(deps, run) };
}

/**
 * What the broker registers at start (H4): the rule and the selector that names it, TOGETHER, so the selector can never name a rule nobody registered. Safe to call more
 * than once. Returns what takes the selector off again (a rule stays: it only ever decides records that name it).
 */
export function registerChainWriteApprovers(): () => void {
  registerApproverRule(CHAIN_WRITER_RULE, writerEligible);
  return registerWriteApproverSelector(chainWriteApprovers);
}

// The rule exists as soon as the code is loaded: an approval that names it can be decided wherever it is read. The selector is registered at broker start.
registerApproverRule(CHAIN_WRITER_RULE, writerEligible);
