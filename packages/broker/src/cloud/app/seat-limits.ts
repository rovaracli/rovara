// Switch blocker 5: v2's limits on a project maintainer's seat (`aws/developer-tasks/decide.ts`): a maintainer who is not the task's owner decides a coding plan only, and never closes it as answered
// or carries an acknowledged run limit (the run limit is money, and the task's owner decides it). The coding-plan-only limit is `cloudActorFor`. These two need the decision's details AND the verified
// approver together, which Code's gate never hands one place (its `checkDecision` sees the attempt, not the person). This joins them with no change to either, in two parts that only work together:
//   - `gate` wraps the decision gate: it runs the decision inside an AsyncLocalStorage context that holds the decision's details (a context belongs to that one call and its awaits: no shared table
//     that another call could read or clear);
//   - `wrap` wraps the approvers adapter: once the real adapter has verified a person and read their live standing, a maintainer's proof is refused when the details of the decision in hand close
//     the plan as answered or acknowledge a run limit. It FAILS CLOSED: a maintainer verifying a request about a task outside such a context (a decision that did not come through the wrapped gate) is
//     refused too, so no path can skip the limits by not going through the wrapper.
// v2's last maintainer limit, "never raises the owner's run limit through a plain approval", has nothing to hold on the core: approving a plan there sets no run limit (the limit is the task's own and
// is not changed by a decision), which a test pins. A surface decides through the wrapped gate only (`inbound.clientGate`; the raw gate is not exposed).
import { AsyncLocalStorage } from "node:async_hooks";
import type { ApprovalVerdict, Approvers } from "@rovara-code/contracts";
import { STANDING_ROLE_PREFIX } from "../adapters/people/methods.js";

interface Attempt { requestId: string; credentials: readonly { method: string; token: string }[]; details?: unknown }

export const SEAT_LIMIT_WORDS = "a project maintainer decides a coding plan only: closing it as answered, or accepting its run limit, is the task owner's";
export const SEAT_LIMIT_UNAVAILABLE = "a project maintainer's decision could not be checked against the limits of their seat just now";

const limitedBy = (details: unknown): boolean => {
  const given = (details ?? {}) as { closeAsAnswered?: unknown; acknowledgedRunLimitUsd?: unknown };
  return given.closeAsAnswered === true || given.acknowledgedRunLimitUsd !== undefined;
};

export function createSeatLimits() {
  const context = new AsyncLocalStorage<{ details: unknown }>();
  return {
    wrap(approvers: Approvers): Approvers {
      return {
        requirement: (request) => approvers.requirement(request),
        async verify(request, proof): Promise<ApprovalVerdict> {
          const verdict = await approvers.verify(request, proof);
          if (!verdict.approved) return verdict;
          const standing = verdict.approver.roles.find((role) => role.startsWith(STANDING_ROLE_PREFIX))?.slice(STANDING_ROLE_PREFIX.length);
          if (standing !== "maintainer") return verdict;
          const held = context.getStore();
          if (request.subject.type === "task" && held === undefined) return { approved: false, reason: SEAT_LIMIT_UNAVAILABLE };
          return held !== undefined && limitedBy(held.details) ? { approved: false, reason: SEAT_LIMIT_WORDS } : verdict;
        },
      };
    },
    /** The decision gate, holding each attempt's details for `wrap` while it decides. */
    gate<G extends { decide(attempt: never): Promise<unknown> }>(gate: G): G {
      return {
        ...gate,
        decide: (attempt: Attempt) => context.run({ details: attempt.details }, () => (gate as unknown as { decide(attempt: Attempt): Promise<unknown> }).decide(attempt)),
      };
    },
  };
}
