// Plan 3, Task 21a-wiring: the `apr` kind of approval on the confirmation page (stub until the implementation commit).
import type { DecideKind } from "../developer/decide-kinds.js";
import type { ApprovalDependencies } from "./approvals.js";

export function approvalDecideKind(_deps: ApprovalDependencies): DecideKind {
  return {
    inspect: async () => ({ status: "not_found" }),
    decide: async () => { throw new Error("not implemented"); },
  };
}
