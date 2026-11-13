// packages/broker/src/aws/developer-routes/owner-seat.ts
// 0.5.18 (Slack merged identity): the task owner's seat, for a commit that acts as the owner (a design approval, a spend approval's resume). The owner is seated from their OWN record and
// membership, read now (ON-4), as `callerFor` always did. What is new: an owner whose sign-in was merged into another (a Slack-only sign-in merged into the person's web sign-in) is seated as
// the survivor, after the task is handed on to them exactly as the merge's own mover does (`handOnMergedTask`), so a task made under the merged-away id is no longer stuck as "stale" for good.
//
// The company check stays: the survivor is seated only when `callerFor` finds them a current member of THIS company (their sign-in, not revoked, and their membership's company), and the task is
// this company's. Anyone else is "not_member", which the caller says plainly (TASK_OWNER_NOT_MEMBER_MESSAGE), never as "stale". Each outcome is logged with a fixed reason code and no ids.
import type { OrgId } from "@rovara-code/contracts";
import { handOnMergedTask } from "../../agent-sessions/lifecycle.js";
import { logDeveloperEvent } from "../../developer/log.js";
import { mergeSurvivor } from "../../developer/merged-owner.js";
import type { DeveloperRecord } from "../../developer/store.js";
import { tryEffectiveTaskOwner, type DeveloperTaskRecord } from "../../developer/task-records.js";
import { getSignIn } from "./authentication.js";
import { agentRunStarterOf } from "./dependencies.js";
import type { DeveloperCaller, DeveloperRouteDependencies } from "./types.js";

export type TaskOwnerSeat =
  | { kind: "seated"; caller: DeveloperCaller; /** The task was handed on to the merge survivor just now (re-read it before deciding). */ handedOn: boolean }
  /** Nobody can be seated: the owner (or the survivor of their merge) is not a current member of this company. */
  | { kind: "not_member"; reason: "owner_unreadable" | "no_runs" | "owner_not_member" | "merge_chain_unreadable" | "survivor_not_member" | "task_other_company" }
  /** Someone else holds the task now (a take-over raced the hand-on): the card is stale. */
  | { kind: "moved" };

/** The seat of `task`'s effective owner in `orgId`, following a merge to its survivor (see the header). */
export async function seatTaskOwner(deps: DeveloperRouteDependencies, orgId: OrgId, task: DeveloperTaskRecord): Promise<TaskOwnerSeat> {
  const seat = await seatOf(deps, orgId, task);
  if (seat.kind !== "seated" || seat.handedOn) {
    logDeveloperEvent({ event: "task.owner_seat", outcome: seat.kind, ...(seat.kind === "not_member" ? { reason: seat.reason } : {}), ...(seat.kind === "seated" ? { handedOn: "true" } : {}) });
  }
  return seat;
}

async function seatOf(deps: DeveloperRouteDependencies, orgId: OrgId, task: DeveloperTaskRecord): Promise<TaskOwnerSeat> {
  const starter = agentRunStarterOf(deps);
  if (starter === undefined) return { kind: "not_member", reason: "no_runs" };
  const owner = tryEffectiveTaskOwner(task);
  if (owner === undefined) return { kind: "not_member", reason: "owner_unreadable" };
  const direct = await starter.callerFor(orgId, owner.developerId);
  if (direct !== undefined) return { kind: "seated", caller: direct, handedOn: false };
  const readRecord = (id: string) => getSignIn<DeveloperRecord>(deps, `DEVELOPER#${id}`);
  const survivor = await mergeSurvivor(readRecord, owner.developerId);
  if (survivor === undefined) return { kind: "not_member", reason: "merge_chain_unreadable" };
  if (survivor === owner.developerId) return { kind: "not_member", reason: "owner_not_member" };
  // The company check: the survivor's own sign-in and membership, read now, in THIS company (callerFor refuses a revoked sign-in and a membership of any other company).
  const caller = await starter.callerFor(orgId, survivor);
  if (caller === undefined) return { kind: "not_member", reason: "survivor_not_member" };
  if (task.orgId !== orgId) return { kind: "not_member", reason: "task_other_company" };
  const hold = await handOnMergedTask(
    { documentClient: deps.documentClient, tableName: deps.tableName, now: deps.now, signInStore: { getDeveloper: readRecord } },
    { orgId, taskId: task.taskId, duplicateId: owner.developerId, survivorId: survivor },
  );
  if (hold === "handed" || hold === "already") return { kind: "seated", caller, handedOn: true };
  return hold === "gone" ? { kind: "not_member", reason: "task_other_company" } : { kind: "moved" };
}
