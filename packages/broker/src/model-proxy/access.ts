// What the broker's callers see of the model proxy (ruling R28). ModelProxyClient talks to LiteLLM
// directly and runs only inside the VPC-attached ModelAccessFunction; ModelAccessInvoker satisfies the
// same interface from the broker Lambdas, which are not in the VPC and never hold the master key.
import type { OrgId } from "@agentx/contracts";

export interface SpendFigures {
  spentUsd: number;
  limitUsd: number;
}

export interface MemberSpend {
  member: SpendFigures;
  org: SpendFigures;
}

export interface MintKeyInput {
  orgId: OrgId;
  /** Absent for work no known member started (a Slack requester not linked to a member): the key then answers to the org alone. */
  developerId?: string | undefined;
  purpose: "task" | "turn";
  refId: string;
  maxBudgetUsd: number;
  ttlSeconds: number;
}

export interface MintedKey {
  key: string;
  /** Epoch milliseconds, counted from when the request was made, so never later than the proxy's own expiry. */
  expiresAt: number;
}

export interface ModelAccess {
  upsertOrg(orgId: OrgId, monthlyBudgetUsd: number): Promise<void>;
  upsertMember(orgId: OrgId, developerId: string, monthlyBudgetUsd: number): Promise<void>;
  /** LiteLLM's own figures (ruling R22); remaining budget is clamped at 0 by the caller (R23). */
  spend(orgId: OrgId, developerId: string): Promise<MemberSpend>;
  /** The org's own figures, for work no known member started (a Slack requester not linked to a member). */
  orgSpend(orgId: OrgId): Promise<SpendFigures>;
  /**
   * What the given keys have spent in all, by key id (the SHA-256 of the key, which is LiteLLM's own token id, so the key itself
   * never leaves the caller). A key the proxy no longer knows has spent nothing it can report and counts 0.
   */
  keySpend(keyIds: readonly string[]): Promise<number>;
  mintKey(input: MintKeyInput): Promise<MintedKey>;
  revokeKey(key: string): Promise<void>;
}
