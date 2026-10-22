// Plan 3 Task 34: STUB while the tests are written first; replaced by the implementation.
import type { AgentId, OrgId, OrgRole, RunEstimate } from "@agentx/contracts";
import type { ProjectMembers } from "../agents/access.js";
import type { DeveloperTaskRecord } from "../developer/task-records.js";
import type { ModelAccess } from "../model-proxy/access.js";
import type { SpendSettingsDependencies } from "./settings.js";

export type EstimatePath = "QUICK" | "FULL" | "TASK" | "AGENT";

export interface RunLimitRequest {
  kind: "run_limit";
  resume: "implement";
  orgId: OrgId;
  taskId: string;
  amountUsd: number;
  newLimitUsd: number;
  reason: string;
  requestedBy: { kind: "member"; developerId: string };
  approverRole: "project_maintainer" | "org_admin";
}
export type RequestRunLimit = (request: RunLimitRequest) => Promise<{ spendRequestId: string } | undefined>;

export type RunLimitDecision =
  | { accepted: true; runLimitUsd: number }
  | { accepted: false; runLimitUsd: number; needs: "maintainer" | "admin"; approverRole: "project_maintainer" | "org_admin"; message: string };

export async function estimateRun(_deps: SpendSettingsDependencies, _input: { orgId: OrgId; project: string; agentId: AgentId; path: EstimatePath; maxPerRunUsd?: number }): Promise<RunEstimate> {
  throw new Error("not implemented");
}
export async function suggestMaxPerRun(_deps: SpendSettingsDependencies, _input: { orgId: OrgId; agentId: AgentId; coding?: boolean }): Promise<number> {
  throw new Error("not implemented");
}
export async function acceptRunLimit(
  _deps: SpendSettingsDependencies & { projectMembers?: ProjectMembers },
  _input: { task: DeveloperTaskRecord; approver: { developerId: string; orgRole: OrgRole } },
): Promise<RunLimitDecision> {
  throw new Error("not implemented");
}
export async function recordRunCost(
  _deps: { documentClient: { send(command: unknown): Promise<unknown> }; tableName: string; modelAccess: ModelAccess },
  _task: DeveloperTaskRecord,
  _input: { path: EstimatePath; endedAt: string },
): Promise<"recorded" | "already_recorded" | "skipped"> {
  throw new Error("not implemented");
}
