// Plan 3 Task 32: requests for more spend. A run that reached one of its own limits (its run limit, the agent's max per run, the planning limit) asks the person
// who may raise it; an agent budget change that would take one person past the owner cap asks an org admin. The request is one record (`spendRequestKey`) with an
// open index item and a slot per subject and kind, so a second pause asks for nothing new. Who may decide is read live (`spendApprovers`), never from the stored
// list. Deciding goes only through the confirmation page (Task 21a's `requireDecideSession`); an approval changes the limit in the same transaction that ends the
// request, and then the task goes on where it stopped (`resumeTaskAfterSpendApproval`).
import type { AuditProof, OrgId, OwnerCapChange, PauseScope, SpendApproverRole, SpendRequestKind, SpendRequestRecord } from "@agentx/contracts";
import type { AgentCaller } from "../agents/access.js";
import type { AgentRouteDependencies } from "../agents/routes.js";
import type { DecideKind } from "../developer/decide-kinds.js";
import type { LifecycleDeps } from "../agents/lifecycle.js";

/** What the broker does for a request once it is approved: the parts that live with the developer tasks. */
export interface SpendRequestHost {
  /** Goes on with a task whose limit was raised (`resumeTaskAfterSpendApproval` in developer-tasks.ts). */
  resumeTask(input: { orgId: OrgId; taskId: string; spendRequestId: string; resetRunWindow: boolean; firstDispatch: boolean }): Promise<void>;
  /** A test run that reached its cap goes on as a normal task of its owner (`POST /v1/app/tasks/{id}/continue-as-task`). */
  continueAsTask?(caller: AgentCaller, taskId: string, body: unknown): Promise<unknown>;
}

export type SpendRequestDependencies = AgentRouteDependencies;

/** Who may decide a request now, read live: the role it is routed to, the people who hold it, and the words "Only <who> can decide this." ends with. */
export interface SpendApprovers {
  role: SpendApproverRole;
  ids: string[];
  who: string;
}

export interface DecideSpendBody {
  requestId: string;
  decision: "APPROVE" | "DENY";
  amountUsd?: number;
}

const notYet = (): never => {
  throw new Error("not implemented");
};

export async function getSpendRequest(_deps: SpendRequestDependencies, _orgId: OrgId, _spendRequestId: string): Promise<SpendRequestRecord | undefined> {
  return notYet();
}

export async function spendApprovers(_deps: SpendRequestDependencies, _request: SpendRequestRecord, _amountUsd?: number): Promise<SpendApprovers> {
  return notYet();
}

export interface CreateSpendRequestInput {
  orgId: OrgId;
  kind: SpendRequestKind;
  scope?: PauseScope;
  taskId?: string;
  agentId?: string;
  newOwner?: { developerId: string };
  amountUsd: number;
  newLimitUsd?: number;
  reason: string;
  requestedBy: SpendRequestRecord["requestedBy"];
  resume?: SpendRequestRecord["resume"];
  change?: OwnerCapChange;
}

export async function createSpendRequest(_deps: SpendRequestDependencies, _input: CreateSpendRequestInput): Promise<{ record: SpendRequestRecord; created: boolean }> {
  return notYet();
}

export async function decideSpendRequest(_deps: SpendRequestDependencies, _caller: AgentCaller, _spendRequestId: string, _body: unknown): Promise<{ spendRequest: Record<string, unknown> }> {
  return notYet();
}

/** The task's budget ran out: the request its pause asks for (none for a budget scope or a test's cap). Never throws for a task that is not paused. */
export async function requestForPausedTask(_deps: SpendRequestDependencies, _taskId: string, _refusal?: { error?: string }): Promise<SpendRequestRecord | undefined> {
  return notYet();
}

export async function escalateOwnerRequests(_deps: SpendRequestDependencies, _options: { budgetMs: number }): Promise<{ escalated: number; expired: number; complete: boolean }> {
  return notYet();
}

/** The `owner_cap` request of a change held by the cap (Task 28's seam): made once per agent, and the change waits for an org admin. */
export async function requestOwnerCap(_deps: SpendRequestDependencies, _input: { orgId: OrgId; agentId: string; requestedBy: string; owner: string; wouldBeUsd: number; capUsd: number; newLimitUsd?: number; newOwner?: string; change: OwnerCapChange; request?: unknown }): Promise<{ record: SpendRequestRecord; message: string }> {
  return notYet();
}

/** Rovara's own move left `owner` over the cap (Task 11's seam): an `owner_cap` request asks an org admin to confirm it. */
export async function confirmOwnerMove(_deps: LifecycleDeps, _orgId: OrgId, _owner: string, _cause: "member_merged" | "member_removed"): Promise<SpendRequestRecord | undefined> {
  return notYet();
}

export function spendDecideKind(_deps: SpendRequestDependencies): DecideKind {
  return { inspect: async () => notYet(), decide: async (_target, _decision, _proof: AuditProof) => notYet() };
}

export async function routeSpendRequests(_deps: SpendRequestDependencies, _caller: AgentCaller, _request: { method: string; body?: string | undefined; headers: Record<string, string | undefined> }, _url: URL): Promise<unknown> {
  return notYet();
}
