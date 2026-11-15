// The production EvalApprovalSource and per-project eval budget the stage hold reads (product-eval.ts; PRODUCT-EVAL-APPROVAL-ADAPTER).
// Both come from the project's product-AI document in the product key table, written by Cloud's settings routes (signed write,
// project admin, fresh step-up, audited) through ProductKeyStore.setEvalApproval / setEvalBudget. Strongly consistent reads, on
// every hold: a withdrawn approval or a lowered budget applies to the next hold.
//
// roleOf: the gateway has no way to re-read a person's Code membership (Cloud asks Code as that person; the gateway holds no
// person's session). The settings route checked the approver's role with Code when the approval was recorded, and the record
// counts for EVAL_APPROVAL_VALID_MS after that (then it must be approved again). This is the known gap of row
// PRODUCT-EVAL-APPROVER-REREAD: a removed approver's approval keeps working until it ages out or a project admin withdraws it.
import type { ProductKeyStore, StoredEvalApproval } from "./product-keys.js";
import type { EvalApproval, EvalApprovalSource, EvalRole } from "./product-eval.js";

/** How long a recorded approval counts: one working day. */
export const EVAL_APPROVAL_VALID_MS = 24 * 60 * 60_000;

type Reader = Pick<ProductKeyStore, "evalFor">;
const live = (approval: StoredEvalApproval | undefined, now: number): StoredEvalApproval | undefined =>
  approval !== undefined && approval.approvedAt <= now && now - approval.approvedAt < EVAL_APPROVAL_VALID_MS ? approval : undefined;

export function storedEvalApprovals(store: Reader, now: () => number = Date.now): EvalApprovalSource {
  return {
    async current(iss, cid, project): Promise<EvalApproval | undefined> {
      const approval = live((await store.evalFor(iss, cid, project)).approval, now());
      if (approval === undefined) return undefined;
      return { selection: approval.selection, inputsDigest: approval.inputsDigest, maxCalls: approval.maxCalls, maxCostMicros: approval.maxCostMicros, ...(approval.model === undefined ? {} : { model: approval.model }), approver: { ...approval.approver } };
    },
    async roleOf(iss, cid, project, approver): Promise<EvalRole | undefined> {
      // Re-read (never cached): the same record, still live, and still naming this approver.
      const approval = live((await store.evalFor(iss, cid, project)).approval, now());
      if (approval === undefined || approval.approver.personId !== approver.personId || approval.approver.provider !== approver.provider) return undefined;
      return approval.role;
    },
  };
}
/** The project's eval budget per stage run: its own, else DEC 203's default. A failed read throws (503, nothing held). */
export function storedEvalBudget(store: Reader): (iss: string, cid: string, project: string) => Promise<{ calls: number; costMicros: number }> {
  return async (iss, cid, project) => {
    const { budget } = await store.evalFor(iss, cid, project);
    return budget === undefined ? { calls: 400, costMicros: 4_000_000 } : { calls: budget.calls, costMicros: budget.costMicros };
  };
}
