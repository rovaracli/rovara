// Switch blocker 5: v2's limits on a project maintainer's seat (`aws/developer-tasks/decide.ts`): a maintainer who is not the task's owner decides a coding plan only, and never closes it as answered
// or carries an acknowledged run limit (the run limit is money, and the task's owner decides it). The coding-plan-only limit is `cloudActorFor`. These two need the decision's details AND the verified
// approver together, which Code's gate never hands one place (its `checkDecision` sees the attempt, not the person). This joins them with no change to either, in two parts that only work together:
//   - `gate` wraps the decision gate: before it decides, it notes the decision's details under each credential's proof key (request, method, token: a key only that person holds), and removes them after;
//   - `wrap` wraps the approvers adapter: once the real adapter has verified a person and read their live standing, a maintainer's proof is refused when the details noted for it close the plan as
//     answered or acknowledge a run limit. The gate then refuses the decision with the reason, and nothing is written.
// A surface decides through the wrapped gate only (`inbound.gate` and `inbound.clientGate`).
import type { ApprovalVerdict, Approvers } from "@rovara-code/contracts";
import { STANDING_ROLE_PREFIX } from "../adapters/people/methods.js";

interface Attempt { requestId: string; credentials: readonly { method: string; token: string }[]; details?: unknown }

export const SEAT_LIMIT_WORDS = "a project maintainer decides a coding plan only: closing it as answered, or accepting its run limit, is the task owner's";

const keyOf = (requestId: string, credential: { method: string; token: string }): string => `${requestId}\u0000${credential.method}\u0000${credential.token}`;

/** The gate asks its approvers about `<the attempt's request id>.<a fresh id>` (a request id never holds a dot), so the attempt's own id is what precedes the first dot. */
const attemptIdOf = (adapterRequestId: string): string => adapterRequestId.split(".")[0]!;

const limitedBy = (details: unknown): boolean => {
  const given = (details ?? {}) as { closeAsAnswered?: unknown; acknowledgedRunLimitUsd?: unknown };
  return given.closeAsAnswered === true || given.acknowledgedRunLimitUsd !== undefined;
};

export function createSeatLimits() {
  const noted = new Map<string, unknown>();
  return {
    wrap(approvers: Approvers): Approvers {
      return {
        requirement: (request) => approvers.requirement(request),
        async verify(request, proof): Promise<ApprovalVerdict> {
          const verdict = await approvers.verify(request, proof);
          if (!verdict.approved) return verdict;
          const standing = verdict.approver.roles.find((role) => role.startsWith(STANDING_ROLE_PREFIX))?.slice(STANDING_ROLE_PREFIX.length);
          if (standing === "maintainer" && limitedBy(noted.get(keyOf(attemptIdOf(proof.requestId), proof)))) return { approved: false, reason: SEAT_LIMIT_WORDS };
          return verdict;
        },
      };
    },
    /** The decision gate, noting each attempt's details for `wrap` while it decides. */
    gate<G extends { decide(attempt: never): Promise<unknown> }>(gate: G): G {
      return {
        ...gate,
        verifyPolicy: (gate as unknown as { verifyPolicy: (companyId: string) => Promise<void> }).verifyPolicy.bind(gate),
        requirement: (gate as unknown as { requirement: (...args: unknown[]) => Promise<unknown> }).requirement.bind(gate),
        async decide(attempt: Attempt) {
          const keys = attempt.credentials.map((credential) => keyOf(attempt.requestId, credential));
          for (const key of keys) noted.set(key, attempt.details);
          try {
            return await (gate as unknown as { decide(attempt: Attempt): Promise<unknown> }).decide(attempt);
          } finally {
            for (const key of keys) noted.delete(key);
          }
        },
      };
    },
  };
}
