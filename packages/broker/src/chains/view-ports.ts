// Plan 4 Task 10: the broker's side of `ChainViewPorts`: what the chain-run view reads of a step's task from Plan 3 (its view, its settled spend, the approvals it waits on).
// The pieces are handed in, so this file holds only how they are put together.
import type { DeveloperTaskView } from "@agentx/cloud-contracts";
import type { OrgId } from "@rovara-code/contracts";
import { agentRunView } from "../agents/run-engine.js";
import type { ApprovalDependencies } from "../agents/approvals.js";
import { taskKey, type DeveloperTaskRecord } from "../developer/task-records.js";
import { cleanUsd } from "../spend/top-ups.js";
import type { ChainViewPorts } from "./view.js";
import { getItem } from "./runner.js";

export interface ChainViewPortInput {
  approvals: Pick<ApprovalDependencies, "documentClient" | "tableName" | "now" | "log">;
  /** The model proxy's spend of keys, when the install has one: without it a task's cost reads as nothing. */
  keySpend?: ((keyIds: readonly string[]) => Promise<number>) | undefined;
  /** Plan 3's task view (`taskView`), bound to the request's task dependencies. It does no owner check: callers load the task first. */
  taskView(task: DeveloperTaskRecord): Promise<DeveloperTaskView>;
}

export function chainViewPortsFor(input: ChainViewPortInput): ChainViewPorts {
  return {
    taskView: (task) => input.taskView(task),
    taskFacts: async (orgId: OrgId, taskId: string) => {
      const stored = await getItem(input.approvals, taskKey(taskId));
      if (stored === undefined || stored["orgId"] !== orgId) return undefined;
      const task = stored as unknown as DeveloperTaskRecord;
      const keys = task.modelKeyIds ?? [];
      const spentUsd = input.keySpend === undefined || keys.length === 0 ? 0 : cleanUsd(await input.keySpend(keys));
      const run = task.agent !== undefined && task.workflow === undefined ? await agentRunView(input.approvals, task) : undefined;
      return { spentUsd, pendingApprovals: run?.pendingApprovals.length ?? 0 };
    },
  };
}
