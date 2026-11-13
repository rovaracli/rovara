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
import { when, type ApprovalVerdict, type Approvers, type DocumentStore, type TransactItem } from "@rovara-code/contracts";
import { orgMemberKey } from "@agentx/cloud-contracts";
import { STANDING_ROLE_PREFIX } from "../adapters/people/methods.js";

interface Attempt { requestId: string; credentials: readonly { method: string; token: string }[]; details?: unknown }

export const SEAT_LIMIT_WORDS = "a project maintainer decides a coding plan only: closing it as answered, or accepting its run limit, is the task owner's";
export const SEAT_LIMIT_UNAVAILABLE = "a project maintainer's decision could not be checked against the limits of their seat just now";

const limitedBy = (details: unknown): boolean => {
  const given = (details ?? {}) as { closeAsAnswered?: unknown; acknowledgedRunLimitUsd?: unknown };
  return given.closeAsAnswered === true || given.acknowledgedRunLimitUsd !== undefined;
};

interface Verified { companyId: string; developerId: string; orgRole: string; taskId?: string | undefined; people?: { revision: number } | "absent" | undefined }

/**
 * L1 (v2's `deciderStillMemberCheck` and PEOPLE fence): what each approver read at verification, held into the decision's own transaction by `fenceStore`, so a person removed or demoted, or a task whose
 * People list changed (a take-over, a change of owners), between the check and the commit does not get the decision recorded. The conditions are the member record holding the role read, and the
 * task's PEOPLE sidecar holding the revision read (or still absent).
 */
export function createSeatLimits(options: { read?: (key: { pk: string; sk: string }) => Promise<Record<string, unknown> | undefined> } = {}) {
  const context = new AsyncLocalStorage<{ details: unknown; verified: Verified[] }>();
  return {
    wrap(approvers: Approvers): Approvers {
      return {
        requirement: (request) => approvers.requirement(request),
        async verify(request, proof): Promise<ApprovalVerdict> {
          const verdict = await approvers.verify(request, proof);
          if (!verdict.approved) return verdict;
          const standing = verdict.approver.roles.find((role) => role.startsWith(STANDING_ROLE_PREFIX))?.slice(STANDING_ROLE_PREFIX.length);
          const held = context.getStore();
          if (held !== undefined) {
            const people = request.subject.type === "task" && options.read !== undefined ? await options.read({ pk: `DEVTASK#${request.subject.id}`, sk: "PEOPLE" }) : undefined;
            held.verified.push({
              companyId: verdict.approver.companyId, developerId: verdict.approver.personId, orgRole: verdict.approver.roles[0] ?? "", ...(request.subject.type === "task" ? { taskId: request.subject.id } : {}),
              people: request.subject.type !== "task" || options.read === undefined ? undefined : people === undefined ? "absent" : { revision: Number(people["revision"]) },
            });
          }
          if (standing !== "maintainer") return verdict;
          if (request.subject.type === "task" && held === undefined) return { approved: false, reason: SEAT_LIMIT_UNAVAILABLE };
          return held !== undefined && limitedBy(held.details) ? { approved: false, reason: SEAT_LIMIT_WORDS } : verdict;
        },
      };
    },
    /** The decision gate, holding each attempt's details for `wrap` while it decides. */
    gate<G extends { decide(attempt: never): Promise<unknown> }>(gate: G): G {
      return {
        ...gate,
        decide: (attempt: Attempt) => context.run({ details: attempt.details, verified: [] }, () => (gate as unknown as { decide(attempt: Attempt): Promise<unknown> }).decide(attempt)),
      };
    },
    /** The store the decision gate commits through: a decision's transaction gains the conditions of what its approvers read (`Verified`). Every other call is the store's own. */
    fenceStore<S extends DocumentStore>(store: S): S {
      return new Proxy(store, {
        get(target, property) {
          if (property !== "transact") {
            const value = Reflect.get(target, property, target) as unknown;
            return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
          }
          return async (items: readonly TransactItem[]) => {
            const held = context.getStore();
            const decision = items.some((item) => item.kind === "put" && item.item["entityType"] === "APPROVAL_DECISION");
            if (!decision || held === undefined || held.verified.length === 0) return await target.transact(items);
            const fence: TransactItem[] = [];
            const seenTasks = new Set<string>();
            // One check per person: a transaction names an item once, and two credentials of one person read the one record. The first read is held; a role that differs between the two reads fails it.
            const seenMembers = new Set<string>();
            for (const person of held.verified) {
              if (!seenMembers.has(`${person.companyId}/${person.developerId}`)) {
                seenMembers.add(`${person.companyId}/${person.developerId}`);
                fence.push({ kind: "check", key: orgMemberKey(person.companyId, person.developerId), condition: when.eq("role", person.orgRole) });
              }
              if (person.taskId !== undefined && person.people !== undefined && !seenTasks.has(person.taskId)) {
                seenTasks.add(person.taskId);
                fence.push({ kind: "check", key: { pk: `DEVTASK#${person.taskId}`, sk: "PEOPLE" }, condition: person.people === "absent" ? when.absent() : when.eq("revision", person.people.revision) });
              }
            }
            return await target.transact([...items, ...fence]);
          };
        },
      });
    },
  };
}
