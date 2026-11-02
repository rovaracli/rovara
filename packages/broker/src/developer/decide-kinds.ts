// Plan 3, Task 21a-presence (PF21): what the confirmation machinery needs to know about each kind of approval, behind one seam. The
// machinery here (tickets, fresh sign-in, the session, the page) never reads an approval record itself: a kind says, for a member and
// an approval, whether the approval exists in the member's org, whether the member may decide it NOW (R68: evaluated live, never from
// stored candidates), what the page shows, and what deciding does. 21a-wiring registers `apr_` (change, write and step approvals) and
// Task 32 registers `spr_` (spend requests); until a kind is registered, its approvals are not found.
import type { AuditProof, OrgId } from "@agentx/contracts";

/** The two prefixes an approval id can have: `apr_` (approvals) and `spr_` (spend requests). */
export type DecideKindPrefix = "apr" | "spr";

/** Who is deciding which approval. `orgId` is the member's org; an approval in another org is not found. */
export interface DecideTarget { orgId: OrgId; developerId: string; approvalId: string }

/**
 * What the page shows for an open approval. Every string is shown as text (escaped once, by the page); `call` is the exact call a write
 * approval would make, pretty-printed by the page, so a person decides what will really happen.
 */
export interface ConfirmView {
  title: string;
  /** The facts a person checks: the agent, project and run; or a spend request's payer, scope, amount and new limit; or an opt-out's files and digest. */
  facts: Array<{ label: string; value: string }>;
  /** What the agent said it was doing (`summary`) and any other plain paragraphs. */
  paragraphs?: string[];
  call?: { connector: string; tool: string; /** The connector scope the call is made in (and for GitHub the repository): part of the call, so two calls that differ only by it read differently. */ scope?: string; repository?: string; arguments: unknown };
}

export type DecideInspection =
  | { status: "not_found" }
  /** The approval exists but this member may not decide it now; `who` completes "Only <who> can decide this." */
  | { status: "forbidden"; who: string }
  | { status: "decided"; by: string; at: string }
  /** Its time ran out (the sweep may not have ended it yet): nobody decided it. */
  | { status: "expired"; at: string }
  | { status: "open"; view: ConfirmView };

/** What the page says once the decision was made (for example "Approved. The change was applied."); a failure to apply is thrown with its reason. */
export interface DecideOutcome {
  refusal?: {code:string;reason:string;stage?:string|undefined;fixHref:string};
  message: string;
  /** The page's heading when the default ("Approved" or "Declined") would mislead: an approval that was made but could not be applied. */
  title?: string;
}

export interface DecideKind {
  /** Reads the approval in `target.orgId` and evaluates, live, whether the member may decide it now (`mayDecide`). */
  inspect(target: DecideTarget): Promise<DecideInspection>;
  /**
   * Makes the decision as the member, through the same function the API route uses (`decideApproval`, `decideSpendRequest`, the opt-out checks).
   * `proof` is the session's (`requireDecideSession`): the kind sets it as `caller.decideProof`, so the decision's audit event carries it.
   */
  decide(target: DecideTarget, decision: "approve" | "decline", proof: AuditProof): Promise<DecideOutcome>;
  /** Called only when the confirmation page is rendered (GET) for this member after `inspect` said "open": a kind that needs the member to have read the page records it here. */
  opened?(target: DecideTarget): Promise<void>;
}

export type DecideKinds = Partial<Record<DecideKindPrefix, DecideKind>>;

export const kindPrefixOf = (approvalId: string): DecideKindPrefix | undefined =>
  /^apr_[0-9a-z]{20}$/.test(approvalId) ? "apr" : /^spr_[0-9a-z]{20}$/.test(approvalId) ? "spr" : undefined;

/** `mayDecide`: whether the member may decide the approval now, as the kind's own live evaluation answers. An unregistered kind is not found. */
export async function mayDecide(kinds: DecideKinds, target: DecideTarget): Promise<DecideInspection> {
  const prefix = kindPrefixOf(target.approvalId);
  const kind = prefix === undefined ? undefined : kinds[prefix];
  return kind === undefined ? { status: "not_found" } : kind.inspect(target);
}
